'use strict';

const assert = require('assert');
const path = require('path');
const { initializeSession, getActiveSession, shutdownSession } = require('../../src/server/sessionManager');
const { handleRequest, handleNotification } = require('../../src/server/requestRouter');
const protocol = require('../../src/shared/protocol');
const { createIndexClient } = require('../../src/client/services/indexClient');

describe('LSP server-client bridge', () => {
    afterEach(async () => {
        await shutdownSession();
    });

    it('sessionManager initializes, gets and shuts down session correctly', async () => {
        const session = initializeSession({
            globalStoragePath: path.resolve('project', 'snapshots'),
            maxCacheBytes: 5000,
        });

        assert.ok(session.projectIndexLoader);
        assert.ok(session.indexClient);
        assert.strictEqual(getActiveSession(), session);

        await shutdownSession();
        assert.equal(getActiveSession(), null);
    });

    it('requestRouter handles loadProjectSnapshot request', async () => {
        const rootFile = path.resolve('project', 'main.k');
        const childFile = path.resolve('project', 'child.key');
        const snapshot = {
            rootFile,
            files: [rootFile, childFile],
            graph: {
                toJSON() {
                    return { rootFile, children: [] };
                },
                missingFiles: [],
                cycles: [],
            },
            keywordMap: new Map([['PART', []]]),
        };

        const session = initializeSession();
        // stub loadProjectSnapshot
        session.indexClient.loadProjectSnapshot = async (file) => {
            assert.equal(file, rootFile);
            return snapshot;
        };

        const serialized = await handleRequest(protocol.LOAD_PROJECT_SNAPSHOT_REQUEST, { rootFile });
        assert.equal(serialized.rootFile, rootFile);
        assert.deepEqual(serialized.keywordMap, [['PART', []]]);
    });

    it('requestRouter handles invalidate notification', () => {
        const rootFile = path.resolve('project', 'main.k');
        let invalidated = null;

        const session = initializeSession();
        session.indexClient.invalidate = (file) => {
            invalidated = file;
        };

        handleNotification(protocol.INVALIDATE_NOTIFICATION, { rootFile });
        assert.equal(invalidated, rootFile);
    });

    it('indexClient in LSP mode delegates calls to LanguageClient', async () => {
        const rootFile = path.resolve('project', 'main.k');
        const serialized = {
            rootFile,
            files: [rootFile],
            graph: { rootFile, children: [] },
            keywordMap: [['PART', []]],
        };

        let requestMethod = null;
        let requestParams = null;
        let notificationMethod = null;
        let notificationParams = null;

        const mockLanguageClient = {
            async sendRequest(method, params) {
                requestMethod = method;
                requestParams = params;
                if (method === protocol.LOAD_PROJECT_SNAPSHOT_REQUEST) {
                    return serialized;
                }
                if (method === protocol.GET_MANIFEST_ENTRIES_REQUEST) {
                    return [{ rootFile, trackedFiles: [rootFile] }];
                }
                if (method === protocol.GET_CACHE_STATS_REQUEST) {
                    return { cachedSnapshotCount: 1 };
                }
                return null;
            },
            sendNotification(method, params) {
                notificationMethod = method;
                notificationParams = params;
            },
        };

        const client = createIndexClient({ languageClient: mockLanguageClient });

        const snapshot = await client.loadProjectSnapshot(rootFile);
        assert.equal(snapshot.rootFile, rootFile);
        assert.ok(snapshot.keywordMap instanceof Map);
        assert.equal(requestMethod, protocol.LOAD_PROJECT_SNAPSHOT_REQUEST);
        assert.deepEqual(requestParams, { rootFile });

        client.invalidate(rootFile);
        assert.equal(notificationMethod, protocol.INVALIDATE_NOTIFICATION);
        assert.deepEqual(notificationParams, { rootFile });

        const manifest = await client.getManifestEntries();
        assert.equal(requestMethod, protocol.GET_MANIFEST_ENTRIES_REQUEST);
        assert.deepEqual(manifest, [{ rootFile, trackedFiles: [rootFile] }]);

        const stats = await client.getCacheStats();
        assert.equal(requestMethod, protocol.GET_CACHE_STATS_REQUEST);
        assert.deepEqual(stats, { cachedSnapshotCount: 1 });
    });
});
