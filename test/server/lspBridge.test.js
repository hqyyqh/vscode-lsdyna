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

    it('reuses the active session when initialize is received twice', () => {
        const first = initializeSession();
        const second = initializeSession();

        assert.strictEqual(second, first);
        assert.strictEqual(getActiveSession(), first);
    });

    it('detaches a closing session before awaiting disposal and preserves its replacement', async () => {
        const closingSession = initializeSession();
        let releaseDispose;
        let disposeStarted = false;
        closingSession.projectIndexLoader.dispose = async () => {
            disposeStarted = true;
            await new Promise(resolve => {
                releaseDispose = resolve;
            });
        };

        const closing = shutdownSession();
        assert.strictEqual(disposeStarted, true);

        let replacement = null;
        try {
            assert.equal(getActiveSession(), null);
            replacement = initializeSession();
        } finally {
            releaseDispose();
            await closing;
        }

        assert.strictEqual(getActiveSession(), replacement);
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
        const cancellationToken = { isCancellationRequested: false };
        session.indexClient.loadProjectSnapshot = async (file, options, onProgress, token) => {
            assert.equal(file, rootFile);
            assert.deepEqual(options, {});
            assert.equal(typeof onProgress, 'function');
            assert.strictEqual(token, cancellationToken);
            return snapshot;
        };

        const serialized = await handleRequest(
            protocol.LOAD_PROJECT_SNAPSHOT_REQUEST,
            { rootFile },
            null,
            cancellationToken,
        );
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

    it('requestRouter clears every server-owned cache layer explicitly', async () => {
        const session = initializeSession();
        const expected = {
            memory: { cachedSnapshotCount: 1, totalSnapshotBytes: 100 },
            projectSnapshotDisk: { entryCount: 1, totalBytes: 200 },
            fileScanDisk: { entryCount: 2, totalBytes: 300 },
        };
        let calls = 0;
        session.clearCaches = async () => {
            calls += 1;
            return expected;
        };

        assert.deepEqual(await handleRequest(protocol.CLEAR_CACHES_REQUEST), expected);
        assert.equal(calls, 1);
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

        let requestCancellationToken = null;
        const mockLanguageClient = {
            async sendRequest(method, params, cancellationToken) {
                requestMethod = method;
                requestParams = params;
                requestCancellationToken = cancellationToken;
                if (method === protocol.LOAD_PROJECT_SNAPSHOT_REQUEST) {
                    return serialized;
                }
                if (method === protocol.GET_MANIFEST_ENTRIES_REQUEST) {
                    return [{ rootFile, trackedFiles: [rootFile] }];
                }
                if (method === protocol.GET_CACHE_STATS_REQUEST) {
                    return { cachedSnapshotCount: 1 };
                }
                if (method === protocol.CLEAR_CACHES_REQUEST) {
                    return { memory: { cachedSnapshotCount: 1, totalSnapshotBytes: 10 } };
                }
                return null;
            },
            sendNotification(method, params) {
                notificationMethod = method;
                notificationParams = params;
            },
        };

        const client = createIndexClient({ languageClient: mockLanguageClient });

        const cancellationToken = { isCancellationRequested: false };
        const snapshot = await client.loadProjectSnapshot(
            rootFile,
            { largeFileMode: 'skeleton' },
            () => undefined,
            cancellationToken,
        );
        assert.equal(snapshot.rootFile, rootFile);
        assert.ok(snapshot.keywordMap instanceof Map);
        assert.equal(requestMethod, protocol.LOAD_PROJECT_SNAPSHOT_REQUEST);
        assert.deepEqual(requestParams, { rootFile, options: { largeFileMode: 'skeleton' }, requestId: '1' });
        assert.strictEqual(requestCancellationToken, cancellationToken);

        client.invalidate(rootFile);
        assert.equal(notificationMethod, protocol.INVALIDATE_NOTIFICATION);
        assert.deepEqual(notificationParams, { rootFile });

        const manifest = await client.getManifestEntries();
        assert.equal(requestMethod, protocol.GET_MANIFEST_ENTRIES_REQUEST);
        assert.deepEqual(manifest, [{ rootFile, trackedFiles: [rootFile] }]);

        const stats = await client.getCacheStats();
        assert.equal(requestMethod, protocol.GET_CACHE_STATS_REQUEST);
        assert.deepEqual(stats, { cachedSnapshotCount: 1 });

        const cleared = await client.clearCaches();
        assert.equal(requestMethod, protocol.CLEAR_CACHES_REQUEST);
        assert.deepEqual(cleared, {
            memory: { cachedSnapshotCount: 1, totalSnapshotBytes: 10 },
        });
    });
});


describe('validated snapshot reuse on the wire', () => {
    it('sends an identity only after receiving it and reuses the same hydrated snapshot', async () => {
        const { createIndexClient } = require('../../out/client/services/indexClient');
        const { ProjectGraph } = require('../../out/core/project/projectGraph');
        const { serializeProjectSnapshot } = require('../../out/core/cache/snapshotSerializer');
        const rootFile=path.resolve('reuse.k'),graph=new ProjectGraph();graph.addFile(rootFile);
        const serialized={...serializeProjectSnapshot({rootFile,graph,files:[rootFile]}),snapshotId:'fixture-1'};
        const requests=[];
        const client=createIndexClient({languageClient:{sendNotification(){},sendRequest:async(_method,params)=>{
            requests.push(params);
            return requests.length===1?serialized:{rootFile,snapshotId:'fixture-1',snapshotUnchanged:true};
        }}});
        const first=await client.loadProjectSnapshot(rootFile);
        assert.strictEqual(await client.loadProjectSnapshot(rootFile),first);
        assert.equal(Object.hasOwn(requests[0],'reuseSnapshotId'),false);
        assert.equal(requests[1].reuseSnapshotId,'fixture-1');
    });
});
