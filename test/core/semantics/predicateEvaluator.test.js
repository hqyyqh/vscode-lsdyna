const assert = require('assert');

const {
    applyReferenceIdTransform,
    evaluatePredicate,
    resolveValueRole,
    selectSemanticBranch,
} = require('../../../out/core/semantics/predicateEvaluator');

describe('manual semantic predicate evaluator', () => {
    it('uses three-valued logic for numeric, cross-field, and parameter inputs', () => {
        assert.equal(evaluatePredicate({ op: 'lt', value: 0 }, { currentValue: -4 }), 'true');
        assert.equal(evaluatePredicate({ op: 'lt', value: 0 }, { currentValue: 4 }), 'false');
        assert.equal(evaluatePredicate({ op: 'lt', value: 0 }, { currentValue: '&TMAX' }), 'indeterminate');
        assert.equal(evaluatePredicate(
            { field: 'TYPE', op: 'in', values: [1, 3] },
            { fields: { type: 3 } },
        ), 'true');
        assert.equal(evaluatePredicate(
            { field: 'TYPE', op: 'eq', value: 1 },
            { fields: {} },
        ), 'indeterminate');
    });

    it('implements Kleene all/any/not without treating unknown as false', () => {
        assert.equal(evaluatePredicate({
            all: [
                { op: 'gt', value: 0 },
                { field: 'MISSING', op: 'eq', value: 1 },
            ],
        }, { currentValue: 2 }), 'indeterminate');
        assert.equal(evaluatePredicate({
            all: [
                { op: 'lt', value: 0 },
                { field: 'MISSING', op: 'eq', value: 1 },
            ],
        }, { currentValue: 2 }), 'false');
        assert.equal(evaluatePredicate({
            any: [
                { op: 'gt', value: 0 },
                { field: 'MISSING', op: 'eq', value: 1 },
            ],
        }, { currentValue: 2 }), 'true');
        assert.equal(evaluatePredicate({ not: { op: 'eq', value: 0 } }, { currentValue: 0 }), 'false');
    });

    it('keeps keyword option slots indeterminate until slot layout is supplied', () => {
        const predicate = { keywordOptionSlot: 'OPTION1', op: 'blank' };
        assert.equal(evaluatePredicate(predicate, {}), 'indeterminate');
        assert.equal(evaluatePredicate(predicate, {
            keywordOptionSlots: { option1: '' },
        }), 'true');
        assert.equal(evaluatePredicate({ keywordOption: 'TITLE', op: 'present' }, {
            keywordOptions: ['title'],
        }), 'true');
        assert.equal(evaluatePredicate({ keywordOption: 'TITLE', op: 'present' }, {}), 'indeterminate');
    });

    it('selects exactly one branch and reports overlap or unknown predicates', () => {
        const branches = [
            { when: { op: 'lt', value: 0 }, role: 'reference' },
            { when: { op: 'eq', value: 0 }, role: 'sentinel' },
        ];
        assert.equal(selectSemanticBranch(branches, { currentValue: -1 }).branch.role, 'reference');
        assert.equal(selectSemanticBranch(branches, { currentValue: '&LCID' }).state, 'indeterminate');
        assert.equal(selectSemanticBranch([
            { when: { op: 'ge', value: 0 }, role: 'literal' },
            { when: { op: 'eq', value: 1 }, role: 'enum' },
        ], { currentValue: 1 }).reason, 'overlapping-branches');
    });

    it('applies only the ID transform explicitly selected by a value branch', () => {
        const relation = {
            kind: 'entity-reference',
            targetKinds: ['curve'],
            branches: [{
                when: { op: 'lt', value: 0 },
                role: 'reference',
                targetKinds: ['curve'],
                idTransform: 'negate',
            }],
        };
        const negative = resolveValueRole(relation, -42);
        assert.equal(negative.state, 'resolved');
        assert.equal(negative.role, 'reference');
        assert.equal(negative.idTransform, 'negate');
        assert.equal(applyReferenceIdTransform(-42, negative.idTransform), 42);
        assert.equal(resolveValueRole(relation, 42).role, 'unknown');
        assert.equal(resolveValueRole(relation, '&LCID').state, 'indeterminate');
        assert.equal(applyReferenceIdTransform(-42, 'identity'), null);
        assert.equal(applyReferenceIdTransform(-42, 'abs'), 42);
    });
});
