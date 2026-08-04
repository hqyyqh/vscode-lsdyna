'use strict';

const assert = require('assert');
const { buildIndex } = require('../../scripts/generate-field-reference-index.cjs');

describe('generate field reference index', () => {
    it('indexes explicit DEFINE targets only in an ID/reference context', () => {
        const index = buildIndex({
            DEFINE_CPG_GAS_PROPERTIES: {
                c: [[{
                    n: 'ID',
                    p: 0,
                    w: 10,
                    t: 'integer',
                    h: 'Unique ID for this gas-properties definition.',
                }]],
                o: [{
                    n: 'TITLE',
                    co: 'pre/1',
                    to: 1,
                    c: [[{ n: 'TITLE', p: 0, w: 80, t: 'string', h: 'Additional title line.' }]],
                }],
            },
            DEFINE_CPG_GAS_PROPERTIES_TITLE: {
                x: 'DEFINE_CPG_GAS_PROPERTIES',
                active: ['TITLE'],
                c: [[{
                    n: 'ID',
                    p: 0,
                    w: 10,
                    t: 'integer',
                    h: 'Unique ID for this gas-properties definition.',
                }]],
            },
            AIRBAG: {
                c: [[{
                    n: 'GASID',
                    p: 0,
                    w: 10,
                    t: 'integer',
                    h: 'ID reference to *DEFINE_CPG_GAS_PROPERTIES.',
                }]],
            },
            NOT_A_REFERENCE: {
                c: [[{
                    n: 'VALUE',
                    p: 0,
                    w: 10,
                    t: 'integer',
                    h: 'Use the *DEFINE_CPG_GAS_PROPERTIES keyword for setup.',
                }]],
            },
        });

        assert.deepEqual(
            index.references.AIRBAG['1:GASID'].targetDefinitions,
            ['DEFINE_CPG_GAS_PROPERTIES']
        );
        assert.equal(index.references.NOT_A_REFERENCE, undefined);
        assert.deepEqual(index.definitionKeywords.generic.DEFINE_CPG_GAS_PROPERTIES, {
            target: 'DEFINE_CPG_GAS_PROPERTIES',
            score: 100,
            cardIndex: 1,
            fieldIndex: 0,
            fieldName: 'ID',
            fieldType: 'integer',
            position: 0,
            width: 10,
        });
        assert.equal(index.definitionKeywords.generic.DEFINE_CPG_GAS_PROPERTIES_TITLE.cardIndex, 2);
    });

    it('drops links to missing or non-identifiable DEFINE targets', () => {
        const index = buildIndex({
            DEFINE_CABLE: {
                c: [[
                    { n: 'BBPID', p: 0, w: 10, t: 'integer', h: 'Beam part ID for the cable core.' },
                    { n: 'SHLPID', p: 10, w: 10, t: 'integer', h: 'Shell part ID.' },
                ]],
            },
            SOURCE: {
                c: [[
                    { n: 'CABLEID', p: 0, w: 10, t: 'integer', h: 'ID reference to *DEFINE_CABLE.' },
                    { n: 'MISSINGID', p: 10, w: 10, t: 'integer', h: 'ID reference to *DEFINE_NOT_REAL.' },
                ]],
            },
        });

        assert.equal(index.references.SOURCE, undefined);
        assert.ok(index.definitionKeywords.ambiguousIdFields.some(item =>
            item.target === 'DEFINE_CABLE' && item.reason === 'missing-id-field'
        ));
        assert.ok(index.definitionKeywords.ambiguousIdFields.some(item =>
            item.target === 'DEFINE_NOT_REAL' && item.reason === 'missing-schema-entry'
        ));
    });
});
