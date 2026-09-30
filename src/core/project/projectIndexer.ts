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
const {
    localDeclaredSearchPaths,
    mergeEffectiveSearchPaths,
    inheritedPathsForChild,
} = require('./includeSearchPathResolve');

const includeScanner = require('../parser/includeScanner');
const keywordScanner = require('../parser/keywordScanner');
const { buildFileIndex, buildFileStructure, completeFileIndex } = require('../scanner/fileIndexBuilder');
const { SCANNER_VERSION, throwIfCancellationRequested } = require('../scanner/scannerContracts');
const { ProjectGraph } = require('./projectGraph');

type FileSignature = {
    mtimeMs: number;
    size: number;
};

type FileScanResult = {
    scanOptionsKey?: string;
    filePath: string;
    fileIndex: any;
    keywords: Array<{ keyword: string; filePath: string; lineIndex: number }>;
    includeEntries: Array<{
        fileName: string;
        lineIndex: number;
        startChar: number;
        endChar: number;
        keyword?: string;
        keywordLine?: number;
        transform?: any;
        parameterizedFileName?: boolean;
        inputFormatOverride?: 'long' | 'standard';
    }>;
    searchPaths: string[];
};

type ProjectIndexBuildOptions = {
    cancellationToken?: { isCancellationRequested?: boolean };
    singleFileOnly?: boolean;
    [key: string]: any;
};

/**
 * Default concurrency limit for parallel file scanning.
 * @type {number}
 */
const DEFAULT_CONCURRENCY = 16;
const DEFAULT_FILE_SCAN_MEMORY_CACHE_BYTES = 16 * 1024 * 1024;

function estimateFileScanResultSize(scanResult) {
    return require('../cache/memorySize').estimateMemorySize(scanResult, DEFAULT_FILE_SCAN_MEMORY_CACHE_BYTES);
}

/**
 * @typedef {Object} ProjectIndexResult
 * @property {string} rootFile - Absolute path to the project's root input file.
 * @property {string[]} files - Array of all absolute file paths tracked in this project.
 * @property {ProjectGraph} graph - The inclusion dependency graph of the project.
 * @property {Map<string, import('../parser/keywordScanner').ScannedKeyword[]>} keywordMap - Registry of keywords associated with their occurrences across the project.
 * @property {import('./projectGraph').MissingFileRecord[]} missingFiles - References to all included files that could not be resolved.
 * @property {import('./projectGraph').CycleRecord[]} cycles - References to circular inclusion loops.
 * @property {Map<string, string[]>} [effectiveSearchPathsByFile] - Effective *INCLUDE* search dirs per file (local + ancestor PATH cards). First BFS visit wins.
 * @property {{scannedFileCount: number, reusedFileCount: number, includeOccurrenceCount: number}} stats - Indexing run performance statistics.
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

async function resolveIncludeWithCandidatesAsync(fileName, searchPaths, resolutionCache) {
    const candidatePaths = [];
    const seen = new Set();
    for (const searchPath of searchPaths) {
        const candidate = path.resolve(searchPath, fileName);
        const key = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
        if (!seen.has(key)) {
            seen.add(key);
            candidatePaths.push(candidate);
        }
    }
    const resolvedPath = await resolveIncludeFromSearchPathsAsync(fileName, searchPaths, resolutionCache);
    return { resolvedPath, candidatePaths };
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

function keywordsFromFileIndex(fileIndex) {
    return (fileIndex.keywordBlocks || []).map(block => ({
        keyword: String(block.keyword || '').startsWith('*')
            ? String(block.keyword).slice(1)
            : String(block.keyword || ''),
        filePath: fileIndex.filePath,
        lineIndex: block.startLine ?? block.lineIndex ?? block.line ?? 0,
    })).filter(entry => entry.keyword);
}

async function buildLegacyFileIndexFromCollectors(filePath, options, collectKeywordsFromFile, collectIncludeDirectivesFromFile) {
    const keywords = await collectKeywordsFromFile(filePath, options);
    const { includeEntries, searchPaths, pathEntries = [] } = await collectIncludeDirectivesFromFile(filePath, options);
    return {
        filePath,
        scannerVersion: SCANNER_VERSION,
        keywordBlocks: (keywords || []).map(entry => ({
            filePath,
            keyword: String(entry.keyword || '').startsWith('*') ? entry.keyword : `*${entry.keyword}`,
            rawKeyword: String(entry.keyword || '').startsWith('*') ? entry.keyword : `*${entry.keyword}`,
            startLine: entry.lineIndex ?? entry.line ?? 0,
            endLine: entry.lineIndex ?? entry.line ?? 0,
            keywordStartChar: 0,
        })),
        includeEntries: includeEntries || [],
        searchPaths: searchPaths || [path.dirname(filePath)],
        pathEntries,
        scanStats: {
            mode: 'stream-skeleton',
            durationMs: 0,
            decodedLineCount: (includeEntries || []).length + pathEntries.length,
            keywordCount: (keywords || []).length,
        },
    };
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
    loadFileIndex = null,
    getFileSignature = readFileSignature,
    concurrency = DEFAULT_CONCURRENCY,
    persistentFileScanCache = null,
    maxFileScanCacheBytes = DEFAULT_FILE_SCAN_MEMORY_CACHE_BYTES,
    estimateFileScanSize = estimateFileScanResultSize,
} = {}) {
    if (loadFileIndex !== null && typeof loadFileIndex !== 'function') {
        throw new TypeError('createProjectIndexer requires loadFileIndex to be a function');
    }
    if (typeof collectIncludeDirectivesFromFile !== 'function') {
        throw new TypeError('createProjectIndexer requires collectIncludeDirectivesFromFile to be a function');
    }
    if (typeof collectKeywordsFromFile !== 'function') {
        throw new TypeError('createProjectIndexer requires collectKeywordsFromFile to be a function');
    }
    if (typeof getFileSignature !== 'function') {
        throw new TypeError('createProjectIndexer requires getFileSignature to be a function');
    }
    if (!Number.isFinite(maxFileScanCacheBytes) || maxFileScanCacheBytes <= 0) {
        throw new TypeError('createProjectIndexer requires maxFileScanCacheBytes to be a positive finite number');
    }
    if (typeof estimateFileScanSize !== 'function') {
        throw new TypeError('createProjectIndexer requires estimateFileScanSize to be a function');
    }

    /** @type {Map<string, { signature: import('../cache/diskSnapshotStore').FileSignature, scanResult: Object, byteSize: number, lastAccessedAt: number }>} */
    const fileScanCache = new Map();
    let fileScanAccessSequence = 0;
    const usesLegacyCollectors = collectIncludeDirectivesFromFile !== includeScanner.collectIncludeDirectivesFromFile
        || collectKeywordsFromFile !== keywordScanner.collectKeywordsFromFile;
    const staged = loadFileIndex === null && !usesLegacyCollectors;
    const effectiveLoadFileIndex = loadFileIndex || (
        usesLegacyCollectors
            ? (filePath, options) => buildLegacyFileIndexFromCollectors(filePath, options, collectKeywordsFromFile, collectIncludeDirectivesFromFile)
            : buildFileIndex
    );

    function getFileScanCacheStats() {
        let totalBytes = 0;
        for (const entry of fileScanCache.values()) totalBytes += entry.byteSize;
        return { entryCount: fileScanCache.size, totalBytes };
    }

    function cacheFileScan(fileCacheKey, signature, scanResult) {
        const measuredByteSize = Number(estimateFileScanSize(scanResult));
        const entry = {
            signature,
            scanResult,
            byteSize: Number.isFinite(measuredByteSize) && measuredByteSize >= 0
                ? measuredByteSize
                : Number.POSITIVE_INFINITY,
            lastAccessedAt: ++fileScanAccessSequence,
        };
        if (entry.byteSize > maxFileScanCacheBytes) return false;
        fileScanCache.set(fileCacheKey, entry);
        let stats = getFileScanCacheStats();
        while (stats.totalBytes > maxFileScanCacheBytes) {
            const candidates = [...fileScanCache.entries()]
                .filter(([cacheKey]) => cacheKey !== fileCacheKey)
                .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);
            const victimKey = candidates.length > 0 ? candidates[0][0] : fileCacheKey;
            if (!fileScanCache.delete(victimKey)) break;
            stats = getFileScanCacheStats();
        }
        return fileScanCache.has(fileCacheKey);
    }

    /**
     * Performs a file-level scan (keywords, includes, paths), utilizing L1 in-memory cache
     * and optional L1.5 persistent per-file disk cache.
     * 
     * @param {string} filePath - Target file path.
     * @param {Object} options - Indexing options.
     * @param {{scannedFileCount: number, reusedFileCount: number, includeOccurrenceCount: number}} stats - Indexing session statistics.
     * @returns {Promise<Object>} The cached or newly scanned file result.
     */
    async function loadFileScan(filePath, options, stats): Promise<FileScanResult> {
        throwIfCancellationRequested(options.cancellationToken);
        const resolvedFilePath = resolveProjectFile(filePath);
        const scanOptionsKey = JSON.stringify([options.maxDefinitionBlockBytes ?? null,
            options.maxReferenceBlockBytes ?? null, options.largeFileThresholdBytes ?? null,
            options.fullScanLargeFiles ?? false]);
        const fileCacheKey = getProjectFileCacheKey(resolvedFilePath) + scanOptionsKey + (options.structureOnly ? ':structure' : '');
        const signature = await getFileSignature(resolvedFilePath);
        throwIfCancellationRequested(options.cancellationToken);
        const cachedEntry = fileScanCache.get(fileCacheKey);

        if (cachedEntry && areFileSignaturesEqual(cachedEntry.signature, signature)) {
            cachedEntry.lastAccessedAt = ++fileScanAccessSequence;
            if (!options.structure) stats.reusedFileCount += 1;
            return cachedEntry.scanResult;
        }

        // Try L1.5 persistent per-file cache
        if (persistentFileScanCache && !options.structureOnly) {
            try {
                const persistedResult = await persistentFileScanCache.get(resolvedFilePath, signature);
                throwIfCancellationRequested(options.cancellationToken);
                if (persistedResult && persistedResult.scanOptionsKey === scanOptionsKey) {
                    cacheFileScan(fileCacheKey, signature, persistedResult);
                    if (!options.structure) stats.reusedFileCount += 1;
                    return persistedResult;
                }
            } catch (error) {
                if (error?.name === 'CancellationError') throw error;
                throwIfCancellationRequested(options.cancellationToken);
                // Best-effort: fall through to full scan
            }
        }

        const fileIndex = options.structureOnly
            ? await buildFileStructure(resolvedFilePath, options)
            : options.structure
                ? await completeFileIndex(options.structure, options)
                : await effectiveLoadFileIndex(resolvedFilePath, options);
        const after = await getFileSignature(resolvedFilePath);
        if (!areFileSignaturesEqual(signature, after) || (options.structure &&
            !areFileSignaturesEqual(signature, options.structure))) {
            const error = new Error('File changed during scan: ' + resolvedFilePath);
            error.name = 'ScanChangedError';
            throw error;
        }
        throwIfCancellationRequested(options.cancellationToken);
        const keywords = options.structureKeywords || keywordsFromFileIndex(fileIndex);
        const scanResult: FileScanResult = {
            scanOptionsKey,
            filePath: resolvedFilePath,
            fileIndex,
            keywords,
            includeEntries: fileIndex.includeEntries || [],
            searchPaths: fileIndex.searchPaths || [path.dirname(resolvedFilePath)],
        };

        cacheFileScan(fileCacheKey, signature, scanResult);
        if (!options.structure) stats.scannedFileCount += 1;

        // Persist to L1.5 cache (fire-and-forget)
        if (persistentFileScanCache && !options.structureOnly) {
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
     * @param {ProjectIndexBuildOptions} [options] - Indexing options.
     * @param {function(Object): void} [onProgress] - Optional callback for periodic snapshot progress.
     * @returns {Promise<ProjectIndexResult>} The assembled project index snapshot.
     */
    async function buildProjectIndexOnce(rootFile, options: ProjectIndexBuildOptions = {}, onProgress = null) {
        throwIfCancellationRequested(options.cancellationToken);
        const resolvedRootFile = resolveProjectFile(rootFile);
        const files = [];
        const fileIndexes = new Map();
        const keywordMap = new Map();
        const graph = new ProjectGraph();
        const visited = new Set();
        /** @type {Map<string, string[]>} first-visit effective search paths (ancestor PATH inheritance) */
        const effectiveSearchPathsByFile = new Map();
        const stats = {
            scannedFileCount: 0,
            reusedFileCount: 0,
            includeOccurrenceCount: 0,
        };
        let lastProgressTime = 0;
        let lastPhase = '';
        const progress = (event) => {
            if (!onProgress) return;
            if (event.phase !== lastPhase || Date.now() - lastProgressTime >= 200) {
                lastPhase = event.phase;
                lastProgressTime = Date.now();
                onProgress({ type: 'progress', rootFile: resolvedRootFile, ...event });
            }
        };
        progress({ phase: 'structure', processedFiles: 0 });

        const limit = createConcurrencyLimiter(concurrency);
        const resolutionCache = new Map();
        const scans = new Map<string, Promise<any>>();
        const startScan = (filePath) => {
            if (!scans.has(filePath)) {
                const pending = limit(() => loadFileScan(filePath, { ...options, structureOnly: staged }, stats));
                pending.catch(() => {});
                scans.set(filePath, pending);
            }
            return scans.get(filePath);
        };

        /**
         * @typedef {Object} BFSQueueItem
         * @property {string} filePath - Resolved file path to visit.
         * @property {string[]} ancestry - Traversal ancestry chain.
         * @property {string[]} inheritedPaths - Absolute PATH dirs from ancestors (cards only).
         */

        /** @type {BFSQueueItem[]} */
        let currentLevel = [{ filePath: resolvedRootFile, ancestry: [], inheritedPaths: [] }];

        while (currentLevel.length > 0) {
            throwIfCancellationRequested(options.cancellationToken);
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
            const scanResults = toScan.map(item => startScan(item.filePath));
            // Observe failures immediately while consuming in deterministic BFS order.
            for (const pending of scanResults) pending.catch(() => {});
            throwIfCancellationRequested(options.cancellationToken);

            /** @type {BFSQueueItem[]} */
            const nextLevel = [];

            for (let i = 0; i < toScan.length; i++) {
                throwIfCancellationRequested(options.cancellationToken);
                const { filePath: resolvedFilePath, ancestry, inheritedPaths } = toScan[i];
                const scanResult = await scanResults[i] as FileScanResult;
                progress({ phase: "structure", filePath: resolvedFilePath, processedFiles: fileIndexes.size + 1 });

                if (scanResult.fileIndex) {
                    fileIndexes.set(resolvedFilePath, scanResult.fileIndex);
                }
                addKeywordUsages(keywordMap, scanResult.keywords);

                // A disk-backed entity-ID query may need one very large file without claiming
                // or traversing its Include closure. The file index still records Include cards,
                // but they do not enter the project graph or BFS queue in this explicit scope.
                if (options.singleFileOnly === true) continue;

                const fileDir = path.dirname(resolvedFilePath);
                const pathEntries = scanResult.fileIndex && scanResult.fileIndex.pathEntries
                    ? scanResult.fileIndex.pathEntries
                    : [];
                const localDeclared = localDeclaredSearchPaths({
                    fileDir,
                    searchPaths: scanResult.searchPaths,
                    pathEntries,
                });
                const effectivePaths = mergeEffectiveSearchPaths({
                    fileDir,
                    localDeclaredPaths: localDeclared,
                    inheritedPaths: inheritedPaths || [],
                });
                // First BFS visit wins (diamond: later parents do not rescan with other PATH sets).
                if (!effectiveSearchPathsByFile.has(resolvedFilePath)) {
                    effectiveSearchPathsByFile.set(resolvedFilePath, effectivePaths);
                }

                const childInherited = inheritedPathsForChild({
                    localDeclaredPaths: localDeclared,
                    inheritedPaths: inheritedPaths || [],
                });

                // Resolve all includes using ancestor-aware search paths
                const includeResolutions = await Promise.all(
                    scanResult.includeEntries.map(entry =>
                        resolveIncludeWithCandidatesAsync(entry.fileName, effectivePaths, resolutionCache)
                    )
                );
                throwIfCancellationRequested(options.cancellationToken);

                for (let j = 0; j < scanResult.includeEntries.length; j++) {
                    throwIfCancellationRequested(options.cancellationToken);
                    const entry = scanResult.includeEntries[j];
                    const {
                        fileName,
                        lineIndex,
                        startChar,
                        endChar,
                        keyword,
                        keywordLine,
                        transform,
                        parameterizedFileName,
                        inputFormatOverride,
                    } = entry;
                    const { resolvedPath, candidatePaths } = includeResolutions[j];

                    if (!resolvedPath) {
                        graph.addMissingFile({
                            fromFile: resolvedFilePath,
                            fileName,
                            lineIndex,
                            startChar,
                            endChar,
                            filePath: candidatePaths[0] || path.resolve(path.dirname(resolvedFilePath), fileName),
                            candidatePaths,
                            keyword,
                            keywordLine,
                            transform,
                            parameterizedFileName,
                            inputFormatOverride,
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
                        graph.addIncludeOccurrence(resolvedFilePath, {
                            filePath: resolvedPath,
                            fileName,
                            lineIndex,
                            startChar,
                            endChar,
                            keyword,
                            keywordLine,
                            transform,
                            parameterizedFileName,
                            inputFormatOverride,
                            cycle: true,
                        });
                        continue;
                    }

                    graph.addIncludeEdge(resolvedFilePath, resolvedPath, {
                        filePath: resolvedPath,
                        fileName,
                        lineIndex,
                        startChar,
                        endChar,
                        keyword,
                        keywordLine,
                        transform,
                        parameterizedFileName,
                        inputFormatOverride,
                    });

                    if (!visited.has(resolvedPath)) {
                        startScan(resolvedPath);
                        nextLevel.push({
                            filePath: resolvedPath,
                            ancestry: [...ancestry, resolvedFilePath],
                            inheritedPaths: childInherited,
                        });
                    }
                }
            }

            currentLevel = nextLevel;
        }

        stats.includeOccurrenceCount = graph.includeOccurrences.length;
        const snapshot = {
            scope: options.singleFileOnly === true ? 'single-file' : 'project',
            rootFile: resolvedRootFile,
            files,
            fileIndexes,
            graph,
            keywordMap,
            missingFiles: graph.missingFiles,
            cycles: graph.cycles,
            effectiveSearchPathsByFile,
            stats,
        };
        if (staged) {
            onProgress?.({ type: 'structureReady', rootFile: resolvedRootFile,
                snapshot: { ...snapshot, phase: 'structure', fileIndexes: new Map(), keywordMap: new Map() } });
            progress({ phase: 'references', processedFiles: 0 });
            for (const filePath of files) {
                const result = await loadFileScan(filePath, { ...options,
                    structure: fileIndexes.get(filePath), structureKeywords: (await scans.get(filePath)).keywords,
                    onProgress: progress }, stats);
                fileIndexes.set(filePath, result.fileIndex);
            }
            // Reject mixed versions even when a previously completed file changes later.
            for (const [filePath, index] of fileIndexes) {
                const signature = await getFileSignature(filePath);
                if (!areFileSignaturesEqual(signature, index)) {
                    const error = new Error('File changed during scan: ' + filePath);
                    error.name = 'ScanChangedError';
                    throw error;
                }
            }
        }
        return snapshot;
    }

    async function buildProjectIndex(rootFile, options = {}, onProgress = null) {
        for (let attempt = 0; ; attempt++) {
            try { return await buildProjectIndexOnce(rootFile, options, onProgress); }
            catch (error) {
                if (error?.name !== 'ScanChangedError' || attempt >= 1) throw error;
                onProgress?.({ type: 'progress', rootFile: resolveProjectFile(rootFile), phase: 'restarting' });
            }
        }
    }

    return {
        buildProjectIndex,
        clearMemoryCache() {
            const removed = getFileScanCacheStats();
            fileScanCache.clear();
            return removed;
        },
        getMemoryCacheStats: getFileScanCacheStats,
    };
}

const defaultProjectIndexer = createProjectIndexer();

module.exports = {
    buildProjectIndex: defaultProjectIndexer.buildProjectIndex,
    createProjectIndexer,
    resolveIncludeFromSearchPaths,
    resolveIncludeFromSearchPathsAsync,
    resolveIncludeWithCandidatesAsync,
    createConcurrencyLimiter,
    DEFAULT_FILE_SCAN_MEMORY_CACHE_BYTES,
    estimateFileScanResultSize,
};

export {};
