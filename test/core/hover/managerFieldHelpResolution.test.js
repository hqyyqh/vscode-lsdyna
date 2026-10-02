const assert = require('node:assert/strict');
const ks = require('../../../src/core/keywordSchema');
const { resolveManagerSchemaField: resolve } = require('../../../src/core/hover/managerFieldHelpResolution');
const { getCatalogInputFormCatalogV4 } = require("../../../src/core/semantics/catalogInputFormCatalogV4");
const schema = ks.loadKeywordSchema(() => 'zh');
function native(keyword) {
    const form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
    return form.reference.formRuleIds.flatMap(id => form.rules[id].cards);
}
function field(name, position = 0) { return { name, position, width: 10 }; }
function schemaField(n, p = 0, h = n) { return { n, p, w: 10, h }; }
function lookup(cards, keyword = 'TEST') { return { inputName: keyword, canonicalName: keyword, activeOptions: [], entry: { c: cards } }; }
describe('manager field help identity', () => {
    for (const keyword of ['CONTACT_AUTOMATIC_SINGLE_SURFACE', 'CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
        'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE', 'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_MPP_ID']) {
        it(`associates native CONTACT fields in ${keyword}`, () => {
            const result = ks.lookupKeywordSchema(keyword, schema);
            const expected = { SURFA: 'SSID', SURFB: 'MSID', SURFATYP: 'SSTYP', SURFBTYP: 'MSTYP',
                SABOXID: 'SBOXID', SBBOXID: 'MBOXID', SAPR: 'SPR', SBPR: 'MPR',
                SFSA: 'SFS', SFSB: 'SFM', SAST: 'SST', SBST: 'MST', SFSAT: 'SFST', SFSBT: 'SFMT' };
            let count = 0;
            for (const card of native(keyword))
                for (const f of card.fields)
                    if (expected[f.name]) {
                        const target = resolve(result, f, card);
                        assert.ok(target, `${keyword} ${f.name}`);
                        assert.equal(ks.canonicalCommentFieldLabel(target.n), ks.canonicalCommentFieldLabel(expected[f.name]));
                        assert.ok(ks.getEnglishFieldHelp(target) || ks.getLocalizedFieldHelp(target), f.name);
                        count++;
                    }
            assert.ok(count >= 14);
        });
    }
    it('resolves composite Johnson-Cook names using native branch card geometry', () => {
        const keyword = 'MAT_JOHNSON_COOK';
        const result = ks.lookupKeywordSchema(keyword, schema);
        const expected = { D1: 'D1/BETA', BETA: 'D1/BETA', D2: 'D2/WC', WC: 'D2/WC',
            D3: 'D3/DC', DC: 'D3/DC', D4: 'D4/GAMMA', GAMMA: 'D4/GAMMA', D: 'C2/P/XNP/D', 'C2/P/XNP': 'C2/P/XNP/D' };
        const found = new Set();
        for (const card of native(keyword))
            for (const f of card.fields)
                if (expected[f.name]) {
                    const target = resolve(result, f, card);
                    assert.equal(target?.n, expected[f.name], `${f.name} card ${card.cardIndex}`);
                    found.add(f.name);
                }
        assert.equal(found.size, Object.keys(expected).length);
    });
    it('resolves ALE generic slots only in their verified keyword and card context', () => {
        const keyword = 'ALE_STRUCTURED_MESH_VOLUME_FILLING';
        const result = ks.lookupKeywordSchema(keyword, schema);
        const names = ['PSID', 'PID', 'SEGSID', 'BOXID', 'OFFSET', 'NID1', 'NID2'];
        const found = new Set();
        for (const card of native(keyword))
            for (const f of card.fields)
                if (names.includes(f.name)) {
                    assert.equal(resolve(result, f, card)?.n, f.position === 20 ? 'E1' : 'E2', f.name);
                    found.add(f.name);
                }
        assert.equal(found.size, names.length);
        const card = { fields: [field('PID', 20), field('OFFSET', 30)] };
        assert.equal(resolve(result, card.fields[0], card), null);
    });
    it('keeps semantic differences unresolved while recognizing OUT/IN', () => {
        const kw = 'ALE_STRUCTURED_MESH_TRIM', result = ks.lookupKeywordSchema(kw, schema);
        // Only a compatible card may resolve: changing node/distance slots is not a synonym.
        const card = { fields: [field('MSHID'), field('OPTION', 10), field('OPER', 20), field('OUT/IN', 30), field('PSID', 40), field('DIST', 50)] };
        assert.equal(resolve(result, card.fields[3], card)?.n, 'IOUTIN');
        for (const [from, to] of [['DT', 'CYCL'], ['PSID', 'PID'], ['E', 'K'], ['PR', 'VC'], ['PLYID', 'MID2']]) {
            const selected = field(from), siblings = { fields: [selected, field('ANCHOR', 10)] };
            assert.equal(resolve(lookup([[schemaField(to), schemaField('ANCHOR', 10)]]), selected, siblings), null);
        }
    });
    it('rejects ambiguous help and geometry mismatches instead of choosing the first name', () => {
        const selected = field('A'), card = { fields: [selected, field('B', 10)] };
        const first = [schemaField('A', 0, 'first'), schemaField('B', 10)];
        const second = [schemaField('A', 0, 'second'), schemaField('B', 10)];
        assert.equal(resolve(lookup([first, second]), selected, card), null);
        assert.equal(resolve(lookup([first]), { ...selected, width: 20 }, card), null);
        assert.equal(resolve(lookup([[schemaField('SSID'), schemaField('B', 10)]]), field('SURFA'), { fields: [field('SURFA'), field('B', 10)] }), null);
        assert.equal(resolve(lookup([[schemaField('D1/BETA'), schemaField('B', 10)]]), field('D1'), { fields: [field('D1'), field('B', 10)] }), null);
    });
    it('preserves identical definitions in repeated schema records', () => {
        for (const [keyword, name] of [['EFV_EOS_012', 'RHO1'], ['CONSTRAINED_BEAM_IN_SOLID', 'COUPID']]) {
            const card = native(keyword).find(card => card.fields[0]?.name === name);
            const result = ks.lookupKeywordSchema(keyword, schema);
            assert.ok(resolve(result, card.fields[0], card), keyword);
        }
    });
    it('uses original field identity and ignores repeated occurrence numbering', () => {
        const selected = { ...field('Display label'), originalName: 'A' };
        const card = { cardIndex: 99, fields: [selected, field('B', 10)] };
        assert.equal(resolve(lookup([[schemaField('A'), schemaField('B', 10)]]), selected, card)?.n, 'A');
        assert.equal(ks.canonicalCommentFieldLabel('SSTYP'), ks.canonicalCommentFieldLabel('SURFATYP'));
        assert.equal(ks.canonicalCommentFieldLabel('MSTYP'), ks.canonicalCommentFieldLabel('SURFBTYP'));
    });
});


describe('resolved form help sources', () => {
    const {managerHelpLookups} = require('../../../src/core/hover/managerFieldHelpResolution');
    it('uses native-equivalent spellings, including TITLE, but rejects shared registrations', () => {
        const group = {spellingGroups:[{relation:'native-equivalent-spellings',keywords:['MAT_230','MAT_PML_ELASTIC']}]};
        const names = managerHelpLookups('MAT_230_TITLE',schema,group).map(lookup=>lookup.canonicalName);
        assert.ok(names.includes('MAT_PML_ELASTIC'));
        assert.ok(!names.includes('MAT_PML_ELASTIC_FLUID'));
        group.spellingGroups[0].relation='shared-form-registration';
        assert.deepEqual(managerHelpLookups('MAT_230',schema,group).map(lookup=>lookup.canonicalName),['MAT_230']);
    });
    it('does not use inactive pre-option cards in the live context', () => {
        const l={inputName:'TEST',canonicalName:'TEST',activeOptions:[],entry:{c:[[schemaField('BASE')]],o:[{n:'OTHER',co:'pre',c:[[schemaField('A'),schemaField('B',10)]]}]}};
        const selected=field('A'),card={fields:[selected,field('B',10)]};
        assert.equal(resolve(l,selected,card,true),null);
    });
});
