'use strict';

/**
 * @fileoverview Custom JSON-RPC request and notification protocol method constants for LSP bridge.
 * @module shared/protocol
 * 
 * This file defines the string constants identifying JSON-RPC request types and notification events
 * sent between the VS Code extension client and the isolated language server process.
 * 
 * Role in System: Shared protocol interface defining the message channel boundaries.
 */

/**
 * Request to trigger background index compilation for a project, returning the completed snapshot.
 * @type {string}
 */
const LOAD_PROJECT_SNAPSHOT_REQUEST = 'lsdyna/loadProjectSnapshot';

/**
 * Notification informing the server that a file changed, invalidating relevant caches.
 * @type {string}
 */
const INVALIDATE_NOTIFICATION = 'lsdyna/invalidate';

/**
 * Request to retrieve the list of all active cache manifest entries on disk.
 * @type {string}
 */
const GET_MANIFEST_ENTRIES_REQUEST = 'lsdyna/getManifestEntries';

/**
 * Request to query cache capacity and size statistics.
 * @type {string}
 */
const GET_CACHE_STATS_REQUEST = 'lsdyna/getCacheStats';

module.exports = {
    LOAD_PROJECT_SNAPSHOT_REQUEST,
    INVALIDATE_NOTIFICATION,
    GET_MANIFEST_ENTRIES_REQUEST,
    GET_CACHE_STATS_REQUEST,
};
