'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { buildProjectReferenceIndex } = require('../../../out/core/references/projectReferenceIndex');
const { EntityQueryCache } = require('../../../out/core/references/entityQueryCache');
const { EntityIndexStore } = require('../../../out/core/cache/entityIndexStore');
const { entityFileRevision } = require('../../../out/core/cache/entityFileRevision');
const { SqliteReferenceIndex } = require('../../../out/core/references/sqliteReferenceIndex');
const { queryIndexedTypeReferences } = require('../../../out/core/references/entityTypeReferenceIndex');
const { queryRegistryReferences } = require('../../../out/core/references/onDemandReferenceScanner');
const { scanBlockLinesFromDisk } = require('../../../out/core/references/onDemandDefinitionScanner');
describe('SQLite reference candidates', function() {
    this.timeout(30000);
    const stores = [];
    afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
    const temporary = require('../../support/tempDirectories').trackTempDirectories();
    async function open(root, fallback = error => { throw error; }) {
        const store = await EntityIndexStore.open(path.join(root, 'storage')); stores.push(store);
        return new SqliteReferenceIndex(store, new EntityQueryCache(), fallback);
    }
    async function fixture(text) {
        const root = temporary(path.join(os.tmpdir(), 'entity-reference-shards-'));
        const file = path.join(root, 'main.k');
        fs.writeFileSync(file, text);
        const index = await buildFileIndex(file, { maxReferenceBlockBytes: 1 });
        const snapshot = { rootFile: file, scope: 'single-file', files: [file],
            graph: { includeOccurrences: [], includeOccurrencesComplete: true }, fileIndexes: new Map([[file, index]]) };
        index.sourceRevision = await entityFileRevision(file);
        let reads = 0;
        const options = { referenceIndex: buildProjectReferenceIndex(snapshot), fileIndexes: snapshot.fileIndexes,
            retainVerifiedMatchesOnIncomplete: true,
            scanBlockLines: (...args) => { reads++; return scanBlockLinesFromDisk(...args); } };
        return { root, options, file, reads: () => reads };
    }
    const query = id => ({ id, targetKinds: ['node'], targetDefinitions: [] });
    const deck = '*KEYWORD\n*BOUNDARY_SPC_NODE\n1,0,1,1,1,0,0,0\n*BOUNDARY_SPC_NODE\n2,0,1,1,1,0,0,0\n*END\n';
    const comparable = value => ({ state: value.state, locations: value.locations, reasons: value.reasons });

    it('restores another ID after reopening without scanning model content', async () => {
        const { root, options, reads } = await fixture(deck);
        const first = await open(root);
        const a = await first.query({ ...options, query: query(1) });
        assert.equal(a.locations.length, 1); assert.ok(reads() > 0);
        await stores[0].close();
        const restored = await open(root);
        const b = await restored.query({ ...options, query: query(2), scanBlockLines: () => { throw Error('unexpected model read'); } });
        assert.deepEqual(comparable(b), comparable(await queryRegistryReferences({ ...options, query: query(2) })));
        assert.equal(b.locations.length, 1); assert.equal(b.referenceLookup.scannedLines, 0);
    });
    it('preserves repeated Include transforms and unresolved parameters across IDs', async () => {
        const { root, options, file } = await fixture(deck.replace('2,0', '&UNKNOWN,0'));
        const contexts = options.referenceIndex.parameterContextsByFile.get(file);
        contexts.push({ ...contexts[0], occurrenceId: 'second', includeOffsets: { ...contexts[0].includeOffsets, idnoff: 100 } });
        const stored = await open(root);
        for (const id of [1, 101, 2, 102]) {
            const actual = await stored.query({ ...options, query: query(id) });
            const expected = await queryIndexedTypeReferences({ ...options, query: query(id) }, new EntityQueryCache());
            assert.deepEqual(comparable(actual), comparable(expected));
            assert.notEqual(actual.state, 'complete');
        }
    });
    it('falls back after database failure and rejects a same-size changed source', async () => {
        const { root, options, file } = await fixture(deck);
        const failures = [], stored = await open(root, error => failures.push(error));
        await stores[0].close();
        const result = await stored.query({ ...options, query: query(1) });
        assert.equal(result.locations.length, 1); assert.equal(failures.length, 1);
        const stat = fs.statSync(file);
        fs.writeFileSync(file, deck.replace('1,0', '3,0')); fs.utimesSync(file, stat.atime, stat.mtime);
        await assert.rejects(stored.query({ ...options, query: query(1) }), { name: 'ScanChangedError' });
    });
    it('resolves target priority at query time rather than persisting one lookup decision', async () => {
        const { root, options, file } = await fixture('*KEYWORD\n*END\n');
        const index = options.referenceIndex;
        const definition = kind => ({ id: 73, targetKind: kind, keyword: kind === 'curve' ? '*DEFINE_CURVE' : '*DEFINE_FUNCTION' });
        Object.assign(index, { indexedTargetKinds: new Set(['curve', 'function']),
            indexedTargetDefinitions: new Set(['DEFINE_CURVE', 'DEFINE_FUNCTION']),
            curvesById: new Map([[73, [definition('curve')]]]),
            entityDefinitionsByKind: new Map([['function', new Map([[73, [definition('function')]]])]]),
            registryReferenceCoverageGaps: [], registryReferenceOccurrences: [{ filePath: file, lineIndex: 1,
                startCharacter: 0, endCharacter: 2, targetKinds: ['curve', 'function'], targetDefinitions: [],
                referenceValue: { kind: 'numeric', id: 73, raw: '73', targetSearch: [
                    { targetKinds: ['curve'], targetKeywords: ['*DEFINE_CURVE'] },
                    { targetKinds: ['function'], targetKeywords: ['*DEFINE_FUNCTION'] }] } }] });
        const stored = await open(root), request = { ...options, query: { id: 73, targetKinds: ['function'], targetDefinitions: [] } };
        assert.equal((await stored.query(request)).locations.length, 0);
        index.curvesById.clear();
        assert.equal((await stored.query(request)).locations.length, 1);
        index.indexedTargetKinds.delete('curve'); index.indexedTargetDefinitions.delete('DEFINE_CURVE');
        const uncertain = await stored.query(request);
        assert.equal(uncertain.locations.length, 0); assert.notEqual(uncertain.state, 'complete');
    });
    it('abandons cancelled builds and scans again on the next request', async () => {
        const { root, options, reads } = await fixture(deck), stored = await open(root);
        const token = { isCancellationRequested: false };
        await assert.rejects(stored.query({ ...options, query: query(1), cancellationToken: token,
            scanBlockLines: (block, visit) => scanBlockLinesFromDisk(block, (...args) => {
                visit(...args); token.isCancellationRequested = true;
            }, token) }), { name: 'CancellationError' });
        const before = reads(), actual = await stored.query({ ...options, query: query(2) });
        assert.equal(actual.locations.length, 1); assert.ok(reads() > before);
    });
    it('rebuilds only an edited Include file while reusing other definition and reference shards', async () => {
        const { root, file } = await fixture('*KEYWORD\n*INCLUDE\na.k\n*INCLUDE\nb.k\n*END\n');
        const a = path.join(root, 'a.k'), b = path.join(root, 'b.k');
        const text = id => `*NODE\n${id},0,0,0\n*BOUNDARY_SPC_NODE\n${id},0,1,1,1,0,0,0\n`;
        fs.writeFileSync(a, text(1)); fs.writeFileSync(b, text(2));
        const indexer = require('../../../out/core/project/projectIndexer').createProjectIndexer({
            getFileSignature: require('../../../out/core/cache/entityFileRevision').entityFileSignature });
        const store = await EntityIndexStore.open(path.join(root, 'incremental')); stores.push(store);
        const fallback = new EntityQueryCache(), fail = error => { throw error; };
        const definitions = new (require('../../../out/core/references/sqliteDefinitionIndex').SqliteDefinitionIndex)(store, fallback, fail);
        const references = new SqliteReferenceIndex(store, fallback, fail), reads = [];
        const queryId = async (snapshot, id) => new (require('../../../out/core/references/entityReferenceQueryService').EntityReferenceQueryService)()
            .queryById(snapshot, id, 'node', { scanDefinitions: definitions.scan, queryReferences: references.query,
                scanBlockLines: (block, ...args) => { reads.push(block.filePath); return scanBlockLinesFromDisk(block, ...args); } });
        const before = await indexer.buildProjectIndex(file, { maxReferenceBlockBytes: 1 });
        const initial = await queryId(before, 1);
        assert.equal(initial.definitions.length, 1); assert.equal(initial.references.length, 1);
        const stat = fs.statSync(a);
        fs.writeFileSync(a, text(3)); fs.utimesSync(a, stat.atime, stat.mtime);
        reads.length = 0;
        const after = await indexer.buildProjectIndex(file, { maxReferenceBlockBytes: 1 });
        assert.strictEqual(after.fileIndexes.get(b), before.fileIndexes.get(b));
        const changed = await queryId(after, 3);
        assert.equal(changed.definitions.length, 1); assert.equal(changed.references.length, 1);
        assert.ok(reads.length); assert.ok(reads.every(file => file === a), JSON.stringify(reads));
        reads.length = 0;
        assert.equal((await queryId(after, 2)).references.length, 1);
        assert.equal((await queryId(after, 1)).locations.length, 0);
        assert.deepEqual(reads, []);
    });
});
