'use strict';

/**
 * @fileoverview High-performance persistent disk storage for project snapshots with auto-vacuuming LRU eviction.
 * @module core/cache/diskSnapshotStore
 * 
 * This module serializes and writes project snapshots to disk, maintaining an index file and individual payload files.
 * It validates file modification times and sizes (FileSignature) to invalidate cache entries when files are modified externally.
 * It runs all operations in a serialized queue (runExclusive) to prevent concurrent write corruption.
 * 
 * Role in System: Provides L2 persistent caching, letting VS Code restore the project index instantly on startup without re-scanning.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { hydrateProjectSnapshot, serializeProjectSnapshot } = require('./snapshotSerializer');

const INDEX_FILE_NAME = 'index.json';
const PAYLOAD_DIRECTORY_NAME = 'payloads';
const SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * @typedef {Object} FileSignature
 * @property {number} mtimeMs - Modification time of the file in milliseconds.
 * @property {number} size - Size of the file in bytes.
 */

/**
 * @typedef {Object} DiskCacheEntry
 * @property {string} rootFile - Absolute path of the root LS-DYNA file.
 * @property {string} payloadFileName - Name of the payload file on disk.
 * @property {number} byteSize - Size of the payload file on disk.
 * @property {number} lastAccessedAt - Timestamp (ms) when the entry was last accessed.
 */

/**
 * @typedef {Object} TrackedFileEntry
 * @property {string} filePath - Absolute path to the tracked file.
 * @property {FileSignature} signature - File modification signature.
 */

/**
 * @typedef {Object} DiskStoreOptions
 * @property {string} cacheDirectory - Absolute path to the directory where snapshots are stored.
 * @property {function(string): Promise<FileSignature>} [getFileSignature] - Optional custom file signature reader.
 * @property {function(): number} [now] - Optional timestamp provider.
 * @property {number} [maxCacheBytes] - Optional maximum size of the cache before eviction occurs.
 * @property {number} [schemaVersion] - Optional schema version to enforce.
 */

/**
 * Resolves a root file path, performing validation checks.
 * 
 * @param {string} rootFile - Root file path.
 * @returns {string} Absolute path.
 * @throws {TypeError} If the path is not a valid string.
 */
function resolveRootFile(rootFile) {
    if (typeof rootFile !== 'string' || rootFile.trim() === '') {
        throw new TypeError('disk snapshot cache entries require a rootFile path');
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
 * Compares two file signatures to detect modification.
 * 
 * @param {FileSignature|null|undefined} left - Left signature.
 * @param {FileSignature|null|undefined} right - Right signature.
 * @returns {boolean} True if signatures match exactly.
 */
function areFileSignaturesEqual(left, right) {
    return left
        && right
        && left.mtimeMs === right.mtimeMs
        && left.size === right.size;
}

/**
 * Default file signature reader using node fs.promises.stat.
 * 
 * @param {string} filePath - Absolute path to the target file.
 * @returns {Promise<FileSignature>} File signature.
 */
async function readFileSignature(filePath) {
    const stat = await fs.promises.stat(filePath);
    return {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
    };
}

/**
 * Clones a cache entry.
 * 
 * @param {DiskCacheEntry|null|undefined} entry - Entry to clone.
 * @returns {DiskCacheEntry|null} Cloned entry, or null.
 */
function cloneEntry(entry) {
    if (!entry) return null;
    return {
        rootFile: entry.rootFile,
        payloadFileName: entry.payloadFileName,
        byteSize: entry.byteSize,
        lastAccessedAt: entry.lastAccessedAt,
    };
}

/**
 * Computes a unique payload filename based on the rootCacheKey hash.
 * 
 * @param {string} rootCacheKey - Normalized root file path key.
 * @returns {string} Output payload filename.
 */
function getPayloadFileName(rootCacheKey) {
    return `${crypto.createHash('sha1').update(rootCacheKey).digest('hex')}.json`;
}

/**
 * Normalizes tracked file structures.
 * 
 * @param {TrackedFileEntry[]} [trackedFiles=[]] - Raw list.
 * @returns {TrackedFileEntry[]} Normalized list.
 */
function normalizeTrackedFiles(trackedFiles = []) {
    return trackedFiles.map(trackedFile => ({
        filePath: resolveRootFile(trackedFile.filePath),
        signature: {
            mtimeMs: trackedFile.signature.mtimeMs,
            size: trackedFile.signature.size,
        },
    }));
}

/**
 * Factory function to create a Disk Snapshot Store.
 * 
 * @param {DiskStoreOptions} options - Configuration options.
 * @returns {{
 *   persist: function({snapshot: Object, trackedFiles: TrackedFileEntry[]}): Promise<void>,
 *   restore: function(string): Promise<{snapshot: Object, trackedFiles: TrackedFileEntry[]}|null>,
 *   getStats: function(): {entryCount: number, totalBytes: number},
 *   listEntries: function(): DiskCacheEntry[]
 * }} The disk snapshot store API instance.
 */
function createDiskSnapshotStore({
    cacheDirectory,
    getFileSignature = readFileSignature,
    now = Date.now,
    maxCacheBytes = Number.POSITIVE_INFINITY,
    schemaVersion = SNAPSHOT_SCHEMA_VERSION,
} = {}) {
    if (typeof cacheDirectory !== 'string' || cacheDirectory.trim() === '') {
        throw new TypeError('createDiskSnapshotStore requires a cacheDirectory path');
    }
    if (typeof getFileSignature !== 'function') {
        throw new TypeError('createDiskSnapshotStore requires getFileSignature to be a function');
    }
    if (typeof now !== 'function') {
        throw new TypeError('createDiskSnapshotStore requires now to be a function');
    }
    if (typeof maxCacheBytes !== 'number' || Number.isNaN(maxCacheBytes) || maxCacheBytes <= 0) {
        throw new TypeError('createDiskSnapshotStore requires maxCacheBytes to be a positive number');
    }

    const resolvedCacheDirectory = path.resolve(cacheDirectory);
    const indexFilePath = path.join(resolvedCacheDirectory, INDEX_FILE_NAME);
    const payloadDirectoryPath = path.join(resolvedCacheDirectory, PAYLOAD_DIRECTORY_NAME);
    
    /** @type {{entries: Map<string, DiskCacheEntry>}|null} */
    let state = null;
    /** @type {Promise<{entries: Map<string, DiskCacheEntry>}>|null} */
    let statePromise = null;
    /** @type {Promise<any>} */
    let mutationChain = Promise.resolve();

    /**
     * Ensures that storage directory and its subdirectories exist.
     * @returns {Promise<void>}
     */
    async function ensureDirectories() {
        await fs.promises.mkdir(payloadDirectoryPath, { recursive: true });
    }

    /**
     * Writes content to a file atomically via temp-file renaming.
     * 
     * @param {string} targetPath - Path to write.
     * @param {string} content - Data to write.
     * @returns {Promise<void>}
     */
    async function writeFileAtomically(targetPath, content) {
        const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await fs.promises.writeFile(tempPath, content, 'utf8');
        await fs.promises.rename(tempPath, targetPath);
    }

    /**
     * Removes a file if it exists, eating ENOENT.
     * 
     * @param {string} filePath - Path to remove.
     * @returns {Promise<void>}
     */
    async function removeFileIfExists(filePath) {
        try {
            await fs.promises.rm(filePath, { force: true });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }

    /**
     * Computes totals for cache state.
     * 
     * @param {{entries: Map<string, DiskCacheEntry>}} currentState - Current in-memory index state.
     * @returns {{entryCount: number, totalBytes: number}} Stats.
     */
    function getStateStats(currentState) {
        let totalBytes = 0;
        for (const entry of currentState.entries.values()) {
            totalBytes += entry.byteSize;
        }

        return {
            entryCount: currentState.entries.size,
            totalBytes,
        };
    }

    /**
     * Serializes and writes the catalog index back to disk.
     * 
     * @param {{entries: Map<string, DiskCacheEntry>}} currentState - State.
     * @returns {Promise<void>}
     */
    async function writeIndex(currentState) {
        await ensureDirectories();
        const serializedIndex = JSON.stringify({
            schemaVersion,
            entries: [...currentState.entries.values()]
                .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)
                .map(entry => cloneEntry(entry)),
        });
        await writeFileAtomically(indexFilePath, serializedIndex);
    }

    /**
     * Clears all snapshot cache files and rebuilds structures.
     * 
     * @returns {Promise<{entries: Map<string, DiskCacheEntry>}>} Cleared state.
     */
    async function resetStorage() {
        await fs.promises.rm(payloadDirectoryPath, { recursive: true, force: true });
        await removeFileIfExists(indexFilePath);
        await ensureDirectories();
        state = { entries: new Map() };
        return state;
    }

    /**
     * Reads index catalog from disk, bootstrapping state.
     * 
     * @returns {Promise<{entries: Map<string, DiskCacheEntry>}>} Current index state.
     */
    async function loadState() {
        if (state) return state;
        if (statePromise) return statePromise;

        statePromise = (async () => {
            await ensureDirectories();
            try {
                const rawIndex = await fs.promises.readFile(indexFilePath, 'utf8');
                const parsedIndex = JSON.parse(rawIndex);
                if (!parsedIndex || parsedIndex.schemaVersion !== schemaVersion || !Array.isArray(parsedIndex.entries)) {
                    return resetStorage();
                }

                state = {
                    entries: new Map(parsedIndex.entries
                        .filter(entry => entry && typeof entry.rootFile === 'string' && typeof entry.payloadFileName === 'string')
                        .map(entry => {
                            const rootFile = resolveRootFile(entry.rootFile);
                            return [
                                getRootCacheKey(rootFile),
                                {
                                    rootFile,
                                    payloadFileName: entry.payloadFileName,
                                    byteSize: entry.byteSize,
                                    lastAccessedAt: entry.lastAccessedAt,
                                },
                            ];
                        })),
                };
                return state;
            } catch (error) {
                if (error.code === 'ENOENT') {
                    state = { entries: new Map() };
                    return state;
                }
                return resetStorage();
            } finally {
                statePromise = null;
            }
        })();

        return statePromise;
    }

    /**
     * Deletes a cache entry from index and payload files on disk.
     * 
     * @param {{entries: Map<string, DiskCacheEntry>}} currentState - Current state.
     * @param {DiskCacheEntry} entry - The entry to remove.
     * @returns {Promise<void>}
     */
    async function removeEntry(currentState, entry) {
        currentState.entries.delete(getRootCacheKey(entry.rootFile));
        await removeFileIfExists(path.join(payloadDirectoryPath, entry.payloadFileName));
        await writeIndex(currentState);
    }

    /**
     * Validates modification timestamps and size signatures of tracked files.
     * 
     * @param {TrackedFileEntry[]} trackedFiles - List of tracked files to check.
     * @returns {Promise<boolean>} True if all files are unmodified.
     */
    async function validateTrackedFiles(trackedFiles) {
        if (!trackedFiles || trackedFiles.length === 0) return true;

        // Fast path: validate the root file (first entry) first.
        // If it has changed, short-circuit immediately without checking all other files.
        try {
            const rootSignature = await getFileSignature(trackedFiles[0].filePath);
            if (!areFileSignaturesEqual(rootSignature, trackedFiles[0].signature)) {
                return false;
            }
        } catch (_error) {
            return false;
        }

        // Validate remaining files in parallel chunks
        const CHUNK_SIZE = 50;
        for (let i = 1; i < trackedFiles.length; i += CHUNK_SIZE) {
            const chunk = trackedFiles.slice(i, i + CHUNK_SIZE);
            const results = await Promise.all(chunk.map(async trackedFile => {
                try {
                    const currentSignature = await getFileSignature(trackedFile.filePath);
                    return areFileSignaturesEqual(currentSignature, trackedFile.signature);
                } catch (_error) {
                    return false;
                }
            }));
            if (results.includes(false)) {
                return false;
            }
        }
        return true;
    }

    /**
     * Performs eviction of least recently used entries if maxCacheBytes limit is breached.
     * 
     * @param {{entries: Map<string, DiskCacheEntry>}} currentState - State.
     * @param {string} protectedRootCacheKey - The rootCacheKey to protect from eviction during this pass.
     * @returns {Promise<void>}
     */
    async function evictEntriesIfNeeded(currentState, protectedRootCacheKey) {
        while (getStateStats(currentState).totalBytes > maxCacheBytes) {
            const evictionCandidates = [...currentState.entries.entries()]
                .filter(([rootCacheKey]) => rootCacheKey !== protectedRootCacheKey)
                .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt);
            if (evictionCandidates.length === 0) {
                const protectedEntry = currentState.entries.get(protectedRootCacheKey);
                if (!protectedEntry) break;
                await removeEntry(currentState, protectedEntry);
                break;
            }
            await removeEntry(currentState, evictionCandidates[0][1]);
        }
    }

    /**
     * Runs an asynchronous operation inside a promise serialization chain.
     * 
     * @template T
     * @param {function(): Promise<T>} operation - Operation to queue.
     * @returns {Promise<T>} Output promise.
     */
    function runExclusive(operation) {
        const promise = mutationChain.then(operation, operation);
        mutationChain = promise.then(() => undefined, () => undefined);
        return promise;
    }

    return {
        /**
         * Serializes and writes a snapshot to disk, scheduling evictions as needed.
         * 
         * @param {Object} params - Arguments.
         * @param {Object} params.snapshot - The project snapshot object.
         * @param {TrackedFileEntry[]} params.trackedFiles - Array of tracked dependency files.
         * @returns {Promise<void>}
         */
        async persist({ snapshot, trackedFiles }) {
            return runExclusive(async () => {
                if (!snapshot || typeof snapshot !== 'object') {
                    throw new TypeError('disk snapshot persistence requires a snapshot object');
                }
                const currentState = await loadState();
                const rootFile = resolveRootFile(snapshot.rootFile);
                const rootCacheKey = getRootCacheKey(rootFile);
                const normalizedTrackedFiles = normalizeTrackedFiles(trackedFiles);
                const payloadFileName = getPayloadFileName(rootCacheKey);
                const payload = {
                    schemaVersion,
                    rootFile,
                    trackedFiles: normalizedTrackedFiles,
                    snapshot: serializeProjectSnapshot(snapshot),
                };
                const payloadContent = JSON.stringify(payload);

                await ensureDirectories();
                await writeFileAtomically(
                    path.join(payloadDirectoryPath, payloadFileName),
                    payloadContent
                );

                currentState.entries.set(rootCacheKey, {
                    rootFile,
                    payloadFileName,
                    byteSize: Buffer.byteLength(payloadContent, 'utf8'),
                    lastAccessedAt: now(),
                });
                await evictEntriesIfNeeded(currentState, rootCacheKey);
                await writeIndex(currentState);
            });
        },

        /**
         * Restores a serialized snapshot from disk, invalidating it if dependency signatures mismatch.
         * 
         * @param {string} rootFile - Path to the project's root file.
         * @returns {Promise<{snapshot: Object, trackedFiles: TrackedFileEntry[]}|null>} Resolved snapshot payload, or null if missing or invalid.
         */
        async restore(rootFile) {
            return runExclusive(async () => {
                const currentState = await loadState();
                const rootCacheKey = getRootCacheKey(rootFile);
                const entry = currentState.entries.get(rootCacheKey);
                if (!entry) return null;

                try {
                    const rawPayload = await fs.promises.readFile(path.join(payloadDirectoryPath, entry.payloadFileName), 'utf8');
                    const payload = JSON.parse(rawPayload);
                    if (!payload || payload.schemaVersion !== schemaVersion || !Array.isArray(payload.trackedFiles)) {
                        await removeEntry(currentState, entry);
                        return null;
                    }
                    if (!await validateTrackedFiles(payload.trackedFiles)) {
                        await removeEntry(currentState, entry);
                        return null;
                    }

                    entry.lastAccessedAt = now();
                    await writeIndex(currentState);
                    return {
                        snapshot: hydrateProjectSnapshot(payload.snapshot),
                        trackedFiles: payload.trackedFiles,
                    };
                } catch (_error) {
                    await removeEntry(currentState, entry);
                    return null;
                }
            });
        },

        /**
         * Returns stats about the cache size and count.
         * 
         * @returns {{entryCount: number, totalBytes: number}} Active cache metadata metrics.
         */
        getStats() {
            return getStateStats(state || { entries: new Map() });
        },

        /**
         * Returns all catalog entries sorted by last accessed time descending (MRU to LRU).
         * 
         * @returns {DiskCacheEntry[]} Array of cache entries.
         */
        listEntries() {
            return [...(state ? state.entries.values() : [])]
                .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)
                .map(entry => cloneEntry(entry));
        },
    };
}

module.exports = {
    createDiskSnapshotStore,
    SNAPSHOT_SCHEMA_VERSION,
};
