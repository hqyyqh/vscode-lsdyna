const assert = require('assert');
const keywordSchema = require('../../../out/core/keywordSchema');
const {
    getFieldReferenceInfo,
    parseFieldReferenceValue,
} = require('../../../out/core/references/fieldReferenceClassifier');

describe('fieldReferenceClassifier', () => {
    it('classifies MAT_024 LCSS as curve or table from generated explicit metadata', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_PIECEWISE_LINEAR_PLASTICITY', schema);
        const field = lookup.entry.c[1].find(item => item.n === 'LCSS');

        const info = getFieldReferenceInfo({
            keyword: 'MAT_PIECEWISE_LINEAR_PLASTICITY',
            cardIndex: 2,
            field,
        });

        assert.deepEqual(info.targetKinds, ['curve', 'table']);
        assert.equal(info.confidence, 'explicit');
        assert.equal(info.source, 'override');
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
        assert.equal(info.confidence, 'explicit');
        assert.equal(info.source, 'override');
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
});
