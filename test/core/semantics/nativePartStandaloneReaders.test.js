'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const { getCardInfoForDocumentLineWithSuggest: resolve, LsdynaFieldHoverProvider } = require("../../../out/extension")._internals;

const partStandaloneReaders = require("../../../keywords/runtime/native-readers/lspp-part-standalone-readers.json");
const TEST_DECKS = [
    {
        keyword: 'NODE_TO_TARGET_VECTOR',
        standard: [
            '*NODE_TO_TARGET_VECTOR',
            '       1        1.000000        2.000000        3.000000',
            '       2        4.000000        5.000000        6.000000'
        ],
        comma: [
            '*NODE_TO_TARGET_VECTOR',
            '1,1.0,2.0,3.0'
        ],
        long: [
            '*NODE_TO_TARGET_VECTOR+',
            '                   1                 1.0                 2.0                 3.0'
        ],
        i10: [
            '*NODE_TO_TARGET_VECTOR%',
            '         1             1.0             2.0             3.0'
        ],
        expectedFields: ['NID', 'XDELTA', 'YDELTA', 'ZDELTA']
    },
    {
        keyword: 'PART_DUPLICATE',
        standard: [
            '*PART_DUPLICATE',
            'PART               1       100       100       100         1         0       0.0',
            'PART               2       200       200       200         1         0       0.0'
        ],
        comma: [
            '*PART_DUPLICATE',
            'PART,1,100,100,100,1,0,0.0'
        ],
        long: [
            '*PART_DUPLICATE+',
            'PART                               1                 100                 100                 100                   1                   0                 0.0'
        ],
        i10: [
            '*PART_DUPLICATE%',
            'PART               1       100       100       100         1         0       0.0'
        ],
        expectedFields: ['PTYPE', 'TYPEID', 'IDPOFF', 'IDEOFF', 'IDNOFF', 'TRANID', 'BOXID', 'ZMIN']
    },
    {
        keyword: 'PART_DUPLICATE_NULL_OVERLAY',
        standard: [
            '*PART_DUPLICATE_NULL_OVERLAY',
            'PART               1       100       100    7.8e-9     2.1e5       0.3'
        ],
        comma: [
            '*PART_DUPLICATE_NULL_OVERLAY',
            'PART,1,100,100,7.8e-9,2.1e5,0.3'
        ],
        long: [
            '*PART_DUPLICATE_NULL_OVERLAY+',
            'PART                               1                 100                 100              7.8e-9               2.1e5                 0.3'
        ],
        i10: [
            '*PART_DUPLICATE_NULL_OVERLAY%',
            'PART               1       100       100    7.8e-9     2.1e5       0.3'
        ],
        expectedFields: ['PTYPE', 'TYPEID', 'IDPOFF', 'IDEOFF', 'DENSITY', 'E', 'PR']
    },
    {
        keyword: 'PART_STACKED_ELEMENTS',
        standard: [
            '*PART_STACKED_ELEMENTS',
            'Stacked Elements Title Here'.padEnd(80),
            '         1         2         0         0',
            '         1         1         1         0         0       0.5         0',
            '         2         1         1         0         0       0.5         0'
        ],
        comma: [
            '*PART_STACKED_ELEMENTS',
            'Stacked Elements Comma Title',
            '1,2,0,0',
            '1,1,1,0,0,0.5,0'
        ],
        long: [
            '*PART_STACKED_ELEMENTS+',
            'Stacked Elements Long Title',
            '                   1                   2                   0                   0',
            '                   1                   1                   1                   0                   0                 0.5                   0'
        ],
        i10: [
            '*PART_STACKED_ELEMENTS%',
            'Stacked Elements I10 Title',
            '         1         2         0         0',
            '         1         1         1         0         0       0.5         0'
        ],
        expectedFields: ['TITLE']
    },
    {
        keyword: 'PART_MOVE',
        standard: [
            '*PART_MOVE',
            '       1             1.0             2.0             3.0       0       0'
        ],
        comma: [
            '*PART_MOVE',
            '1,1.0,2.0,3.0,0,0'
        ],
        long: [
            '*PART_MOVE+',
            '                   1                 1.0                 2.0                 3.0                   0                   0'
        ],
        i10: [
            '*PART_MOVE%',
            '         1             1.0             2.0             3.0        0         0'
        ],
        expectedFields: ['PID', 'XMOV', 'YMOV', 'ZMOV', 'CID', 'IFSET']
    },
    {
        keyword: 'PART_MOVE_N2N',
        standard: [
            '*PART_MOVE_N2N',
            '       1       2       3       0           1'
        ],
        comma: [
            '*PART_MOVE_N2N',
            '1,2,3,0,1'
        ],
        long: [
            '*PART_MOVE_N2N+',
            '                   1                   2                   3                   0                   1'
        ],
        i10: [
            '*PART_MOVE_N2N%',
            '         1         2         3         0         1'
        ],
        expectedFields: ['PID', 'N1', 'N1', 'IFSET', 'DONOW']
    },
    {
        keyword: 'PART_MODES',
        standard: [
            '*PART_MODES',
            '         1         4         0         0         0         1         0         0',
            'modes.pch'.padEnd(70),
            '         1         2         3         4         0         0         0         0',
            '         1         4       0.1'
        ],
        comma: [
            '*PART_MODES',
            '1,4,0,0,0,1,0,0',
            'modes.pch',
            '1,2,3,4,0,0,0,0',
            '1,4,0.1'
        ],
        long: [
            '*PART_MODES+',
            '                   1                   4                   0                   0                   0                   1                   0                   0',
            'modes.pch',
            '                   1                   2                   3                   4                   0                   0                   0                   0',
            '                   1                   4                 0.1'
        ],
        i10: [
            '*PART_MODES%',
            '         1         4         0         0         0         1         0         0',
            'modes.pch',
            '         1         2         3         4         0         0         0         0',
            '         1         4       0.1'
        ],
        expectedFields: ['PID', 'NMFB', 'FORM', 'ANSID', 'FORMAT', 'KMFLAG', 'NUPDF', 'SIGREC']
    }
];

describe('native PART and NODE standalone readers', () => {
    it('validates part-standalone-readers catalog evidence and bindings structure', () => {

        const bindings = partStandaloneReaders.bindings;
        assert.equal(Object.keys(bindings).length, 6);

        assert.equal(bindings.PART_DUPLICATE.cardCount, 1);

        assert.equal(bindings.PART_DUPLICATE_NULL_OVERLAY.cardCount, 1);

        assert.equal(bindings.PART_STACKED_ELEMENTS.cardCount, 3);

        assert.equal(bindings.PART_MOVE.cardCount, 1);

        assert.equal(bindings.PART_MOVE_N2N.cardCount, 1);
        assert.equal(bindings.PART_MOVE_N2N.readWindows, true);

        assert.equal(bindings.PART_MODES.cardCount, 4);
    });

    it('resolves fields across all four formats (standard, comma, long, i10) for all 7 keywords', () => {
        for (const tc of TEST_DECKS) {
            for (const fmt of ['standard', 'comma', 'long', 'i10']) {
                const lines = tc[fmt];
                const doc = fakeDoc(lines.join('\n'));
                const res = resolve(doc, 1);
                assert.ok(res?.cardInfo, `${tc.keyword} [${fmt}]: resolve returned no cardInfo`);
                assert.equal(res.cardInfo.resolutionSource, 'native-file-reader', `${tc.keyword} [${fmt}]: resolutionSource is not native-file-reader`);
                assert.equal(res.cardInfo.card.length, tc.expectedFields.length, `${tc.keyword} [${fmt}]: card field count mismatch`);
                const names = res.cardInfo.card.map(f => f.n);
                assert.deepEqual(names, tc.expectedFields, `${tc.keyword} [${fmt}]: field names mismatch`);
            }
        }
    });

    it('handles PART_STACKED_ELEMENTS multi-card layout and repeating layer cards', () => {
        const lines = TEST_DECKS.find(c => c.keyword === 'PART_STACKED_ELEMENTS').standard;
        const doc = fakeDoc(lines.join('\n'));
        // Card 1: Title
        const r1 = resolve(doc, 1);
        assert.equal(r1.cardInfo.nativeCardIndex, 1);
        assert.equal(r1.cardInfo.card[0].n, 'TITLE');
        assert.equal(r1.cardInfo.card[0].rawValue.trim(), 'Stacked Elements Title Here');

        // Card 2: Main
        const r2 = resolve(doc, 2);
        assert.equal(r2.cardInfo.nativeCardIndex, 2);
        assert.deepEqual(r2.cardInfo.card.map(f => f.n), ['PIDREF', 'NUMLAY', 'ADPOPT', 'INPLCMP']);

        // Card 3: Layer 1
        const r3 = resolve(doc, 3);
        assert.equal(r3.cardInfo.nativeCardIndex, 3);
        assert.deepEqual(r3.cardInfo.card.map(f => f.n), ['PIDi', 'SIDi', 'MIDi', 'HGIDi', 'TMIDi', 'THKi', 'NSLDi']);
        assert.equal(r3.cardInfo.card[0].rawValue, '1');

        // Card 3: Layer 2
        const r4 = resolve(doc, 4);
        assert.equal(r4.cardInfo.nativeCardIndex, 3);
        assert.deepEqual(r4.cardInfo.card.map(f => f.n), ['PIDi', 'SIDi', 'MIDi', 'HGIDi', 'TMIDi', 'THKi', 'NSLDi']);
        assert.equal(r4.cardInfo.card[0].rawValue, '2');
    });

    it('handles PART_MODES 4-card sequence with KMFLAG=1 and dynamic card skip with KMFLAG=0', () => {
        // KMFLAG = 1: Card 1 -> Card 2 (filename) -> Card 3 (modes) -> Card 4 (damping)
        const lines = TEST_DECKS.find(c => c.keyword === 'PART_MODES').standard;
        const doc1 = fakeDoc(lines.join('\n'));
        const r1 = resolve(doc1, 1);
        assert.equal(r1.cardInfo.nativeCardIndex, 1);

        const r2 = resolve(doc1, 2);
        assert.equal(r2.cardInfo.nativeCardIndex, 2);
        assert.equal(r2.cardInfo.card[0].n, 'FILENAME');
        assert.equal(r2.cardInfo.card[0].rawValue.trim(), 'modes.pch');

        const r3 = resolve(doc1, 3);
        assert.equal(r3.cardInfo.nativeCardIndex, 3);
        assert.equal(r3.cardInfo.card[0].n, 'MODE1');

        const r4 = resolve(doc1, 4);
        assert.equal(r4.cardInfo.nativeCardIndex, 4);
        assert.deepEqual(r4.cardInfo.card.map(f => f.n), ['MSTART', 'MSTOP', 'DAMPF']);

        // KMFLAG = 0: Card 1 -> Card 2 (filename) -> Card 4 (damping), skipping Card 3
        const doc0 = fakeDoc([
            '*PART_MODES',
            '         1         4         0         0         0         0         0         0',
            'modes.pch'.padEnd(70),
            '         1         4       0.1'
        ].join('\n'));
        const rSkip = resolve(doc0, 3);
        assert.equal(rSkip.cardInfo.nativeCardIndex, 4);
        assert.deepEqual(rSkip.cardInfo.card.map(f => f.n), ['MSTART', 'MSTOP', 'DAMPF']);
    });

    it('retains homogeneous multi-instance identity across repeated single-card records', () => {
        const doc = fakeDoc([
            '*PART_MOVE',
            '       1             1.0             2.0             3.0       0       0',
            '       2             4.0             5.0             6.0       0       0',
            '       3             7.0             8.0             9.0       0       0'
        ].join('\n'));

        for (let line = 1; line <= 3; line++) {
            const res = resolve(doc, line);
            assert.ok(res?.cardInfo);
            assert.equal(res.cardInfo.nativeCardIndex, 1);
            assert.equal(res.cardInfo.card[0].rawValue, String(line));
        }
    });

    it('provides hover documentation for native fields', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const doc = { ...fakeDoc([
            '*PART_MOVE_N2N',
            '       1       2       3       0           1'
        ].join('\n')), version: 1 };

        const hover = await provider.provideHover(doc, { line: 1, character: 3 });
        assert.ok(hover);
        assert.ok(hover.contents.length > 0);
    });
});
