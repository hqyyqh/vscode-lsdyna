'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function serializedSnapshot(rootFile = 'project/main.k') {
    return {
        rootFile,
        files: [rootFile],
        fileIndexes: [],
        graph: { rootFile, children: [], missingFiles: [], cycles: [] },
        keywordMap: [],
    };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

describe('createWorkerPool', () => {
    it('builds project snapshots in a worker and hydrates graph and keywordMap', async () => {
        const { createWorkerPool } = require('../../src/worker/workerPool');
        const workerPath = path.join(__dirname, '..', '..', 'out', 'worker', 'scanWorker.js');
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-worker-pool-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.key');
        const pool = createWorkerPool({ workerPath });

        fs.writeFileSync(rootFile, '*INCLUDE\nchild.key\n', 'utf8');
        fs.writeFileSync(childFile, '*PART\n', 'utf8');

        try {
            const snapshot = await pool.buildProjectIndex(rootFile);
            assert.ok(snapshot.keywordMap instanceof Map);
            assert.deepEqual(snapshot.keywordMap.get('PART').map(entry => entry.filePath), [childFile]);
            assert.deepEqual(snapshot.graph.toTree(rootFile), {
                filePath: rootFile,
                children: [
                    {
                        filePath: childFile,
                        children: [],
                    },
                ],
            });
            assert.strictEqual(snapshot.missingFiles, snapshot.graph.missingFiles);
            assert.strictEqual(snapshot.cycles, snapshot.graph.cycles);
        } finally {
            await pool.dispose();
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('rejects pending requests when the worker errors', async () => {
        const { createWorkerPool } = require('../../src/worker/workerPool');
        const handlers = new Map();
        const fakeWorker = {
            on(eventName, handler) {
                handlers.set(eventName, handler);
            },
            postMessage() {},
            terminate() {
                return Promise.resolve(0);
            },
        };
        const pool = createWorkerPool({
            workerPath: 'fake-worker.js',
            workerFactory: () => fakeWorker,
        });

        const pendingRequest = pool.buildProjectIndex('project/main.k');
        handlers.get('error')(new Error('worker crashed'));

        await assert.rejects(pendingRequest, /worker crashed/);
        await pool.dispose();
    });

    it('uses a 120-second default and terminates after the injected inactivity timeout', async () => {
        const { createWorkerPool, DEFAULT_REQUEST_TIMEOUT_MS } = require('../../src/worker/workerPool');
        const handlers = new Map();
        let terminateCalls = 0;
        const fakeWorker = {
            on(eventName, handler) {
                handlers.set(eventName, handler);
            },
            postMessage() {},
            terminate() {
                terminateCalls += 1;
                return Promise.resolve(0);
            },
        };
        const pool = createWorkerPool({
            workerPath: 'silent-worker.js',
            workerFactory: () => fakeWorker,
            requestTimeoutMs: 30,
        });

        const pending = pool.buildProjectIndex('project/main.k');
        const outcome = await Promise.race([
            pending.then(
                () => ({ kind: 'resolved' }),
                error => ({ kind: 'rejected', error }),
            ),
            delay(100).then(() => ({ kind: 'outer-timeout' })),
        ]);

        try {
            assert.strictEqual(DEFAULT_REQUEST_TIMEOUT_MS, 120000);
            assert.strictEqual(outcome.kind, 'rejected');
            assert.match(outcome.error.message, /timed out after 30 ms/i);
            assert.strictEqual(pool.isDisposed(), true);
            assert.strictEqual(terminateCalls, 1);
        } finally {
            await pool.dispose();
        }
    });

    it('refreshes the inactivity timeout on progress and clears it after success', async () => {
        const { createWorkerPool } = require('../../src/worker/workerPool');
        const handlers = new Map();
        let postedMessage = null;
        let terminateCalls = 0;
        const fakeWorker = {
            on(eventName, handler) {
                handlers.set(eventName, handler);
            },
            postMessage(message) {
                postedMessage = message;
            },
            terminate() {
                terminateCalls += 1;
                return Promise.resolve(0);
            },
        };
        const pool = createWorkerPool({
            workerPath: 'progress-worker.js',
            workerFactory: () => fakeWorker,
            requestTimeoutMs: 80,
        });
        const progressSnapshots = [];
        const pending = pool.buildProjectIndex(
            'project/main.k',
            {},
            snapshot => progressSnapshots.push(snapshot),
        );

        setTimeout(() => {
            handlers.get('message')({
                requestId: postedMessage.requestId,
                snapshot: serializedSnapshot(),
                type: 'progress',
            });
        }, 50);
        setTimeout(() => {
            handlers.get('message')({
                requestId: postedMessage.requestId,
                snapshot: serializedSnapshot(),
                type: 'result',
            });
        }, 100);

        try {
            const result = await pending;
            assert.strictEqual(result.rootFile, 'project/main.k');
            assert.strictEqual(progressSnapshots.length, 1);
            await delay(100);
            assert.strictEqual(terminateCalls, 0);
            assert.strictEqual(pool.isDisposed(), false);
        } finally {
            await pool.dispose();
        }
    });

    it('clears the inactivity timeout after a worker error response', async () => {
        const { createWorkerPool } = require('../../src/worker/workerPool');
        const handlers = new Map();
        let postedMessage = null;
        let terminateCalls = 0;
        const fakeWorker = {
            on(eventName, handler) {
                handlers.set(eventName, handler);
            },
            postMessage(message) {
                postedMessage = message;
            },
            terminate() {
                terminateCalls += 1;
                return Promise.resolve(0);
            },
        };
        const pool = createWorkerPool({
            workerPath: 'error-worker.js',
            workerFactory: () => fakeWorker,
            requestTimeoutMs: 50,
        });
        const pending = pool.buildProjectIndex('project/main.k');

        handlers.get('message')({
            error: {
                message: 'scan failed',
                name: 'ScanError',
            },
            requestId: postedMessage.requestId,
            type: 'error',
        });

        try {
            await assert.rejects(pending, /scan failed/);
            await delay(100);
            assert.strictEqual(terminateCalls, 0);
            assert.strictEqual(pool.isDisposed(), false);
        } finally {
            await pool.dispose();
        }
    });

    it('rejects pending requests immediately when disposed', async () => {
        const { createWorkerPool } = require('../../src/worker/workerPool');
        const fakeWorker = {
            on() {},
            postMessage() {},
            terminate() {
                return Promise.resolve(0);
            },
        };
        const pool = createWorkerPool({
            workerPath: 'pending-worker.js',
            workerFactory: () => fakeWorker,
        });
        const pending = pool.buildProjectIndex('project/main.k');

        const disposing = pool.dispose();
        await assert.rejects(pending, /disposed/i);
        await disposing;
        assert.strictEqual(pool.isDisposed(), true);
    });

    it('rejects an unexpected response type instead of leaving the request pending', async () => {
        const { createWorkerPool } = require('../../src/worker/workerPool');
        const handlers = new Map();
        let postedMessage = null;
        const fakeWorker = {
            on(eventName, handler) {
                handlers.set(eventName, handler);
            },
            postMessage(message) {
                postedMessage = message;
            },
            terminate() {
                return Promise.resolve(0);
            },
        };
        const pool = createWorkerPool({
            workerPath: 'protocol-worker.js',
            workerFactory: () => fakeWorker,
            requestTimeoutMs: 1000,
        });
        const pending = pool.buildProjectIndex('project/main.k');
        const settled = pending.then(
            () => ({ kind: 'resolved' }),
            error => ({ kind: 'rejected', error }),
        );

        let dispatchError = null;
        try {
            handlers.get('message')({
                requestId: postedMessage.requestId,
                type: 'unexpected',
            });
        } catch (error) {
            dispatchError = error;
        }

        const outcome = await Promise.race([
            settled,
            delay(100).then(() => ({ kind: 'outer-timeout' })),
        ]);
        try {
            assert.equal(dispatchError, null);
            assert.strictEqual(outcome.kind, 'rejected');
            assert.match(outcome.error.message, /unexpected scan worker response type/i);
        } finally {
            await pool.dispose();
        }
    });

    it('rejects malformed result snapshots instead of throwing from the message handler', async () => {
        const { createWorkerPool } = require('../../src/worker/workerPool');
        const handlers = new Map();
        let postedMessage = null;
        const fakeWorker = {
            on(eventName, handler) {
                handlers.set(eventName, handler);
            },
            postMessage(message) {
                postedMessage = message;
            },
            terminate() {
                return Promise.resolve(0);
            },
        };
        const pool = createWorkerPool({
            workerPath: 'malformed-worker.js',
            workerFactory: () => fakeWorker,
            requestTimeoutMs: 1000,
        });
        const pending = pool.buildProjectIndex('project/main.k');
        const settled = pending.then(
            () => ({ kind: 'resolved' }),
            error => ({ kind: 'rejected', error }),
        );

        let dispatchError = null;
        try {
            handlers.get('message')({
                requestId: postedMessage.requestId,
                snapshot: null,
                type: 'result',
            });
        } catch (error) {
            dispatchError = error;
        }

        const outcome = await Promise.race([
            settled,
            delay(100).then(() => ({ kind: 'outer-timeout' })),
        ]);
        try {
            assert.equal(dispatchError, null);
            assert.strictEqual(outcome.kind, 'rejected');
            assert.match(outcome.error.message, /invalid scan worker result/i);
        } finally {
            await pool.dispose();
        }
    });
});
