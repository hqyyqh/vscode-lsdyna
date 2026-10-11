'use strict';

const assert = require('assert');

describe('locked LanguageClient startup contract', () => {
    it('waits for async invalidation delivery and reports rejection to its caller', async () => {
        const { createIndexClient } = require('../../out/client/services/indexClient');
        let finish;
        const languageClient = { sendRequest: async () => null,
            sendNotification: () => new Promise(resolve => { finish = resolve; }) };
        const index = createIndexClient({ languageClient });
        let settled = false;
        const invalidated = index.invalidate('/model.k').then(() => { settled = true; });
        await Promise.resolve();
        assert.equal(settled, false);
        finish();
        await invalidated;
        languageClient.sendNotification = async () => { throw Error('controlled inactive connection'); };
        await assert.rejects(index.invalidate('/model.k'), /controlled inactive connection/);
    });
});
const path = require('path');
const { initializeSession, getActiveSession, shutdownSession } = require('../../src/server/sessionManager');
const { handleRequest, handleNotification } = require('../../src/server/requestRouter');
const protocol = require('../../src/shared/protocol');
const { createIndexClient } = require('../../src/client/services/indexClient');

describe('LSP server-client bridge', () => {
    afterEach(async () => {
        await shutdownSession();
    });
    const temporary = require('../support/tempDirectories').trackTempDirectories();

    it('restores project views from shared SQLite file facts without writing project JSON snapshots', async function() {
        this.timeout(20000);
        const fs = require('fs'), os = require('os');
        const root = temporary(path.join(os.tmpdir(), 'session-sqlite-')), file = path.join(root, 'model.k');
        const storage = path.join(root, 'storage');
        fs.writeFileSync(file, '*KEYWORD\n*DEFINE_CURVE\n1\n0,0\n1,1\n*END\n');
        let session = initializeSession({ globalStoragePath: storage });
        const first = await session.indexClient.loadProjectSnapshot(file);
        assert.equal(fs.existsSync(path.join(storage, 'index.json')), false);
        assert.equal(fs.existsSync(path.join(storage, 'file-scans', 'file-scan-index.json')), false);
        await shutdownSession();
        session = initializeSession({ globalStoragePath: storage });
        const restored = await session.indexClient.loadProjectSnapshot(file);
        assert.deepEqual(restored.keywordMap, first.keywordMap);
        assert.equal(restored.stats.scannedFileCount, 0);
        assert.ok(restored.stats.reusedFileCount >= 1);
    });

    it('routes entity pages directly to the worker without transferring a project snapshot', async () => {
        const session = initializeSession();
        const request = { rootFile: path.resolve('model.k'), scope: 'single-file', id: 1, targetKind: 'node' };
        const token = { isCancellationRequested: false };
        const response = { status: 'ready', revision: 'v1', result: { locations: [] } };
        session.indexClient.loadProjectSnapshot = async () => { throw Error('Entity page must not request a host snapshot'); };
        session.projectIndexLoader.queryEntity = async (params, progress, passedToken) => {
            assert.deepEqual(params, request); assert.equal(progress, null); assert.strictEqual(passedToken, token);
            return response;
        };
        const client = createIndexClient({ languageClient: { sendNotification() {},
            sendRequest: (method, params, cancellationToken) => handleRequest(method, params, null, cancellationToken) } });
        assert.strictEqual(await client.queryEntity(request, token), response);
        session.projectIndexLoader.queryEntity = async () => {
            throw require('../../out/core/scanner/scannerContracts').createCancellationError();
        };
        await assert.rejects(client.queryEntity(request, token), error => error.name === 'CancellationError');
    });

    it('preserves server cancellation across JSON-RPC without hiding real failures', async () => {
        const { createCancellationError } = require('../../src/core/scanner/scannerContracts');
        const { ResponseError, LSPErrorCodes } = require('vscode-languageserver-protocol');
        const session = initializeSession();
        let failure = createCancellationError();
        session.indexClient.loadProjectSnapshot = async () => { throw failure; };
        const client = createIndexClient({ languageClient: {
            sendNotification() {},
            sendRequest: async (method, params) => {
                try { return await handleRequest(method, params); }
                catch (error) {
                    if (error instanceof ResponseError) {
                        const wire = JSON.parse(JSON.stringify(error.toJson()));
                        assert.equal(wire.code, LSPErrorCodes.RequestCancelled);
                        throw new ResponseError(wire.code, wire.message, wire.data);
                    }
                    throw error;
                }
            },
        } });
        await assert.rejects(client.loadProjectSnapshot(path.resolve('main.k')), error => error.name === 'CancellationError');
        failure = new Error('controlled disk read failure');
        await assert.rejects(client.loadProjectSnapshot(path.resolve('main.k')), /controlled disk read failure/);
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
    it('includes worker-owned entity cache statistics without loading a project snapshot', async () => {
        const session = initializeSession();
        session.indexClient.getCacheStats = async () => ({ cachedSnapshotCount: 2 });
        session.indexClient.loadProjectSnapshot = async () => { throw new Error('unexpected snapshot'); };
        session.projectIndexLoader.getEntityIndexStats = async () => ({ sqlite: { bytes: 4096 }, memoryBudget: 1024 });
        assert.deepEqual(await handleRequest(protocol.GET_CACHE_STATS_REQUEST), {
            cachedSnapshotCount: 2, entityIndex: { sqlite: { bytes: 4096 }, memoryBudget: 1024 } });
    });

    it('propagates unconfirmed worker shutdown through cache-clear and session disposal', async () => {
        const { createProjectIndexLoader } = require('../../src/worker/projectIndexLoader');
        const failure = new Error('worker stop unavailable');
        const session = initializeSession();
        const originalLoader = session.projectIndexLoader;
        session.projectIndexLoader = createProjectIndexLoader({
            createPool: () => ({
                async buildProjectIndex(rootFile) { return { rootFile }; },
                async dispose() { throw failure; },
            }),
        });
        try {
            await session.projectIndexLoader.buildProjectIndex('main.k');
            await assert.rejects(handleRequest(protocol.CLEAR_CACHES_REQUEST), error => error === failure);
            await assert.rejects(session.dispose(), error => error === failure);
            await assert.rejects(session.dispose(), error => error === failure);
        } finally {
            session.projectIndexLoader = originalLoader;
        }
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
