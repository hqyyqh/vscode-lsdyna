'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { SqliteDefinitionIndex } = require('../../../out/core/references/sqliteDefinitionIndex');
const { EntityIndexStore } = require('../../../out/core/cache/entityIndexStore');
const { entityFileSignature } = require('../../../out/core/cache/entityFileRevision');
const { EntityQueryCache } = require('../../../out/core/references/entityQueryCache');
const { EntityReferenceQueryService } = require('../../../out/core/references/entityReferenceQueryService');
const { createProjectIndexer } = require('../../../out/core/project/projectIndexer');
const { scanBlockLinesFromDisk } = require('../../../out/core/references/onDemandDefinitionScanner');
describe('SQLite definitions in entity queries', function() {
    this.timeout(30000);
    const stores = [];
    afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
    const temporary = require('../../support/tempDirectories').trackTempDirectories();
    async function input() {
        const root = temporary(path.join(os.tmpdir(), 'entity-sqlite-query-')), file = path.join(root, 'model.k');
        fs.writeFileSync(file, '*NODE\n       1\n       2\n');
        const indexer = createProjectIndexer({ getFileSignature: entityFileSignature });
        return { root, file, indexer, snapshot: await indexer.buildProjectIndex(file, { singleFileOnly: true }) };
    }
    async function definitions(root, onFallback = error => { throw error; }) {
        const store = await EntityIndexStore.open(path.join(root, 'storage')); stores.push(store);
        return new SqliteDefinitionIndex(store, new EntityQueryCache(16 * 1024 * 1024), onFallback);
    }
    it('serves different IDs after reopening SQLite without invoking the source reader', async () => {
        const { root, snapshot } = await input();
        let reads = 0;
        const first = await definitions(root), service = new EntityReferenceQueryService();
        const result = await service.queryById(snapshot, 1, 'node', { scanDefinitions: first.scan,
            scanBlockLines: (...args) => { reads++; return scanBlockLinesFromDisk(...args); } });
        assert.equal(result.definitions[0].entityId, '1'); assert.ok(reads > 0);
        await stores[0].close();
        const restored = await definitions(root);
        const second = await new EntityReferenceQueryService().queryById(snapshot, 2, 'node', { scanDefinitions: restored.scan,
            scanBlockLines: () => { throw Error('Warm definition query must not read the model'); } });
        assert.equal(second.lifecycle, 'ready');
        assert.equal(second.definitions[0].entityId, '2');
    });
    it('rejects stale snapshots and rebuilds after an edit with an unchanged size and restored mtime', async () => {
        const { root, file, snapshot, indexer } = await input();
        const lookup = await definitions(root), service = new EntityReferenceQueryService();
        await service.queryById(snapshot, 1, 'node', { scanDefinitions: lookup.scan });
        const stat = fs.statSync(file);
        fs.writeFileSync(file, '*NODE\n       3\n       2\n'); fs.utimesSync(file, stat.atime, stat.mtime);
        const fresh = await indexer.buildProjectIndex(file, { singleFileOnly: true });
        assert.notEqual(fresh.fileIndexes.get(file).sourceRevision, snapshot.fileIndexes.get(file).sourceRevision);
        const result = await new EntityReferenceQueryService().queryById(fresh, 3, 'node', { scanDefinitions: lookup.scan });
        assert.equal(result.definitions[0].entityId, '3');
        const old = await new EntityReferenceQueryService().queryById(fresh, 1, 'node', { scanDefinitions: lookup.scan });
        assert.deepEqual(old.definitions, []);
    });
});
