'use strict';

/**
 * @fileoverview Recursive project-wide directory and include dependency index coordinator.
 * @module core/project/projectIndexer
 * 
 * This module traverses the include dependency tree of an LS-DYNA project starting from a root file.
 * It builds a combined keyword index, resolves relative search paths (*INCLUDE_PATH), detects cycles, 
 * tracks missing files, and uses an in-memory L1 cache (fileScanCache) based on file signatures 
 * to speed up incremental indexing.
 * 
 * Role in System: Main orchestration service for full project indexing. Orchestrated by the worker 
 * pool or language server to maintain the global project snapshots.
 */

const fs = require('fs');
const path = require('path');

const includeScanner = require('../parser/includeScanner');
const keywordScanner = require('../parser/keywordScanner');
const { ProjectGraph } = require('./projectGraph');

/**
 * @typedef {Object} ProjectIndexResult
 * @property {string} rootFile - Absolute path to the project's root input file.
 * @property {string[]} files - Array of all absolute file paths tracked in this project.
 * @property {ProjectGraph} graph - The inclusion dependency graph of the project.
 * @property {Map<string, import('../parser/keywordScanner').ScannedKeyword[]>} keywordMap - Registry of keywords associated with their occurrences across the project.
 * @property {import('./projectGraph').MissingFileRecord[]} missingFiles - References to all included files that could not be resolved.
 * @property {import('./projectGraph').CycleRecord[]} cycles - References to circular inclusion loops.
 * @property {{scannedFileCount: number, reusedFileCount: number}} stats - Indexing run performance statistics.
 */

/**
 * Resolves a project file path, validating and returning its absolute path.
 * 
 * @param {string} filePath - Input file path.
 * @returns {string} Absolute path.
 */
function resolveProjectFile(filePath) {
    return path.resolve(filePath);
}

/**
 * Generates a normalized map key for a project file. Handles Windows casing.
 * 
 * @param {string} filePath - Input file path.
 * @returns {string} Normalized lookup key.
 */
function getProjectFileCacheKey(filePath) {
    const resolvedFilePath = resolveProjectFile(filePath);
    return process.platform === 'win32'
        ? resolvedFilePath.toLowerCase()
        : resolvedFilePath;
}

/**
 * Compares two file signatures to check if a file has changed.
 * 
 * @param {import('../cache/diskSnapshotStore').FileSignature|null|undefined} left - Left signature.
 * @param {import('../cache/diskSnapshotStore').FileSignature|null|undefined} right - Right signature.
 * @returns {boolean} True if they match.
 */
function areFileSignaturesEqual(left, right) {
    return left
        && right
        && left.mtimeMs === right.mtimeMs
        && left.size === right.size;
}

/**
 * Reads modification and size details for a project file from disk.
 * 
 * @param {string} filePath - Absolute path to the target file.
 * @returns {Promise<import('../cache/diskSnapshotStore').FileSignature>} File signature.
 */
async function readFileSignature(filePath) {
    const stat = await fs.promises.stat(filePath);
    return {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
    };
}

/**
 * Resolves a filename against a list of active include search paths.
 * Returns the first path where the file actually exists on the filesystem.
 * 
 * @param {string} fileName - Filename to search for.
 * @param {string[]} searchPaths - Ordered array of folder search paths.
 * @returns {string|null} Resolved absolute file path, or null if not found.
 */
function resolveIncludeFromSearchPaths(fileName, searchPaths) {
    for (const searchPath of searchPaths) {
        const fullPath = path.resolve(searchPath, fileName);
        if (fs.existsSync(fullPath)) return fullPath;
    }
    return null;
}

/**
 * Merges scanned keyword items into a collective keywordMap index.
 * 
 * @param {Map<string, import('../parser/keywordScanner').ScannedKeyword[]>} keywordMap - Target map to populate.
 * @param {import('../parser/keywordScanner').ScannedKeyword[]} keywords - Scanned keywords to insert.
 */
function addKeywordUsages(keywordMap, keywords) {
    for (const keywordEntry of keywords) {
        if (!keywordMap.has(keywordEntry.keyword)) keywordMap.set(keywordEntry.keyword, []);
        keywordMap.get(keywordEntry.keyword).push(keywordEntry);
    }
}

/**
 * Factory function to create a Project Indexer.
 * 
 * @param {Object} [options={}] - Custom scan overrides.
 * @param {function(string): Promise<import('../parser/includeScanner').IncludeResult>} [options.collectIncludeDirectivesFromFile] - Custom include parser.
 * @param {function(string): Promise<import('../parser/keywordScanner').ScannedKeyword[]>} [options.collectKeywordsFromFile] - Custom keyword parser.
 * @param {function(string): Promise<import('../cache/diskSnapshotStore').FileSignature>} [options.getFileSignature] - Custom file signature reader.
 * @returns {{
 *   buildProjectIndex: function(string): Promise<ProjectIndexResult>
 * }} A project indexer instance.
 */
function createProjectIndexer({
    collectIncludeDirectivesFromFile = includeScanner.collectIncludeDirectivesFromFile,
    collectKeywordsFromFile = keywordScanner.collectKeywordsFromFile,
    getFileSignature = readFileSignature,
} = {}) {
    if (typeof collectIncludeDirectivesFromFile !== 'function') {
        throw new TypeError('createProjectIndexer requires collectIncludeDirectivesFromFile to be a function');
    }
    if (typeof collectKeywordsFromFile !== 'function') {
        throw new TypeError('createProjectIndexer requires collectKeywordsFromFile to be a function');
    }
    if (typeof getFileSignature !== 'function') {
        throw new TypeError('createProjectIndexer requires getFileSignature to be a function');
    }

    /** @type {Map<string, { signature: import('../cache/diskSnapshotStore').FileSignature, scanResult: Object }>} */
    const fileScanCache = new Map();

    /**
     * Performs a file-level scan (keywords, includes, paths), utilizing the L1 signature cache.
     * 
     * @param {string} filePath - Target file path.
     * @param {{scannedFileCount: number, reusedFileCount: number}} stats - Indexing session statistics.
     * @returns {Promise<Object>} The cached or newly scanned file result.
     */
    async function loadFileScan(filePath, stats) {
        const resolvedFilePath = resolveProjectFile(filePath);
        const fileCacheKey = getProjectFileCacheKey(resolvedFilePath);
        const signature = await getFileSignature(resolvedFilePath);
        const cachedEntry = fileScanCache.get(fileCacheKey);

        if (cachedEntry && areFileSignaturesEqual(cachedEntry.signature, signature)) {
            stats.reusedFileCount += 1;
            return cachedEntry.scanResult;
        }

        const keywords = await collectKeywordsFromFile(resolvedFilePath);
        const { includeEntries, searchPaths } = await collectIncludeDirectivesFromFile(resolvedFilePath);
        const scanResult = {
            filePath: resolvedFilePath,
            keywords,
            includeEntries,
            searchPaths,
        };

        fileScanCache.set(fileCacheKey, {
            signature,
            scanResult,
        });
        stats.scannedFileCount += 1;
        return scanResult;
    }

    /**
     * Rebuilds the project index starting from the given root file by recursively scanning inclusions.
     * 
     * @param {string} rootFile - Absolute path to the main LS-DYNA input deck.
     * @returns {Promise<ProjectIndexResult>} The assembled project index snapshot.
     */
    async function buildProjectIndex(rootFile) {
        const resolvedRootFile = resolveProjectFile(rootFile);
        const files = [];
        const keywordMap = new Map();
        const graph = new ProjectGraph();
        const visited = new Set();
        const stats = {
            scannedFileCount: 0,
            reusedFileCount: 0,
        };

        /**
         * Depth-First Search traversal to visit and parse files recursively.
         * 
         * @param {string} filePath - File path being visited.
         * @param {string[]} [ancestry=[]] - Traversal ancestry chain.
         */
        async function visit(filePath, ancestry = []) {
            const resolvedFilePath = resolveProjectFile(filePath);
            if (visited.has(resolvedFilePath)) return;
            visited.add(resolvedFilePath);
            files.push(resolvedFilePath);
            graph.addFile(resolvedFilePath);

            const scanResult = await loadFileScan(resolvedFilePath, stats);
            addKeywordUsages(keywordMap, scanResult.keywords);

            for (const entry of scanResult.includeEntries) {
                const { fileName, lineIndex, startChar, endChar } = entry;
                const resolvedPath = resolveIncludeFromSearchPaths(fileName, scanResult.searchPaths);
                if (!resolvedPath) {
                    graph.addMissingFile({
                        fromFile: resolvedFilePath,
                        fileName,
                        lineIndex,
                        startChar,
                        endChar,
                        filePath: path.resolve(scanResult.searchPaths[0] || path.dirname(resolvedFilePath), fileName),
                    });
                    continue;
                }

                if (ancestry.includes(resolvedPath) || resolvedPath === resolvedFilePath) {
                    graph.addCycle({
                        fromFile: resolvedFilePath,
                        toFile: resolvedPath,
                        lineIndex,
                        startChar,
                        endChar,
                        path: [...ancestry, resolvedFilePath, resolvedPath],
                    });
                    continue;
                }

                graph.addIncludeEdge(resolvedFilePath, resolvedPath);
                await visit(resolvedPath, [...ancestry, resolvedFilePath]);
            }
        }

        await visit(resolvedRootFile);

        return {
            rootFile: resolvedRootFile,
            files,
            graph,
            keywordMap,
            missingFiles: graph.missingFiles,
            cycles: graph.cycles,
            stats,
        };
    }

    return {
        buildProjectIndex,
    };
}

const defaultProjectIndexer = createProjectIndexer();

module.exports = {
    buildProjectIndex: defaultProjectIndexer.buildProjectIndex,
    createProjectIndexer,
};
