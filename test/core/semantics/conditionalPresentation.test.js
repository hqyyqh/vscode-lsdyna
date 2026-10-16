const assert = require('node:assert/strict');
const { groupConditionalAdvice, conditionLabel } = require('../../../out/core/semantics/conditionalPresentation');
const { getKeywordSemanticAdvice } = require('../../../out/core/semantics/manualSemanticAdvisor');
const { ManualSemanticCatalog } = require('../../../out/core/semantics/manualSemanticCatalog');
const path = require('node:path');
describe('conditional presentation', () => {
    it('groups BARLAT manual rules by structured predicates, not card prose or native ordinals', () => {
        const catalog = new ManualSemanticCatalog({ rootDir: path.resolve("keywords/runtime/manual-semantics") });
        const advice = getKeywordSemanticAdvice('*MANUAL_ONLY_CONDITIONS', { fields: { FIT: 0, HARD: 3 } },
            { rulesForKeyword: () => catalog.rulesForKeyword('*MAT_BARLAT_YLD2000') });
        const groups = groupConditionalAdvice(advice);
        const fit = groups.find(group => group.condition === 'FIT = 1');
        assert.ok(fit); assert.deepEqual(fit.cards, ['Card 3b.1', 'Card 3b.2']);
        assert.equal(fit.applicability, 'not-applicable'); assert.ok(fit.evidence.length);
        assert.equal(groups.find(group => group.condition === 'HARD = 3').cards.length, 3);
    });
    it('keeps prerequisites, ordering and repetition distinct and preserves unknown states', () => {
        const base = { presence: 'conditional', when: { field: 'FIT', op: 'eq', value: 1 }, applicability: 'indeterminate' };
        const cards = [
            { ...base, ruleId: 'a', card: 'A', summary: 'same text' },
            { ...base, ruleId: 'b', card: 'B', summary: 'unrelated words', when: { value: 1, op: 'eq', field: 'FIT' } },
            { ...base, ruleId: 'c', card: 'C', prerequisite: { card: 'P' } },
            { ...base, ruleId: 'd', card: 'D', ordering: { after: 'Q' } },
            { ...base, ruleId: 'e', card: 'E', repeat: { count: 'N' } },
        ];
        const groups = groupConditionalAdvice({ cards, unresolvedFields: ['FIT'], contextReason: 'field-unresolved' });
        assert.equal(groups.length, 4); assert.deepEqual(groups[0].cards, ['A', 'B']);
        assert.deepEqual(groups[0].unresolvedFields, ['FIT']); assert.equal(groups[0].applicability, 'indeterminate');
        assert.equal(conditionLabel({ all: [{ field: 'A', op: 'lt', value: 0 }, { field: 'FIT', op: 'eq', value: 1 }] }), '(A < 0 ∧ FIT = 1)');
        assert.equal(conditionLabel({ unsupported: true }), null);
    });
});

it('reports repeated native rows and reordering without collapsing duplicates', () => {
    const { nativeBranchSummary } = require('../../../out/core/semantics/conditionalPresentation');
    assert.deepEqual(nativeBranchSummary([1, 2, 2, 3], [1, 3, 2, 4]), {
        current: [1, 2, 2, 3], draft: [1, 3, 2, 4], added: [4], removed: [2], reordered: true,
    });
});
