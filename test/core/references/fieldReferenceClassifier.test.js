const assert = require('assert');
const keywordSchema = require('../../../out/core/keywordSchema');
const {
    getFieldReferenceInfo,
    parseFieldReferenceValue,
} = require('../../../out/core/references/fieldReferenceClassifier');

describe('fieldReferenceClassifier', () => {
    it('classifies MAT_024 LCSS as curve or table from schema help metadata', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_PIECEWISE_LINEAR_PLASTICITY', schema);
        const field = lookup.entry.c[1].find(item => item.n === 'LCSS');

        const info = getFieldReferenceInfo({
            keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY',
            cardIndex: 2,
            field,
        });

        assert.deepEqual(info.targetKinds, ['curve', 'table']);
        assert.equal(info.confidence, 'high');
        assert.equal(info.source, 'schema-help');
    });

    it('classifies MAT_024_TITLE LCSS as curve or table at cardIndex 3', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_PIECEWISE_LINEAR_PLASTICITY_TITLE', schema);
        const field = lookup.entry.c[1].find(item => item.n === 'LCSS');

        const info = getFieldReferenceInfo({
            keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY_TITLE',
            cardIndex: 3,
            field,
        });

        assert.deepEqual(info.targetKinds, ['curve', 'table']);
        assert.equal(info.confidence, 'high');
        assert.equal(info.source, 'schema-help');
    });

    it('classifies MAT_ADD_EROSION signed real damage fields from schema help metadata', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_ADD_EROSION', schema);
        const damageCard = lookup.entry.c[2];
        const ecrit = damageCard.find(item => item.n === 'ECRIT');
        const fadexp = damageCard.find(item => item.n === 'FADEXP');

        const ecritInfo = getFieldReferenceInfo({
            keyword: 'MAT_ADD_EROSION',
            cardIndex: 3,
            field: ecrit,
        });
        const fadexpInfo = getFieldReferenceInfo({
            keyword: 'MAT_ADD_EROSION',
            cardIndex: 3,
            field: fadexp,
        });

        assert.deepEqual(ecritInfo.targetKinds, ['curve', 'table']);
        assert.equal(ecritInfo.fieldType, 'real');
        assert.equal(ecritInfo.requiresSignedSwitch, true);
        assert.deepEqual(fadexpInfo.targetKinds, ['curve']);
        assert.equal(fadexpInfo.fieldType, 'real');
        assert.equal(fadexpInfo.requiresSignedSwitch, true);
    });

    it('does not classify non-curve/table integer fields', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_PIECEWISE_LINEAR_PLASTICITY', schema);
        const field = lookup.entry.c[0].find(item => item.n === 'MID');

        const info = getFieldReferenceInfo({
            keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY',
            cardIndex: 1,
            field,
        });

        assert.equal(info, null);
    });

    it('parses integer reference values and strips negative switch signs by default', () => {
        assert.deepEqual(parseFieldReferenceValue('      1001', { allowSignedSwitch: true }), {
            id: 1001,
            raw: '1001',
            isSignedSwitch: false,
        });
        assert.deepEqual(parseFieldReferenceValue('        -7', { allowSignedSwitch: true }), {
            id: 7,
            raw: '-7',
            isSignedSwitch: true,
        });
        assert.equal(parseFieldReferenceValue('         0', { allowSignedSwitch: true }), null);
        assert.equal(parseFieldReferenceValue('     &LCSS', { allowSignedSwitch: true }), null);
        assert.equal(parseFieldReferenceValue('        -7', { allowSignedSwitch: false }), null);
    });

    it('parses signed real references only when the schema says the switch is required', () => {
        const signedRealInfo = {
            allowSignedSwitch: true,
            requiresSignedSwitch: true,
            fieldType: 'real',
        };

        assert.deepEqual(parseFieldReferenceValue(' -31001008.0', signedRealInfo), {
            id: 31001008,
            raw: '-31001008.0',
            isSignedSwitch: true,
        });
        assert.equal(parseFieldReferenceValue('  31001008.0', signedRealInfo), null);
        assert.equal(parseFieldReferenceValue('        -0.5', signedRealInfo), null);
    });
});
