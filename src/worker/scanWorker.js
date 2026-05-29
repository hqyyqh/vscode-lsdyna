'use strict';

/**
 * @fileoverview Node.js Worker Thread entry point for background project indexing.
 * @module worker/scanWorker
 * 
 * This script runs inside an isolated Node.js worker thread. It listens for incoming messages
 * from the parent thread, runs `buildProjectIndex` recursively, serializes the resulting 
 * snapshot, and posts it back to the parent port.
 * 
 * Role in System: Executes processor-intensive parsing logic asynchronously away from the main server loop.
 */

const { parentPort } = require('worker_threads');

const { serializeProjectSnapshot } = require('../core/cache/snapshotSerializer');
const { buildProjectIndex } = require('../core/project/projectIndexer');

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

/**
 * Minimum interval (ms) between progress messages to avoid flooding the parent thread.
 * @type {number}
 */
const PROGRESS_THROTTLE_MS = 300;

// Bind message listener on parent port to process requests.
parentPort.on('message', async (message) => {
    if (!message || message.type !== 'buildProjectIndex') return;

    try {
        let lastProgressTime = 0;

        const onProgress = (info) => {
            const now = Date.now();
            if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return;
            lastProgressTime = now;

            parentPort.postMessage({
                requestId: message.requestId,
                type: 'progress',
                scannedFileCount: info.scannedFileCount,
                currentFile: info.currentFile,
            });
        };

        const snapshot = await buildProjectIndex(message.rootFile, { onProgress });
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
