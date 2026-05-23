'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { hydrateProjectSnapshot, serializeProjectSnapshot } = require('./snapshotSerializer');

const INDEX_FILE_NAME = 'index.json';
const PAYLOAD_DIRECTORY_NAME = 'payloads';
const SNAPSHOT_SCHEMA_VERSION = 1;

function resolveRootFile(rootFile) {
    if (typeof rootFile !== 'string' || rootFile.trim() === '') {
        throw new TypeError('disk snapshot cache entries require a rootFile path');
    }
    return path.resolve(rootFile);
}

function getRootCacheKey(rootFile) {
    const resolvedRootFile = resolveRootFile(rootFile);
    return process.platform === 'win32'
        ? resolvedRootFile.toLowerCase()
        : resolvedRootFile;
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

function cloneEntry(entry) {
    if (!entry) return null;
    return {
        rootFile: entry.rootFile,
        payloadFileName: entry.payloadFileName,
        byteSize: entry.byteSize,
        lastAccessedAt: entry.lastAccessedAt,
    };
}

function getPayloadFileName(rootCacheKey) {
    return `${crypto.createHash('sha1').update(rootCacheKey).digest('hex')}.json`;
}

function normalizeTrackedFiles(trackedFiles = []) {
    return trackedFiles.map(trackedFile => ({
        filePath: resolveRootFile(trackedFile.filePath),
        signature: {
            mtimeMs: trackedFile.signature.mtimeMs,
            size: trackedFile.signature.size,
        },
    }));
}

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
    let state = null;
    let statePromise = null;
    let mutationChain = Promise.resolve();

    async function ensureDirectories() {
        await fs.promises.mkdir(payloadDirectoryPath, { recursive: true });
    }

    async function writeFileAtomically(targetPath, content) {
        const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await fs.promises.writeFile(tempPath, content, 'utf8');
        await fs.promises.rename(tempPath, targetPath);
    }

    async function removeFileIfExists(filePath) {
        try {
            await fs.promises.rm(filePath, { force: true });
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }

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

    async function resetStorage() {
        await fs.promises.rm(payloadDirectoryPath, { recursive: true, force: true });
        await removeFileIfExists(indexFilePath);
        await ensureDirectories();
        state = { entries: new Map() };
        return state;
    }

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

    async function removeEntry(currentState, entry) {
        currentState.entries.delete(getRootCacheKey(entry.rootFile));
        await removeFileIfExists(path.join(payloadDirectoryPath, entry.payloadFileName));
        await writeIndex(currentState);
    }

    async function validateTrackedFiles(trackedFiles) {
        for (const trackedFile of trackedFiles) {
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

    function runExclusive(operation) {
        const promise = mutationChain.then(operation, operation);
        mutationChain = promise.then(() => undefined, () => undefined);
        return promise;
    }

    return {
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
        getStats() {
            return getStateStats(state || { entries: new Map() });
        },
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
