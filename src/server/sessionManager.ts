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

const path = require('path');
const { createIndexClient, DEFAULT_MAX_SNAPSHOT_BYTES } = require('../client/services/indexClient');
const { createProjectIndexLoader } = require('../worker/projectIndexLoader');
const { entityFileSignature } = require('../core/cache/entityFileRevision');
const {
    createDiskSnapshotStore,
    DEFAULT_MAX_CACHE_BYTES: DEFAULT_PROJECT_SNAPSHOT_DISK_BYTES,
    DEFAULT_MAX_ENTRY_AGE_MS,
} = require('../core/cache/diskSnapshotStore');
const {
    DEFAULT_MAX_CACHE_BYTES: DEFAULT_FILE_SCAN_DISK_BYTES,
} = require('../core/cache/fileScanCacheStore');

type ServerSessionOptions = {
    readDocumentSource?: (request: any) => Promise<any>;
    globalStoragePath?: string;
    entityMemoryBytes?: number;
    entityDiskBytes?: number;
    maxCacheBytes?: number;
    maxMemoryCacheBytes?: number;
    maxProjectSnapshotCacheBytes?: number;
    maxFileScanCacheBytes?: number;
    maxFileScanMemoryCacheBytes?: number;
    maxCacheAgeMs?: number;
};

/**
 * Represents an active LS-DYNA Language Server Session.
 * Manages the background worker thread pool and persistent caching stores.
 */
class LsdynaServerSession {
    projectIndexLoader: any;
    indexClient: any;
    private legacySnapshotCache: any;

    /**
     * Creates an LsdynaServerSession instance.
     * 
     * @param {Object} [options={}] - Configuration details.
     * @param {string} [options.globalStoragePath] - Absolute folder path to store disk caches.
     * @param {number} [options.maxCacheBytes] - Max size of disk caches before eviction (defaults to 256MB).
     */
    constructor({
        globalStoragePath,
        readDocumentSource,
        entityMemoryBytes,
        entityDiskBytes,
        maxCacheBytes,
        maxMemoryCacheBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
        maxProjectSnapshotCacheBytes = maxCacheBytes ?? DEFAULT_PROJECT_SNAPSHOT_DISK_BYTES,
        maxFileScanCacheBytes = DEFAULT_FILE_SCAN_DISK_BYTES,
        maxFileScanMemoryCacheBytes = 16 * 1024 * 1024,
        maxCacheAgeMs = DEFAULT_MAX_ENTRY_AGE_MS,
    }: ServerSessionOptions = {}) {
        /**
         * Pool coordinator for spawning background node worker processes.
         * @type {import('../worker/projectIndexLoader').ProjectIndexLoader}
         */
        this.projectIndexLoader = createProjectIndexLoader({
            readDocumentSource,
            entityStorageDirectory: globalStoragePath,
            entityMemoryBytes,
            entityDiskBytes,
            fileScanCacheDirectory: globalStoragePath ? path.join(globalStoragePath, 'file-scans') : null,
            fileScanCacheOptions: {
                maxCacheBytes: maxFileScanCacheBytes,
                maxEntryAgeMs: maxCacheAgeMs,
            },
            fileScanMemoryCacheBytes: maxFileScanMemoryCacheBytes,
        });

        // Keep the legacy store only for explicit cache cleanup. New sessions restore
        // shared physical-file facts in the worker instead of duplicating whole projects.
        this.legacySnapshotCache = globalStoragePath ? createDiskSnapshotStore({
            cacheDirectory: globalStoragePath, maxCacheBytes: maxProjectSnapshotCacheBytes,
            maxEntryAgeMs: maxCacheAgeMs,
        }) : null;

        /**
         * Client index loader backing workspace queries.
         * @type {import('../client/services/indexClient').IndexClient}
         */
        this.indexClient = createIndexClient({
            buildProjectIndex: this.projectIndexLoader.buildProjectIndex,
            maxSnapshotBytes: maxMemoryCacheBytes,
            getFileSignature: entityFileSignature,
        });
    }

    /**
     * Clears all project-index cache layers. Active scans are cancelled by
     * recycling the worker; live editor text remains owned by VS Code.
     */
    async clearCaches() {
        const [project, fileScans] = await Promise.all([
            this.indexClient.clearCaches(),
            this.projectIndexLoader.clearPersistentCache(),
        ]);
        return {
            memory: project.memory,
            projectSnapshotDisk: this.legacySnapshotCache ? await this.legacySnapshotCache.clear() : project.projectSnapshotDisk,
            fileScanDisk: fileScans,
            ...(fileScans.entityIndex ? { entityIndex: fileScans.entityIndex } : {}),
        };
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
 * @param {Object} [options={}] - Config options passed to construction.
 * @returns {LsdynaServerSession} The newly created active session.
 * Repeated initialization is idempotent for the lifetime of the server
 * process. Initialization options are applied only when the first session is
 * created.
 */
function initializeSession(options: ServerSessionOptions = {}) {
    if (activeSession) {
        return activeSession;
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
    const closingSession = activeSession;
    if (!closingSession) return;

    // Detach before awaiting disposal so requests cannot enter a closing
    // session. A replacement created during the await must remain active.
    activeSession = null;
    await closingSession.dispose();
}

module.exports = {
    initializeSession,
    getActiveSession,
    shutdownSession,
};

export {};
