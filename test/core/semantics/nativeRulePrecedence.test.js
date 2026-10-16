const assert = require('node:assert/strict');
const schema = require('../../../out/core/keywordSchema');
const { getCatalogInputFormCatalogV4 } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
const { getActionableFieldReferenceInfo, getRegistryApprovedFieldReferenceInfo } = require('../../../out/core/references/fieldReferenceClassifier');
const { getCatalogFieldReferenceInfo } = require('../../../out/core/references/registryReferenceScanner');
const { analyzeKeywordStructureLines } = require('../../../out/core/structure/structureAnalyzer');
const { getKeywordSemanticAdvice } = require('../../../out/core/semantics/manualSemanticAdvisor');
const { planOfficialFieldChoices } = require('../../../out/core/semantics/officialFieldChoicePlanner');
const { nativeFileCatalogKeyword } = require("../../../out/core/semantics/catalogNativeFileLayout");
const doc = lines => ({ version: 1, lineCount: lines.length, lineAt: line => ({ text: lines[line] }) });
const forbidden = () => { throw Error('manual rules must not override native authority'); };

describe('native rules precede manual supplements across consumers', () => {
    it('uses native reference targets even when the manual adds another namespace', () => {
        const field = schema.lookupKeywordSchema('MAT_PIECEWISE_LINEAR_PLASTICITY').entry.c[1].find(f => f.n === 'LCSS');
        const request = { keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY', cardIndex: 2, field };
        assert.deepEqual(getRegistryApprovedFieldReferenceInfo(request).targetKinds, ['curve', 'table']);
        assert.deepEqual(getActionableFieldReferenceInfo(request), getCatalogFieldReferenceInfo(request));
        assert.deepEqual(getActionableFieldReferenceInfo(request).targetKinds, ['curve']);
    });

    it('does not let a manual grammar reject native records or repair an unresolved native branch', () => {
        for (const [keyword, lines, status] of [
            ['MAT_ELASTIC', ['         0'.repeat(8)], 'valid'],
            ['SECTION_SHELL', ['         0'.repeat(8)], 'context-dependent'],
            ['CONTACT_AUTOMATIC_SURFACE_TO_SURFACE', ['         0'.repeat(8)], 'context-dependent'],
            ['CONTACT_AUTOMATIC_SURFACE_TO_SURFACE', Array(11).fill('         0'.repeat(8)), 'context-dependent'],
            ['MAT_ELASTIC_TITLE', ['Native title', '         0'.repeat(8)], 'valid'],
        ]) {
            const result = analyzeKeywordStructureLines('*' + keyword, lines.map((text, i) => ({ text, line: i + 1 })),
                { catalog: { grammarForKeyword: forbidden } });
            assert.equal(result.status, status, keyword + ': ' + result.reason);
            assert.ok(result.sourceProfileId.startsWith('lspp:'));
            assert.deepEqual(result.repairCandidates, []);
        }
    });

    it('retains the manual structure fallback when no native reader exists', () => {
        let called = false;
        const result = analyzeKeywordStructureLines('*CONTROL_TERMINATION', [{ line: 1, text: '         0'.repeat(8) }], {
            catalog: { grammarForKeyword() { called = true; return { status: 'unverified', reason: 'manual-fallback' }; } },
        });
        assert.equal(called, true);
        assert.equal(result.reason, 'manual-fallback');
    });

    it('suppresses manual conditions and option restrictions covered by native rules', () => {
        const result = getKeywordSemanticAdvice('*MAT_ELASTIC_TITLE', {}, { rulesForKeyword: () => [
            {ruleId:'native-e',kind:'card-presence',relation:{kind:'card-presence',card:'Card 1.1',presence:'conditional',when:{field:'E',op:'lt',value:0}}},
            {ruleId:'manual-other',kind:'card-presence',relation:{kind:'card-presence',card:'Other',presence:'conditional',when:{field:'OTHER',op:'eq',value:1}}},
            ...['TITLE','OTHER'].map(optionSlot=>({ruleId:optionSlot,kind:'keyword-option',relation:{kind:'keyword-option',optionSlot}})),
        ] });
        assert.deepEqual(result.cards.map(card=>card.ruleId), ['manual-other']);
        assert.deepEqual(result.optionSlots.map(slot=>slot.slot), ['OTHER']);
        assert.equal(schema.keywordPrefixOptionDecision('DEFINE_FUNCTION', 'TITLE'), 'allow');
        const prefix = schema.getVerifiedPrefixLayout(schema.lookupKeywordSchema('DEFINE_FUNCTION_TITLE'));
        assert.equal(prefix.status, 'verified');
        assert.ok(prefix.policyIds.every(id => id.startsWith('lspp:')));
    });

    it('keeps native catalog identity and selectors before manual aliases and filters', () => {
        const catalog = getCatalogInputFormCatalogV4();
        const keyword = 'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE';
        const nativeBase = catalog.formForKeyword(keyword, false);
        const composedBase = catalog.formForKeyword(keyword);
        for (const id of nativeBase.reference.formRuleIds)
            assert.deepEqual(composedBase.rules[id].cards, nativeBase.rules[id].cards, 'composition preserves native base descriptors');
        assert.equal(nativeFileCatalogKeyword('CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION_ID_MPP'),
            'CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION');
        const raw = catalog.formForKeyword('CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION', false);
        const bound = catalog.formForKeyword('CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION_ID_MPP', false);
        assert.deepEqual(bound.reference.formRuleIds, raw.reference.formRuleIds);
        for (const id of raw.reference.formRuleIds) assert.deepEqual(bound.rules[id].cards, raw.rules[id].cards);
        const fallback = catalog.formForKeyword('CONTACT_AUTOMATIC_SINGLE_SURFACE');
        assert.ok(fallback.reference.formRuleIds.some(id => fallback.rules[id].contactComposition));
    });

    it('uses manual value evidence when the field has no native enumeration', () => {
        const field = { n: 'FLAG', t: 'integer', p: 0, w: 10 };
        const fixture = { MANUAL_ONLY: { c: [[field]] } };
        const result = planOfficialFieldChoices(doc(['*MANUAL_ONLY', '         0']), { line: 1, character: 1 }, fixture, {
            keywordLine: 0,
            rulesForField: () => [{ keyword: '*MANUAL_ONLY', ruleId: 'manual:flag', field: 'FLAG', kind: 'field-choice',
                relation: { kind: 'field-choice', branches: [0, 1].map(value => ({ when: { op: 'eq', value }, role: 'enum' })) } }],
        });
        assert.equal(result.status, 'ready');
        assert.equal(result.ruleId, 'manual:flag');
        const native = planOfficialFieldChoices(doc(['*CONTROL_TERMINATION', '         0'.repeat(8)]),
            { line: 1, character: 51 }, schema.loadKeywordSchema(), { keywordLine: 0, rulesForField: forbidden });
        assert.equal(native.status, 'ready');
        assert.deepEqual(native.choices.map(choice => choice.valueText), ['0', '1']);
    });

    it('uses native physical fields for display identity despite a conflicting help schema', () => {
        const { summarizeKeywordIdentity } = require('../../../out/core/keywordDisplayIdentity');
        const conflicting = { MAT_ELASTIC: { c: [[{ n: 'MID', t: 'integer', p: 20, w: 10 }]] } };
        const result = summarizeKeywordIdentity('MAT_ELASTIC', ['        42         1       999'], { schema: conflicting });
        assert.deepEqual(result.identity, { field: 'MID', value: '42' });
    });
});
