'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createFileScanCacheStore } = require('../../../src/core/cache/fileScanCacheStore');

describe('createFileScanCacheStore', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-scan-cache-'));
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('stores and retrieves scan results by file path and signature', async () => {
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        const filePath = '/project/test.k';
        const signature = { mtimeMs: 1000, size: 500 };
        const scanResult = {
            filePath,
            keywords: [{ keyword: 'PART', filePath, lineIndex: 0 }],
            includeEntries: [{ fileName: 'child.k', lineIndex: 1, startChar: 0, endChar: 7 }],
            searchPaths: ['/project'],
        };

        await store.set(filePath, signature, scanResult);
        const retrieved = await store.get(filePath, signature);

        assert.deepEqual(retrieved, scanResult);
        assert.equal(store.getStats().entryCount, 1);
    });

    it('returns null for stale signatures', async () => {
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        const filePath = '/project/test.k';
        const signature = { mtimeMs: 1000, size: 500 };
        const scanResult = { filePath, keywords: [], includeEntries: [], searchPaths: [] };

        await store.set(filePath, signature, scanResult);

        const staleSignature = { mtimeMs: 2000, size: 500 };
        const retrieved = await store.get(filePath, staleSignature);

        assert.equal(retrieved, null);
    });

    it('returns null for cached file indexes with a stale scanner version', async () => {
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        const filePath = '/project/versioned.k';
        const signature = { mtimeMs: 1000, size: 500 };
        const scanResult = {
            filePath,
            fileIndex: {
                filePath,
                scannerVersion: 0,
                keywordBlocks: [],
                includeEntries: [],
                searchPaths: ['/project'],
            },
            keywords: [],
            includeEntries: [],
            searchPaths: ['/project'],
        };

        await store.set(filePath, signature, scanResult);
        const retrieved = await store.get(filePath, signature);

        assert.equal(retrieved, null);
    });

    it('returns null for unknown files', async () => {
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        const retrieved = await store.get('/unknown.k', { mtimeMs: 1000, size: 100 });
        assert.equal(retrieved, null);
    });

    it('persists data across store instances (cross-session)', async () => {
        const store1 = createFileScanCacheStore({ cacheDirectory: tempDir });
        const filePath = '/project/persist.k';
        const signature = { mtimeMs: 3000, size: 1000 };
        const scanResult = { filePath, keywords: [{ keyword: 'NODE', filePath, lineIndex: 5 }], includeEntries: [], searchPaths: ['/project'] };

        await store1.set(filePath, signature, scanResult);

        // Create a new store instance pointing to the same directory (simulating session restart)
        const store2 = createFileScanCacheStore({ cacheDirectory: tempDir });
        const retrieved = await store2.get(filePath, signature);

        assert.deepEqual(retrieved, scanResult);
    });

    it('invalidates a single file entry', async () => {
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        const filePath = '/project/inv.k';
        const signature = { mtimeMs: 1000, size: 500 };

        await store.set(filePath, signature, { keywords: [] });
        await store.invalidate(filePath);

        const retrieved = await store.get(filePath, signature);
        assert.equal(retrieved, null);
        assert.equal(store.getStats().entryCount, 0);
    });

    it('invalidates all entries', async () => {
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });

        await store.set('/a.k', { mtimeMs: 1, size: 1 }, { keywords: [] });
        await store.set('/b.k', { mtimeMs: 2, size: 2 }, { keywords: [] });

        await store.invalidateAll();

        assert.equal(await store.get('/a.k', { mtimeMs: 1, size: 1 }), null);
        assert.equal(await store.get('/b.k', { mtimeMs: 2, size: 2 }), null);
        assert.equal(store.getStats().entryCount, 0);
    });

    it('handles corrupted payload gracefully', async () => {
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        const filePath = '/project/corrupt.k';
        const signature = { mtimeMs: 1000, size: 500 };

        await store.set(filePath, signature, { keywords: [] });

        // Corrupt the payload file
        const payloadDir = path.join(tempDir, 'file-scans');
        const files = fs.readdirSync(payloadDir);
        for (const f of files) {
            fs.writeFileSync(path.join(payloadDir, f), 'NOT JSON!!!', 'utf8');
        }

        const retrieved = await store.get(filePath, signature);
        assert.equal(retrieved, null);
    });

    it('evicts by persisted payload bytes and refreshes LRU order on reads', async () => {
        let tick = 0;
        const store = createFileScanCacheStore({
            cacheDirectory: tempDir,
            maxCacheBytes: 300,
            now: () => ++tick,
        });
        const signature = { mtimeMs: 1, size: 1 };
        const payload = marker => ({ marker, data: marker.repeat(100) });

        await store.set('/a.k', signature, payload('a'));
        await store.set('/b.k', signature, payload('b'));
        assert.deepEqual(await store.get('/a.k', signature), payload('a'));
        await store.set('/c.k', signature, payload('c'));

        assert.deepEqual(await store.get('/a.k', signature), payload('a'));
        assert.equal(await store.get('/b.k', signature), null);
        assert.deepEqual(await store.get('/c.k', signature), payload('c'));
        assert.ok(store.getStats().totalBytes <= 300);
        assert.equal(store.getStats().entryCount, 2);
    });

    it('expires idle entries at the configured age boundary', async () => {
        const signature = { mtimeMs: 10, size: 20 };
        const writer = createFileScanCacheStore({
            cacheDirectory: tempDir,
            maxEntryAgeMs: 100,
            now: () => 1000,
        });
        await writer.set('/aged.k', signature, { keywords: [] });

        const reader = createFileScanCacheStore({
            cacheDirectory: tempDir,
            maxEntryAgeMs: 100,
            now: () => 1100,
        });
        assert.equal(await reader.get('/aged.k', signature), null);
        assert.deepEqual(await reader.getStatsAsync(), { entryCount: 0, totalBytes: 0 });
        assert.deepEqual(fs.readdirSync(path.join(tempDir, 'file-scans')), []);
    });

    it('does not retain a payload larger than the hard byte budget', async () => {
        const store = createFileScanCacheStore({
            cacheDirectory: tempDir,
            maxCacheBytes: 1,
        });
        const signature = { mtimeMs: 1, size: 1 };

        await store.set('/oversize.k', signature, { data: 'too large' });

        assert.equal(await store.get('/oversize.k', signature), null);
        assert.deepEqual(store.getStats(), { entryCount: 0, totalBytes: 0 });
    });

    it('drops incompatible cache identities instead of leaving orphan payloads', async () => {
        const signature = { mtimeMs: 1, size: 1 };
        const writer = createFileScanCacheStore({
            cacheDirectory: tempDir,
            schemaVersion: 'old-runtime',
        });
        await writer.set('/old.k', signature, { keywords: [] });

        const reader = createFileScanCacheStore({
            cacheDirectory: tempDir,
            schemaVersion: 'new-runtime',
        });
        assert.equal(await reader.get('/old.k', signature), null);
        assert.deepEqual(fs.readdirSync(path.join(tempDir, 'file-scans')), []);
    });

    it('reports entry and byte totals removed by invalidateAll', async () => {
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        await store.set('/a.k', { mtimeMs: 1, size: 1 }, { keywords: [] });
        await store.set('/b.k', { mtimeMs: 2, size: 2 }, { keywords: [] });
        const before = store.getStats();

        const removed = await store.invalidateAll();

        assert.deepEqual(removed, before);
        assert.deepEqual(store.getStats(), { entryCount: 0, totalBytes: 0 });
    });

    it('reconciles payload sizes before enforcing a lower cross-session budget', async () => {
        const signature = { mtimeMs: 1, size: 1 };
        const writer = createFileScanCacheStore({ cacheDirectory: tempDir });
        await writer.set('/reconcile.k', signature, { data: 'larger than one byte' });
        const indexPath = path.join(tempDir, 'file-scan-index.json');
        const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        Object.values(index.entries)[0].byteSize = 0;
        fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8');

        const reader = createFileScanCacheStore({ cacheDirectory: tempDir, maxCacheBytes: 1 });
        assert.equal(await reader.get('/reconcile.k', signature), null);
        assert.deepEqual(await reader.getStatsAsync(), { entryCount: 0, totalBytes: 0 });
    });
});
