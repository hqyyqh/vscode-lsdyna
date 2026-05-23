'use strict';

const { createConnection, ProposedFeatures, TextDocumentSyncKind } = require('vscode-languageserver/node');
const { initializeSession, shutdownSession } = require('./sessionManager');
const { handleRequest, handleNotification } = require('./requestRouter');
const protocol = require('../shared/protocol');

const connection = createConnection(ProposedFeatures.all);

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

connection.onShutdown(async () => {
    await shutdownSession();
});

connection.onRequest(protocol.LOAD_PROJECT_SNAPSHOT_REQUEST, async (params) => {
    return handleRequest(protocol.LOAD_PROJECT_SNAPSHOT_REQUEST, params);
});

connection.onRequest(protocol.GET_MANIFEST_ENTRIES_REQUEST, async (params) => {
    return handleRequest(protocol.GET_MANIFEST_ENTRIES_REQUEST, params);
});

connection.onRequest(protocol.GET_CACHE_STATS_REQUEST, async (params) => {
    return handleRequest(protocol.GET_CACHE_STATS_REQUEST, params);
});

connection.onNotification(protocol.INVALIDATE_NOTIFICATION, (params) => {
    handleNotification(protocol.INVALIDATE_NOTIFICATION, params);
});

connection.listen();
