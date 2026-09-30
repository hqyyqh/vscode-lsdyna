const assert = require('assert');
const path = require('path');
const {
    definitionRecordMode,
    fixedCandidateWidths,
    globalInputFormatFromKeywordLine,
    keywordInputFormat,
    mergeOnDemandDefinitions,
    parseOnDemandIdCandidates,
    queryOnDemandDefinitionAtPosition,
    runtimeDefinitionKeywords,
    scanOnDemandDefinitions,
    selectOnDemandDefinitionDescriptors,
} = require('../../../out/core/references/onDemandDefinitionScanner');
const familyScannerHandoff = require('../../../keywords/family_definition_scanner_handoff.json');

const NODE_DESCRIPTOR = {
    keyword: 'NODE',
    target: 'NODE',
    targetKind: 'node',
    cardIndex: 1,
    fieldIndex: 0,
    fieldName: 'NID',
    fieldType: 'integer',
    position: 0,
    width: 8,
    ruleId: 'rule:node',
    evidenceIds: ['evidence:node'],
};

const TEST_DEFINITION_KEYWORDS = {
    onDemand: { NODE: NODE_DESCRIPTOR },
};

describe('onDemandDefinitionScanner', () => {
    it('reuses the immutable runtime descriptor view', () => {
        assert.strictEqual(runtimeDefinitionKeywords(), runtimeDefinitionKeywords());
        assert.strictEqual(
            runtimeDefinitionKeywords({ allowCandidate: true }),
            runtimeDefinitionKeywords({ allowCandidate: true }),
        );
    });

    it('selects only official on-demand descriptors for the resolved namespace', () => {
        const node = selectOnDemandDefinitionDescriptors(['node'], []);
        const element = selectOnDemandDefinitionDescriptors(['element'], []);

        assert.deepEqual(node.map(item => item.keyword), ['NODE']);
        assert.equal(element.length, 12);
        assert.ok(element.some(item => item.keyword === 'ELEMENT_SHELL'));
        assert.ok(!node.some(item => item.keyword === 'NODE_TRANSFORM'));
        assert.deepEqual(
            selectOnDemandDefinitionDescriptors([], ['NODE']).map(item => item.keyword),
            ['NODE'],
        );
    });

    it('uses the official standard, I10, long, and comma field forms without whitespace tokenization', () => {
        assert.deepEqual(fixedCandidateWidths(NODE_DESCRIPTOR, 'standard'), [8]);
        assert.deepEqual(fixedCandidateWidths(NODE_DESCRIPTOR, 'i10'), [10]);
        assert.deepEqual(fixedCandidateWidths(NODE_DESCRIPTOR, 'long'), [20]);

        const standard = parseOnDemandIdCandidates('    1001', NODE_DESCRIPTOR, {
            formatMode: 'standard',
        });
        const i10 = parseOnDemandIdCandidates('      1001', NODE_DESCRIPTOR, {
            formatMode: 'i10',
        });
        const long = parseOnDemandIdCandidates('                1001', NODE_DESCRIPTOR, {
            formatMode: 'long',
        });
        const comma = parseOnDemandIdCandidates('1001,0.0,0.0,0.0', NODE_DESCRIPTOR);

        assert.deepEqual(standard.map(item => [item.input.value, item.startCharacter]), [[1001, 4]]);
        assert.deepEqual(i10.map(item => [item.input.value, item.startCharacter]), [[1001, 6]]);
        assert.deepEqual(long.map(item => [item.input.value, item.startCharacter]), [[1001, 16]]);
        assert.deepEqual(comma.map(item => [item.input.value, item.startCharacter]), [[1001, 0]]);
        assert.deepEqual(parseOnDemandIdCandidates('1001 0 0', NODE_DESCRIPTOR), []);

        const packed = '1234567887654321';
        assert.equal(
            parseOnDemandIdCandidates(packed, NODE_DESCRIPTOR, { formatMode: 'standard' })[0].input.value,
            12345678,
        );
        assert.equal(
            parseOnDemandIdCandidates(packed, NODE_DESCRIPTOR, { formatMode: 'i10' })[0].input.value,
            1234567887,
        );
    });

    it('parses official alphanumeric label identities in fixed, long, and comma forms', () => {
        const descriptor = familyScannerHandoff.descriptors.find(item =>
            item.keyword === 'MAT_024'
        );
        assert.equal(definitionRecordMode(descriptor), 'exact-data-record-ordinal');
        assert.deepEqual(
            parseOnDemandIdCandidates('  HS Steel', descriptor).map(item => item.input),
            [{ kind: 'label', raw: 'HS Steel', value: 'HS Steel' }],
        );
        assert.deepEqual(
            parseOnDemandIdCandidates('            HS Steel', descriptor, { formatMode: 'long' })
                .map(item => item.input.value),
            ['HS Steel'],
        );
        assert.deepEqual(
            parseOnDemandIdCandidates('HS Steel,7.8e-9', descriptor).map(item => item.input.value),
            ['HS Steel'],
        );
    });

    it('uses exact base/TITLE physical data ordinals while preserving repeated NODE records', async () => {
        const byKeyword = keyword => familyScannerHandoff.descriptors.find(item =>
            item.keyword === keyword
        );
        const scan = async (descriptor, effectiveId, lines) => scanOnDemandDefinitions({
            fileIndexes: new Map([[path.resolve('family.k'), {
                keywordBlocks: [{
                    filePath: path.resolve('family.k'),
                    keyword: `*${descriptor.keyword}`,
                    rawKeyword: `*${descriptor.keyword}`,
                    startLine: 0,
                    endLine: lines.length,
                }],
            }]]),
            effectiveId,
            targetDefinitions: [descriptor.keyword],
            projectScoped: false,
            definitionKeywords: { onDemand: { [descriptor.keyword]: descriptor } },
            scanBlockLines: async (_block, visitLine) => {
                for (let index = 0; index < lines.length; index++) {
                    await visitLine(lines[index], index + 1, {
                        keywordLineText: `*${descriptor.keyword}`,
                    });
                }
                return { complete: true, lineCount: lines.length };
            },
        });

        const base = byKeyword('MAT_024');
        const laterOnly = await scan(base, 42, ['$ comment', '         7', '        42']);
        assert.equal(laterOnly.definitions.length, 0);
        const baseHit = await scan(base, 7, ['  $ indented comment', '         7', '         7']);
        assert.equal(baseHit.definitions.length, 1);
        assert.equal(baseHit.definitions[0].idLine, 2);

        const title = byKeyword('MAT_024_TITLE');
        const titleHit = await scan(title, 'HS Steel', [
            '$# title',
            'material title',
            '  HS Steel',
            '  HS Steel',
        ]);
        assert.equal(titleHit.definitions.length, 1);
        assert.equal(titleHit.definitions[0].idLine, 3);

        const blankConsumesOrdinal = await scan(base, 7, ['', '         7']);
        assert.equal(blankConsumesOrdinal.definitions.length, 0);
        assert.equal(definitionRecordMode(NODE_DESCRIPTOR), 'repeat-all-data-records');
    });

    it('honors deck-wide and per-keyword input format controls', () => {
        assert.equal(globalInputFormatFromKeywordLine('*KEYWORD LONG=Y'), 'long');
        assert.equal(globalInputFormatFromKeywordLine('*KEYWORD LONG=K'), 'long');
        assert.equal(globalInputFormatFromKeywordLine('*KEYWORD LONG=S', 'long'), 'standard');
        assert.equal(globalInputFormatFromKeywordLine('*KEYWORD I10=Y'), 'i10');
        assert.equal(keywordInputFormat('*NODE+', 'standard'), 'long');
        assert.equal(keywordInputFormat('*NODE +', 'standard'), 'long');
        assert.equal(keywordInputFormat('*NODE %', 'standard'), 'i10');
        assert.equal(keywordInputFormat('*NODE-', 'long'), 'standard');
        assert.equal(keywordInputFormat('*NODE', 'long'), 'long');
    });

    it('maps one streamed physical ID through its Include occurrence IDFOFF', async () => {
        const filePath = path.resolve('model', 'nodes.k');
        const fileIndexes = new Map([[filePath, {
            keywordBlocks: [{
                filePath,
                keyword: '*NODE',
                rawKeyword: '*NODE',
                startLine: 10,
                endLine: 12,
            }],
        }]]);
        const referenceIndex = {
            parameterContextsByFile: new Map([[filePath, [{
                occurrenceId: 'root:nodes',
                occurrencePath: ['root', 'root:nodes'],
                occurrencePathLabels: ['root', 'main.k:2 -> nodes.k'],
                idfoffOffset: 100,
                initialBindings: new Map(),
                initialUncertaintyReasons: [],
                timeline: [],
                uncertaintyReasons: [],
            }]]]),
        };
        const scanBlockLines = async (_block, visitLine) => {
            await visitLine('    1001', 11, { keywordLineText: '*NODE' });
            await visitLine('    1002', 12, { keywordLineText: '*NODE' });
            return { complete: true, keywordLineText: '*NODE', lineCount: 2 };
        };

        const lookup = await scanOnDemandDefinitions({
            referenceIndex,
            fileIndexes,
            effectiveId: 1101,
            targetKinds: ['node'],
            projectScoped: true,
            scanBlockLines,
            definitionKeywords: TEST_DEFINITION_KEYWORDS,
        });

        assert.equal(lookup.state, 'complete');
        assert.equal(lookup.scannedLineCount, 2);
        assert.equal(lookup.definitions.length, 1);
        assert.equal(lookup.definitions[0].sourceId, 1001);
        assert.equal(lookup.definitions[0].effectiveId, 1101);
        assert.equal(lookup.definitions[0].idfoffOffset, 100);
        assert.equal(lookup.definitions[0].idLine, 11);
        assert.equal(lookup.definitions[0].idStartChar, 4);
    });

    it('maps a definition-origin query through one occurrence and rejects ambiguous occurrences', () => {
        const filePath = path.resolve('model', 'origin-nodes.k');
        const lines = ['*NODE', '    1001', '    1002'];
        const fileIndex = { keywordBlocks: [{
            filePath,
            keyword: '*NODE',
            rawKeyword: '*NODE',
            startLine: 0,
            endLine: 2,
        }] };
        const context = offset => ({
            occurrenceId: `root:nodes:${offset}`,
            occurrencePath: ['root', `root:nodes:${offset}`],
            occurrencePathLabels: ['root', `nodes:${offset}`],
            idfoffOffset: offset,
            inputFormatMode: 'standard',
            initialBindings: new Map(),
            initialUncertaintyReasons: [],
            timeline: [],
            uncertaintyReasons: [],
        });
        const query = contexts => queryOnDemandDefinitionAtPosition({
            referenceIndex: { parameterContextsByFile: new Map([[filePath, contexts]]) },
            fileIndex,
            filePath,
            position: { line: 1, character: 5 },
            projectScoped: true,
            lineAt: index => lines[index],
            definitionKeywords: TEST_DEFINITION_KEYWORDS,
        });

        const ready = query([context(100)]);
        assert.equal(ready.state, 'ready');
        assert.equal(ready.query.id, 1101);
        assert.deepEqual(ready.query.targetKinds, ['node']);
        assert.equal(ready.declarations[0].line, 1);

        const same = query([context(100), context(100)]);
        assert.equal(same.state, 'ready');
        assert.equal(same.query.id, 1101);

        const ambiguous = query([context(100), context(200)]);
        assert.equal(ambiguous.state, 'ambiguous');
        assert.deepEqual(ambiguous.reasons, ['definition-occurrence-ambiguous']);
    });

    it('fails closed for label offsets, stale structure, comments, and non-ID cells', () => {
        const descriptor = familyScannerHandoff.descriptors.find(item => item.keyword === 'MAT_024');
        const filePath = path.resolve('model', 'origin-material.k');
        const lines = ['*MAT_024', '  HS Steel', '        42'];
        const fileIndex = { keywordBlocks: [{
            filePath,
            keyword: '*MAT_024',
            rawKeyword: '*MAT_024',
            startLine: 0,
            endLine: 2,
        }] };
        const referenceIndex = { parameterContextsByFile: new Map([[filePath, [{
            occurrenceId: 'root:mat', occurrencePath: [], occurrencePathLabels: [],
            idfoffOffset: 1, inputFormatMode: 'standard', initialBindings: new Map(),
            initialUncertaintyReasons: [], timeline: [], uncertaintyReasons: [],
        }]]]) };
        const query = overrides => queryOnDemandDefinitionAtPosition({
            referenceIndex, fileIndex, filePath, position: { line: 1, character: 4 },
            projectScoped: true, lineAt: index => lines[index],
            definitionKeywords: { onDemand: { MAT_024: descriptor } },
            ...overrides,
        });
        assert.deepEqual(query().reasons, ['label-idfoff-unsupported']);
        assert.equal(query({ position: { line: 2, character: 9 } }).state, 'none');
        assert.equal(query({ lineAt: () => undefined }).state, 'incomplete');
        assert.equal(query({ fileIndex: { keywordBlocks: [{
            filePath, keyword: '*COMMENT', startLine: 0, endLine: 2,
        }] } }).state, 'none');
    });

    it('resolves a parameterized definition only from the occurrence parameter timeline', async () => {
        const filePath = path.resolve('model', 'parameter-nodes.k');
        const binding = {
            name: 'NODEID',
            value: 42,
            valueState: 'integer',
        };
        const referenceIndex = {
            parameterContextsByFile: new Map([[filePath, [{
                occurrenceId: 'root:nodes',
                occurrencePath: ['root', 'root:nodes'],
                occurrencePathLabels: ['root', 'parameter-nodes.k'],
                idfoffOffset: 0,
                initialBindings: new Map([['NODEID', binding]]),
                initialUncertaintyReasons: [],
                timeline: [],
                uncertaintyReasons: [],
            }]]]),
        };
        const lookup = await scanOnDemandDefinitions({
            referenceIndex,
            fileIndexes: new Map([[filePath, {
                keywordBlocks: [{ filePath, keyword: '*NODE', startLine: 0, endLine: 1 }],
            }]]),
            effectiveId: 42,
            targetDefinitions: ['NODE'],
            projectScoped: true,
            scanBlockLines: async (_block, visitLine) => {
                await visitLine(' &NODEID', 1, { keywordLineText: '*NODE' });
                return { complete: true, keywordLineText: '*NODE', lineCount: 1 };
            },
            definitionKeywords: TEST_DEFINITION_KEYWORDS,
        });

        assert.equal(lookup.state, 'complete');
        assert.equal(lookup.definitions.length, 1);
        assert.equal(lookup.definitions[0].sourceId, 42);
        assert.equal(lookup.definitions[0].parameterResolution.resolved, true);
    });

    it('parses one physical block under each Include occurrence input-format mode', async () => {
        const filePath = path.resolve('model', 'mixed-format-nodes.k');
        const makeContext = (occurrenceId, inputFormatMode) => ({
            occurrenceId,
            occurrencePath: ['root', occurrenceId],
            occurrencePathLabels: ['root', occurrenceId],
            idfoffOffset: 0,
            inputFormatMode,
            initialBindings: new Map(),
            initialUncertaintyReasons: [],
            timeline: [],
            uncertaintyReasons: [],
        });
        const lookup = await scanOnDemandDefinitions({
            referenceIndex: {
                parameterContextsByFile: new Map([[filePath, [
                    makeContext('root:standard', 'standard'),
                    makeContext('root:long', 'long'),
                ]]]),
            },
            fileIndexes: new Map([[filePath, {
                keywordBlocks: [{ filePath, keyword: '*NODE', startLine: 0, endLine: 1 }],
            }]]),
            effectiveId: 17,
            targetKinds: ['node'],
            projectScoped: true,
            scanBlockLines: async (_block, visitLine) => {
                await visitLine('                  17', 1, { keywordLineText: '*NODE' });
                return { complete: true, keywordLineText: '*NODE', lineCount: 1 };
            },
            definitionKeywords: TEST_DEFINITION_KEYWORDS,
        });

        assert.equal(lookup.state, 'complete');
        assert.equal(lookup.definitions.length, 1);
        assert.equal(lookup.definitions[0].occurrenceId, 'root:long');
        assert.equal(lookup.definitions[0].idStartChar, 18);
    });

    it('keeps unresolved definition inputs partial and merges complete coverage conservatively', async () => {
        const filePath = path.resolve('model', 'dynamic-nodes.k');
        const partial = await scanOnDemandDefinitions({
            referenceIndex: { parameterContextsByFile: new Map() },
            fileIndexes: new Map([[filePath, {
                keywordBlocks: [{ filePath, keyword: '*NODE', startLine: 0, endLine: 1 }],
            }]]),
            effectiveId: 7,
            targetKinds: ['node'],
            projectScoped: false,
            scanBlockLines: async (_block, visitLine) => {
                await visitLine('  <NID>', 1, { keywordLineText: '*NODE' });
                return { complete: true, keywordLineText: '*NODE', lineCount: 1 };
            },
            definitionKeywords: TEST_DEFINITION_KEYWORDS,
        });
        assert.equal(partial.state, 'partial');
        assert.ok(partial.reasons.includes('on-demand-definition-expression'));

        const complete = mergeOnDemandDefinitions({
            state: 'uncertain',
            definitions: [],
            reasons: ['target-kind-on-demand'],
            id: 7,
        }, {
            state: 'complete',
            definitions: [{ filePath, id: 7 }],
            reasons: [],
        });
        assert.equal(complete.state, 'exact');
        assert.deepEqual(complete.reasons, []);

        const stillPartial = mergeOnDemandDefinitions({
            state: 'uncertain',
            definitions: [],
            reasons: ['target-kind-on-demand'],
        }, partial);
        assert.equal(stillPartial.state, 'uncertain');
        assert.ok(stillPartial.reasons.includes('target-kind-on-demand'));
    });

    it('does not publish a partial result after cancellation', async () => {
        const token = { isCancellationRequested: false };
        const filePath = path.resolve('model', 'cancelled-nodes.k');
        const lookup = await scanOnDemandDefinitions({
            referenceIndex: { parameterContextsByFile: new Map() },
            fileIndexes: new Map([[filePath, {
                keywordBlocks: [{ filePath, keyword: '*NODE', startLine: 0, endLine: 2 }],
            }]]),
            effectiveId: 1,
            targetKinds: ['node'],
            projectScoped: false,
            cancellationToken: token,
            scanBlockLines: async (_block, visitLine) => {
                await visitLine('       1', 1, { keywordLineText: '*NODE' });
                token.isCancellationRequested = true;
                return { complete: false, cancelled: true, lineCount: 1 };
            },
            definitionKeywords: TEST_DEFINITION_KEYWORDS,
        });

        assert.equal(lookup.state, 'cancelled');
    });
});
