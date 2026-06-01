'use strict';

/**
 * @fileoverview Incremental project graph updater driven by file change events.
 * @module core/incremental/graphUpdater
 * 
 * When a file in the project changes, this module re-scans only the affected file,
 * diffs its include list and keywords against the previous state, and patches the
 * in-memory ProjectGraph and keywordMap without requiring a full tree rebuild.
 * 
 * For the common case (file edited without changing its include list), the update is
 * essentially free. When includes change, only the added/removed subtrees are traversed.
 * 
 * Role in System: Enables near-instant incremental updates after FileSystemWatcher events,
 * avoiding the cost of re-scanning the entire project (which may contain 100+ files of 100-500MB each).
 */

const fs = require('fs');
const path = require('path');

const includeScanner = require('../parser/includeScanner');
const keywordScanner = require('../parser/keywordScanner');
const { ProjectGraph } = require('../project/projectGraph');

/**
 * Resolves a project file path to absolute.
 * @param {string} filePath
 * @returns {string}
 */
function resolveFile(filePath) {
    return path.resolve(filePath);
}

/**
 * Normalizes a file path for map lookups (handles Windows casing).
 * @param {string} filePath
 * @returns {string}
 */
function normalizeKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Resolves a filename against search paths asynchronously.
 * @param {string} fileName
 * @param {string[]} searchPaths
 * @returns {Promise<string|null>}
 */
async function resolveIncludeAsync(fileName, searchPaths) {
    for (const searchPath of searchPaths) {
        const fullPath = path.resolve(searchPath, fileName);
        try {
            await fs.promises.access(fullPath, fs.constants.F_OK);
            return fullPath;
        } catch (_error) {
            continue;
        }
    }
    return null;
}

/**
 * @typedef {Object} IncrementalUpdateResult
 * @property {boolean} changed - Whether the update resulted in any changes.
 * @property {string[]} addedFiles - New files added to the graph.
 * @property {string[]} removedFiles - Files removed from the graph (orphaned).
 * @property {boolean} includesChanged - Whether the include structure changed.
 * @property {boolean} keywordsChanged - Whether keywords changed.
 */

/**
 * @typedef {Object} GraphUpdaterOptions
 * @property {function(string): Promise<import('../parser/includeScanner').IncludeResult>} [collectIncludeDirectivesFromFile]
 * @property {function(string): Promise<import('../parser/keywordScanner').ScannedKeyword[]>} [collectKeywordsFromFile]
 * @property {function(string, string[]): Promise<string|null>} [resolveInclude] - Custom include resolver.
 */

/**
 * Factory function to create an incremental graph updater.
 * 
 * @param {GraphUpdaterOptions} [options={}]
 * @returns {{
 *   updateFile: function(string, Object): Promise<IncrementalUpdateResult>,
 *   removeFile: function(string, Object): IncrementalUpdateResult
 * }}
 */
function createGraphUpdater({
    collectIncludeDirectivesFromFile = includeScanner.collectIncludeDirectivesFromFile,
    collectKeywordsFromFile = keywordScanner.collectKeywordsFromFile,
    resolveInclude = resolveIncludeAsync,
} = {}) {

    /**
     * Re-scans a single file and patches the project snapshot incrementally.
     * 
     * @param {string} changedFilePath - The file that changed.
     * @param {Object} snapshot - The current project snapshot (mutated in place).
     * @param {ProjectGraph} snapshot.graph - The project graph.
     * @param {Map<string, Object[]>} snapshot.keywordMap - The keyword map.
     * @param {string[]} snapshot.files - All tracked files.
     * @param {string} snapshot.rootFile - Root file path.
     * @returns {Promise<IncrementalUpdateResult>}
     */
    async function updateFile(changedFilePath, snapshot) {
        const resolvedPath = resolveFile(changedFilePath);
        const { graph, keywordMap, files } = snapshot;

        // Check if file is part of this project
        const fileKey = normalizeKey(resolvedPath);
        const isTracked = files.some(f => normalizeKey(f) === fileKey);
        if (!isTracked) {
            return { changed: false, addedFiles: [], removedFiles: [], includesChanged: false, keywordsChanged: false };
        }

        // Re-scan the changed file
        let newIncludes, newKeywords;
        try {
            const includeResult = await collectIncludeDirectivesFromFile(resolvedPath);
            newIncludes = includeResult;
            newKeywords = await collectKeywordsFromFile(resolvedPath);
        } catch (_error) {
            // File may have been deleted or become unreadable
            return removeFile(changedFilePath, snapshot);
        }

        // --- Update keywords ---
        let keywordsChanged = false;
        // Remove old keywords for this file
        for (const [keyword, entries] of keywordMap.entries()) {
            const before = entries.length;
            const filtered = entries.filter(e => normalizeKey(e.filePath) !== fileKey);
            if (filtered.length !== before) {
                keywordsChanged = true;
                if (filtered.length === 0) {
                    keywordMap.delete(keyword);
                } else {
                    keywordMap.set(keyword, filtered);
                }
            }
        }
        // Add new keywords
        if (newKeywords.length > 0) {
            keywordsChanged = true;
            for (const kw of newKeywords) {
                if (!keywordMap.has(kw.keyword)) keywordMap.set(kw.keyword, []);
                keywordMap.get(kw.keyword).push(kw);
            }
        }

        // --- Update includes ---
        const oldChildren = graph.getChildren(resolvedPath);
        const newChildPaths = [];

        for (const entry of newIncludes.includeEntries) {
            const resolved = await resolveInclude(entry.fileName, newIncludes.searchPaths);
            if (resolved) {
                newChildPaths.push(resolved);
            }
        }

        const oldChildSet = new Set(oldChildren.map(normalizeKey));
        const newChildSet = new Set(newChildPaths.map(normalizeKey));

        const includesChanged = oldChildSet.size !== newChildSet.size ||
            [...oldChildSet].some(k => !newChildSet.has(k));

        const addedFiles = [];
        const removedFiles = [];

        if (includesChanged) {
            // Clear old edges from this file
            const childrenList = graph.children.get(resolvedPath);
            if (childrenList) {
                for (const oldChild of [...childrenList]) {
                    // Remove parent reference
                    const parentList = graph.parents.get(oldChild);
                    if (parentList) {
                        const idx = parentList.indexOf(resolvedPath);
                        if (idx >= 0) parentList.splice(idx, 1);
                    }
                }
                childrenList.length = 0;
            }

            // Clear old include entries for this file
            graph.includeEntries.set(resolvedPath, []);

            // Remove old missing file records from this file
            snapshot.missingFiles = (snapshot.missingFiles || []).filter(
                m => normalizeKey(m.fromFile) !== fileKey
            );
            graph.missingFiles = graph.missingFiles.filter(
                m => normalizeKey(m.fromFile) !== fileKey
            );

            // Remove cycles from this file
            snapshot.cycles = (snapshot.cycles || []).filter(
                c => normalizeKey(c.fromFile) !== fileKey
            );
            graph.cycles = graph.cycles.filter(
                c => normalizeKey(c.fromFile) !== fileKey
            );

            // Add new edges
            for (const entry of newIncludes.includeEntries) {
                const resolved = await resolveInclude(entry.fileName, newIncludes.searchPaths);
                if (!resolved) {
                    const missingRecord = {
                        fromFile: resolvedPath,
                        fileName: entry.fileName,
                        lineIndex: entry.lineIndex,
                        startChar: entry.startChar,
                        endChar: entry.endChar,
                        filePath: path.resolve(newIncludes.searchPaths[0] || path.dirname(resolvedPath), entry.fileName),
                    };
                    graph.addMissingFile(missingRecord);
                    if (!snapshot.missingFiles) snapshot.missingFiles = [];
                    snapshot.missingFiles.push(missingRecord);
                    continue;
                }

                graph.addIncludeEdge(resolvedPath, resolved);

                // If this is a newly added file, track it
                if (!files.some(f => normalizeKey(f) === normalizeKey(resolved))) {
                    files.push(resolved);
                    addedFiles.push(resolved);
                }
            }

            // Find orphaned files (files that no longer have any parent in the graph)
            for (const oldChild of oldChildren) {
                const childKey = normalizeKey(oldChild);
                if (newChildSet.has(childKey)) continue;

                const parents = graph.getParents(oldChild);
                if (parents.length === 0 && normalizeKey(oldChild) !== normalizeKey(snapshot.rootFile)) {
                    // This file is orphaned - collect it and its subtree
                    const orphans = collectOrphans(oldChild, graph, snapshot.rootFile);
                    for (const orphan of orphans) {
                        const orphanKey = normalizeKey(orphan);
                        const idx = files.findIndex(f => normalizeKey(f) === orphanKey);
                        if (idx >= 0) {
                            files.splice(idx, 1);
                            removedFiles.push(orphan);
                        }
                        // Clean up keywords for removed files
                        for (const [keyword, entries] of keywordMap.entries()) {
                            const filtered = entries.filter(e => normalizeKey(e.filePath) !== orphanKey);
                            if (filtered.length === 0) {
                                keywordMap.delete(keyword);
                            } else {
                                keywordMap.set(keyword, filtered);
                            }
                        }
                    }
                }
            }
        }

        return {
            changed: keywordsChanged || includesChanged,
            addedFiles,
            removedFiles,
            includesChanged,
            keywordsChanged,
        };
    }

    /**
     * Handles a file removal from the project.
     * 
     * @param {string} removedFilePath - The removed file path.
     * @param {Object} snapshot - The current project snapshot.
     * @returns {IncrementalUpdateResult}
     */
    function removeFile(removedFilePath, snapshot) {
        const resolvedPath = resolveFile(removedFilePath);
        const fileKey = normalizeKey(resolvedPath);
        const { graph, keywordMap, files } = snapshot;

        const isTracked = files.some(f => normalizeKey(f) === fileKey);
        if (!isTracked) {
            return { changed: false, addedFiles: [], removedFiles: [], includesChanged: false, keywordsChanged: false };
        }

        // Remove keywords
        for (const [keyword, entries] of keywordMap.entries()) {
            const filtered = entries.filter(e => normalizeKey(e.filePath) !== fileKey);
            if (filtered.length === 0) {
                keywordMap.delete(keyword);
            } else {
                keywordMap.set(keyword, filtered);
            }
        }

        // Remove from files list
        const idx = files.findIndex(f => normalizeKey(f) === fileKey);
        if (idx >= 0) files.splice(idx, 1);

        // Remove edges
        const children = graph.getChildren(resolvedPath);
        for (const child of children) {
            const parentList = graph.parents.get(child);
            if (parentList) {
                const pIdx = parentList.indexOf(resolvedPath);
                if (pIdx >= 0) parentList.splice(pIdx, 1);
            }
        }

        const parents = graph.getParents(resolvedPath);
        for (const parent of parents) {
            const childList = graph.children.get(parent);
            if (childList) {
                const cIdx = childList.indexOf(resolvedPath);
                if (cIdx >= 0) childList.splice(cIdx, 1);
            }
            const entries = graph.includeEntries.get(parent);
            if (entries) {
                const filtered = entries.filter(e => normalizeKey(e.filePath) !== fileKey);
                graph.includeEntries.set(parent, filtered);
            }
        }

        graph.children.delete(resolvedPath);
        graph.includeEntries.delete(resolvedPath);
        graph.parents.delete(resolvedPath);

        return {
            changed: true,
            addedFiles: [],
            removedFiles: [resolvedPath],
            includesChanged: true,
            keywordsChanged: true,
        };
    }

    return { updateFile, removeFile };
}

/**
 * Collects all orphaned files reachable from a starting node that have no other parents.
 * 
 * @param {string} startFile - Starting orphan file.
 * @param {ProjectGraph} graph - The project graph.
 * @param {string} rootFile - The project root file (never orphaned).
 * @returns {string[]} List of orphaned file paths.
 */
function collectOrphans(startFile, graph, rootFile) {
    const orphans = [];
    const queue = [startFile];
    const visited = new Set();

    while (queue.length > 0) {
        const current = queue.shift();
        const key = normalizeKey(current);
        if (visited.has(key)) continue;
        visited.add(key);

        if (normalizeKey(current) === normalizeKey(rootFile)) continue;

        const parents = graph.getParents(current);
        if (parents.length > 0) continue; // Still reachable

        orphans.push(current);
        const children = graph.getChildren(current);
        for (const child of children) {
            queue.push(child);
        }
    }

    return orphans;
}

module.exports = {
    createGraphUpdater,
};
