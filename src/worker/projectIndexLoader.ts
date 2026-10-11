'use strict';

/**
 * @fileoverview Lazy pool manager and recoverer for background worker index compilation tasks.
 * @module worker/projectIndexLoader
 * 
 * This module instantiates the background Node.js worker pool (WorkerPool) lazily on the first request, 
 * routes indexing commands to it, and recovers (re-creates) the pool if worker processes fail.
 * 
 * Role in System: Handles coordination and lifecycle of worker threads, preventing memory leaks 
 * by keeping pool instances clean.
 */

const path = require('path');
const { createFileScanCacheStore } = require('../core/cache/fileScanCacheStore');
const { createWorkerPool } = require('./workerPool');

type ProjectIndexLoader = {
    buildProjectIndex(rootFile: string, options?: object, onProgress?: ((snapshot: object) => void) | null, cancellationToken?: any): Promise<object>;
    queryEntity?(request: any, onProgress?: ((event: any) => void) | null, cancellationToken?: any): Promise<any>;
    controlEntityIndex?(action: 'stats' | 'clear'): Promise<any>;
    dispose(): Promise<void>;
    clearPersistentCache(): Promise<{entryCount: number, totalBytes: number}>;
    isDisposed?: () => boolean;
};

type ProjectIndexLoaderOptions = {
    createPool?: (options: { workerPath: string; fileScanCacheDirectory?: string | null; fileScanCacheOptions?: object; fileScanMemoryCacheBytes?: number;
        entityStorageDirectory?: string; entityMemoryBytes?: number; entityDiskBytes?: number }) => ProjectIndexLoader;
    createFileScanCache?: (options: object) => any;
    workerPath?: string;
    fileScanCacheDirectory?: string | null;
    fileScanCacheOptions?: object;
    fileScanMemoryCacheBytes?: number;
    entityStorageDirectory?: string;
    entityMemoryBytes?: number;
    entityDiskBytes?: number;
};

/**
 * Factory function to create a Project Index Loader coordinator.
 * 
 * @param {Object} [options={}] - Custom overrides.
 * @param {function(Object): import('./workerPool').WorkerPool} [options.createPool] - Custom worker pool factory.
 * @param {string} [options.workerPath] - Absolute path to the worker entry script.
 * @param {string} [options.fileScanCacheDirectory] - Optional path for persistent per-file scan cache.
 * @returns {{
 *   buildProjectIndex: function(string): Promise<import('../core/project/projectIndexer').ProjectIndexResult>,
 *   dispose: function(): Promise<void>,
 *   isDisposed: function(): boolean
 * }} The loader API client.
 */
function createProjectIndexLoader({
    createPool = createWorkerPool,
    createFileScanCache = createFileScanCacheStore,
    workerPath = path.join(__dirname, 'scanWorker.js'),
    fileScanCacheDirectory = null,
    fileScanCacheOptions = {},
    fileScanMemoryCacheBytes = 16 * 1024 * 1024,
    entityStorageDirectory,
    entityMemoryBytes,
    entityDiskBytes,
}: ProjectIndexLoaderOptions = {}) {
    /** @type {import('./workerPool').WorkerPool|null} */
    let workerPool = null;
    let disposed = false;
    let clearPromise = null;
    let stopPromise = null;
    let disposePromise = null;

    /**
     * Checks if the worker pool has been disposed.
     * 
     * @param {import('./workerPool').WorkerPool|null} pool - Worker pool to check.
     * @returns {boolean} True if pool is disposed or null.
     */
    function isPoolDisposed(pool) {
        return !pool || (typeof pool.isDisposed === 'function' && pool.isDisposed());
    }

    function stopWorkerPool() {
        if (!stopPromise && workerPool) {
            const closingPool = workerPool;
            stopPromise = Promise.resolve().then(() => closingPool.dispose()).then(() => {
                workerPool = null;
                stopPromise = null;
            });
        }
        return stopPromise;
    }

    /**
     * Gets the active worker pool instance, initializing it lazily if it doesn't exist.
     * 
     * @returns {import('./workerPool').WorkerPool} Active worker pool.
     */
    function getWorkerPool() {
        if (disposed) {
            throw new Error('project index loader has been disposed');
        }
        if (!workerPool) {
            workerPool = createPool({
                workerPath,
                fileScanCacheDirectory,
                fileScanCacheOptions,
                fileScanMemoryCacheBytes,
                ...(entityStorageDirectory === undefined ? {} : { entityStorageDirectory }),
                ...(entityMemoryBytes === undefined ? {} : { entityMemoryBytes }),
                ...(entityDiskBytes === undefined ? {} : { entityDiskBytes }),
            });
        }
        return workerPool;
    }

    return {
        async getEntityIndexStats() {
            if (disposed) throw new Error('project index loader has been disposed');
            while (clearPromise || stopPromise || (workerPool && isPoolDisposed(workerPool))) {
                await (clearPromise || stopPromise || stopWorkerPool());
            }
            return workerPool ? workerPool.controlEntityIndex('stats') : null;
        },
        async queryEntity(request, onProgress = null, cancellationToken = null) {
            if (disposed) throw new Error('project index loader has been disposed');
            while (clearPromise || stopPromise || (workerPool && isPoolDisposed(workerPool))) {
                await (clearPromise || stopPromise || stopWorkerPool());
            }
            return getWorkerPool().queryEntity(request, onProgress, cancellationToken);
        },
        /**
         * Asynchronously delegates project indexing to the worker pool.
         * 
         * @param {string} rootFile - Absolute path to the root LS-DYNA file.
         * @param {Object} [options] - Indexing options.
         * @param {function(Object): void} [onProgress] - Optional progress callback.
         * @returns {Promise<import('../core/project/projectIndexer').ProjectIndexResult>} Scanned project snapshot.
         */
        async buildProjectIndex(rootFile, options = {}, onProgress = null, cancellationToken = null) {
            if (disposed) throw new Error('project index loader has been disposed');
            while (clearPromise || stopPromise || (workerPool && isPoolDisposed(workerPool))) {
                await (clearPromise || stopPromise || stopWorkerPool());
            }
            const pool = getWorkerPool();
            return await pool.buildProjectIndex(rootFile, options, onProgress, cancellationToken);
        },

        /**
         * Stops the current worker before deleting its persistent per-file
         * cache.  A later scan creates a fresh worker lazily.
         */
        async clearPersistentCache() {
            if (disposed) {
                throw new Error('project index loader has been disposed');
            }
            if (clearPromise) return clearPromise;

            const operation = Promise.resolve().then(async () => {
                let entityIndex;
                const ownsSqlite = entityStorageDirectory || (fileScanCacheDirectory &&
                    (createPool === createWorkerPool || typeof workerPool?.controlEntityIndex === 'function'));
                if (ownsSqlite) {
                    if (stopPromise || (workerPool && isPoolDisposed(workerPool))) await (stopPromise || stopWorkerPool());
                    const pool = getWorkerPool();
                    if (typeof pool.controlEntityIndex === 'function') entityIndex = await pool.controlEntityIndex('clear');
                }
                await stopWorkerPool();
                if (!fileScanCacheDirectory) return { entryCount: 0, totalBytes: 0, ...(entityIndex ? { entityIndex } : {}) };

                const store = createFileScanCache({
                    cacheDirectory: fileScanCacheDirectory,
                    ...fileScanCacheOptions,
                });
                return { ...await store.invalidateAll(), ...(entityIndex ? { entityIndex } : {}) };
            });
            clearPromise = operation;
            try {
                return await operation;
            } finally {
                if (clearPromise === operation) clearPromise = null;
            }
        },

        /**
         * Disposes the active worker pool and frees up system processes.
         * 
         * @returns {Promise<void>}
         */
        dispose() {
            if (!disposePromise) {
                disposed = true;
                disposePromise = Promise.resolve().then(async () => {
                    if (clearPromise) await clearPromise;
                    await stopWorkerPool();
                });
            }
            return disposePromise;
        },

        /**
         * Reports whether this loader has begun permanent shutdown.
         */
        isDisposed() {
            return disposed;
        },
    };
}

module.exports = {
    createProjectIndexLoader,
};

export {};
