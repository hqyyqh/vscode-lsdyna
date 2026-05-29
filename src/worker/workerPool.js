'use strict';

/**
 * @fileoverview Worker thread process host and message dispatcher.
 * @module worker/workerPool
 * 
 * This module defines a WorkerPool instance that wraps a Node.js Worker thread.
 * It manages request/response matching via unique correlation IDs (requestId), rejects pending promises 
 * if the worker encounters an unhandled exception or terminates unexpectedly, and manages clean thread shutdown.
 * 
 * Role in System: Executes heavy operations in a concurrent system thread to prevent blocking
 * the main language server event loop.
 */

const { Worker } = require('worker_threads');

const { hydrateProjectSnapshot } = require('../core/cache/snapshotSerializer');

/**
 * @typedef {Object} WorkerPoolOptions
 * @property {string} workerPath - Absolute file path to the worker entry script.
 * @property {function(string): Worker} [workerFactory] - Optional factory function to instantiate a worker.
 */

/**
 * Factory function to create a Worker Pool managing background indexing tasks.
 * 
 * @param {WorkerPoolOptions} options - Configuration options.
 * @returns {{
 *   buildProjectIndex: function(string, Object=): Promise<import('../core/project/projectIndexer').ProjectIndexResult>,
 *   dispose: function(): Promise<void>,
 *   isDisposed: function(): boolean
 * }} The worker pool control interface.
 */
function createWorkerPool({
    workerPath,
    workerFactory = (nextWorkerPath) => new Worker(nextWorkerPath),
} = {}) {
    if (typeof workerPath !== 'string' || workerPath.trim() === '') {
        throw new TypeError('createWorkerPool requires a workerPath');
    }
    if (typeof workerFactory !== 'function') {
        throw new TypeError('createWorkerPool requires a workerFactory function');
    }

    /** @type {Worker} */
    const worker = workerFactory(workerPath);
    /** @type {Map<number, {resolve: function(any): void, reject: function(Error): void, onProgress?: function(Object): void}>} */
    const pendingRequests = new Map();
    let nextRequestId = 1;
    let disposed = false;

    /**
     * Rejects all outstanding promises in the queue with a given error.
     * 
     * @param {Error} error - Error to reject with.
     */
    function rejectPendingRequests(error) {
        for (const pendingRequest of pendingRequests.values()) {
            pendingRequest.reject(error);
        }
        pendingRequests.clear();
    }

    // Listens for completed parsing jobs from the worker thread.
    worker.on('message', (message) => {
        const pendingRequest = pendingRequests.get(message.requestId);
        if (!pendingRequest) return;

        if (message.type === 'progress') {
            if (typeof pendingRequest.onProgress === 'function') {
                pendingRequest.onProgress({
                    scannedFileCount: message.scannedFileCount,
                    currentFile: message.currentFile,
                });
            }
            return;
        }

        pendingRequests.delete(message.requestId);

        if (message.type === 'error') {
            const error = new Error(message.error.message);
            error.name = message.error.name;
            error.stack = message.error.stack;
            pendingRequest.reject(error);
            return;
        }

        pendingRequest.resolve(hydrateProjectSnapshot(message.snapshot));
    });

    // Handle unexpected worker process crashes.
    worker.on('error', (error) => {
        disposed = true;
        rejectPendingRequests(error);
    });

    // Handle worker thread exits.
    worker.on('exit', (code) => {
        if (disposed && pendingRequests.size === 0) return;

        disposed = true;
        rejectPendingRequests(new Error(`scan worker exited with code ${code}`));
    });

    return {
        /**
         * Asynchronously enqueues a project indexing request and sends it to the worker thread.
         * 
         * @param {string} rootFile - Absolute path to the project's root input file.
         * @param {Object} [options={}] - Optional parameters.
         * @param {function({scannedFileCount: number, currentFile: string}): void} [options.onProgress] - Progress callback.
         * @returns {Promise<import('../core/project/projectIndexer').ProjectIndexResult>} Resolved project index.
         */
        buildProjectIndex(rootFile, options = {}) {
            if (disposed) {
                return Promise.reject(new Error('scan worker pool has been disposed'));
            }

            const requestId = nextRequestId++;
            return new Promise((resolve, reject) => {
                pendingRequests.set(requestId, { reject, resolve, onProgress: options.onProgress });
                worker.postMessage({
                    requestId,
                    rootFile,
                    type: 'buildProjectIndex',
                });
            });
        },

        /**
         * Terminate the worker thread and reject all remaining pending requests.
         * 
         * @returns {Promise<void>}
         */
        async dispose() {
            if (disposed) return;
            disposed = true;
            rejectPendingRequests(new Error('scan worker pool has been disposed'));
            await worker.terminate();
        },

        /**
         * Queries whether this worker pool is active or disposed.
         * 
         * @returns {boolean} True if the pool has been disposed.
         */
        isDisposed() {
            return disposed;
        },
    };
}

module.exports = {
    createWorkerPool,
};
