const assert = require('assert');

const {
    getKeywordSemanticAdvice,
    predicateFieldsForCardAdvice,
    fieldChoiceAdviceFromRules,
} = require('../../../out/core/semantics/manualSemanticAdvisor');
const {
    ManualSemanticCatalog,
} = require('../../../out/core/semantics/manualSemanticCatalog');
const path = require('path');

const runtimeRoot = path.resolve(__dirname, '..', '..', '..', 'keywords', 'manual_semantics');

function fakeCatalog(rules) {
    return {
        requested: [],
        rulesForKeyword(keyword) {
            this.requested.push(keyword);
            return rules;
        },
    };
}

function cardRule({ card, presence, when, repeat }) {
    return {
        ruleId: `rule:${card}`,
        kind: 'card-presence',
        card,
        summary: `${card} official summary`,
        evidence: [{
            evidenceId: `evidence:${card}`,
            manualId: 'official-manual',
            page: 42,
            quoteSha256: 'not-exposed-by-advisor',
        }],
        relation: {
            kind: 'card-presence',
            card,
            presence,
            ...(when ? { when } : {}),
            ...(repeat ? { repeat } : {}),
        },
    };
}

describe('manual semantic advisor', () => {
    it('publishes the six official CONTACT slots in physical order without inventing values', () => {
        const catalog = new ManualSemanticCatalog({ rootDir: runtimeRoot });
        const advice = getKeywordSemanticAdvice('*CONTACT', {}, catalog);

        assert.deepEqual(advice.optionSlots.map(item => item.slot), [
            'OPTION1', 'OPTION2', 'OPTION3', 'OPTION4', 'OPTION5', 'OPTION6',
        ]);
        assert.deepEqual(advice.optionSlots.map(item => item.required), [
            true, false, false, false, false, false,
        ]);
        assert.ok(advice.optionSlots.every(item => item.evidence.some(evidence =>
            evidence.manualId === 'ls-dyna-dev-keyword-manual-vol-i' && evidence.page === 1128
        )));
        assert.ok(advice.optionSlots.every(item => !Object.hasOwn(item, 'values')));
    });

    it('evaluates conditional cards with true, false, and parameter-safe indeterminate states', () => {
        const catalog = fakeCatalog([
            cardRule({
                card: 'Anisotropic Damage Card',
                presence: 'conditional',
                when: { field: 'FLAG', op: 'eq', value: -1 },
            }),
        ]);

        assert.equal(
            getKeywordSemanticAdvice('*MAT_DAMAGE_1', { fields: { FLAG: -1 } }, catalog)
                .cards[0].applicability,
            'applicable',
        );
        assert.equal(
            getKeywordSemanticAdvice('*MAT_DAMAGE_1', { fields: { FLAG: 0 } }, catalog)
                .cards[0].applicability,
            'not-applicable',
        );
        const dynamic = getKeywordSemanticAdvice(
            '*MAT_DAMAGE_1',
            { fields: { FLAG: '&DAMAGE_MODE' } },
            catalog,
        ).cards[0];
        assert.equal(dynamic.applicability, 'indeterminate');
        assert.equal(dynamic.predicateState, 'indeterminate');
    });

    it('keeps required, optional, and repeat-only statements informational and non-diagnostic', () => {
        const catalog = fakeCatalog([
            cardRule({ card: 'Card 1', presence: 'required' }),
            cardRule({ card: 'Optional Card A', presence: 'optional' }),
            cardRule({
                card: 'Transformation Cards',
                presence: 'unspecified',
                repeat: { mode: 'repeatable', terminator: 'next-keyword' },
            }),
        ]);
        const cards = getKeywordSemanticAdvice('define_transformation', {}, catalog).cards;

        assert.deepEqual(cards.map(item => item.applicability), [
            'required', 'optional', 'informational',
        ]);
        assert.deepEqual(cards[2].repeat, {
            mode: 'repeatable',
            terminator: 'next-keyword',
        });
        assert.deepEqual(cards[0].evidence, [{
            evidenceId: 'evidence:Card 1',
            manualId: 'official-manual',
            page: 42,
        }]);
    });

    it('requests only the exact normalized catalog keyword and does not guess a family', () => {
        const catalog = fakeCatalog([]);
        const advice = getKeywordSemanticAdvice(
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            {},
            catalog,
        );

        assert.deepEqual(catalog.requested, ['*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE']);
        assert.deepEqual(advice.optionSlots, []);
        assert.deepEqual(advice.cards, []);
    });

    it('does not touch the catalog for an empty keyword', () => {
        const catalog = fakeCatalog([]);
        assert.deepEqual(getKeywordSemanticAdvice('  *  ', {}, catalog), {
            keyword: '',
            optionSlots: [],
            cards: [],
        });
        assert.deepEqual(catalog.requested, []);
    });

    it('collects nested predicate field dependencies without treating option slots as fields', () => {
        assert.deepEqual(predicateFieldsForCardAdvice([{
            when: {
                all: [
                    { field: 'x0', op: 'eq', value: 0 },
                    { any: [
                        { field: 'FVOPT', op: 'lt', value: 7 },
                        { not: { keywordOption: 'SPM', op: 'present' } },
                    ] },
                ],
            },
        }]), ['FVOPT', 'X0']);
    });

    it('projects finite documented equality branches without auto-triggering an open domain', () => {
        const advice = fieldChoiceAdviceFromRules([{
            keyword: '*MAT_TEST',
            field: 'FLAG',
            kind: 'field-choice',
            ruleId: 'rule:choice',
            summary: 'Official flag values.',
            evidence: [{ evidenceId: 'evidence:choice', manualId: 'manual-1', page: 9 }],
            relation: {
                kind: 'field-choice',
                branches: [
                    { when: { op: 'eq', value: -1 }, role: 'enum' },
                    { when: { op: 'eq', value: 0 }, role: 'sentinel' },
                    { when: { op: 'gt', value: 0 }, role: 'literal' },
                ],
            },
        }]);

        assert.deepEqual(advice.choices, [
            { value: -1, valueText: '-1', role: 'enum' },
            { value: 0, valueText: '0', role: 'sentinel' },
        ]);
        assert.equal(advice.domainKind, 'mixed');
        assert.equal(advice.domainComplete, false);
        assert.equal(advice.automatic, false);
        assert.equal(advice.evidence[0].page, 9);
    });

    it('keeps future pack-specific evidence locations separate without guessing pages', () => {
        const englishProfile = 'a'.repeat(64);
        const bilingualProfile = 'b'.repeat(64);
        const advice = fieldChoiceAdviceFromRules([{
            keyword: '*MAT_TEST',
            field: 'FLAG',
            kind: 'field-choice',
            ruleId: 'rule:profile-locations',
            evidence: [{
                evidenceId: 'evidence:profile-locations',
                locations: [
                    {
                        sourceProfileId: englishProfile,
                        manualId: 'manual-vol-ii',
                        page: 832,
                    },
                    {
                        sourceProfileId: bilingualProfile,
                        manualId: 'manual-vol-ii',
                        page: 814,
                    },
                ],
            }],
            relation: {
                kind: 'field-choice',
                branches: [{ when: { op: 'eq', value: 1 }, role: 'enum' }],
            },
        }]);

        assert.deepEqual(advice.evidence, [
            {
                evidenceId: 'evidence:profile-locations',
                manualId: 'manual-vol-ii',
                page: 832,
                sourceProfileId: englishProfile,
            },
            {
                evidenceId: 'evidence:profile-locations',
                manualId: 'manual-vol-ii',
                page: 814,
                sourceProfileId: bilingualProfile,
            },
        ]);
    });

    it('keeps literal/reference and large choice lists explicit-only', () => {
        const rule = {
            keyword: '*TEST',
            field: 'MODE',
            kind: 'field-choice',
            ruleId: 'rule:explicit',
            relation: {
                kind: 'field-choice',
                branches: [
                    { when: { op: 'eq', value: 'TMAX' }, role: 'literal' },
                    { when: { op: 'eq', value: -1 }, role: 'reference' },
                ],
            },
        };
        assert.equal(fieldChoiceAdviceFromRules([rule]).domainKind, 'mixed');
        assert.equal(fieldChoiceAdviceFromRules([rule]).automatic, false);
        rule.relation.branches = Array.from({ length: 13 }, (_, value) => ({
            when: { op: 'eq', value },
            role: 'enum',
        }));
        assert.equal(fieldChoiceAdviceFromRules([rule]).domainKind, 'closed');
        assert.equal(fieldChoiceAdviceFromRules([rule]).domainComplete, true);
        assert.equal(fieldChoiceAdviceFromRules([rule]).automatic, false);
    });

    it('keeps a finite sentinel explicit-only when the same field has an open reference branch', () => {
        const advice = fieldChoiceAdviceFromRules([{
            keyword: '*CONTROL_TEST',
            field: 'TMAX',
            kind: 'field-choice',
            ruleId: 'rule:mixed-domain',
            relation: {
                kind: 'field-choice',
                branches: [
                    { when: { op: 'eq', value: 0 }, role: 'sentinel' },
                    { when: { op: 'lt', value: 0 }, role: 'reference' },
                ],
            },
        }]);

        assert.deepEqual(advice.choices, [
            { value: 0, valueText: '0', role: 'sentinel' },
        ]);
        assert.equal(advice.domainKind, 'mixed');
        assert.equal(advice.domainComplete, false);
        assert.equal(advice.automatic, false);
    });

    it('fails open on overlapping field-choice rules or duplicate values', () => {
        const rule = {
            keyword: '*TEST',
            field: 'MODE',
            kind: 'field-choice',
            ruleId: 'rule:one',
            relation: {
                kind: 'field-choice',
                branches: [
                    { when: { op: 'eq', value: 1 }, role: 'enum' },
                    { when: { op: 'eq', value: 1 }, role: 'sentinel' },
                ],
            },
        };
        assert.equal(fieldChoiceAdviceFromRules([rule]), null);
        rule.relation.branches[1].when.value = '1';
        assert.equal(fieldChoiceAdviceFromRules([rule]), null);
        rule.relation.branches.pop();
        assert.equal(fieldChoiceAdviceFromRules([rule, { ...rule, ruleId: 'rule:two' }]), null);
    });
});
