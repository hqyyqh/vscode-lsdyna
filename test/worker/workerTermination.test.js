'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const { createWorkerPool } = require('../../src/worker/workerPool');
const { createProjectIndexLoader } = require('../../src/worker/projectIndexLoader');
const { createFileScanCacheStore } = require('../../src/core/cache/fileScanCacheStore');

const turn = () => new Promise(resolve => setImmediate(resolve));
function gate() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

describe('confirmed worker termination', () => {
    for (const synchronous of [false, true]) {
        it(`preserves ${synchronous ? 'synchronous' : 'asynchronous'} termination failure on every dispose`, async () => {
            const failure = new Error('termination unavailable');
            let calls = 0;
            const pool = createWorkerPool({
                workerPath: 'injected-worker.js',
                workerFactory: () => ({
                    on() {}, postMessage() {},
                    terminate() {
                        calls += 1;
                        if (synchronous) throw failure;
                        return Promise.reject(failure);
                    },
                }),
            });
            await Promise.all([pool.dispose(), pool.dispose()].map(operation =>
                assert.rejects(operation, error => error === failure)));
            await assert.rejects(pool.dispose(), error => error === failure);
            assert.equal(calls, 1);
            assert.equal(pool.isDisposed(), true);
        });

        for (const trigger of ['clear', 'fatal', 'recovery']) {
            it(`keeps an unconfirmed pool after ${trigger} and ${synchronous ? 'sync' : 'async'} stop failure`, async () => {
                const failure = new Error('stop failed');
                let creates = 0, stops = 0, cacheCreates = 0, retired = false;
                const loader = createProjectIndexLoader({
                    fileScanCacheDirectory: path.resolve('injected-cache'),
                    createFileScanCache() { cacheCreates += 1; throw new Error('must not touch cache'); },
                    createPool() {
                        creates += 1;
                        return {
                            async buildProjectIndex(rootFile) {
                                if (trigger !== 'clear') { retired = true; throw new Error('scan failed'); }
                                return { rootFile };
                            },
                            isDisposed: () => retired,
                            dispose() {
                                stops += 1;
                                retired = true;
                                if (synchronous) throw failure;
                                return Promise.reject(failure);
                            },
                        };
                    },
                });
                if (trigger !== 'clear') await assert.rejects(loader.buildProjectIndex('main.k'), /scan failed/);
                else await loader.buildProjectIndex('main.k');
                if (trigger === 'recovery') await assert.rejects(loader.buildProjectIndex('retry.k'), error => error === failure);
                await assert.rejects(loader.clearPersistentCache(), error => error === failure);
                await assert.rejects(loader.buildProjectIndex('again.k'), error => error === failure);
                await assert.rejects(loader.clearPersistentCache(), error => error === failure);
                await Promise.all([loader.dispose(), loader.dispose()].map(operation =>
                    assert.rejects(operation, error => error === failure)));
                await assert.rejects(loader.dispose(), error => error === failure);
                assert.deepEqual({ creates, stops, cacheCreates }, { creates: 1, stops: 1, cacheCreates: 0 });
            });
        }
    }

    it('observes automatic stop failure and preserves the original scan error', async () => {
        const failure = new Error('automatic stop failed');
        const handlers = new Map();
        const unhandled = [];
        const observe = error => unhandled.push(error);
        let calls = 0;
        process.on('unhandledRejection', observe);
        try {
            const pool = createWorkerPool({
                workerPath: 'injected-worker.js',
                workerFactory: () => ({
                    on: (event, handler) => handlers.set(event, handler),
                    postMessage(message) {
                        handlers.get('message')({ requestId: message.requestId, type: 'invalid' });
                    },
                    terminate() { calls += 1; return Promise.reject(failure); },
                }),
            });
            await assert.rejects(pool.buildProjectIndex('main.k'), /unexpected scan worker response/);
            await turn();
            assert.deepEqual(unhandled, []);
            await assert.rejects(pool.dispose(), error => error === failure);
            assert.equal(calls, 1);
        } finally {
            process.removeListener('unhandledRejection', observe);
        }
    });

    for (const permanentShutdown of [false, true]) {
        it(`waits for both stop and cache invalidation${permanentShutdown ? ' during permanent shutdown' : ' before rebuilding'}`, async () => {
            const stopped = gate(), invalidated = gate(), stopStarted = gate(), cacheStarted = gate();
            let creates = 0, stops = 0;
            const loader = createProjectIndexLoader({
                fileScanCacheDirectory: path.resolve('injected-cache'),
                createPool() {
                    creates += 1;
                    let retired = false;
                    return {
                        async buildProjectIndex(rootFile) { return { rootFile }; },
                        isDisposed: () => retired,
                        async dispose() { stops += 1; retired = true; stopStarted.resolve(); await stopped.promise; },
                    };
                },
                createFileScanCache: () => ({
                    async invalidateAll() { cacheStarted.resolve(); await invalidated.promise; return { entryCount: 1, totalBytes: 7 }; },
                }),
            });
            await loader.buildProjectIndex('main.k');
            const clears = [loader.clearPersistentCache(), loader.clearPersistentCache()];
            await stopStarted.promise;
            let scanSettled = false, closeSettled = false;
            const scan = loader.buildProjectIndex('again.k').then(
                value => { scanSettled = true; return { value }; },
                error => { scanSettled = true; return { error }; });
            const closing = permanentShutdown ? loader.dispose().then(() => { closeSettled = true; }) : null;
            try {
                await turn();
                assert.deepEqual({ creates, stops, scanSettled, closeSettled }, { creates: 1, stops: 1, scanSettled: false, closeSettled: false });
                stopped.resolve();
                await cacheStarted.promise;
                await turn();
                assert.equal(creates, 1);
                assert.equal(scanSettled, false);
                assert.equal(closeSettled, false);
            } finally {
                stopped.resolve();
                invalidated.resolve();
                await Promise.all(clears);
            }
            assert.deepEqual(await clears[0], { entryCount: 1, totalBytes: 7 });
            const outcome = await scan;
            if (permanentShutdown) {
                await closing;
                assert.match(outcome.error.message, /disposed/);
                assert.equal(creates, 1);
            } else {
                assert.deepEqual(outcome.value, { rootFile: 'again.k' });
                assert.equal(creates, 2);
            }
            await loader.dispose();
        });
    }

    it('waits for a failed pool to exit when clear races with recovery', async () => {
        const stopped = gate(), stopStarted = gate(), invalidated = gate(), cacheStarted = gate();
        let creates = 0, stops = 0;
        const loader = createProjectIndexLoader({
            fileScanCacheDirectory: path.resolve('injected-cache'),
            createPool() {
                creates += 1;
                const first = creates === 1;
                let retired = false;
                return {
                    async buildProjectIndex(rootFile) {
                        if (first) { retired = true; throw new Error('scan failed'); }
                        return { rootFile };
                    },
                    isDisposed: () => retired,
                    async dispose() { stops += 1; stopStarted.resolve(); await stopped.promise; },
                };
            },
            createFileScanCache: () => ({ async invalidateAll() {
                cacheStarted.resolve(); await invalidated.promise; return { entryCount: 0, totalBytes: 0 };
            } }),
        });
        await assert.rejects(loader.buildProjectIndex('main.k'), /scan failed/);
        const recovering = loader.buildProjectIndex('again.k');
        await turn();
        assert.equal(stops, 1);
        await stopStarted.promise;
        const clearing = loader.clearPersistentCache();
        try {
            stopped.resolve();
            await cacheStarted.promise;
            await turn();
            assert.equal(creates, 1);
            assert.equal(stops, 1);
        } finally {
            stopped.resolve(); invalidated.resolve(); await clearing;
        }
        assert.deepEqual(await recovering, { rootFile: 'again.k' });
        assert.equal(creates, 2);
        await loader.dispose();
    });

    it('clears real scan-cache files only after the Node worker exit event', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-worker-stop-'));
        const rootFile = path.join(directory, 'main.k'), cacheDirectory = path.join(directory, 'cache');
        const deck = '*KEYWORD\n*PART\npart\n1,1,1\n*END\n';
        const workers = [];
        let exits = 0, cacheClears = 0;
        fs.writeFileSync(rootFile, deck);
        const loader = createProjectIndexLoader({
            workerPath: path.resolve('out/worker/scanWorker.js'),
            fileScanCacheDirectory: cacheDirectory,
            createPool: options => createWorkerPool({ ...options, workerFactory(workerPath, workerOptions) {
                const worker = new Worker(workerPath, workerOptions);
                workers.push(worker);
                worker.on('exit', () => { exits += 1; });
                return worker;
            } }),
            createFileScanCache(options) {
                assert.equal(exits, workers.length);
                cacheClears += 1;
                return createFileScanCacheStore(options);
            },
        });
        try {
            const first = await loader.buildProjectIndex(rootFile);
            const generations = (await loader.getEntityIndexStats()).sqlite.generations;
            assert.ok(generations >= 1);
            assert.equal(fs.existsSync(path.join(cacheDirectory, 'file-scan-index.json')), false);
            const removed = await loader.clearPersistentCache();
            assert.ok(removed.entityIndex.cleared.removed >= generations);
            assert.equal(removed.entityIndex.sqlite.generations, 0);
            assert.equal(removed.entryCount, 0);
            assert.equal(cacheClears, 1);
            assert.equal(exits, 1);
            assert.equal((await createFileScanCacheStore({ cacheDirectory }).getStatsAsync()).entryCount, 0);
            const second = await loader.buildProjectIndex(rootFile);
            assert.deepEqual(second.keywordMap, first.keywordMap);
            await Promise.all([loader.dispose(), loader.dispose()]);
            assert.equal(workers.length, 2);
            assert.equal(exits, 2);
            assert.equal(fs.readFileSync(rootFile, 'utf8'), deck);
        } finally {
            await Promise.all(workers.map(worker => worker.terminate()));
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }).timeout(20_000);
});
