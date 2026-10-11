'use strict';
const assert = require('node:assert/strict');
const { resolveReferenceValueSemantics, parseFieldReferenceValue } = require('../../../out/core/references/fieldReferenceClassifier');
const { semanticOccurrence } = require('../../../out/core/references/registryReferenceScanner');

describe('unresolved native value roles', () => {
    it('keeps an unmatched unknown branch indeterminate across scanner and parameter resolution callers', () => {
        const relation = { kind: 'value-branch', otherwise: 'unknown', branches: [
            { when: { op: 'gt', value: 0 }, role: 'reference', targetKinds: ['segment-set'], idTransform: 'identity' },
            { when: { op: 'eq', value: 0 }, role: 'non-reference' },
        ] };
        assert.equal(resolveReferenceValueSemantics(relation, 74).state, 'reference');
        assert.equal(resolveReferenceValueSemantics(relation, 0).state, 'non-reference');
        assert.equal(resolveReferenceValueSemantics(relation, -74).state, 'indeterminate');
        assert.equal(resolveReferenceValueSemantics(relation, -74).reason, 'reference-role-unknown');
        assert.equal(parseFieldReferenceValue('-74', { relation }), null);
        const parameter = parseFieldReferenceValue('&SID', { relation });
        assert.equal(parameter.kind, 'parameter');
        assert.equal(parameter.semanticRelation, relation);
        assert.equal(resolveReferenceValueSemantics(parameter.semanticRelation, -74).state, 'indeterminate');
        const explicitScalar = { ...relation, otherwise: 'scalar' };
        assert.equal(resolveReferenceValueSemantics(explicitScalar, -74).state, 'non-reference');
    });

    it('does not bypass an explicit zero role while keeping optional direct zero IDs absent', () => {
        for (const [relation, complete] of [
            [{ kind: 'entity-reference', targetKinds: ['segment-set'] }, true],
            [{ kind: 'value-branch', otherwise: 'unknown', branches: [
                { when: { op: 'gt', value: 0 }, role: 'reference', targetKinds: ['segment-set'] },
            ] }, false],
            [{ kind: 'value-branch', otherwise: 'non-reference', branches: [
                { when: { op: 'eq', value: 0 }, role: 'reference', targetKinds: ['segment-set'] },
            ] }, false],
            [{ kind: 'value-branch', otherwise: 'unknown', branches: [
                { when: { op: 'eq', value: 0 }, role: 'non-reference' },
            ] }, true],
        ]) {
            const result = { complete: true, reasons: [], referenceOccurrences: [],
                valueDomainOccurrences: [], referenceCoverage: { complete: true, gaps: [] } };
            semanticOccurrence({ block: { filePath: 'zero.k', keyword: '*EFV_COUPLING', startLine: 0 },
                keyword: 'EFV_COUPLING', cardIndex: 2,
                field: { n: 'SETSTR', t: 'integer', p: 0, w: 10, fieldIndex: 0 },
                line: '0', lineIndex: 2, result, formatMode: 'comma',
                options: { infoCache: new Map(), formatCache: new Map(),
                    referenceCatalog: { infoForField: () => ({ relation,
                        definitionRegistry: { selectorSource: "keyword-catalog" } }) },
                    maxReferenceOccurrences: 100, maxValueDomainOccurrences: 100 } });
            assert.equal(result.complete, complete, JSON.stringify(relation));
            assert.equal(result.referenceOccurrences.length, 0);
            assert.equal(result.referenceCoverage.gaps.length, complete ? 0 : 1);
        }
    });
});
