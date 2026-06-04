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
const { createWorkerPool } = require('./workerPool');

type ProjectIndexLoader = {
    buildProjectIndex(rootFile: string, options?: object, onProgress?: ((snapshot: object) => void) | null): Promise<object>;
    dispose(): Promise<void>;
    isDisposed?: () => boolean;
};

type ProjectIndexLoaderOptions = {
    createPool?: (options: { workerPath: string; fileScanCacheDirectory?: string | null }) => ProjectIndexLoader;
    workerPath?: string;
    fileScanCacheDirectory?: string | null;
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
 *   dispose: function(): Promise<void>
 * }} The loader API client.
 */
function createProjectIndexLoader({
    createPool = createWorkerPool,
    workerPath = path.join(__dirname, 'scanWorker.js'),
    fileScanCacheDirectory = null,
}: ProjectIndexLoaderOptions = {}) {
    /** @type {import('./workerPool').WorkerPool|null} */
    let workerPool = null;

    /**
     * Checks if the worker pool has been disposed.
     * 
     * @param {import('./workerPool').WorkerPool|null} pool - Worker pool to check.
     * @returns {boolean} True if pool is disposed or null.
     */
    function isPoolDisposed(pool) {
        return !pool || (typeof pool.isDisposed === 'function' && pool.isDisposed());
    }

    /**
     * Gets the active worker pool instance, initializing it lazily if it doesn't exist.
     * 
     * @returns {import('./workerPool').WorkerPool} Active worker pool.
     */
    function getWorkerPool() {
        if (isPoolDisposed(workerPool)) {
            workerPool = null;
        }
        if (!workerPool) {
            workerPool = createPool({ workerPath, fileScanCacheDirectory });
        }
        return workerPool;
    }

    return {
        /**
         * Asynchronously delegates project indexing to the worker pool.
         * 
         * @param {string} rootFile - Absolute path to the root LS-DYNA file.
         * @param {Object} [options] - Indexing options.
         * @param {function(Object): void} [onProgress] - Optional progress callback.
         * @returns {Promise<import('../core/project/projectIndexer').ProjectIndexResult>} Scanned project snapshot.
         */
        async buildProjectIndex(rootFile, options = {}, onProgress = null) {
            const pool = getWorkerPool();
            try {
                return await pool.buildProjectIndex(rootFile, options, onProgress);
            } catch (error) {
                if (workerPool === pool && isPoolDisposed(pool)) {
                    workerPool = null;
                }
                throw error;
            }
        },

        /**
         * Disposes the active worker pool and frees up system processes.
         * 
         * @returns {Promise<void>}
         */
        async dispose() {
            if (!workerPool) return;
            await workerPool.dispose();
            workerPool = null;
        },
    };
}

module.exports = {
    createProjectIndexLoader,
};

export {};
