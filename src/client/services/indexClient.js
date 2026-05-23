'use strict';

const fs = require('fs');
const path = require('path');

const { createCacheManifestStore } = require('../../core/cache/cacheManifestStore');

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

function estimateSnapshotSize(snapshot) {
    return Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
}

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

function createIndexClient({
    buildProjectIndex,
    getFileSignature = readFileSignature,
    estimateSnapshotSize: getSnapshotSize = estimateSnapshotSize,
    maxSnapshotBytes = Number.POSITIVE_INFINITY,
    manifestStore = createCacheManifestStore(),
} = {}) {
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

    async function loadProjectSnapshot(rootFile) {
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
                        const entry = {
                            snapshot,
                            trackedFiles,
                            byteSize: getSnapshotSize(snapshot),
                        };
                        touchSnapshotEntry(entry);
                        snapshots.set(rootCacheKey, entry);
                        evictSnapshotsIfNeeded(rootCacheKey);
                    } else {
                        manifestStore.remove(resolvedRootFile);
                        snapshots.delete(rootCacheKey);
                    }
                }
                return snapshot;
            })
            .catch(error => {
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
