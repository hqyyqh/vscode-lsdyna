'use strict';

/**
 * @fileoverview Main entry point for the LS-DYNA Language Server Protocol (LSP) server.
 * @module server/server
 * 
 * This file establishes a node-based LSP connection (vscode-languageserver), binds event handlers
 * for session initialization and shutdown, and registers router hooks to handle incoming JSON-RPC 
 * requests and notification messages.
 * 
 * Role in System: Runs in an isolated background process to handle heavy indexing operations,
 * keeping the extension's UI thread fully responsive.
 */

const { createConnection, ProposedFeatures, TextDocumentSyncKind } = require('vscode-languageserver/node');
const { initializeSession, shutdownSession } = require('./sessionManager');
const { handleRequest, handleNotification } = require('./requestRouter');
const protocol = require('../shared/protocol');

/**
 * Active language server connection instance utilizing ProposedFeatures.
 * @type {import('vscode-languageserver').Connection}
 */
const connection = createConnection(ProposedFeatures.all);

// Bind initialization hook to register capabilities and boot session storage.
connection.onInitialize((params) => {
    const initOptions = params.initializationOptions || {};
    initializeSession({
        globalStoragePath: initOptions.globalStoragePath,
        maxCacheBytes: initOptions.maxCacheBytes,
    });

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
        },
    };
});

// Bind shutdown hook to dispose resources.
connection.onShutdown(async () => {
    await shutdownSession();
});

// Bind custom request handler for loading project snapshots.
connection.onRequest(protocol.LOAD_PROJECT_SNAPSHOT_REQUEST, async (params) => {
    return handleRequest(protocol.LOAD_PROJECT_SNAPSHOT_REQUEST, params, {
        sendNotification: (method, data) => connection.sendNotification(method, data),
    });
});

// Bind custom request handler for retrieving cache manifests.
connection.onRequest(protocol.GET_MANIFEST_ENTRIES_REQUEST, async (params) => {
    return handleRequest(protocol.GET_MANIFEST_ENTRIES_REQUEST, params);
});

// Bind custom request handler for fetching cache size and stats.
connection.onRequest(protocol.GET_CACHE_STATS_REQUEST, async (params) => {
    return handleRequest(protocol.GET_CACHE_STATS_REQUEST, params);
});

// Bind custom notification handler to invalidate cache ranges.
connection.onNotification(protocol.INVALIDATE_NOTIFICATION, (params) => {
    handleNotification(protocol.INVALIDATE_NOTIFICATION, params);
});

// Start listening on JSON-RPC.
connection.listen();
