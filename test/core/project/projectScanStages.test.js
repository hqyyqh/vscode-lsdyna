const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createProjectIndexer } = require('../../../out/core/project/projectIndexer');
describe('project scan stages', function () {
    this.timeout(20000);
    let dir, root;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-stages-')); root = path.join(dir, 'main.k');
        fs.writeFileSync(root, '*INCLUDE\nchild.k\n'); fs.writeFileSync(path.join(dir, 'child.k'), '*MAT_ELASTIC\n         1       1.0       2.0       0.3\n'); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    it('publishes a complete structure before reference completion, with no semantic data in progress', async () => {
        const events = [];
        const result = await createProjectIndexer().buildProjectIndex(root, {}, event => events.push(event));
        const ready = events.find(e => e.type === 'structureReady');
        assert.ok(ready); assert.equal(ready.snapshot.phase, 'structure');
        assert.equal(ready.snapshot.files.length, 2); assert.equal(ready.snapshot.fileIndexes.size, 0);
        assert.equal(ready.snapshot.keywordMap.size, 0);
        assert.ok(events.findIndex(e => e.type === 'structureReady') < events.findIndex(e => e.phase === 'references'));
        for (const event of events.filter(e => e.type === 'progress')) assert.equal(event.fileIndexes, undefined);
        assert.ok([...result.fileIndexes.values()].every(i => i.registryReferences));
    });
    it('cancels after structure without returning a pseudo-complete reference snapshot', async () => {
        const token = { isCancellationRequested: false };
        let ready;
        await assert.rejects(createProjectIndexer().buildProjectIndex(root, { cancellationToken: token }, event => {
            if (event.type === 'structureReady') { ready = event.snapshot; token.isCancellationRequested = true; }
        }), e => e.name === 'CancellationError');
        assert.equal(ready.files.length, 2);
    });
    it('retries once when a file changes between stages', async () => {
        let changes = 0;
        const result = await createProjectIndexer().buildProjectIndex(root, {}, event => {
            if (event.type === 'structureReady' && !changes++) fs.appendFileSync(root, '$ external edit\n');
        });
        assert.equal(changes, 2);
        assert.equal(result.fileIndexes.get(root).size, fs.statSync(root).size);
    });
    it('rejects repeated changes rather than retaining a mixed snapshot', async () => {
        let ready = 0;
        await assert.rejects(createProjectIndexer().buildProjectIndex(root, {}, event => {
            if (event.type === 'structureReady') { ready++; fs.appendFileSync(root, '$ changed\n'); }
        }), e => e.name === 'ScanChangedError');
        assert.equal(ready, 2);
    });
    it('keeps small cached files when an oversized entry cannot be admitted', async () => {
        const calls = [];
        const indexer = createProjectIndexer({ maxFileScanCacheBytes: 100,
            estimateFileScanSize: scan => scan.filePath.endsWith('big.k') ? 101 : 30,
            getFileSignature: async () => ({ size: 1, mtimeMs: 1 }),
            loadFileIndex: async filePath => { calls.push(filePath); return { filePath, keywordBlocks: [], includeEntries: [] }; },
        });
        await indexer.buildProjectIndex(root);
        await indexer.buildProjectIndex(path.join(dir, 'big.k'));
        await indexer.buildProjectIndex(root);
        assert.equal(calls.filter(f => f === root).length, 1);
        assert.deepEqual(indexer.getMemoryCacheStats(), { entryCount: 1, totalBytes: 30 });
    });
});
