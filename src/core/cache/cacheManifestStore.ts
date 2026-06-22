'use strict';

/**
 * @fileoverview In-memory storage and management of cache metadata entries.
 * @module core/cache/cacheManifestStore
 * 
 * This module manages metadata (manifests) representing project snapshots stored on disk.
 * It tracks root file paths, associated dependencies, document sizes, and access times,
 * providing sorting (LRU support) and memory footprint stats.
 * 
 * Role in System: Provides a metadata catalog of snapshot caches, helping the disk snapshot store
 * decide which files to evict when size thresholds are exceeded.
 */

const path = require('path');

/**
 * @typedef {Object} ManifestEntry
 * @property {string} rootFile - Absolute path of the project's root input file.
 * @property {string[]} trackedFiles - List of all dependency files included by the root file.
 * @property {string[]} missingDependencyPaths - Candidate paths for unresolved includes.
 * @property {number} trackedFileCount - Number of files tracked by this project entry.
 * @property {number} byteSize - Size in bytes of the snapshot file on disk.
 * @property {number} lastAccessedAt - Timestamp (milliseconds) of the last access time.
 */

/**
 * @typedef {Object} ManifestStoreStats
 * @property {number} entryCount - The total number of manifest entries.
 * @property {number} totalBytes - The sum of byte sizes of all manifest entries.
 */

/**
 * Resolves a root file path to an absolute path, validation checks included.
 * 
 * @param {string} rootFile - Path to the root file.
 * @returns {string} Absolute path.
 * @throws {TypeError} If the path is not a valid string.
 */
function resolveManifestRootFile(rootFile) {
    if (typeof rootFile !== 'string' || rootFile.trim() === '') {
        throw new TypeError('cache manifest entries require a rootFile path');
    }
    return path.resolve(rootFile);
}

/**
 * Generates a normalized lookup key for a root file path. Handles Windows casing differences.
 * 
 * @param {string} rootFile - Path to the root file.
 * @returns {string} The normalized lookup key.
 */
function getManifestRootKey(rootFile) {
    const resolvedRootFile = resolveManifestRootFile(rootFile);
    return process.platform === 'win32'
        ? resolvedRootFile.toLowerCase()
        : resolvedRootFile;
}

/**
 * Resolves and deduplicates file paths under a project tree.
 * 
 * @param {string[]} [trackedFiles=[]] - List of file paths to normalize.
 * @returns {string[]} Normalized and deduplicated absolute file paths.
 */
function normalizeTrackedFiles(trackedFiles = []) {
    const normalizedFiles = [];
    const seen = new Set();

    for (const filePath of trackedFiles) {
        const resolvedFilePath = resolveManifestRootFile(filePath);
        const fileKey = getManifestRootKey(resolvedFilePath);
        if (seen.has(fileKey)) continue;
        seen.add(fileKey);
        normalizedFiles.push(resolvedFilePath);
    }

    return normalizedFiles;
}

/**
 * Creates a deep clone of a manifest entry to prevent external mutations.
 * 
 * @param {ManifestEntry|null|undefined} entry - The entry to clone.
 * @returns {ManifestEntry|null} Cloned manifest entry, or null if input was falsy.
 */
function cloneManifestEntry(entry) {
    if (!entry) return null;
    return {
        rootFile: entry.rootFile,
        trackedFiles: [...entry.trackedFiles],
        trackedFileCount: entry.trackedFileCount,
        missingDependencyPaths: [...(entry.missingDependencyPaths || [])],
        byteSize: entry.byteSize,
        lastAccessedAt: entry.lastAccessedAt,
    };
}

/**
 * Factory function to create a Cache Manifest Store instance.
 * 
 * @returns {{
 *   get: function(string): (ManifestEntry|null),
 *   getStats: function(): ManifestStoreStats,
 *   list: function(): ManifestEntry[],
 *   remove: function(string): boolean,
 *   upsert: function({rootFile: string, trackedFiles: string[], byteSize: number, lastAccessedAt: number}): ManifestEntry
 * }} A manifest store instance.
 */
function createCacheManifestStore() {
    /** @type {Map<string, ManifestEntry>} */
    const entries = new Map();

    /**
     * Inserts or updates a manifest entry in the store.
     * 
     * @param {Object} params - Entry details.
     * @param {string} params.rootFile - Root file path.
     * @param {string[]} params.trackedFiles - Tracked dependency files.
     * @param {number} params.byteSize - Snapshot file size in bytes.
     * @param {number} params.lastAccessedAt - Timestamp of last access.
     * @returns {ManifestEntry} The created or updated entry clone.
     */
    function upsert({ rootFile, trackedFiles, missingDependencyPaths = [], byteSize, lastAccessedAt }) {
        if (typeof byteSize !== 'number' || Number.isNaN(byteSize) || byteSize < 0) {
            throw new TypeError('cache manifest entries require a non-negative byteSize');
        }
        if (typeof lastAccessedAt !== 'number' || Number.isNaN(lastAccessedAt) || lastAccessedAt < 0) {
            throw new TypeError('cache manifest entries require a non-negative lastAccessedAt');
        }

        const resolvedRootFile = resolveManifestRootFile(rootFile);
        const normalizedTrackedFiles = normalizeTrackedFiles(trackedFiles && trackedFiles.length > 0
            ? trackedFiles
            : [resolvedRootFile]);
        const normalizedMissingDependencyPaths = normalizeTrackedFiles(missingDependencyPaths);
        const entry = {
            rootFile: resolvedRootFile,
            trackedFiles: normalizedTrackedFiles,
            trackedFileCount: normalizedTrackedFiles.length,
            missingDependencyPaths: normalizedMissingDependencyPaths,
            byteSize,
            lastAccessedAt,
        };

        entries.set(getManifestRootKey(resolvedRootFile), entry);
        return cloneManifestEntry(entry);
    }

    /**
     * Retrieves a manifest entry by root file path.
     * 
     * @param {string} rootFile - Root file path.
     * @returns {ManifestEntry|null} Cloned manifest entry, or null if not found.
     */
    function get(rootFile) {
        return cloneManifestEntry(entries.get(getManifestRootKey(rootFile)));
    }

    /**
     * Deletes a manifest entry by root file path.
     * 
     * @param {string} rootFile - Root file path.
     * @returns {boolean} True if deleted, false if did not exist.
     */
    function remove(rootFile) {
        return entries.delete(getManifestRootKey(rootFile));
    }

    /**
     * Lists all manifest entries sorted by last accessed time descending (MRU to LRU).
     * 
     * @returns {ManifestEntry[]} Sorted manifest entries.
     */
    function list() {
        return [...entries.values()]
            .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)
            .map(cloneManifestEntry);
    }

    /**
     * Computes totals for entries count and bytes size.
     * 
     * @returns {ManifestStoreStats} Stats object.
     */
    function getStats() {
        let entryCount = 0;
        let totalBytes = 0;

        for (const entry of entries.values()) {
            entryCount += 1;
            totalBytes += entry.byteSize;
        }

        return {
            entryCount,
            totalBytes,
        };
    }

    return {
        get,
        getStats,
        list,
        remove,
        upsert,
    };
}

module.exports = {
    createCacheManifestStore,
};

export {};
