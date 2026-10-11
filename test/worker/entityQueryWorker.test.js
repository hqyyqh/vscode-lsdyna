'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createWorkerPool } = require('../../out/worker/workerPool');
describe('Background entity query pages', function() {
    this.timeout(60000);
    const pools = [];
    afterEach(async () => { for (const pool of pools.splice(0)) await pool.dispose(); });
    const temporary = require('../support/tempDirectories').trackTempDirectories();
    function input(count = 450) {
        const root = temporary(path.join(os.tmpdir(), 'entity-worker-')), file = path.join(root, 'model.k');
        fs.writeFileSync(file, '*NODE\n' + '       1\n'.repeat(count));
        const pool = createWorkerPool({ workerPath: path.resolve('out/worker/scanWorker.js'),
            entityStorageDirectory: path.join(root, 'storage') }); pools.push(pool);
        return { pool, file, request: { rootFile: file, scope: 'single-file', id: 1, targetKind: 'node' } };
    }
    it('matches the complete scanner when switching demanded curve, part and node namespaces', async () => {
        const { pool, file } = input(1);
        fs.writeFileSync(file, '*KEYWORD\n*NODE\n1,0,0,0\n2,1,0,0\n3,1,1,0\n4,0,1,0\n' +
            '*ELEMENT_SHELL\n1,7,1,2,3,4\n*PART\npart\n7,0,5\n' +
            '*MAT_ELASTIC\n5,1,1,0.3\n*DEFINE_CURVE\n9\n0,0\n1,1\n*LOAD_BODY_Z\n9,1.0\n*END\n');
        const snapshot = await require('../../out/core/project/projectIndexer').buildProjectIndex(file, { singleFileOnly: true });
        const service = new (require('../../out/core/references/entityReferenceQueryService').EntityReferenceQueryService)();
        for (const [targetKind, id] of [['curve', 9], ['part', 7], ['node', 1], ['curve', 9]]) {
            const expected = await service.queryById(snapshot, id, targetKind);
            const actual = await pool.queryEntity({ rootFile: file, scope: 'single-file', targetKind, id });
            assert.equal(actual.status, 'ready');
            const positions = rows => rows.map(row => [row.role, row.filePath, row.line, row.startCharacter, row.endCharacter]);
            assert.deepEqual(positions(actual.result.locations), positions(expected.locations), targetKind);
            const labels = rows => rows.map(row => [row.entityId, row.entityKind, row.entityName]);
            assert.deepEqual(labels(actual.result.locations), labels(expected.locations), targetKind);
            for (const row of actual.result.locations.filter(row => row.role === 'reference'))
                assert.ok(actual.result.page.groupCounts[row.entityKind || ''] > 0);
            assert.equal(actual.result.state, expected.state, targetKind);
        }
    });

    it('omits mesh facts without removing keyword blocks or reusing full-policy SQLite results', async () => {
        const { pool, file } = input(1);
        const source = '*KEYWORD\n*NODE\n1,0,0,0\n*ELEMENT_SHELL\n1,7,1,1,1,1\n' +
            '*PART\npart\n7,0,5\n*MAT_ELASTIC\n5,1,1,0.3\n*DEFINE_CURVE\n9\n0,0\n1,1\n*LOAD_BODY_Z\n9,1\n*END\n';
        fs.writeFileSync(file, source);
        const request = { rootFile: file, scope: 'single-file', targetKind: 'part', id: 7 };
        const full = await pool.queryEntity(request);
        assert.ok(full.result.locations.some(row => row.role === 'reference'));
        const filtered = await pool.queryEntity({ ...request, excludeMeshEntities: true });
        assert.equal(filtered.result.page.counts.reference, 0);
        assert.equal(filtered.result.page.counts.definition, 1);
        assert.equal((await pool.queryEntity(request)).result.page.counts.reference, full.result.page.counts.reference);
        const curve = await pool.queryEntity({ ...request, targetKind: 'curve', id: 9, excludeMeshEntities: true });
        assert.equal(curve.result.page.counts.definition, 1);
        assert.equal(curve.result.page.counts.reference, 1);
        const node = await pool.queryEntity({ ...request, targetKind: 'node', id: 1, excludeMeshEntities: true });
        assert.equal(node.result.state, 'unsupported');
        const index = await require('../../out/core/scanner/fileIndexBuilder').buildFileIndex(file, { excludeMeshEntities: true });
        assert.ok(index.keywordBlocks.some(block => block.keyword === '*NODE'));
        assert.ok(index.keywordBlocks.some(block => block.keyword === '*ELEMENT_SHELL'));
        assert.equal(fs.readFileSync(file, 'utf8'), source);
    });

    it('returns only result pages, preserves counts, and expires cursors after edits', async () => {
        const { pool, file, request } = input();
        const first = await pool.queryEntity(request);
        assert.equal(first.status, 'ready'); assert.equal(first.result.locations.length, 200);
        assert.equal(first.result.page.counts.definition, 450);
        assert.equal(first.result.state, 'ambiguous');
        assert.equal((await pool.queryEntity({ ...request, id: 2, cursor: first.result.page.next.definition })).status, 'expired');
        assert.equal(first.snapshot, undefined); assert.equal(first.result.referenceIndex, undefined);
        assert.ok(!JSON.stringify(first).includes('fileIndexes'));
        const second = await pool.queryEntity({ ...request, cursor: first.result.page.next.definition });
        const third = await pool.queryEntity({ ...request, cursor: second.result.page.next.definition });
        assert.equal(second.result.locations.length, 200); assert.equal(third.result.locations.length, 50);
        assert.equal(third.result.page.next.definition, undefined);
        assert.equal(new Set([...first.result.locations, ...second.result.locations, ...third.result.locations].map(item => item.line)).size, 450);
        fs.appendFileSync(file, '       1\n');
        assert.equal((await pool.queryEntity({ ...request, cursor: first.result.page.next.definition })).status, 'expired');
        const fresh = await pool.queryEntity(request);
        assert.equal(fresh.result.page.counts.definition, 451);
    });
    it('restores resolved pages after worker restart without rebuilding a project snapshot', async () => {
        const { EntityQueryWorker } = require('../../out/worker/entityQueryWorker');
        const root = temporary(path.join(os.tmpdir(), 'entity-resolved-')), file = path.join(root, 'model.k');
        fs.writeFileSync(file, '*KEYWORD\n*NODE\n' + '       1\n'.repeat(450));
        const indexer = require('../../out/core/project/projectIndexer').createProjectIndexer({
            getFileSignature: require('../../out/core/cache/entityFileRevision').entityFileSignature });
        const firstWorker = new EntityQueryWorker((file, options, progress, token) =>
            indexer.buildProjectIndex(file, { ...options, cancellationToken: token }, progress), path.join(root, 'storage'));
        pools.push(firstWorker);
        const request = { rootFile: file, scope: 'single-file', id: 1, targetKind: 'node' };
        const first = await firstWorker.query(request);
        await firstWorker.dispose();
        let rebuilds = 0;
        const restored = new EntityQueryWorker(async () => { rebuilds++; throw Error('Unexpected project rebuild'); }, path.join(root, 'storage'));
        pools.push(restored);
        const again = await restored.query(request);
        assert.deepEqual(again, first);
        const second = await restored.query({ ...request, cursor: again.result.page.next.definition });
        const third = await restored.query({ ...request, cursor: second.result.page.next.definition });
        assert.deepEqual([second.result.locations.length, third.result.locations.length], [200, 50]);
        assert.equal(rebuilds, 0);
        fs.appendFileSync(file, '       2\n');
        await assert.rejects(restored.query(request), /Unexpected project rebuild/);
        assert.equal(rebuilds, 1);
    });

    it('invalidates resolved pages when a higher-priority Include appears without editing existing files', async () => {
        const { pool, file } = input(1), root = path.dirname(file), fallback = path.join(root, 'fallback');
        fs.mkdirSync(fallback);
        const curve = id => '*DEFINE_CURVE\n' + id + '\n0,0\n1,1\n';
        fs.writeFileSync(path.join(fallback, 'child.k'), curve(1));
        fs.writeFileSync(file, '*KEYWORD\n*INCLUDE_PATH\n' + fallback + '\n*INCLUDE\nchild.k\n*END\n');
        const request = { rootFile: file, scope: 'project', targetKind: 'curve', id: 1 };
        const first = await pool.queryEntity(request);
        assert.equal(first.result.page.counts.definition, 1);
        fs.writeFileSync(path.join(root, 'child.k'), curve(2));
        const changed = await pool.queryEntity(request);
        assert.equal(changed.result.page.counts.definition, 0);
        assert.notEqual(changed.revision, first.revision);
    });

    it('cancels one subscriber without cancelling an identical query still awaited by another', async () => {
        const { pool, request } = input(500);
        let callback;
        const token = { isCancellationRequested: false, onCancellationRequested: cb => {
            callback = cb; return { dispose() {} };
        } };
        const cancelled = pool.queryEntity(request, null, token);
        const waiting = pool.queryEntity(request);
        token.isCancellationRequested = true; callback();
        await assert.rejects(cancelled, { name: 'CancellationError' });
        assert.equal((await waiting).result.page.counts.definition, 500);
    });
    it('reports and clears the persistent generations through the worker without changing model content', async () => {
        const { pool, file, request } = input(20), original = fs.readFileSync(file);
        await pool.queryEntity(request);
        const before = await pool.controlEntityIndex('stats');
        assert.ok(before.sqlite.generations >= 1); assert.ok(before.sqlite.bytes > 0);
        assert.equal(before.memoryBudget, 256 * 1024 * 1024);
        const cleared = await pool.controlEntityIndex('clear');
        assert.ok(cleared.cleared.removed >= 1); assert.equal(cleared.sqlite.generations, 0);
        assert.equal((await pool.queryEntity(request)).result.page.counts.definition, 20);
        assert.deepEqual(fs.readFileSync(file), original);
        await assert.rejects(pool.controlEntityIndex('delete-model'), /Invalid entity index operation/);
    });
    it('clears SQLite through the loader before recycling its worker and rebuilds on demand', async () => {
        const root = temporary(path.join(os.tmpdir(), 'entity-loader-')), file = path.join(root, 'model.k');
        fs.writeFileSync(file, '*NODE\n       1\n');
        const loader = require('../../out/worker/projectIndexLoader').createProjectIndexLoader({
            workerPath: path.resolve('out/worker/scanWorker.js'), entityStorageDirectory: path.join(root, 'storage') });
        pools.push(loader);
        assert.equal(await loader.getEntityIndexStats(), null);
        const request = { rootFile: file, scope: 'single-file', id: 1, targetKind: 'node' };
        await loader.queryEntity(request);
        assert.ok((await loader.getEntityIndexStats()).sqlite.generations >= 1);
        const cleared = await loader.clearPersistentCache();
        assert.ok(cleared.entityIndex.cleared.removed >= 1);
        assert.equal(await loader.getEntityIndexStats(), null);
        assert.equal((await loader.queryEntity(request)).result.page.counts.definition, 1);
    });
    it('retries persistence initialization after cancellation rather than disabling SQLite', async () => {
        const { EntityIndexStore } = require('../../out/core/cache/entityIndexStore');
        const { EntityQueryWorker } = require('../../out/worker/entityQueryWorker');
        const root = temporary(path.join(os.tmpdir(), 'entity-init-cancel-')), file = path.join(root, 'model.k');
        fs.writeFileSync(file, '*NODE\n       1\n');
        const indexer = require('../../out/core/project/projectIndexer').createProjectIndexer({
            getFileSignature: require('../../out/core/cache/entityFileRevision').entityFileSignature });
        const diagnostics = [], worker = new EntityQueryWorker((file, options, progress, token) =>
            indexer.buildProjectIndex(file, { ...options, cancellationToken: token }, progress),
            path.join(root, 'storage'), undefined, undefined, error => diagnostics.push(error), 1234);
        pools.push(worker);
        let opened, resume;
        const ready = new Promise(resolve => { opened = resolve; }), gate = new Promise(resolve => { resume = resolve; });
        const original = EntityIndexStore.open;
        const originalPrune = EntityIndexStore.prototype.prune, ages = [];
        EntityIndexStore.prototype.prune = function(age, ...args) { ages.push(age); return originalPrune.call(this, age, ...args); };
        EntityIndexStore.open = async (...args) => { const store = await original(...args); opened(); await gate; return store; };
        const request = { rootFile: file, scope: 'single-file', id: 1, targetKind: 'node' }, token = { isCancellationRequested: false };
        try {
            const pending = worker.query(request, token);
            await ready; token.isCancellationRequested = true; resume();
            await assert.rejects(pending, { name: 'CancellationError' });
        } finally { resume(); EntityIndexStore.open = original; EntityIndexStore.prototype.prune = originalPrune; }
        assert.deepEqual(ages, [1234]);
        assert.equal((await worker.query(request)).result.page.counts.definition, 1);
        assert.ok((await worker.stats()).sqlite); assert.deepEqual(diagnostics, []);
    });
});
