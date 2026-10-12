'use strict';

const assert = require('node:assert');
const path = require('node:path');

const {
    buildProjectReferenceIndex,
} = require('../../../out/core/references/projectReferenceIndex');
const {
    collectRegistryReferenceMatches,
    definitionAtPosition,
    definitionLocations,
    namespaceMatches,
    queryFromReferenceSource,
} = require('../../../out/core/references/registryReferenceNetwork');
const {
    getRegistryApprovedFieldReferenceInfo,
    parseFieldReferenceValue,
} = require('../../../out/core/references/fieldReferenceClassifier');
const registry = require("../../../keywords/runtime/definitions/definition_registry.json");
const { EntityReferenceQueryService } = require('../../../out/core/references/entityReferenceQueryService');

function emptyRegistryReferences(overrides = {}) {
    return {
        complete: true,
        reasons: [],
        referenceOccurrences: [],
        valueDomainOccurrences: [],
        ...overrides,
    };
}

function signedPartOccurrence(filePath, id = 17) {
    const info = getRegistryApprovedFieldReferenceInfo({
        keyword: 'PART',
        cardIndex: 2,
        field: { n: 'ADPOPT', t: 'integer', p: 60, w: 10 },
    });
    return {
        filePath,
        keyword: '*PART',
        cardIndex: 2,
        fieldName: 'ADPOPT',
        lineIndex: 2,
        startCharacter: 67,
        endCharacter: 70,
        rawValue: `-${id}`,
        authoringRelationId: info.definitionRegistry.authoringRelationId,
        coordinateId: info.definitionRegistry.coordinateId,
        sourceRuleId: info.ruleId,
        referenceValue: parseFieldReferenceValue(`-${id}`, info),
        targetKinds: ['curve'],
        targetDefinitions: [],
    };
}

function curve(filePath, id = 17, line = 7) {
    const raw = String(id);
    return {
        kind: 'curve', id, idRaw: raw, filePath, keyword: '*DEFINE_CURVE',
        startLine: line - 1, endLine: line + 2, idLine: line,
        idStartChar: 10 - raw.length, idEndChar: 10, points: [],
    };
}

function part(filePath, id = 42, line = 2) {
    const raw = String(id);
    return {
        kind: 'generic', id, idRaw: raw, filePath, keyword: '*PART',
        targetKeyword: 'PART', targetKind: 'part',
        ruleId: 'rule:da4aa6b06d895cb13ae9120b',
        evidenceIds: ['evidence:c05c75b0b88afcbdc9057f5d'],
        startLine: line - 2, endLine: line, idLine: line,
        idStartChar: 10 - raw.length, idEndChar: 10,
    };
}

function setPart(filePath, id = 1000001, line = 1) {
    const raw = String(id);
    return {
        kind: 'generic', id, idRaw: raw, filePath, keyword: '*SET_PART',
        targetKeyword: 'SET_PART', targetKind: 'part-set',
        ruleId: 'rule:94d1738d89bdf682dd5fc3bb',
        evidenceIds: ['evidence:a347e4e065b89b286fac2b17'],
        startLine: line - 1, endLine: line, idLine: line,
        idStartChar: 10 - raw.length, idEndChar: 10,
    };
}

function materialLabel(filePath, id = 'HS Steel', line = 2) {
    return {
        kind: 'generic', id, idRaw: id, idInput: { kind: 'label', raw: id, value: id },
        filePath, keyword: '*MAT_024', targetKeyword: 'MAT', targetKind: 'material',
        startLine: line - 2, endLine: line + 2, idLine: line,
        idStartChar: 10 - id.length, idEndChar: 10,
        definitionRegistry: {
            approved: true,
            authoringRelationId: 'family-scanner-fixture:material',
            coordinateId: 'family-scanner-fixture:mid',
            sourceRuleId: 'family-scanner-fixture:rule',
            decisionId: 'family-scanner-fixture:decision',
        },
    };
}

function exactDefinition(filePath, keyword, targetKind, id = 77, line = 2) {
    const raw = String(id);
    return {
        kind: 'generic', id, idRaw: raw, filePath, keyword: `*${keyword}`,
        targetKeyword: keyword, targetKind,
        startLine: line - 1, endLine: line + 1, idLine: line,
        idStartChar: 10 - raw.length, idEndChar: 10,
        definitionRegistry: {
            approved: true,
            authoringRelationId: `exact-scanner-fixture:${keyword}`,
            coordinateId: `exact-scanner-fixture:${targetKind}`,
            sourceRuleId: 'exact-scanner-fixture:rule',
            decisionId: 'exact-scanner-fixture:decision',
        },
    };
}

function completeSnapshot(rootFile, sourceFile, definitionFile, occurrence, definitions) {
    const files = [...new Set([rootFile, sourceFile, definitionFile])];
    return {
        rootFile,
        files,
        graph: {
            includeOccurrences: files.filter(file => file !== rootFile).map((file, index) => ({
                occurrenceId: `root:${index}`,
                fromFile: rootFile,
                filePath: file,
                fileName: path.basename(file),
                lineIndex: index + 1,
                keyword: '*INCLUDE',
            })),
        },
        fileIndexes: new Map(files.map(file => [file, {
            parameterEvents: [],
            referenceDefinitions: file === definitionFile
                ? definitions
                : { curves: [], tables: [], genericDefinitions: [] },
            registryReferences: file === sourceFile
                ? emptyRegistryReferences({ referenceOccurrences: [occurrence] })
                : emptyRegistryReferences(),
        }])),
    };
}

describe('registryReferenceNetwork', () => {
    it('selects the primary namespace, then the fallback, without mixing same-ID definitions', () => {
        const { analyzeReference } = require('../../../src/core/references/projectReferenceIndex');
        const { mergeOnDemandDefinitions } = require('../../../src/core/references/onDemandDefinitionScanner');
        const search = [{ targetKinds: ['curve'], targetKeywords: ['*DEFINE_CURVE'] },
            { targetKinds: ['function'], targetKeywords: ['*DEFINE_FUNCTION'] }];
        const value = { kind: 'numeric', id: 73, raw: '73', targetSearch: search };
        const definition = kind => ({ id: 73, targetKind: kind, keyword: kind === 'curve' ? '*DEFINE_CURVE' : '*DEFINE_FUNCTION' });
        const index = (primary, alternate, covered = true) => ({
            indexedTargetKinds: new Set(covered ? ['curve', 'function'] : ['function']),
            indexedTargetDefinitions: new Set(covered ? ['DEFINE_CURVE', 'DEFINE_FUNCTION'] : ['DEFINE_FUNCTION']),
            curvesById: new Map(primary ? [[73, [definition('curve')]]] : []),
            entityDefinitionsByKind: new Map([['function', new Map(alternate ? [[73, [definition('function')]]] : [])]]),
            completenessReasons: [], registryReferenceCoverageGaps: [], registryReferenceOccurrences: [{
                filePath: 'priority.k', lineIndex: 3, startCharacter: 0, endCharacter: 2,
                referenceValue: value, targetKinds: ['curve', 'function'], targetDefinitions: [] }],
            parameterContextsByFile: new Map([['priority.k', [{ idfoffOffset: 0, occurrencePath: [], occurrencePathLabels: [] }]]]),
        });
        for (const [primary, alternate] of [[true, true], [true, false], [false, true], [false, false]]) {
            const current = index(primary, alternate);
            const result = analyzeReference(current, value, ['curve', 'function']);
            assert.equal(result.state, primary || alternate ? 'exact' : 'missing');
            assert.deepEqual(result.definitions.map(item => item.targetKind), primary ? ['curve'] : alternate ? ['function'] : []);
            for (const kind of ['curve', 'function']) {
                const matches = collectRegistryReferenceMatches(current, { id: 73, targetKinds: [kind] },
                    { retainVerifiedMatchesOnIncomplete: true });
                assert.equal(matches.locations.length, kind === (primary ? 'curve' : alternate ? 'function' : null) ? 1 : 0);
            }
        }
        const unresolved = index(false, true, false);
        const analysis = analyzeReference(unresolved, value, ['curve', 'function']);
        assert.equal(analysis.state, 'uncertain');
        assert.ok(analysis.reasons.includes('lspp-target-priority-unresolved'));
        assert.equal(collectRegistryReferenceMatches(unresolved, { id: 73, targetKinds: ['function'] },
            { retainVerifiedMatchesOnIncomplete: true }).locations.length, 0);
        const alternateDefinition = unresolved.entityDefinitionsByKind.get('function').get(73)[0];
        const lookup = { state: 'complete', definitions: [definition('curve'), alternateDefinition], reasons: [],
            descriptors: [{ keyword: 'DEFINE_CURVE', targetKind: 'curve' }, { keyword: 'DEFINE_FUNCTION', targetKind: 'function' }] };
        assert.deepEqual(mergeOnDemandDefinitions(analysis, lookup, unresolved).definitions.map(item => item.targetKind), ['curve']);
        assert.deepEqual(mergeOnDemandDefinitions(analysis, { ...lookup, definitions: [alternateDefinition] }, unresolved)
            .definitions.map(item => item.targetKind), ['function']);
    });
    it('retains known reference matches without claiming target definition coverage', () => {
        const filePath = path.resolve('native-unavailable-definition.k');
        const occurrence = { ...signedPartOccurrence(filePath), targetDefinitionUnavailable: true };
        const index = buildProjectReferenceIndex(completeSnapshot(filePath, filePath, filePath, occurrence,
            { curves: [], tables: [], genericDefinitions: [] }));
        const query = { id: 17, targetKinds: ['curve'], targetDefinitions: [] };
        const partial = collectRegistryReferenceMatches(index, query, { retainVerifiedMatchesOnIncomplete: true });
        assert.equal(partial.locations.length, 1);
        assert.equal(partial.state, 'partial');
        assert.ok(partial.reasons.includes('lspp-target-definition-layout-unresolved'));
        const strict = collectRegistryReferenceMatches(index, query);
        assert.equal(strict.state, 'incomplete');
        assert.deepEqual(strict.locations, []);
    });
    const createTempDirectory = require('../../support/tempDirectories').trackTempDirectories();

    it('keeps default expression queries incomplete without blocking unrelated namespaces', async function () {
        this.timeout(10_000); // Builds and verifies six independent on-disk project indexes.
        const fs = require('node:fs');
        const os = require('node:os');
        const { buildProjectIndex } = require('../../../out/core/project/projectIndexer');
        const root = createTempDirectory(path.join(os.tmpdir(), 'dynasense-expression-network-'));
        for (const raw of ['<CID>', '<17>', '<min(CID,17)>', '17', '&CID', 'UNKNOWN']) {
            const file = path.join(root, `case-${raw.replace(/[^A-Za-z0-9]/g, '_')}.k`);
            const text = `*KEYWORD\n*PARAMETER\niCID,17\n*DEFINE_CURVE\n17,0,1,1,0,0\n0,0\n1,1\n*LOAD_BODY_Z\n${raw},9806,0,0,0,0,0\n*LOAD_BODY_Z\n17,9806,0,0,0,0,0\n*END\n`;
            fs.writeFileSync(file, text);
            const snapshot = await buildProjectIndex(file);
            const index = buildProjectReferenceIndex(snapshot);
            const query = { id: 17, targetKinds: ['curve'], targetDefinitions: ['DEFINE_CURVE'] };
            const curve = collectRegistryReferenceMatches(index, query);
            if (raw.startsWith('<')) {
                assert.equal(curve.state, 'incomplete', raw);
                assert.deepEqual(curve.locations, []);
                assert.ok(curve.reasons.some(reason => reason.endsWith(':9:parameter-expression-unresolved')));
                const partial = collectRegistryReferenceMatches(index, query,
                    { retainVerifiedMatchesOnIncomplete: true });
                assert.equal(partial.state, 'partial');
                assert.deepEqual(partial.locations.map(location => location.line), [10]);
                assert.ok(partial.reasons.some(reason => reason.endsWith(':9:parameter-expression-unresolved')));
                const shifted = collectRegistryReferenceMatches(index, { ...query, id: 9806 },
                    { retainVerifiedMatchesOnIncomplete: true });
                assert.deepEqual(shifted.locations, [], 'The scale factor must not become a curve reference');
            } else {
                assert.equal(curve.state, 'complete', raw);
                assert.deepEqual(curve.locations.map(location => location.line),
                    raw === 'UNKNOWN' ? [10] : [8, 10]);
            }
            const node = collectRegistryReferenceMatches(index,
                { id: 17, targetKinds: ['node'], targetDefinitions: ['NODE'] });
            assert.equal(node.state, 'complete', raw);
            assert.deepEqual(node.reasons, []);
            assert.equal(fs.readFileSync(file, 'utf8'), text);
        }
    });

    it('keeps a root loading until all queries settle and preserves later invalidations', async () => {
        const rootFile = path.resolve('registry-network', 'concurrent.k');
        const snapshot = { rootFile, files: [rootFile], scope: 'single-file',
            graph: { includeOccurrences: [], includeOccurrencesComplete: true },
            fileIndexes: new Map([[rootFile, { keywordBlocks: [], parameterEvents: [],
                referenceDefinitions: { curves: [], tables: [], genericDefinitions: [] },
                registryReferences: emptyRegistryReferences() }]]) };
        const complete = { state: 'complete', definitions: [], reasons: [] };
        for (const outcome of ['ready', 'stale', 'needs-refresh', 'fail-first', 'fail-last']) {
            const service = new EntityReferenceQueryService();
            const callbacks = [];
            let started;
            const bothStarted = new Promise(resolve => { started = resolve; });
            const context = { definitionKeywords: { generic: {}, onDemand: { MAT_TEST: { targetKind: 'material' } } },
                collectReferences: () => ({ state: 'complete', locations: [], reasons: [] }),
                scanDefinitions: () => new Promise((resolve, reject) => {
                    callbacks.push({ resolve, reject });
                    if (callbacks.length === 2) started();
                }) };
            const first = service.queryById(snapshot, 1, 'material', context);
            const second = service.queryById(snapshot, 2, 'material', context);
            await bothStarted;
            assert.equal(callbacks.length, 2);
            assert.equal(service.lifecycle(rootFile), 'loading');
            if (outcome === 'fail-first') callbacks[0].reject(new Error('first query failed'));
            else callbacks[0].resolve(complete);
            const firstResult = await first;
            assert.equal(firstResult.lifecycle, outcome === 'fail-first' ? 'failed' : 'ready');
            assert.equal(service.lifecycle(rootFile), 'loading');
            if (outcome === 'stale') service.markStale(rootFile);
            if (outcome === 'needs-refresh') service.markNeedsRefresh(rootFile);
            if (outcome === 'fail-last') callbacks[1].reject(new Error('last query failed'));
            else callbacks[1].resolve(complete);
            await second;
            assert.equal(service.lifecycle(rootFile), outcome.startsWith('fail-') ? 'failed' : outcome);
            await service.queryById(snapshot, 3, 'material', { ...context, scanDefinitions: async () => complete });
            assert.equal(service.lifecycle(rootFile), 'ready');
        }
    });

    it('resolves an exact HOURGLASS descriptor in both F12 directions', () => {
        const record = registry.byKeyword.PART.find(item =>
            item.kind === 'entity-reference' && item.field.fieldName === 'HGID');
        const info = getRegistryApprovedFieldReferenceInfo({
            keyword: 'PART', cardIndex: record.field.cardIndex,
            field: { n: 'HGID', t: record.field.fieldType,
                p: record.field.position, w: record.field.width },
        });
        const rootFile = path.resolve('registry-network', 'hourglass-main.k');
        const definitionFile = path.resolve('registry-network', 'hourglass.k');
        const occurrence = {
            filePath: rootFile, keyword: '*PART', cardIndex: record.field.cardIndex,
            fieldName: 'HGID', lineIndex: 2, startCharacter: 7, endCharacter: 9,
            rawValue: '77', authoringRelationId: record.authoringRelationId,
            coordinateId: record.coordinateId, sourceRuleId: record.sourceRuleId,
            referenceValue: parseFieldReferenceValue('77', info),
            targetKinds: ['hourglass'], targetDefinitions: ['HOURGLASS'],
        };
        const snapshot = completeSnapshot(rootFile, rootFile, definitionFile, occurrence, {
            curves: [], tables: [],
            genericDefinitions: [exactDefinition(definitionFile, 'HOURGLASS', 'hourglass')],
        });
        const index = buildProjectReferenceIndex(snapshot);
        const forward = queryFromReferenceSource(index, {
            referenceValue: occurrence.referenceValue,
            referenceInfo: { targetKinds: ['hourglass'], targetDefinitions: ['HOURGLASS'] },
        }, { documentPath: rootFile, lineIndex: 2 });
        assert.equal(forward.state, 'ready');
        const service = new EntityReferenceQueryService();
        const unifiedForward = service.queryFromSource(index, {
            referenceValue: occurrence.referenceValue,
            referenceInfo: { targetKinds: ['hourglass'], targetDefinitions: ['HOURGLASS'] },
        }, { documentPath: rootFile, lineIndex: 2, documentVersion: 7, rootFile });
        const unifiedReverse = service.queryFromDefinition(index, definitionFile, { line: 2, character: 9 }, {
            documentVersion: 7, rootFile,
        });
        assert.equal(unifiedForward.state, 'exact');
        assert.equal(unifiedReverse.state, 'exact');
        assert.equal(unifiedForward.queryIdentity, unifiedReverse.queryIdentity);
        assert.deepEqual(definitionLocations(index, forward.query).map(x => [x.filePath, x.line]),
            [[definitionFile, 2]]);
        const reverse = definitionAtPosition(index, definitionFile, { line: 2, character: 9 });
        assert.equal(reverse.state, 'ready');
        const matches = collectRegistryReferenceMatches(index, reverse.query);
        assert.equal(matches.state, 'complete');
        assert.deepEqual(matches.locations.map(x => x.authoringRelationId),
            [record.authoringRelationId]);
        index.completenessReasons = ['registry-reference-preview-byte-limit', 'include-occurrence-incomplete',
            'registry-reference-preview-byte-limit'];
        const incomplete = service.queryFromDefinition(index, definitionFile, { line: 2, character: 9 }, { rootFile });
        assert.equal(incomplete.state, 'indeterminate');
        assert.deepEqual(incomplete.reasons, [
            `${rootFile}:2:include-occurrence-incomplete`,
            `${rootFile}:2:registry-reference-preview-byte-limit`,
            'include-occurrence-incomplete', 'registry-reference-preview-byte-limit',
        ]);
    });

    it('keeps an exact material label identity closed in forward and reverse navigation', () => {
        const referenceRecord = registry.byKeyword.PART.find(record =>
            record.kind === 'entity-reference' && record.field.fieldName === 'MID'
        );
        const info = getRegistryApprovedFieldReferenceInfo({
            keyword: 'PART', cardIndex: referenceRecord.field.cardIndex,
            field: { n: 'MID', t: referenceRecord.field.fieldType,
                p: referenceRecord.field.position, w: referenceRecord.field.width },
        });
        const rootFile = path.resolve('registry-network', 'label-main.k');
        const definitionFile = path.resolve('registry-network', 'label-material.k');
        const occurrence = {
            filePath: rootFile, keyword: '*PART', cardIndex: referenceRecord.field.cardIndex,
            fieldName: 'MID', lineIndex: 2, startCharacter: 2, endCharacter: 10,
            rawValue: 'HS Steel', authoringRelationId: referenceRecord.authoringRelationId,
            coordinateId: referenceRecord.coordinateId, sourceRuleId: referenceRecord.sourceRuleId,
            referenceValue: parseFieldReferenceValue('HS Steel', info),
            targetKinds: ['material'], targetDefinitions: ['MAT'],
        };
        const snapshot = completeSnapshot(rootFile, rootFile, definitionFile, occurrence, {
            curves: [], tables: [], genericDefinitions: [materialLabel(definitionFile)],
        });
        const index = buildProjectReferenceIndex(snapshot);
        const forward = queryFromReferenceSource(index, {
            referenceValue: occurrence.referenceValue,
            referenceInfo: { targetKinds: ['material'], targetDefinitions: ['MAT'] },
        }, { documentPath: rootFile, lineIndex: 2 });
        assert.equal(forward.state, 'ready');
        assert.equal(forward.query.id, 'HS Steel');
        assert.deepEqual(definitionLocations(index, forward.query).map(x => [x.filePath, x.line]),
            [[definitionFile, 2]]);
        const reverse = definitionAtPosition(index, definitionFile, { line: 2, character: 5 });
        assert.equal(reverse.state, 'ready');
        assert.equal(reverse.query.id, 'HS Steel');
        const matches = collectRegistryReferenceMatches(index, reverse.query);
        assert.equal(matches.state, 'complete');
        assert.deepEqual(matches.locations.map(x => x.id), ['HS Steel']);
    });

    it('proves the complete approved LOAD_BODY/DEFINE_CURVE F12 and Shift+F12 relation group', () => {
        const records = Object.values(registry.byKeyword).flat();
        const definition = records.find(record => record.kind === 'entity-definition' &&
            record.field.keywordForm === 'DEFINE_CURVE' && record.field.fieldName === 'LCID');
        const references = records.filter(record => record.kind === 'entity-reference' &&
            record.field.fieldName === 'LCID' && record.familyProjection?.manualKeyword === '*LOAD_BODY' &&
            (record.relation.targetKeywords || []).includes('*DEFINE_CURVE') &&
            (record.relation.targetKinds || []).includes('curve'))
            .sort((left, right) => left.familyProjection.option.localeCompare(right.familyProjection.option));
        assert.deepEqual(references.map(record => record.familyProjection.option),
            ['RX', 'RY', 'RZ', 'VECTOR', 'X', 'Y', 'Z']);

        const rootFile = path.resolve('registry-network', 'load-body-main.k');
        const definitionFile = path.resolve('registry-network', 'curve.k');
        const definitionOccurrence = curve(definitionFile, 101, 2);
        const occurrences = references.map((record, index) => {
            const info = getRegistryApprovedFieldReferenceInfo({
                keyword: record.field.keyword,
                cardIndex: record.field.cardIndex,
                field: {
                    n: record.field.fieldName,
                    t: record.field.fieldType,
                    p: record.field.position,
                    w: record.field.width,
                },
            });
            assert.equal(info.definitionRegistry.sourceRuleId, record.sourceRuleId);
            return {
                filePath: rootFile,
                keyword: record.field.keyword,
                cardIndex: record.field.cardIndex,
                fieldName: record.field.fieldName,
                lineIndex: index + 2,
                startCharacter: 7,
                endCharacter: 10,
                rawValue: '101',
                authoringRelationId: info.definitionRegistry.authoringRelationId,
                coordinateId: info.definitionRegistry.coordinateId,
                sourceRuleId: info.definitionRegistry.sourceRuleId,
                referenceValue: parseFieldReferenceValue('101', info),
                targetKinds: ['curve'],
                targetDefinitions: ['DEFINE_CURVE'],
            };
        });
        const snapshot = {
            rootFile,
            files: [rootFile, definitionFile],
            graph: { includeOccurrences: [{
                occurrenceId: 'root:curve', fromFile: rootFile, filePath: definitionFile,
                fileName: path.basename(definitionFile), lineIndex: 1, keyword: '*INCLUDE',
            }] },
            fileIndexes: new Map([
                [rootFile, {
                    parameterEvents: [],
                    referenceDefinitions: { curves: [], tables: [], genericDefinitions: [] },
                    registryReferences: emptyRegistryReferences({ referenceOccurrences: occurrences }),
                }],
                [definitionFile, {
                    parameterEvents: [],
                    referenceDefinitions: {
                        curves: [definitionOccurrence], tables: [], genericDefinitions: [],
                    },
                    registryReferences: emptyRegistryReferences(),
                }],
            ]),
        };
        const index = buildProjectReferenceIndex(snapshot);
        for (const occurrence of occurrences) {
            const query = queryFromReferenceSource(index, {
                referenceValue: occurrence.referenceValue,
                referenceInfo: {
                    targetKinds: occurrence.targetKinds,
                    targetDefinitions: occurrence.targetDefinitions,
                },
            }, { documentPath: rootFile, lineIndex: occurrence.lineIndex });
            assert.equal(query.state, 'ready', occurrence.authoringRelationId);
            assert.deepEqual(definitionLocations(index, query.query).map(item => [item.filePath, item.line]),
                [[definitionFile, 2]]);
        }
        const reverse = definitionAtPosition(index, definitionFile, { line: 2, character: 9 });
        assert.equal(reverse.state, 'ready');
        assert.equal(reverse.definitions[0].definitionRegistry.sourceRuleId,
            definition.sourceRuleId);
        const matches = collectRegistryReferenceMatches(index, reverse.query);
        assert.equal(matches.state, 'complete');
        assert.deepEqual(matches.locations.map(item => item.authoringRelationId).sort(),
            occurrences.map(record => record.authoringRelationId).sort());
    });

    it('resolves LOAD_BODY_PARTS PSID to SET_PART SID and reverses with Shift+F12', () => {
        const records = Object.values(registry.byKeyword).flat();
        const definitionRecord = records.find(record => record.kind === 'entity-definition' &&
            record.field.keywordForm === 'SET_PART' && record.field.fieldName === 'SID');
        const referenceRecord = records.find(record => record.kind === 'entity-reference' &&
            record.field.keywordForm === 'LOAD_BODY_PARTS' && record.field.fieldName === 'PSID');
        assert.ok(definitionRecord);
        assert.ok(referenceRecord);

        const rootFile = path.resolve('registry-network', 'load-body-parts-main.k');
        const definitionFile = path.resolve('registry-network', 'set-part.k');
        const info = getRegistryApprovedFieldReferenceInfo({
            keyword: 'LOAD_BODY_PARTS', cardIndex: 1,
            field: { n: 'PSID', t: 'integer', p: 0, w: 10 },
        });
        const occurrence = {
            filePath: rootFile,
            keyword: '*LOAD_BODY_PARTS',
            cardIndex: 1,
            fieldName: 'PSID',
            lineIndex: 1,
            startCharacter: 3,
            endCharacter: 10,
            rawValue: '1000001',
            authoringRelationId: info.definitionRegistry.authoringRelationId,
            coordinateId: info.definitionRegistry.coordinateId,
            sourceRuleId: info.definitionRegistry.sourceRuleId,
            referenceValue: parseFieldReferenceValue('1000001', info),
            targetKinds: ['part-set'],
            targetDefinitions: ['SET_PART'],
        };
        const snapshot = completeSnapshot(
            rootFile,
            rootFile,
            definitionFile,
            occurrence,
            { curves: [], tables: [], genericDefinitions: [setPart(definitionFile)] },
        );
        const index = buildProjectReferenceIndex(snapshot);
        const query = queryFromReferenceSource(index, {
            referenceValue: occurrence.referenceValue,
            referenceInfo: {
                targetKinds: occurrence.targetKinds,
                targetDefinitions: occurrence.targetDefinitions,
            },
        }, { documentPath: rootFile, lineIndex: occurrence.lineIndex });
        assert.equal(query.state, 'ready');
        assert.deepEqual(definitionLocations(index, query.query).map(item =>
            [item.filePath, item.line]), [[definitionFile, 1]]);

        const reverse = definitionAtPosition(index, definitionFile, { line: 1, character: 9 });
        assert.equal(reverse.state, 'ready');
        assert.equal(reverse.definitions[0].definitionRegistry.sourceRuleId,
            definitionRecord.sourceRuleId);
        const matches = collectRegistryReferenceMatches(index, reverse.query);
        assert.equal(matches.state, 'complete');
        assert.deepEqual(matches.locations.map(item => item.authoringRelationId),
            [info.definitionRegistry.authoringRelationId]);
    });

    it('matches signed references by effective ID and exact namespace', () => {
        const rootFile = path.resolve('registry-network', 'main.k');
        const sourceFile = path.resolve('registry-network', 'part.k');
        const definitionFile = path.resolve('registry-network', 'curve.k');
        const occurrence = signedPartOccurrence(sourceFile);
        const index = buildProjectReferenceIndex(completeSnapshot(
            rootFile,
            sourceFile,
            definitionFile,
            occurrence,
            { curves: [curve(definitionFile)], tables: [], genericDefinitions: [] },
        ));

        const result = collectRegistryReferenceMatches(index, {
            id: 17, targetKinds: ['curve'], targetDefinitions: [],
        });
        assert.equal(index.registryReferenceScanComplete, true);
        assert.equal(result.state, 'complete');
        assert.deepEqual(result.locations.map(item => [item.filePath, item.line]), [[sourceFile, 2]]);
        assert.equal(result.locations[0].authoringRelationId,
            occurrence.authoringRelationId);
        assert.deepEqual(definitionLocations(index, {
            id: 17, targetKinds: ['curve'], targetDefinitions: [],
        }).map(item => [item.filePath, item.line]), [[definitionFile, 7]]);
    });

    it('does not cross namespaces when IDs overlap', () => {
        const occurrence = signedPartOccurrence('/fixture/part.k');
        assert.equal(namespaceMatches(
            { id: 17, targetKinds: ['curve'], targetDefinitions: [] },
            occurrence,
        ), true);
        assert.equal(namespaceMatches(
            { id: 17, targetKinds: ['part'], targetDefinitions: ['PART'] },
            occurrence,
        ), false);
    });

    it('derives a query only from Registry-approved definitions at the exact ID token', () => {
        const filePath = path.resolve('registry-network', 'part-definition.k');
        const snapshot = {
            rootFile: filePath,
            files: [filePath],
            graph: { includeOccurrences: [] },
            fileIndexes: new Map([[filePath, {
                parameterEvents: [],
                referenceDefinitions: {
                    curves: [], tables: [], genericDefinitions: [part(filePath)],
                },
                registryReferences: emptyRegistryReferences(),
            }]]),
        };
        const index = buildProjectReferenceIndex(snapshot);
        const ready = definitionAtPosition(index, filePath, { line: 2, character: 9 });

        assert.equal(ready.state, 'ready');
        assert.deepEqual(ready.query, {
            id: 42, targetKinds: ['part'], targetDefinitions: ['PART'],
        });
        assert.equal(definitionAtPosition(index, filePath, { line: 2, character: 0 }).state, 'none');
    });

    it('fails closed for incomplete scans, signed IDFOFF, and result capacity', () => {
        const occurrence = signedPartOccurrence('/fixture/source.k');
        const incomplete = {
            registryReferenceScanComplete: false,
            registryReferenceScanReasons: ['fixture:scan-incomplete'],
        };
        assert.deepEqual(
            collectRegistryReferenceMatches(incomplete, {
                id: 17, targetKinds: ['curve'], targetDefinitions: [],
            }).reasons,
            ['fixture:scan-incomplete'],
        );

        const index = {
            registryReferenceScanComplete: true,
            registryReferenceScanReasons: [],
            registryReferenceOccurrences: [occurrence, { ...occurrence, lineIndex: 3 }],
            parameterContextsByFile: new Map([[
                occurrence.filePath,
                [{
                    occurrencePath: ['root', 'signed'], occurrencePathLabels: ['root', 'signed'],
                    idfoffOffset: 5, initialBindings: new Map(), timeline: [],
                }],
            ]]),
            completenessReasons: [],
            indexedTargetKinds: new Set(['curve']),
            indexedTargetDefinitions: new Set(),
            onDemandTargetKinds: new Set(),
            onDemandTargetDefinitions: new Set(),
            curvesById: new Map(), tablesById: new Map(),
            genericDefinitionsByKeyword: new Map(), entityDefinitionsByKind: new Map(),
            unresolvedCurves: [], unresolvedTables: [],
            unresolvedGenericDefinitionsByKeyword: new Map(), unresolvedEntityDefinitionsByKind: new Map(),
        };
        const signed = collectRegistryReferenceMatches(index, {
            id: 17, targetKinds: ['curve'], targetDefinitions: [],
        });
        assert.equal(signed.state, 'incomplete');
        assert.deepEqual(signed.locations, []);
        assert.ok(signed.reasons.some(reason => reason.includes('signed-switch-transform-unverified')));

        index.parameterContextsByFile.get(occurrence.filePath)[0].idfoffOffset = 0;
        const bounded = collectRegistryReferenceMatches(index, {
            id: 17, targetKinds: ['curve'], targetDefinitions: [],
        }, { maxMatches: 1 });
        assert.equal(bounded.state, 'incomplete');
        assert.deepEqual(bounded.locations, []);
        assert.ok(bounded.reasons.includes('registry-reference-results-capacity-exceeded'));

        index.registryReferenceScanComplete = false;
        index.registryReferenceScanReasons = ['/fixture/source.k:registry-reference-input-unsupported'];
        const legacyOpaque = collectRegistryReferenceMatches(index, {
            id: 17, targetKinds: ['curve'], targetDefinitions: [],
        });
        assert.equal(legacyOpaque.state, 'complete');
        assert.equal(legacyOpaque.locations.length, 2);
    });

    it('ignores unrelated scoped coverage gaps and retains verified relevant matches explicitly', () => {
        const occurrence = { ...signedPartOccurrence('/fixture/source.k'), targetKinds: ['part'] };
        const index = {
            registryReferenceScanComplete: false,
            registryReferenceScanReasons: ['/fixture/source.k:registry-reference-preview-byte-limit'],
            registryReferenceCoverageGaps: [{
                filePath: '/fixture/source.k', reason: 'registry-reference-preview-byte-limit',
                scope: 'namespaces', targetKinds: ['part'], targetDefinitions: ['PART'],
            }],
            registryReferenceOccurrences: [occurrence],
            parameterContextsByFile: new Map([[occurrence.filePath, [{ idfoffOffset: 0,
                occurrencePath: ['root'], occurrencePathLabels: ['root'] }]]]), completenessReasons: [],
            indexedTargetKinds: new Set(['curve', 'part']), indexedTargetDefinitions: new Set(),
            onDemandTargetKinds: new Set(), onDemandTargetDefinitions: new Set(),
            curvesById: new Map(), tablesById: new Map(), genericDefinitionsByKeyword: new Map(),
            entityDefinitionsByKind: new Map(), unresolvedCurves: [], unresolvedTables: [],
            unresolvedGenericDefinitionsByKeyword: new Map(), unresolvedEntityDefinitionsByKind: new Map(),
        };
        const curve = collectRegistryReferenceMatches(index, {
            id: 17, targetKinds: ['curve'], targetDefinitions: [],
        });
        assert.equal(curve.state, 'complete');

        const strict = collectRegistryReferenceMatches(index, {
            id: 17, targetKinds: ['part'], targetDefinitions: [],
        });
        assert.equal(strict.state, 'incomplete');
        assert.deepEqual(strict.locations, []);

        const explicit = collectRegistryReferenceMatches(index, {
            id: 17, targetKinds: ['part'], targetDefinitions: [],
        }, { retainVerifiedMatchesOnIncomplete: true });
        assert.equal(explicit.state, 'partial');
        assert.equal(explicit.locations.length, 1);
    });

    it('keeps source-query transform and parameter ambiguity explicit', () => {
        const occurrence = signedPartOccurrence('/fixture/source.k');
        const index = {
            parameterContextsByFile: new Map(),
            completenessReasons: [],
            indexedTargetKinds: new Set(['curve']),
            indexedTargetDefinitions: new Set(),
            onDemandTargetKinds: new Set(),
            onDemandTargetDefinitions: new Set(),
            curvesById: new Map(), tablesById: new Map(),
            genericDefinitionsByKeyword: new Map(), entityDefinitionsByKind: new Map(),
            unresolvedCurves: [], unresolvedTables: [],
            unresolvedGenericDefinitionsByKeyword: new Map(), unresolvedEntityDefinitionsByKind: new Map(),
        };
        const source = {
            referenceValue: occurrence.referenceValue,
            referenceInfo: { targetKinds: ['curve'], targetDefinitions: [] },
        };
        for (const options of [{}, { documentPath: occurrence.filePath }]) {
            const unavailable = queryFromReferenceSource(index, source, options);
            assert.equal(unavailable.state, 'incomplete');
            assert.equal(unavailable.query, null);
            assert.ok(unavailable.reasons.includes('reference-source-context-unavailable'));
        }
        index.parameterContextsByFile.set(occurrence.filePath, [{ idfoffOffset: 0,
            occurrencePath: ['root'], occurrencePathLabels: ['root'] }]);
        const ready = queryFromReferenceSource(index, {
            referenceValue: occurrence.referenceValue,
            referenceInfo: { targetKinds: ['curve'], targetDefinitions: [] },
        }, { documentPath: occurrence.filePath, lineIndex: occurrence.lineIndex });
        assert.equal(ready.state, 'ready');
        assert.equal(ready.query.id, 17);
    });

    it('resolves signed parameter branches only when every occurrence agrees', () => {
        const info = getRegistryApprovedFieldReferenceInfo({
            keyword: 'PART', cardIndex: 2,
            field: { n: 'ADPOPT', t: 'integer', p: 60, w: 10 },
        });
        const filePath = '/fixture/parameter-part.k';
        const occurrence = {
            filePath,
            lineIndex: 2,
            startCharacter: 64,
            endCharacter: 70,
            referenceValue: parseFieldReferenceValue('-&LCID', info),
            targetKinds: ['curve'],
            targetDefinitions: [],
        };
        const binding = value => ({ valueState: 'integer', value, reason: null });
        const context = value => ({
            occurrencePath: ['root'], occurrencePathLabels: ['root'], idfoffOffset: 0,
            initialBindings: new Map([['LCID', binding(value)]]), timeline: [],
        });
        const index = {
            registryReferenceScanComplete: true,
            registryReferenceScanReasons: [],
            registryReferenceOccurrences: [occurrence],
            parameterContextsByFile: new Map([[filePath, [context(17)]]]),
            completenessReasons: [],
            indexedTargetKinds: new Set(['curve']), indexedTargetDefinitions: new Set(),
            onDemandTargetKinds: new Set(), onDemandTargetDefinitions: new Set(),
            curvesById: new Map(), tablesById: new Map(),
            genericDefinitionsByKeyword: new Map(), entityDefinitionsByKind: new Map(),
            unresolvedCurves: [], unresolvedTables: [],
            unresolvedGenericDefinitionsByKeyword: new Map(), unresolvedEntityDefinitionsByKind: new Map(),
        };
        const exact = collectRegistryReferenceMatches(index, {
            id: 17, targetKinds: ['curve'], targetDefinitions: [],
        });
        assert.equal(exact.state, 'complete');
        assert.equal(exact.locations.length, 1);

        index.parameterContextsByFile.set(filePath, [context(17), context(18)]);
        const ambiguous = collectRegistryReferenceMatches(index, {
            id: 17, targetKinds: ['curve'], targetDefinitions: [],
        });
        assert.equal(ambiguous.state, 'incomplete');
        assert.deepEqual(ambiguous.locations, []);
        assert.ok(ambiguous.reasons.some(reason => reason.includes('parameter-occurrence-ambiguous')));
    });

    it('retains only verified reference bindings for explicit partial entity queries', () => {
        const cleanFile = '/fixture/clean.k';
        const uncertainFile = '/fixture/uncertain.k';
        const clean = signedPartOccurrence(cleanFile, 17);
        const uncertain = { ...signedPartOccurrence(uncertainFile, 23), lineIndex: 4 };
        const context = offset => ({
            occurrencePath: ['root'], occurrencePathLabels: ['root'], idfoffOffset: offset,
            initialBindings: new Map(), initialUncertaintyReasons: [], timeline: [],
        });
        const index = {
            registryReferenceScanComplete: true,
            registryReferenceScanReasons: [],
            registryReferenceOccurrences: [clean, uncertain],
            parameterContextsByFile: new Map([
                [cleanFile, [context(0)]],
                [uncertainFile, [context(null)]],
            ]),
            completenessReasons: [],
            indexedTargetKinds: new Set(['curve']), indexedTargetDefinitions: new Set(),
            onDemandTargetKinds: new Set(), onDemandTargetDefinitions: new Set(),
            curvesById: new Map(), tablesById: new Map(),
            genericDefinitionsByKeyword: new Map(), entityDefinitionsByKind: new Map(),
            unresolvedCurves: [], unresolvedTables: [],
            unresolvedGenericDefinitionsByKeyword: new Map(), unresolvedEntityDefinitionsByKind: new Map(),
        };

        const strict = collectRegistryReferenceMatches(index, {
            id: 17, targetKinds: ['curve'], targetDefinitions: [],
        });
        assert.equal(strict.state, 'incomplete');
        assert.deepEqual(strict.locations, []);

        const partial = collectRegistryReferenceMatches(index, {
            id: 17, targetKinds: ['curve'], targetDefinitions: [],
        }, { retainVerifiedMatchesOnIncomplete: true });
        assert.equal(partial.state, 'partial');
        assert.equal(partial.locations.length, 1);
        assert.equal(partial.locations[0].filePath, cleanFile);
        assert.ok(partial.reasons.some(reason => reason.includes('transform-offset-unresolved')));
    });
});
