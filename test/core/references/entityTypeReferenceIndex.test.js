'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { trackTempDirectories } = require('../../support/tempDirectories');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { buildProjectReferenceIndex } = require('../../../out/core/references/projectReferenceIndex');
const { EntityQueryCache } = require('../../../out/core/references/entityQueryCache');
const { queryIndexedTypeReferences } = require('../../../out/core/references/entityTypeReferenceIndex');
const { queryRegistryReferences, scanOnDemandReferences } = require('../../../out/core/references/onDemandReferenceScanner');
const { scanBlockLinesFromDisk } = require('../../../out/core/references/onDemandDefinitionScanner');

describe('entity type reference shards', function () {
    this.timeout(30000);
    const temporary = trackTempDirectories();
    async function fixture(text) {
        const root = temporary(path.join(os.tmpdir(), 'entity-reference-shards-'));
        const file = path.join(root, 'main.k');
        fs.writeFileSync(file, text);
        const index = await buildFileIndex(file, { maxReferenceBlockBytes: 1 });
        const snapshot = { rootFile: file, scope: 'single-file', files: [file],
            graph: { includeOccurrences: [], includeOccurrencesComplete: true }, fileIndexes: new Map([[file, index]]) };
        let reads = 0;
        const options = { referenceIndex: buildProjectReferenceIndex(snapshot), fileIndexes: snapshot.fileIndexes,
            retainVerifiedMatchesOnIncomplete: true,
            scanBlockLines: (...args) => { reads++; return scanBlockLinesFromDisk(...args); } };
        return { options, file, reads: () => reads };
    }
    const query = id => ({ id, targetKinds: ['node'], targetDefinitions: [] });
    const deck = '*KEYWORD\n*BOUNDARY_SPC_NODE\n1,0,1,1,1,0,0,0\n*BOUNDARY_SPC_NODE\n2,0,1,1,1,0,0,0\n*END\n';
    const comparable = value => ({ state: value.state, locations: value.locations, reasons: value.reasons });
    it('streams all-ID reference facts without retaining them and supplies each Include identity', async () => {
        const { options, file } = await fixture(deck);
        const contexts = options.referenceIndex.parameterContextsByFile.get(file);
        contexts.push({ ...contexts[0], occurrenceId: 'second', includeOffsets: { ...contexts[0].includeOffsets, idnoff: 100 } });
        const request = { ...options, query: query(undefined), collectAllIds: true };
        const expected = await scanOnDemandReferences(request), occurrences = [];
        const streamed = await scanOnDemandReferences({ ...request, retainOccurrences: false,
            acceptOccurrence: occurrence => { occurrences.push(occurrence); return true; } });
        assert.deepEqual(streamed.occurrences, []);
        assert.deepEqual(occurrences, expected.occurrences);
        assert.deepEqual(streamed.gaps, expected.gaps);
        assert.deepEqual(streamed.resolvedGaps, expected.resolvedGaps);
        assert.ok(occurrences.some(item => item.occurrenceId === 'second'));
        const rejected = await scanOnDemandReferences({ ...request, retainOccurrences: false, acceptOccurrence: () => false });
        assert.ok(rejected.gaps.length); assert.equal(rejected.resolvedGaps.size, 0);
        await assert.rejects(scanOnDemandReferences({ ...request, retainOccurrences: false }), /all-ID consumer/);
    });
    it('recovers a type once and selects only the next ID candidates', async () => {
        const { options, reads } = await fixture(deck), cache = new EntityQueryCache();
        const first = await queryIndexedTypeReferences({ ...options, query: query(1) }, cache);
        assert.equal(first.locations.length, 1);
        const before = reads(); assert.ok(before > 0);
        const second = await queryIndexedTypeReferences({ ...options, query: query(2) }, cache);
        assert.equal(second.locations.length, 1); assert.equal(second.locations[0].line, 4);
        assert.equal(reads(), before); assert.equal(second.referenceLookup.scannedLines, 0);
        assert.equal(second.inspected, 1);
        assert.deepEqual(comparable(second), comparable(await queryRegistryReferences({ ...options, query: query(2) })));
    });
    it('preserves each repeated Include instance and invalidates changed parameter contexts', async () => {
        const { options, file } = await fixture(deck), cache = new EntityQueryCache();
        const contexts = options.referenceIndex.parameterContextsByFile.get(file);
        const original = contexts[0];
        contexts.push({ ...original, occurrenceId: 'second', includeOffsets: { ...original.includeOffsets, idnoff: 100 } });
        for (const id of [1, 101, 2, 102]) {
            const actual = await queryIndexedTypeReferences({ ...options, query: query(id) }, cache);
            const expected = await queryRegistryReferences({ ...options, query: query(id) });
            assert.deepEqual(comparable(actual), comparable(expected));
            assert.equal(actual.locations.length, 1);
        }
        contexts[1].includeOffsets.idnoff = 200;
        const changed = await queryIndexedTypeReferences({ ...options, query: query(201) }, cache);
        assert.equal(changed.locations.length, 1);
    });
    it('keeps unresolved parameters uncertain and falls back within a zero budget', async () => {
        const { options } = await fixture(deck.replace('2,0', '&UNKNOWN,0'));
        for (const budget of [0, 1024 * 1024]) {
            const cache = new EntityQueryCache(budget);
            for (const id of [1, 2]) {
                const actual = await queryIndexedTypeReferences({ ...options, query: query(id) }, cache);
                const expected = await queryRegistryReferences({ ...options, query: query(id) });
                assert.equal(actual.locations.length, expected.locations.length);
                assert.notEqual(actual.state, 'complete'); assert.ok(actual.reasons.length);
            }
            assert.equal(cache.stats().reservedBytes, 0); assert.ok(cache.stats().bytes <= budget);
        }
    });
    it('retains more than the legacy 10000 matches when the managed budget permits it', async () => {
        const { options } = await fixture(deck);
        const base = await queryRegistryReferences({ ...options, query: query(1) });
        const occurrence = base.referenceIndex.registryReferenceOccurrences.find(item => item.lineIndex === 2);
        options.referenceIndex = { ...base.referenceIndex, registryReferenceCoverageGaps: [],
            registryReferenceOccurrences: Array.from({ length: 10001 }, (_, lineIndex) => ({ ...occurrence, lineIndex })) };
        const result = await queryIndexedTypeReferences({ ...options, query: query(1) }, new EntityQueryCache());
        assert.equal(result.locations.length, 10001);
        assert.equal(result.state, 'complete');
        assert.ok(!result.reasons.includes('registry-reference-results-capacity-exceeded'));
    });
});
