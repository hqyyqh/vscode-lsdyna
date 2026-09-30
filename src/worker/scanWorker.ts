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
const { createFileScanCacheStore } = require('../core/cache/fileScanCacheStore');
const { createProjectIndexer } = require('../core/project/projectIndexer');

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

// Initialize per-file persistent cache if a cache directory is provided
let persistentFileScanCache = null;
if (workerData && workerData.fileScanCacheDirectory) {
    try {
        persistentFileScanCache = createFileScanCacheStore({
            cacheDirectory: workerData.fileScanCacheDirectory,
            ...(workerData.fileScanCacheOptions || {}),
        });
    } catch (_error) {
        // Best-effort: run without persistent cache
    }
}

// Create indexer with persistent cache support
const indexer = createProjectIndexer({
    persistentFileScanCache,
    maxFileScanCacheBytes: workerData?.fileScanMemoryCacheBytes,
});
const { buildProjectIndex } = indexer;
const requestCancellationTokens = new Map();

// Bind message listener on parent port to process requests.
parentPort.on('message', async (message) => {
    if (!message) return;
    if (message.type === 'cancelRequest') {
        const token = requestCancellationTokens.get(message.requestId);
        if (token) token.isCancellationRequested = true;
        return;
    }
    if (message.type !== 'buildProjectIndex') return;

    const cancellationToken = { isCancellationRequested: false };
    requestCancellationTokens.set(message.requestId, cancellationToken);

    try {
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
        requestCancellationTokens.delete(message.requestId);
    }
});

export {};
