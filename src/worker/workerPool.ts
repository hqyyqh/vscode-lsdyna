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

const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

type WorkerLike = {
    on(eventName: string, handler: (...args: any[]) => void): void;
    postMessage(message: any): void;
    terminate(): Promise<any>;
};

type WorkerPoolOptions = {
    workerPath?: string;
    workerFactory?: (nextWorkerPath: string, workerOpts: { workerData?: { fileScanCacheDirectory: string } }) => WorkerLike;
    fileScanCacheDirectory?: string | null;
    requestTimeoutMs?: number;
};

/**
 * @typedef {Object} WorkerPoolOptions
 * @property {string} workerPath - Absolute file path to the worker entry script.
 * @property {function(string, Object): Worker} [workerFactory] - Optional factory function to instantiate a worker.
 * @property {string} [fileScanCacheDirectory] - Optional path for persistent per-file scan cache.
 * @property {number} [requestTimeoutMs=120000] - Inactivity timeout, refreshed by progress messages.
 */

/**
 * Factory function to create a Worker Pool managing background indexing tasks.
 * 
 * @param {WorkerPoolOptions} options - Configuration options.
 * @returns {{
 *   buildProjectIndex: function(string): Promise<import('../core/project/projectIndexer').ProjectIndexResult>,
 *   dispose: function(): Promise<void>,
 *   isDisposed: function(): boolean
 * }} The worker pool control interface.
 */
function createWorkerPool({
    workerPath,
    workerFactory = (nextWorkerPath, workerOpts) => new Worker(nextWorkerPath, workerOpts),
    fileScanCacheDirectory = null,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: WorkerPoolOptions = {}) {
    if (typeof workerPath !== 'string' || workerPath.trim() === '') {
        throw new TypeError('createWorkerPool requires a workerPath');
    }
    if (typeof workerFactory !== 'function') {
        throw new TypeError('createWorkerPool requires a workerFactory function');
    }
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
        throw new TypeError('createWorkerPool requires requestTimeoutMs to be a positive finite number');
    }

    /** @type {Worker} */
    const workerOpts: { workerData?: { fileScanCacheDirectory: string } } = {};
    if (fileScanCacheDirectory) {
        workerOpts.workerData = { fileScanCacheDirectory };
    }
    const worker = workerFactory(workerPath, workerOpts);
    /** @type {Map<number, {resolve: function(any): void, reject: function(Error): void, onProgress: function(any): void, timeout: NodeJS.Timeout|null}>} */
    const pendingRequests = new Map();
    let nextRequestId = 1;
    let disposed = false;
    let terminationPromise = null;

    function clearRequestTimeout(pendingRequest) {
        if (!pendingRequest?.timeout) return;
        clearTimeout(pendingRequest.timeout);
        pendingRequest.timeout = null;
    }

    function takePendingRequest(requestId) {
        const pendingRequest = pendingRequests.get(requestId);
        if (!pendingRequest) return null;
        pendingRequests.delete(requestId);
        clearRequestTimeout(pendingRequest);
        return pendingRequest;
    }

    /**
     * Rejects all outstanding promises in the queue with a given error.
     * 
     * @param {Error} error - Error to reject with.
     */
    function rejectPendingRequests(error) {
        for (const pendingRequest of pendingRequests.values()) {
            clearRequestTimeout(pendingRequest);
            pendingRequest.reject(error);
        }
        pendingRequests.clear();
    }

    function terminateWorker() {
        if (terminationPromise) return terminationPromise;
        try {
            terminationPromise = Promise.resolve(worker.terminate()).catch(() => undefined);
        } catch {
            terminationPromise = Promise.resolve();
        }
        return terminationPromise;
    }

    function failWorker(error, terminate = false) {
        disposed = true;
        rejectPendingRequests(error);
        if (terminate) {
            void terminateWorker();
        }
    }

    function armRequestTimeout(requestId, pendingRequest) {
        clearRequestTimeout(pendingRequest);
        pendingRequest.timeout = setTimeout(() => {
            if (pendingRequests.get(requestId) !== pendingRequest) return;
            failWorker(
                new Error(`scan worker request timed out after ${requestTimeoutMs} ms without progress`),
                true,
            );
        }, requestTimeoutMs);
    }

    // Listens for completed parsing jobs from the worker thread.
    worker.on('message', (message) => {
        const pendingRequest = pendingRequests.get(message.requestId);
        if (!pendingRequest) return;

        if (message.type === 'progress') {
            try {
                if (pendingRequest.onProgress) {
                    pendingRequest.onProgress(hydrateProjectSnapshot(message.snapshot));
                }
                armRequestTimeout(message.requestId, pendingRequest);
            } catch (error) {
                failWorker(
                    new Error(`invalid scan worker progress: ${error?.message || String(error)}`),
                    true,
                );
            }
            return;
        }

        if (message.type === 'error') {
            const completedRequest = takePendingRequest(message.requestId);
            const payload = message.error || {};
            const error = new Error(payload.message || 'scan worker request failed');
            if (payload.name) error.name = payload.name;
            if (payload.stack) error.stack = payload.stack;
            completedRequest.reject(error);
            return;
        }

        if (message.type !== 'result') {
            failWorker(
                new Error(`unexpected scan worker response type: ${String(message.type)}`),
                true,
            );
            return;
        }

        const completedRequest = takePendingRequest(message.requestId);
        try {
            completedRequest.resolve(hydrateProjectSnapshot(message.snapshot));
        } catch (error) {
            const invalidResultError = new Error(
                `invalid scan worker result: ${error?.message || String(error)}`,
            );
            completedRequest.reject(invalidResultError);
            failWorker(invalidResultError, true);
        }
    });

    // Handle unexpected worker process crashes.
    worker.on('error', (error) => {
        failWorker(error);
    });

    // Handle worker thread exits.
    worker.on('exit', (code) => {
        if (disposed && pendingRequests.size === 0) return;

        failWorker(new Error(`scan worker exited with code ${code}`));
    });

    return {
        /**
         * Asynchronously enqueues a project indexing request and sends it to the worker thread.
         * 
         * @param {string} rootFile - Absolute path to the project's root input file.
         * @param {Object} [options] - Optional indexing options (e.g. fullScanLargeFiles).
         * @param {function(Object): void} [onProgress] - Optional progress callback.
         * @returns {Promise<import('../core/project/projectIndexer').ProjectIndexResult>} Resolved project index.
         */
        buildProjectIndex(rootFile, options = {}, onProgress = null) {
            if (disposed) {
                return Promise.reject(new Error('scan worker pool has been disposed'));
            }

            const requestId = nextRequestId++;
            return new Promise((resolve, reject) => {
                const pendingRequest = {
                    reject,
                    resolve,
                    onProgress,
                    timeout: null,
                };
                pendingRequests.set(requestId, pendingRequest);
                armRequestTimeout(requestId, pendingRequest);
                try {
                    worker.postMessage({
                        requestId,
                        rootFile,
                        options,
                        type: 'buildProjectIndex',
                    });
                } catch (error) {
                    takePendingRequest(requestId);
                    pendingRequest.reject(error);
                }
            });
        },

        /**
         * Terminate the worker thread and reject all remaining pending requests.
         * 
         * @returns {Promise<void>}
         */
        async dispose() {
            if (!disposed) {
                disposed = true;
                rejectPendingRequests(new Error('scan worker pool has been disposed'));
            }
            await terminateWorker();
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
    DEFAULT_REQUEST_TIMEOUT_MS,
};

export {};
