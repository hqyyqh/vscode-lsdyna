'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { trackTempDirectories } = require('../../support/tempDirectories');
const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
const { buildProjectReferenceIndex } = require('../../../src/core/references/projectReferenceIndex');
const { scanOnDemandReferences } = require('../../../src/core/references/onDemandReferenceScanner');
const { queryIndexedEntityId } = require('../../../src/core/references/indexedEntityQuery');
const { scanBlockLinesFromDisk } = require('../../../src/core/references/onDemandDefinitionScanner');

describe('on-demand reference scanner', function () {
    this.timeout(60000);
    const tempDirectory = trackTempDirectories();
    const row = (values, width = 8) => values.map(value => String(value).padStart(width)).join('');
    const snapshotFor = (filePath, fileIndex) => ({ rootFile: filePath, scope: 'single-file', files: [filePath],
        graph: { includeOccurrences: [], includeOccurrencesComplete: true },
        fileIndexes: new Map([[filePath, fileIndex]]) });
    async function fixture(text, maxReferenceBlockBytes = 45) {
        const root = tempDirectory(path.join(os.tmpdir(), 'dynasense-demand-references-'));
        const filePath = path.join(root, 'main.key');
        fs.writeFileSync(filePath, text);
        const fileIndex = await buildFileIndex(filePath, { maxReferenceBlockBytes });
        const snapshot = snapshotFor(filePath, fileIndex);
        return { filePath, fileIndex, snapshot, referenceIndex: buildProjectReferenceIndex(snapshot) };
    }
    const beamDeck = '*KEYWORD\n*ELEMENT_BEAM\n' + row([1, 8, 1, 1, 0]) + '\n' + row([2, 73, 1, 73, 0]) + '\n*END\n';
    const lookup = (value, overrides = {}) => scanOnDemandReferences({
        referenceIndex: value.referenceIndex, fileIndexes: value.snapshot.fileIndexes,
        query: { id: 73, targetKinds: ['node'], targetDefinitions: [] }, ...overrides });

    it('replays deferred manual supplements instead of certifying them from native-only namespaces', async () => {
        const keyword = 'BOUNDARY_PRESCRIBED_MOTION_SET_SEGMENT_ID';
        const schema = require('../../../out/core/keywordSchema');
        const cards = schema.getRenderedCardsForLookup(schema.lookupKeywordSchema(keyword, schema.loadKeywordSchema(() => 'en')));
        const text = ['*KEYWORD', '*' + keyword, ...cards.map((card, row) => card.map((field, index) =>
            row === 0 && index === 0 ? '73' : ['integer', 'real'].includes(field.t) ? '0' : '').join(',')), '*END'].join('\n');
        const value = await fixture(text, 65536);
        assert.ok(value.fileIndex.registryReferences.referenceOccurrences.some(item => item.fieldName === 'ID' && item.referenceValue.id === 73));
        value.referenceIndex.registryReferenceOccurrences = [];
        value.referenceIndex.registryReferenceCoverageGaps = [{ filePath: value.filePath, startLine: 1,
            reason: 'registry-reference-scan-deferred', scope: 'all', targetKinds: [], targetDefinitions: [] }];
        const result = await lookup(value, { query: { id: 73, targetKinds: ['set'], targetDefinitions: [] }, collectAllIds: true });
        assert.deepEqual(result.occurrences.map(item => [item.fieldName, item.referenceValue.id]), [['ID', 73]]);
        assert.equal(result.resolvedGaps.size, 1);
    });

    it('retains manual references mapped to later cards instead of matching frozen source coordinates', async () => {
        const schema = require('../../../out/core/keywordSchema');
        for (const [keyword, fieldName, targetKind] of [
            ['AIRBAG_CPG', 'ADAID', 'part-set'],
            ['CONSTRAINED_SOIL_PILE', 'LCCU', 'curve'],
            ['CONTROL_FORMING_SCRAP_FALL', 'NEWID', 'part'],
            ['DEFINE_SPH_INJECTION', 'NID', 'node'],
            ['ELEMENT_SEATBELT_SLIPRING', 'FUNCID', 'function'],
            ['AIRBAG_SALE', 'NIDI', 'node'],
        ]) for (const cap of [65536, 1]) {
            const cards = schema.getRenderedCardsForLookup(schema.lookupKeywordSchema(keyword, schema.loadKeywordSchema(() => 'en')));
            const targetCard = cards.findIndex(card => card.some(field => field.n.trim() === fieldName));
            assert.ok(targetCard >= 1, keyword);
            const value = await fixture(['*KEYWORD', '*' + keyword, ...cards.map(card => {
                const line = ' '.repeat(200).split('');
                for (const field of card) line.splice(field.p, field.w,
                    ...String(field.n.trim() === fieldName ? 73 : 0).padStart(field.w));
                return line.join('');
            }), '*END'].join('\n'), cap);
            const result = await require('../../../out/core/references/onDemandReferenceScanner').queryRegistryReferences({
                referenceIndex: value.referenceIndex, fileIndexes: value.snapshot.fileIndexes,
                query: { id: 73, targetKinds: [targetKind], targetDefinitions: [] }, retainVerifiedMatchesOnIncomplete: true });
            assert.ok(result.locations.some(location => location.id === 73 && location.line === targetCard + 2) &&
                result.referenceIndex.registryReferenceOccurrences.some(occurrence => occurrence.fieldName.trim() === fieldName),
                `${keyword}, cap=${cap}: ${JSON.stringify({ state: result.state, reasons: result.reasons, locations: result.locations })}`);
        }
    });

    it('uses exact TITLE spelling rules for no-prefix repetitions and a single keyword prefix', async () => {
        for (const format of ['standard', 'comma', 'long', 'i10']) {
            const marker = format === 'long' ? ' +' : format === 'i10' ? ' %' : '';
            const render = (values, width) => format === 'comma' ? values.join(',') : row(values,
                format === 'long' ? 20 : format === 'i10' ? Math.max(10, width) : width);
            for (const cap of [undefined, 1]) {
                const discrete = await fixture(['*KEYWORD', '*ELEMENT_DISCRETE_TITLE' + marker,
                    render([1, 0, 0, 0, 73, 0, 0, 0], 8), '$ between objects',
                    render([2, 0, 0, 0, 73, 0, 0, 0], 8), '*END'].join('\n'), cap);
                const query = await queryIndexedEntityId({ snapshot: discrete.snapshot, id: 73, targetKind: 'sd' });
                assert.deepEqual(query.locations.filter(item => item.role === 'reference').map(item => [item.fieldName, item.line]),
                    [['VID', 2], ['VID', 4]], JSON.stringify({ format, cap, reasons: query.reasons }));
                assert.ok(!query.reasons.some(reason => /preview-byte-limit|native-layout-unavailable/.test(reason)));
                const cese = await fixture(['*KEYWORD', '*CESE_PART_TITLE' + marker, 'keyword title',
                    render([1, 73, 73], 10), render([2, 73, 73], 10), '*END'].join('\n'), cap);
                for (const kind of ['cese-mat', 'cese-eos']) {
                    const result = await queryIndexedEntityId({ snapshot: cese.snapshot, id: 73, targetKind: kind });
                    assert.deepEqual(result.locations.filter(item => item.role === 'reference').map(item => [item.fieldName, item.line]),
                        [[kind === 'cese-mat' ? 'MID' : 'EOSID', 3]], JSON.stringify({ format, cap, kind, reasons: result.reasons }));
                    assert.ok(!result.reasons.some(reason => /preview-byte-limit|native-layout-unavailable/.test(reason)));
                }
            }
        }
    });

    it('replays ordinary small blocks with global formats, parameters, INCLUDE offsets and physical lines', async () => {
        for (const mode of ['standard', 'long', 'i10', 'comma']) {
            const header = mode === 'long' ? '*KEYWORD LONG=Y' : mode === 'i10' ? '*KEYWORD I10=Y' : '*KEYWORD';
            const data = mode === 'comma' ? '&N,0,1,1,1,0,0,0' : row(['&N', 0, 1, 1, 1, 0, 0, 0], mode === 'long' ? 20 : 10);
            const value = await fixture([header, '*BOUNDARY_SPC_NODE', '$ retain physical line', data, '*END'].join('\n'), 1);
            const context = value.referenceIndex.parameterContextsByFile.get(value.filePath)[0];
            context.includeOffsets.idnoff = 100;
            context.initialBindings = new Map([['N', { valueState: 'integer', value: 73 }]]);
            const result = await lookup(value, { query: { id: 173, targetKinds: ['node'], targetDefinitions: [] } });
            assert.deepEqual(result.occurrences.map(item => [item.fieldName, item.lineIndex]), [['NID', 3]], mode);
            assert.ok(result.resolvedGaps.size > 0, mode); assert.deepEqual(result.gaps, [], mode);
            context.initialBindings.clear();
            const unknown = await lookup(value);
            assert.equal(unknown.resolvedGaps.size, 0, mode);
        }
    });

    it('keeps ordinary replay bounded and retains unrelated blockers and result limits', async () => {
        const value = await fixture('*KEYWORD\n*BOUNDARY_SPC_NODE\n73,0,1,1,1,0,0,0\n*END', 1);
        const unrelated = { filePath: value.filePath, startLine: 1, reason: 'lspp-unresolved-native-target',
            scope: 'namespaces', targetKinds: ['node'], targetDefinitions: [] };
        value.referenceIndex.registryReferenceCoverageGaps.push(unrelated);
        const result = await lookup(value);
        assert.equal(result.occurrences.length, 1); assert.ok(!result.resolvedGaps.has(unrelated));
        const capacity = await lookup(value, { maxMatches: 0 });
        assert.equal(capacity.occurrences.length, 0); assert.equal(capacity.resolvedGaps.size, 0);
        const large = await fixture('*KEYWORD\n*BOUNDARY_SPC_NODE\n73,0,1,1,1,0,0,0\n$' + 'x'.repeat(256 * 1024) + '\n*END', 1);
        const bounded = await lookup(large);
        assert.equal(bounded.scannedBlocks, 0); assert.equal(bounded.resolvedGaps.size, 0);
        const oversizedReader = await lookup(value, { scanBlockLines: async (block, visit) => {
            visit('x'.repeat(256 * 1024), block.startLine + 1); return { complete: true };
        } });
        assert.equal(oversizedReader.occurrences.length, 0); assert.equal(oversizedReader.resolvedGaps.size, 0);
    });

    it('never resolves ordinary-block gaps after read failure, cancellation or a disk change', async () => {
        const value = await fixture('*KEYWORD\n*BOUNDARY_SPC_NODE\n73,0,1,1,1,0,0,0\n*END', 1);
        for (const scanBlockLines of [
            async () => ({ complete: false, reason: 'fixture-read-failed' }),
            async () => ({ cancelled: true }),
            async (...args) => { const read = await scanBlockLinesFromDisk(...args); fs.appendFileSync(value.filePath, '\n$ changed'); return read; },
        ]) {
            const result = await lookup(value, { scanBlockLines });
            assert.equal(result.occurrences.length, 0); assert.equal(result.resolvedGaps.size, 0);
        }
    });

    it('streams AMBIENT control-selected bodies without consuming the following header as a body', async () => {
        for (const keyword of ['BOUNDARY_AMBIENT', 'BOUNDARY_AMBIENT_ID'])
        for (const format of ['standard', 'comma', 'long', 'i10']) {
            const marker = format === 'long' ? ' +' : format === 'i10' ? ' %' : '';
            const render = values => format === 'comma' ? values.join(',') : row(values, format === 'long' ? 20 : 10);
            for (const cap of [undefined, 1]) {
                const value = await fixture(['*KEYWORD', '*' + keyword + marker,
                    render([1, 73, 4, 0, 0]), render([73, 73]),
                    render([2, 73, 0, 0, 0]), '*END'].join('\n'), cap);
                for (const [kind, expected] of [
                    ['ale-structured-multimaterial-group', [['MMG', 2], ['MMG', 4]]],
                    ['curve', [['LCID1', 3], ['LCID2', 3]]],
                ]) {
                    const query = await queryIndexedEntityId({ snapshot: value.snapshot, id: 73, targetKind: kind });
                    assert.deepEqual(query.locations.filter(item => item.role === 'reference').map(item => [item.fieldName, item.line]), expected,
                        JSON.stringify({ keyword, format, cap, kind, reasons: query.reasons }));
                    assert.ok(!query.reasons.some(reason => /preview-byte-limit|native-layout-unavailable/.test(reason)));
                }
            }
        }
        const unknown = await fixture('*KEYWORD\n*BOUNDARY_AMBIENT\n1,73,&TYPE,0,0\n73,73\n*END', 1);
        const result = await queryIndexedEntityId({ snapshot: unknown.snapshot, id: 73, targetKind: 'curve' });
        assert.ok(['partial', 'incomplete'].includes(result.state));
        assert.ok(result.reasons.length);
    });

    it('recovers source-bound single CESE headers without inventing repeated references', async () => {
        for (const format of ['standard', 'comma', 'long', 'i10']) {
            const render = values => format === 'comma' ? values.join(',') : row(values, format === 'long' ? 20 : 10);
            const marker = format === 'long' ? ' +' : format === 'i10' ? ' %' : '';
            const value = await fixture(['*KEYWORD', '*CESE_PART' + marker,
                render([1, 73, 73]), render([2, 73, 73]), '*END'].join('\n'), 1);
            for (const kind of ['cese-mat', 'cese-eos']) {
                const result = await queryIndexedEntityId({ snapshot: value.snapshot, id: 73, targetKind: kind });
                assert.deepEqual(result.locations.filter(item => item.role === 'reference').map(item => [item.fieldName, item.line]),
                    [[kind === 'cese-mat' ? 'MID' : 'EOSID', 2]], JSON.stringify({ format, kind, reasons: result.reasons }));
                assert.ok(!result.reasons.some(reason => /preview-byte-limit|native-layout-unavailable/.test(reason)));
            }
        }
    });

    it('streams repeated SHELL headers across counted bodies and ignores a special Pi tail', async () => {
        for (const format of ['standard', 'comma', 'long', 'i10']) {
            const render = values => format === 'comma' ? values.join(',') : row(values, format === 'long' ? 20 : 10);
            const marker = format === 'long' ? ' +' : format === 'i10' ? ' %' : '';
            const lines = ['*KEYWORD', '*SECTION_SHELL' + marker,
                render([1, 2, 0, 17, 0, -73, 1, 0]), render(Array(8).fill(0)),
                ...Array(3).fill(render(Array(8).fill(-73))),
                render([2, 2, 0, 0, 0, -73, 0, 0]), render(Array(8).fill(0)),
                render([3, 100, 0, 0, 0, -73, 0, 0]), render(Array(8).fill(0)),
                render(Array(8).fill(0)), render(Array(3).fill(0)),
                ...Array(128).fill(render(Array(8).fill(-73))), '*END'];
            for (const cap of [undefined, 1]) {
                const value = await fixture(lines.join('\n'), cap);
                const result = await queryIndexedEntityId({ snapshot: value.snapshot, id: 73, targetKind: 'integration-shell' });
                assert.deepEqual(result.locations.filter(item => item.role === 'reference').map(item => [item.fieldName, item.line]),
                    [['QR_IRID', 2], ['QR_IRID', 7], ['QR_IRID', 9]], JSON.stringify({ format, cap, reasons: result.reasons }));
                assert.ok(!result.reasons.some(reason => /preview-byte-limit|native-layout-unavailable/.test(reason)));
            }
            const unknown = await fixture(['*KEYWORD', '*SECTION_SHELL' + marker,
                render([1, '&FORM', 0, 0, 0, -73, 0, 0]), render(Array(8).fill(0)), '*END'].join('\n'), 1);
            const query = await queryIndexedEntityId({ snapshot: unknown.snapshot, id: 73, targetKind: 'integration-shell' });
            assert.ok(['partial', 'incomplete'].includes(query.state));
            assert.ok(query.reasons.length > 0);
        }
    });

    it('binds indexed and disk references to each repeated INCLUDE offset separately', async () => {
        for (const maxReferenceBlockBytes of [undefined, 1]) {
            const directory = tempDirectory(path.join(os.tmpdir(), 'dynasense-repeated-reference-offset-'));
            const main = path.join(directory, 'main.k'), child = path.join(directory, 'child.k');
            fs.writeFileSync(main, '*KEYWORD\n*PARAMETER\nIN,73\n*INCLUDE\nchild.k\n*INCLUDE_TRANSFORM\nchild.k\n*END\n');
            fs.writeFileSync(child, '*KEYWORD\n*NODE\n' + row([73]) + '\n*ELEMENT_BEAM\n' + row([1,0,0,'&N',0]) + '\n*END\n');
            const snapshot = { rootFile: main, files: [main, child], fileIndexes: new Map(), graph: {
                includeOccurrencesComplete: true, includeOccurrences: [
                    { occurrenceId: 'child:1', fromFile: main, filePath: child, fileName: 'child.k', keywordLine: 3, lineIndex: 4 },
                    { occurrenceId: 'child:2', fromFile: main, filePath: child, fileName: 'child.k', keywordLine: 5, lineIndex: 6,
                        transform: { offsets: { idnoff: { kind: 'numeric', value: 100, raw: '100' } } } },
                ] } };
            for (const file of snapshot.files) snapshot.fileIndexes.set(file, await buildFileIndex(file, { maxReferenceBlockBytes }));
            for (const id of [73, 173]) {
                const result = await queryIndexedEntityId({ snapshot, id, targetKind: 'node' });
                assert.deepEqual(result.locations.filter(row => row.role === 'reference').map(row => [row.fieldName, row.line]),
                    [['N2', 4]], JSON.stringify({ id, maxReferenceBlockBytes, reasons: result.reasons }));
                assert.ok(!result.reasons.some(reason => /transform-occurrence-ambiguous|parameter-occurrence-ambiguous/.test(reason)));
            }
        }
    });
    it('streams SOIL variable bodies with resolved controls and INCLUDE offsets', async () => {
        const lines = ['*KEYWORD', '*CONSTRAINED_SOIL_PILE_CONSTANTS%', row([0, 1, 0, 0, 0, 0, 0, 0], 10),
            row([0, 0, 0, 0, 0, 0, 0, 0], 10)];
        for (let index = 0; index < 1000; index++) lines.push(row([2, 0, 0, 0, 0, 0, 0, 0], 10),
            row([0, 0, 0, 0, 0, 0, 0, 0], 10), row([0, 0, 0, 0, 0, 0, 0, 0], 10),
            row([0, 0, 0, 0, 0, 0, 0, '&Z'], 10));
        const targetLine = lines.length;
        lines.push(row(['&N', 0, 0, 0, 0, 0, 0, 0], 10), row([0, 0, 0, 0, 0, 0, 0, 0], 10),
            row([0, 0, 0, 0, 0, 0, 0, 0], 10), row([0, 0, 0, 0, 0, 0, 0, '&Z'], 10), '*END');
        const value = await fixture(lines.join('\n'), 25);
        const context = value.referenceIndex.parameterContextsByFile.get(value.filePath)[0];
        context.includeOffsets.idpoff = 100;
        context.initialBindings = new Map([['N', { valueState: 'integer', value: 73 }], ['Z', { valueState: 'integer', value: 0 }]]);
        const query = { id: 173, targetKinds: ['part'], targetDefinitions: [] };
        const result = await lookup(value, { query });
        assert.deepEqual(result.occurrences.map(item => [item.fieldName, item.lineIndex]), [['PID', targetLine]]);
        assert.ok(result.resolvedGaps.size > 0);
        assert.equal(result.gaps.length, 0);
        context.initialBindings.delete('Z');
        const unresolved = await lookup(value, { query });
        assert.equal(unresolved.resolvedGaps.size, 0);
        assert.ok(unresolved.gaps.length > 0, 'An unresolved HLC must not be interpreted as zero');
    });

    it('recovers user-material axes with parameter controls and INCLUDE offsets from a bounded prefix', async () => {
        const value = await fixture(['*KEYWORD', '*MAT_USER_DEFINED_MATERIAL_MODELS',
            row([970001, 1, 41, 2147483647, 0, '&O', 0, 0], 10), row([0, 0, 0, 0, 0, 2147483647, 0, 0], 10),
            row(['-&N', 0, 0, 0, 0, 0, 0, 0], 10), row([0, 0, 0, 0, 0, 0, 0, 0], 10),
            ...Array(1000).fill(row([73, 73, 73, 73, 73, 73, 73, 73], 10)), '*END'].join('\n'), 25);
        const context = value.referenceIndex.parameterContextsByFile.get(value.filePath)[0];
        context.includeOffsets.iddoff = 100;
        context.initialBindings = new Map([['N', { valueState: 'integer', value: 73 }], ['O', { valueState: 'integer', value: 1 }]]);
        const query = { id: 173, targetKinds: ['coordinate-system'], targetDefinitions: [] };
        const result = await lookup(value, { query });
        assert.deepEqual(result.occurrences.map(item => [item.fieldName, item.lineIndex]), [['AOPT', 4]],
            JSON.stringify({ scannedBlocks: result.scannedBlocks, gaps: result.gaps,
                inputGaps: value.referenceIndex.registryReferenceCoverageGaps.map(gap => ({ reason: gap.reason, kinds: gap.targetKinds })) }));
        assert.ok(result.resolvedGaps.size > 0);
        assert.equal(result.gaps.length, 0, JSON.stringify(result.gaps));
        context.initialBindings.delete('O');
        const unresolved = await lookup(value, { query });
        assert.equal(unresolved.occurrences.length, 0);
        assert.equal(unresolved.resolvedGaps.size, 0);
        assert.ok(unresolved.gaps.length > 0);
    });

    it('finds tail matches beyond both default index capacity and 16 MiB, including a reopened serialized index', async () => {
        const text = '*KEYWORD\n*NODE\n' + row([73]) + '\n*ELEMENT_BEAM\n' +
            (row([1, 8, 1, 1, 0]) + '\n').repeat(20000) +
            ('$' + 'x'.repeat(17400) + '\n').repeat(1024) + row([2, 73, 1, 73, 0]) + '\n*END\n';
        const value = await fixture(text, 16 * 1024 * 1024);
        assert.ok(value.fileIndex.size > 16 * 1024 * 1024);
        const reasons = value.fileIndex.registryReferences.referenceCoverage.gaps.map(gap => gap.reason);
        assert.ok(reasons.includes('registry-reference-capacity-exceeded'));
        assert.ok(reasons.includes('registry-reference-preview-byte-limit'));
        const baseline = JSON.stringify(value.fileIndex.registryReferences);
        for (const fileIndex of [value.fileIndex, JSON.parse(JSON.stringify(value.fileIndex))]) {
            const query = await queryIndexedEntityId({ snapshot: snapshotFor(value.filePath, fileIndex), id: 73, targetKind: 'node' });
            const refs = query.locations.filter(location => location.role === 'reference');
            assert.deepEqual(refs.map(location => [location.keyword, location.fieldName, location.line]),
                [['*ELEMENT_BEAM', 'N2', 21028]]);
            assert.equal(query.referenceLookup.occurrences.length, 1);
            assert.equal(refs[0].entityId, undefined, 'A repeated record must not inherit the block first EID');
            assert.ok(!query.reasons.some(reason => /capacity-exceeded|preview-byte-limit/.test(reason)), JSON.stringify(query.reasons));
        }
        assert.equal(JSON.stringify(value.fileIndex.registryReferences), baseline, 'Query recovery must not mutate the persistent index');
    });

    it('queries the original airbag ID definition and references without mixing a same-ID PART', async () => {
        const value = await fixture(['*KEYWORD','*PART','same ID part',row([73]),'*AIRBAG_FLUID_AND_GAS_ID',
            row([73,'bag']),row(Array(8).fill(0)),row(Array(8).fill(0)),row(Array(7).fill(0)),
            '*AIRBAG_INTERACTION',row([73,74],10),'*END'].join('\n'), 1024);
        const query = await queryIndexedEntityId({ snapshot: value.snapshot, id: 73, targetKind: 'airbag-id' });
        assert.equal(query.state, 'complete', JSON.stringify(query.reasons));
        assert.deepEqual(query.locations.map(item => [item.role, item.keyword, item.fieldName, item.line]),
            [['definition', '*AIRBAG_FLUID_AND_GAS_ID', 'ID', 5], ['reference', '*AIRBAG_INTERACTION', 'AB1', 10]]);
        assert.equal(query.locations.some(item => item.keyword === '*PART'), false);
        const absent = await queryIndexedEntityId({ snapshot: value.snapshot, id: 999, targetKind: 'airbag-id' });
        assert.equal(absent.state, 'complete', JSON.stringify(absent.reasons));
        assert.deepEqual(absent.locations, []);
    });

    it('streams SOLID nodes beyond 16 MiB and index capacity with parameter and INCLUDE binding', async () => {
        const lines = ['*KEYWORD', '*ELEMENT_SOLID'];
        for (let i = 0; i < 21000; i++) lines.push(row([i + 1, 73, 2, 2, 2, 2, 2, 2, 2, 2]), '$' + 'padding'.repeat(110));
        const targetLine = lines.length;
        lines.push(row([980002, 73, 2, 2, 2, 2, 2, 2, 2, '&N']), '*END');
        const value = await fixture(lines.join('\n'), 16 * 1024 * 1024);
        assert.ok(fs.statSync(value.filePath).size > 16 * 1024 * 1024);
        const context = value.referenceIndex.parameterContextsByFile.get(value.filePath)[0];
        context.includeOffsets.idnoff = 100;
        context.initialBindings = new Map([['N', { valueState: 'integer', value: 73 }]]);
        const result = await lookup(value, { query: { id: 173, targetKinds: ['node'], targetDefinitions: [] } });
        assert.deepEqual(result.occurrences.map(item => [item.fieldName, item.lineIndex]), [['N8', targetLine]]);
        assert.ok(result.resolvedGaps.size > 0);
        assert.equal(result.gaps.length, 0);
        const other = await lookup(value, { query: { id: 173, targetKinds: ['node-set'], targetDefinitions: [] } });
        assert.equal(other.occurrences.length, 0);
    });

    it('streams truncated list tails with the correct namespace, parameter binding, TITLE and INCLUDE offset', async () => {
        for (const [keyword, kind, field] of [['SET_NODE_LIST', 'node', 'NID2'], ['SET_PART_LIST_TITLE', 'part', 'PID2']]) {
            const value = await fixture(['*KEYWORD', '*' + keyword, ...(keyword.endsWith('_TITLE') ? ['73'] : []),
                row([970001], 10), row([1, 2], 10), row([3, '&N'], 10), '*END'].join('\n'), 25);
            const context = value.referenceIndex.parameterContextsByFile.get(value.filePath)[0];
            context.includeOffsets[kind === 'node' ? 'idnoff' : 'idpoff'] = 100;
            context.initialBindings = new Map([['N', { valueState: 'integer', value: 73 }]]);
            const result = await lookup(value, { query: { id: 173, targetKinds: [kind], targetDefinitions: [] } });
            assert.deepEqual(result.occurrences.map(item => [item.fieldName, item.lineIndex]),
                [[field, 4 + Number(keyword.endsWith('_TITLE'))]]);
            assert.ok(result.resolvedGaps.size > 0);
            assert.equal(result.gaps.length, 0);
            const other = await lookup(value, { query: { id: 173, targetKinds: [kind === 'node' ? 'part' : 'node'], targetDefinitions: [] } });
            assert.equal(other.occurrences.length, 0);
        }
    });
    it('streams GENERAL tails with bounded header context and keeps same-ID native namespaces separate', async () => {
        const record = (option, id) => option.padEnd(10) + String(id).padStart(10);
        const value = await fixture(['*KEYWORD', '*SET_NODE_GENERAL_TITLE', '73', row([970001], 10),
            ...Array.from({ length: 1000 }, () => record('PART', 2)), record('PART', 73), record('NODE', '&N'), '*END'].join('\n'), 25);
        const context = value.referenceIndex.parameterContextsByFile.get(value.filePath)[0];
        context.includeOffsets.idnoff = 100;
        context.includeOffsets.idpoff = 100;
        context.initialBindings = new Map([['N', { valueState: 'integer', value: 73 }]]);
        for (const [kind, line] of [['part', 1004], ['node', 1005]]) {
            const result = await lookup(value, { query: { id: 173, targetKinds: [kind], targetDefinitions: [] } });
            assert.deepEqual(result.occurrences.map(item => [item.fieldName, item.lineIndex]), [['E1', line]]);
            assert.ok(result.resolvedGaps.size > 0);
            assert.equal(result.gaps.length, 0);
        }
    });
    it('streams IGA tails and fixed native registrations after the preview limit without retaining unrelated IDs', async () => {
        for (const [keyword, kind, field, records] of [
            ['SET_IGA_FACE_UVW_COLLECT_TITLE', 'iga-face-xyz', 'EID1',
                ['IGA collection', row([970001], 10), ...Array.from({ length: 1000 }, () => row([2], 10)), row(['&N'], 10)]],
            ['AIRBAG_REFERENCE_GEOMETRY', 'node', 'NID',
                [...Array.from({ length: 1000 }, () => row([2], 8)), row(['&N'], 8)]],
        ]) {
            const value = await fixture(['*KEYWORD', '*' + keyword, ...records, '*END'].join('\n'), 25);
            const context = value.referenceIndex.parameterContextsByFile.get(value.filePath)[0];
            if (kind === 'node') context.includeOffsets.idnoff = 100;
            context.initialBindings = new Map([['N', { valueState: 'integer', value: 73 }]]);
            const result = await lookup(value, { query: { id: kind === 'node' ? 173 : 73, targetKinds: [kind], targetDefinitions: [] } });
            assert.deepEqual(result.occurrences.map(item => [item.fieldName, item.lineIndex]), [[field, records.length + 1]]);
            assert.ok(result.resolvedGaps.size > 0);
            assert.equal(result.gaps.length, 0);
        }
    });

    it('uses native long widths and repeated two-card boundaries, preserving comments and internal blank cards', async () => {
        const text = '*KEYWORD\n*ELEMENT_BEAM_OFFSET+\n' + row([1, 8, 1, 1, 0], 20) + '\n\n$ between records\n' +
            row([2, 73, 1, 73, 0], 20) + '\n' + row([0, 0], 20) + '\n*END\n';
        const value = await fixture(text);
        const result = await lookup(value);
        assert.deepEqual(result.occurrences.map(item => [item.fieldName, item.lineIndex, item.startCharacter]), [['N2', 5, 78]]);
        assert.deepEqual([...result.resolvedGaps].map(gap => gap.reason).sort(),
            ['registry-reference-native-layout-unavailable', 'registry-reference-preview-byte-limit']);
        assert.equal(result.gaps.length, 0);
    });

    it('resolves parameter values and INCLUDE offsets through existing occurrence binding', async () => {
        const value = await fixture(beamDeck.replace(row([2, 73, 1, 73, 0]), row([2, 73, 1, '&N', 0])));
        const context = value.referenceIndex.parameterContextsByFile.get(value.filePath)[0];
        context.includeOffsets.idnoff = 100;
        context.initialBindings = new Map([['N', { valueState: 'integer', value: 73 }]]);
        const result = await lookup(value, { query: { id: 173, targetKinds: ['node'], targetDefinitions: [] } });
        assert.equal(result.occurrences.length, 1);
        assert.equal(result.occurrences[0].fieldName, 'N2');
        assert.equal(result.resolvedGaps.size, 1);
        context.includeOffsets.idnoff = null;
        const uncertain = await lookup(value);
        assert.equal(uncertain.occurrences.length, 0);
        assert.equal(uncertain.resolvedGaps.size, 0);
    });

    it('retains gaps for read failures, cancellation, changed disk data, and unsaved documents without a current reader', async () => {
        const value = await fixture(beamDeck);
        const failed = await lookup(value, { scanBlockLines: async () => ({ complete: false, reason: 'fixture-read-failed' }) });
        assert.equal(failed.resolvedGaps.size, 0);
        assert.equal(failed.gaps[0].reason, 'fixture-read-failed');
        const token = { isCancellationRequested: false };
        const cancelled = await lookup(value, { cancellationToken: token, scanBlockLines: async () => {
            token.isCancellationRequested = true;
            return { cancelled: true };
        } });
        assert.equal(cancelled.cancelled, true);
        const changed = await lookup(value, { scanBlockLines: async (...args) => {
            const result = await scanBlockLinesFromDisk(...args);
            fs.appendFileSync(value.filePath, '$ changed\n');
            return result;
        } });
        assert.equal(changed.occurrences.length, 0);
        assert.equal(changed.resolvedGaps.size, 0);
        value.fileIndex.documentVersion = 1;
        const dirty = await lookup(value);
        assert.equal(dirty.scannedBlocks, 0);
    });

    it('keeps unmatched namespaces, dynamic layouts and result limits explicitly incomplete', async () => {
        const value = await fixture(beamDeck);
        const unrelated = { filePath: value.filePath, startLine: 1, reason: 'fixture-unresolved-target',
            scope: 'namespaces', targetKinds: ['node'], targetDefinitions: [] };
        value.referenceIndex.registryReferenceCoverageGaps.push(unrelated);
        const result = await lookup(value);
        assert.ok(!result.resolvedGaps.has(unrelated));
        assert.deepEqual(result.occurrences.map(item => item.fieldName), ['N2']);
        const capacity = await lookup(value, { query: { id: 1, targetKinds: ['node'], targetDefinitions: [] }, maxMatches: 1 });
        assert.equal(capacity.occurrences.length, 1);
        assert.equal(capacity.resolvedGaps.size, 0);
        const solid = await fixture(beamDeck.replace('ELEMENT_BEAM', 'ELEMENT_SOLID_ORTHO_DOF_TEN_NODES_FORMAT'));
        const unsupported = await lookup(solid);
        assert.equal(unsupported.scannedBlocks, 0);
    });
});
