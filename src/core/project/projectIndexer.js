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
 * Performance optimizations:
 * - BFS traversal with parallel file scanning (configurable concurrency)
 * - Async file resolution with search path resolution cache
 * - L1 signature-based file scan cache
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
 * Default concurrency limit for parallel file scanning.
 * @type {number}
 */
const DEFAULT_CONCURRENCY = 16;

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
 * Resolves a filename against a list of active include search paths (synchronous, legacy).
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
 * Asynchronously resolves a filename against a list of active include search paths.
 * Uses a resolution cache to avoid redundant filesystem queries for repeated lookups.
 * 
 * @param {string} fileName - Filename to search for.
 * @param {string[]} searchPaths - Ordered array of folder search paths.
 * @param {Map<string, string|null>} resolutionCache - Cache mapping (fileName + searchPaths hash) → resolved path.
 * @returns {Promise<string|null>} Resolved absolute file path, or null if not found.
 */
async function resolveIncludeFromSearchPathsAsync(fileName, searchPaths, resolutionCache) {
    const cacheKey = fileName + '\0' + searchPaths.join('\0');
    if (resolutionCache.has(cacheKey)) {
        return resolutionCache.get(cacheKey);
    }

    for (const searchPath of searchPaths) {
        const fullPath = path.resolve(searchPath, fileName);
        try {
            await fs.promises.access(fullPath, fs.constants.F_OK);
            resolutionCache.set(cacheKey, fullPath);
            return fullPath;
        } catch (_error) {
            // File not found at this path, continue searching.
        }
    }

    resolutionCache.set(cacheKey, null);
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
 * Creates a concurrency limiter that restricts the number of parallel async operations.
 * 
 * @param {number} concurrency - Maximum number of concurrent tasks.
 * @returns {function(function(): Promise<T>): Promise<T>} A function wrapping async operations with concurrency control.
 * @template T
 */
function createConcurrencyLimiter(concurrency) {
    let activeCount = 0;
    const queue = [];

    function run() {
        while (activeCount < concurrency && queue.length > 0) {
            const { fn, resolve, reject } = queue.shift();
            activeCount++;
            fn().then(
                (result) => { activeCount--; resolve(result); run(); },
                (error) => { activeCount--; reject(error); run(); }
            );
        }
    }

    return function limit(fn) {
        return new Promise((resolve, reject) => {
            queue.push({ fn, resolve, reject });
            run();
        });
    };
}

/**
 * Factory function to create a Project Indexer.
 * 
 * @param {Object} [options={}] - Custom scan overrides.
 * @param {function(string): Promise<import('../parser/includeScanner').IncludeResult>} [options.collectIncludeDirectivesFromFile] - Custom include parser.
 * @param {function(string): Promise<import('../parser/keywordScanner').ScannedKeyword[]>} [options.collectKeywordsFromFile] - Custom keyword parser.
 * @param {function(string): Promise<import('../cache/diskSnapshotStore').FileSignature>} [options.getFileSignature] - Custom file signature reader.
 * @param {number} [options.concurrency] - Maximum number of parallel file scans.
 * @param {Object} [options.persistentFileScanCache] - Optional persistent per-file scan cache store.
 * @returns {{
 *   buildProjectIndex: function(string): Promise<ProjectIndexResult>
 * }} A project indexer instance.
 */
function createProjectIndexer({
    collectIncludeDirectivesFromFile = includeScanner.collectIncludeDirectivesFromFile,
    collectKeywordsFromFile = keywordScanner.collectKeywordsFromFile,
    getFileSignature = readFileSignature,
    concurrency = DEFAULT_CONCURRENCY,
    persistentFileScanCache = null,
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
     * Performs a file-level scan (keywords, includes, paths), utilizing L1 in-memory cache
     * and optional L1.5 persistent per-file disk cache.
     * 
     * @param {string} filePath - Target file path.
     * @param {Object} options - Indexing options.
     * @param {{scannedFileCount: number, reusedFileCount: number}} stats - Indexing session statistics.
     * @returns {Promise<Object>} The cached or newly scanned file result.
     */
    async function loadFileScan(filePath, options, stats) {
        const resolvedFilePath = resolveProjectFile(filePath);
        const fileCacheKey = getProjectFileCacheKey(resolvedFilePath);
        const signature = await getFileSignature(resolvedFilePath);
        const cachedEntry = fileScanCache.get(fileCacheKey);

        if (cachedEntry && areFileSignaturesEqual(cachedEntry.signature, signature)) {
            stats.reusedFileCount += 1;
            return cachedEntry.scanResult;
        }

        // Try L1.5 persistent per-file cache
        if (persistentFileScanCache) {
            try {
                const persistedResult = await persistentFileScanCache.get(resolvedFilePath, signature);
                if (persistedResult) {
                    fileScanCache.set(fileCacheKey, { signature, scanResult: persistedResult });
                    stats.reusedFileCount += 1;
                    return persistedResult;
                }
            } catch (_error) {
                // Best-effort: fall through to full scan
            }
        }

        const keywords = await collectKeywordsFromFile(resolvedFilePath, options);
        const { includeEntries, searchPaths } = await collectIncludeDirectivesFromFile(resolvedFilePath, options);
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

        // Persist to L1.5 cache (fire-and-forget)
        if (persistentFileScanCache) {
            persistentFileScanCache.set(resolvedFilePath, signature, scanResult).catch(() => {
                // Best-effort persistence
            });
        }

        return scanResult;
    }

    /**
     * Rebuilds the project index starting from the given root file using BFS with parallel scanning.
     * 
     * Files at each BFS level are scanned concurrently (up to the concurrency limit) to maximize
     * I/O throughput. Cycle detection and ancestry tracking are maintained per-path via the queue.
     * 
     * @param {string} rootFile - Absolute path to the main LS-DYNA input deck.
     * @param {Object} [options] - Indexing options.
     * @param {function(Object): void} [onProgress] - Optional callback for periodic snapshot progress.
     * @returns {Promise<ProjectIndexResult>} The assembled project index snapshot.
     */
    async function buildProjectIndex(rootFile, options = {}, onProgress = null) {
        const resolvedRootFile = resolveProjectFile(rootFile);
        const files = [];
        const keywordMap = new Map();
        const graph = new ProjectGraph();
        const visited = new Set();
        const stats = {
            scannedFileCount: 0,
            reusedFileCount: 0,
        };
        let lastProgressTime = Date.now();

        const limit = createConcurrencyLimiter(concurrency);
        const resolutionCache = new Map();

        /**
         * @typedef {Object} BFSQueueItem
         * @property {string} filePath - Resolved file path to visit.
         * @property {string[]} ancestry - Traversal ancestry chain.
         */

        /** @type {BFSQueueItem[]} */
        let currentLevel = [{ filePath: resolvedRootFile, ancestry: [] }];

        while (currentLevel.length > 0) {
            // Filter out already-visited files before scanning
            const toScan = [];
            for (const item of currentLevel) {
                if (!visited.has(item.filePath)) {
                    visited.add(item.filePath);
                    files.push(item.filePath);
                    graph.addFile(item.filePath);
                    toScan.push(item);
                }
            }

            if (toScan.length === 0) break;

            // Scan all files in this level in parallel (with concurrency limit)
            const scanResults = await Promise.all(
                toScan.map(item => limit(() => loadFileScan(item.filePath, options, stats)))
            );

            /** @type {BFSQueueItem[]} */
            const nextLevel = [];

            for (let i = 0; i < toScan.length; i++) {
                const { filePath: resolvedFilePath, ancestry } = toScan[i];
                const scanResult = scanResults[i];

                addKeywordUsages(keywordMap, scanResult.keywords);

                // Resolve all includes for this file in parallel
                const includeResolutions = await Promise.all(
                    scanResult.includeEntries.map(entry =>
                        resolveIncludeFromSearchPathsAsync(entry.fileName, scanResult.searchPaths, resolutionCache)
                    )
                );

                for (let j = 0; j < scanResult.includeEntries.length; j++) {
                    const entry = scanResult.includeEntries[j];
                    const { fileName, lineIndex, startChar, endChar } = entry;
                    const resolvedPath = includeResolutions[j];

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

                    if (!visited.has(resolvedPath)) {
                        nextLevel.push({
                            filePath: resolvedPath,
                            ancestry: [...ancestry, resolvedFilePath],
                        });
                    }
                }
            }

            // Report progress between BFS levels
            if (onProgress && Date.now() - lastProgressTime >= 500) {
                lastProgressTime = Date.now();
                onProgress({
                    rootFile: resolvedRootFile,
                    files: [...files],
                    graph,
                    keywordMap,
                    missingFiles: graph.missingFiles,
                    cycles: graph.cycles,
                    stats: { ...stats },
                });
            }

            currentLevel = nextLevel;
        }

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
    resolveIncludeFromSearchPaths,
    resolveIncludeFromSearchPathsAsync,
    createConcurrencyLimiter,
};
