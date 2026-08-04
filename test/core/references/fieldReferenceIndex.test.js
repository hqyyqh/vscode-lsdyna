const assert = require('assert');
const path = require('path');

describe('field reference index', () => {
    it('contains generated curve/table field metadata from schema help', () => {
        const index = require(path.join('..', '..', '..', 'keywords', 'field_reference_index.json'));
        const references = index.references || {};
        const mat024 = references.MAT_PIECEWISE_LINEAR_PLASTICITY || {};
        const matAddErosion = references.MAT_ADD_EROSION || {};
        const matAddErosionTitle = references.MAT_ADD_EROSION_TITLE || {};
        const airbagHybridJetting = references.AIRBAG_HYBRID_JETTING || {};
        const airbagPressureVolume = references.AIRBAG_SIMPLE_PRESSURE_VOLUME || {};

        assert.equal(index.schemaVersion, 1);
        assert.deepEqual(index.generatedFrom, {
            fieldData: 'keywords/field_data.json',
        });
        assert.ok(index.definitionKeywords.scanned.length >= 50);
        assert.ok(index.definitionKeywords.scanned.includes('DEFINE_CURVE_FUNCTION'));
        assert.ok(index.definitionKeywords.scanned.includes('DEFINE_TABLE_3D'));
        assert.ok(index.definitionKeywords.generic.DEFINE_CPM_CHAMBER);
        assert.equal(
            index.definitionKeywords.generic.DEFINE_CPM_CHAMBER_TITLE.target,
            'DEFINE_CPM_CHAMBER',
        );
        assert.ok(index.definitionKeywords.ambiguousIdFields.some(item => item.reason === 'missing-schema-entry'));
        assert.ok(Object.values(references).every(rules => Object.values(rules).every(rule =>
            (rule.targetDefinitions || []).every(target =>
                Object.values(index.definitionKeywords.generic).some(descriptor => descriptor.target === target)
            )
        )));
        assert.deepEqual(mat024['2:LCSS'].targetKinds, ['curve', 'table']);
        assert.equal(mat024['2:LCSS'].confidence, 'high');
        assert.equal(mat024['2:LCSS'].source, 'schema-help');
        assert.deepEqual(matAddErosion['2:SIGP1'].targetKinds, ['curve']);
        assert.equal(matAddErosion['2:SIGP1'].fieldType, 'real');
        assert.equal(matAddErosion['2:SIGP1'].requiresSignedSwitch, true);
        assert.deepEqual(matAddErosion['2:SIGVM'].targetKinds, ['curve']);
        assert.equal(matAddErosion['2:SIGVM'].requiresSignedSwitch, true);
        assert.deepEqual(matAddErosionTitle['3:SIGP1'].targetKinds, ['curve']);
        assert.equal(matAddErosionTitle['3:SIGP1'].requiresSignedSwitch, true);
        assert.deepEqual(airbagHybridJetting['7:CA'].targetKinds, ['curve']);
        assert.equal(airbagHybridJetting['7:CA'].requiresSignedSwitch, true);
        assert.equal(airbagPressureVolume['2:BETA'], undefined);
        assert.equal(mat024['1:MID'], undefined);
        assert.ok(Object.keys(references).length > 100);
    });

    it('keeps every generic definition descriptor aligned with rendered schema cards', () => {
        const index = require(path.join('..', '..', '..', 'keywords', 'field_reference_index.json'));
        const schema = require(path.join('..', '..', '..', 'keywords', 'field_data.json'));
        const { getRenderedCards, lookupKeywordSchema } = require('../../../out/core/keywordSchema');
        const generic = index.definitionKeywords.generic;

        assert.equal(Object.keys(index.references).length, 2298);
        assert.equal(Object.keys(generic).length, 58);
        assert.equal(new Set(Object.values(generic).map(descriptor => descriptor.target)).size, 29);
        assert.equal(index.definitionKeywords.ambiguousIdFields.length, 11);

        for (const [keyword, descriptor] of Object.entries(generic)) {
            const lookup = lookupKeywordSchema(keyword, schema);
            assert.ok(lookup, `missing schema lookup for ${keyword}`);
            assert.equal(lookup.canonicalName, descriptor.target, `${keyword} target mismatch`);
            const card = getRenderedCards(lookup.entry, lookup.activeOptions)[descriptor.cardIndex - 1];
            const field = card && card[descriptor.fieldIndex];
            assert.ok(field, `missing ${keyword} descriptor field`);
            assert.deepEqual(
                [field.n, field.t, field.p, field.w],
                [descriptor.fieldName, descriptor.fieldType, descriptor.position, descriptor.width],
                `${keyword} descriptor layout mismatch`,
            );
        }
    });
});
