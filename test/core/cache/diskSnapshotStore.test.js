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
    it('persists and restores hydrated snapshots when tracked file signatures still match', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-disk-cache-'));
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

        try {
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
        } finally {
            fs.rmSync(cacheDirectory, { recursive: true, force: true });
        }
    });

    it('returns null and drops stale entries when tracked file signatures change', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-disk-cache-'));
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

        try {
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
        } finally {
            fs.rmSync(cacheDirectory, { recursive: true, force: true });
        }
    });

    it('isolates corrupted payload files without breaking other entries', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-disk-cache-'));
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

        try {
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
        } finally {
            fs.rmSync(cacheDirectory, { recursive: true, force: true });
        }
    });

    it('recovers from a corrupted index file and can persist again', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-disk-cache-'));
        const rootFile = path.resolve('project', 'main.k');
        const snapshot = createSnapshot(rootFile);
        const signatures = new Map(snapshot.files.map((filePath, index) => [
            filePath,
            { mtimeMs: index + 1, size: (index + 1) * 100 },
        ]));

        try {
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
        } finally {
            fs.rmSync(cacheDirectory, { recursive: true, force: true });
        }
    });

    it('evicts least recently used entries when the disk cache exceeds the byte budget', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const calibrationDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-disk-cache-calibration-'));
        const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-disk-cache-'));
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

        try {
            for (const snapshot of snapshots) {
                await store.persist({
                    snapshot,
                    trackedFiles: snapshot.files.map(filePath => ({ filePath, signature: signatures.get(filePath) })),
                });
            }

            assert.ok(store.getStats().totalBytes <= maxCacheBytes);
            assert.deepEqual(store.listEntries().map(entry => entry.rootFile), [roots[2], roots[1]]);
        } finally {
            fs.rmSync(calibrationDirectory, { recursive: true, force: true });
            fs.rmSync(cacheDirectory, { recursive: true, force: true });
        }
    });

    it('expires idle entries at the configured age boundary across sessions', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-disk-cache-age-'));
        const rootFile = path.resolve('project', 'aged.k');
        const snapshot = createSnapshot(rootFile);
        const signatures = new Map(snapshot.files.map((filePath, index) => [
            filePath,
            { mtimeMs: index + 1, size: index + 100 },
        ]));

        try {
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
        } finally {
            fs.rmSync(cacheDirectory, { recursive: true, force: true });
        }
    });

    it('does not retain a single snapshot larger than the hard byte budget', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-disk-cache-oversize-'));
        const rootFile = path.resolve('project', 'oversize.k');
        const snapshot = createSnapshot(rootFile);

        try {
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
        } finally {
            fs.rmSync(cacheDirectory, { recursive: true, force: true });
        }
    });

    it('clears all payloads atomically and reports the removed budget', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-disk-cache-clear-'));
        const rootFile = path.resolve('project', 'clear.k');
        const snapshot = createSnapshot(rootFile);

        try {
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
        } finally {
            fs.rmSync(cacheDirectory, { recursive: true, force: true });
        }
    });

    it('reconciles payload sizes before enforcing a lower cross-session budget', async () => {
        const { createDiskSnapshotStore } = require('../../../src/core/cache/diskSnapshotStore');
        const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-disk-cache-reconcile-'));
        const rootFile = path.resolve('project', 'reconcile.k');
        const snapshot = createSnapshot(rootFile);
        const signatures = new Map(snapshot.files.map(filePath => [filePath, { mtimeMs: 1, size: 1 }]));
        try {
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
        } finally {
            fs.rmSync(cacheDirectory, { recursive: true, force: true });
        }
    });
});
