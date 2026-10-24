'use strict';

/**
 * @fileoverview Node.js Worker Thread entry point for background project indexing.
 * @module worker/scanWorker
 * 
 * This script runs inside an isolated Node.js worker thread. It listens for incoming messages
 * from the parent thread, runs `buildProjectIndex` recursively, serializes the resulting 
 * snapshot, and posts it back to the parent port.
 * 
 * Supports optional persistent per-file scan cache for cross-session acceleration.
 * 
 * Role in System: Executes processor-intensive parsing logic asynchronously away from the main server loop.
 */

const { parentPort, workerData } = require('worker_threads');

const { serializeProjectSnapshot } = require('../core/cache/snapshotSerializer');
const { SqliteFileScanCache } = require('../core/cache/sqliteFileScanCache');
const { createProjectIndexer } = require('../core/project/projectIndexer');
const { entityFileSignature } = require('../core/cache/entityFileRevision');
const { EntityQueryWorker } = require('./entityQueryWorker');
const { ProjectSessions } = require('./projectSessions');
const { LiveFileSource } = require('./liveFileSource');
const { assertIndexPayload, INDEX_PROTOCOL_VERSION } = require('../shared/indexPages');
const sourceReads = new Map();
let sourceSequence = 0;
const liveSource = new LiveFileSource(request => new Promise((resolve, reject) => {
    const sourceRequestId = ++sourceSequence;
    const timer = setTimeout(() => {
        sourceReads.delete(sourceRequestId); reject(new Error('Document range read timed out'));
    }, 120000);
    sourceReads.set(sourceRequestId, { resolve, reject, timer });
    parentPort.postMessage({ type: 'documentSource', sourceRequestId, request: assertIndexPayload(request) });
}));

/**
 * Converts a standard Error object into a plain serializable JSON object.
 * 
 * @param {Error} error - The caught error instance.
 * @returns {{message: string, stack: string, name: string}} Serializable error payload.
 */
function serializeError(error) {
    return {
        message: String(error?.message || error).slice(0, 16384),
        stack: String(error?.stack || '').slice(0, 65536),
        name: String(error?.name || 'Error').slice(0, 128),
    };
}

// One owner and capacity budget for physical-file facts and entity records.
const persistentFileScanCache = new SqliteFileScanCache(() => entityQueries.indexStore(),
    Math.floor((workerData?.entityMemoryBytes ?? 256 * 1024 * 1024) / 8));

// Create indexer with persistent cache support
const indexer = createProjectIndexer({
    concurrency: 4,
    persistentFileScanCache,
    maxFileScanCacheBytes: workerData?.fileScanMemoryCacheBytes,
    getFileSignature: liveSource.signature,
    loadFileStructure: liveSource.structure,
});
const { buildProjectIndex } = indexer;
const entityQueries = new EntityQueryWorker((rootFile, options, onProgress, cancellationToken) =>
    buildProjectIndex(rootFile, { ...options, cancellationToken }, onProgress),
    workerData?.entityStorageDirectory || workerData?.fileScanCacheDirectory,
    workerData?.entityMemoryBytes, workerData?.entityDiskBytes, undefined, workerData?.fileScanCacheOptions?.maxEntryAgeMs,
    (root, options, token) => projectSessions.loadStructure(root, options, token), liveSource);
const requestCancellationTokens = new Map();
const projectSessions = new ProjectSessions(buildProjectIndex,
    Math.floor((workerData?.entityMemoryBytes ?? 256 * 1024 * 1024) / 4), liveSource.unchanged, () => entityQueries.indexStore());

// Bind message listener on parent port to process requests.
parentPort.on('message', async (message) => {
    if (!message) return;
    if (message.type === 'documentSourceResult') {
        const pending = sourceReads.get(message.sourceRequestId);
        if (!pending) return;
        sourceReads.delete(message.sourceRequestId); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else {
            try { pending.resolve(assertIndexPayload(message.result)); }
            catch (error) { pending.reject(error); }
        }
        return;
    }
    if (message.type === 'cancelRequest') {
        const token = requestCancellationTokens.get(message.requestId);
        if (token) token.isCancellationRequested = true;
        return;
    }
    if (!['buildProjectIndex', 'queryEntity', 'controlEntityIndex', 'projectSession'].includes(message.type)) return;

    const cancellationToken = { isCancellationRequested: false };
    requestCancellationTokens.set(message.requestId, cancellationToken);
    let heartbeat;

    try {
        if (message.type === 'projectSession') {
            assertIndexPayload(message.options);
            if (message.options?.protocolVersion !== INDEX_PROTOCOL_VERSION)
                throw new Error('Project protocol mismatch; reload window');
            if (message.options.action === 'shutdown') {
                for (const token of requestCancellationTokens.values()) token.isCancellationRequested = true;
                await projectSessions.clear(); await indexer.drainFileScans(); await entityQueries.dispose();
                parentPort.postMessage({ requestId: message.requestId, type: 'result', result: { closed: true } });
                return;
            }
            if (message.options.action === 'invalidate') entityQueries.invalidateProgressive(message.options.rootFile);
            const result = assertIndexPayload(await (message.options.action === 'source-analysis'
                ? entityQueries.sourceAnalysis(message.options, cancellationToken)
                : String(message.options.action).startsWith('query-')
                ? entityQueries.projectQuery(message.options, cancellationToken)
                : projectSessions.request(message.options, cancellationToken)));
            parentPort.postMessage({ requestId: message.requestId, type: 'result', result });
            return;
        }
        if (message.type === 'controlEntityIndex') {
            if (message.options.action === 'clear') { await projectSessions.clear(); await indexer.drainFileScans(); }
            heartbeat = setInterval(() => parentPort.postMessage({ requestId: message.requestId,
                type: 'progress', event: { type: 'entity-query-progress' } }), 1000);
            const result = await entityQueries.control(message.options.action);
            parentPort.postMessage({ requestId: message.requestId, type: 'result', result });
            return;
        }
        if (message.type === 'queryEntity') {
            const progress = (event = {}) => parentPort.postMessage({ requestId: message.requestId,
                type: 'progress', event: { ...event, type: 'entity-query-progress', rootFile: message.rootFile } });
            heartbeat = setInterval(progress, 1000);
            const result = await entityQueries.query(message.options, cancellationToken, progress);
            parentPort.postMessage({ requestId: message.requestId, type: 'result', result });
            return;
        }
        const snapshot = await buildProjectIndex(message.rootFile, {
            ...(message.options || {}),
            cancellationToken,
        }, (partialSnapshot) => {
            parentPort.postMessage({
                requestId: message.requestId,
                event: partialSnapshot.type === 'structureReady'
                    ? { ...partialSnapshot, snapshot: serializeProjectSnapshot(partialSnapshot.snapshot) }
                    : partialSnapshot.type === 'progress' ? partialSnapshot : undefined,
                ...(partialSnapshot.type ? {} : { snapshot: serializeProjectSnapshot(partialSnapshot) }),
                type: 'progress',
            });
        });
        parentPort.postMessage({
            requestId: message.requestId,
            snapshot: serializeProjectSnapshot(snapshot),
            type: 'result',
            
        });
    } catch (error) {
        parentPort.postMessage({
            error: serializeError(error),
            requestId: message.requestId,
            type: 'error',
        });
    } finally {
        clearInterval(heartbeat);
        requestCancellationTokens.delete(message.requestId);
    }
});

export {};
