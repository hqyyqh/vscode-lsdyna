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

    it('updates the manifest store when caching, touching, and invalidating snapshots', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const { createCacheManifestStore } = require('../../../src/core/cache/cacheManifestStore');
        const rootFile = path.resolve('project', 'main.k');
        const childFile = path.resolve('project', 'child.key');
        const manifestStore = createCacheManifestStore();
        const client = createIndexClient({
            buildProjectIndex: async () => ({ rootFile, files: [rootFile, childFile] }),
            getFileSignature: async () => ({ mtimeMs: 10, size: 100 }),
            estimateSnapshotSize: () => 24,
            manifestStore,
        });

        await client.loadProjectSnapshot(rootFile);
        const initialEntry = manifestStore.get(rootFile);
        assert.equal(initialEntry.byteSize, 24);
        assert.equal(initialEntry.trackedFileCount, 2);
        assert.deepEqual(initialEntry.trackedFiles, [rootFile, childFile]);

        await client.loadProjectSnapshot(rootFile);
        const touchedEntry = manifestStore.get(rootFile);
        assert.ok(touchedEntry.lastAccessedAt > initialEntry.lastAccessedAt);

        client.invalidate(rootFile);
        assert.equal(manifestStore.get(rootFile), null);
    });

    it('rebuilds instead of restoring stale manifest entries when invalidated during cache validation', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const { createCacheManifestStore } = require('../../../src/core/cache/cacheManifestStore');
        const rootFile = path.resolve('project', 'main.k');
        const manifestStore = createCacheManifestStore();
        const signatures = [{ mtimeMs: 10, size: 100 }];
        const snapshots = [
            { rootFile, files: [rootFile], version: 1 },
            { rootFile, files: [rootFile], version: 2 },
        ];
        let buildCount = 0;
        let validationDeferred;
        let validateAsync = false;
        const client = createIndexClient({
            buildProjectIndex: async () => snapshots[buildCount++],
            getFileSignature: async () => {
                if (!validateAsync) return signatures[0];
                return new Promise(resolve => {
                    validationDeferred = () => resolve(signatures[0]);
                });
            },
            manifestStore,
        });

        assert.strictEqual(await client.loadProjectSnapshot(rootFile), snapshots[0]);

        validateAsync = true;
        const pendingLoad = client.loadProjectSnapshot(rootFile);
        while (!validationDeferred) {
            await new Promise(resolve => setImmediate(resolve));
        }

        client.invalidate(rootFile);
        validateAsync = false;
        validationDeferred();

        const refreshedSnapshot = await pendingLoad;
        assert.strictEqual(refreshedSnapshot, snapshots[1]);
        assert.equal(buildCount, 2);
        assert.deepEqual(manifestStore.get(rootFile), {
            rootFile,
            trackedFiles: [rootFile],
            trackedFileCount: 1,
            byteSize: Buffer.byteLength(JSON.stringify(snapshots[1]), 'utf8'),
            lastAccessedAt: 2,
        });
    });

    it('persists successful fresh snapshots to the disk cache without affecting the returned snapshot', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const rootFile = path.resolve('project', 'main.k');
        const childFile = path.resolve('project', 'child.key');
        const snapshot = { rootFile, files: [rootFile, childFile], version: 1 };
        const persistCalls = [];
        const client = createIndexClient({
            buildProjectIndex: async () => snapshot,
            getFileSignature: async (filePath) => (
                filePath === rootFile
                    ? { mtimeMs: 10, size: 100 }
                    : { mtimeMs: 20, size: 200 }
            ),
            persistentCache: {
                async persist(entry) {
                    persistCalls.push(entry);
                },
            },
        });

        assert.strictEqual(await client.loadProjectSnapshot(rootFile), snapshot);
        assert.equal(persistCalls.length, 1);
        assert.strictEqual(persistCalls[0].snapshot, snapshot);
        assert.deepEqual(persistCalls[0].trackedFiles, [
            { filePath: rootFile, signature: { mtimeMs: 10, size: 100 } },
            { filePath: childFile, signature: { mtimeMs: 20, size: 200 } },
        ]);
    });

    it('does not block fresh snapshot resolution on disk persistence', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const rootFile = path.resolve('project', 'main.k');
        const snapshot = { rootFile, files: [rootFile], version: 1 };
        let persistStarted = false;
        let releasePersist;
        const client = createIndexClient({
            buildProjectIndex: async () => snapshot,
            getFileSignature: async () => ({ mtimeMs: 10, size: 100 }),
            persistentCache: {
                persist() {
                    persistStarted = true;
                    return new Promise(resolve => {
                        releasePersist = resolve;
                    });
                },
            },
        });

        let resolvedSnapshot = null;
        const pendingLoad = client.loadProjectSnapshot(rootFile).then(result => {
            resolvedSnapshot = result;
            return result;
        });

        while (!persistStarted) {
            await new Promise(resolve => setImmediate(resolve));
        }
        await new Promise(resolve => setImmediate(resolve));

        assert.strictEqual(resolvedSnapshot, snapshot);
        releasePersist();
        assert.strictEqual(await pendingLoad, snapshot);
    });

    it('ignores disk cache persistence failures and keeps the in-memory snapshot', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const rootFile = path.resolve('project', 'main.k');
        const snapshot = { rootFile, files: [rootFile], version: 1 };
        let buildCount = 0;
        const client = createIndexClient({
            buildProjectIndex: async () => {
                buildCount += 1;
                return snapshot;
            },
            getFileSignature: async () => ({ mtimeMs: 10, size: 100 }),
            persistentCache: {
                async persist() {
                    throw new Error('disk write failed');
                },
            },
        });

        assert.strictEqual(await client.loadProjectSnapshot(rootFile), snapshot);
        assert.strictEqual(await client.loadProjectSnapshot(rootFile), snapshot);
        assert.equal(buildCount, 1);
    });

    it('restores valid snapshots from the disk cache on L1 miss', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const rootFile = path.resolve('project', 'main.k');
        const childFile = path.resolve('project', 'child.key');
        const snapshot = { rootFile, files: [rootFile, childFile], version: 1 };
        const trackedFiles = [
            { filePath: rootFile, signature: { mtimeMs: 10, size: 100 } },
            { filePath: childFile, signature: { mtimeMs: 20, size: 200 } },
        ];
        let buildCount = 0;
        let restoreCount = 0;
        const client = createIndexClient({
            buildProjectIndex: async () => {
                buildCount += 1;
                return snapshot;
            },
            getFileSignature: async (filePath) => (
                filePath === rootFile
                    ? { mtimeMs: 10, size: 100 }
                    : { mtimeMs: 20, size: 200 }
            ),
            persistentCache: {
                async restore(filePath) {
                    restoreCount += 1;
                    assert.equal(filePath, rootFile);
                    return { snapshot, trackedFiles };
                },
                async persist() {},
            },
        });

        const result = await client.loadProjectSnapshot(rootFile);
        assert.strictEqual(result, snapshot);
        assert.equal(restoreCount, 1);
        assert.equal(buildCount, 0);

        // Subsequent call hits L1 cache, no L2 restore or build
        const l1Result = await client.loadProjectSnapshot(rootFile);
        assert.strictEqual(l1Result, snapshot);
        assert.equal(restoreCount, 1);
        assert.equal(buildCount, 0);
    });

    it('falls back to buildProjectIndex when disk restore returns null', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const rootFile = path.resolve('project', 'main.k');
        const snapshot = { rootFile, files: [rootFile], version: 1 };
        let buildCount = 0;
        let restoreCount = 0;
        let persistCalls = [];
        const client = createIndexClient({
            buildProjectIndex: async () => {
                buildCount += 1;
                return snapshot;
            },
            getFileSignature: async () => ({ mtimeMs: 10, size: 100 }),
            persistentCache: {
                async restore() {
                    restoreCount += 1;
                    return null;
                },
                async persist(entry) {
                    persistCalls.push(entry);
                },
            },
        });

        const result = await client.loadProjectSnapshot(rootFile);
        assert.strictEqual(result, snapshot);
        assert.equal(restoreCount, 1);
        assert.equal(buildCount, 1);
        assert.equal(persistCalls.length, 1);
    });

    it('coalesces concurrent requests on L1 miss so that only one L2 restore is performed', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const rootFile = path.resolve('project', 'main.k');
        const snapshot = { rootFile, files: [rootFile], version: 1 };
        const trackedFiles = [{ filePath: rootFile, signature: { mtimeMs: 10, size: 100 } }];
        let restoreCount = 0;
        let restoreDeferred;
        const client = createIndexClient({
            buildProjectIndex: async () => {
                throw new Error('should not build');
            },
            getFileSignature: async () => ({ mtimeMs: 10, size: 100 }),
            persistentCache: {
                async restore() {
                    restoreCount += 1;
                    return new Promise(resolve => {
                        restoreDeferred = () => resolve({ snapshot, trackedFiles });
                    });
                },
                async persist() {},
            },
        });

        const load1 = client.loadProjectSnapshot(rootFile);
        const load2 = client.loadProjectSnapshot(rootFile);

        while (!restoreDeferred) {
            await new Promise(resolve => setImmediate(resolve));
        }
        restoreDeferred();

        const result1 = await load1;
        const result2 = await load2;

        assert.strictEqual(result1, snapshot);
        assert.strictEqual(result2, snapshot);
        assert.equal(restoreCount, 1);
    });

    it('handles disk restore failures gracefully by falling back to build', async () => {
        const { createIndexClient } = require('../../../src/client/services/indexClient');
        const rootFile = path.resolve('project', 'main.k');
        const snapshot = { rootFile, files: [rootFile], version: 1 };
        let buildCount = 0;
        let restoreCount = 0;
        const client = createIndexClient({
            buildProjectIndex: async () => {
                buildCount += 1;
                return snapshot;
            },
            getFileSignature: async () => ({ mtimeMs: 10, size: 100 }),
            persistentCache: {
                async restore() {
                    restoreCount += 1;
                    throw new Error('disk read error');
                },
                async persist() {},
            },
        });

        const result = await client.loadProjectSnapshot(rootFile);
        assert.strictEqual(result, snapshot);
        assert.equal(restoreCount, 1);
        assert.equal(buildCount, 1);
    });
});
