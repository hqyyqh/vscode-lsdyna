'use strict';

const assert = require('assert');
const {
    splitLines,
    computeChangeMarks,
    alignLines,
    orderedMarkLines,
} = require('../../../src/client/changeMarks/changeMarksDiff');
const { emptyChangeMarks } = require('../../../src/client/changeMarks/types');

describe('changeMarksDiff', () => {
    describe('splitLines', () => {
        it('normalizes CRLF and keeps trailing empty line after final newline', () => {
            assert.deepStrictEqual(splitLines('a\r\nb\r\n'), ['a', 'b', '']);
            assert.deepStrictEqual(splitLines(''), ['']);
            assert.deepStrictEqual(splitLines('solo'), ['solo']);
        });
    });

    describe('computeChangeMarks (index-wise modified)', () => {
        it('marks nothing when all three snapshots match', () => {
            const t = 'L1\nL2\n';
            assert.deepStrictEqual(computeChangeMarks(t, t, t), emptyChangeMarks());
        });

        it('marks unsavedModified for dirty lines vs save point', () => {
            const origin = 'A\nB\nC';
            const save = 'A\nB\nC';
            const current = 'A\nBX\nC';
            const m = computeChangeMarks(origin, save, current);
            assert.deepStrictEqual(m.unsavedModifiedLines, [1]);
            assert.deepStrictEqual(m.unsavedInsertedLines, []);
            assert.deepStrictEqual(m.savedModifiedLines, []);
            assert.deepStrictEqual(m.savedInsertedLines, []);
        });

        it('marks savedModified after save when line still differs from origin', () => {
            const origin = 'A\nB\nC';
            const save = 'A\nB2\nC';
            const current = 'A\nB2\nC';
            const m = computeChangeMarks(origin, save, current);
            assert.deepStrictEqual(m.unsavedModifiedLines, []);
            assert.deepStrictEqual(m.savedModifiedLines, [1]);
        });

        it('prefers unsaved over saved when dirty again after a save', () => {
            const origin = 'A\nB\nC';
            const save = 'A\nB2\nC';
            const current = 'A\nB3\nC';
            const m = computeChangeMarks(origin, save, current);
            assert.deepStrictEqual(m.unsavedModifiedLines, [1]);
            assert.deepStrictEqual(m.savedModifiedLines, []);
        });

        it('can mark modified lines both orange and green', () => {
            const origin = 'A\nB\nC\nD';
            const save = 'A\nB2\nC\nD';
            const current = 'A\nB2\nCX\nD';
            const m = computeChangeMarks(origin, save, current);
            assert.deepStrictEqual(m.unsavedModifiedLines, [2]);
            assert.deepStrictEqual(m.savedModifiedLines, [1]);
        });
    });

    describe('computeChangeMarks (inserts)', () => {
        it('marks unsavedInserted for inserted lines', () => {
            const origin = 'A\nC';
            const save = 'A\nC';
            const current = 'A\nB\nC';
            const m = computeChangeMarks(origin, save, current);
            assert.ok(m.unsavedInsertedLines.includes(1), `expected insert: ${JSON.stringify(m)}`);
            assert.deepStrictEqual(m.unsavedModifiedLines, []);
            assert.deepStrictEqual(m.savedModifiedLines, []);
            assert.deepStrictEqual(m.savedInsertedLines, []);
            assert.deepStrictEqual(m.unsavedDeletedLines, []);
        });

        it('marks savedInserted after insert was saved', () => {
            const origin = 'A\nC';
            const save = 'A\nB\nC';
            const current = 'A\nB\nC';
            const m = computeChangeMarks(origin, save, current);
            assert.deepStrictEqual(m.unsavedInsertedLines, []);
            assert.ok(m.savedInsertedLines.includes(1), `expected saved insert: ${JSON.stringify(m)}`);
        });

        it('keeps prior modified as solid after a later insert (not demoted to hollow)', () => {
            // User repro: edit B→BX (solid), then insert NEW → BX must stay modified.
            const origin = 'A\nB\nC';
            const save = 'A\nB\nC';
            const current = 'A\nBX\nNEW\nC';
            const m = computeChangeMarks(origin, save, current);
            assert.deepStrictEqual(m.unsavedModifiedLines, [1], `modified BX: ${JSON.stringify(m)}`);
            assert.deepStrictEqual(m.unsavedInsertedLines, [2], `insert NEW: ${JSON.stringify(m)}`);
            assert.deepStrictEqual(m.unsavedDeletedLines, []);
        });

        it('keeps modified solid when insert is before the edited line', () => {
            const origin = 'A\nB\nC';
            const save = 'A\nB\nC';
            const current = 'A\nNEW\nBX\nC';
            const m = computeChangeMarks(origin, save, current);
            assert.ok(m.unsavedModifiedLines.includes(2), `BX modified: ${JSON.stringify(m)}`);
            assert.ok(m.unsavedInsertedLines.includes(1), `NEW insert: ${JSON.stringify(m)}`);
            assert.ok(!m.unsavedInsertedLines.includes(2), 'BX must not be insert');
        });
    });

    describe('computeChangeMarks (deletes)', () => {
        it('marks unsavedDeleted on neighbor after middle delete', () => {
            const origin = 'A\nB\nC';
            const save = 'A\nB\nC';
            const current = 'A\nC';
            const m = computeChangeMarks(origin, save, current);
            // Gap before C → anchor on current line of C (index 1)
            assert.deepStrictEqual(m.unsavedDeletedLines, [1]);
            assert.deepStrictEqual(m.unsavedModifiedLines, []);
            assert.deepStrictEqual(m.unsavedInsertedLines, []);
            assert.deepStrictEqual(m.savedDeletedLines, []);
        });

        it('marks unsavedDeleted on last line for trailing delete', () => {
            const origin = 'A\nB\nC';
            const save = 'A\nB\nC';
            const current = 'A\nB';
            const m = computeChangeMarks(origin, save, current);
            assert.deepStrictEqual(m.unsavedDeletedLines, [1]);
        });

        it('marks unsavedDeleted on first line for leading delete', () => {
            const origin = 'A\nB\nC';
            const save = 'A\nB\nC';
            const current = 'B\nC';
            const m = computeChangeMarks(origin, save, current);
            assert.deepStrictEqual(m.unsavedDeletedLines, [0]);
        });

        it('marks savedDeleted after delete was saved', () => {
            const origin = 'A\nB\nC';
            const save = 'A\nC';
            const current = 'A\nC';
            const m = computeChangeMarks(origin, save, current);
            assert.deepStrictEqual(m.unsavedDeletedLines, []);
            assert.deepStrictEqual(m.savedDeletedLines, [1]);
        });

        it('prefers unsaved delete over saved when same anchor', () => {
            // Delete unsaved: origin==save has B; current dropped B
            const origin = 'A\nB\nC';
            const save = 'A\nB\nC';
            const current = 'A\nC';
            const m = computeChangeMarks(origin, save, current);
            assert.deepStrictEqual(m.unsavedDeletedLines, [1]);
            assert.deepStrictEqual(m.savedDeletedLines, []);
        });
    });

    describe('alignLines / orderedMarkLines', () => {
        it('aligns matching lines and marks inserts', () => {
            const rows = alignLines(['A', 'C'], ['A', 'B', 'C']);
            const currentOnly = rows.filter(r => r.currentIndex >= 0);
            assert.strictEqual(currentOnly.length, 3);
            assert.ok(rows.some(r => r.originIndex < 0 && r.currentIndex === 1));
        });

        it('pairs substituted lines by similarity (not as pure inserts)', () => {
            // left B vs right BX should pair; NEW is the true insert
            const rows = alignLines(['A', 'B', 'C'], ['A', 'BX', 'NEW', 'C']);
            const bx = rows.find(r => r.currentIndex === 1);
            assert.ok(bx, JSON.stringify(rows));
            assert.strictEqual(bx.originIndex, 1, 'BX pairs with B');
            const neu = rows.find(r => r.currentIndex === 2);
            assert.ok(neu && neu.originIndex < 0, 'NEW is insert');
        });

        it('orders unsaved before saved, sorts within each group, and de-dupes', () => {
            const lines = orderedMarkLines({
                unsavedModifiedLines: [5, 1],
                unsavedInsertedLines: [5],
                unsavedDeletedLines: [4],
                savedModifiedLines: [3, 1],
                savedInsertedLines: [2],
                savedDeletedLines: [6],
            });
            // unsaved unique sorted: 1,4,5 then saved not in unsaved: 2,3,6
            assert.deepStrictEqual(lines, [1, 4, 5, 2, 3, 6]);
        });
    });
});
