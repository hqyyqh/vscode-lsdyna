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
        });
    } catch (_error) {
        // Best-effort: run without persistent cache
    }
}

// Create indexer with persistent cache support
const indexer = createProjectIndexer({
    persistentFileScanCache,
});
const { buildProjectIndex } = indexer;

// Bind message listener on parent port to process requests.
parentPort.on('message', async (message) => {
    if (!message || message.type !== 'buildProjectIndex') return;

    try {
        const snapshot = await buildProjectIndex(message.rootFile, message.options || {}, (partialSnapshot) => {
            const count = partialSnapshot.files ? partialSnapshot.files.length : 0;
            console.log(`[scanWorker] emitting progress: ${count} files`);
            parentPort.postMessage({
                requestId: message.requestId,
                snapshot: serializeProjectSnapshot(partialSnapshot),
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
    }
});

export {};
