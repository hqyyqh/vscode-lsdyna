'use strict';

const path = require('path');

function resolveManifestRootFile(rootFile) {
    if (typeof rootFile !== 'string' || rootFile.trim() === '') {
        throw new TypeError('cache manifest entries require a rootFile path');
    }
    return path.resolve(rootFile);
}

function getManifestRootKey(rootFile) {
    const resolvedRootFile = resolveManifestRootFile(rootFile);
    return process.platform === 'win32'
        ? resolvedRootFile.toLowerCase()
        : resolvedRootFile;
}

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

function cloneManifestEntry(entry) {
    if (!entry) return null;
    return {
        rootFile: entry.rootFile,
        trackedFiles: [...entry.trackedFiles],
        trackedFileCount: entry.trackedFileCount,
        byteSize: entry.byteSize,
        lastAccessedAt: entry.lastAccessedAt,
    };
}

function createCacheManifestStore() {
    const entries = new Map();

    function upsert({ rootFile, trackedFiles, byteSize, lastAccessedAt }) {
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
        const entry = {
            rootFile: resolvedRootFile,
            trackedFiles: normalizedTrackedFiles,
            trackedFileCount: normalizedTrackedFiles.length,
            byteSize,
            lastAccessedAt,
        };

        entries.set(getManifestRootKey(resolvedRootFile), entry);
        return cloneManifestEntry(entry);
    }

    function get(rootFile) {
        return cloneManifestEntry(entries.get(getManifestRootKey(rootFile)));
    }

    function remove(rootFile) {
        return entries.delete(getManifestRootKey(rootFile));
    }

    function list() {
        return [...entries.values()]
            .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)
            .map(cloneManifestEntry);
    }

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
