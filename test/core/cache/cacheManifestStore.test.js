'use strict';

const assert = require('assert');
const path = require('path');

describe('createCacheManifestStore', () => {
    it('normalizes root aliases when storing and reading manifest entries', () => {
        const { createCacheManifestStore } = require('../../../src/core/cache/cacheManifestStore');
        const canonicalRoot = path.resolve('project', 'main.k');
        const aliasedRoot = `${path.dirname(canonicalRoot)}${path.sep}.${path.sep}${path.basename(canonicalRoot)}`;
        const manifestStore = createCacheManifestStore();

        manifestStore.upsert({
            rootFile: canonicalRoot,
            trackedFiles: [canonicalRoot, path.resolve('project', 'child.key')],
            byteSize: 42,
            lastAccessedAt: 7,
        });

        assert.deepEqual(manifestStore.get(aliasedRoot), {
            rootFile: canonicalRoot,
            trackedFiles: [canonicalRoot, path.resolve('project', 'child.key')],
            trackedFileCount: 2,
            byteSize: 42,
            lastAccessedAt: 7,
        });
    });

    it('lists manifest entries in most-recently-used order with aggregate stats', () => {
        const { createCacheManifestStore } = require('../../../src/core/cache/cacheManifestStore');
        const manifestStore = createCacheManifestStore();
        const rootA = path.resolve('project', 'a.k');
        const rootB = path.resolve('project', 'b.k');

        manifestStore.upsert({
            rootFile: rootA,
            trackedFiles: [rootA],
            byteSize: 12,
            lastAccessedAt: 1,
        });
        manifestStore.upsert({
            rootFile: rootB,
            trackedFiles: [rootB],
            byteSize: 20,
            lastAccessedAt: 3,
        });

        assert.deepEqual(manifestStore.list().map(entry => entry.rootFile), [rootB, rootA]);
        assert.deepEqual(manifestStore.getStats(), {
            entryCount: 2,
            totalBytes: 32,
        });
    });
});
