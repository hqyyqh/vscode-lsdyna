'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require('../support/helpers');
const schemaApi = require('../../out/core/keywordSchema');
const validator = require('../../out/core/parser/keywordValidator');
const { isKnownKeywordName, suggestSimilarKeywords } = require('../../out/core/keywordSuggest');
const { classifyManualMatch } = require('../../out/core/manualMatch');

const cases = [
    ['CONTACT_AUTOMATIC_SINGLE_SURFACE_MPP_ID', 'CONTACT_AUTOMATIC_SINGLE_SURFACE', ['MPP', 'ID']],
    ['CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_OFFSET', 'CONTACT_TIED_SHELL_EDGE_TO_SURFACE_OFFSET', ['ID']],
    ['CONTACT_MPP_TIED_SHELL_EDGE_TO_SURFACE_ID_BEAM_OFFSET', 'CONTACT_TIED_SHELL_EDGE_TO_SURFACE_BEAM_OFFSET', ['ID', 'MPP']],
    ['CONTACT_ID_TIED_NODES_TO_SURFACE_CONSTRAINED_OFFSET', 'CONTACT_TIED_NODES_TO_SURFACE_CONSTRAINED_OFFSET', ['ID']],
    ['PARAMETER_NOECHO_LOCAL_MUTABLE', 'PARAMETER', ['LOCAL', 'MUTABLE', 'NOECHO']],
];

describe('shared keyword recognition', () => {
    it('agrees across schema, diagnostics, spelling suggestions and manual relationships', () => {
        const schema = schemaApi.loadKeywordSchema();
        validator.init(new Set(['NODE', 'END']));
        for (const [name, canonical, options] of cases) {
            const lookup = schemaApi.lookupKeywordSchema(name, schema);
            assert.ok(lookup, name);
            assert.equal(lookup.canonicalName, canonical, name);
            assert.deepEqual([...lookup.activeOptions].sort(), [...options].sort(), name);
            assert.equal(validator.builtInKeywordMatches(name, schema), true, name);
            assert.equal(isKnownKeywordName(name), true, name);
            assert.equal(suggestSimilarKeywords(name).tier, 'none', name);
            assert.equal(classifyManualMatch(name, canonical), 'section', name);
            const diagnostics = validator.collectKeywordValidationDiagnostics(fakeDoc('*' + name + '\n*END'), () => false);
            assert.equal(diagnostics.filter(item => item.code === 'unknown-keyword').length, 0, name);
        }
    });

    it('applies CONTACT option ordering across catalog families, without a spelling whitelist', () => {
        const schema = schemaApi.loadKeywordSchema();
        let checked = 0;
        for (const [name, entry] of Object.entries(schema)) {
            if (!name.startsWith('CONTACT_') || name.startsWith('CONTACT_2D') || entry.x ||
                !entry.o?.some(option => option.n === 'ID' && option.to > 0) ||
                !entry.o?.some(option => option.n === 'MPP' && option.to > 0)) continue;
            const reordered = 'CONTACT_ID_' + name.slice('CONTACT_'.length) + '_MPP';
            const lookup = schemaApi.lookupKeywordSchema(reordered, schema);
            assert.ok(lookup, reordered);
            assert.equal(lookup.canonicalName, name, reordered);
            assert.deepEqual([...lookup.activeOptions].sort(), ['ID', 'MPP'], reordered);
            checked++;
        }
        assert.ok(checked > 30, String(checked));
    });

    it('rejects duplicates, incompatible combinations, unknown options and broken compound tokens', () => {
        const schema = schemaApi.loadKeywordSchema();
        for (const name of [
            'CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_ID',
            'CONTACT_AUTOMATIC_SINGLE_SURFACE_MPP_MPP',
            'CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_UNKNOWN',
            'CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_OFFSET',
            'CONTACT_TIED_SHELL_EDGE_TO_SURFACE_OFFSET_BEAM_ID',
            'CONTACT_TIED_ID_SHELL_EDGE_TO_SURFACE_OFFSET',
            'CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_OFFSET_CONSTRAINED_OFFSET',
            'CONTACT_2D_ID_UNKNOWN', 'CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_A',
            'PARAMETER_LOCAL_LOCAL', 'MAT_024_TITLE_TITLE', 'MAT_024_', '**NODE',
        ]) {
            assert.equal(schemaApi.lookupKeywordSchema(name, schema), null, name);
            assert.equal(validator.builtInKeywordMatches(name, schema), false, name);
            assert.equal(isKnownKeywordName(name), false, name);
            assert.equal(classifyManualMatch(name, 'CONTACT_TIED_SHELL_EDGE_TO_SURFACE'), 'approximate', name);
        }
    });

    it('keeps keyword Hover, physical fields and incomplete-form edit restrictions consistent', async function () {
        this.timeout(30000);
        const { LsdynaFieldHoverProvider, buildKeywordOptionViewModel } = require('../../out/extension')._internals;
        const provider = new LsdynaFieldHoverProvider();
        for (const name of ['CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_OFFSET', 'CONTACT_TIED_SHELL_EDGE_TO_SURFACE_OFFSET_ID']) {
            const document = fakeDoc('*' + name + '\n' + '1'.padStart(10) + ' contact\n' +
                Array(8).fill('1'.padStart(10)).join('') + '\n*END');
            const hover = await provider.provideDetailedHover(document, { line: 0, character: 2 });
            const text = hover.contents.map(item => item.value).join('\n');
            assert.ok(text.includes('CID') && text.includes('SURFA'), name);
            assert.ok(!text.includes('Unknown keyword') && !text.includes('未知关键字'), name);
            assert.deepEqual(schemaApi.getCardInfoForDocumentLine(document, 2).card.map(field => field.n),
                ['SURFA', 'SURFB', 'SURFATYP', 'SURFBTYP', 'SABOXID', 'SBBOXID', 'SAPR', 'SBPR']);
            const model = buildKeywordOptionViewModel({ document, selection: { active: { line: 0, character: 0 } } }, 0, {});
            assert.equal(model.plan.status, 'blocked'); // Name recognition does not validate a truncated contact block.
        }
    });

    it('uses the provided schema identity and does not retain a stale contact catalog', () => {
        const a = { CONTACT_EXAMPLE_OFFSET: { c: [], o: [{ n: 'ID', to: 1, c: [] }] } };
        const b = { CONTACT_EXAMPLE: { c: [] } };
        assert.ok(schemaApi.lookupKeywordSchema('CONTACT_ID_EXAMPLE_OFFSET', a));
        assert.equal(schemaApi.lookupKeywordSchema('CONTACT_ID_EXAMPLE_OFFSET', b), null);
    });
});
