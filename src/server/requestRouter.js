'use strict';

const { getActiveSession } = require('./sessionManager');
const { serializeProjectSnapshot } = require('../core/cache/snapshotSerializer');
const protocol = require('../shared/protocol');

async function handleRequest(method, params) {
    const session = getActiveSession();
    if (!session) {
        throw new Error('No active server session initialized');
    }

    switch (method) {
        case protocol.LOAD_PROJECT_SNAPSHOT_REQUEST: {
            const { rootFile } = params;
            const snapshot = await session.indexClient.loadProjectSnapshot(rootFile);
            return serializeProjectSnapshot(snapshot);
        }
        case protocol.GET_MANIFEST_ENTRIES_REQUEST: {
            return session.indexClient.getManifestEntries();
        }
        case protocol.GET_CACHE_STATS_REQUEST: {
            return session.indexClient.getCacheStats();
        }
        default:
            throw new Error(`Unsupported custom request method: ${method}`);
    }
}

function handleNotification(method, params) {
    const session = getActiveSession();
    if (!session) return;

    switch (method) {
        case protocol.INVALIDATE_NOTIFICATION: {
            const { rootFile } = params;
            session.indexClient.invalidate(rootFile);
            break;
        }
        default:
            // Ignore unsupported notifications
            break;
    }
}

module.exports = {
    handleRequest,
    handleNotification,
};
