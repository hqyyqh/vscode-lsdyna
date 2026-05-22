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
});
