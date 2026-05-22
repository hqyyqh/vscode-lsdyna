'use strict';

const fs = require('fs');
const path = require('path');

function resolveRootFile(rootFile) {
    if (typeof rootFile !== 'string' || rootFile.trim() === '') {
        throw new TypeError('loadProjectSnapshot requires a rootFile path');
    }
    return path.resolve(rootFile);
}

function getRootCacheKey(rootFile) {
    const resolvedRootFile = resolveRootFile(rootFile);
    return process.platform === 'win32'
        ? resolvedRootFile.toLowerCase()
        : resolvedRootFile;
}

function getTrackedSnapshotFiles(snapshot) {
    if (Array.isArray(snapshot.files) && snapshot.files.length > 0) {
        return snapshot.files;
    }
    return [snapshot.rootFile];
}

function areFileSignaturesEqual(left, right) {
    return left
        && right
        && left.mtimeMs === right.mtimeMs
        && left.size === right.size;
}

async function readFileSignature(filePath) {
    const stat = await fs.promises.stat(filePath);
    return {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
    };
}

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

function createIndexClient({ buildProjectIndex, getFileSignature = readFileSignature } = {}) {
    if (typeof buildProjectIndex !== 'function') {
        throw new TypeError('createIndexClient requires a buildProjectIndex function');
    }
    if (typeof getFileSignature !== 'function') {
        throw new TypeError('createIndexClient requires getFileSignature to be a function');
    }

    const snapshots = new Map();
    const generations = new Map();

    function getGeneration(rootCacheKey) {
        return generations.get(rootCacheKey) || 0;
    }

    async function loadProjectSnapshot(rootFile) {
        const resolvedRootFile = resolveRootFile(rootFile);
        const rootCacheKey = getRootCacheKey(rootFile);

        while (snapshots.has(rootCacheKey)) {
            const cachedEntry = snapshots.get(rootCacheKey);
            if (cachedEntry.promise) return cachedEntry.promise;

            const valid = await isSnapshotValid(cachedEntry, getFileSignature);
            const currentEntry = snapshots.get(rootCacheKey);
            if (currentEntry !== cachedEntry) continue;
            if (valid) return cachedEntry.snapshot;

            invalidate(resolvedRootFile);
        }

        const generation = getGeneration(rootCacheKey);
        const promise = Promise.resolve(buildProjectIndex(resolvedRootFile))
            .then(async snapshot => {
                let trackedFiles = null;
                try {
                    trackedFiles = await captureTrackedFiles(snapshot, getFileSignature);
                } catch (_error) {
                    trackedFiles = null;
                }

                const currentEntry = snapshots.get(rootCacheKey);
                if (getGeneration(rootCacheKey) === generation && currentEntry && currentEntry.promise === promise) {
                    if (trackedFiles) {
                        snapshots.set(rootCacheKey, { snapshot, trackedFiles });
                    } else {
                        snapshots.delete(rootCacheKey);
                    }
                }
                return snapshot;
            })
            .catch(error => {
                const currentEntry = snapshots.get(rootCacheKey);
                if (currentEntry && currentEntry.promise === promise) {
                    snapshots.delete(rootCacheKey);
                }
                throw error;
            });

        snapshots.set(rootCacheKey, { promise });
        return promise;
    }

    function invalidate(rootFile) {
        const rootCacheKey = getRootCacheKey(rootFile);
        generations.set(rootCacheKey, getGeneration(rootCacheKey) + 1);
        snapshots.delete(rootCacheKey);
    }

    return {
        invalidate,
        loadProjectSnapshot,
    };
}

module.exports = {
    createIndexClient,
};
