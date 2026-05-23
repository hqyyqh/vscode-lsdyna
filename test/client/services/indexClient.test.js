'use strict';

const assert = require('assert');
const path = require('path');

describe('createIndexClient', () => {
    it('exposes loadProjectSnapshot as the shared snapshot entry point', async () => {
        let createIndexClient;
        try {
            ({ createIndexClient } = require('../../../src/client/services/indexClient'));
        } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
        }

        assert.equal(typeof createIndexClient, 'function');

        const rootFile = path.join('project', 'main.k');
        const snapshot = { rootFile: path.resolve(rootFile) };
        const client = createIndexClient({
            buildProjectIndex: async (rootFile) => {
                assert.equal(rootFile, snapshot.rootFile);
                return snapshot;
            },
        });

        assert.equal(typeof client.loadProjectSnapshot, 'function');
        assert.strictEqual(await client.loadProjectSnapshot(rootFile), snapshot);
    });

    it('reuses cached snapshots across normalized root aliases', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const canonicalRoot = path.resolve('project', 'main.k');
        const aliasedRoot = `${path.dirname(canonicalRoot)}${path.sep}.${path.sep}${path.basename(canonicalRoot)}`;
        const snapshot = { rootFile: canonicalRoot };
        const calls = [];
        const client = createIndexClient({
            buildProjectIndex: async (rootFile) => {
                calls.push(rootFile);
                return snapshot;
            },
            getFileSignature: async () => ({ mtimeMs: 10, size: 100 }),
        });

        assert.strictEqual(await client.loadProjectSnapshot(canonicalRoot), snapshot);
        assert.strictEqual(await client.loadProjectSnapshot(aliasedRoot), snapshot);
        assert.deepEqual(calls, [canonicalRoot]);
    });

    it('rebuilds cached snapshots after invalidation across normalized root aliases', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const canonicalRoot = path.resolve('project', 'main.k');
        const aliasedRoot = `${path.dirname(canonicalRoot)}${path.sep}.${path.sep}${path.basename(canonicalRoot)}`;
        const snapshots = [
            { rootFile: canonicalRoot, version: 1 },
            { rootFile: canonicalRoot, version: 2 },
        ];
        let callCount = 0;
        const client = createIndexClient({
            buildProjectIndex: async () => snapshots[callCount++],
            getFileSignature: async () => ({ mtimeMs: 10, size: 100 }),
        });

        assert.strictEqual(await client.loadProjectSnapshot(canonicalRoot), snapshots[0]);
        client.invalidate(aliasedRoot);
        assert.strictEqual(await client.loadProjectSnapshot(canonicalRoot), snapshots[1]);
        assert.equal(callCount, 2);
    });

    it('bypasses stale in-flight loads after invalidation', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const rootFile = path.resolve('project', 'main.k');
        const resolvers = [];
        let buildCount = 0;
        const client = createIndexClient({
            buildProjectIndex: async (rootPath) => new Promise(resolve => {
                buildCount += 1;
                const snapshot = { rootFile: rootPath, version: buildCount };
                resolvers.push(() => resolve(snapshot));
            }),
            getFileSignature: async () => ({ mtimeMs: 10, size: 100 }),
        });

        const staleLoad = client.loadProjectSnapshot(rootFile);
        client.invalidate(rootFile);
        const freshLoad = client.loadProjectSnapshot(rootFile);

        assert.equal(buildCount, 2);

        resolvers[0]();
        const staleSnapshot = await staleLoad;
        assert.equal(staleSnapshot.version, 1);

        const sharedFreshLoad = client.loadProjectSnapshot(rootFile);
        assert.equal(buildCount, 2);

        resolvers[1]();
        const freshSnapshot = await freshLoad;
        assert.equal(freshSnapshot.version, 2);
        assert.strictEqual(await sharedFreshLoad, freshSnapshot);
        assert.strictEqual(await client.loadProjectSnapshot(rootFile), freshSnapshot);
        assert.equal(buildCount, 2);
    });

    it('rebuilds cached snapshots when a tracked project file changes', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const rootFile = path.resolve('project', 'main.k');
        const childFile = path.resolve('project', 'child.key');
        const snapshots = [
            { rootFile, files: [rootFile, childFile], version: 1 },
            { rootFile, files: [rootFile, childFile], version: 2 },
        ];
        const signatures = new Map([
            [rootFile, { mtimeMs: 10, size: 100 }],
            [childFile, { mtimeMs: 10, size: 200 }],
        ]);
        let buildCount = 0;
        const client = createIndexClient({
            buildProjectIndex: async () => snapshots[buildCount++],
            getFileSignature: async (filePath) => signatures.get(filePath),
        });

        assert.strictEqual(await client.loadProjectSnapshot(rootFile), snapshots[0]);

        signatures.set(childFile, { mtimeMs: 20, size: 200 });

        assert.strictEqual(await client.loadProjectSnapshot(rootFile), snapshots[1]);
        assert.equal(buildCount, 2);
    });

    it('rebuilds cached snapshots when a tracked project file disappears', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const rootFile = path.resolve('project', 'main.k');
        const childFile = path.resolve('project', 'child.key');
        const snapshots = [
            { rootFile, files: [rootFile, childFile], version: 1 },
            { rootFile, files: [rootFile], version: 2 },
        ];
        const missing = new Error('ENOENT');
        missing.code = 'ENOENT';
        const signatures = new Map([
            [rootFile, { mtimeMs: 10, size: 100 }],
            [childFile, { mtimeMs: 10, size: 200 }],
        ]);
        let buildCount = 0;
        const client = createIndexClient({
            buildProjectIndex: async () => snapshots[buildCount++],
            getFileSignature: async (filePath) => {
                if (!signatures.has(filePath)) throw missing;
                return signatures.get(filePath);
            },
        });

        assert.strictEqual(await client.loadProjectSnapshot(rootFile), snapshots[0]);

        signatures.delete(childFile);

        assert.strictEqual(await client.loadProjectSnapshot(rootFile), snapshots[1]);
        assert.equal(buildCount, 2);
    });

    it('evicts the least recently used snapshot when the cache size limit is exceeded', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const roots = [
            path.resolve('project', 'a.k'),
            path.resolve('project', 'b.k'),
            path.resolve('project', 'c.k'),
        ];
        const buildCounts = new Map();
        const client = createIndexClient({
            buildProjectIndex: async (rootFile) => {
                buildCounts.set(rootFile, (buildCounts.get(rootFile) || 0) + 1);
                return { rootFile, files: [rootFile] };
            },
            getFileSignature: async () => ({ mtimeMs: 10, size: 100 }),
            estimateSnapshotSize: () => 10,
            maxSnapshotBytes: 20,
        });

        await client.loadProjectSnapshot(roots[0]);
        await client.loadProjectSnapshot(roots[1]);
        await client.loadProjectSnapshot(roots[0]);
        await client.loadProjectSnapshot(roots[2]);

        assert.equal(client.getCacheStats().cachedSnapshotCount, 2);
        assert.equal(client.getCacheStats().totalSnapshotBytes, 20);

        await client.loadProjectSnapshot(roots[1]);

        assert.equal(buildCounts.get(roots[0]), 1);
        assert.equal(buildCounts.get(roots[1]), 2);
        assert.equal(buildCounts.get(roots[2]), 1);
    });

    it('updates snapshot cache stats after invalidation', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const rootA = path.resolve('project', 'a.k');
        const rootB = path.resolve('project', 'b.k');
        const client = createIndexClient({
            buildProjectIndex: async (rootFile) => ({ rootFile, files: [rootFile] }),
            getFileSignature: async () => ({ mtimeMs: 10, size: 100 }),
            estimateSnapshotSize: () => 12,
            maxSnapshotBytes: 100,
        });

        await client.loadProjectSnapshot(rootA);
        await client.loadProjectSnapshot(rootB);
        assert.deepEqual(client.getCacheStats(), {
            cachedSnapshotCount: 2,
            totalSnapshotBytes: 24,
        });

        client.invalidate(rootA);

        assert.deepEqual(client.getCacheStats(), {
            cachedSnapshotCount: 1,
            totalSnapshotBytes: 12,
        });
    });
});
