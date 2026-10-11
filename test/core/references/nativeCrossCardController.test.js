'use strict';

const assert = require('node:assert/strict');
const { resolveSiblingTargetBinding, semanticOccurrence } =
    require('../../../out/core/references/registryReferenceScanner');

describe('native cross-card reference discriminators', () => {
    const relation = kind => ({ kind: 'entity-reference', targetKinds: [kind], targetKeywords: [] });
    const info = {
        conditional: true, targetKinds: ['node', 'node-set'], targetDefinitions: [],
        relation: { kind: 'entity-reference', targetKinds: ['node', 'node-set'], targetKeywords: [] },
        definitionRegistry: { selectorSource: "keyword-catalog", operationalProjection: { siblingTargetBinding: {
            cardIndex: 1, fieldIndex: 4, fieldName: 'ITYP', defaultValue: '0',
            formats: {
                standard: { mode: 'fixed', position: 40, width: 10 },
                i10: { mode: 'fixed', position: 40, width: 10 },
                long: { mode: 'fixed', position: 80, width: 20 },
                comma: { mode: 'comma', fieldIndex: 4 },
            },
            branches: [{ value: '0', relation: relation('node') },
                { value: '1', relation: relation('node-set') }],
        } } },
    };
    const row = (values, mode) => mode === 'comma' ? values.join(',')
        : values.map(value => String(value).padStart(mode === 'long' ? 20 : 10)).join('');

    for (const mode of ['standard', 'i10', 'long', 'comma']) {
        it(`uses the header discriminator for every repeated source record in ${mode}`, () => {
            for (const [controller, kind] of [['0', 'node'], ['1', 'node-set'], ['', 'node']]) {
                const entries = [{ text: row([9, 0, 0, 0, controller, 0, 0], mode), lineIndex: 1 }];
                const result = { complete: true, reasons: [], referenceOccurrences: [],
                    valueDomainOccurrences: [], referenceCoverage: { complete: true, gaps: [] } };
                const options = { infoCache: new Map(), referenceCatalog: { infoForField: () => info },
                    maxReferenceOccurrences: 100, maxValueDomainOccurrences: 100 };
                for (const [ordinal, id] of [73, 74, 75].entries()) {
                    const source = row([id, 0, 0, 0, '1', 0, 0, 0], mode);
                    semanticOccurrence({ block: { filePath: 'controller.k', keyword: '*CONSTRAINED_INTERPOLATION',
                        startLine: 0, endLine: 5 }, keyword: 'CONSTRAINED_INTERPOLATION', cardIndex: 2,
                        field: { n: 'INID', t: 'integer', p: 0, w: mode === 'long' ? 20 : 10, fieldIndex: 0 },
                        line: source, lineIndex: ordinal + 2, result, options, formatMode: mode, entries });
                }
                assert.equal(result.complete, true);
                assert.equal(result.referenceOccurrences.length, 3);
                assert.deepEqual(result.referenceOccurrences.map(value => value.targetKinds), [[kind], [kind], [kind]]);
                assert.deepEqual(result.referenceOccurrences.map(value => value.referenceValue.id), [73, 74, 75]);
            }
        });
    }

    it('keeps missing, parameterized and unsupported header discriminators indeterminate', () => {
        const source = row([73, 0, 0, 0, 1], 'standard');
        assert.deepEqual(resolveSiblingTargetBinding(info, source, 'standard', [], 2),
            { state: 'indeterminate', reason: 'sibling-record-unavailable' });
        for (const [value, reason] of [['&ITYPE', 'sibling-value-parameterized'],
            ['<ITYPE>', 'sibling-value-parameterized'], ['7', 'sibling-value-unsupported']]) {
            const result = resolveSiblingTargetBinding(info, source, 'standard',
                [{ text: row([0, 0, 0, 0, value], 'standard') }], 2);
            assert.deepEqual(result, { state: 'indeterminate', reason });
        }
        assert.equal(resolveSiblingTargetBinding(info, source, 'standard', [], 1).info.targetKinds[0], 'node-set',
            'Same-card callers still read their current line');
    });

    it('uses an explicit native string fallback without treating parameters as constants', () => {
        const exact = structuredClone(info);
        const binding = exact.definitionRegistry.operationalProjection.siblingTargetBinding;
        Object.assign(binding, { cardIndex: 2, fieldIndex: 0, defaultValue: '',
            controllerValueMode: 'native-string-exact-uppercase',
            formats: { comma: { mode: 'comma', fieldIndex: 0 } },
            branches: [{ value: 'POS6N', relation: relation('node') }],
            otherwiseRelation: { kind: 'non-reference', targetKinds: [], targetKeywords: [] } });
        for (const [token, kind] of [['POS6N', 'entity-reference'], ['pos6n', 'entity-reference'],
            ['POS6Nx', 'non-reference'], ['TRANSL', 'non-reference'], ['', 'non-reference']]) {
            const selected = resolveSiblingTargetBinding(exact, `${token},73`, 'comma', [], 2);
            assert.equal(selected.state, 'resolved', token);
            assert.equal(selected.info.relation.kind, kind, token);
        }
        for (const token of ['&OPTION', '<OPTION>', 'POS6N<', '中文', 'POS6N\u0001'])
            assert.equal(resolveSiblingTargetBinding(exact, `${token},73`, 'comma', [], 2).state, 'indeterminate', token);
        delete binding.otherwiseRelation;
        assert.equal(resolveSiblingTargetBinding(exact, 'TRANSL,73', 'comma', [], 2).state, 'indeterminate');
    });

    it('finds a controller by its native card identity in the current bounded instance', () => {
        const source = row([73, 0, 0, 0, 1], 'standard');
        const header = { text: row([0, 0, 0, 0, 0], 'standard'), native: { cardIndex: 1 } };
        const tail = { text: source, native: { cardIndex: 2 } };
        assert.equal(resolveSiblingTargetBinding(info, source, 'standard', [tail, header], 2).info.targetKinds[0], 'node');
        assert.equal(resolveSiblingTargetBinding(info, source, 'standard', [tail], 2).reason, 'sibling-record-unavailable',
            'A missing header must not be replaced by a tail at the same array position');
        const prefixed = structuredClone(info);
        prefixed.definitionRegistry.operationalProjection.siblingTargetBinding.cardIndex = 3;
        const control = { ...header, native: { cardIndex: 3 } };
        const title = { text: 'Native SSI title', native: { cardIndex: 1 } };
        assert.equal(resolveSiblingTargetBinding(prefixed, source, 'standard', [control, tail, title], 2).info.targetKinds[0], 'node');
    });

    it('does not substitute a header default when the cross-card record is unavailable', () => {
        const result = { complete: true, reasons: [], referenceOccurrences: [], valueDomainOccurrences: [],
            referenceCoverage: { complete: true, gaps: [] } };
        semanticOccurrence({ block: { filePath: 'controller.k', keyword: '*CONSTRAINED_INTERPOLATION', startLine: 0 },
            keyword: 'CONSTRAINED_INTERPOLATION', cardIndex: 2,
            field: { n: 'INID', t: 'integer', p: 0, w: 10, fieldIndex: 0 },
            line: row([73], 'standard'), lineIndex: 2, result, formatMode: 'standard', entries: [],
            options: { infoCache: new Map(), referenceCatalog: { infoForField: () => info },
                maxReferenceOccurrences: 100, maxValueDomainOccurrences: 100 } });
        assert.equal(result.complete, false);
        assert.equal(result.referenceOccurrences.length, 0);
        assert.equal(result.valueDomainOccurrences[0].semantic.reason, 'sibling-record-unavailable');
        assert.equal(result.referenceCoverage.gaps.length, 1);
    });

    it('preserves the native zero/nonzero owner discriminator and absolute reference IDs', () => {
        const ownerInfo = structuredClone(info);
        const binding = ownerInfo.definitionRegistry.operationalProjection.siblingTargetBinding;
        binding.fieldName = 'ISG';
        binding.branches = [
            { when: { op: 'eq', value: 0 }, relation: { ...relation('interface-ssi'), idTransform: 'abs' } },
            { when: { op: 'ne', value: 0 }, relation: { ...relation('segment-set'), idTransform: 'abs' } },
        ];
        for (const mode of ['standard', 'i10', 'long', 'comma']) {
            for (const [controller, expected] of [[0, 'interface-ssi'], ['00', 'interface-ssi'],
                [1, 'segment-set'], [-1, 'segment-set'], [2, 'segment-set'], ['', 'interface-ssi']]) {
                for (const id of [73, -73]) {
                    const result = { complete: true, reasons: [], referenceOccurrences: [],
                        valueDomainOccurrences: [], referenceCoverage: { complete: true, gaps: [] } };
                    semanticOccurrence({ block: { filePath: 'seismic.k', keyword: '*LOAD_SEISMIC_SSI_NODE', startLine: 0 },
                        keyword: 'LOAD_SEISMIC_SSI_NODE', cardIndex: 2,
                        field: { n: 'SSID', t: 'integer', p: 0, w: mode === 'long' ? 20 : 10, fieldIndex: 0 },
                        line: row([id], mode), lineIndex: 2, result, formatMode: mode,
                        entries: [{ text: row([0, 0, 0, 0, controller], mode) }],
                        options: { infoCache: new Map(), referenceCatalog: { infoForField: () => ownerInfo },
                            maxReferenceOccurrences: 100, maxValueDomainOccurrences: 100 } });
                    assert.equal(result.complete, true);
                    assert.deepEqual(result.referenceOccurrences.map(value => value.targetKinds), [[expected]]);
                    assert.equal(result.referenceOccurrences[0].referenceValue.id, 73);
                }
            }
        }
        for (const value of ['abc', 1.5, '2147483648', '-2147483649', '&ISG', '<ISG>']) {
            assert.equal(resolveSiblingTargetBinding(ownerInfo, row([73], 'comma'), 'comma',
                [{ text: row([0, 0, 0, 0, value], 'comma') }], 2).state, 'indeterminate');
        }
    });

    it('keeps definition availability scoped to the selected native branch', () => {
        const selected = structuredClone(info);
        selected.targetDefinitionUnavailable = true;
        selected.definitionRegistry.operationalProjection.siblingTargetBinding.branches = [
            { value: '0', relation: { ...relation('interface-id'), targetDefinitionUnavailable: true } },
            { value: '1', relation: relation('segment-set') },
        ];
        for (const [controller, unavailable] of [[0, true], [1, false]]) {
            const resolved = resolveSiblingTargetBinding(selected, row([73], 'comma'), 'comma',
                [{ text: row([0, 0, 0, 0, controller], 'comma') }], 2);
            assert.equal(resolved.info.targetDefinitionUnavailable, unavailable);
            const result = { complete: true, reasons: [], referenceOccurrences: [], valueDomainOccurrences: [],
                referenceCoverage: { complete: true, gaps: [] } };
            semanticOccurrence({ block: { filePath: 'seismic.k', keyword: '*LOAD_SEISMIC_SSI_NODE', startLine: 0 },
                keyword: 'LOAD_SEISMIC_SSI_NODE', cardIndex: 2,
                field: { n: 'SSID', t: 'integer', p: 0, w: 10, fieldIndex: 0 },
                line: '73', lineIndex: 2, result, formatMode: 'comma',
                entries: [{ text: row([0, 0, 0, 0, controller], 'comma') }],
                options: { infoCache: new Map(), referenceCatalog: { infoForField: () => selected },
                    maxReferenceOccurrences: 100, maxValueDomainOccurrences: 100 } });
            assert.equal(Boolean(result.referenceOccurrences[0].targetDefinitionUnavailable), unavailable);
        }
    });

    it('queries the fixed EFV tail segment target without consulting the header SETYP', () => {
        const tailInfo = { conditional: true, targetKinds: ['segment-set'], targetDefinitions: [],
            definitionRegistry: { selectorSource: "keyword-catalog" },
            relation: { kind: 'value-branch', otherwise: 'unknown', branches: [
                { when: { op: 'gt', value: 0 }, role: 'reference', targetKinds: ['segment-set'], targetKeywords: [], idTransform: 'identity' },
                { when: { op: 'eq', value: 0 }, role: 'non-reference' },
            ] } };
        for (const mode of ['standard', 'i10', 'long', 'comma']) {
            for (const [id, expectedComplete] of [[74, true], [0, true], [-74, false], ['&SID', true]]) {
                const result = { complete: true, reasons: [], referenceOccurrences: [],
                    valueDomainOccurrences: [], referenceCoverage: { complete: true, gaps: [] } };
                const width = mode === 'long' ? 20 : 10;
                semanticOccurrence({ block: { filePath: 'efv.k', keyword: '*EFV_COUPLING', startLine: 0 },
                    keyword: 'EFV_COUPLING', cardIndex: 2,
                    field: { n: 'SETSTR', t: 'integer', p: width, w: width, fieldIndex: 1 },
                    line: row([84, id], mode), lineIndex: 2, result, formatMode: mode,
                    entries: [{ text: row([83, 73, '&SETYP', .5], mode) }],
                    options: { infoCache: new Map(), referenceCatalog: { infoForField: () => tailInfo },
                        maxReferenceOccurrences: 100, maxValueDomainOccurrences: 100 } });
                assert.equal(result.complete, expectedComplete, `${mode}/${id}: ${JSON.stringify(result)}`);
                assert.equal(result.referenceOccurrences.length, id === 74 || id === '&SID' ? 1 : 0);
                if (id === 74) {
                    assert.deepEqual(result.referenceOccurrences[0].targetKinds, ['segment-set']);
                    assert.equal(result.referenceOccurrences[0].referenceValue.id, 74);
                }
                if (id === '&SID') {
                    assert.equal(result.referenceOccurrences[0].semantic.state, 'reference-potential');
                    assert.equal(result.referenceOccurrences[0].referenceValue.parameterName, 'SID');
                    assert.equal(result.referenceOccurrences[0].referenceValue.semanticRelation.otherwise, 'unknown');
                }
                assert.equal(result.referenceCoverage.gaps.length, expectedComplete ? 0 : 1);
            }
        }
    });
});
