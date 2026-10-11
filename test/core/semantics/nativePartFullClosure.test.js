'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const { getCardInfoForDocumentLineWithSuggest: resolve } = require("../../../out/extension")._internals;

const partModularReaders = require("../../../keywords/runtime/native-readers/lspp-part-modular-readers.json");
const partKeywords=require("../../fixtures/public-behavior/part-registration-keywords.json");

const MAIN_FIELDS = ['PID', 'SECID', 'MID', 'EOSID', 'HGID', 'GRAV', 'ADPOPT', 'TMID'];
const INERTIA_CARD3 = ['XC', 'YC', 'ZC', 'TM', 'IRCS', 'NODEID'];
const INERTIA_CARD4 = ['IXX', 'IXY', 'IXZ', 'IYY', 'IYZ', 'IZZ'];
const INERTIA_CARD5 = ['VTX', 'VTY', 'VTZ', 'VRX', 'VRY', 'VRZ'];
const INERTIA_CARD6 = ['XL', 'YL', 'ZL', 'XLIP', 'YLIP', 'ZLIP', 'CID'];

const TEST_DECKS = [
    {
        keyword: 'PART_INERTIA',
        cardCount: 6,
        standard: [
            '*PART_INERTIA',
            'Sample Part Inertia Title'.padEnd(80),
            '       101       201       301         0         0         0         0         0',
            '       0.0       0.0       0.0       1.0         0         0',
            '       1.0       0.0       0.0       1.0       0.0       1.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0         0'
        ],
        comma: [
            '*PART_INERTIA',
            'Sample Part Inertia Comma Title',
            '101,201,301,0,0,0,0,0',
            '0.0,0.0,0.0,1.0,0,0',
            '1.0,0.0,0.0,1.0,0.0,1.0',
            '0.0,0.0,0.0,0.0,0.0,0.0',
            '0.0,0.0,0.0,0.0,0.0,0.0,0'
        ],
        long: [
            '*PART_INERTIA+',
            'Sample Part Inertia Long Title'.padEnd(80),
            '                 101                 201                 301                   0                   0                   0                   0                   0',
            '                 0.0                 0.0                 0.0                 1.0                   0                   0',
            '                 1.0                 0.0                 0.0                 1.0                 0.0                 1.0',
            '                 0.0                 0.0                 0.0                 0.0                 0.0                 0.0',
            '                 0.0                 0.0                 0.0                 0.0                 0.0                 0.0                   0'
        ],
        i10: [
            '*PART_INERTIA%',
            'Sample Part Inertia I10 Title'.padEnd(80),
            '       101       201       301         0         0         0         0         0',
            '       0.0       0.0       0.0       1.0         0         0',
            '       1.0       0.0       0.0       1.0       0.0       1.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0         0'
        ],
        cardChecks: [
            { cardIndex: 3, fields: INERTIA_CARD3 },
            { cardIndex: 4, fields: INERTIA_CARD4 },
            { cardIndex: 5, fields: INERTIA_CARD5 },
            { cardIndex: 6, fields: INERTIA_CARD6 }
        ]
    },
    {
        keyword: 'PART_INERTIA_CONTACT',
        cardCount: 7,
        standard: [
            '*PART_INERTIA_CONTACT',
            'Sample Part Inertia Contact Title'.padEnd(80),
            '       101       201       301         0         0         0         0         0',
            '       0.0       0.0       0.0       1.0         0         0',
            '       1.0       0.0       0.0       1.0       0.0       1.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0         0',
            '       0.1       0.2       0.0       0.0         0       0.0       0.0         0'
        ],
        comma: [
            '*PART_INERTIA_CONTACT',
            'Sample Part Inertia Contact Comma Title',
            '101,201,301,0,0,0,0,0',
            '0.0,0.0,0.0,1.0,0,0',
            '1.0,0.0,0.0,1.0,0.0,1.0',
            '0.0,0.0,0.0,0.0,0.0,0.0',
            '0.0,0.0,0.0,0.0,0.0,0.0,0',
            '0.1,0.2,0.0,0.0,0,0.0,0.0,0'
        ],
        long: [
            '*PART_INERTIA_CONTACT+',
            'Sample Part Inertia Contact Long Title'.padEnd(80),
            '                 101                 201                 301                   0                   0                   0                   0                   0',
            '                 0.0                 0.0                 0.0                 1.0                   0                   0',
            '                 1.0                 0.0                 0.0                 1.0                 0.0                 1.0',
            '                 0.0                 0.0                 0.0                 0.0                 0.0                 0.0',
            '                 0.0                 0.0                 0.0                 0.0                 0.0                 0.0                   0',
            '                 0.1                 0.2                 0.0                 0.0                   0                 0.0                 0.0                   0'
        ],
        i10: [
            '*PART_INERTIA_CONTACT%',
            'Sample Part Inertia Contact I10 Title'.padEnd(80),
            '       101       201       301         0         0         0         0         0',
            '       0.0       0.0       0.0       1.0         0         0',
            '       1.0       0.0       0.0       1.0       0.0       1.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0',
            '       0.0       0.0       0.0       0.0       0.0       0.0         0',
            '       0.1       0.2       0.0       0.0         0       0.0       0.0         0'
        ],
        cardChecks: [
            { cardIndex: 7, fields: ['FS', 'FD', 'DC', 'VC', 'OPTT', 'SFT', 'SSF', 'CPARM8'] }
        ]
    },
    {
        keyword: 'PART_FIELD',
        cardCount: 5,
        standard: [
            '*PART_FIELD',
            'Sample Part Field Title'.padEnd(80),
            '       101       201       301         0         0         0         0         0',
            '         1',
            '         4',
            '         1       101         2       102         3       103         4       104'
        ],
        comma: [
            '*PART_FIELD',
            'Sample Part Field Comma Title',
            '101,201,301,0,0,0,0,0',
            '1,',
            '4,',
            '1,101,2,102,3,103,4,104'
        ],
        long: [
            '*PART_FIELD+',
            'Sample Part Field Long Title'.padEnd(80),
            '                 101                 201                 301                   0                   0                   0                   0                   0',
            '                   1',
            '                   4',
            '                   1                 101                   2                 102                   3                 103                   4                 104'
        ],
        i10: [
            '*PART_FIELD%',
            'Sample Part Field I10 Title'.padEnd(80),
            '       101       201       301         0         0         0         0         0',
            '         1',
            '         4',
            '         1       101         2       102         3       103         4       104'
        ],
        cardChecks: [
            { cardIndex: 3, fields: ['FIDBO'] },
            { cardIndex: 4, fields: ['NHV'] },
            { cardIndex: 5, fields: ['IHV1', 'FIDHV1', 'IHV2', 'FIDHV2', 'IHV3', 'FIDHV3', 'IHV4', 'FIDHV4'] }
        ]
    },
    {
        keyword: 'PART_REPOSITION_CONTACT_PRINT_ATTACHMENT_NODES_FIELD',
        cardCount: 9,
        standard: [
            '*PART_REPOSITION_CONTACT_PRINT_ATTACHMENT_NODES_FIELD',
            'Sample Part All Modules Title'.padEnd(80),
            '       101       201       301         0         0         0         0         0',
            '         1         0         2',
            '       0.1       0.2       0.0       0.0         0       0.0       0.0         0',
            '         1',
            '      5001',
            '         1',
            '         4',
            '         1       101         2       102         3       103         4       104'
        ],
        comma: [
            '*PART_REPOSITION_CONTACT_PRINT_ATTACHMENT_NODES_FIELD',
            'Sample Part All Modules Comma Title',
            '101,201,301,0,0,0,0,0',
            '1,0,2',
            '0.1,0.2,0.0,0.0,0,0.0,0.0,0',
            '1,',
            '5001,',
            '1,',
            '4,',
            '1,101,2,102,3,103,4,104'
        ],
        long: [
            '*PART_REPOSITION_CONTACT_PRINT_ATTACHMENT_NODES_FIELD+',
            'Sample Part All Modules Long Title'.padEnd(80),
            '                 101                 201                 301                   0                   0                   0                   0                   0',
            '                   1                   0                   2',
            '                 0.1                 0.2                 0.0                 0.0                   0                 0.0                 0.0                   0',
            '                   1',
            '                5001',
            '                   1',
            '                   4',
            '                   1                 101                   2                 102                   3                 103                   4                 104'
        ],
        i10: [
            '*PART_REPOSITION_CONTACT_PRINT_ATTACHMENT_NODES_FIELD%',
            'Sample Part All Modules I10 Title'.padEnd(80),
            '       101       201       301         0         0         0         0         0',
            '         1         0         2',
            '       0.1       0.2       0.0       0.0         0       0.0       0.0         0',
            '         1',
            '      5001',
            '         1',
            '         4',
            '         1       101         2       102         3       103         4       104'
        ],
        cardChecks: [
            { cardIndex: 3, fields: ['CMSN', 'MDEP', 'MOVOPT'] },
            { cardIndex: 4, fields: ['FS', 'FD', 'DC', 'VC', 'OPTT', 'SFT', 'SSF', 'CPARM8'] },
            { cardIndex: 5, fields: ['PRBF'] },
            { cardIndex: 6, fields: ['ANSID'] },
            { cardIndex: 7, fields: ['FIDBO'] },
            { cardIndex: 8, fields: ['NHV'] },
            { cardIndex: 9, fields: ['IHV1', 'FIDHV1', 'IHV2', 'FIDHV2', 'IHV3', 'FIDHV3', 'IHV4', 'FIDHV4'] }
        ]
    }
];

describe('Category PART Full Closure Phase 2C (Inertia, Field, and All Combinations)', () => {
    // Source and matrix digest locks are checked in publicPartRegistryFixtureSources.test.js.
    it('retains 49 modular native reader bindings', () => {
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
                    assert.ok(res?.cardInfo, `Expected cardInfo for ${specimen.keyword} Card 2 (${format})`);
                    assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                    assert.equal(res.cardInfo.nativeCardIndex, 2);
                    assert.equal(res.cardInfo.inputFormat, format);
                    assert.deepEqual(res.cardInfo.card.map(f => f.n), MAIN_FIELDS);
                    assert.equal(res.cardInfo.approvedStaticRecord, undefined);
                }
            });

            for (const check of specimen.cardChecks) {
                it(`resolves Card ${check.cardIndex} across standard, comma, long, and i10 formats`, () => {
                    for (const format of ['standard', 'comma', 'long', 'i10']) {
                        const doc = fakeDoc(specimen[format].join('\n'));
                        const res = resolve(doc, check.cardIndex);
                        assert.ok(res?.cardInfo, `Expected cardInfo for ${specimen.keyword} Card ${check.cardIndex} (${format})`);
                        assert.equal(res.cardInfo.resolutionSource, 'native-file-reader');
                        assert.equal(res.cardInfo.nativeCardIndex, check.cardIndex);
                        assert.equal(res.cardInfo.inputFormat, format);
                        assert.deepEqual(res.cardInfo.card.map(f => f.n), check.fields);
                        assert.equal(res.cardInfo.approvedStaticRecord, undefined);
                    }
                });
            }
        });
    }

    it('achieves 100.0% native closure across all 72 Category PART registrations in authoritative binary registry', function() {
        this.timeout(20000);
        const partRegs=partKeywords.map(name=>({name}));
        assert.equal(partRegs.length, 72, 'Category PART should have strictly 72 registrations');

        let resolved = 0;
        const failures = [];

        for (const reg of partRegs) {
            const kw = reg.name === 'PART' ? 'PART' : (reg.name.startsWith('PART_') ? reg.name : 'PART_' + reg.name);
            const doc = fakeDoc(['*' + kw, '         1         2         3         4'].join('\n'));
            const res = resolve(doc, 1);
            if (res?.cardInfo?.resolutionSource === 'native-file-reader') {
                resolved++;
            } else {
                failures.push({ kw, source: res?.cardInfo?.resolutionSource });
            }
        }

        assert.equal(failures.length, 0, `Category PART had unresolved keywords: ${JSON.stringify(failures)}`);
        assert.equal(resolved, 72, `Category PART closure ${resolved}/72 is not 100%`);
    });
});
