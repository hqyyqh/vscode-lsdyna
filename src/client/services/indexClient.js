'use strict';

/**
 * @fileoverview LSP Client-Server snapshot coordinator and L1 cache client.
 * @module client/services/indexClient
 * 
 * This module creates the IndexClient instance. In client mode (within VS Code host), it delegates
 * calls to the LSP LanguageClient. In server mode (within Language Server process), it coordinates
 * background indexing, manages in-memory L1 snapshot cache, verifies tracked file signatures, 
 * maps cache access histories (LRU), and interacts with the L2 disk persistent snapshot cache.
 * 
 * Role in System: Central gateway bridging the UI tree providers to the indexing engine.
 */

const fs = require('fs');
const path = require('path');

const { createCacheManifestStore } = require('../../core/cache/cacheManifestStore');
const { hydrateProjectSnapshot } = require('../../core/cache/snapshotSerializer');
const protocol = require('../../shared/protocol');

/**
 * Resolves a root file path, performing validation checks.
 * 
 * @param {string} rootFile - Root file path.
 * @returns {string} Absolute path.
 * @throws {TypeError} If path is not a valid string.
 */
function resolveRootFile(rootFile) {
    if (typeof rootFile !== 'string' || rootFile.trim() === '') {
        throw new TypeError('loadProjectSnapshot requires a rootFile path');
    }
    return path.resolve(rootFile);
}

/**
 * Generates a normalized map key for the root file. Handles Windows casing.
 * 
 * @param {string} rootFile - Root file path.
 * @returns {string} Normalized lookup key.
 */
function getRootCacheKey(rootFile) {
    const resolvedRootFile = resolveRootFile(rootFile);
    return process.platform === 'win32'
        ? resolvedRootFile.toLowerCase()
        : resolvedRootFile;
}

/**
 * Resolves the list of files tracked inside a project snapshot.
 * 
 * @param {import('../../core/project/projectIndexer').ProjectIndexResult} snapshot - Project index snapshot.
 * @returns {string[]} File list.
 */
function getTrackedSnapshotFiles(snapshot) {
    if (Array.isArray(snapshot.files) && snapshot.files.length > 0) {
        return snapshot.files;
    }
    return [snapshot.rootFile];
}

/**
 * Compares two file signatures to check if they match.
 * 
 * @param {import('../../core/cache/diskSnapshotStore').FileSignature|null|undefined} left - Left.
 * @param {import('../../core/cache/diskSnapshotStore').FileSignature|null|undefined} right - Right.
 * @returns {boolean} True if matched.
 */
function areFileSignaturesEqual(left, right) {
    return left
        && right
        && left.mtimeMs === right.mtimeMs
        && left.size === right.size;
}

/**
 * Reads modification and size details for a file from disk.
 * 
 * @param {string} filePath - Absolute path.
 * @returns {Promise<import('../../core/cache/diskSnapshotStore').FileSignature>} File signature.
 */
async function readFileSignature(filePath) {
    const stat = await fs.promises.stat(filePath);
    return {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
    };
}

/**
 * Captures file signatures for all files tracked by a project snapshot.
 * 
 * @param {import('../../core/project/projectIndexer').ProjectIndexResult} snapshot - Snapshot.
 * @param {function(string): Promise<import('../../core/cache/diskSnapshotStore').FileSignature>} getFileSignature - Signature function.
 * @returns {Promise<import('../../core/cache/diskSnapshotStore').TrackedFileEntry[]>} Tracked files with signatures.
 */
async function captureTrackedFiles(snapshot, getFileSignature) {
    const trackedFiles = [];
    const seen = new Set();

    for (const filePath of getTrackedSnapshotFiles(snapshot)) {
        const resolvedFilePath = resolveRootFile(filePath);
        const fileCacheKey = getRootCacheKey(resolvedFilePath);
        if (seen.has(fileCacheKey)) continue;
        seen.add(fileCacheKey);
        trackedFiles.push({
            filePath: resolvedFilePath,
            signature: await getFileSignature(resolvedFilePath),
        });
    }

    return trackedFiles;
}

/**
 * Validates whether all tracked files matching a manifest catalog entry remain unmodified on disk.
 * 
 * @param {Object} entry - Manifest entry block.
 * @param {import('../../core/cache/diskSnapshotStore').TrackedFileEntry[]} entry.trackedFiles - Tracked files.
 * @param {function(string): Promise<import('../../core/cache/diskSnapshotStore').FileSignature>} getFileSignature - Signature reader.
 * @returns {Promise<boolean>} True if cache entry matches filesystem state.
 */
async function isSnapshotValid(entry, getFileSignature) {
    if (!Array.isArray(entry.trackedFiles) || entry.trackedFiles.length === 0) {
        return false;
    }

    for (const trackedFile of entry.trackedFiles) {
        try {
            const currentSignature = await getFileSignature(trackedFile.filePath);
            if (!areFileSignaturesEqual(currentSignature, trackedFile.signature)) {
                return false;
            }
        } catch (_error) {
            return false;
        }
    }

    return true;
}

/**
 * Estimates serialized memory size of a snapshot object.
 * 
 * @param {Object} snapshot - Snapshot object.
 * @returns {number} Byte count.
 */
function estimateSnapshotSize(snapshot) {
    return Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
}

/**
 * Summarizes caches memory metrics.
 * 
 * @param {Map<string, Object>} snapshots - Active cached snapshots.
 * @returns {{cachedSnapshotCount: number, totalSnapshotBytes: number}} Stats details.
 */
function getSnapshotCacheStats(snapshots) {
    let cachedSnapshotCount = 0;
    let totalSnapshotBytes = 0;

    for (const entry of snapshots.values()) {
        if (!entry || !entry.snapshot || typeof entry.byteSize !== 'number') continue;
        cachedSnapshotCount += 1;
        totalSnapshotBytes += entry.byteSize;
    }

    return {
        cachedSnapshotCount,
        totalSnapshotBytes,
    };
}

/**
 * @typedef {Object} ClientOptions
 * @property {function(string): Promise<import('../../core/project/projectIndexer').ProjectIndexResult>} [buildProjectIndex] - Main index builder.
 * @property {function(string): Promise<import('../../core/cache/diskSnapshotStore').FileSignature>} [getFileSignature] - Signature reader.
 * @property {function(Object): number} [estimateSnapshotSize] - Size estimator.
 * @property {number} [maxSnapshotBytes] - Cache limit.
 * @property {Object} [manifestStore] - Cache catalog store.
 * @property {import('../../core/cache/diskSnapshotStore').DiskSnapshotStore} [persistentCache] - L2 disk cache.
 * @property {Object} [languageClient] - VS Code LanguageClient bridge (present only in client mode).
 */

/**
 * Factory function to create an Index Client instance.
 * 
 * @param {ClientOptions} [options={}] - Config parameters.
 * @returns {{
 *   loadProjectSnapshot: function(string): Promise<import('../../core/project/projectIndexer').ProjectIndexResult>,
 *   invalidate: function(string): void,
 *   getManifestEntries: function(): Promise<import('../../core/cache/cacheManifestStore').ManifestEntry[]>,
 *   getCacheStats: function(): Promise<{cachedSnapshotCount: number, totalSnapshotBytes: number}>
 * }} Client API.
 */
function createIndexClient({
    buildProjectIndex,
    getFileSignature = readFileSignature,
    estimateSnapshotSize: getSnapshotSize = estimateSnapshotSize,
    maxSnapshotBytes = Number.POSITIVE_INFINITY,
    manifestStore = createCacheManifestStore(),
    persistentCache = null,
    languageClient = null,
} = {}) {
    if (languageClient) {
        if (typeof languageClient.sendRequest !== 'function' || typeof languageClient.sendNotification !== 'function') {
            throw new TypeError('createIndexClient requires a languageClient supporting sendRequest and sendNotification');
        }
        let progressCallback = null;
        
        // Delay binding the notification until the client is fully initialized
        const bindNotification = async () => {
            try {
                if (typeof languageClient.onReady === 'function') {
                    await languageClient.onReady();
                } else if (languageClient.state !== 2) { // 2 = State.Running
                    // Give it some time to start if onReady is missing
                    await new Promise(r => setTimeout(r, 500));
                }
                languageClient.onNotification(protocol.SCAN_PROGRESS_NOTIFICATION, (params) => {
                    if (progressCallback) {
                        progressCallback(hydrateProjectSnapshot(params));
                    }
                });
            } catch (e) {
                // Ignore if client fails to start
            }
        };
        bindNotification();
        return {
            async loadProjectSnapshot(rootFile, onProgress = null) {
                if (typeof languageClient.onReady === 'function') {
                    await languageClient.onReady();
                }
                progressCallback = onProgress;
                const resolvedRootFile = resolveRootFile(rootFile);
                try {
                    const serialized = await languageClient.sendRequest(
                        protocol.LOAD_PROJECT_SNAPSHOT_REQUEST,
                        { rootFile: resolvedRootFile }
                    );
                    return hydrateProjectSnapshot(serialized);
                } finally {
                    progressCallback = null;
                }
            },
            async invalidate(rootFile) {
                if (typeof languageClient.onReady === 'function') {
                    await languageClient.onReady();
                }
                const resolvedRootFile = resolveRootFile(rootFile);
                languageClient.sendNotification(
                    protocol.INVALIDATE_NOTIFICATION,
                    { rootFile: resolvedRootFile }
                );
            },
            async getManifestEntries() {
                if (typeof languageClient.onReady === 'function') {
                    await languageClient.onReady();
                }
                return await languageClient.sendRequest(protocol.GET_MANIFEST_ENTRIES_REQUEST);
            },
            async getCacheStats() {
                if (typeof languageClient.onReady === 'function') {
                    await languageClient.onReady();
                }
                return await languageClient.sendRequest(protocol.GET_CACHE_STATS_REQUEST);
            },
        };
    }

    if (typeof buildProjectIndex !== 'function') {
        throw new TypeError('createIndexClient requires a buildProjectIndex function');
    }
    if (typeof getFileSignature !== 'function') {
        throw new TypeError('createIndexClient requires getFileSignature to be a function');
    }
    if (typeof getSnapshotSize !== 'function') {
        throw new TypeError('createIndexClient requires estimateSnapshotSize to be a function');
    }
    if (typeof maxSnapshotBytes !== 'number' || Number.isNaN(maxSnapshotBytes) || maxSnapshotBytes <= 0) {
        throw new TypeError('createIndexClient requires maxSnapshotBytes to be a positive number');
    }
    if (!manifestStore || typeof manifestStore.upsert !== 'function' || typeof manifestStore.remove !== 'function') {
        throw new TypeError('createIndexClient requires manifestStore to support upsert and remove');
    }
    if (persistentCache && typeof persistentCache.persist !== 'function') {
        throw new TypeError('createIndexClient requires persistentCache.persist to be a function');
    }

    const snapshots = new Map();
    const generations = new Map();
    let accessSequence = 0;

    function getGeneration(rootCacheKey) {
        return generations.get(rootCacheKey) || 0;
    }

    function touchSnapshotEntry(entry) {
        entry.lastAccessedAt = ++accessSequence;
        manifestStore.upsert({
            rootFile: entry.snapshot.rootFile,
            trackedFiles: entry.trackedFiles.map(trackedFile => trackedFile.filePath),
            byteSize: entry.byteSize,
            lastAccessedAt: entry.lastAccessedAt,
        });
    }

    function evictSnapshotsIfNeeded(protectedRootCacheKey) {
        let cacheStats = getSnapshotCacheStats(snapshots);
        while (cacheStats.totalSnapshotBytes > maxSnapshotBytes) {
            const evictionCandidates = [...snapshots.entries()]
                .filter(([rootCacheKey, entry]) => (
                    rootCacheKey !== protectedRootCacheKey
                    && entry
                    && entry.snapshot
                    && typeof entry.byteSize === 'number'
                ))
                .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);

            if (evictionCandidates.length === 0) break;
            manifestStore.remove(evictionCandidates[0][1].snapshot.rootFile);
            snapshots.delete(evictionCandidates[0][0]);
            cacheStats = getSnapshotCacheStats(snapshots);
        }
    }

    async function loadProjectSnapshot(rootFile, onProgress = null) {
        const resolvedRootFile = resolveRootFile(rootFile);
        const rootCacheKey = getRootCacheKey(rootFile);

        while (snapshots.has(rootCacheKey)) {
            const cachedEntry = snapshots.get(rootCacheKey);
            if (cachedEntry.promise) return cachedEntry.promise;

            const valid = await isSnapshotValid(cachedEntry, getFileSignature);
            const currentEntry = snapshots.get(rootCacheKey);
            if (currentEntry !== cachedEntry) continue;
            if (valid) {
                touchSnapshotEntry(cachedEntry);
                return cachedEntry.snapshot;
            }

            invalidate(resolvedRootFile);
        }

        const generation = getGeneration(rootCacheKey);
        const promise = (async () => {
            if (persistentCache) {
                try {
                    const restored = await persistentCache.restore(resolvedRootFile);
                    if (restored) {
                        const currentEntry = snapshots.get(rootCacheKey);
                        if (getGeneration(rootCacheKey) === generation && currentEntry && currentEntry.promise === promise) {
                            const entry = {
                                snapshot: restored.snapshot,
                                trackedFiles: restored.trackedFiles,
                                byteSize: getSnapshotSize(restored.snapshot),
                            };
                            touchSnapshotEntry(entry);
                            snapshots.set(rootCacheKey, entry);
                            evictSnapshotsIfNeeded(rootCacheKey);
                        }
                        return restored.snapshot;
                    }
                } catch (_error) {
                    // Best-effort L2 restore: fall back to building the index if recovery fails.
                }
            }

            const snapshot = await buildProjectIndex(resolvedRootFile, onProgress);
            let trackedFiles = null;
            try {
                trackedFiles = await captureTrackedFiles(snapshot, getFileSignature);
            } catch (_error) {
                trackedFiles = null;
            }

            const currentEntry = snapshots.get(rootCacheKey);
            if (getGeneration(rootCacheKey) === generation && currentEntry && currentEntry.promise === promise) {
                if (trackedFiles) {
                    const entry = {
                        snapshot,
                        trackedFiles,
                        byteSize: getSnapshotSize(snapshot),
                    };
                    touchSnapshotEntry(entry);
                    snapshots.set(rootCacheKey, entry);
                    evictSnapshotsIfNeeded(rootCacheKey);
                    if (persistentCache) {
                        Promise.resolve()
                            .then(() => persistentCache.persist({ snapshot, trackedFiles }))
                            .catch(() => {
                                // Best-effort persistence: disk cache failures must not break primary indexing.
                            });
                    }
                } else {
                    manifestStore.remove(resolvedRootFile);
                    snapshots.delete(rootCacheKey);
                }
            }
            return snapshot;
        })().catch(error => {
            const currentEntry = snapshots.get(rootCacheKey);
            if (currentEntry && currentEntry.promise === promise) {
                manifestStore.remove(resolvedRootFile);
                snapshots.delete(rootCacheKey);
            }
            throw error;
        });

        snapshots.set(rootCacheKey, { promise });
        return promise;
    }

    /**
     * Invalidates cache entry matching the root file.
     * 
     * @param {string} rootFile - Target root path.
     */
    function invalidate(rootFile) {
        const resolvedRootFile = resolveRootFile(rootFile);
        const rootCacheKey = getRootCacheKey(rootFile);
        generations.set(rootCacheKey, getGeneration(rootCacheKey) + 1);
        manifestStore.remove(resolvedRootFile);
        snapshots.delete(rootCacheKey);
    }

    return {
        getCacheStats() {
            return getSnapshotCacheStats(snapshots);
        },
        getManifestEntries() {
            return manifestStore.list();
        },
        invalidate,
        loadProjectSnapshot,
    };
}

module.exports = {
    createIndexClient,
};
