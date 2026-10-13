'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EntityIndexStore } = require('../../../out/core/cache/entityIndexStore');
const { buildSqliteDefinitionShard } = require('../../../out/core/references/sqliteDefinitionShard');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { entityFileRevision } = require('../../../out/core/cache/entityFileRevision');
const { scanOnDemandDefinitions, runtimeDefinitionKeywords, scanBlockLinesFromDisk } = require('../../../out/core/references/onDemandDefinitionScanner');
describe('SQLite streaming definition shards', function() {
    this.timeout(30000);
    let store;
    afterEach(async () => { await store?.close(); store = undefined; });
    const temporary = require('../../support/tempDirectories').trackTempDirectories();
    async function input() {
        const root = temporary(path.join(os.tmpdir(), 'sqlite-definitions-')), file = path.join(root, 'nodes.k');
        fs.writeFileSync(file, '*KEYWORD\n*NODE\n' + Array.from({ length: 1000 }, (_, i) =>
            String(i + 1).padStart(8) + '0'.padStart(16).repeat(3)).join('\n') + '\n*END\n');
        store = await EntityIndexStore.open(path.join(root, 'storage'));
        const sourceRevision = await entityFileRevision(file), index = await buildFileIndex(file);
        return { file, index, options: { sourceRevision, referenceIndex: {}, projectScoped: false, targetKinds: ['node'],
            targetDefinitions: [], definitionKeywords: runtimeDefinitionKeywords() } };
    }
    it('uses existing parsing semantics, stores all IDs, and retains no full in-memory definition list', async () => {
        const { file, index, options } = await input();
        const result = await buildSqliteDefinitionShard(store, 'node:file', 'revision', file, index, 'parser-v1', options);
        assert.equal(result.state, 'complete'); assert.equal(result.totalMatchCount, 1000);
        assert.deepEqual(result.definitions, []);
        const expected = await scanOnDemandDefinitions({ ...options, fileIndexes: new Map([[file, index]]), effectiveId: 999 });
        const page = await store.page('node:file', 'revision', 'node', 999, 'definition');
        assert.deepEqual(page.records, expected.definitions);
        assert.equal((await store.page('node:file', 'revision', 'node', 2, 'definition')).records[0].id, 2);
        assert.equal((await store.page('node:file', 'revision', 'curve', 2, 'definition')).records.length, 0);
        const rejected = await scanOnDemandDefinitions({ ...options, fileIndexes: new Map([[file, index]]),
            collectAllIds: true, retainDefinitions: false, acceptDefinition: () => false });
        assert.equal(rejected.state, 'partial');
        assert.ok(rejected.reasons.includes('on-demand-definition-consumer-rejected'));
    });
    it('does not publish a cancelled or changed source and refuses dirty documents', async () => {
        const { file, index, options } = await input();
        await assert.rejects(buildSqliteDefinitionShard(store, 'dirty', 'v1', file, { ...index, documentVersion: 2 }, 'p', options), /Unsaved/);
        const token = { isCancellationRequested: false };
        const cancelReader = async (block, visit) => scanBlockLinesFromDisk(block, async (...args) => {
            await visit(...args); if (args[1] > 200) token.isCancellationRequested = true;
        }, token);
        await assert.rejects(buildSqliteDefinitionShard(store, 'cancel', 'v1', file, index, 'p',
            { ...options, scanBlockLines: cancelReader, cancellationToken: token }), { name: 'CancellationError' });
        assert.equal((await store.page('cancel', 'v1', 'node', 1, 'definition')).state, 'miss');
        const reader = async (...args) => {
            const result = await scanBlockLinesFromDisk(...args);
            fs.appendFileSync(file, '$ externally edited\n'); return result;
        };
        await assert.rejects(buildSqliteDefinitionShard(store, 'changed', 'v1', file, index, 'p',
            { ...options, scanBlockLines: reader }), /changed during construction/);
        assert.equal((await store.page('changed', 'v1', 'node', 1, 'definition')).state, 'miss');
        await assert.rejects(buildSqliteDefinitionShard(store, 'stale', 'v1', file, index, 'p', options), /source revision is stale/);
    });
    it('batches small blocks together while preserving each block template and bounded writes', async () => {
        const { file, options } = await input();
        fs.writeFileSync(file, '*KEYWORD\n' + Array.from({ length: 600 }, (_, i) =>
            `*NODE\n${i + 1},0,0,0\n`).join('') + '*END\n');
        const index = await buildFileIndex(file), sourceRevision = await entityFileRevision(file);
        const writes = [], append = store.append.bind(store);
        store.append = (build, records, token, templates) => {
            writes.push({ count: records.length, bytes: Buffer.byteLength(JSON.stringify([records, templates])) });
            return append(build, records, token, templates);
        };
        const result = await buildSqliteDefinitionShard(store, 'many-blocks', 'v1', file, index, 'p', { ...options, sourceRevision });
        assert.equal(result.state, 'complete');
        assert.equal(result.totalMatchCount, 600);
        assert.ok(writes.length < 10, `Expected bounded batches, received ${writes.length} writes`);
        assert.ok(writes.every(write => write.count <= 512 && write.bytes < 512 * 1024));
        for (const id of [1, 300, 600]) {
            const page = await store.page('many-blocks', 'v1', 'node', id, 'definition');
            assert.equal(page.records.length, 1);
            assert.equal(page.records[0].idLine, id * 2);
            assert.equal(page.records[0].startLine, id * 2 - 1);
        }
    });
    it('writes block metadata only for the requested type and its format dependencies', async () => {
        const { file, options } = await input();
        fs.writeFileSync(file, '*KEYWORD\n*NODE\n1,0,0,0\n*DEFINE_CURVE\n7\n0,0\n1,1\n*END\n');
        const index = await buildFileIndex(file), sourceRevision = await entityFileRevision(file);
        const written = [], metadata = store.metadata.bind(store);
        store.metadata = (build, facts, token) => {
            written.push(...(facts.blocks || [])); return metadata(build, facts, token);
        };
        const result = await buildSqliteDefinitionShard(store, 'node-only', 'v1', file, index, 'p', { ...options, sourceRevision });
        assert.equal(result.state, 'complete');
        assert.deepEqual(written.map(block => block.line), [0, 1]);
        assert.equal((await store.page('node-only', 'v1', 'node', 1, 'definition')).records.length, 1);
    });
    it('retains parameter resolution and distinct Include transformations through SQLite', async () => {
        const inputData = await input(), file = inputData.file;
        fs.writeFileSync(file, ('*NODE\n &NODEID' + '0'.padStart(16).repeat(3) + '\n').repeat(2));
        const sourceRevision = await entityFileRevision(file), index = await buildFileIndex(file);
        const contexts = [0, 100].map(offset => ({ occurrenceId: `include:${offset}`,
            occurrencePath: ['root', `include:${offset}`], occurrencePathLabels: ['root', `model:${offset}`],
            idfoffOffset: offset, inputFormatMode: 'standard',
            initialBindings: new Map([['NODEID', { name: 'NODEID', value: 42, valueState: 'integer' }]]),
            initialUncertaintyReasons: [], timeline: [], uncertaintyReasons: [] }));
        const options = { ...inputData.options, sourceRevision, projectScoped: true,
            referenceIndex: { parameterContextsByFile: new Map([[file, contexts]]) } };
        assert.equal((await buildSqliteDefinitionShard(store, 'contexts', 'v1', file, index, 'p', options)).state, 'complete');
        for (const id of [42, 142]) {
            const expected = await scanOnDemandDefinitions({ ...options, fileIndexes: new Map([[file, index]]), effectiveId: id });
            const stored = await store.page('contexts', 'v1', 'node', id, 'definition');
            assert.equal(stored.records.length, 2);
            assert.deepEqual(stored.records, expected.definitions);
            assert.equal(stored.records[0].parameterResolution.resolved, true);
        }
    });
});
