'use strict';
const assert = require('node:assert/strict'), path = require('node:path'), os = require('node:os');
const { EntityIndexStore } = require('../../../out/core/cache/entityIndexStore');
const { SqliteFileScanCache } = require('../../../out/core/cache/sqliteFileScanCache');
describe('Shared SQLite physical file facts', function() {
    this.timeout(15000);
    let store;
    afterEach(async () => { await store?.close(); });
    const temporary = require('../../support/tempDirectories').trackTempDirectories();
    it('shares structure across type variants and restores ordered facts after reopening', async () => {
        const root = temporary(path.join(os.tmpdir(), 'file-facts-')), file = path.join(root, 'model.k');
        store = await EntityIndexStore.open(root);
        let cache = new SqliteFileScanCache(async () => store);
        const signature = { size: 100, mtimeMs: 1, sourceRevision: 'one' };
        const structure = { filePath: file, structureOptionsKey: 'structure', keywordBlocks:
            Array.from({ length: 450 }, (_, startLine) => ({ keyword: '*NODE', startLine })),
            parameterEvents: [], nativeReadEvents: [{ lineIndex: 0, value: 'context' }], includeEntries: [],
            largeFileLineMap: { stride: 100, offsets: [0, 10, 20] } };
        const make = kind => ({ filePath: file, scanOptionsKey: kind, includeEntries: [], searchPaths: [],
            keywords: require('../../../out/core/project/projectIndexer').keywordsFromFileIndex(structure), fileIndex: { ...structure,
            referenceDefinitions: { genericDefinitions: [{ id: kind }] }, registryReferences: { complete: false, reasons: ['unknown'], referenceOccurrences: [] } } });
        await cache.set(file, signature, make('curve'));
        await cache.set(file, signature, make('part'));
        assert.equal((await store.stats()).generations, 3);
        await store.close(); store = await EntityIndexStore.open(root);
        cache = new SqliteFileScanCache(async () => store);
        for (const scanOptionsKey of ['curve', 'part']) assert.deepEqual(await cache.get(file, signature,
            { scanOptionsKey, structureOptionsKey: 'structure' }), make(scanOptionsKey));
        const only = await cache.get(file, signature, { structureOnly: true, structureOptionsKey: 'structure' });
        assert.deepEqual(only.fileIndex, structure);
        assert.equal(await cache.get(file, { ...signature, sourceRevision: 'replaced-same-size' }, { structureOnly: true, structureOptionsKey: 'structure' }), null);
        assert.equal(await cache.get(file, signature, { scanOptionsKey: 'node', structureOptionsKey: 'structure' }), null);
    });
    it('does not publish a cancelled file build or restore beyond the memory budget', async () => {
        const root = temporary(path.join(os.tmpdir(), 'file-facts-budget-')), file = path.join(root, 'model.k');
        store = await EntityIndexStore.open(root);
        const cache = new SqliteFileScanCache(async () => store, 1024);
        const signature = { size: 100, mtimeMs: 1, sourceRevision: 'one' };
        const scan = { filePath: file, fileIndex: { structureOptionsKey: 'structure', keywordBlocks: Array(200).fill({ keyword: '*NODE' }) } };
        await assert.rejects(cache.set(file, signature, scan, { structureOnly: true }), /budget/);
        assert.equal((await store.stats()).generations, 0);
        await assert.rejects(cache.set(file, signature, scan, { cancellationToken: { isCancellationRequested: true } }), { name: 'CancellationError' });
    });

    it('restores large scalar arrays across bounded database pages without expanding call arguments', async () => {
        const root = temporary(path.join(os.tmpdir(), 'file-facts-pages-')), file = path.join(root, 'model.k');
        store = await EntityIndexStore.open(root);
        const cache = new SqliteFileScanCache(async () => store);
        const signature = { size: 100, mtimeMs: 1, sourceRevision: 'one' };
        const offsets = Array.from({ length: 300000 }, (_, index) => index * 100);
        const fileIndex = { filePath: file, structureOptionsKey: 'structure', keywordBlocks: [],
            largeFileLineMap: { stride: 100, offsets } };
        await cache.set(file, signature, { fileIndex }, { structureOnly: true });
        const restored = await cache.get(file, signature, { structureOnly: true, structureOptionsKey: 'structure' });
        assert.deepEqual(restored.fileIndex.largeFileLineMap.offsets, offsets);
    });
});
