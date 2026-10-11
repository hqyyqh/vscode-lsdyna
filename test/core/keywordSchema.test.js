'use strict';

const assert = require('assert');
const { fakeDoc } = require("../support/helpers");

describe('keywordSchema resolver', () => {
    it('resolves every mixed-case catalog key without replacing its help objects', () => {
        const { loadKeywordSchema, lookupKeywordSchema } = require('../../src/core/keywordSchema');
        const schema = loadKeywordSchema();
        const names = Object.keys(schema).filter(name => /^[A-Z0-9_-]+$/i.test(name) && name !== name.toUpperCase());
        assert.ok(names.length > 0);
        for (const name of names) {
            const canonical = schema[name].x || name;
            for (const spelling of [name, name.toUpperCase(), name.toLowerCase()]) {
                const found = lookupKeywordSchema(spelling, schema);
                assert.ok(found, spelling);
                assert.strictEqual(found.entry, schema[canonical]);
                assert.strictEqual(found.entry.c[0][0], schema[canonical].c[0][0]);
                assert.deepEqual(found.activeOptions, schema[name].active || []);
            }
        }
    });

    it('handles folded keys, aliases and option prefixes without guessing ambiguous keys', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');
        const base = { c: [], a: ['ALIAS'], o: [{ n: 'TITLE', c: [], co: 'before/1', to: 1 }] };
        const schema = { Mixed: base, Mixed_TITLE: { c: [], x: 'Mixed', active: ['TITLE'] } };
        assert.strictEqual(lookupKeywordSchema('ALIAS', schema).entry, base);
        assert.strictEqual(lookupKeywordSchema('MIXED_TITLE', schema).entry, base);
        assert.deepEqual(lookupKeywordSchema('mixed_title', { Mixed: base }).activeOptions, ['TITLE']);
        assert.equal(lookupKeywordSchema('MIXED_UNKNOWN', schema), null);
        assert.equal(lookupKeywordSchema('MIXED', { 'Mixed (description)': base }), null);
        assert.equal(lookupKeywordSchema('MIXED', { Mixed: base, miXed: { c: [] } }), null);
        const exact = { c: [] };
        assert.strictEqual(lookupKeywordSchema('mixed', { Mixed: base, MIXED: exact }).entry, exact);
    });

    it('resolves complete alias chains and merges their active options with suffix options', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');
        const base = { c: [], active: ['BASE'] };
        const middle = { c: [], x: 'base', active: ['title', 'BASE'] };
        const alias = { c: [], x: 'middle', active: ['outer'],
            o: [{ n: 'EXTRA', c: [], co: 'title/1', to: 1 }] };
        const schema = { BASE: base, Middle: middle, ALIAS: alias };
        const found = lookupKeywordSchema('ALIAS_EXTRA', schema);
        assert.strictEqual(found.entry, base);
        assert.equal(found.canonicalName, 'BASE');
        assert.deepEqual(found.activeOptions, ['OUTER', 'TITLE', 'BASE', 'EXTRA']);
        assert.equal(alias.x, 'middle');
        assert.equal(middle.x, 'base');
        assert.deepEqual(middle.active, ['title', 'BASE']);
    });

    it('rejects missing, ambiguous and cyclic alias targets without using intermediate cards', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');
        const alias = x => ({ c: [[{ n: 'INTERMEDIATE', t: 'integer', p: 0, w: 10 }]], x });
        assert.equal(lookupKeywordSchema('A', { A: alias('MISSING') }), null);
        assert.equal(lookupKeywordSchema('A', { A: alias('A') }), null);
        assert.equal(lookupKeywordSchema('A', { A: alias('B'), B: alias('A') }), null);
        assert.equal(lookupKeywordSchema('A', { A: alias('B'), B: alias('C') }), null);
        assert.equal(lookupKeywordSchema('A', { A: alias('mixed'), Mixed: { c: [] }, miXed: { c: [] } }), null);
    });

    it('keeps COMMENT bodies opaque to field resolution', () => {
        const { resolveCardForDocumentLine } = require('../../src/core/keywordSchema');
        const doc = fakeDoc('*COMMENT\n$# fields\nordinary text\n*END');
        for (const line of [1, 2]) {
            assert.equal(resolveCardForDocumentLine(doc, line).status, 'unsupported');
        }
    });

    it('maps every line after DEFINE_FUNCTION header data to its text card', () => {
        const { getCardInfoForDocumentLine } = require('../../src/core/keywordSchema');
        const schema = {
            DEFINE_FUNCTION: {
                c: [
                    [{ n: 'FID', p: 0, w: 10, t: 'integer' }],
                    [{ n: 'FUNCTION', p: 0, w: 80, t: 'string' }],
                ],
                tc: [{ name: 'function', f: [{ n: 'FUNCTION', p: 0, w: 80, t: 'string' }] }],
            },
        };
        const doc = fakeDoc([
            '*DEFINE_FUNCTION',
            '         1',
            'x + y',
            '$ x - y',
            '*END',
        ].join('\n'));

        const header = getCardInfoForDocumentLine(doc, 1, schema);
        assert.ok(header);
        assert.equal(header.isTextCard, undefined);
        for (const line of [2, 3]) {
            const info = getCardInfoForDocumentLine(doc, line, schema);
            assert.ok(info);
            assert.equal(info.isTextCard, true);
            assert.equal(info.cardIndex, 2);
        }
    });

    it('resolves title variants to canonical schema and renders TITLE first', () => {
        const { lookupKeywordSchema, getRenderedCards } = require('../../src/core/keywordSchema');

        const lookup = lookupKeywordSchema('MAT_001_TITLE');
        assert.ok(lookup);
        assert.equal(lookup.inputName, 'MAT_001_TITLE');
        assert.equal(lookup.canonicalName, 'MAT_001');
        assert.deepEqual(lookup.activeOptions, ['TITLE']);

        const rendered = getRenderedCards(lookup.entry, lookup.activeOptions);
        assert.equal(rendered[0][0].n, 'TITLE');
        assert.equal(rendered[1][0].n, 'MID');
    });

    it('renders the current catalog multi-hop aliases from their final entry and all source options', function () {
        this.timeout(20000); // Replays the full alias catalog, not one keyword.
        const { loadKeywordSchema, lookupKeywordSchema, getRenderedCards, getCardInfoForDocumentLine } =
            require('../../src/core/keywordSchema');
        const schema = loadKeywordSchema();
        let multiHop = 0;
        for (const [keyword, source] of Object.entries(schema)) {
            const first = source.x && schema[source.x];
            if (!first?.x) continue;
            multiHop++;
            const lookup = lookupKeywordSchema(keyword, schema);
            assert.ok(lookup, keyword);
            assert.equal(lookup.entry.x, undefined, keyword);
            assert.strictEqual(lookup.entry, schema[lookup.canonicalName], keyword);
            const rendered = getRenderedCards(lookup.entry, lookup.activeOptions);
            assert.equal(rendered[0][0].n, 'TITLE', keyword);
            assert.strictEqual(rendered[1][0], lookup.entry.c[0][0], keyword);
            const document = fakeDoc(`*${keyword}\nChain title\n       731\n*END`);
            const header = getCardInfoForDocumentLine(document, 2, schema);
            assert.equal(header?.cardIndex, 2, keyword);
            assert.equal(header?.card[0].n, lookup.entry.c[0][0].n, keyword);
            assert.equal(schema[keyword].x, source.x, keyword);
        }
        assert.equal(multiHop, 20);
    });

    it('uses the verified leading-card count across TITLE, ID, and MPP families', () => {
        const {
            getLeadingMaterialTitleCardCount,
            lookupKeywordSchema,
        } = require('../../src/core/keywordSchema');
        const material = lookupKeywordSchema('MAT_DAMAGE_1_TITLE');
        const curve = lookupKeywordSchema('DEFINE_CURVE_TITLE');
        const set = lookupKeywordSchema('SET_PART_LIST_TITLE');

        assert.equal(getLeadingMaterialTitleCardCount(material), 1);
        assert.equal(getLeadingMaterialTitleCardCount(curve), 1);
        assert.equal(getLeadingMaterialTitleCardCount(set), 1);
        assert.equal(
            getLeadingMaterialTitleCardCount(lookupKeywordSchema('RIGIDWALL_GEOMETRIC_CYLINDER_ID')),
            1,
        );
        assert.equal(
            getLeadingMaterialTitleCardCount(lookupKeywordSchema('CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP')),
            2,
        );
    });

    it('projects official prefix fields and conditional CONTACT MPP2 exactly', () => {
        const {
            getRenderedCardsForLookup,
            getVerifiedPrefixLayout,
            getVerifiedPrefixLayoutSteps,
            lookupKeywordSchema,
        } = require('../../src/core/keywordSchema');

        const geometric = lookupKeywordSchema('RIGIDWALL_GEOMETRIC_CYLINDER_ID');
        assert.deepEqual(
            getVerifiedPrefixLayout(geometric).cards[0].map(field => field.n),
            ['RWID', 'HEADING'],
        );
        const planar = lookupKeywordSchema('RIGIDWALL_PLANAR_ID');
        assert.deepEqual(getVerifiedPrefixLayout(planar).cards[0].map(field => field.n), ['RWID']);
        const rivet = lookupKeywordSchema('CONSTRAINED_RIVET_ID');
        assert.deepEqual(getVerifiedPrefixLayout(rivet).cards[0].map(field => field.n), ['RID']);
        const icfd = lookupKeywordSchema('ICFD_PART_TITLE');
        assert.deepEqual(getVerifiedPrefixLayout(icfd).cards[0].map(field => field.n), ['HEADING']);

        const combined = lookupKeywordSchema('CONSTRAINED_BEAM_IN_SOLID_ID_TITLE');
        assert.deepEqual(
            getVerifiedPrefixLayout(combined).cards[0].map(field => field.n),
            ['COUPID', 'TITLE'],
        );
        assert.equal(getVerifiedPrefixLayout(combined).cards.length, 1);

        const contact = lookupKeywordSchema('CONTACT_AUTOMATIC_SINGLE_SURFACE_MPP_ID');
        const withoutMarker = getVerifiedPrefixLayout(contact, ['', '', '']);
        assert.deepEqual(withoutMarker.cards.map(card => card[0].n), ['CID', 'IGNORE']);
        const withMarker = getVerifiedPrefixLayout(contact, ['', '', '&']);
        assert.deepEqual(withMarker.cards.map(card => card[0].n), ['CID', 'IGNORE', '&']);
        assert.deepEqual(withMarker.cards[2].map(field => field.n), ['&', 'CHKSEGS', 'PENSF', 'GRPABLE', 'IGTOL']);
        const body = getRenderedCardsForLookup(contact, ['', '', '&'])[3];
        const nativeForm = require("../../src/core/semantics/catalogInputFormCatalogV4")
            .getCatalogInputFormCatalogV4().formForKeyword(contact.inputName);
        const nativeBody = Object.values(nativeForm.rules).flatMap(rule => rule.cards || [])
            .find(card => card.cardRecordId === "record:3c11134d2da44eeb1b070a21:440dd31a8a6ca9beaef27bb6");
        assert.equal(nativeBody.fields[0].fieldRecordId, "record:3c11134d2da44eeb1b070a21:ced317ff062626eddb57498d");
        assert.equal(nativeBody.fields[0].name, 'SURFA');
        assert.deepEqual({ name: body[0].n, position: body[0].p, width: body[0].w },
            { name: nativeBody.fields[0].name, position: nativeBody.fields[0].serializationPosition,
                width: nativeBody.fields[0].serializationWidth });
        const steps = getVerifiedPrefixLayoutSteps('CONTACT_AUTOMATIC_SINGLE_SURFACE', ['ID', 'MPP']);
        assert.deepEqual(steps.map(step => step.card[0].n), ['CID', 'IGNORE', '&']);
        assert.deepEqual(steps[2].recordMarker, { kind: 'column-one', value: '&' });
        assert.ok(steps.every(step => step.evidenceIds.length > 0));
        assert.equal(getVerifiedPrefixLayoutSteps('MAT_001', ['ID', 'MPP']), null);
    });

    it('fails closed for the two manual-denied DEFINE_FUNCTION TITLE spellings', () => {
        const { getVerifiedPrefixLayout, lookupKeywordSchema } = require('../../src/core/keywordSchema');
        for (const keyword of ['DEFINE_FUNCTION_TITLE', 'DEFINE_FUNCTION_TABULATED_TITLE']) {
            const layout = getVerifiedPrefixLayout(lookupKeywordSchema(keyword));
            assert.equal(layout.status, 'unsupported-option');
            assert.deepEqual(layout.unsupportedOptions, ['TITLE']);
            assert.deepEqual(layout.cards, []);
        }
    });

    it('marks the variable-position SECTION_SHELL MISC card as reviewed but unwritable', () => {
        const { getVerifiedPrefixLayout, lookupKeywordSchema } = require('../../src/core/keywordSchema');
        const layout = getVerifiedPrefixLayout(lookupKeywordSchema('SECTION_SHELL_MISC'));
        assert.equal(layout.status, 'unverified');
        assert.deepEqual(layout.activePreOptions, ['MISC']);
        assert.deepEqual(layout.cards, []);
    });

    it('resolves card info via keywordOverride for unknown typed block names', () => {
        const { getCardInfoForDocumentLine } = require('../../src/core/keywordSchema');
        const doc = fakeDoc([
            '*LOAD_BODY_Z1',
            '$#    lcid        sf    lciddr        xc        yc        zc       cid',
            '   1000001 9806.0000',
        ].join('\n'));

        assert.equal(getCardInfoForDocumentLine(doc, 2), null);
        const withOverride = getCardInfoForDocumentLine(doc, 2, undefined, {
            keywordOverride: 'LOAD_BODY_Z',
        });
        assert.ok(withOverride);
        assert.equal(withOverride.card[0].n, 'LCID');
        assert.equal(withOverride.keywordName, 'LOAD_BODY_Z');
    });

    it('rejects prefix matches when leftover suffix is not a known option', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');

        // Unknown options must not turn a valid CONTACT prefix into a known name.
        const invalid = lookupKeywordSchema('CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_UNKNOWN');
        assert.equal(invalid, null);

        const validOffsetId = lookupKeywordSchema('CONTACT_TIED_SHELL_EDGE_TO_SURFACE_OFFSET_ID');
        assert.ok(validOffsetId);
        assert.equal(validOffsetId.canonicalName, 'CONTACT_TIED_SHELL_EDGE_TO_SURFACE_OFFSET');
        assert.deepEqual(validOffsetId.activeOptions, ['ID']);

        const validIdMpp = lookupKeywordSchema('CONTACT_AUTOMATIC_SINGLE_SURFACE_MPP_ID');
        assert.ok(validIdMpp);
        assert.equal(validIdMpp.canonicalName, 'CONTACT_AUTOMATIC_SINGLE_SURFACE');
        assert.deepEqual(validIdMpp.activeOptions, ['MPP', 'ID']);
    });

    it('resolves every legal PARAMETER option order to its canonical card layout', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');
        for (const [keyword, canonical, activeOptions] of [
            ['PARAMETER_MUTABLE_LOCAL_NOECHO', 'PARAMETER', ['LOCAL', 'MUTABLE', 'NOECHO']],
            ['PARAMETER_NOECHO_LOCAL_MUTABLE', 'PARAMETER', ['LOCAL', 'MUTABLE', 'NOECHO']],
            ['PARAMETER_EXPRESSION_NOECHO_MUTABLE_LOCAL', 'PARAMETER_EXPRESSION', ['LOCAL', 'MUTABLE', 'NOECHO']],
            ['PARAMETER_EXPRESSION_LOCAL_NOECHO', 'PARAMETER_EXPRESSION', ['LOCAL', 'NOECHO']],
        ]) {
            const lookup = lookupKeywordSchema(keyword);
            assert.ok(lookup, keyword);
            assert.equal(lookup.canonicalName, canonical);
            assert.deepEqual(lookup.activeOptions, activeOptions);
            assert.equal(lookup.entry.c[0][0].n.startsWith('PRMR'), true);
        }
    });

    it('rejects PARAMETER extraction artifacts and misplaced EXPRESSION', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');
        for (const keyword of [
            'PARAMETER_OPTION',
            'PARAMETER_EXPRES',
            'PARAMETER_LOCAL_EXPRESSION',
            'PARAMETER_LOCAL_LOCAL',
        ]) {
            assert.equal(lookupKeywordSchema(keyword), null, keyword);
        }
    });

    it('overrides stale PARAMETER field help without mutating the schema JSON', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');
        const ordinary = lookupKeywordSchema('PARAMETER_NOECHO');
        const expression = lookupKeywordSchema('PARAMETER_EXPRESSION_MUTABLE');
        const type = lookupKeywordSchema('PARAMETER_TYPE');

        assert.ok(ordinary.entry.c[0][0].h.includes('1-9'));
        assert.ok(ordinary.entry.c[0][0].h.includes('C (character)'));
        assert.ok(!ordinary.entry.c[0][0].h.includes('7 characters'));
        assert.ok(expression.entry.c[0][1].h.includes('first 10 columns'));
        assert.ok(type.entry.c[0][2].h.includes('LS-DYNA ignores PRTYP'));
    });

    it('resolves manifest aliases to the canonical card schema', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');

        const lookup = lookupKeywordSchema('SET_NODE');
        assert.ok(lookup);
        assert.equal(lookup.canonicalName, 'SET_NODE_LIST');
        assert.equal(lookup.entry.c[0][0].n, 'SID');
    });

    it('resolves only source-locked manual spellings with an exact complete card layout', () => {
        const {
            getRenderedCards,
            loadKeywordSchema,
            lookupKeywordSchema,
        } = require('../../src/core/keywordSchema');
        const source = require("../../keywords/authoring/engineering/keywordSpellingAliases.json");
        const schema = loadKeywordSchema(() => 'en');

        assert.equal(source.policy.fuzzyAliasPermission, false);
        assert.equal(source.policy.optionInferencePermission, false);
        assert.equal(source.aliases.length, 5);
        for (const item of source.aliases) {
            const lookup = lookupKeywordSchema(item.manualKeyword, schema);
            assert.ok(lookup, item.manualKeyword);
            assert.equal(lookup.canonicalName, item.schemaKeyword);
            assert.deepEqual(
                getRenderedCards(lookup.entry, lookup.activeOptions)[item.cardIndex - 1]
                    .map(field => ({
                        name: field.n,
                        type: field.t,
                        position: field.p,
                        width: field.w,
                    })),
                item.card,
                item.manualKeyword,
            );

            const drifted = { ...schema, [item.schemaKeyword]: {
                ...schema[item.schemaKeyword],
                c: schema[item.schemaKeyword].c.map((card, index) => index === item.cardIndex - 1
                    ? card.map((field, fieldIndex) => fieldIndex === 0
                        ? { ...field, w: field.w + 1 }
                        : field)
                    : card),
            } };
            assert.equal(lookupKeywordSchema(item.manualKeyword, drifted), null,
                `${item.manualKeyword} must fail closed after layout drift`);
        }
    });

    it('repairs the source-locked IGA card only while the complete bad source shape matches', () => {
        const { getCardInfoForDocumentLine, getRenderedCardsForLookup, loadKeywordSchema, lookupKeywordSchema } = require('../../src/core/keywordSchema');
        const { readCellValue, writeCellR1 } = require('../../src/core/edit/cardCellModel');
        const { fakeDoc } = require("../support/helpers");
        const source = require("../../keywords/authoring/engineering/keywordLayoutCorrections.json");
        const schema = loadKeywordSchema(() => 'en');
        const correction = source.corrections[0];

        assert.equal(source.policy.optionInferencePermission, false);
        assert.equal(source.policy.partialCardCorrectionPermission, false);
        assert.equal(correction.keyword, 'IGA_INTEGRATION_SHELL_REDUCE');
        assert.deepEqual(
            lookupKeywordSchema(correction.keyword, schema).entry.c[0].map(field => ({
                name: field.n,
                type: field.t,
                position: field.p,
                width: field.w,
            })),
            correction.officialCard,
        );

        const lookup = lookupKeywordSchema(correction.keyword, schema);
        const card = getRenderedCardsForLookup(lookup)[0];
        assert.deepEqual(card.map(field => [field.p, field.w]), [[0, 10], [10, 10], [20, 10]]);
        let line = '';
        line = writeCellR1(line, card, 0, '12');
        line = writeCellR1(line, card, 1, '1');
        line = writeCellR1(line, card, 2, '2');
        assert.equal(readCellValue(line, card, 0), '12');
        assert.equal(readCellValue(line, card, 1), '1');
        assert.equal(readCellValue(line, card, 2), '2');

        const doc = fakeDoc(['*IGA_INTEGRATION_SHELL_REDUCE', line].join('\n'));
        const info = getCardInfoForDocumentLine(doc, 1, schema);
        assert.ok(info);
        // Actual file reads take precedence over the legacy schema correction.
        // The pinned native probe reads PATCHID at offset 152, not column zero.
        assert.equal(info.card[0].p, 152);
        assert.equal(info.card[2].w, 20);
        assert.equal(info.card[0].rawValue, '');

        const drifted = { ...schema, [correction.keyword]: {
            ...schema[correction.keyword],
            c: schema[correction.keyword].c.map((card, index) => index === 0
                ? card.map((field, fieldIndex) => fieldIndex === 0
                    ? { ...field, p: field.p + 1 }
                    : field)
                : card),
        } };
        assert.equal(lookupKeywordSchema(correction.keyword, drifted), null);
    });

    it('resolves SET_PART aliases to the SET_PART_LIST card schema', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');

        for (const keyword of ['SET_PART', '*SET_PART']) {
            const lookup = lookupKeywordSchema(keyword);

            assert.ok(lookup, `${keyword} should resolve`);
            assert.equal(lookup.canonicalName, 'SET_PART_LIST');
            assert.equal(lookup.entry.c[0][0].n, 'SID');
        }
    });

    it('resolves SET_NODE_TITLE and SET_PART_TITLE aliases through LIST title variants', () => {
        const { lookupKeywordSchema, getRenderedCards } = require('../../src/core/keywordSchema');

        for (const [keyword, canonical] of [
            ['SET_NODE_TITLE', 'SET_NODE_LIST'],
            ['*SET_NODE_TITLE', 'SET_NODE_LIST'],
            ['SET_PART_TITLE', 'SET_PART_LIST'],
            ['*SET_PART_TITLE', 'SET_PART_LIST'],
        ]) {
            const lookup = lookupKeywordSchema(keyword);

            assert.ok(lookup, `${keyword} should resolve`);
            assert.equal(lookup.canonicalName, canonical);
            assert.deepEqual(lookup.activeOptions, ['TITLE']);
            assert.equal(lookup.entry.c[0][0].n, 'SID');
            const rendered = getRenderedCards(lookup.entry, lookup.activeOptions);
            assert.equal(rendered[0][0].n, 'TITLE');
            assert.equal(rendered[1][0].n, 'SID');
        }
    });

    it('matches CONTACT optional cards by observed data line count', () => {
        const { getCardForDocumentLine } = require('../../src/core/keywordSchema');
        const doc = fakeDoc([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base card 1',
            'base card 2',
            'base card 3',
            'optional card A',
            'optional card B',
            'optional card C',
            'optional card D',
            'optional card E',
            'optional card F',
            ''
        ].join('\n'));

        const optionA = getCardForDocumentLine(doc, 4);
        assert.ok(optionA);
        assert.equal(optionA[0].n, 'SOFT');

        const optionF = getCardForDocumentLine(doc, 9);
        assert.ok(optionF);
        assert.equal(optionF[0].n, 'PSTIFF');
    });

    it('matches a TITLE data line instead of returning null', () => {
        const { getCardForDocumentLine } = require('../../src/core/keywordSchema');
        const doc = fakeDoc('*MAT_001_TITLE\nMaterial title\n        1\n');

        const titleCard = getCardForDocumentLine(doc, 1);
        assert.ok(titleCard);
        assert.equal(titleCard[0].n, 'TITLE');
    });

    it('does not let a stale field-header comment override an active TITLE prefix', () => {
        const { getCardInfoForDocumentLine } = require('../../src/core/keywordSchema');
        const doc = fakeDoc([
            '*MAT_DAMAGE_1_TITLE',
            '$#     mid        ro         e        pr      sigy      lcss      lcds',
            ' '.repeat(80),
            '$#      q1        c1        q2        c2      epsd    espr/s        dc      flag',
            `${' '.repeat(70)}        -1`,
        ].join('\n'));

        const title = getCardInfoForDocumentLine(doc, 2);
        assert.ok(title);
        assert.equal(title.cardIndex, 1);
        assert.equal(title.card[0].n, 'TITLE');
        assert.equal(title.isLeadingOptionCard, true);
        assert.equal(title.resolutionSource, 'leading-option');
        assert.equal(title.cardPositionConflict, undefined);

        const shifted = getCardInfoForDocumentLine(doc, 4, undefined, {
            keywordLine: 0,
            dataLineOrdinal: 2,
            previousHeaderText: doc.lineAt(3).text,
            columnOneCommentsOnly: true,
            observedDataLines: [' '.repeat(80), doc.lineAt(4).text],
        });
        assert.ok(shifted);
        assert.equal(shifted.cardIndex, 2);
        assert.equal(shifted.card[0].n, 'MID');
        assert.equal(shifted.resolutionSource, 'physical-order');
        assert.equal(shifted.cardPositionConflict, undefined);
    });

    it('recognizes pipe-delimited preprocessor headers as the same physical card', () => {
        const { getCardInfoForDocumentLine } = require('../../src/core/keywordSchema');
        const header = '$    NEIPH|    NEIPS|   MAXINT|   STRFLG|   SIGFLG|   EPSFLG|   RLTFLG|   ENGFLG';
        const doc = fakeDoc([
            '*DATABASE_EXTENT_BINARY',
            header,
            '         0        16         3         1         1         1         1         1',
        ].join('\n'));

        const info = getCardInfoForDocumentLine(doc, 2, undefined, {
            keywordLine: 0,
            dataLineOrdinal: 1,
            previousHeaderTexts: [header],
            columnOneCommentsOnly: true,
        });

        assert.ok(info);
        assert.deepEqual(info.card.map(field => field.n), [
            'NEIPH', 'NEIPS', 'MAXINT', 'STRFLG',
            'SIGFLG', 'EPSFLG', 'RLTFLG', 'ENGFLG',
        ]);
        assert.equal(info.cardCommentNotice, undefined);
        assert.equal(info.cardPositionConflict, undefined);
    });

    it('recognizes plain dollar fixed headers and ignores nearby prose comments', () => {
        const { getCardInfoForDocumentLine } = require('../../src/core/keywordSchema');
        const labels = ['NEIPH', 'NEIPS', 'MAXINT', 'STRFLG', 'SIGFLG', 'EPSFLG', 'RLTFLG', 'ENGFLG'];
        const header = '$' + labels.map((label, index) => label.padStart(index === 0 ? 9 : 10)).join('');
        const doc = fakeDoc([
            '*DATABASE_EXTENT_BINARY',
            header,
            '$ Output settings retained for the company crash workflow',
            ' '.repeat(80),
        ].join('\n'));

        const info = getCardInfoForDocumentLine(doc, 3, undefined, {
            keywordLine: 0,
            dataLineOrdinal: 1,
            previousHeaderTexts: [header, doc.lineAt(2).text],
            columnOneCommentsOnly: true,
        });

        assert.ok(info);
        assert.equal(info.card[0].n, 'NEIPH');
        assert.equal(info.cardCommentNotice, undefined);
    });

    it('assesses mismatched comments separately from card resolution', () => {
        const { getCardInfoForDocumentLine } = require('../../src/core/keywordSchema');
        const header = '$    NEIPH|    NEIPS|   MAXINT|   STRFLG|   SIGFLG|   EPSFLG|      OLD|     OLD2';
        const doc = fakeDoc(['*DATABASE_EXTENT_BINARY', header, ' '.repeat(80)].join('\n'));

        const info = getCardInfoForDocumentLine(doc, 2, undefined, {
            keywordLine: 0,
            dataLineOrdinal: 1,
            previousHeaderTexts: [header],
            columnOneCommentsOnly: true,
        });

        assert.ok(info);
        assert.equal(info.card[0].n, 'NEIPH');
        assert.equal(info.cardPositionConflict, undefined);
        assert.equal(info.cardCommentNotice, undefined);
        const notice = require('../../src/core/keywordSchema').assessCardComment(info, [header]);
        assert.equal(notice.kind, 'definition-mismatch');
        assert.equal(notice.matchedFieldCount, 6);
        assert.deepEqual(notice.differences, [
            { position: 60, width: 10, observed: 'OLD', expected: 'RLTFLG' },
            { position: 70, width: 10, observed: 'OLD2', expected: 'ENGFLG' },
        ]);
    });

    it('keeps preprocessor metadata and low-coverage comments unknown and quiet', () => {
        const { getCardInfoForDocumentLine } = require('../../src/core/keywordSchema');
        const doc = fakeDoc([
            '*DATABASE_EXTENT_BINARY',
            '$HMNAME DATABASE 1',
            '$HWCOLOR DATABASE 4',
            '$ ------------------------------',
            ' '.repeat(80),
        ].join('\n'));

        const info = getCardInfoForDocumentLine(doc, 4, undefined, {
            keywordLine: 0,
            dataLineOrdinal: 1,
            previousHeaderTexts: [doc.lineAt(1).text, doc.lineAt(2).text, doc.lineAt(3).text],
            columnOneCommentsOnly: true,
        });

        assert.ok(info);
        assert.equal(info.card[0].n, 'NEIPH');
        assert.equal(info.cardCommentNotice, undefined);
        assert.equal(info.cardPositionConflict, undefined);
    });

    it('returns unresolved within the read budget near the end of a million-line deck', () => {
        const { getCardInfoForDocumentLine } = require('../../src/core/keywordSchema');
        const lineCount = 1_000_000;
        const targetLine = lineCount - 1;
        const header = '$    NEIPH|    NEIPS|   MAXINT|   STRFLG|   SIGFLG|   EPSFLG|   RLTFLG|   ENGFLG';
        let lineReads = 0;
        const doc = {
            lineCount,
            lineAt(line) {
                lineReads++;
                if (line === 0) return { text: '*DATABASE_EXTENT_BINARY' };
                if (line === targetLine) return { text: ' '.repeat(80) };
                return { text: header };
            },
        };

        const info = getCardInfoForDocumentLine(doc, targetLine, undefined, {
            keywordLine: 0,
            columnOneCommentsOnly: true,
        });

        assert.equal(info, null);
        assert.ok(lineReads <= 256, `expected bounded line reads, got ${lineReads}`);
    });

    it('keeps native CONTACT ID_MPP card order despite stale comments', () => {
        const { getCardForDocumentLine, getCardInfoForDocumentLine } = require('../../src/core/keywordSchema');
        const doc = fakeDoc([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP',
            '$#    ssid      msid     sstyp     mstyp    sboxid    mboxid       spr       mpr',
            '',
            '$#      fs        fd        dc        vc       vdc    penchk        bt        dt',
            '       0.0       0.0       0.0       0.0       0.0         0       0.0       0.0',
            '$#    soft    sofscl    lcidab    maxpar     sbopt     depth     bsort    frcfrq',
            '                 0.1         0     1.025         2         2                   1',
            '$#  pstiff   ignroff               fstol    2dbinr    ssftyp     swtpr    tetfac',
            '         0         0                 2.0         0         0         0       0.0'
        ].join('\n'));

        const cid = getCardInfoForDocumentLine(doc, 2);
        assert.ok(cid);
        assert.equal(cid.card[0].n, 'CID');
        assert.equal(cid.isLeadingOptionCard, true);
        assert.equal(cid.cardPositionConflict, undefined);

        const mpp1 = getCardForDocumentLine(doc, 4);
        assert.ok(mpp1);
        assert.equal(mpp1[0].n, 'SURFA');

        const soft = getCardForDocumentLine(doc, 6);
        assert.ok(soft);
        assert.equal(soft[0].n, 'FS');

        const pstiff = getCardForDocumentLine(doc, 8);
        assert.ok(pstiff);
        assert.equal(pstiff[0].n, 'SFSA');
    });

    it('keeps old compact entries usable when option metadata is absent', () => {
        const { getRenderedCards } = require('../../src/core/keywordSchema');
        const entry = { c: [[{ n: 'A', p: 0, w: 10 }], [{ n: 'B', p: 0, w: 10 }]], r: 1 };

        const cards = getRenderedCards(entry, [], 4);
        assert.equal(cards.length, 4);
        assert.equal(cards[0][0].n, 'A');
        assert.equal(cards[3][0].n, 'B');
    });

    it('does not invent repetition for a single-card schema without r', () => {
        const { getCardInfoForDocumentLine } = require('../../src/core/keywordSchema');
        const schema = { TEST: { c: [[{ n: 'ID', p: 0, w: 10 }]] } };
        const doc = fakeDoc('*TEST\n         1\n         2');
        assert.ok(getCardInfoForDocumentLine(doc, 1, schema));
        assert.equal(getCardInfoForDocumentLine(doc, 2, schema), null);
    });

    it('does not invent extra cards for multi-card keywords without r', () => {
        const { getRenderedCards } = require('../../src/core/keywordSchema');
        const entry = {
            c: [
                [{ n: 'A', p: 0, w: 10 }],
                [{ n: 'B', p: 0, w: 10 }],
            ],
        };
        const cards = getRenderedCards(entry, [], 4);
        assert.equal(cards.length, 2);
        assert.equal(cards[1][0].n, 'B');
    });

    it('expands multi-card SET_SOLID list rows when entry.r is set (Vol I Card 2)', () => {
        const { lookupKeywordSchema, getRenderedCards, getCardForDocumentLine } = require('../../src/core/keywordSchema');
        const lookup = lookupKeywordSchema('SET_SOLID');
        assert.ok(lookup);
        assert.equal(lookup.entry.r, 1);
        assert.ok(lookup.entry.c.length >= 2);

        const cards = getRenderedCards(lookup.entry, lookup.activeOptions || [], 4);
        assert.equal(cards.length, 4);
        assert.equal(cards[0][0].n, 'SID');
        assert.equal(cards[3][0].n, 'K1');

        const doc = {
            lineCount: 5,
            lineAt(i) {
                const lines = [
                    '*SET_SOLID',
                    '$#     sid    solver',
                    '         1      MECH',
                    '         1         2         3         4         5         6         7         8',
                    '         9        10',
                ];
                return { text: lines[i] };
            },
        };
        const row2 = getCardForDocumentLine(doc, 4);
        assert.ok(row2, 'second SET_SOLID list data row should resolve as K1.. list card');
        assert.equal(row2[0].n, 'K1');
    });

    it('expands SET_NODE_LIST_COLLECT list rows when entry.r is set', () => {
        const { lookupKeywordSchema, getRenderedCards } = require('../../src/core/keywordSchema');
        const lookup = lookupKeywordSchema('SET_NODE_LIST_COLLECT');
        assert.ok(lookup);
        assert.equal(lookup.entry.r, 1);
        const cards = getRenderedCards(lookup.entry, lookup.activeOptions || [], 3);
        assert.equal(cards.length, 3);
        assert.equal(cards[2][0].n, 'NID1');
    });

    it('caches the compact schema runtime per language', () => {
        const fs = require('fs');
        const keywordSchema = require('../../src/core/keywordSchema');
        const originalReadFileSync = fs.readFileSync;
        let schemaRuntimeReads = 0;

        keywordSchema.resetKeywordSchemaCache();
        fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
            if (String(filePath).endsWith('field_schema.runtime.json.gz')) {
                schemaRuntimeReads++;
            }
            return originalReadFileSync.call(this, filePath, ...args);
        };

        try {
            const first = keywordSchema.loadKeywordSchema(() => 'en');
            const second = keywordSchema.loadKeywordSchema(() => 'en');

            assert.strictEqual(first, second);
            assert.equal(schemaRuntimeReads, 1);
        } finally {
            fs.readFileSync = originalReadFileSync;
            keywordSchema.resetKeywordSchemaCache();
        }
    });

    it('returns card info with keyword name and one-based card index', () => {
        const keywordSchema = require('../../src/core/keywordSchema');
        const doc = fakeDoc([
            '*MAT_PIECEWISE_LINEAR_PLASTICITY',
            '$#     mid        ro         e        pr      sigy      etan      fail      tdel',
            '         1       7.8     210.0       0.3     400.0       0.0',
            '$#       c         p      lcss      lcsr        vp',
            '       0.0       0.0      1001         0       0.0',
        ].join('\n'));

        const info = keywordSchema.getCardInfoForDocumentLine(doc, 4, keywordSchema.loadKeywordSchema(() => 'en'));

        assert.equal(info.keywordName, 'MAT_PIECEWISE_LINEAR_PLASTICITY');
        assert.equal(info.cardIndex, 2);
        assert.ok(info.card.some(field => field.n === 'LCSS'));
    });

    describe('isLongFormatKeyword', () => {
        const keywordSchema = require('../../src/core/keywordSchema');
        const { isLongFormatKeyword } = keywordSchema;

        it('detects per-keyword long-format marker (trailing +)', () => {
            assert.strictEqual(isLongFormatKeyword('*NODE+'), true);
            assert.strictEqual(isLongFormatKeyword('*ELEMENT_SHELL+'), true);
            assert.strictEqual(isLongFormatKeyword('  *NODE+  '), true);
        });

        it('detects the per-keyword I10 percent marker', () => {
            assert.strictEqual(isLongFormatKeyword('*NODE %'), true);
            assert.strictEqual(isLongFormatKeyword('*NODE%'), true);
            assert.strictEqual(isLongFormatKeyword('*NODE,%'), true);
        });

        it('detects deck-wide LONG=Y/K while keeping LONG=S standard', () => {
            assert.strictEqual(isLongFormatKeyword('*KEYWORD LONG=Y'), true);
            assert.strictEqual(isLongFormatKeyword('*KEYWORD LONG=K'), true);
            assert.strictEqual(isLongFormatKeyword('*KEYWORD LONG=S'), false);
            assert.strictEqual(isLongFormatKeyword('*KEYWORD  long = y'), true);
            assert.strictEqual(isLongFormatKeyword('*KEYWORD LONG=Y 100000000'), true);
            assert.strictEqual(isLongFormatKeyword('*NODE LONG=Y'), false);
            assert.strictEqual(isLongFormatKeyword('*KEYWORD I10=Y'), true);
            assert.strictEqual(isLongFormatKeyword('*KEYWORD I10=N'), false);
        });

        it('resolves attached standard-format overrides to the base schema keyword', () => {
            const schema = keywordSchema.loadKeywordSchema(() => 'en');
            assert.equal(keywordSchema.lookupKeywordSchema('*NODE-', schema).canonicalName, 'NODE');
            assert.equal(
                keywordSchema.lookupKeywordSchema('*DEFINE_BOX_ADAPTIVE-', schema).canonicalName,
                'DEFINE_BOX_ADAPTIVE',
            );
        });

        it('is false for short-format keywords', () => {
            assert.strictEqual(isLongFormatKeyword('*NODE'), false);
            assert.strictEqual(isLongFormatKeyword('*SET_NODE_LIST'), false);
            assert.strictEqual(isLongFormatKeyword('*NODE-'), false);
            assert.strictEqual(isLongFormatKeyword('*KEYWORD'), false);
            assert.strictEqual(isLongFormatKeyword('*KEYWORD 100000000'), false);
        });

        it('is false for non-keyword / empty text', () => {
            assert.strictEqual(isLongFormatKeyword(''), false);
            assert.strictEqual(isLongFormatKeyword('         1       7.8'), false);
            assert.strictEqual(isLongFormatKeyword('$ comment'), false);
        });
    });
});
