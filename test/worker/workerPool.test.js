'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('createWorkerPool', () => {
    it('builds project snapshots in a worker and hydrates graph and keywordMap', async () => {
        const { createWorkerPool } = require('../../src/worker/workerPool');
        const workerPath = path.join(__dirname, '..', '..', 'src', 'worker', 'scanWorker.js');
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
});
