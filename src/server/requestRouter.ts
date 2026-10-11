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
const { serializeProjectSnapshot, serializeProjectSnapshotForClient } = require('../core/cache/snapshotSerializer');
const protocol = require('../shared/protocol');
const { ResponseError, LSPErrorCodes } = require('vscode-languageserver/node');
const snapshotIds = new WeakMap();
let snapshotSequence = 0;

/**
 * Routes and handles incoming custom LSP JSON-RPC requests.
 * 
 * @param {string} method - Protocol request method string.
 * @param {Object} params - Method parameters payload.
 * @param {import('vscode-languageserver').Connection} [connection] - Language server connection.
 * @param {import('vscode-languageserver').CancellationToken} [cancellationToken] - Request cancellation token.
 * @returns {Promise<any>} Response JSON data.
 * @throws {Error} If no active session exists or request method is unsupported.
 */
async function handleRequest(method, params, connection = null, cancellationToken = null) {
    const session = getActiveSession();
    if (!session) {
        throw new Error('No active server session initialized');
    }

    try { switch (method) {
        case protocol.QUERY_ENTITY_REQUEST: {
            return await session.projectIndexLoader.queryEntity(params, null, cancellationToken);
        }
        case protocol.LOAD_PROJECT_SNAPSHOT_REQUEST: {
            const { rootFile, options, requestId, reuseSnapshotId } = params;
            const snapshot = await session.indexClient.loadProjectSnapshot(rootFile, options || {}, (partialSnapshot) => {
                if (connection && requestId && partialSnapshot.type) {
                    if (!cancellationToken?.isCancellationRequested) {
                        const event = partialSnapshot.type === 'structureReady'
                            ? { ...partialSnapshot, snapshot: serializeProjectSnapshot(partialSnapshot.snapshot) }
                            : partialSnapshot;
                        void connection.sendNotification(protocol.SCAN_PROGRESS_NOTIFICATION, { requestId, event });
                    }
                } else if (connection && requestId) {
                    void serializeProjectSnapshotForClient(partialSnapshot).then(snapshot => {
                        if (!cancellationToken?.isCancellationRequested) {
                            return connection.sendNotification(protocol.SCAN_PROGRESS_NOTIFICATION, { requestId, snapshot });
                        }
                    }).catch(error => console.warn('[lsdyna] Scan progress delivery failed:', error));
                }
            }, cancellationToken);
            if (connection && requestId) {
                let snapshotId = snapshotIds.get(snapshot);
                if (!snapshotId) { snapshotId = String(++snapshotSequence); snapshotIds.set(snapshot, snapshotId); }
                if (reuseSnapshotId === snapshotId) return { rootFile: snapshot.rootFile, snapshotId, snapshotUnchanged: true };
                const result = await serializeProjectSnapshotForClient(snapshot, chunk =>
                    connection.sendNotification(protocol.SNAPSHOT_REFERENCES_NOTIFICATION, { requestId, ...chunk }),
                    cancellationToken);
                return { ...result, snapshotId };
            }
            return serializeProjectSnapshot(snapshot);
        }
        case protocol.GET_MANIFEST_ENTRIES_REQUEST: {
            return session.indexClient.getManifestEntries();
        }
        case protocol.GET_CACHE_STATS_REQUEST: {
            const stats = await session.indexClient.getCacheStats();
            const entityIndex = await session.projectIndexLoader?.getEntityIndexStats?.();
            return entityIndex ? { ...stats, entityIndex } : stats;
        }
        case protocol.CLEAR_CACHES_REQUEST: {
            return session.clearCaches();
        }
        default:
            throw new Error(`Unsupported custom request method: ${method}`);
    } } catch (error) {
        if (error?.name === 'CancellationError') {
            throw new ResponseError(LSPErrorCodes.RequestCancelled, error.message);
        }
        throw error;
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

export {};
