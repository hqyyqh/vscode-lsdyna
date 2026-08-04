'use strict';

const assert = require('assert');
const {
    cardTotalWidth,
    padLineToCard,
    formatCellR1,
    readCellValue,
    clearCell,
    isLineAllEmpty,
    writeCellR1,
    caretAfterCellValue,
    fieldIndexAt,
    fieldIndexForDelete,
    fieldIndexForTabNav,
    classifyGrid,
    classifySelection,
    alignLineInPlace,
    clearCellsIntersecting,
    applyInCellDelete,
    applyInCellInsert,
    navSelectionRange,
} = require('../../../src/core/edit/cardCellModel');

const CARD3 = [
    { n: 'A', p: 0, w: 10 },
    { n: 'B', p: 10, w: 10 },
    { n: 'C', p: 20, w: 10 },
];

function buildLine(a, b, c) {
    let line = '';
    line = writeCellR1(line, CARD3, 0, a);
    line = writeCellR1(line, CARD3, 1, b);
    line = writeCellR1(line, CARD3, 2, c);
    return line;
}

describe('cardCellModel', () => {
    describe('format / write / clear', () => {
        it('formatCellR1 right-aligns and truncates', () => {
            assert.strictEqual(formatCellR1('12', 10), '        12');
            assert.strictEqual(formatCellR1('12345678901', 10), '1234567890');
        });

        it('S1: clear middle field keeps neighbors in columns', () => {
            const line0 = buildLine('123.0', '45.6', '78.9');
            assert.strictEqual(readCellValue(line0, CARD3, 0), '123.0');
            assert.strictEqual(readCellValue(line0, CARD3, 1), '45.6');
            assert.strictEqual(readCellValue(line0, CARD3, 2), '78.9');
            assert.strictEqual(cardTotalWidth(CARD3), 30);
            assert.ok(line0.length >= 30);

            const cleared = clearCell(line0, CARD3, 1);
            assert.strictEqual(readCellValue(cleared, CARD3, 0), '123.0');
            assert.strictEqual(readCellValue(cleared, CARD3, 1), '');
            assert.strictEqual(readCellValue(cleared, CARD3, 2), '78.9');
            // Field C still starts at column 20
            assert.strictEqual(cleared.slice(20, 30).trim(), '78.9');
            assert.strictEqual(cleared.slice(10, 20), '          ');
        });

        it('S2b: short overwrite does not collapse next field', () => {
            const line0 = buildLine('1', '12345', '67890');
            const short = writeCellR1(line0, CARD3, 1, '12');
            assert.strictEqual(readCellValue(short, CARD3, 1), '12');
            assert.strictEqual(readCellValue(short, CARD3, 2), '67890');
            assert.strictEqual(short.slice(20, 30).trim(), '67890');
            assert.ok(short.length >= 30);
        });

        it('S2c: clearCell blanks full logical cell including keep-separator column', () => {
            const line0 = buildLine('1', '999', '3');
            const cleared = clearCell(line0, CARD3, 1);
            assert.strictEqual(cleared.slice(10, 20), '          ');
            assert.strictEqual(readCellValue(cleared, CARD3, 2), '3');
        });

        it('isLineAllEmpty: empty and space-wall are empty; value rows are not', () => {
            assert.strictEqual(isLineAllEmpty(''), true);
            assert.strictEqual(isLineAllEmpty('                              '), true);
            assert.strictEqual(isLineAllEmpty(buildLine('', '', '')), true);
            assert.strictEqual(isLineAllEmpty(buildLine('1', '', '')), false);
            assert.strictEqual(isLineAllEmpty(buildLine('', '', '9')), false);
        });
    });

    describe('classifyGrid / classifySelection', () => {
        it('classifies intact vs messy vs off', () => {
            const intact = buildLine('1', '2', '3');
            assert.strictEqual(classifyGrid(intact, CARD3), 'intact');
            assert.strictEqual(classifyGrid('1,2,3', CARD3), 'messy');
            assert.strictEqual(classifyGrid('1 2 3', CARD3), 'messy');
            assert.strictEqual(classifyGrid('x', [{ n: 'T', p: 0, w: 80 }]), 'off');
            assert.strictEqual(classifyGrid('x', []), 'off');
        });

        it('fails closed for overlapping, reversed, and invalid field geometry', () => {
            assert.strictEqual(classifyGrid('', [
                { n: 'A', p: 0, w: 10 },
                { n: 'B', p: 0, w: 10 },
            ]), 'off');
            assert.strictEqual(classifyGrid('', [
                { n: 'A', p: 10, w: 10 },
                { n: 'B', p: 0, w: 10 },
            ]), 'off');
            assert.strictEqual(classifyGrid('', [
                { n: 'A', p: 0, w: 0 },
            ]), 'off');
        });

        it('classifies A full cell, keep-separator A, B, C, D', () => {
            const line = buildLine('1', '22', '333');
            assert.deepStrictEqual(
                classifySelection(line, CARD3, { startChar: 10, endChar: 20, isEmpty: false }),
                { kind: 'A', fieldIndex: 1 },
            );
            assert.deepStrictEqual(
                classifySelection(line, CARD3, { startChar: 11, endChar: 20, isEmpty: false }, { navKeepSeparator: true }),
                { kind: 'A', fieldIndex: 1 },
            );
            assert.deepStrictEqual(
                classifySelection(line, CARD3, { startChar: 12, endChar: 15, isEmpty: false }),
                { kind: 'B', fieldIndex: 1 },
            );
            assert.deepStrictEqual(
                classifySelection(line, CARD3, { startChar: 15, endChar: 15, isEmpty: true }),
                { kind: 'C', fieldIndex: 1 },
            );
            assert.deepStrictEqual(
                classifySelection(line, CARD3, { startChar: 5, endChar: 25, isEmpty: false }),
                { kind: 'D', fieldIndex: 0 },
            );
        });
    });

    describe('alignLineInPlace', () => {
        it('right-aligns physical fields without token re-rack', () => {
            // Physical: "1" in field0 left-ish, "2" in field1
            let line = padLineToCard('', CARD3);
            line = line.slice(0, 0) + '1' + line.slice(1);
            line = line.slice(0, 10) + '2' + line.slice(11);
            const aligned = alignLineInPlace(line, CARD3);
            assert.strictEqual(readCellValue(aligned, CARD3, 0), '1');
            assert.strictEqual(readCellValue(aligned, CARD3, 1), '2');
            // Values should be right-aligned in their cells
            assert.strictEqual(aligned.slice(0, 10), formatCellR1('1', 10));
            assert.strictEqual(aligned.slice(10, 20), formatCellR1('2', 10));
        });
    });

    describe('caretAfterCellValue', () => {
        it('sits after the last digit (exclusive end; may equal next field start)', () => {
            const line = writeCellR1(buildLine('1', 'x', '9'), CARD3, 1, '12');
            const caret = caretAfterCellValue(line, CARD3, 1);
            // Field 1 is [10, 20); value "12" R1-ends at exclusive col 20 when flush right,
            // or earlier if not full width — always after last digit.
            const val = readCellValue(line, CARD3, 1);
            assert.strictEqual(val, '12');
            // Caret is exclusive end of value within [10, 20]
            assert.ok(caret >= 10 && caret <= 20, `caret ${caret}`);
            // Character immediately left of caret is last digit
            assert.strictEqual(line[caret - 1], '2');
        });

        it('full-width value caret is exclusive end (= next field start)', () => {
            const line = writeCellR1(buildLine('1', 'x', '9'), CARD3, 1, '1234567890');
            const caret = caretAfterCellValue(line, CARD3, 1);
            assert.strictEqual(caret, 20);
            // Geometry alone maps 20 to next field; Backspace uses fieldIndexForDelete
            assert.strictEqual(fieldIndexAt(line, CARD3, caret), 2);
            assert.strictEqual(fieldIndexForDelete(line, CARD3, caret, 'left'), 1);
        });
    });

    describe('in-cell edit', () => {
        it('append insert builds value with R1 (S2 path)', () => {
            let line = buildLine('1', '12345', '67890');
            let r = applyInCellInsert(line, CARD3, 1, caretAfterCellValue(line, CARD3, 1), '1');
            // first key from A would write "1"; here append on existing — use write for first key
            line = writeCellR1(line, CARD3, 1, '1');
            r = applyInCellInsert(line, CARD3, 1, caretAfterCellValue(line, CARD3, 1), '2');
            assert.ok(r);
            assert.strictEqual(readCellValue(r.line, CARD3, 1), '12');
            assert.strictEqual(readCellValue(r.line, CARD3, 2), '67890');
        });

        it('multi-digit append stays in same field (no jump to next)', () => {
            let line = writeCellR1(buildLine('1', '12345', '67890'), CARD3, 1, '1');
            for (const ch of ['2', '3', '4']) {
                const caret = caretAfterCellValue(line, CARD3, 1);
                // Exclusive end may equal next field start; ownership is via Ap / fieldIndexForDelete
                assert.ok(caret >= 10 && caret <= 20, `caret ${caret}`);
                const r = applyInCellInsert(line, CARD3, 1, caret, ch);
                assert.ok(r);
                line = r.line;
            }
            assert.strictEqual(readCellValue(line, CARD3, 1), '1234');
            assert.strictEqual(readCellValue(line, CARD3, 2), '67890');
        });

        it('backspace on Ap shortens value without eating next field', () => {
            let line = writeCellR1(buildLine('1', 'x', '9'), CARD3, 1, '12');
            const r = applyInCellDelete(
                line,
                CARD3,
                1,
                { startChar: caretAfterCellValue(line, CARD3, 1), endChar: caretAfterCellValue(line, CARD3, 1), isEmpty: true },
                'left',
            );
            assert.ok(r);
            assert.strictEqual(readCellValue(r.line, CARD3, 1), '1');
            assert.strictEqual(readCellValue(r.line, CARD3, 2), '9');
        });

        it('backspace deletes character LEFT of caret (not right)', () => {
            // Value "123" R1 in field 1; caret between '2' and '3' → BS removes '2'
            let line = writeCellR1(buildLine('1', 'x', '9'), CARD3, 1, '123');
            const padded = line;
            // Find value region: last three non-space in [10, 20)
            const slice = padded.slice(10, 20);
            const lead = (slice.match(/^\s*/) || [''])[0].length;
            const caretBetween2and3 = 10 + lead + 2; // after "12"
            assert.strictEqual(padded[caretBetween2and3 - 1], '2');
            assert.strictEqual(padded[caretBetween2and3], '3');
            const r = applyInCellDelete(
                line,
                CARD3,
                1,
                { startChar: caretBetween2and3, endChar: caretBetween2and3, isEmpty: true },
                'left',
            );
            assert.ok(r);
            assert.strictEqual(readCellValue(r.line, CARD3, 1), '13');
            assert.strictEqual(readCellValue(r.line, CARD3, 2), '9');
        });

        it('backspace after last digit removes last digit only', () => {
            let line = writeCellR1(buildLine('1', '2', '99'), CARD3, 2, '99');
            const caret = caretAfterCellValue(line, CARD3, 2);
            assert.strictEqual(line[caret - 1], '9');
            const r = applyInCellDelete(
                line,
                CARD3,
                2,
                { startChar: caret, endChar: caret, isEmpty: true },
                'left',
            );
            assert.ok(r);
            assert.ok(!r.hitBoundary);
            assert.strictEqual(readCellValue(r.line, CARD3, 2), '9');
            assert.strictEqual(readCellValue(r.line, CARD3, 1), '2');
            // Caret stays after remaining digit
            assert.strictEqual(r.line[r.caretCol - 1], '9');
        });

        it('backspace in leading R1 pad hits left boundary (does not invent right-delete)', () => {
            const line = writeCellR1(buildLine('1', '2', 'x'), CARD3, 2, '45');
            // Field 2 is [20, 30); value right-aligned — caret in pad has nothing to the left in value
            const r = applyInCellDelete(
                line,
                CARD3,
                2,
                { startChar: 22, endChar: 22, isEmpty: true },
                'left',
            );
            assert.ok(r);
            assert.strictEqual(r.hitBoundary, 'left');
            assert.strictEqual(readCellValue(r.line, CARD3, 2), '45');
        });

        it('S4: delete on empty cell hits boundary without eating next field', () => {
            const line = clearCell(buildLine('1', '2', '3'), CARD3, 1);
            const r = applyInCellDelete(
                line,
                CARD3,
                1,
                { startChar: 15, endChar: 15, isEmpty: true },
                'right',
            );
            assert.ok(r);
            assert.strictEqual(r.hitBoundary, 'right');
            assert.strictEqual(readCellValue(r.line, CARD3, 2), '3');
            assert.strictEqual(readCellValue(r.line, CARD3, 1), '');
        });

        it('backspace on empty last field hits left boundary', () => {
            const line = clearCell(buildLine('1', '2', '3'), CARD3, 2);
            const r = applyInCellDelete(
                line,
                CARD3,
                2,
                { startChar: 25, endChar: 25, isEmpty: true },
                'left',
            );
            assert.ok(r);
            assert.strictEqual(r.hitBoundary, 'left');
            assert.strictEqual(readCellValue(r.line, CARD3, 1), '2');
        });

        it('E1: deleting a mid-value selection leaves no internal hole', () => {
            // Value "123" in field 1; select just the "2" and delete.
            let line = writeCellR1(buildLine('1', 'x', '9'), CARD3, 1, '123');
            const slice = line.slice(10, 20);
            const lead = (slice.match(/^\s*/) || [''])[0].length;
            const sel2 = 10 + lead + 1; // start of "2"
            const r = applyInCellDelete(
                line,
                CARD3,
                1,
                { startChar: sel2, endChar: sel2 + 1, isEmpty: false },
                'right',
            );
            assert.ok(r);
            // "13", not "1 3" — no space in a numeric field.
            assert.strictEqual(readCellValue(r.line, CARD3, 1), '13');
            assert.strictEqual(readCellValue(r.line, CARD3, 2), '9');
        });

        it('E1: deleting an interior span keeps the rest contiguous', () => {
            // Value "12345"; select "234" and delete → "15".
            let line = writeCellR1(buildLine('1', 'x', '9'), CARD3, 1, '12345');
            const slice = line.slice(10, 20);
            const lead = (slice.match(/^\s*/) || [''])[0].length;
            const start = 10 + lead + 1; // start of "2"
            const r = applyInCellDelete(
                line,
                CARD3,
                1,
                { startChar: start, endChar: start + 3, isEmpty: false },
                'right',
            );
            assert.ok(r);
            assert.strictEqual(readCellValue(r.line, CARD3, 1), '15');
        });

        it('E1: string field keeps meaningful internal spaces', () => {
            // Left-aligned string cell (w>=40). Value "AB CD"; delete the "B".
            const SCARD = [{ n: 'HEADING', p: 0, w: 40, t: 'string' }];
            let line = writeCellR1('', SCARD, 0, 'AB CD');
            assert.strictEqual(readCellValue(line, SCARD, 0), 'AB CD');
            // "AB CD": index 0='A',1='B',2=' ',3='C',4='D'. Delete index 1.
            const r = applyInCellDelete(
                line,
                SCARD,
                0,
                { startChar: 1, endChar: 2, isEmpty: false },
                'right',
            );
            assert.ok(r);
            // Internal space between the two words is preserved: "A CD".
            assert.strictEqual(readCellValue(r.line, SCARD, 0), 'A CD');
        });

        it('E1: deleting the whole value drops caret to field start', () => {
            let line = writeCellR1(buildLine('1', 'x', '9'), CARD3, 1, '123');
            const slice = line.slice(10, 20);
            const lead = (slice.match(/^\s*/) || [''])[0].length;
            const start = 10 + lead;
            const r = applyInCellDelete(
                line,
                CARD3,
                1,
                { startChar: start, endChar: start + 3, isEmpty: false },
                'right',
            );
            assert.ok(r);
            assert.strictEqual(readCellValue(r.line, CARD3, 1), '');
            assert.strictEqual(r.caretCol, 10);
        });
    });

    describe('M1 multi-cell clear', () => {
        it('clears fields whose values intersect selection', () => {
            const line = buildLine('1', '2', '3');
            // R1 packs values at cell ends (cols 9, 19, 29); span full card width.
            const out = clearCellsIntersecting(line, CARD3, 0, 30);
            assert.strictEqual(readCellValue(out, CARD3, 0), '');
            assert.strictEqual(readCellValue(out, CARD3, 1), '');
            assert.strictEqual(readCellValue(out, CARD3, 2), '');
        });

        it('does not clear next field when selection only covers prior value + pad', () => {
            // Mimic *ELEMENT_MASS_PART_SET: select "57999994" and trailing pad into ADDMASS
            const card = [
                { n: 'PSID', p: 0, w: 8 },
                { n: 'ADDMASS', p: 8, w: 16 },
                { n: 'FINMASS', p: 24, w: 16 },
            ];
            let line = '';
            line = writeCellR1(line, card, 0, '57999994');
            line = writeCellR1(line, card, 1, '0.05');
            line = writeCellR1(line, card, 2, '0.0');
            // Value of PSID is [0,8); pad of ADDMASS starts at 8. Select [0,12) → value + pad only.
            const out = clearCellsIntersecting(line, card, 0, 12);
            assert.strictEqual(readCellValue(out, card, 0), '');
            assert.strictEqual(readCellValue(out, card, 1), '0.05');
            assert.strictEqual(readCellValue(out, card, 2), '0.0');
        });

        it('still clears two fields when both values are selected', () => {
            const line = buildLine('12', '34', '56');
            // field0 value ends at 10, field1 value is near 18-20; select across both values
            const out = clearCellsIntersecting(line, CARD3, 8, 20);
            assert.strictEqual(readCellValue(out, CARD3, 0), '');
            assert.strictEqual(readCellValue(out, CARD3, 1), '');
            assert.strictEqual(readCellValue(out, CARD3, 2), '56');
        });
    });

    describe('navSelectionRange', () => {
        it('uses full width for first field and keep-separator for later', () => {
            assert.deepStrictEqual(navSelectionRange(CARD3, 0), { start: 0, end: 10 });
            assert.deepStrictEqual(navSelectionRange(CARD3, 1, { previousFieldHasValue: true }), {
                start: 11,
                end: 20,
            });
        });
    });

    describe('fieldIndexForDelete', () => {
        it('maps Backspace at field boundary to previous field', () => {
            const line = buildLine('12', '34', '56');
            // col 10 is start of field 1 = exclusive end of field 0
            assert.strictEqual(fieldIndexAt(line, CARD3, 10), 1);
            assert.strictEqual(fieldIndexForDelete(line, CARD3, 10, 'left'), 0);
            assert.strictEqual(fieldIndexForDelete(line, CARD3, 20, 'left'), 1);
            // Delete (right) keeps geometric field
            assert.strictEqual(fieldIndexForDelete(line, CARD3, 10, 'right'), 1);
            // Interior of field unchanged
            assert.strictEqual(fieldIndexForDelete(line, CARD3, 15, 'left'), 1);
        });

        it('backspace at next-field start chops previous field last digit', () => {
            const line = buildLine('1', '99', '3');
            // After field 1 value exclusive end = 20
            const r = applyInCellDelete(
                line,
                CARD3,
                fieldIndexForDelete(line, CARD3, 20, 'left'),
                { startChar: 20, endChar: 20, isEmpty: true },
                'left',
            );
            assert.ok(r);
            assert.strictEqual(readCellValue(r.line, CARD3, 1), '9');
            assert.strictEqual(readCellValue(r.line, CARD3, 2), '3');
        });
    });

    describe('fieldIndexAt', () => {
        it('maps columns to fields', () => {
            assert.strictEqual(fieldIndexAt('', CARD3, 0), 0);
            assert.strictEqual(fieldIndexAt('', CARD3, 10), 1);
            assert.strictEqual(fieldIndexAt('', CARD3, 25), 2);
        });
    });

    describe('fieldIndexForTabNav', () => {
        it('maps R1 previous exclusive end at next.p to previous field', () => {
            // R1 right-aligns any non-empty value against the right edge, so exclusive end
            // of field 0 is always next.p (10) — full-width and short alike.
            const full = buildLine('1234567890', '34', '56');
            assert.strictEqual(caretAfterCellValue(full, CARD3, 0), 10);
            assert.strictEqual(fieldIndexAt(full, CARD3, 10), 1);
            assert.strictEqual(fieldIndexForTabNav(full, CARD3, 10), 0);
            assert.strictEqual(fieldIndexForDelete(full, CARD3, 10, 'left'), 0);

            const short = buildLine('12', '34', '56');
            assert.strictEqual(caretAfterCellValue(short, CARD3, 0), 10);
            assert.strictEqual(fieldIndexForTabNav(short, CARD3, 10), 0);
        });

        it('keeps geometric ownership when previous field is empty', () => {
            const line = buildLine('', '34', '56');
            assert.strictEqual(fieldIndexAt(line, CARD3, 10), 1);
            assert.strictEqual(fieldIndexForTabNav(line, CARD3, 10), 1);
            // Backspace still owns previous (documented intentional difference)
            assert.strictEqual(fieldIndexForDelete(line, CARD3, 10, 'left'), 0);
        });

        it('keeps geometric ownership inside fields', () => {
            const line = buildLine('12', '34', '56');
            assert.strictEqual(fieldIndexForTabNav(line, CARD3, 5), 0);
            assert.strictEqual(fieldIndexForTabNav(line, CARD3, 15), 1);
        });
    });
});
