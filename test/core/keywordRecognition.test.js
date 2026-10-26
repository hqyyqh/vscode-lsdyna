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
    it('recognizes attached input-format markers and validates slash spellings', () => {
        validator.init(new Set(['NODE', 'END']));
        for (const name of ['CONSTRAINED_JOINT_REVOLUTE_ID', 'MAT_054/055_TITLE', 'MAT_3-PARAMETER_BARLAT_TITLE'])
            for (const marker of ['', '+', '%', '-']) {
                const diagnostics = spelling => validator.collectKeywordValidationDiagnostics(fakeDoc('*' + spelling + '\n*END'), () => false)
                    .filter(diagnostic => diagnostic.code === 'unknown-keyword');
                assert.equal(isKnownKeywordName(name + marker), true, name + marker);
                assert.equal(diagnostics(name + marker).length, 0, name + marker);
                assert.equal(diagnostics(name + '_UNKNOWN' + marker).length, 1, name + marker);
            }
        for (const name of ['CONSTRAINED_JOINT_REVOLUTE_ID++', 'MAT_054/055_TITLE%%', 'MAT_034_TITLE--'])
            assert.equal(isKnownKeywordName(name), false, name);
    });
    it('recognizes the exact names in other native reader catalogs without granting suffix write permission', () => {
        const {keywordDataPath} = require('../../out/core/keywordDataPath');
        const native = require("../../out/core/semantics/catalogNativeFileLayout");
        for (const file of ['lspp-batch-fixed-readers.json', 'lspp-conditional-layout-readers.json',
            'lspp-occurrence-readers.json', 'lspp-ordinal-conditional-readers.json', 'lspp-ordinal-file-readers.json', 'lspp-tail-repeat-readers.json']) {
            const source = require(keywordDataPath('native-readers/' + file));
            assert.equal(source.sourceSha256, native.NATIVE_FILE_SOURCE);
            for (const name of Object.keys(source.bindings).filter(name => /_(ID|TITLE|MPP)$/.test(name))) {
                assert.equal(isKnownKeywordName(name), true, name);
                assert.equal(validator.builtInKeywordMatches(name), true, name);
                assert.equal(isKnownKeywordName(name + '_UNKNOWN'), false, name);
            }
        }
        for (const name of ['BOUNDARY_AMBIENT_ID', 'DATABASE_FREQUENCY_BINARY_D3SPCM_ID'])
            assert.equal(native.isVerifiedNativeSpelling(name), false, name);
    });
    it('recognizes every verified native spelling without granting a schema or edit permission', () => {
        const { keywordDataPath } = require('../../out/core/keywordDataPath');
        const native = require("../../out/core/semantics/catalogNativeFileLayout");
        const schema = schemaApi.loadKeywordSchema();
        validator.init(new Set(['NODE', 'END']));
        let checked = 0;
        for (const file of ['lspp-spelling-file-readers.json', 'lspp-contact-id-mpp-fixed-readers.json', 'lspp-contact-mpp-tail-readers.json', 'lspp-suffix-fixed-readers.json']) {
            const source = require(keywordDataPath('native-readers/' + file));
            assert.equal(source.sourceSha256, native.NATIVE_FILE_SOURCE);
            for (const name of Object.keys(source.bindings)) {
                const before = schemaApi.lookupKeywordSchema(name, schema);
                assert.equal(validator.builtInKeywordMatches(name, schema), true, name);
                assert.equal(isKnownKeywordName('*' + name.toLowerCase()), true, name);
                assert.equal(suggestSimilarKeywords(name).tier, 'none', name);
                const diagnostics = validator.collectKeywordValidationDiagnostics(fakeDoc('*' + name + '\n*END'), () => false);
                assert.equal(diagnostics.filter(d => d.code === 'unknown-keyword').length, 0, name);
                assert.deepEqual(schemaApi.lookupKeywordSchema(name, schema), before, name);
                assert.equal(native.isVerifiedNativeSpelling(name + '_UNKNOWN'), false, name);
                checked++;
            }
            for (const name of Object.keys(source.gaps || {})) {
                if (!source.bindings[name]) assert.equal(native.isVerifiedNativeSpelling(name), false, name);
            }
            const identity = source.sourceSha256;
            try {
                source.sourceSha256 = 'unverified';
                const exclusive = Object.keys(source.bindings).find(name => !native.isVerifiedNativeSpelling(name));
                assert.ok(exclusive, file);
            } finally { source.sourceSha256 = identity; }
        }
        assert.ok(checked >= 516, String(checked));
        for (const name of ['CONSTRAINED_JOINT_REVOLUTE_ID', 'CONSTRAINED_JOINT_CYLINDRICAL_ID', 'SET_SHELL_TITLE']) {
            assert.equal(schemaApi.lookupKeywordSchema(name, schema), null);
            assert.equal(native.nativeSpellingBinding(name).displayOnly, true);
            assert.equal(require('../../out/core/semantics/nativeFieldResolution').nativeFieldDisplayOnly(name), true);
            assert.equal(isKnownKeywordName(name, { candidates: ['NODE'] }), false);
        }
    });

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
