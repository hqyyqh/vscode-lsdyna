'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const { getCardInfoForDocumentLineWithSuggest: resolve, LsdynaFieldHoverProvider } = require("../../../out/extension")._internals;

const MAIN_FIELDS = ['PID', 'SECID', 'MID', 'EOSID', 'HGID', 'GRAV', 'ADPOPT', 'TMID'];
const CONTACT_FIELDS = ['FS', 'FD', 'DC', 'VC', 'OPTT', 'SFT', 'SSF', 'CPARM8'];
const PRINT_FIELDS = ['PRBF'];
const ATTACHMENT_FIELDS = ['ANSID'];
const REPOSITION_FIELDS = ['CMSN', 'MDEP', 'MOVOPT'];

const MULTI_DECKS = [
    {
        keyword: 'PART_CONTACT_PRINT',
        expectedCards: [
            ['TITLE'],
            MAIN_FIELDS,
            CONTACT_FIELDS,
            PRINT_FIELDS
        ],
        standard: [
            '*PART_CONTACT_PRINT',
            'Sample Contact Print Title'.padEnd(80),
            '       101       201       301         0         0         0         0         0',
            '       0.1       0.2       0.0       0.0       0.0       1.0       1.0       0.0',
            '         1'
        ]
    },
    {
        keyword: 'PART_CONTACT_ATTACHMENT_NODES',
        expectedCards: [
            ['TITLE'],
            MAIN_FIELDS,
            CONTACT_FIELDS,
            ATTACHMENT_FIELDS
        ],
        standard: [
            '*PART_CONTACT_ATTACHMENT_NODES',
            'Sample Contact Attachment Title'.padEnd(80),
            '       102       202       302         0         0         0         0         0',
            '       0.1       0.2       0.0       0.0       0.0       1.0       1.0       0.0',
            '      5001'
        ]
    },
    {
        keyword: 'PART_CONTACT_PRINT_ATTACHMENT_NODES',
        expectedCards: [
            ['TITLE'],
            MAIN_FIELDS,
            CONTACT_FIELDS,
            PRINT_FIELDS,
            ATTACHMENT_FIELDS
        ],
        standard: [
            '*PART_CONTACT_PRINT_ATTACHMENT_NODES',
            'Sample Contact Print Attachment Title'.padEnd(80),
            '       103       203       303         0         0         0         0         0',
            '       0.1       0.2       0.0       0.0       0.0       1.0       1.0       0.0',
            '         1',
            '      5001'
        ]
    },
    {
        keyword: 'PART_PRINT_ATTACHMENT_NODES',
        expectedCards: [
            ['TITLE'],
            MAIN_FIELDS,
            PRINT_FIELDS,
            ATTACHMENT_FIELDS
        ],
        standard: [
            '*PART_PRINT_ATTACHMENT_NODES',
            'Sample Print Attachment Title'.padEnd(80),
            '       104       204       304         0         0         0         0         0',
            '         1',
            '      5001'
        ]
    },
    {
        keyword: 'PART_REPOSITION_PRINT',
        expectedCards: [
            ['TITLE'],
            MAIN_FIELDS,
            REPOSITION_FIELDS,
            PRINT_FIELDS
        ],
        standard: [
            '*PART_REPOSITION_PRINT',
            'Sample Reposition Print Title'.padEnd(80),
            '       105       205       305         0         0         0         0         0',
            '         1         0         2',
            '         1'
        ]
    },
    {
        keyword: 'PART_REPOSITION_ATTACHMENT_NODES',
        expectedCards: [
            ['TITLE'],
            MAIN_FIELDS,
            REPOSITION_FIELDS,
            ATTACHMENT_FIELDS
        ],
        standard: [
            '*PART_REPOSITION_ATTACHMENT_NODES',
            'Sample Reposition Attachment Title'.padEnd(80),
            '       106       206       306         0         0         0         0         0',
            '         1         0         2',
            '      5001'
        ]
    },
    {
        keyword: 'PART_REPOSITION_CONTACT',
        expectedCards: [
            ['TITLE'],
            MAIN_FIELDS,
            REPOSITION_FIELDS,
            CONTACT_FIELDS
        ],
        standard: [
            '*PART_REPOSITION_CONTACT',
            'Sample Reposition Contact Title'.padEnd(80),
            '       107       207       307         0         0         0         0         0',
            '         1         0         2',
            '       0.1       0.2       0.0       0.0       0.0       1.0       1.0       0.0'
        ]
    },
    {
        keyword: 'PART_REPOSITION_CONTACT_PRINT',
        expectedCards: [
            ['TITLE'],
            MAIN_FIELDS,
            REPOSITION_FIELDS,
            CONTACT_FIELDS,
            PRINT_FIELDS
        ],
        standard: [
            '*PART_REPOSITION_CONTACT_PRINT',
            'Sample Reposition Contact Print Title'.padEnd(80),
            '       108       208       308         0         0         0         0         0',
            '         1         0         2',
            '       0.1       0.2       0.0       0.0       0.0       1.0       1.0       0.0',
            '         1'
        ]
    },
    {
        keyword: 'PART_REPOSITION_CONTACT_ATTACHMENT_NODES',
        expectedCards: [
            ['TITLE'],
            MAIN_FIELDS,
            REPOSITION_FIELDS,
            CONTACT_FIELDS,
            ATTACHMENT_FIELDS
        ],
        standard: [
            '*PART_REPOSITION_CONTACT_ATTACHMENT_NODES',
            'Sample Reposition Contact Attachment Title'.padEnd(80),
            '       109       209       309         0         0         0         0         0',
            '         1         0         2',
            '       0.1       0.2       0.0       0.0       0.0       1.0       1.0       0.0',
            '      5001'
        ]
    },
    {
        keyword: 'PART_REPOSITION_PRINT_ATTACHMENT_NODES',
        expectedCards: [
            ['TITLE'],
            MAIN_FIELDS,
            REPOSITION_FIELDS,
            PRINT_FIELDS,
            ATTACHMENT_FIELDS
        ],
        standard: [
            '*PART_REPOSITION_PRINT_ATTACHMENT_NODES',
            'Sample Reposition Print Attachment Title'.padEnd(80),
            '       110       210       310         0         0         0         0         0',
            '         1         0         2',
            '         1',
            '      5001'
        ]
    },
    {
        keyword: 'PART_REPOSITION_CONTACT_PRINT_ATTACHMENT_NODES',
        expectedCards: [
            ['TITLE'],
            MAIN_FIELDS,
            REPOSITION_FIELDS,
            CONTACT_FIELDS,
            PRINT_FIELDS,
            ATTACHMENT_FIELDS
        ],
        standard: [
            '*PART_REPOSITION_CONTACT_PRINT_ATTACHMENT_NODES',
            'Sample Reposition Contact Print Attachment Title'.padEnd(80),
            '       111       211       311         0         0         0         0         0',
            '         1         0         2',
            '       0.1       0.2       0.0       0.0       0.0       1.0       1.0       0.0',
            '         1',
            '      5001'
        ]
    }
];

describe('Category PART Multi-Modular Readers Phase 2B', () => {
    for (const specimen of MULTI_DECKS) {
        describe(`Keyword: *${specimen.keyword}`, () => {
            it('resolves all cards in exact orthogonal sequence with exact field schemas', () => {
                const doc = fakeDoc(specimen.standard.join('\n'));
                for (let cardIdx = 1; cardIdx <= specimen.expectedCards.length; cardIdx++) {
                    const res = resolve(doc, cardIdx);
                    assert.ok(res?.cardInfo, `Expected cardInfo for ${specimen.keyword} Card ${cardIdx}`);
                    assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                    assert.equal(res.cardInfo.nativeCardIndex, cardIdx);
                    assert.equal(res.cardInfo.approvedStaticRecord, undefined);
                    const expected = specimen.expectedCards[cardIdx - 1];
                    assert.deepEqual(res.cardInfo.card.map(f => f.n), expected,
                        `${specimen.keyword} Card ${cardIdx} fields mismatch`);
                }
            });

            it('resolves in long format (+)', () => {
                const lines = ['*' + specimen.keyword + '+', specimen.standard[1]];
                for (let i = 2; i < specimen.standard.length; i++) {
                    const fields = specimen.standard[i].trim().split(/\s+/);
                    lines.push(fields.map(v => v.padStart(20)).join(''));
                }
                const doc = fakeDoc(lines.join('\n'));
                for (let cardIdx = 1; cardIdx <= specimen.expectedCards.length; cardIdx++) {
                    const res = resolve(doc, cardIdx);
                    assert.ok(res?.cardInfo, `Expected long cardInfo for ${specimen.keyword} Card ${cardIdx}`);
                    assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                    if (cardIdx > 1) assert.equal(res.cardInfo.inputFormat, 'long');
                }
            });

            it('resolves in comma format', () => {
                const lines = ['*' + specimen.keyword, specimen.standard[1]];
                for (let i = 2; i < specimen.standard.length; i++) {
                    const fields = specimen.standard[i].trim().split(/\s+/);
                    lines.push(fields.join(',') + (fields.length === 1 ? ',' : ''));
                }
                const doc = fakeDoc(lines.join('\n'));
                for (let cardIdx = 1; cardIdx <= specimen.expectedCards.length; cardIdx++) {
                    const res = resolve(doc, cardIdx);
                    assert.ok(res?.cardInfo, `Expected comma cardInfo for ${specimen.keyword} Card ${cardIdx}`);
                    assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                    if (cardIdx > 1) assert.equal(res.cardInfo.inputFormat, 'comma');
                }
            });
        });
    }

    it('provides native hover documentation across multi-modular fields', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const specimen = MULTI_DECKS[0]; // PART_CONTACT_PRINT
        const doc = { ...fakeDoc(specimen.standard.join('\n')), version: 1 };

        // Card 3: Contact (FS)
        const hoverFS = await provider.provideHover(doc, { line: 3, character: 3 });
        assert.ok(hoverFS?.contents[0]?.value?.includes('FS'), 'Hover should document FS field');

        // Card 4: Print (PRBF)
        const hoverPRBF = await provider.provideHover(doc, { line: 4, character: 3 });
        assert.ok(hoverPRBF?.contents[0]?.value?.includes('PRBF'), 'Hover should document PRBF field');
    });
});
