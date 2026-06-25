const assert = require('assert');
const path = require('path');

describe('field reference index', () => {
    it('contains generated curve/table field metadata from schema help', () => {
        const index = require(path.join('..', '..', '..', 'keywords', 'field_reference_index.json'));
        const references = index.references || {};
        const mat024 = references.MAT_PIECEWISE_LINEAR_PLASTICITY || {};

        assert.equal(index.schemaVersion, 1);
        assert.deepEqual(index.generatedFrom, {
            fieldData: 'keywords/field_data.json',
        });
        assert.ok(index.definitionKeywords.scanned.length >= 50);
        assert.ok(index.definitionKeywords.scanned.includes('DEFINE_CURVE_FUNCTION'));
        assert.ok(index.definitionKeywords.scanned.includes('DEFINE_TABLE_3D'));
        assert.deepEqual(mat024['2:LCSS'].targetKinds, ['curve', 'table']);
        assert.equal(mat024['2:LCSS'].confidence, 'high');
        assert.equal(mat024['2:LCSS'].source, 'schema-help');
        assert.equal(mat024['1:MID'], undefined);
        assert.ok(Object.keys(references).length > 100);
    });
});
