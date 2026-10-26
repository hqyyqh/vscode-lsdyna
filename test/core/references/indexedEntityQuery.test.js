'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildFileIndex } = require('../../../src/core/scanner/fileIndexBuilder');
const {
    indexedEntityKinds,
    normalizeIndexedEntityId,
    queryIndexedEntityId,
} = require('../../../src/core/references/indexedEntityQuery');
const { EntityReferenceQueryService } = require('../../../src/core/references/entityReferenceQueryService');

describe('indexedEntityQuery', () => {
    it('does not mark a shared root failed when only one subscriber cancels', async () => {
        const rootFile = path.resolve('shared-cancellation.k');
        const snapshot = { rootFile, files: [rootFile], scope: 'single-file',
            graph: { includeOccurrences: [], includeOccurrencesComplete: true },
            fileIndexes: new Map([[rootFile, { keywordBlocks: [], parameterEvents: [],
                referenceDefinitions: { curves: [], tables: [], genericDefinitions: [] },
                registryReferences: { complete: true, referenceCoverage: { complete: true, gaps: [] },
                    referenceOccurrences: [], valueDomainOccurrences: [] } }]]) };
        const service = new EntityReferenceQueryService();
        let release, started;
        const begin = new Promise(resolve => { started = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        const context = { definitionKeywords: { generic: {}, onDemand: { MAT_TEST: { targetKind: 'material' } } },
            scanDefinitions: async () => { started(); await gate; return { state: 'complete', definitions: [], reasons: [] }; },
            collectReferences: () => ({ state: 'complete', locations: [], reasons: [] }) };
        const token = { isCancellationRequested: false };
        const first = service.queryById(snapshot, 1, 'material', { ...context, cancellationToken: token });
        const second = service.queryById(snapshot, 1, 'material', context);
        await begin; token.isCancellationRequested = true;
        await first; release();
        assert.equal((await second).state, 'missing');
        assert.equal(service.lifecycle(rootFile), 'ready');
    });
    it('reuses serialized unchanged files and invalidates a changed disk revision', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-query-cache-'));
        const filePath = path.join(root, 'nodes.k');
        try {
            fs.writeFileSync(filePath, '*KEYWORD\n*NODE\n       1               0               0               0\n*END\n');
            const fileIndex = await buildFileIndex(filePath);
            const snapshot = { rootFile: filePath, files: [filePath], scope: 'single-file',
                graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                fileIndexes: new Map([[filePath, fileIndex]]) };
            const service = new EntityReferenceQueryService();
            const { scanBlockLinesFromDisk } = require('../../../out/core/references/onDemandDefinitionScanner');
            let reads = 0;
            const context = { scanBlockLines: (...args) => { reads++; return scanBlockLinesFromDisk(...args); } };
            const first = await service.queryById(snapshot, 1, 'node', context);
            assert.equal(first.state, 'exact');
            const initialReads = reads;
            assert.ok(initialReads > 0);
            const repeated = await service.queryById({ ...snapshot, fileIndexes: new Map(snapshot.fileIndexes) }, 1, 'node', context);
            assert.deepEqual(repeated.locations, first.locations);
            assert.equal(reads, initialReads);
            await service.queryById({ ...snapshot, fileIndexes: new Map([[filePath, { ...fileIndex }]]) }, 1, 'node', context);
            assert.equal(reads, initialReads);
            fs.writeFileSync(filePath, '*KEYWORD\n*NODE\n       2               0               0               0\n$ changed\n*END\n');
            const changed = { ...snapshot, fileIndexes: new Map([[filePath, await buildFileIndex(filePath)]]) };
            assert.equal((await service.queryById(changed, 1, 'node', context)).state, 'missing');
            assert.equal((await service.queryById(changed, 2, 'node', context)).state, 'exact');
            assert.ok(reads > initialReads);
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
    it('checks an on-demand primary definition before assigning a same-ID fallback reference', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-target-priority-'));
        const filePath = path.join(root, 'priority.k');
        try {
            for (const primary of [true, false]) {
                fs.writeFileSync(filePath, ['*KEYWORD', '*DEFINE_CURVE', '        73', '         0         0',
                    ...(primary ? ['*NODE', '      73       0       0       0'] : []), '*END'].join('\n'));
                const fileIndex = await buildFileIndex(filePath);
                fileIndex.registryReferences = { complete: true, referenceCoverage: { complete: true, gaps: [] },
                    referenceOccurrences: [{ filePath, keyword: '*TEST_SOURCE', fieldName: 'ID', lineIndex: 3,
                        startCharacter: 0, endCharacter: 2, targetKinds: ['node', 'curve'], targetDefinitions: [],
                        referenceValue: { kind: 'numeric', id: 73, raw: '73', targetSearch: [
                            { targetKinds: ['node'], targetKeywords: ['*NODE'] },
                            { targetKinds: ['curve'], targetKeywords: ['*DEFINE_CURVE'] }] } }], valueDomainOccurrences: [] };
                const snapshot = { rootFile: filePath, files: [filePath], scope: 'single-file',
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true }, fileIndexes: new Map([[filePath, fileIndex]]) };
                for (const kind of ['node', 'curve']) {
                    const result = await queryIndexedEntityId({ snapshot, id: 73, targetKind: kind });
                    const matches = result.locations.filter(location => location.role === 'reference');
                    assert.equal(matches.length, kind === (primary ? 'node' : 'curve') ? 1 : 0,
                        JSON.stringify({ primary, kind, state: result.state, reasons: result.reasons }));
                    assert.ok(result.locations.filter(location => location.role === 'definition')
                        .every(location => location.entityKind === kind));
                }
                assert.equal(fileIndex.registryReferences.referenceOccurrences[0].referenceValue.id, 73);
            }
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
    it('does not report missing or complete when a result has unusable coordinates', async () => {
        const filePath = path.resolve('indexed-entity', 'coordinates.k');
        const snapshot = { rootFile: filePath, files: [filePath], scope: 'single-file',
            graph: { includeOccurrences: [], includeOccurrencesComplete: true },
            fileIndexes: new Map([[filePath, { keywordBlocks: [], parameterEvents: [],
                referenceDefinitions: { curves: [], tables: [], genericDefinitions: [] },
                registryReferences: { complete: true, referenceOccurrences: [], valueDomainOccurrences: [] } }]]) };
        const valid = { filePath, idLine: 1, idStartChar: 0, idEndChar: 2, keyword: '*MAT_TEST' };
        const context = definitions => ({
            definitionKeywords: { generic: {}, onDemand: { MAT_TEST: { targetKind: 'material' } } },
            collectReferences: () => ({ state: 'complete', locations: [], reasons: [] }),
            scanDefinitions: async () => ({ state: 'complete', definitions, reasons: [] }),
        });
        for (const invalid of [{ ...valid, idEndChar: undefined }, { ...valid, idLine: -1 },
            { ...valid, idStartChar: -1 }, { ...valid, idEndChar: -1 }, { ...valid, idLine: 1.5 },
            { ...valid, idStartChar: 3 }, { ...valid, idLine: Number.MAX_SAFE_INTEGER + 1 }]) {
            for (const role of ['definition', 'reference']) {
                const options = role === 'definition' ? context([invalid]) : { ...context([]),
                    collectReferences: () => ({ state: 'complete', reasons: [], locations: [{ filePath,
                        line: invalid.idLine, startCharacter: invalid.idStartChar, endCharacter: invalid.idEndChar }] }) };
                const query = await queryIndexedEntityId({ snapshot, id: 17, targetKind: 'material', ...options });
                assert.equal(query.state, 'incomplete');
                assert.deepEqual(query.locations, []);
                assert.ok(query.reasons.includes('entity-query-location-unavailable'));
                const service = await new EntityReferenceQueryService().queryById(snapshot, 17, 'material', options);
                assert.equal(service.state, 'indeterminate');
            }
        }
        const partial = await queryIndexedEntityId({ snapshot, id: 17, targetKind: 'material',
            ...context([valid, { ...valid, idEndChar: undefined }]) });
        assert.equal(partial.state, 'partial');
        assert.equal(partial.locations.length, 1);
        const duplicate = await queryIndexedEntityId({ snapshot, id: 17, targetKind: 'material', ...context([valid, valid]) });
        assert.equal(duplicate.state, 'complete');
        assert.equal(duplicate.locations.length, 1);
    });

    it('uses verified owning IDs for display and never promotes a referenced ID', async () => {
        const filePath = path.resolve('semantic-display.k');
        const blocks = [
            { keyword: '*PART', startLine: 0, endLine: 3, displayIdentity: { confidence: 'verified',
                title: 'Bumper', identity: { field: 'PID', value: '12' } } },
            { keyword: '*PART', startLine: 4, endLine: 7, displayIdentity: { confidence: 'verified',
                identity: { field: 'MID', value: '3' } } },
            { keyword: '*MAT_ELASTIC_TITLE', startLine: 8, endLine: 11, displayIdentity: {
                confidence: 'verified', title: 'Steel', identity: { field: 'MID', value: '3' } } },
            { keyword: '*ELEMENT_SHELL', startLine: 12, endLine: 15, displayIdentity: {
                confidence: 'verified', title: 'First element', identity: { field: 'EID', value: '100' } } },
        ];
        const location = line => ({ filePath, line, startCharacter: 0, endCharacter: 10 });
        const result = await queryIndexedEntityId({
            snapshot: { rootFile: filePath, scope: 'single-file', files: [filePath],
                graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                fileIndexes: new Map([[filePath, { keywordBlocks: blocks, parameterEvents: [],
                    referenceDefinitions: { curves: [], tables: [], genericDefinitions: [] },
                    registryReferences: { complete: true, referenceOccurrences: [], valueDomainOccurrences: [] } }]]) },
            id: 3, targetKind: 'material',
            definitionKeywords: { generic: { PART: { targetKind: 'part', fieldName: 'PID' } },
                onDemand: { MAT_ELASTIC_TITLE: { targetKind: 'material', fieldName: 'MID' },
                    ELEMENT_SHELL: { targetKind: 'element', fieldName: 'EID', recordMode: 'exact-data-record-ordinal' } } },
            collectReferences: () => ({ state: 'complete', locations: [location(2), location(6), location(15)], reasons: [] }),
            scanDefinitions: async () => ({ state: 'complete', definitions: [{ ...location(10),
                idLine: 10, idStartChar: 0, idEndChar: 10, keyword: '*MAT_ELASTIC_TITLE' }], reasons: [] }),
        });
        assert.equal(result.locations[0].entityId, '3');
        assert.equal(result.locations[0].entityName, 'Steel');
        assert.equal(result.locations[1].entityId, '12');
        assert.equal(result.locations[1].entityKind, 'part');
        assert.equal(result.locations[1].entityName, 'Bumper');
        assert.equal(result.locations[2].entityId, undefined);
        assert.equal(result.locations[2].entityKind, 'part');
        assert.equal(result.locations[3].entityId, undefined);
        assert.equal(result.locations[3].entityKind, 'element');
        assert.equal(result.locations[3].entityName, undefined);
    }).timeout(10000);
    it('normalizes positive integer and bounded alphanumeric identities', function () {
        this.timeout(10000);
        assert.equal(normalizeIndexedEntityId(' 2000101 '), 2000101);
        assert.equal(normalizeIndexedEntityId('+17'), 17);
        assert.equal(normalizeIndexedEntityId('0017'), 17);
        for (const value of [Infinity, NaN, false, 17n, { toString: () => '17' }]) {
            assert.equal(normalizeIndexedEntityId(value), null);
        }
        assert.equal(normalizeIndexedEntityId('MAT_LABEL_1'), 'MAT_LABEL_1');
        assert.equal(normalizeIndexedEntityId('0'), null);
        assert.equal(normalizeIndexedEntityId('-1'), null);
        assert.equal(normalizeIndexedEntityId('&MID'), null);
        assert.ok(indexedEntityKinds().includes('material'));
        assert.ok(indexedEntityKinds().includes('curve'));
        const kinds = indexedEntityKinds({ definitionKeywords: {}, referenceKeywords: {
            FIXTURE: [{ targetDefinitionUnavailable: true, relation: {
                kind: 'entity-reference', targetKinds: ['reference-only-fixture'], targetKeywords: [],
            } }],
        } });
        assert.ok(kinds.includes('reference-only-fixture'), 'A known reference namespace remains queryable without a definition selector');
    });

    it('finds PART/MID through its native ordered material target without changing LS-PrePost namespaces', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-indexed-entity-'));
        const filePath = path.join(tempRoot, 'large.key');
        fs.writeFileSync(filePath, [
            '*KEYWORD',
            '*DEFINE_CURVE',
            '   2000101         0',
            '       0.0       1.0',
            '*LOAD_BODY_Z',
            '   2000101       1.0',
            '*PART',
            'material part',
            '         1         1   2000101         0         0         0         0         0',
            '*MAT_ELASTIC',
            '   20001011.82900E-9     300.0       0.3       0.0       0.0       0.0',
            '*END',
        ].join('\n'), 'utf8');

        try {
            const fileIndex = await buildFileIndex(filePath, { largeFileThresholdBytes: 0 });
            assert.ok(fileIndex.largeFileLineMap, 'Exercise the large-file index contract');
            const result = await queryIndexedEntityId({
                snapshot: {
                    scope: 'single-file',
                    rootFile: filePath,
                    files: [filePath],
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                    fileIndexes: new Map([[filePath, fileIndex]]),
                },
                id: 2000101,
                targetKind: 'material',
            });

            assert.equal(result.state, 'complete', JSON.stringify(result.reasons));
            assert.deepEqual(result.reasons, []);
            assert.equal(result.scope, 'single-file');
            assert.deepEqual(
                result.locations.map(location => ({
                    role: location.role,
                    keyword: location.keyword,
                    fieldName: location.fieldName,
                    line: location.line,
                })),
                [
                    { role: 'definition', keyword: '*MAT_ELASTIC', fieldName: 'MID', line: 10 },
                    { role: 'reference', keyword: '*PART', fieldName: 'MID', line: 8 },
                ],
            );
            assert.ok(result.locations[1].sourceRuleId.startsWith('lspp:14:PART:2:2:'));
            const lspp = fileIndex.registryReferences.referenceOccurrences.filter(item =>
                item.fieldName === 'MID' && item.sourceRuleId.startsWith('lspp:'));
            assert.equal(lspp.length, 1);
            assert.deepEqual(lspp[0].referenceValue.targetSearch.map(target => target.targetKinds), [['material'], ['ispg']]);
            assert.equal(lspp[0].targetKinds.includes('icfd-material'), false, 'ICFD_PART native fields must not be assigned to PART');
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('continues definition lookup when explicit reference coverage is incomplete', async () => {
        const filePath = path.resolve('indexed-entity', 'incomplete.k');
        const result = await queryIndexedEntityId({
            snapshot: {
                scope: 'single-file',
                rootFile: filePath,
                files: [filePath],
                graph: { includeOccurrences: [] },
                fileIndexes: new Map([[filePath, {
                    parameterEvents: [],
                    referenceDefinitions: { curves: [], tables: [], genericDefinitions: [] },
                    registryReferences: {
                        complete: false,
                        reasons: ['registry-reference-capacity-exceeded'],
                        referenceOccurrences: [],
                        valueDomainOccurrences: [],
                    },
                }]]),
            },
            id: 2000101,
            targetKind: 'material',
            scanDefinitions: async () => ({
                state: 'complete',
                definitions: [{ filePath, idLine: 4, idStartChar: 0, idEndChar: 7,
                    keyword: '*MAT_ELASTIC', fieldName: 'ID' }],
                reasons: [],
            }),
        });

        assert.equal(result.state, 'partial');
        assert.deepEqual(result.locations.map(location => location.role), ['definition']);
        assert.ok(result.reasons.some(reason => reason.includes('registry-reference-capacity-exceeded')));
    });

    it('injects the caller block reader into on-demand definition scanning', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-indexed-reader-'));
        const filePath = path.join(tempRoot, 'reader.key');
        fs.writeFileSync(filePath, '*MAT_ELASTIC\n         1\n', 'utf8');
        const marker = async () => ({ complete: true, lineCount: 0 });
        let received = null;
        try {
            const fileIndex = await buildFileIndex(filePath);
            const query = await queryIndexedEntityId({
                snapshot: {
                    scope: 'single-file', rootFile: filePath, files: [filePath],
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                    fileIndexes: new Map([[filePath, fileIndex]]),
                },
                id: 1,
                targetKind: 'material',
                scanBlockLines: marker,
                scanDefinitions: async options => {
                    received = options.scanBlockLines;
                    return { state: 'complete', definitions: [], reasons: [] };
                },
            });

            assert.equal(query.state, 'complete');
            assert.strictEqual(received, marker);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('returns verified partial locations without claiming unresolved project occurrences are complete', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-indexed-partial-'));
        const filePath = path.join(tempRoot, 'partial.key');
        fs.writeFileSync(filePath, '*MAT_ELASTIC\n   2000102\n', 'utf8');
        try {
            const fileIndex = await buildFileIndex(filePath);
            const query = await queryIndexedEntityId({
                snapshot: {
                    scope: 'project', rootFile: filePath, files: [filePath],
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                    fileIndexes: new Map([[filePath, fileIndex]]),
                },
                id: 2000102,
                targetKind: 'material',
                collectReferences: (_referenceIndex, _query, options) => {
                    assert.equal(options.retainVerifiedMatchesOnIncomplete, true);
                    return {
                        state: 'partial',
                        locations: [{
                            filePath, line: 8, startCharacter: 23, endCharacter: 30,
                        }],
                        reasons: [
                            `${filePath}:20:transform-offset-unresolved`,
                            `${filePath}:40:transform-offset-unresolved`,
                        ],
                    };
                },
                scanDefinitions: async () => ({
                    state: 'partial',
                    definitions: [{
                        filePath, idLine: 1, idStartChar: 3, idEndChar: 10,
                        keyword: '*MAT_ELASTIC', fieldName: 'ID',
                    }],
                    reasons: ['occurrence-search-path-unavailable'],
                }),
            });

            assert.equal(query.state, 'partial');
            assert.deepEqual(query.locations.map(location => location.role), ['definition', 'reference']);
            assert.deepEqual(query.reasons, [
                'occurrence-search-path-unavailable',
                'transform-offset-unresolved (2 occurrences)',
            ]);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
