'use strict';

/**
 * @fileoverview Request and notification dispatcher for custom LS-DYNA LSP messages.
 * @module server/requestRouter
 * 
 * This module routes custom JSON-RPC requests (e.g. loading a project snapshot, listing manifest
 * items, or getting cache statistics) and notifications (e.g. invalidating a cache path) to
 * the active LSP server session.
 * 
 * Role in System: Intermediary translation layer between the raw protocol connection and 
 * the session manager's indexing capabilities.
 */

const { getActiveSession } = require('./sessionManager');
const { serializeProjectSnapshot } = require('../core/cache/snapshotSerializer');
const protocol = require('../shared/protocol');

/**
 * Routes and handles incoming custom LSP JSON-RPC requests.
 * 
 * @param {string} method - Protocol request method string.
 * @param {Object} params - Method parameters payload.
 * @param {import('vscode-languageserver').Connection} [connection] - Language server connection.
 * @returns {Promise<any>} Response JSON data.
 * @throws {Error} If no active session exists or request method is unsupported.
 */
async function handleRequest(method, params, connection) {
    const session = getActiveSession();
    if (!session) {
        throw new Error('No active server session initialized');
    }

    switch (method) {
        case protocol.LOAD_PROJECT_SNAPSHOT_REQUEST: {
            const { rootFile } = params;
            const snapshot = await session.indexClient.loadProjectSnapshot(rootFile, (partialSnapshot) => {
                if (connection) {
                    connection.sendNotification(
                        protocol.SCAN_PROGRESS_NOTIFICATION, 
                        serializeProjectSnapshot(partialSnapshot)
                    );
                }
            });
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

/**
 * Routes and handles incoming custom LSP JSON-RPC notifications (one-way).
 * 
 * @param {string} method - Protocol notification method string.
 * @param {Object} params - Notification parameters payload.
 */
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
