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

    it('classifies MAT_ADD_EROSION signed real failure fields from schema help metadata', () => {
        const schema = keywordSchema.loadKeywordSchema(() => 'en');
        const lookup = keywordSchema.lookupKeywordSchema('MAT_ADD_EROSION', schema);
        const failureCard = lookup.entry.c[1];
        const sigp1 = failureCard.find(item => item.n === 'SIGP1');
        const sigvm = failureCard.find(item => item.n === 'SIGVM');

        const sigp1Info = getFieldReferenceInfo({
            keyword: 'MAT_ADD_EROSION',
            cardIndex: 2,
            field: sigp1,
        });
        const sigvmInfo = getFieldReferenceInfo({
            keyword: 'MAT_ADD_EROSION',
            cardIndex: 2,
            field: sigvm,
        });

        assert.deepEqual(sigp1Info.targetKinds, ['curve']);
        assert.equal(sigp1Info.fieldType, 'real');
        assert.equal(sigp1Info.requiresSignedSwitch, true);
        assert.deepEqual(sigvmInfo.targetKinds, ['curve']);
        assert.equal(sigvmInfo.fieldType, 'real');
        assert.equal(sigvmInfo.requiresSignedSwitch, true);
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

    it('classifies explicit generic DEFINE targets from generated schema metadata', () => {
        const info = getFieldReferenceInfo({
            keyword: 'AIRBAG_PARTICLE',
            cardIndex: 6,
            field: { n: 'CHM' },
        });

        assert.deepEqual(info.targetKinds, []);
        assert.deepEqual(info.targetDefinitions, ['DEFINE_CPM_CHAMBER']);
    });

    it('parses integer reference values and strips negative switch signs by default', () => {
        const positive = parseFieldReferenceValue('      1001', { allowSignedSwitch: true });
        assert.equal(positive.kind, 'numeric');
        assert.equal(positive.id, 1001);
        assert.equal(positive.raw, '1001');
        assert.equal(positive.isSignedSwitch, false);
        assert.deepEqual(positive.input, { kind: 'numeric', raw: '1001', value: 1001 });

        const negative = parseFieldReferenceValue('        -7', { allowSignedSwitch: true });
        assert.equal(negative.kind, 'numeric');
        assert.equal(negative.id, 7);
        assert.equal(negative.raw, '-7');
        assert.equal(negative.isSignedSwitch, true);
        assert.deepEqual(negative.input, { kind: 'numeric', raw: '-7', value: -7 });

        assert.equal(parseFieldReferenceValue('         0', { allowSignedSwitch: true }), null);
        assert.equal(parseFieldReferenceValue('        -7', { allowSignedSwitch: false }), null);
    });

    it('preserves parameter-controlled reference values and signed-switch form', () => {
        const parameter = parseFieldReferenceValue('     &LCSS', { allowSignedSwitch: true });
        assert.equal(parameter.kind, 'parameter');
        assert.equal(parameter.parameterName, 'LCSS');
        assert.equal(parameter.raw, '&LCSS');
        assert.equal(parameter.isSignedSwitch, false);
        assert.deepEqual(parameter.input, {
            kind: 'parameter',
            raw: '&LCSS',
            name: 'LCSS',
            negated: false,
        });

        const signedParameter = parseFieldReferenceValue('    -&LCSS', { allowSignedSwitch: true });
        assert.equal(signedParameter.kind, 'parameter');
        assert.equal(signedParameter.parameterName, 'LCSS');
        assert.equal(signedParameter.isSignedSwitch, true);
        assert.equal(parseFieldReferenceValue('-&LCSS', { allowSignedSwitch: false }), null);
    });

    it('parses signed real references only when the schema says the switch is required', () => {
        const signedRealInfo = {
            allowSignedSwitch: true,
            requiresSignedSwitch: true,
            fieldType: 'real',
        };

        const parsed = parseFieldReferenceValue(' -31001008.0', signedRealInfo);
        assert.equal(parsed.kind, 'numeric');
        assert.equal(parsed.id, 31001008);
        assert.equal(parsed.raw, '-31001008.0');
        assert.equal(parsed.isSignedSwitch, true);
        assert.deepEqual(parsed.input, {
            kind: 'numeric',
            raw: '-31001008.0',
            value: -31001008,
        });
        assert.equal(parseFieldReferenceValue('  31001008.0', signedRealInfo), null);
        assert.equal(parseFieldReferenceValue('        -0.5', signedRealInfo), null);
        assert.equal(parseFieldReferenceValue('       &CID', signedRealInfo), null);
        assert.equal(parseFieldReferenceValue('      -&CID', signedRealInfo).kind, 'parameter');
    });
});
