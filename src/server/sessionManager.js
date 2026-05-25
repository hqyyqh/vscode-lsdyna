'use strict';

/**
 * @fileoverview Session manager for booting and maintaining active LSP server indexing services.
 * @module server/sessionManager
 * 
 * This module manages the lifecycle of the active LSP session (LsdynaServerSession).
 * It instantiates the background task worker pool (ProjectIndexLoader) and the persistent disk 
 * cache store (DiskSnapshotStore), bridging them to the index loader client (IndexClient).
 * 
 * Role in System: Orchestrates and holds state of the active LSP server runtime.
 */

const { createIndexClient } = require('../client/services/indexClient');
const { createProjectIndexLoader } = require('../worker/projectIndexLoader');
const { createDiskSnapshotStore } = require('../core/cache/diskSnapshotStore');

/**
 * Represents an active LS-DYNA Language Server Session.
 * Manages the background worker thread pool and persistent caching stores.
 */
class LsdynaServerSession {
    /**
     * Creates an LsdynaServerSession instance.
     * 
     * @param {Object} [options={}] - Configuration details.
     * @param {string} [options.globalStoragePath] - Absolute folder path to store disk caches.
     * @param {number} [options.maxCacheBytes] - Max size of disk caches before eviction (defaults to 256MB).
     */
    constructor({ globalStoragePath, maxCacheBytes } = {}) {
        /**
         * Pool coordinator for spawning background node worker processes.
         * @type {import('../worker/projectIndexLoader').ProjectIndexLoader}
         */
        this.projectIndexLoader = createProjectIndexLoader();

        /**
         * L2 persistent snapshot cache on disk.
         * @type {import('../core/cache/diskSnapshotStore').DiskSnapshotStore|null}
         */
        let persistentCache = null;
        if (globalStoragePath) {
            persistentCache = createDiskSnapshotStore({
                cacheDirectory: globalStoragePath,
                maxCacheBytes: maxCacheBytes || 256 * 1024 * 1024,
            });
        }

        /**
         * Client index loader backing workspace queries.
         * @type {import('../client/services/indexClient').IndexClient}
         */
        this.indexClient = createIndexClient({
            buildProjectIndex: this.projectIndexLoader.buildProjectIndex,
            persistentCache,
        });
    }

    /**
     * Terminate the background index loader and dispose all worker thread pools.
     * 
     * @returns {Promise<void>}
     */
    async dispose() {
        if (this.projectIndexLoader) {
            await this.projectIndexLoader.dispose();
        }
    }
}

/**
 * Singleton active session reference.
 * @type {LsdynaServerSession|null}
 */
let activeSession = null;

/**
 * Boots and registers the active server session singleton.
 * 
 * @param {Object} options - Config options passed to construction.
 * @returns {LsdynaServerSession} The newly created active session.
 * @throws {Error} If a session has already been initialized.
 */
function initializeSession(options) {
    if (activeSession) {
        throw new Error('Server session is already initialized');
    }
    activeSession = new LsdynaServerSession(options);
    return activeSession;
}

/**
 * Retrieves the currently active server session singleton.
 * 
 * @returns {LsdynaServerSession|null} Active session, or null if uninitialized.
 */
function getActiveSession() {
    return activeSession;
}

/**
 * Disposes the active server session and clears singleton reference.
 * 
 * @returns {Promise<void>}
 */
async function shutdownSession() {
    if (activeSession) {
        await activeSession.dispose();
        activeSession = null;
    }
}

module.exports = {
    initializeSession,
    getActiveSession,
    shutdownSession,
};
