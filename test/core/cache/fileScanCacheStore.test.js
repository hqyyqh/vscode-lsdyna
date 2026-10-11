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

    it('persists strong source revisions and rejects a replacement with unchanged size and mtime', async () => {
        const file = path.resolve('model.k'), signature = { mtimeMs: 1, size: 10, sourceRevision: 'file-identity-a' };
        const first = createFileScanCacheStore({ cacheDirectory: tempDir });
        await first.set(file, signature, { keywords: [] });
        const reopened = createFileScanCacheStore({ cacheDirectory: tempDir });
        assert.deepEqual(await reopened.get(file, signature), { keywords: [] });
        assert.equal(await reopened.get(file, { ...signature, sourceRevision: 'file-identity-b' }), null);
    });

    it('rejects an index payload path outside its scan directory without touching that file', async () => {
        const file = path.resolve('project/main.k');
        const signature = { mtimeMs: 1, size: 1 };
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        await store.set(file, signature, { keywords: [] });
        const outside = path.join(tempDir, 'outside.json');
        const sentinel = 'file outside the scan directory';
        fs.writeFileSync(outside, sentinel);
        const indexPath = path.join(tempDir, 'file-scan-index.json');
        const index = JSON.parse(fs.readFileSync(indexPath));
        Object.values(index.entries)[0].payloadFile = '../outside.json';
        fs.writeFileSync(indexPath, JSON.stringify(index));
        const restored = createFileScanCacheStore({ cacheDirectory: tempDir });
        assert.equal(await restored.get(file, signature), null);
        assert.equal(fs.readFileSync(outside, 'utf8'), sentinel);
        assert.equal((await restored.getStats()).entryCount, 0);
    });

    for (const identity of ['lspp-handoff', 'reference-policy']) it(`discards scan results with a different ${identity}`, async () => {
        const { FILE_SCAN_CACHE_SCHEMA_VERSION } = require('../../../src/core/cache/fileScanCacheStore');
        const previousVersion = FILE_SCAN_CACHE_SCHEMA_VERSION.replace(new RegExp(`:${identity}-[^:]+`), '');
        assert.notEqual(previousVersion, FILE_SCAN_CACHE_SCHEMA_VERSION);
        const signature = { mtimeMs: 1000, size: 500 };
        const oldStore = createFileScanCacheStore({ cacheDirectory: tempDir, schemaVersion: previousVersion });
        await oldStore.set('/project/relations.k', signature, { keywords: [] });
        const currentStore = createFileScanCacheStore({ cacheDirectory: tempDir });
        assert.equal(await currentStore.get('/project/relations.k', signature), null);
    });

    it('discards results from a different native Ford feature profile', async () => {
        const { FILE_SCAN_CACHE_SCHEMA_VERSION } = require('../../../src/core/cache/fileScanCacheStore');
        const otherProfile = FILE_SCAN_CACHE_SCHEMA_VERSION.replace(/:native-ford-([01])/, (_match, value) =>
            ':native-ford-' + (value === '1' ? '0' : '1'));
        assert.notEqual(otherProfile, FILE_SCAN_CACHE_SCHEMA_VERSION);
        const signature = { mtimeMs: 1000, size: 500 };
        const oldStore = createFileScanCacheStore({ cacheDirectory: tempDir, schemaVersion: otherProfile });
        await oldStore.set('/project/user-material.k', signature, { keywords: [] });
        assert.equal(await createFileScanCacheStore({ cacheDirectory: tempDir }).get('/project/user-material.k', signature), null);
    });

    it('reclaims orphan payloads even when the index is missing', async () => {
        const payloads = path.join(tempDir, 'file-scans');
        fs.mkdirSync(payloads);
        fs.writeFileSync(path.join(payloads, 'orphan.json'), 'orphan');
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        assert.equal(await store.get('/project/missing.k', { mtimeMs: 1, size: 1 }), null);
        assert.deepEqual(fs.readdirSync(payloads), []);
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

    it('rejects version 16 short-record indexes and persists the current incomplete record', async () => {
        const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
        const filePath = path.join(tempDir, 'short-record.k');
        fs.writeFileSync(filePath, '*DEFINE_CURVE\n17\n0,1\n2,3\n4\n*END');
        const current = { fileIndex: await buildFileIndex(filePath) };
        const legacy = structuredClone(current);
        legacy.fileIndex.scannerVersion = 16;
        legacy.fileIndex.referenceDefinitions.curves[0].points.pop();
        legacy.fileIndex.referenceDefinitions.curves[0].dataCompleteness = { state: 'complete', reasons: [] };
        const signature = { mtimeMs: 1000, size: 500 };
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        await store.set(filePath, signature, legacy);
        assert.equal(await store.get(filePath, signature), null);
        await store.set(filePath, signature, current);
        const cached = await store.get(filePath, signature);
        const curve = cached.fileIndex.referenceDefinitions.curves[0];
        assert.equal(curve.points.length, 3);
        assert.equal(curve.points[2].y, null);
        assert.equal(curve.dataCompleteness.state, 'incomplete');
    });

    it('rejects version 17 cached numeric labels after the reference parser correction', async () => {
        const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
        const filePath = path.join(tempDir, 'numeric-label.k');
        fs.writeFileSync(filePath, '*PART\nOriginal cache fixture\n1,0,0.0,0,0,0,0,0\n*END');
        const current = { fileIndex: await buildFileIndex(filePath) };
        const legacy = structuredClone(current);
        legacy.fileIndex.scannerVersion = 17;
        legacy.fileIndex.registryReferences.referenceOccurrences.push({
            fieldName: 'MID', referenceValue: { kind: 'label', id: '0.0', raw: '0.0' },
        });
        const signature = { mtimeMs: 1000, size: 500 };
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        await store.set(filePath, signature, legacy);
        assert.equal(await store.get(filePath, signature), null);
        await store.set(filePath, signature, current);
        const cached = await store.get(filePath, signature);
        assert.deepEqual(cached, current);
        assert.ok(!cached.fileIndex.registryReferences.referenceOccurrences.some(item =>
            item.referenceValue?.kind === 'label' && item.referenceValue.id === '0.0'));
    });

    it('returns null for unknown files', async () => {
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        const retrieved = await store.get('/unknown.k', { mtimeMs: 1000, size: 100 });
        assert.equal(retrieved, null);
    });

    it('rejects version 18 expression scans that falsely claimed complete reference coverage', async () => {
        const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
        const filePath = path.join(tempDir, 'expression.k');
        fs.writeFileSync(filePath, '*LOAD_BODY_Z\n<17>,9806,0,0,0,0,0\n*END');
        const current = { fileIndex: await buildFileIndex(filePath) };
        const legacy = structuredClone(current);
        legacy.fileIndex.scannerVersion = 18;
        legacy.fileIndex.registryReferences.referenceCoverage = { complete: true, gaps: [] };
        legacy.fileIndex.registryReferences.valueDomainOccurrences.find(item =>
            item.fieldName === 'LCID').semantic = { state: 'non-reference', role: 'unparsed-input' };
        const signature = { mtimeMs: 1000, size: 500 };
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        await store.set(filePath, signature, legacy);
        assert.equal(await store.get(filePath, signature), null);
        await store.set(filePath, signature, current);
        const cached = await store.get(filePath, signature);
        assert.deepEqual(cached, current);
        assert.ok(cached.fileIndex.registryReferences.referenceCoverage.gaps.some(gap =>
            gap.reason === 'parameter-expression-unresolved' && gap.targetKinds.includes('curve')));
    });

    it('rejects version 19 scans that split function arguments into later fields', async () => {
        const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
        const filePath = path.join(tempDir, 'expression-arguments.k');
        fs.writeFileSync(filePath, '*LOAD_BODY_Z\n<min(CID,17)>,9806,0,0,0,0,0\n*END');
        const current = { fileIndex: await buildFileIndex(filePath) };
        const legacy = structuredClone(current);
        legacy.fileIndex.scannerVersion = 19;
        legacy.fileIndex.registryReferences.referenceCoverage = { complete: true, gaps: [] };
        const signature = { mtimeMs: 1000, size: 500 };
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        await store.set(filePath, signature, legacy);
        assert.equal(await store.get(filePath, signature), null);
        await store.set(filePath, signature, current);
        assert.deepEqual(await store.get(filePath, signature), current);
        assert.equal(current.fileIndex.registryReferences.valueDomainOccurrences.find(item =>
            item.fieldName === 'LCID').rawValue, '<min(CID,17)>');
        assert.equal(current.fileIndex.registryReferences.referenceOccurrences.some(item =>
            item.referenceValue?.id === 9806), false);
    });

    it('rejects version 20 caches that silently omitted missing blocker coverage', async () => {
        const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
        const filePath = path.join(tempDir, 'missing-blockers.k');
        fs.writeFileSync(filePath, '*PART\nOriginal blocker cache fixture\n1,0,17,0,0,0,<ADPOPT>,0\n*END');
        const current = { fileIndex: await buildFileIndex(filePath) };
        assert.equal(current.fileIndex.registryReferences.referenceCoverage.complete, false);
        const legacy = structuredClone(current);
        legacy.fileIndex.scannerVersion = 20;
        legacy.fileIndex.registryReferences.complete = true;
        legacy.fileIndex.registryReferences.reasons = [];
        legacy.fileIndex.registryReferences.referenceCoverage = { complete: true, gaps: [] };
        const signature = { mtimeMs: 1000, size: 500 };
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        await store.set(filePath, signature, legacy);
        assert.equal(await store.get(filePath, signature), null);
        await store.set(filePath, signature, current);
        assert.deepEqual(await store.get(filePath, signature), current);
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

    it('rejects version 21 reference scans and preserves the native MID rule after reopening', async () => {
        const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
        const { queryIndexedEntityId } = require('../../../src/core/references/indexedEntityQuery');
        const { FILE_SCAN_CACHE_SCHEMA_VERSION } = require('../../../src/core/cache/fileScanCacheStore');
        const { getSemanticRuntimeCatalogV2 } = require('../../../src/core/semantics/semanticRuntimeV2');
        assert.ok(FILE_SCAN_CACHE_SCHEMA_VERSION.includes(getSemanticRuntimeCatalogV2().status().datasetReleaseId));
        const filePath = path.join(tempDir, 'material.k');
        fs.writeFileSync(filePath, '*KEYWORD\n*PART\nTire tread\n1,1,2000101,0,0,0,0,0\n*MAT_ELASTIC\n2000101,1.829e-9,300,0.3\n*END');
        const current = { fileIndex: await buildFileIndex(filePath, { largeFileThresholdBytes: 0 }) };
        const signature = { mtimeMs: current.fileIndex.mtimeMs, size: current.fileIndex.size };
        const store = createFileScanCacheStore({ cacheDirectory: tempDir });
        for (const omitReference of [true, false]) {
            const legacy = structuredClone(current);
            legacy.fileIndex.scannerVersion = 21;
            if (omitReference) legacy.fileIndex.registryReferences.referenceOccurrences = [];
            else legacy.fileIndex.registryReferences.referenceOccurrences.find(item =>
                item.fieldName === 'MID' && item.targetKinds.includes('material')).sourceRuleId = 'lspp:71:PART:2:2';
            await store.set(filePath, signature, legacy);
            assert.equal(await store.get(filePath, signature), null);
        }
        await store.set(filePath, signature, current);
        const restored = await createFileScanCacheStore({ cacheDirectory: tempDir }).get(filePath, signature);
        assert.deepEqual(restored, current);
        const result = await queryIndexedEntityId({ id: 2000101, targetKind: 'material', snapshot: {
            rootFile: filePath, scope: 'single-file', files: [filePath],
            graph: { includeOccurrences: [], includeOccurrencesComplete: true },
            fileIndexes: new Map([[filePath, restored.fileIndex]]),
        } });
        const reference = result.locations.find(item => item.role === 'reference');
        assert.equal(reference.line, 3);
        assert.equal(reference.fieldName, 'MID');
        assert.ok(reference.sourceRuleId.startsWith('lspp:'));
        assert.equal(result.state, 'complete', JSON.stringify(result.reasons));
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
