const assert = require('node:assert/strict');
const { nativeCoversCondition } = require('../../../out/core/semantics/nativeRuleCoverage');
const { nativeAppendLayoutMatches } = require('../../../out/core/semantics/nativeFileReadContext');
const { analyzeKeywordStructureLines } = require('../../../out/core/structure/structureAnalyzer');
const { getCatalogInputFormCatalogV4 } = require("../../../out/core/semantics/catalogInputFormCatalogV4");

describe('manual supplements use specific native capabilities', () => {
    it('distinguishes an actual native branch from unrelated field and reader evidence', () => {
        assert.equal(nativeCoversCondition('MAT_ELASTIC', { field: 'E' }), true);
        assert.equal(nativeCoversCondition('MAT_ELASTIC_TITLE', { field: 'E' }), true);
        assert.equal(nativeCoversCondition('MAT_ELASTIC', { field: 'UNRELATED' }), false);
        assert.equal(nativeCoversCondition('CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION_ID_MPP', { field: 'FORMULA' }), false);
        assert.equal(nativeCoversCondition('MAT_ELASTIC', { predicates: [{field:'E'}, {field:'UNRELATED'}] }), false);
    });

    it('accepts a missing native card without granting an extra instance or guessing parameters', () => {
        const row = value => ['1', '1', value].map(v => String(v).padStart(10)).join('').padEnd(80);
        assert.equal(nativeAppendLayoutMatches('*MAT_ELASTIC', [row(-1)], [' '.repeat(80)], 'standard'), true);
        assert.equal(nativeAppendLayoutMatches('*MAT_ELASTIC', [row(1)], [' '.repeat(80)], 'standard'), false);
        assert.equal(nativeAppendLayoutMatches('*MAT_ELASTIC', [row('&unknown')], [' '.repeat(80)], 'standard'), false);
        assert.equal(nativeAppendLayoutMatches('*MAT_ELASTIC', [row(-1)], [' '.repeat(80), ' '.repeat(80)], 'standard'), false);
    });

    it('retains reviewed manual repair authority when its append agrees with the native branch', () => {
        const form = getCatalogInputFormCatalogV4().formForKeyword('MAT_ELASTIC', false);
        const cards = form.rules[form.reference.formRuleIds[0]].cards;
        const profile = 'a'.repeat(64);
        const nodes = cards.map((card, index) => ({type:'record',nodeId:'card-'+index,cardNodeId:'card-'+index,
            cardLabel:'Card '+(index+1),sourceProfileId:profile,verificationStatus:'verified-full',blankAllowed:true,
            geometryRef:{kind:'official-field-signature',fieldWidth:10,
                fields:card.fields.map((field,i)=>({index:i,name:field.name,typeCode:field.type===1?'I':'R'}))}}));
        const grammar = {grammarId:'reviewed-append',keyword:'*MAT_ELASTIC',sourceProfileId:profile,verificationStatus:'verified-full',
            root:{type:'sequence',nodeId:'root',sourceProfileId:profile,verificationStatus:'verified-full',nodes},
            repairPolicy:{automatic:false,uniqueRepairEligible:true,mode:'append-contiguous-blank-suffix',
                insertableCardOrdinals:[2],minimumExistingPhysicalCard:1,targetPhysicalCard:2}};
        const catalog = {grammarForKeyword:()=>({status:'verified',grammar})};
        const row = '         1         1        -1'.padEnd(80);
        const result = analyzeKeywordStructureLines('*MAT_ELASTIC', [{line:1,text:row}], {catalog});
        assert.equal(result.status, 'definite-error');
        assert.equal(result.repairCandidates.length, 1);
        assert.equal(result.details.nativeRepairLayoutVerified, true);
        const unknown = analyzeKeywordStructureLines('*MAT_ELASTIC', [{line:1,text:row.replace('        -1','  &unknown')}], {catalog});
        assert.deepEqual(unknown.repairCandidates, []);
    });
});
