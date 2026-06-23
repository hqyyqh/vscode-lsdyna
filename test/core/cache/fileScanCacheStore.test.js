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
});
