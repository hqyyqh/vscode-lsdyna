'use strict';

/**
 * @fileoverview Incremental project graph updater driven by file change events.
 * @module core/incremental/graphUpdater
 * 
 * When a file in the project changes, this module re-scans only the affected file,
 * diffs its include list and keywords against the previous state, and patches the
 * in-memory ProjectGraph and keywordMap. Callers must rebuild before publication
 * when the result reports requiresFullRebuild.
 * 
 * For the common case (file edited without changing its include list), the update is
 * limited to that file's scans and metadata. Root reachability determines which
 * detached files can be removed; new subtrees and rich indexes require a rebuild.
 *
 * Role in System: Legacy snapshot update API, currently exercised by tests rather
 * than a production watcher. It does not certify a complete new project scan.
 */

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');

const includeScanner = require('../parser/includeScanner');
const keywordScanner = require('../parser/keywordScanner');
const { ProjectGraph } = require('../project/projectGraph');
const {
    getEffectiveSearchPathsFromSnapshot,
    pathCardsChanged,
} = require('../project/effectiveSearchPathLookup');

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
        } catch (error) {
            if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
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
 * @property {boolean} [requiresFullRebuild] - PATH/structure changed or rich indexes need refresh; caller must rebuild before publication.
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
    /**
     * Resolve search dirs for include names: prefer snapshot effective paths
     * (ancestor PATH inheritance), else file-local scanner searchPaths.
     */
    function resolveSearchPathsForFile(resolvedPath, newIncludes, snapshot) {
        const fromSnapshot = getEffectiveSearchPathsFromSnapshot(resolvedPath, snapshot);
        if (fromSnapshot) {
            return fromSnapshot;
        }
        return newIncludes.searchPaths || [path.dirname(resolvedPath)];
    }

    /**
     * Previous PATH cards for this file from fileIndexes (if present).
     */
    function previousPathEntries(resolvedPath, snapshot) {
        const fileIndexes = snapshot.fileIndexes;
        if (!fileIndexes) return [];
        const key = normalizeKey(resolvedPath);
        let fileIndex = null;
        if (fileIndexes instanceof Map) {
            fileIndex = fileIndexes.get(resolvedPath);
            if (!fileIndex) {
                for (const [fp, fi] of fileIndexes.entries()) {
                    if (normalizeKey(fp) === key) {
                        fileIndex = fi;
                        break;
                    }
                }
            }
        } else if (typeof fileIndexes === 'object') {
            fileIndex = fileIndexes[resolvedPath];
        }
        return (fileIndex && fileIndex.pathEntries) || [];
    }

    async function updateFile(changedFilePath, snapshot) {
        const { graph, keywordMap, files } = snapshot;

        // Check if file is part of this project
        const fileKey = normalizeKey(changedFilePath);
        const resolvedPath = files.find(file => normalizeKey(file) === fileKey);
        if (!resolvedPath) {
            return {
                changed: false,
                addedFiles: [],
                removedFiles: [],
                includesChanged: false,
                keywordsChanged: false,
                requiresFullRebuild: false,
            };
        }

        // Re-scan the changed file
        let newIncludes, newKeywords;
        try {
            const includeResult = await collectIncludeDirectivesFromFile(resolvedPath);
            newIncludes = includeResult;
            newKeywords = await collectKeywordsFromFile(resolvedPath);
        } catch (error) {
            if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
            return removeFile(changedFilePath, snapshot);
        }

        // PATH card changes invalidate ancestor inheritance for the whole tree.
        const oldPathEntries = previousPathEntries(resolvedPath, snapshot);
        const newPathEntries = newIncludes.pathEntries || [];
        if (pathCardsChanged(oldPathEntries, newPathEntries)) {
            return {
                changed: true,
                addedFiles: [],
                removedFiles: [],
                includesChanged: true,
                keywordsChanged: false,
                requiresFullRebuild: true,
            };
        }

        const searchPaths = resolveSearchPathsForFile(resolvedPath, newIncludes, snapshot);

        // Resolve once before mutating either keywords or graph records.
        const resolvedIncludes = [];
        for (const entry of newIncludes.includeEntries) {
            const resolved = await resolveInclude(entry.fileName, searchPaths);
            const canonical = resolved && (files.find(file => normalizeKey(file) === normalizeKey(resolved)) || resolved);
            resolvedIncludes.push({ entry, resolved: canonical });
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

        // Child membership and ordered statement metadata have different responsibilities.
        const oldChildren = graph.getChildren(resolvedPath);
        const oldChildSet = new Set(oldChildren.map(normalizeKey));
        const newChildSet = new Set(resolvedIncludes.filter(item => item.resolved).map(item => normalizeKey(item.resolved)));
        const includesChanged = oldChildSet.size !== newChildSet.size ||
            [...oldChildSet].some(key => !newChildSet.has(key));
        const fromChangedFile = entry => normalizeKey(entry.fromFile) === fileKey;
        const previousOccurrences = graph.includeOccurrences.filter(fromChangedFile);
        const insertionIndex = graph.includeOccurrences.findIndex(fromChangedFile);
        graph.includeOccurrences = graph.includeOccurrences.filter(entry => !fromChangedFile(entry));
        const retainedOccurrenceCount = graph.includeOccurrences.length;

        for (const child of oldChildren) {
            graph.parents.set(child, graph.getParents(child).filter(parent => normalizeKey(parent) !== fileKey));
        }
        graph.children.set(resolvedPath, []);
        graph.includeEntries.set(resolvedPath, []);
        graph.missingFiles = graph.missingFiles.filter(entry => !fromChangedFile(entry));
        graph.cycles = graph.cycles.filter(entry => !fromChangedFile(entry));

        const addedFiles = [];
        const children = includeChildren(graph);
        for (const { entry, resolved } of resolvedIncludes) {
            if (!resolved) {
                const candidatePaths = [...new Map(searchPaths.map(searchPath => {
                    const candidate = path.resolve(searchPath, entry.fileName);
                    return [normalizeKey(candidate), candidate];
                })).values()];
                graph.addMissingFile({
                    ...entry,
                    fromFile: resolvedPath,
                    filePath: candidatePaths[0] || path.resolve(path.dirname(resolvedPath), entry.fileName),
                    candidatePaths,
                });
                continue;
            }
            const cyclePath = findIncludePath(children, resolved, resolvedPath);
            if (cyclePath) {
                graph.addCycle({ ...entry, fromFile: resolvedPath, toFile: resolved, path: [resolvedPath, ...cyclePath] });
                graph.addIncludeOccurrence(resolvedPath, { ...entry, filePath: resolved, cycle: true });
            } else {
                graph.addIncludeEdge(resolvedPath, resolved, { ...entry, filePath: resolved });
            }
            if (!files.some(file => normalizeKey(file) === normalizeKey(resolved))) {
                files.push(resolved);
                addedFiles.push(resolved);
            }
        }
        const updatedOccurrences = graph.includeOccurrences.splice(retainedOccurrenceCount);
        graph.includeOccurrences.splice(insertionIndex < 0 ? retainedOccurrenceCount : insertionIndex, 0, ...updatedOccurrences);
        const metadataChanged = !isDeepStrictEqual(previousOccurrences, updatedOccurrences);
        const removedFiles = pruneFiles(snapshot, collectOrphans(graph, snapshot.rootFile, files));
        snapshot.missingFiles = graph.missingFiles;
        snapshot.cycles = graph.cycles;
        if (snapshot.stats) snapshot.stats.includeOccurrenceCount = graph.includeOccurrences.length;
        // The legacy collectors cannot rebuild rich file indexes, new subtrees or ancestor cycle contexts.
        const requiresFullRebuild = includesChanged || Boolean(snapshot.fileIndexes) || graph.cycles.length > 0;
        if (requiresFullRebuild) graph.includeOccurrencesComplete = false;

        return {
            changed: keywordsChanged || includesChanged || metadataChanged,
            addedFiles,
            removedFiles,
            includesChanged,
            keywordsChanged,
            requiresFullRebuild,
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
        const { graph, files } = snapshot;

        const isTracked = files.some(f => normalizeKey(f) === fileKey);
        if (!isTracked) {
            return { changed: false, addedFiles: [], removedFiles: [], includesChanged: false, keywordsChanged: false };
        }

        graph.includeOccurrencesComplete = false;
        const removedFiles = pruneFiles(snapshot, [resolvedPath]);
        removedFiles.push(...pruneFiles(snapshot, collectOrphans(graph, snapshot.rootFile, files)));

        return {
            changed: true,
            addedFiles: [],
            removedFiles,
            includesChanged: true,
            keywordsChanged: true,
            requiresFullRebuild: true,
        };
    }

    return { updateFile, removeFile };
}

/**
 * Collects tracked files no longer reachable from the root, including detached cycles.
 *
 * @param {ProjectGraph} graph - The project graph.
 * @param {string} rootFile - The project root file (never orphaned).
 * @param {string[]} files - Tracked files.
 * @returns {string[]} List of orphaned file paths.
 */
function collectOrphans(graph, rootFile, files) {
    // ponytail: one full graph traversal per structural edit; use incremental reachability if profiling shows a bottleneck.
    const rootKey = normalizeKey(rootFile);
    const queue = [files.find(file => normalizeKey(file) === rootKey) || rootFile];
    const children = includeChildren(graph);
    const reachable = new Set();
    while (queue.length) {
        const current = queue.pop();
        const key = normalizeKey(current);
        if (reachable.has(key)) continue;
        reachable.add(key);
        queue.push(...(children.get(key) || []));
    }
    return files.filter(file => !reachable.has(normalizeKey(file)));
}

/** Include cycle statements participate in reachability even though collapsed edges omit them. */
function includeChildren(graph) {
    const children = new Map([...graph.children].map(([file, entries]) => [normalizeKey(file), [...entries]]));
    for (const entry of graph.includeOccurrences) {
        if (entry.missing) continue;
        const key = normalizeKey(entry.fromFile);
        if (!children.has(key)) children.set(key, []);
        children.get(key).push(entry.filePath);
    }
    return children;
}

/** Find one closing path for a changed Include statement, without recursive cycle expansion. */
function findIncludePath(children, start, target) {
    // ponytail: one graph search per Include statement; cache paths if measured edit latency requires it.
    const targetKey = normalizeKey(target);
    const pending = [start];
    const previous = new Map([[normalizeKey(start), null]]);
    while (pending.length) {
        const current = pending.pop();
        if (normalizeKey(current) === targetKey) {
            const found = [];
            for (let file = current; file; file = previous.get(normalizeKey(file))) found.unshift(file);
            return found;
        }
        for (const child of children.get(normalizeKey(current)) || []) {
            const key = normalizeKey(child);
            if (previous.has(key)) continue;
            previous.set(key, current);
            pending.push(child);
        }
    }
    return null;
}

/** Remove files and every dependent graph/snapshot record together. */
function pruneFiles(snapshot, removedFiles) {
    if (!removedFiles.length) return [];
    const removed = new Set(removedFiles.map(normalizeKey));
    const keepPath = file => !removed.has(normalizeKey(file));
    const { graph, files, keywordMap } = snapshot;
    const trackedRemoved = files.filter(file => !keepPath(file));
    files.splice(0, files.length, ...files.filter(keepPath));
    for (const [keyword, entries] of keywordMap) {
        const retained = entries.filter(entry => keepPath(entry.filePath));
        if (retained.length) keywordMap.set(keyword, retained);
        else keywordMap.delete(keyword);
    }
    for (const map of [graph.children, graph.parents, graph.includeEntries]) {
        for (const [file, entries] of map) {
            if (!keepPath(file)) map.delete(file);
            else map.set(file, entries.filter(entry => keepPath(typeof entry === 'string' ? entry : entry.filePath)));
        }
    }
    graph.includeOccurrences = graph.includeOccurrences.filter(entry => keepPath(entry.fromFile) && keepPath(entry.filePath));
    graph.missingFiles = graph.missingFiles.filter(entry => keepPath(entry.fromFile));
    graph.cycles = graph.cycles.filter(entry => keepPath(entry.fromFile) && entry.path.every(keepPath));
    snapshot.missingFiles = graph.missingFiles;
    snapshot.cycles = graph.cycles;
    for (const name of ['fileIndexes', 'effectiveSearchPathsByFile']) {
        const collection = snapshot[name];
        if (collection instanceof Map) {
            for (const file of collection.keys()) if (!keepPath(file)) collection.delete(file);
        } else if (Array.isArray(collection)) {
            snapshot[name] = collection.filter(([file]) => keepPath(file));
        } else if (collection) {
            for (const file of Object.keys(collection)) if (!keepPath(file)) delete collection[file];
        }
    }
    return trackedRemoved;
}

module.exports = {
    createGraphUpdater,
};

export {};
