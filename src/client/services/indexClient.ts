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
const { hydrateProjectSnapshot, receiveSnapshotChunk, restoreSnapshotChunks } = require('../../core/cache/snapshotSerializer');
const {
    createCancellationError,
    throwIfCancellationRequested,
} = require('../../core/scanner/scannerContracts');
const protocol = require('../../shared/protocol');
const { LSPErrorCodes } = require('vscode-languageserver-protocol');

const DEFAULT_MAX_SNAPSHOT_BYTES = 48 * 1024 * 1024;

type IndexClientOptions = {
    buildProjectIndex?: (rootFile: string, options?: object, onProgress?: ((snapshot: any) => void) | null, cancellationToken?: any) => Promise<any>;
    getFileSignature?: (filePath: string) => Promise<any>;
    estimateSnapshotSize?: (snapshot: any) => number;
    maxSnapshotBytes?: number;
    cacheSingleFileSnapshots?: boolean;
    excludeMeshEntities?: boolean;
    manifestStore?: any;
    persistentCache?: any;
    languageClient?: any;
};

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

function waitForPromiseWithCancellation(promise, cancellationToken) {
    if (cancellationToken?.isCancellationRequested) {
        // The shared operation may still reject after this already-cancelled waiter leaves.
        void Promise.resolve(promise).catch(() => undefined);
        throwIfCancellationRequested(cancellationToken);
    }
    if (!cancellationToken || typeof cancellationToken.onCancellationRequested !== 'function') {
        return promise;
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let registration = null;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            registration?.dispose?.();
            callback(value);
        };
        registration = cancellationToken.onCancellationRequested(() => {
            finish(reject, createCancellationError());
        });
        Promise.resolve(promise).then(
            value => finish(resolve, value),
            error => finish(reject, error),
        );
        if (settled) registration?.dispose?.();
    });
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
        && left.size === right.size
        && left.sourceRevision === right.sourceRevision;
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
async function captureTrackedFiles(snapshot, getFileSignature, cancellationToken = null) {
    const trackedFiles = [];
    const seen = new Set();

    for (const filePath of getTrackedSnapshotFiles(snapshot)) {
        throwIfCancellationRequested(cancellationToken);
        const resolvedFilePath = resolveRootFile(filePath);
        const fileCacheKey = getRootCacheKey(resolvedFilePath);
        if (seen.has(fileCacheKey)) continue;
        seen.add(fileCacheKey);
        const signature = await getFileSignature(resolvedFilePath);
        throwIfCancellationRequested(cancellationToken);
        const scanned = snapshot.fileIndexes?.get?.(resolvedFilePath);
        if (scanned && Number.isFinite(scanned.size) && Number.isFinite(scanned.mtimeMs) &&
            !areFileSignaturesEqual(scanned, signature)) {
            const error = new Error('File changed before snapshot publication: ' + resolvedFilePath);
            error.name = 'ScanChangedError';
            throw error;
        }
        trackedFiles.push({
            filePath: resolvedFilePath,
            signature,
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

    for (let offset = 0; offset < entry.trackedFiles.length; offset += 8) {
        const valid = await Promise.all(entry.trackedFiles.slice(offset, offset + 8).map(async trackedFile => {
            try { return areFileSignaturesEqual(await getFileSignature(trackedFile.filePath), trackedFile.signature); }
            catch { return false; }
        }));
        if (valid.includes(false)) return false;
    }

    return true;
}

/**
 * Estimates serialized memory size of a snapshot object.
 * 
 * @param {Object} snapshot - Snapshot object.
 * @returns {number} Byte count.
 */
function estimateSnapshotSize(snapshot, budget = DEFAULT_MAX_SNAPSHOT_BYTES) {
    return require('../../core/cache/memorySize').estimateMemorySize(snapshot, budget);
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
 *   getCacheStats: function(): Promise<{cachedSnapshotCount: number, totalSnapshotBytes: number}>,
 *   clearCaches: function(): Promise<Object>
 * }} Client API.
 */
function createIndexClient({
    buildProjectIndex,
    getFileSignature = readFileSignature,
    maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
    estimateSnapshotSize: getSnapshotSize = snapshot => estimateSnapshotSize(snapshot, maxSnapshotBytes),
    cacheSingleFileSnapshots = false,
    excludeMeshEntities = false,
    manifestStore = createCacheManifestStore(),
    persistentCache = null,
    languageClient = null,
}: IndexClientOptions = {}) {
    if (languageClient) {
        if (typeof languageClient.sendRequest !== 'function' || typeof languageClient.sendNotification !== 'function') {
            throw new TypeError('createIndexClient requires a languageClient supporting sendRequest and sendNotification');
        }
        let requestSequence = 0;
        let lastSnapshot = null;
        let documentSource = async (_request: any) => ({ state: 'disk' });
        languageClient.onRequest?.(protocol.DOCUMENT_SOURCE_REQUEST, async request => {
            const { assertIndexPayload } = require('../../shared/indexPages');
            return assertIndexPayload(await documentSource(assertIndexPayload(request)));
        });
        const requests = new Map();
        
        // The locked LanguageClient queues handlers registered before start.
        if (typeof languageClient.onNotification === 'function') {
            try {
                languageClient.onNotification(protocol.SCAN_PROGRESS_NOTIFICATION, (params) => {
                    const request = requests.get(params?.requestId);
                    if (request && !request.cancellationToken?.isCancellationRequested && params.event &&
                        typeof params.event.rootFile === 'string' &&
                        getRootCacheKey(params.event.rootFile) === request.rootKey) {
                        const event = params.event;
                        request.onProgress?.(event.type === 'structureReady'
                            ? { ...event, snapshot: hydrateProjectSnapshot(event.snapshot) } : event);
                        return;
                    }
                    if (!request || request.cancellationToken?.isCancellationRequested ||
                        typeof params.snapshot?.rootFile !== 'string' ||
                        getRootCacheKey(params.snapshot?.rootFile) !== request.rootKey) return;
                    request.onProgress?.(hydrateProjectSnapshot(params.snapshot));
                });
                languageClient.onNotification(protocol.SNAPSHOT_REFERENCES_NOTIFICATION, (params) => {
                    const request = requests.get(params?.requestId);
                    if (!request || request.cancellationToken?.isCancellationRequested || request.error) return;
                    try {
                        receiveSnapshotChunk(request.chunks, params);
                        if (params.field !== 'keywordBlocks') {
                            const records = request.chunks.get(JSON.stringify([params.filePath, params.field]));
                            for (let i = params.offset; i < records.length; i++) request.intern(records[i]);
                        }
                    } catch (error) { request.error = error; }

                });
            } catch (error) {
                console.error('[lsdyna] Failed to bind progress notification:', error);
            }
        }
        return {
            setDocumentSource(reader) { documentSource = reader; },
            async sourceAnalysis(request, cancellationToken = null) {
                return this.projectSession({ ...request, action: 'source-analysis' }, cancellationToken);
            },
            async affectedProjectRoots(filePath) {
                return (await this.projectSession({ action: 'affected', rootFile: resolveRootFile(filePath) })).roots;
            },
            async queryEntityProgressive(query, onProgress = null, cancellationToken = null, isCurrent = () => true) {
                return require('./progressiveEntityClient').followEntityQuery(
                    (request, token) => this.projectSession(request, token), query, onProgress, cancellationToken, isCurrent);
            },
            async loadProjectStructure(rootFile, options = {}, onProgress = null, cancellationToken = null) {
                const { followProjectStructure } = require('./projectSessionClient');
                return followProjectStructure((request, token) => this.projectSession(request, token),
                    resolveRootFile(rootFile), options, onProgress, cancellationToken);
            },
            async projectSession(request, cancellationToken = null) {
                const { INDEX_PROTOCOL_VERSION, assertIndexPayload } = require('../../shared/indexPages');
                throwIfCancellationRequested(cancellationToken);
                return assertIndexPayload(await languageClient.sendRequest(protocol.PROJECT_SESSION_REQUEST,
                    assertIndexPayload({ ...request, protocolVersion: INDEX_PROTOCOL_VERSION }), cancellationToken || undefined));
            },
            async queryEntity(request, cancellationToken = null) {
                throwIfCancellationRequested(cancellationToken);
                try {
                    return await languageClient.sendRequest(protocol.QUERY_ENTITY_REQUEST,
                        { ...request, rootFile: resolveRootFile(request.rootFile) }, cancellationToken || undefined);
                } catch (error) {
                    if (error?.code === LSPErrorCodes.RequestCancelled) throw createCancellationError();
                    throw error;
                }
            },
            async loadProjectSnapshot(rootFile, options = {}, onProgress = null, cancellationToken = null) {
                if (excludeMeshEntities) options = { ...options, excludeMeshEntities: true };
                throwIfCancellationRequested(cancellationToken);
                const resolvedRootFile = resolveRootFile(rootFile);
                const previous = lastSnapshot;
                const requestId = String(++requestSequence);
                const request = { onProgress, cancellationToken, rootKey: getRootCacheKey(resolvedRootFile),
                    chunks: new Map(), error: null,
                    intern: require('../../core/references/referenceMetadata').createReferenceMetadataInterner() };
                requests.set(requestId, request);
                try {
                    const serialized = await languageClient.sendRequest(
                        protocol.LOAD_PROJECT_SNAPSHOT_REQUEST,
                        { rootFile: resolvedRootFile, options, requestId,
                            ...(previous?.rootFile === resolvedRootFile ? { reuseSnapshotId: previous.id } : {}) },
                        cancellationToken || undefined,
                    );
                    throwIfCancellationRequested(cancellationToken);
                    if (typeof serialized?.rootFile !== 'string' ||
                        getRootCacheKey(serialized.rootFile) !== request.rootKey) {
                        throw new Error('Project snapshot root does not match its request');
                    }
                    if (request.error) throw request.error;
                    if (serialized.snapshotUnchanged) {
                        if (!previous || previous.id !== serialized.snapshotId) throw new Error('Unknown reused project snapshot');
                        return previous.snapshot;
                    }
                    restoreSnapshotChunks(serialized, request.chunks);
                    const snapshot = hydrateProjectSnapshot(serialized);
                    if (serialized.snapshotId) lastSnapshot = { rootFile: resolvedRootFile, id: serialized.snapshotId, snapshot };
                    return snapshot;
                } catch (error) {
                    if (error?.code === LSPErrorCodes.RequestCancelled) {
                        throw createCancellationError();
                    }
                    throw error;
                } finally {
                    requests.delete(requestId);
                }
            },
            async invalidate(rootFile) {
                const resolvedRootFile = resolveRootFile(rootFile);
                await languageClient.sendNotification(
                    protocol.INVALIDATE_NOTIFICATION,
                    { rootFile: resolvedRootFile }
                );
            },
            async getManifestEntries() {
                return await languageClient.sendRequest(protocol.GET_MANIFEST_ENTRIES_REQUEST);
            },
            async getCacheStats() {
                return await languageClient.sendRequest(protocol.GET_CACHE_STATS_REQUEST);
            },
            async clearCaches() {
                return await languageClient.sendRequest(protocol.CLEAR_CACHES_REQUEST);
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
    let cacheEpoch = 0;

    function getGeneration(rootCacheKey) {
        return generations.get(rootCacheKey) || 0;
    }

    function touchSnapshotEntry(entry) {
        entry.lastAccessedAt = ++accessSequence;
        if (entry.snapshot.scope === 'single-file') return;
        const missingDependencyPaths = [];
        const seenMissingPaths = new Set();
        for (const record of entry.snapshot.missingFiles || []) {
            for (const candidatePath of record.candidatePaths || []) {
                const resolvedPath = path.resolve(candidatePath);
                const candidateKey = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
                if (seenMissingPaths.has(candidateKey)) continue;
                seenMissingPaths.add(candidateKey);
                missingDependencyPaths.push(resolvedPath);
            }
        }
        manifestStore.upsert({
            rootFile: entry.snapshot.rootFile,
            trackedFiles: entry.trackedFiles.map(trackedFile => trackedFile.filePath),
            missingDependencyPaths,
            byteSize: entry.byteSize,
            lastAccessedAt: entry.lastAccessedAt,
        });
    }

    function evictSnapshotsIfNeeded(protectedRootCacheKey) {
        const protectedEntry = snapshots.get(protectedRootCacheKey);
        if (protectedEntry?.byteSize > maxSnapshotBytes) {
            snapshots.delete(protectedRootCacheKey);
            return;
        }
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

            if (evictionCandidates.length === 0) {
                const protectedEntry = snapshots.get(protectedRootCacheKey);
                if (!protectedEntry?.snapshot) break;
                manifestStore.remove(protectedEntry.snapshot.rootFile);
                snapshots.delete(protectedRootCacheKey);
                break;
            }
            manifestStore.remove(evictionCandidates[0][1].snapshot.rootFile);
            snapshots.delete(evictionCandidates[0][0]);
            cacheStats = getSnapshotCacheStats(snapshots);
        }
    }

    async function loadProjectSnapshot(rootFile, options: any = {}, onProgress = null, cancellationToken = null) {
        if (excludeMeshEntities) options = { ...options, excludeMeshEntities: true };
        throwIfCancellationRequested(cancellationToken);
        const resolvedRootFile = resolveRootFile(rootFile);

        // Only the entity worker retains single-file snapshots. Scope remains part of the
        // cache identity; these entries never enter project manifests or disk snapshots.
        if (options?.singleFileOnly === true && !cacheSingleFileSnapshots) {
            return buildProjectIndex(
                resolvedRootFile,
                { ...options, singleFileOnly: true },
                onProgress,
                cancellationToken,
            );
        }
        const rootCacheKey = getRootCacheKey(rootFile);
        const optionsKey = JSON.stringify(Object.keys(options)
            .filter(key => options[key] !== undefined &&
                !(options[key] === false && ['fullScanLargeFiles', 'singleFileOnly'].includes(key)))
            .sort().map(key => [key, options[key]]));

        while (snapshots.has(rootCacheKey)) {
            const cachedEntry = snapshots.get(rootCacheKey);
            if (cachedEntry.optionsKey !== optionsKey) { invalidate(resolvedRootFile); continue; }
            if (cachedEntry.promise) {
                cachedEntry.subscribers.add({ onProgress, cancellationToken });
                if (cachedEntry.structureEvent) onProgress?.(cachedEntry.structureEvent);
                return waitForPromiseWithCancellation(cachedEntry.promise, cancellationToken);
            }

            const valid = await isSnapshotValid(cachedEntry, getFileSignature);
            throwIfCancellationRequested(cancellationToken);
            const currentEntry = snapshots.get(rootCacheKey);
            if (currentEntry !== cachedEntry) continue;
            if (valid) {
                touchSnapshotEntry(cachedEntry);
                return cachedEntry.snapshot;
            }

            invalidate(resolvedRootFile);
        }

        const generation = getGeneration(rootCacheKey);
        const loadEpoch = cacheEpoch;
        const callerToken = cancellationToken;
        const subscribers = new Set([{ onProgress, cancellationToken: callerToken }]);
        const sharedToken = {
            get isCancellationRequested() {
                return cacheEpoch !== loadEpoch || getGeneration(rootCacheKey) !== generation ||
                    [...subscribers].every(subscriber => subscriber.cancellationToken?.isCancellationRequested);
            },
            onCancellationRequested(listener) {
                const timer = setInterval(() => {
                    if (sharedToken.isCancellationRequested) { clearInterval(timer); listener(); }
                }, 25);
                timer.unref?.();
                return { dispose: () => clearInterval(timer) };
            },
        };
        cancellationToken = sharedToken;
        const publish = (event) => {
            if (sharedToken.isCancellationRequested) return;
            const entry = snapshots.get(rootCacheKey);
            if (entry?.subscribers === subscribers) {
                if (event?.type === 'structureReady') entry.structureEvent = event;
                if (event?.phase === 'restarting') entry.structureEvent = null;
            }
            for (const subscriber of subscribers) {
                if (!subscriber.cancellationToken?.isCancellationRequested) subscriber.onProgress?.(event);
            }
        };
        const promise = (async () => {
            if (persistentCache && !options.singleFileOnly) {
                try {
                    const restored = await persistentCache.restore(resolvedRootFile);
                    throwIfCancellationRequested(cancellationToken);
                    if (restored && (restored.snapshot.scanOptionsKey || '[]') === optionsKey) {
                        const currentEntry = snapshots.get(rootCacheKey);
                        if (cacheEpoch === loadEpoch && getGeneration(rootCacheKey) === generation
                            && currentEntry && currentEntry.promise === promise) {
                            const entry = {
                                snapshot: restored.snapshot,
                                optionsKey,
                                trackedFiles: restored.trackedFiles,
                                byteSize: getSnapshotSize(restored.snapshot),
                            };
                            touchSnapshotEntry(entry);
                            snapshots.set(rootCacheKey, entry);
                            evictSnapshotsIfNeeded(rootCacheKey);
                        }
                        return restored.snapshot;
                    }
                } catch (error) {
                    if (error?.name === 'CancellationError') throw error;
                    throwIfCancellationRequested(cancellationToken);
                    // Best-effort L2 restore: fall back to building the index if recovery fails.
                }
            }

            const snapshot = await buildProjectIndex(
                resolvedRootFile,
                options,
                publish,
                cancellationToken,
            );
            snapshot.scanOptionsKey = optionsKey;
            throwIfCancellationRequested(cancellationToken);
            let trackedFiles = null;
            try {
                trackedFiles = await captureTrackedFiles(snapshot, getFileSignature, cancellationToken);
            } catch (error) {
                if (error?.name === 'CancellationError' || error?.name === 'ScanChangedError') throw error;
                throwIfCancellationRequested(cancellationToken);
                trackedFiles = null;
            }

            const currentEntry = snapshots.get(rootCacheKey);
            if (cacheEpoch === loadEpoch && getGeneration(rootCacheKey) === generation
                && currentEntry && currentEntry.promise === promise) {
                if (trackedFiles) {
                    const entry = {
                        snapshot,
                        optionsKey,
                        trackedFiles,
                        byteSize: getSnapshotSize(snapshot),
                    };
                    touchSnapshotEntry(entry);
                    snapshots.set(rootCacheKey, entry);
                    evictSnapshotsIfNeeded(rootCacheKey);
                    if (persistentCache && !options.singleFileOnly) {
                        const persistenceEpoch = cacheEpoch;
                        Promise.resolve()
                            .then(() => {
                                if (cacheEpoch !== persistenceEpoch) return undefined;
                                return persistentCache.persist({ snapshot, trackedFiles });
                            })
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

        snapshots.set(rootCacheKey, { promise, optionsKey, subscribers, structureEvent: null });
        return waitForPromiseWithCancellation(promise, callerToken);
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

    async function clearCaches() {
        cacheEpoch += 1;
        const memory = getSnapshotCacheStats(snapshots);
        snapshots.clear();
        generations.clear();
        if (typeof manifestStore.clear === 'function') {
            manifestStore.clear();
        } else {
            for (const entry of manifestStore.list()) manifestStore.remove(entry.rootFile);
        }

        let projectSnapshotDisk = { entryCount: 0, totalBytes: 0 };
        if (persistentCache && typeof persistentCache.clear === 'function') {
            projectSnapshotDisk = await persistentCache.clear();
        }
        return { memory, projectSnapshotDisk };
    }

    return {
        clearCaches,
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
    DEFAULT_MAX_SNAPSHOT_BYTES,
};

export {};
