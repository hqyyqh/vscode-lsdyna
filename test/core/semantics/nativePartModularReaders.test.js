'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const { getCardInfoForDocumentLineWithSuggest: resolve, LsdynaFieldHoverProvider } = require("../../../out/extension")._internals;

const partModularReaders = require("../../../keywords/runtime/native-readers/lspp-part-modular-readers.json");
const MAIN_FIELDS = ['PID', 'SECID', 'MID', 'EOSID', 'HGID', 'GRAV', 'ADPOPT', 'TMID'];

const TEST_DECKS = [
    {
        keyword: 'PART_AVERAGED',
        cards: 2,
        standard: [
            '*PART_AVERAGED',
            'Sample Averaged Part Title'.padEnd(80),
            '       101       201       301         0         0         0         0         0'
        ],
        comma: [
            '*PART_AVERAGED',
            'Sample Averaged Part Comma Title',
            '101,201,301,0,0,0,0,0'
        ],
        long: [
            '*PART_AVERAGED+',
            'Sample Averaged Part Long Title'.padEnd(80),
            '                 101                 201                 301                   0                   0                   0                   0                   0'
        ],
        i10: [
            '*PART_AVERAGED%',
            'Sample Averaged Part I10 Title'.padEnd(80),
            '       101       201       301         0         0         0         0         0'
        ],
        card3Fields: null
    },
    {
        keyword: 'PART_ATTACHMENT_NODES',
        cards: 3,
        standard: [
            '*PART_ATTACHMENT_NODES',
            'Sample Attachment Nodes Part Title'.padEnd(80),
            '       102       202       302         0         0         0         0         0',
            '      5001'
        ],
        comma: [
            '*PART_ATTACHMENT_NODES',
            'Sample Attachment Nodes Comma Title',
            '102,202,302,0,0,0,0,0',
            '5001,'
        ],
        long: [
            '*PART_ATTACHMENT_NODES+',
            'Sample Attachment Nodes Long Title'.padEnd(80),
            '                 102                 202                 302                   0                   0                   0                   0                   0',
            '                5001'
        ],
        i10: [
            '*PART_ATTACHMENT_NODES%',
            'Sample Attachment Nodes I10 Title'.padEnd(80),
            '       102       202       302         0         0         0         0         0',
            '      5001'
        ],
        card3Fields: ['ANSID']
    },
    {
        keyword: 'PART_CONTACT',
        cards: 3,
        standard: [
            '*PART_CONTACT',
            'Sample Contact Part Title'.padEnd(80),
            '       103       203       303         0         0         0         0         0',
            '       0.1       0.2       0.0       0.0       0.0       1.0       1.0       0.0'
        ],
        comma: [
            '*PART_CONTACT',
            'Sample Contact Comma Title',
            '103,203,303,0,0,0,0,0',
            '0.1,0.2,0.0,0.0,0.0,1.0,1.0,0.0'
        ],
        long: [
            '*PART_CONTACT+',
            'Sample Contact Long Title'.padEnd(80),
            '                 103                 203                 303                   0                   0                   0                   0                   0',
            '                 0.1                 0.2                 0.0                 0.0                 0.0                 1.0                 1.0                 0.0'
        ],
        i10: [
            '*PART_CONTACT%',
            'Sample Contact I10 Title'.padEnd(80),
            '       103       203       303         0         0         0         0         0',
            '       0.1       0.2       0.0       0.0       0.0       1.0       1.0       0.0'
        ],
        card3Fields: ['FS', 'FD', 'DC', 'VC', 'OPTT', 'SFT', 'SSF', 'CPARM8']
    },
    {
        keyword: 'PART_PRINT',
        cards: 3,
        standard: [
            '*PART_PRINT',
            'Sample Print Part Title'.padEnd(80),
            '       104       204       304         0         0         0         0         0',
            '         1'
        ],
        comma: [
            '*PART_PRINT',
            'Sample Print Comma Title',
            '104,204,304,0,0,0,0,0',
            '1,'
        ],
        long: [
            '*PART_PRINT+',
            'Sample Print Long Title'.padEnd(80),
            '                 104                 204                 304                   0                   0                   0                   0                   0',
            '                   1'
        ],
        i10: [
            '*PART_PRINT%',
            'Sample Print I10 Title'.padEnd(80),
            '       104       204       304         0         0         0         0         0',
            '         1'
        ],
        card3Fields: ['PRBF']
    },
    {
        keyword: 'PART_REPOSITION',
        cards: 3,
        standard: [
            '*PART_REPOSITION',
            'Sample Reposition Part Title'.padEnd(80),
            '       105       205       305         0         0         0         0         0',
            '         1         0         2'
        ],
        comma: [
            '*PART_REPOSITION',
            'Sample Reposition Comma Title',
            '105,205,305,0,0,0,0,0',
            '1,0,2'
        ],
        long: [
            '*PART_REPOSITION+',
            'Sample Reposition Long Title'.padEnd(80),
            '                 105                 205                 305                   0                   0                   0                   0                   0',
            '                   1                   0                   2'
        ],
        i10: [
            '*PART_REPOSITION%',
            'Sample Reposition I10 Title'.padEnd(80),
            '       105       205       305         0         0         0         0         0',
            '         1         0         2'
        ],
        card3Fields: ['CMSN', 'MDEP', 'MOVOPT']
    }
];

describe('Category PART Modular Readers Phase 2A', () => {
    it('retains all 49 modular configuration bindings', () => {
        assert.equal(Object.keys(partModularReaders.bindings).length, 49);
    });

    for (const specimen of TEST_DECKS) {
        describe(`Keyword: *${specimen.keyword}`, () => {
            it('resolves Card 1 as 80-column Title text card', () => {
                const doc = fakeDoc(specimen.standard.join('\n'));
                const res = resolve(doc, 1);
                assert.ok(res?.cardInfo);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                assert.equal(res.cardInfo.nativeCardIndex, 1);
                assert.equal(res.cardInfo.card.length, 1);
                assert.equal(res.cardInfo.card[0].n, 'TITLE');
                assert.equal(res.cardInfo.card[0].w, 80);
                assert.equal(res.cardInfo.approvedStaticRecord, undefined);
            });

            it('resolves Card 2 Main fields across standard, comma, long, and i10 formats', () => {
                for (const format of ['standard', 'comma', 'long', 'i10']) {
                    const doc = fakeDoc(specimen[format].join('\n'));
                    const res = resolve(doc, 2);
                    assert.ok(res?.cardInfo, `Expected cardInfo for ${specimen.keyword} ${format} Card 2`);
                    assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                    assert.equal(res.cardInfo.nativeCardIndex, 2);
                    assert.deepEqual(res.cardInfo.card.map(f => f.n), MAIN_FIELDS);
                }
            });

            if (specimen.card3Fields) {
                it(`resolves Card 3 modular extension fields (${specimen.card3Fields.join(', ')})`, () => {
                    for (const format of ['standard', 'comma', 'long', 'i10']) {
                        const doc = fakeDoc(specimen[format].join('\n'));
                        const res = resolve(doc, 3);
                        assert.ok(res?.cardInfo, `Expected cardInfo for ${specimen.keyword} ${format} Card 3`);
                        assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                        assert.equal(res.cardInfo.nativeCardIndex, 3);
                        assert.deepEqual(res.cardInfo.card.map(f => f.n), specimen.card3Fields);
                    }
                });
            }
        });
    }

    it('provides native hover documentation for modular fields', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = { ...fakeDoc([
            '*PART_CONTACT',
            'Sample Contact Title'.padEnd(80),
            '       103       203       303         0         0         0         0         0',
            '       0.1       0.2       0.0       0.0       0.0       1.0       1.0       0.0'
        ].join('\n')), version: 1 };

        const hover = await provider.provideHover(doc, { line: 3, character: 3 });
        assert.ok(hover?.contents[0]?.value?.includes('FS'), 'Hover should document FS field');
    });
});
