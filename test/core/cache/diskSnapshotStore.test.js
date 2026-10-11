'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProjectGraph } = require('../../../src/core/project/projectGraph');

function createSnapshot(rootFile, childFile = path.resolve(path.dirname(rootFile), 'child.key')) {
    const graph = new ProjectGraph();
    graph.addIncludeEdge(rootFile, childFile);
    return {
        rootFile,
        files: [rootFile, childFile],
        graph,
        keywordMap: new Map([
            ['PART', [{ keyword: 'PART', filePath: childFile, lineIndex: 0 }]],
        ]),
        missingFiles: graph.missingFiles,
        cycles: graph.cycles,
        stats: { scannedFileCount: 2, reusedFileCount: 0 },
    };
}

describe('createDiskSnapshotStore', () => {
    const makeTemp = require('../../support/tempDirectories').trackTempDirectories();
    it('rejects an index payload path outside its payload directory without touching that file', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-path-'));
        const snapshot = createSnapshot(path.resolve('project/main.k'));
        const signatures = snapshot.files.map(filePath => ({ filePath, signature: { size: 1, mtimeMs: 1 } }));
        const store = createDiskSnapshotStore({ cacheDirectory });
        await store.persist({ snapshot, trackedFiles: signatures });
        const outside = path.join(cacheDirectory, 'outside.json');
        const sentinel = 'file outside the payload directory';
        fs.writeFileSync(outside, sentinel);
        const indexPath = path.join(cacheDirectory, 'index.json');
        const index = JSON.parse(fs.readFileSync(indexPath));
        index.entries[0].payloadFileName = '../outside.json';
        fs.writeFileSync(indexPath, JSON.stringify(index));
        const restored = createDiskSnapshotStore({ cacheDirectory });
        assert.equal(await restored.restore(snapshot.rootFile), null);
        assert.equal(fs.readFileSync(outside, 'utf8'), sentinel);
        assert.equal(restored.getStats().entryCount, 0);
    });

    it('reclaims payloads when the index is missing and cleans failed atomic writes', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-'));
        const payloads = path.join(cacheDirectory, 'payloads');
        const originalRename = fs.promises.rename;
        try {
            fs.mkdirSync(payloads);
            fs.writeFileSync(path.join(payloads, 'orphan.json'), 'orphan');
            const store = createDiskSnapshotStore({ cacheDirectory });
            assert.equal(await store.restore(path.resolve('missing.k')), null);
            assert.deepEqual(fs.readdirSync(payloads), []);
            fs.promises.rename = async (source, target) => {
                if (source.startsWith(cacheDirectory + path.sep)) throw Object.assign(new Error('Injected rename failure'), { code: 'EACCES' });
                return originalRename(source, target);
            };
            const snapshot = createSnapshot(path.resolve('main.k'));
            for (let i = 0; i < 3; i++) {
                await assert.rejects(store.persist({ snapshot, trackedFiles: snapshot.files.map(filePath => ({
                    filePath, signature: { mtimeMs: 1, size: 1 },
                })) }), /Injected rename failure/);
                assert.deepEqual(fs.readdirSync(payloads), []);
                assert.equal(fs.readdirSync(cacheDirectory).some(name => name.includes('.tmp-')), false);
            }
        } finally {
            fs.promises.rename = originalRename;
        }
    });

    it('rejects unsigned snapshots and drops payloads with incomplete dependency or root identities', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-identities-'));
        const snapshot = createSnapshot(path.resolve('project/main.k'));
        const trackedFiles = snapshot.files.map(filePath => ({ filePath, signature: { mtimeMs: 1, size: 1 } }));
        const store = createDiskSnapshotStore({ cacheDirectory, getFileSignature: async () => ({ mtimeMs: 1, size: 1 }) });
        for (const files of [[], trackedFiles.slice(1), trackedFiles.slice(0, 1)])
            await assert.rejects(store.persist({ snapshot, trackedFiles: files }), /signatures for all snapshot files/);
        for (const corrupt of [
            payload => { payload.trackedFiles = []; },
            payload => { payload.trackedFiles.shift(); },
            payload => { payload.trackedFiles.pop(); },
            payload => { payload.rootFile = path.resolve('other.k'); },
            payload => { payload.snapshot.rootFile = path.resolve('other.k'); },
        ]) {
            await store.persist({ snapshot, trackedFiles });
            assert.ok(await store.restore(snapshot.rootFile), 'valid control must restore');
            const file = path.join(cacheDirectory, 'payloads', store.listEntries()[0].payloadFileName);
            const payload = JSON.parse(fs.readFileSync(file));
            corrupt(payload);
            fs.writeFileSync(file, JSON.stringify(payload));
            assert.equal(await store.restore(snapshot.rootFile), null);
            assert.equal(store.getStats().entryCount, 0);
            assert.equal(fs.existsSync(file), false);
        }
    });

    it('persists and restores hydrated snapshots when tracked file signatures still match', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-'));
        const rootFile = path.resolve('project', 'main.k');
        const childFile = path.resolve('project', 'child.key');
        const snapshot = createSnapshot(rootFile, childFile);
        const signatures = new Map([
            [rootFile, { mtimeMs: 10, size: 100 }],
            [childFile, { mtimeMs: 20, size: 200 }],
        ]);
        const store = createDiskSnapshotStore({
            cacheDirectory,
            getFileSignature: async (filePath) => signatures.get(filePath),
            now: () => 1000,
        });

        {
            await store.persist({
                snapshot,
                trackedFiles: [
                    { filePath: rootFile, signature: signatures.get(rootFile) },
                    { filePath: childFile, signature: signatures.get(childFile) },
                ],
            });

            const restored = await store.restore(rootFile);
            assert.ok(restored.snapshot.keywordMap instanceof Map);
            assert.deepEqual(restored.snapshot.keywordMap.get('PART'), snapshot.keywordMap.get('PART'));
            assert.deepEqual(restored.snapshot.graph.toTree(rootFile), snapshot.graph.toTree(rootFile));
        }
    });

    it('returns null and drops stale entries when tracked file signatures change', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-'));
        const rootFile = path.resolve('project', 'main.k');
        const snapshot = createSnapshot(rootFile);
        const signatures = new Map(snapshot.files.map((filePath, index) => [
            filePath,
            { mtimeMs: index + 1, size: (index + 1) * 100 },
        ]));
        const store = createDiskSnapshotStore({
            cacheDirectory,
            getFileSignature: async (filePath) => signatures.get(filePath),
            now: () => 1000,
        });

        {
            await store.persist({
                snapshot,
                trackedFiles: snapshot.files.map(filePath => ({ filePath, signature: signatures.get(filePath) })),
            });

            signatures.set(snapshot.files[1], { mtimeMs: 999, size: 200 });

            assert.equal(await store.restore(rootFile), null);
            assert.deepEqual(store.getStats(), {
                entryCount: 0,
                totalBytes: 0,
            });
        }
    });

    it('isolates corrupted payload files without breaking other entries', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-'));
        const rootA = path.resolve('project', 'a.k');
        const rootB = path.resolve('project', 'b.k');
        const snapshotA = createSnapshot(rootA, path.resolve('project', 'a-child.key'));
        const snapshotB = createSnapshot(rootB, path.resolve('project', 'b-child.key'));
        const signatures = new Map([
            ...snapshotA.files.map((filePath, index) => [filePath, { mtimeMs: index + 1, size: (index + 1) * 100 }]),
            ...snapshotB.files.map((filePath, index) => [filePath, { mtimeMs: index + 11, size: (index + 1) * 200 }]),
        ]);
        const store = createDiskSnapshotStore({
            cacheDirectory,
            getFileSignature: async (filePath) => signatures.get(filePath),
            now: (() => {
                let tick = 0;
                return () => ++tick * 1000;
            })(),
        });

        {
            await store.persist({
                snapshot: snapshotA,
                trackedFiles: snapshotA.files.map(filePath => ({ filePath, signature: signatures.get(filePath) })),
            });
            await store.persist({
                snapshot: snapshotB,
                trackedFiles: snapshotB.files.map(filePath => ({ filePath, signature: signatures.get(filePath) })),
            });

            const entryA = store.listEntries().find(entry => entry.rootFile === rootA);
            fs.writeFileSync(path.join(cacheDirectory, 'payloads', entryA.payloadFileName), '{bad json', 'utf8');

            assert.equal(await store.restore(rootA), null);
            const restoredB = await store.restore(rootB);
            assert.equal(restoredB.snapshot.rootFile, rootB);
            assert.deepEqual(store.listEntries().map(entry => entry.rootFile), [rootB]);
        }
    });

    it('recovers from a corrupted index file and can persist again', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-'));
        const rootFile = path.resolve('project', 'main.k');
        const snapshot = createSnapshot(rootFile);
        const signatures = new Map(snapshot.files.map((filePath, index) => [
            filePath,
            { mtimeMs: index + 1, size: (index + 1) * 100 },
        ]));

        {
            fs.mkdirSync(cacheDirectory, { recursive: true });
            fs.writeFileSync(path.join(cacheDirectory, 'index.json'), '{bad json', 'utf8');

            const store = createDiskSnapshotStore({
                cacheDirectory,
                getFileSignature: async (filePath) => signatures.get(filePath),
                now: () => 1000,
            });

            assert.equal(await store.restore(rootFile), null);

            await store.persist({
                snapshot,
                trackedFiles: snapshot.files.map(filePath => ({ filePath, signature: signatures.get(filePath) })),
            });

            const restored = await store.restore(rootFile);
            assert.equal(restored.snapshot.rootFile, rootFile);
        }
    });

    it('evicts least recently used entries when the disk cache exceeds the byte budget', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const calibrationDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-calibration-'));
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-'));
        const roots = [
            path.resolve('project', 'a.k'),
            path.resolve('project', 'b.k'),
            path.resolve('project', 'c.k'),
        ];
        const snapshots = roots.map((rootFile, index) => createSnapshot(rootFile, path.resolve('project', `child-${index}.key`)));
        const signatures = new Map();
        for (const snapshot of snapshots) {
            for (const [index, filePath] of snapshot.files.entries()) {
                signatures.set(filePath, { mtimeMs: index + 1, size: (index + 1) * 100 });
            }
        }

        const calibrationStore = createDiskSnapshotStore({
            cacheDirectory: calibrationDirectory,
            getFileSignature: async (filePath) => signatures.get(filePath),
            now: () => 1000,
        });

        for (const snapshot of snapshots) {
            await calibrationStore.persist({
                snapshot,
                trackedFiles: snapshot.files.map(filePath => ({ filePath, signature: signatures.get(filePath) })),
            });
        }

        const sizes = calibrationStore.listEntries().map(entry => entry.byteSize);
        assert.equal(sizes.length, 3);
        const maxCacheBytes = Math.max(
            sizes[0] + sizes[1],
            sizes[0] + sizes[2],
            sizes[1] + sizes[2]
        );
        const nowValues = [1000, 2000, 3000];
        const store = createDiskSnapshotStore({
            cacheDirectory,
            getFileSignature: async (filePath) => signatures.get(filePath),
            now: () => nowValues.shift() || 4000,
            maxCacheBytes,
        });

        {
            for (const snapshot of snapshots) {
                await store.persist({
                    snapshot,
                    trackedFiles: snapshot.files.map(filePath => ({ filePath, signature: signatures.get(filePath) })),
                });
            }

            assert.ok(store.getStats().totalBytes <= maxCacheBytes);
            assert.deepEqual(store.listEntries().map(entry => entry.rootFile), [roots[2], roots[1]]);
        }
    });

    it('expires idle entries at the configured age boundary across sessions', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-age-'));
        const rootFile = path.resolve('project', 'aged.k');
        const snapshot = createSnapshot(rootFile);
        const signatures = new Map(snapshot.files.map((filePath, index) => [
            filePath,
            { mtimeMs: index + 1, size: index + 100 },
        ]));

        {
            const writer = createDiskSnapshotStore({
                cacheDirectory,
                getFileSignature: async filePath => signatures.get(filePath),
                maxEntryAgeMs: 100,
                now: () => 1000,
            });
            await writer.persist({
                snapshot,
                trackedFiles: snapshot.files.map(filePath => ({ filePath, signature: signatures.get(filePath) })),
            });

            const reader = createDiskSnapshotStore({
                cacheDirectory,
                getFileSignature: async filePath => signatures.get(filePath),
                maxEntryAgeMs: 100,
                now: () => 1100,
            });
            assert.equal(await reader.restore(rootFile), null);
            assert.deepEqual(reader.getStats(), { entryCount: 0, totalBytes: 0 });
            assert.deepEqual(fs.readdirSync(path.join(cacheDirectory, 'payloads')), []);
        }
    });

    it('does not retain a single snapshot larger than the hard byte budget', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-oversize-'));
        const rootFile = path.resolve('project', 'oversize.k');
        const snapshot = createSnapshot(rootFile);

        {
            const store = createDiskSnapshotStore({
                cacheDirectory,
                getFileSignature: async () => ({ mtimeMs: 1, size: 1 }),
                maxCacheBytes: 1,
            });
            await store.persist({
                snapshot,
                trackedFiles: snapshot.files.map(filePath => ({
                    filePath,
                    signature: { mtimeMs: 1, size: 1 },
                })),
            });

            assert.deepEqual(store.getStats(), { entryCount: 0, totalBytes: 0 });
            assert.equal(await store.restore(rootFile), null);
        }
    });

    it('clears all payloads atomically and reports the removed budget', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-clear-'));
        const rootFile = path.resolve('project', 'clear.k');
        const snapshot = createSnapshot(rootFile);

        {
            const store = createDiskSnapshotStore({
                cacheDirectory,
                getFileSignature: async () => ({ mtimeMs: 1, size: 1 }),
            });
            await store.persist({
                snapshot,
                trackedFiles: snapshot.files.map(filePath => ({
                    filePath,
                    signature: { mtimeMs: 1, size: 1 },
                })),
            });
            const before = store.getStats();
            const removed = await store.clear();

            assert.deepEqual(removed, before);
            assert.deepEqual(store.getStats(), { entryCount: 0, totalBytes: 0 });
            assert.deepEqual(fs.readdirSync(path.join(cacheDirectory, 'payloads')), []);
        }
    });

    it('reconciles payload sizes before enforcing a lower cross-session budget', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = makeTemp(path.join(os.tmpdir(), 'lsdyna-disk-cache-reconcile-'));
        const rootFile = path.resolve('project', 'reconcile.k');
        const snapshot = createSnapshot(rootFile);
        const signatures = new Map(snapshot.files.map(filePath => [filePath, { mtimeMs: 1, size: 1 }]));
        {
            const writer = createDiskSnapshotStore({
                cacheDirectory,
                getFileSignature: async filePath => signatures.get(filePath),
            });
            await writer.persist({
                snapshot,
                trackedFiles: snapshot.files.map(filePath => ({ filePath, signature: signatures.get(filePath) })),
            });
            const indexPath = path.join(cacheDirectory, 'index.json');
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            index.entries[0].byteSize = 0;
            fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8');

            const reader = createDiskSnapshotStore({
                cacheDirectory,
                getFileSignature: async filePath => signatures.get(filePath),
                maxCacheBytes: 1,
            });
            assert.equal(await reader.restore(rootFile), null);
            assert.deepEqual(reader.getStats(), { entryCount: 0, totalBytes: 0 });
        }
    });
});
