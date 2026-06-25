const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    patchMatAddErosionDamageFields,
    patchMatAddErosionSnippets,
} = require('../../scripts/patch-mat-add-erosion-damage-fields.cjs');

function makeCard() {
    return [
        { n: 'IDAM', p: 0, w: 10, h: 'Flag for damage model.', t: 'integer' },
        { n: 'UNUSED', p: 10, w: 10, h: '', t: 'integer' },
        { n: 'UNUSED', p: 20, w: 10, h: '', t: 'integer' },
        { n: 'UNUSED', p: 30, w: 10, h: '', t: 'integer' },
        { n: 'UNUSED', p: 40, w: 10, h: '', t: 'integer' },
        { n: 'UNUSED', p: 50, w: 10, h: '', t: 'integer' },
        { n: 'UNUSED', p: 60, w: 10, h: '', t: 'integer' },
        { n: 'LCREGD', p: 70, w: 10, h: 'regularization curve', t: 'integer' },
    ];
}

function makeSchema() {
    return {
        MAT_ADD_EROSION: { c: [[], [], makeCard()] },
        MAT_ADD_EROSION_TITLE: { x: 'MAT_ADD_EROSION', active: ['TITLE'], c: [[], [], makeCard()] },
    };
}

function fieldNames(schema, keyword) {
    return schema[keyword].c[2].map(field => field.n);
}

function makeSnippets() {
    return {
        '*MAT_ADD_EROSION': {
            body: [
                '*MAT_ADD_EROSION',
                '$#    idam    unused    unused    unused    unused    unused    unused    lcregd',
                '${17:      IDAM}${18:    UNUSED}${19:    UNUSED}${20:    UNUSED}${21:    UNUSED}${22:    UNUSED}${23:    UNUSED}${24:    LCREGD}',
                '$0',
            ],
        },
        '*MAT_ADD_EROSION_TITLE': {
            body: [
                '*MAT_ADD_EROSION_TITLE',
                '$# title                                                                        ',
                '${1:TITLE}',
                '$#    idam    unused    unused    unused    unused    unused    unused    lcregd',
                '${18:      IDAM}${19:    UNUSED}${20:    UNUSED}${21:    UNUSED}${22:    UNUSED}${23:    UNUSED}${24:    UNUSED}${25:    LCREGD}',
                '$0',
            ],
        },
    };
}

describe('patchMatAddErosionDamageFields', () => {
    it('restores legacy damage fields in English MAT_ADD_EROSION schemas', () => {
        const schema = makeSchema();

        const result = patchMatAddErosionDamageFields(schema, 'en');

        assert.equal(result.changedFields, 12);
        assert.deepEqual(fieldNames(schema, 'MAT_ADD_EROSION'), [
            'IDAM', 'DMGTYP', 'LCSDG', 'ECRIT', 'DMGEXP', 'DCRIT', 'FADEXP', 'LCREGD',
        ]);
        assert.deepEqual(fieldNames(schema, 'MAT_ADD_EROSION_TITLE'), [
            'IDAM', 'DMGTYP', 'LCSDG', 'ECRIT', 'DMGEXP', 'DCRIT', 'FADEXP', 'LCREGD',
        ]);

        const fields = schema.MAT_ADD_EROSION.c[2];
        assert.deepEqual(fields.slice(1, 7).map(field => field.t), [
            'integer', 'integer', 'real', 'real', 'real', 'real',
        ]);
        assert.ok(fields[1].h.includes('DMGTYP is interpreted digit-wise'));
        assert.ok(fields[2].h.includes('Load curve ID or Table ID'));
        assert.ok(fields[3].h.includes('Critical plastic strain'));
        assert.ok(fields[6].h.includes('damage-related stress fadeout'));
    });

    it('adds localized Chinese help while preserving mirrored structure', () => {
        const schema = makeSchema();

        patchMatAddErosionDamageFields(schema, 'zh');

        const fields = schema.MAT_ADD_EROSION_TITLE.c[2];
        assert.equal(fields[1].n, 'DMGTYP');
        assert.equal(fields[1].t, 'integer');
        assert.ok(fields[1].h.includes('For GISSMO damage type'));
        assert.ok(fields[1].h.includes('对于 GISSMO 损伤类型'));
        assert.ok(fields[2].h.includes('载荷曲线 ID 或表 ID'));
        assert.ok(fields[6].h.includes('损伤相关应力渐隐'));
    });

    it('keeps the patch idempotent', () => {
        const schema = makeSchema();

        patchMatAddErosionDamageFields(schema, 'en');
        const second = patchMatAddErosionDamageFields(schema, 'en');

        assert.equal(second.changedFields, 0);
    });

    it('updates MAT_ADD_EROSION keyword snippets for restored damage fields', () => {
        const snippets = makeSnippets();

        const result = patchMatAddErosionSnippets(snippets);

        assert.equal(result.changedSnippets, 2);
        assert.ok(snippets['*MAT_ADD_EROSION'].body.includes(
            '$#    idam    dmgtyp     lcsdg     ecrit    dmgexp     dcrit    fadexp    lcregd'
        ));
        assert.ok(snippets['*MAT_ADD_EROSION'].body.includes(
            '${17:      IDAM}${18:    DMGTYP}${19:     LCSDG}${20:     ECRIT}${21:    DMGEXP}${22:     DCRIT}${23:    FADEXP}${24:    LCREGD}'
        ));
        assert.ok(snippets['*MAT_ADD_EROSION_TITLE'].body.includes(
            '${18:      IDAM}${19:    DMGTYP}${20:     LCSDG}${21:     ECRIT}${22:    DMGEXP}${23:     DCRIT}${24:    FADEXP}${25:    LCREGD}'
        ));

        const second = patchMatAddErosionSnippets(snippets);
        assert.equal(second.changedSnippets, 0);
    });

    it('keeps repository field_data and snippet files patched', () => {
        const repoRoot = path.resolve(__dirname, '..', '..');
        const english = JSON.parse(fs.readFileSync(path.join(repoRoot, 'keywords', 'field_data.json'), 'utf8'));
        const localized = JSON.parse(fs.readFileSync(path.join(repoRoot, 'keywords', 'field_data_zh.json'), 'utf8'));
        const snippets = JSON.parse(fs.readFileSync(path.join(repoRoot, 'snippets', 'lsdyna.json'), 'utf8'));

        assert.deepEqual(fieldNames(english, 'MAT_ADD_EROSION'), [
            'IDAM', 'DMGTYP', 'LCSDG', 'ECRIT', 'DMGEXP', 'DCRIT', 'FADEXP', 'LCREGD',
        ]);
        assert.deepEqual(fieldNames(localized, 'MAT_ADD_EROSION_TITLE'), [
            'IDAM', 'DMGTYP', 'LCSDG', 'ECRIT', 'DMGEXP', 'DCRIT', 'FADEXP', 'LCREGD',
        ]);
        assert.ok(localized.MAT_ADD_EROSION.c[2][1].h.includes('对于 GISSMO 损伤类型'));
        assert.ok(snippets['*MAT_ADD_EROSION'].body.includes(
            '$#    idam    dmgtyp     lcsdg     ecrit    dmgexp     dcrit    fadexp    lcregd'
        ));
        assert.ok(snippets['*MAT_ADD_EROSION_TITLE'].body.includes(
            '$#    idam    dmgtyp     lcsdg     ecrit    dmgexp     dcrit    fadexp    lcregd'
        ));
    });
});
