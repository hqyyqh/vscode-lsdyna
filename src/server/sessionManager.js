'use strict';

const { createIndexClient } = require('../client/services/indexClient');
const { createProjectIndexLoader } = require('../worker/projectIndexLoader');
const { createDiskSnapshotStore } = require('../core/cache/diskSnapshotStore');

class LsdynaServerSession {
    constructor({ globalStoragePath, maxCacheBytes } = {}) {
        this.projectIndexLoader = createProjectIndexLoader();

        let persistentCache = null;
        if (globalStoragePath) {
            persistentCache = createDiskSnapshotStore({
                cacheDirectory: globalStoragePath,
                maxCacheBytes: maxCacheBytes || 256 * 1024 * 1024,
            });
        }

        this.indexClient = createIndexClient({
            buildProjectIndex: this.projectIndexLoader.buildProjectIndex,
            persistentCache,
        });
    }

    async dispose() {
        if (this.projectIndexLoader) {
            await this.projectIndexLoader.dispose();
        }
    }
}

let activeSession = null;

function initializeSession(options) {
    if (activeSession) {
        throw new Error('Server session is already initialized');
    }
    activeSession = new LsdynaServerSession(options);
    return activeSession;
}

function getActiveSession() {
    return activeSession;
}

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
