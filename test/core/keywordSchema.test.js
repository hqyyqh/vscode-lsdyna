'use strict';

const assert = require('assert');
const { fakeDoc } = require('../helpers');

describe('keywordSchema resolver', () => {
    it('maps text-card lines including $ and $# content to the text card', () => {
        const { getCardInfoForDocumentLine } = require('../../src/core/keywordSchema');
        const schema = {
            COMMENT: {
                c: [[{ n: 'COMMENT', p: 0, w: 80, h: 'Any comment line.', t: 'string' }]],
                tc: [{ name: 'comment', f: [{ n: 'COMMENT', p: 0, w: 80, t: 'string' }] }],
            },
        };
        const doc = fakeDoc([
            '*COMMENT',
            '$# this is text, not a field header',
            '$ this is also text',
            'ordinary free text',
            '*END',
        ].join('\n'));

        for (const line of [1, 2, 3]) {
            const info = getCardInfoForDocumentLine(doc, line, schema);
            assert.ok(info);
            assert.equal(info.isTextCard, true);
            assert.equal(info.cardIndex, 1);
            assert.equal(info.card[0].n, 'COMMENT');
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

        // Valid base + ID exists, but ID_OFFSET is not a schema option combination
        // (correct form is OFFSET_ID / BEAM_OFFSET_ID). Must not soft-match as known.
        const invalid = lookupKeywordSchema('CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_OFFSET');
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

    it('resolves SET_PART aliases to the SET_PART_LIST card schema', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');

        for (const keyword of ['SET_PART', '*SET_PART']) {
            const lookup = lookupKeywordSchema(keyword);

            assert.ok(lookup, `${keyword} should resolve`);
            assert.equal(lookup.canonicalName, 'SET_PART_LIST');
            assert.equal(lookup.entry.c[0][0].n, 'SID');
        }
    });

    it('resolves SET_NODE_TITLE and SET_PART_TITLE aliases to LIST title variants', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');

        for (const [keyword, canonical] of [
            ['SET_NODE_TITLE', 'SET_NODE_LIST_TITLE'],
            ['*SET_NODE_TITLE', 'SET_NODE_LIST_TITLE'],
            ['SET_PART_TITLE', 'SET_PART_LIST_TITLE'],
            ['*SET_PART_TITLE', 'SET_PART_LIST_TITLE'],
        ]) {
            const lookup = lookupKeywordSchema(keyword);

            assert.ok(lookup, `${keyword} should resolve`);
            assert.equal(lookup.canonicalName, canonical);
            assert.deepEqual(lookup.activeOptions, ['TITLE']);
            assert.equal(lookup.entry.c[0][0].n, 'SID');
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

    it('uses field comment headers before line-count fallback for CONTACT option variants', () => {
        const { getCardForDocumentLine } = require('../../src/core/keywordSchema');
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

        const ssid = getCardForDocumentLine(doc, 2);
        assert.ok(ssid);
        assert.equal(ssid[0].n, 'SSID');

        const fs = getCardForDocumentLine(doc, 4);
        assert.ok(fs);
        assert.equal(fs[0].n, 'FS');

        const soft = getCardForDocumentLine(doc, 6);
        assert.ok(soft);
        assert.equal(soft[0].n, 'SOFT');

        const pstiff = getCardForDocumentLine(doc, 8);
        assert.ok(pstiff);
        assert.equal(pstiff[0].n, 'PSTIFF');
    });

    it('keeps old compact entries usable when option metadata is absent', () => {
        const { getRenderedCards } = require('../../src/core/keywordSchema');
        const entry = { c: [[{ n: 'A', p: 0, w: 10 }], [{ n: 'B', p: 0, w: 10 }]], r: 1 };

        const cards = getRenderedCards(entry, [], 4);
        assert.equal(cards.length, 4);
        assert.equal(cards[0][0].n, 'A');
        assert.equal(cards[3][0].n, 'B');
    });

    it('repeats single-card keywords for extra data rows even without r', () => {
        const { getRenderedCards, getCardForDocumentLine } = require('../../src/core/keywordSchema');
        const entry = {
            c: [[
                { n: 'EID', p: 0, w: 8 },
                { n: 'NID', p: 8, w: 8 },
                { n: 'MASS', p: 16, w: 16 },
                { n: 'PID', p: 32, w: 8 },
            ]],
        };
        const cards = getRenderedCards(entry, [], 3);
        assert.equal(cards.length, 3);
        assert.equal(cards[2][0].n, 'EID');

        // Live schema: *ELEMENT_MASS second data row must resolve a card
        const doc = {
            lineCount: 4,
            lineAt(i) {
                const lines = [
                    '*ELEMENT_MASS',
                    '$#   eid     nid            mass     pid',
                    '  900001  900001         7.77E-2       0',
                    '  920001  920001         7.77E-2       0',
                ];
                return { text: lines[i] };
            },
        };
        const row2 = getCardForDocumentLine(doc, 3);
        assert.ok(row2, 'second ELEMENT_MASS data row should have card fields');
        assert.equal(row2[0].n, 'EID');
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

    it('caches loaded schema JSON per language', () => {
        const fs = require('fs');
        const keywordSchema = require('../../src/core/keywordSchema');
        const originalReadFileSync = fs.readFileSync;
        let fieldDataReads = 0;

        keywordSchema.resetKeywordSchemaCache();
        fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
            if (String(filePath).endsWith('field_data.json')) {
                fieldDataReads++;
            }
            return originalReadFileSync.call(this, filePath, ...args);
        };

        try {
            const first = keywordSchema.loadKeywordSchema(() => 'en');
            const second = keywordSchema.loadKeywordSchema(() => 'en');

            assert.strictEqual(first, second);
            assert.equal(fieldDataReads, 1);
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
        const { isLongFormatKeyword } = require('../../src/core/keywordSchema');

        it('detects per-keyword long-format marker (trailing +)', () => {
            assert.strictEqual(isLongFormatKeyword('*NODE+'), true);
            assert.strictEqual(isLongFormatKeyword('*ELEMENT_SHELL+'), true);
            assert.strictEqual(isLongFormatKeyword('  *NODE+  '), true);
        });

        it('detects deck-wide LONG=Y / LONG=S option', () => {
            assert.strictEqual(isLongFormatKeyword('*KEYWORD LONG=Y'), true);
            assert.strictEqual(isLongFormatKeyword('*KEYWORD LONG=S'), true);
            assert.strictEqual(isLongFormatKeyword('*KEYWORD  long = y'), true);
            assert.strictEqual(isLongFormatKeyword('*KEYWORD LONG=Y 100000000'), true);
        });

        it('is false for short-format keywords', () => {
            assert.strictEqual(isLongFormatKeyword('*NODE'), false);
            assert.strictEqual(isLongFormatKeyword('*SET_NODE_LIST'), false);
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
