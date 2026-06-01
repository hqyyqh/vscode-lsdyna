'use strict';

/**
 * @fileoverview Persistent per-file scan result cache for cross-session reuse.
 * @module core/cache/fileScanCacheStore
 * 
 * This module provides a disk-backed cache mapping individual file paths to their parsed
 * scan results (include entries, search paths, keywords). Each entry is validated against
 * a file signature (mtime + size) so stale entries are automatically rejected.
 * 
 * Optimized for the primary use case: ~100 files of 100-500MB each, where re-scanning 
 * is extremely expensive and should be avoided across VS Code sessions.
 * 
 * Role in System: L1.5 persistent cache sitting between the in-memory L1 cache (lives only 
 * during indexer instance lifetime) and the L2 full-snapshot disk cache.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * @typedef {Object} FileSignature
 * @property {number} mtimeMs - Modification time of the file in milliseconds.
 * @property {number} size - Size of the file in bytes.
 */

/**
 * @typedef {Object} FileScanEntry
 * @property {string} filePath - Absolute path to the scanned file.
 * @property {FileSignature} signature - File modification signature at scan time.
 * @property {Object} scanResult - The cached scan result containing keywords, includeEntries, searchPaths.
 */

/**
 * @typedef {Object} FileScanCacheIndex
 * @property {number} schemaVersion - Schema version for forward compatibility.
 * @property {Object<string, {payloadFile: string, signature: FileSignature}>} entries - Index mapping file keys to payload references.
 */

const INDEX_FILE_NAME = 'file-scan-index.json';
const PAYLOAD_DIR_NAME = 'file-scans';
const SCHEMA_VERSION = 1;

/**
 * Generates a normalized cache key for a file path. Handles Windows casing.
 * 
 * @param {string} filePath - Input file path.
 * @returns {string} Normalized lookup key.
 */
function getFileCacheKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Generates a unique payload filename based on the file path hash.
 * 
 * @param {string} cacheKey - Normalized file cache key.
 * @returns {string} Payload filename.
 */
function getPayloadFileName(cacheKey) {
    return crypto.createHash('sha1').update(cacheKey).digest('hex') + '.json';
}

/**
 * Compares two file signatures.
 * 
 * @param {FileSignature|null|undefined} left - Left signature.
 * @param {FileSignature|null|undefined} right - Right signature.
 * @returns {boolean} True if signatures match.
 */
function areSignaturesEqual(left, right) {
    return left && right && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

/**
 * Factory function to create a persistent file scan cache store.
 * 
 * @param {Object} options - Configuration.
 * @param {string} options.cacheDirectory - Absolute path to cache storage directory.
 * @param {number} [options.schemaVersion] - Schema version override.
 * @returns {{
 *   get: function(string, FileSignature): Promise<Object|null>,
 *   set: function(string, FileSignature, Object): Promise<void>,
 *   invalidate: function(string): Promise<void>,
 *   invalidateAll: function(): Promise<void>,
 *   getStats: function(): {entryCount: number}
 * }}
 */
function createFileScanCacheStore({
    cacheDirectory,
    schemaVersion = SCHEMA_VERSION,
} = {}) {
    if (typeof cacheDirectory !== 'string' || cacheDirectory.trim() === '') {
        throw new TypeError('createFileScanCacheStore requires a cacheDirectory path');
    }

    const resolvedCacheDir = path.resolve(cacheDirectory);
    const indexFilePath = path.join(resolvedCacheDir, INDEX_FILE_NAME);
    const payloadDirPath = path.join(resolvedCacheDir, PAYLOAD_DIR_NAME);

    /** @type {Map<string, {payloadFile: string, signature: FileSignature}>|null} */
    let indexCache = null;
    let indexLoaded = false;
    /** @type {Promise<void>|null} */
    let writeChain = Promise.resolve();

    /**
     * Ensures cache directories exist.
     */
    async function ensureDirectories() {
        await fs.promises.mkdir(payloadDirPath, { recursive: true });
    }

    /**
     * Loads the index from disk into memory.
     * 
     * @returns {Promise<Map<string, {payloadFile: string, signature: FileSignature}>>}
     */
    async function loadIndex() {
        if (indexCache && indexLoaded) return indexCache;

        await ensureDirectories();
        try {
            const raw = await fs.promises.readFile(indexFilePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.schemaVersion !== schemaVersion || !parsed.entries) {
                indexCache = new Map();
            } else {
                indexCache = new Map(Object.entries(parsed.entries));
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                // Corrupted index, start fresh
                try { await fs.promises.rm(indexFilePath, { force: true }); } catch (_e) { /* ignore */ }
            }
            indexCache = new Map();
        }
        indexLoaded = true;
        return indexCache;
    }

    /**
     * Persists the current index to disk.
     */
    async function saveIndex() {
        if (!indexCache) return;
        await ensureDirectories();
        const data = {
            schemaVersion,
            entries: Object.fromEntries(indexCache),
        };
        const tempPath = indexFilePath + '.tmp-' + process.pid + '-' + Date.now();
        await fs.promises.writeFile(tempPath, JSON.stringify(data), 'utf8');
        await fs.promises.rename(tempPath, indexFilePath);
    }

    /**
     * Serializes write operations to prevent corruption.
     * @param {function(): Promise<void>} fn
     * @returns {Promise<void>}
     */
    function enqueueWrite(fn) {
        writeChain = writeChain.then(fn, fn);
        return writeChain;
    }

    return {
        /**
         * Retrieves a cached scan result for a file, validated against its current signature.
         * 
         * @param {string} filePath - Absolute path to the file.
         * @param {FileSignature} currentSignature - Current file signature from disk.
         * @returns {Promise<Object|null>} Cached scan result, or null if miss/stale.
         */
        async get(filePath, currentSignature) {
            const index = await loadIndex();
            const cacheKey = getFileCacheKey(filePath);
            const entry = index.get(cacheKey);

            if (!entry || !areSignaturesEqual(entry.signature, currentSignature)) {
                return null;
            }

            try {
                const payloadPath = path.join(payloadDirPath, entry.payloadFile);
                const raw = await fs.promises.readFile(payloadPath, 'utf8');
                return JSON.parse(raw);
            } catch (_error) {
                // Corrupted payload, remove entry
                index.delete(cacheKey);
                return null;
            }
        },

        /**
         * Stores a scan result for a file with its current signature.
         * 
         * @param {string} filePath - Absolute path to the file.
         * @param {FileSignature} signature - File signature at scan time.
         * @param {Object} scanResult - The scan result to cache.
         * @returns {Promise<void>}
         */
        async set(filePath, signature, scanResult) {
            return enqueueWrite(async () => {
                const index = await loadIndex();
                const cacheKey = getFileCacheKey(filePath);
                const payloadFile = getPayloadFileName(cacheKey);
                const payloadPath = path.join(payloadDirPath, payloadFile);

                await ensureDirectories();
                const tempPath = payloadPath + '.tmp-' + process.pid + '-' + Date.now();
                await fs.promises.writeFile(tempPath, JSON.stringify(scanResult), 'utf8');
                await fs.promises.rename(tempPath, payloadPath);

                index.set(cacheKey, { payloadFile, signature });
                await saveIndex();
            });
        },

        /**
         * Invalidates a single file's cache entry.
         * 
         * @param {string} filePath - File to invalidate.
         * @returns {Promise<void>}
         */
        async invalidate(filePath) {
            return enqueueWrite(async () => {
                const index = await loadIndex();
                const cacheKey = getFileCacheKey(filePath);
                const entry = index.get(cacheKey);
                if (!entry) return;

                index.delete(cacheKey);
                try {
                    await fs.promises.rm(path.join(payloadDirPath, entry.payloadFile), { force: true });
                } catch (_error) { /* ignore */ }
                await saveIndex();
            });
        },

        /**
         * Invalidates all cached entries.
         * 
         * @returns {Promise<void>}
         */
        async invalidateAll() {
            return enqueueWrite(async () => {
                indexCache = new Map();
                indexLoaded = true;
                try {
                    await fs.promises.rm(payloadDirPath, { recursive: true, force: true });
                    await fs.promises.rm(indexFilePath, { force: true });
                } catch (_error) { /* ignore */ }
                await ensureDirectories();
            });
        },

        /**
         * Returns cache statistics.
         * 
         * @returns {{entryCount: number}}
         */
        getStats() {
            return { entryCount: indexCache ? indexCache.size : 0 };
        },
    };
}

module.exports = {
    createFileScanCacheStore,
};
