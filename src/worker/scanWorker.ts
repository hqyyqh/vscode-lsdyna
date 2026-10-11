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

/**
 * Converts a standard Error object into a plain serializable JSON object.
 * 
 * @param {Error} error - The caught error instance.
 * @returns {{message: string, stack: string, name: string}} Serializable error payload.
 */
function serializeError(error) {
    return {
        message: error.message,
        stack: error.stack,
        name: error.name,
    };
}

// One owner and capacity budget for physical-file facts and entity records.
const persistentFileScanCache = new SqliteFileScanCache(() => entityQueries.indexStore(),
    Math.floor((workerData?.entityMemoryBytes || 256 * 1024 * 1024) / 8));

// Create indexer with persistent cache support
const indexer = createProjectIndexer({
    persistentFileScanCache,
    maxFileScanCacheBytes: workerData?.fileScanMemoryCacheBytes,
    getFileSignature: entityFileSignature,
});
const { buildProjectIndex } = indexer;
const entityQueries = new EntityQueryWorker((rootFile, options, onProgress, cancellationToken) =>
    buildProjectIndex(rootFile, { ...options, cancellationToken }, onProgress),
    workerData?.entityStorageDirectory || workerData?.fileScanCacheDirectory,
    workerData?.entityMemoryBytes, workerData?.entityDiskBytes, undefined, workerData?.fileScanCacheOptions?.maxEntryAgeMs);
const requestCancellationTokens = new Map();

// Bind message listener on parent port to process requests.
parentPort.on('message', async (message) => {
    if (!message) return;
    if (message.type === 'cancelRequest') {
        const token = requestCancellationTokens.get(message.requestId);
        if (token) token.isCancellationRequested = true;
        return;
    }
    if (!['buildProjectIndex', 'queryEntity', 'controlEntityIndex'].includes(message.type)) return;

    const cancellationToken = { isCancellationRequested: false };
    requestCancellationTokens.set(message.requestId, cancellationToken);
    let heartbeat;

    try {
        if (message.type === 'controlEntityIndex') {
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
