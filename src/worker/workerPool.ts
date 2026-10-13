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
const { createCancellationError } = require('../core/scanner/scannerContracts');

const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

type WorkerLike = {
    on(eventName: string, handler: (...args: any[]) => void): void;
    postMessage(message: any): void;
    terminate(): Promise<any>;
};
type IndexWorkerData = {
    fileScanCacheDirectory?: string | null; fileScanCacheOptions?: object; fileScanMemoryCacheBytes?: number;
    entityStorageDirectory?: string; entityMemoryBytes?: number; entityDiskBytes?: number;
};

type WorkerPoolOptions = {
    readDocumentSource?: (request: any) => Promise<any>;
    workerPath?: string;
    workerFactory?: (nextWorkerPath: string, workerOpts: { workerData?: IndexWorkerData }) => WorkerLike;
    fileScanCacheDirectory?: string | null;
    fileScanCacheOptions?: object;
    fileScanMemoryCacheBytes?: number;
    requestTimeoutMs?: number;
    entityStorageDirectory?: string;
    entityMemoryBytes?: number;
    entityDiskBytes?: number;
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
    fileScanCacheOptions = {},
    fileScanMemoryCacheBytes = 16 * 1024 * 1024,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    entityStorageDirectory,
    entityMemoryBytes,
    entityDiskBytes,
    readDocumentSource,
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
    const workerOpts: { workerData?: IndexWorkerData } = {
        workerData: {
            fileScanCacheDirectory,
            fileScanCacheOptions,
            fileScanMemoryCacheBytes,
            ...(entityStorageDirectory === undefined ? {} : { entityStorageDirectory }),
            ...(entityMemoryBytes === undefined ? {} : { entityMemoryBytes }),
            ...(entityDiskBytes === undefined ? {} : { entityDiskBytes }),
        },
    };
    const worker = workerFactory(workerPath, workerOpts);
    /** @type {Map<number, {resolve: function(any): void, reject: function(Error): void, onProgress: function(any): void, timeout: NodeJS.Timeout|null, cancellationRegistration?: {dispose?: function(): void}|null}>} */
    const pendingRequests = new Map();
    let nextRequestId = 1;
    let disposed = false;
    let terminationPromise = null;

    function clearRequestTimeout(pendingRequest) {
        if (!pendingRequest?.timeout) return;
        clearTimeout(pendingRequest.timeout);
        pendingRequest.timeout = null;
    }

    function disposeCancellationRegistration(pendingRequest) {
        const registration = pendingRequest?.cancellationRegistration;
        pendingRequest.cancellationRegistration = null;
        registration?.dispose?.();
    }

    function takePendingRequest(requestId) {
        const pendingRequest = pendingRequests.get(requestId);
        if (!pendingRequest) return null;
        pendingRequests.delete(requestId);
        clearRequestTimeout(pendingRequest);
        disposeCancellationRegistration(pendingRequest);
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
            disposeCancellationRegistration(pendingRequest);
            pendingRequest.reject(error);
        }
        pendingRequests.clear();
    }

    function terminateWorker() {
        if (terminationPromise) return terminationPromise;
        terminationPromise = Promise.resolve().then(() => worker.terminate());
        return terminationPromise;
    }

    function failWorker(error, terminate = false) {
        disposed = true;
        rejectPendingRequests(error);
        if (terminate) {
            // Observe automatic shutdown failure; dispose still receives the stored rejection.
            void terminateWorker().catch(() => undefined);
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
        if (message.type === 'documentSource') {
            const { assertIndexPayload } = require('../shared/indexPages');
            Promise.resolve().then(() => readDocumentSource
                ? readDocumentSource(assertIndexPayload(message.request)) : { state: 'disk' })
                .then(result => {
                    if (!disposed) worker.postMessage({ type: 'documentSourceResult', sourceRequestId: message.sourceRequestId,
                        result: assertIndexPayload(result) });
                }).catch(error => {
                    if (!disposed) worker.postMessage({ type: 'documentSourceResult', sourceRequestId: message.sourceRequestId,
                        error: { message: String(error.message).slice(0, 4096) } });
                });
            return;
        }
        const pendingRequest = pendingRequests.get(message.requestId);
        if (!pendingRequest) return;

        if (message.type === 'progress') {
            try {
                if (pendingRequest.onProgress) {
                    const event = message.event;
                    pendingRequest.onProgress(event?.type === 'structureReady'
                        ? { ...event, snapshot: hydrateProjectSnapshot(event.snapshot) }
                        : ['progress', 'entity-query-progress'].includes(event?.type) ? event : hydrateProjectSnapshot(message.snapshot));
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
            if (completedRequest.resultType === 'projectSession') {
                completedRequest.resolve(require('../shared/indexPages').assertIndexPayload(message.result));
            } else if (completedRequest.resultType === 'queryEntity') {
                if (!['ready', 'expired', 'stale'].includes(message.result?.status) ||
                    message.result.status === 'ready' && (!Array.isArray(message.result.result?.locations) || message.result.result.locations.length > 400))
                    throw new Error('Invalid entity result page');
                completedRequest.resolve(message.result);
            } else if (completedRequest.resultType === 'controlEntityIndex') {
                if (!message.result || !Number.isSafeInteger(message.result.memoryBudget)) throw new Error('Invalid entity index statistics');
                completedRequest.resolve(message.result);
            } else completedRequest.resolve(hydrateProjectSnapshot(message.snapshot));
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

    function requestWorker(type, rootFile, options = {}, onProgress = null, cancellationToken = null) {
            if (disposed) {
                return Promise.reject(new Error('scan worker pool has been disposed'));
            }
            if (cancellationToken?.isCancellationRequested === true) {
                return Promise.reject(createCancellationError());
            }

            const requestId = nextRequestId++;
            return new Promise((resolve, reject) => {
                const pendingRequest = {
                    reject,
                    resolve,
                    onProgress,
                    timeout: null,
                    cancellationRegistration: null,
                    resultType: type,
                };
                pendingRequests.set(requestId, pendingRequest);
                armRequestTimeout(requestId, pendingRequest);
                try {
                    worker.postMessage({
                        requestId,
                        rootFile,
                        options,
                        type,
                    });
                    if (typeof cancellationToken?.onCancellationRequested === 'function') {
                        const registration = cancellationToken.onCancellationRequested(() => {
                            if (pendingRequests.get(requestId) !== pendingRequest) return;
                            try {
                                worker.postMessage({ requestId, type: 'cancelRequest' });
                            } catch {
                                // The local promise is still rejected below; worker failure is handled separately.
                            }
                            const cancelledRequest = takePendingRequest(requestId);
                            cancelledRequest?.reject(createCancellationError());
                        });
                        if (pendingRequests.get(requestId) === pendingRequest) {
                            pendingRequest.cancellationRegistration = registration;
                        } else {
                            registration?.dispose?.();
                        }
                    }
                } catch (error) {
                    const failedRequest = takePendingRequest(requestId);
                    failedRequest?.reject(error);
                }
            });
    }

    return {
        projectSession: (request, cancellationToken = null) =>
            requestWorker('projectSession', request.rootFile, request, null, cancellationToken),
        buildProjectIndex: (rootFile, options = {}, onProgress = null, cancellationToken = null) =>
            requestWorker('buildProjectIndex', rootFile, options, onProgress, cancellationToken),
        queryEntity: (request, onProgress = null, cancellationToken = null) =>
            requestWorker('queryEntity', request.rootFile, request, onProgress, cancellationToken),
        controlEntityIndex: action => requestWorker('controlEntityIndex', undefined, { action }),

        /**
         * Terminate the worker thread and reject all remaining pending requests.
         * 
         * @returns {Promise<void>}
         */
        async dispose() {
            if (!disposed && worker instanceof Worker) {
                let timer;
                try {
                    await Promise.race([
                        requestWorker('projectSession', undefined, { protocolVersion: require('../shared/indexPages').INDEX_PROTOCOL_VERSION,
                            action: 'shutdown' }),
                        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Worker shutdown timed out')), 10000); }),
                    ]);
                } catch (_) { /* An unresponsive worker is terminated below. */ }
                finally { clearTimeout(timer); }
            }
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
