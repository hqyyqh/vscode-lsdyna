'use strict';

const assert = require('assert');
const { createCardCellEditGuard } = require('../../../src/client/services/cardCellEditGuard');
const {
    writeCellR1,
    readCellValue,
    clearCell,
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

function fakeDoc(lines) {
    const text = lines.join('\n');
    const arr = text.split('\n');
    return {
        uri: { toString: () => 'file:///t.k', fsPath: '/t.k' },
        version: 1,
        lineCount: arr.length,
        languageId: 'lsdyna',
        lineAt(i) {
            return { text: arr[i] || '' };
        },
    };
}

describe('cardCellEditGuard', () => {
    it('does not activate fixed-column editing for a text-card line', () => {
        const document = fakeDoc(['*COMMENT', 'free text exceeding eighty columns is still content']);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isTextCardLine: (_document, line) => line === 1,
            isProtectEnabled: () => true,
        });

        assert.strictEqual(guard.shouldCellEditActive({
            document,
            selection: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 0 },
                isEmpty: true,
            },
        }), false);
    });

    it('plans A-state clear without collapsing next field', () => {
        const line = buildLine('123.0', '45.6', '78.9');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(document, 1, 1, true);
        const plan = guard.planDelete(
            document,
            {
                start: { line: 1, character: 11 },
                end: { line: 1, character: 20 },
                isEmpty: false,
            },
            'right',
        );
        assert.ok(plan);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 0), '123.0');
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '');
        assert.strictEqual(readCellValue(plan.newText, CARD3, 2), '78.9');
    });

    it('plans A first-key type as full-cell write after Tab markA', () => {
        const line = buildLine('1', '12345', '67890');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(document, 1, 1, true);
        const plan = guard.planType(
            document,
            {
                start: { line: 1, character: 11 },
                end: { line: 1, character: 20 },
                isEmpty: false,
            },
            '1',
        );
        assert.ok(plan);
        assert.ok(!plan.escape);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '1');
        assert.strictEqual(readCellValue(plan.newText, CARD3, 2), '67890');
        assert.strictEqual(plan.markAp, true);
    });

    it('does not force an A overwrite after the user collapses the Tab selection', () => {
        const line = buildLine('1', '12345', '67890');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(document, 1, 1, true);

        assert.strictEqual(guard.planType(
            document,
            {
                start: { line: 1, character: 15 },
                end: { line: 1, character: 15 },
                isEmpty: true,
            },
            '9',
        ), null);
    });

    it('planType returns null without Tab nav (geometry alone does not type-over)', () => {
        const line = buildLine('1', '12345', '67890');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        // Full-field selection without markA
        const plan = guard.planType(
            document,
            {
                start: { line: 1, character: 10 },
                end: { line: 1, character: 20 },
                isEmpty: false,
            },
            '9',
        );
        assert.strictEqual(plan, null);
    });

    it('planType escapes * and $ after Tab (leave cell mode to host)', () => {
        const line = buildLine('1', '12345', '67890');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(document, 1, 1, true);
        assert.deepStrictEqual(
            guard.planType(
                document,
                { start: { line: 1, character: 11 }, end: { line: 1, character: 20 }, isEmpty: false },
                '*',
            ),
            { escape: true },
        );
        assert.deepStrictEqual(
            guard.planType(
                document,
                { start: { line: 1, character: 11 }, end: { line: 1, character: 20 }, isEmpty: false },
                '$',
            ),
            { escape: true },
        );
    });

    it('returns null when protect disabled', () => {
        const line = buildLine('1', '2', '3');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => false,
        });
        guard.markA(document, 1, 1, true);
        assert.strictEqual(
            guard.planDelete(
                document,
                { start: { line: 1, character: 10 }, end: { line: 1, character: 20 }, isEmpty: false },
                'right',
            ),
            null,
        );
        assert.strictEqual(
            guard.planType(
                document,
                { start: { line: 1, character: 10 }, end: { line: 1, character: 20 }, isEmpty: false },
                '1',
            ),
            null,
        );
    });

    it('fails closed when the document version no longer matches the navigation mark', () => {
        const line = buildLine('1', '2', '3');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(document, 1, 1, true);

        document.version += 1;
        const plan = guard.planType(
            document,
            {
                start: { line: 1, character: 11 },
                end: { line: 1, character: 20 },
                isEmpty: false,
            },
            '9',
        );

        assert.strictEqual(plan, null);
        assert.strictEqual(guard.navMatches(document, 1), false);
    });

    it('multi-key type stays in same field (A then Ap append)', () => {
        let line = buildLine('1', '12345', '67890');
        let document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(document, 1, 1, true);

        // First key: full-cell write
        let plan = guard.planType(
            document,
            { start: { line: 1, character: 11 }, end: { line: 1, character: 20 }, isEmpty: false },
            '1',
        );
        assert.ok(plan && !plan.escape);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '1');
        assert.strictEqual(plan.fieldIndex, 1);
        line = plan.newText;
        document = fakeDoc(['*NODE', line]);
        document.version = 2;
        guard.markAp(document, 1, plan.fieldIndex);

        // Caret after value: exclusive end may equal 20 (next field start); Ap owns field 1
        let caret = plan.caret;
        assert.ok(caret >= 10 && caret <= 20, `caret ${caret}`);

        // Simulate selection change after edit (Ap must not clear on right-edge caret)
        guard.onSelectionChange({
            document,
            selection: {
                start: { line: 1, character: caret },
                end: { line: 1, character: caret },
                isEmpty: true,
            },
            selections: [{ start: { line: 1, character: caret }, end: { line: 1, character: caret }, isEmpty: true }],
        });
        assert.ok(guard.getNav(), 'Ap nav must survive selection change at value end');
        assert.strictEqual(guard.getNav().mode, 'Ap');
        assert.strictEqual(guard.getNav().fieldIndex, 1);

        // Second / third keys: append in same field
        for (const ch of ['2', '3']) {
            plan = guard.planType(
                document,
                {
                    start: { line: 1, character: caret },
                    end: { line: 1, character: caret },
                    isEmpty: true,
                },
                ch,
            );
            assert.ok(plan && !plan.escape, `planType for '${ch}'`);
            assert.strictEqual(plan.fieldIndex, 1);
            line = plan.newText;
            caret = plan.caret;
            document = fakeDoc(['*NODE', line]);
            document.version = (document.version || 2) + 1;
            guard.markAp(document, 1, plan.fieldIndex);
            guard.onSelectionChange({
                document,
                selection: {
                    start: { line: 1, character: caret },
                    end: { line: 1, character: caret },
                    isEmpty: true,
                },
                selections: [{ start: { line: 1, character: caret }, end: { line: 1, character: caret }, isEmpty: true }],
            });
        }
        assert.strictEqual(readCellValue(line, CARD3, 1), '123');
        assert.strictEqual(readCellValue(line, CARD3, 2), '67890');
        assert.strictEqual(guard.getNav().fieldIndex, 1);
    });

    it('rejects an over-width multi-character A input without truncating it', () => {
        const line = buildLine('1', '2', '3');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(document, 1, 1, true);

        const plan = guard.planType(
            document,
            {
                start: { line: 1, character: 11 },
                end: { line: 1, character: 20 },
                isEmpty: false,
            },
            '12345678901',
        );

        assert.deepStrictEqual(plan, { blocked: true });
        assert.strictEqual(document.lineAt(1).text, line);
    });

    it('rejects an Ap append that would exceed the field width', () => {
        const line = buildLine('1', '123456789', '3');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markAp(document, 1, 1);

        const plan = guard.planType(
            document,
            {
                start: { line: 1, character: 20 },
                end: { line: 1, character: 20 },
                isEmpty: true,
            },
            'XY',
        );

        assert.deepStrictEqual(plan, { blocked: true });
        assert.strictEqual(document.lineAt(1).text, line);
    });

    it('hands a rapid cross-field Ap selection back to native typing', () => {
        const line = buildLine('1', '1234', '3');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markAp(document, 1, 1, 18);

        const plan = guard.planType(
            document,
            {
                start: { line: 1, character: 5 },
                end: { line: 1, character: 18 },
                isEmpty: false,
            },
            'X',
        );

        assert.strictEqual(plan, null);
        assert.strictEqual(document.lineAt(1).text, line);
    });

    it('repairs a native paste over an A selection without shifting later fields', () => {
        const originalLine = buildLine('1', '2', '3');
        const before = fakeDoc(['*NODE', originalLine]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(before, 1, 1, true);

        const pastedLine = originalLine.slice(0, 11) + '9.5' + originalLine.slice(20);
        const after = fakeDoc(['*NODE', pastedLine]);
        after.version = 2;
        const plan = guard.planPostEditCorrection(after, [{
            range: {
                start: { line: 1, character: 11 },
                end: { line: 1, character: 20 },
            },
            rangeLength: 9,
            text: '9.5',
        }]);

        assert.ok(plan);
        assert.strictEqual(plan.blocked, false);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '9.5');
        assert.strictEqual(plan.newText.slice(20), originalLine.slice(20));
        assert.strictEqual(guard.getNav(), null);
    });

    it('rejects an over-width A paste and preserves the captured pre-edit line', () => {
        const originalLine = buildLine('1', '2', '3');
        const before = fakeDoc(['*NODE', originalLine]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(before, 1, 1, true);

        const pasted = '12345678901';
        const pastedLine = originalLine.slice(0, 11) + pasted + originalLine.slice(20);
        const after = fakeDoc(['*NODE', pastedLine]);
        after.version = 2;
        const plan = guard.planPostEditCorrection(after, [{
            range: {
                start: { line: 1, character: 11 },
                end: { line: 1, character: 20 },
            },
            rangeLength: 9,
            text: pasted,
        }]);

        assert.ok(plan);
        assert.strictEqual(plan.blocked, true);
        assert.strictEqual(plan.originalText, originalLine);
        assert.strictEqual(plan.newText, originalLine);
        assert.strictEqual(plan.restoreMode, 'A');
    });

    it('rejects a multiline A paste and preserves the captured pre-edit line', () => {
        const originalLine = buildLine('1', '2', '3');
        const before = fakeDoc(['*NODE', originalLine]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(before, 1, 1, true);

        const after = fakeDoc([
            '*NODE',
            originalLine.slice(0, 11) + '9',
            '5' + originalLine.slice(20),
        ]);
        after.version = 2;
        const plan = guard.planPostEditCorrection(after, [{
            range: {
                start: { line: 1, character: 11 },
                end: { line: 1, character: 20 },
            },
            rangeLength: 9,
            text: '9\n5',
        }]);

        assert.ok(plan);
        assert.strictEqual(plan.blocked, true);
        assert.strictEqual(plan.originalText, originalLine);
        assert.strictEqual(plan.newText, originalLine);
    });

    it('fails closed for multiple changes, stale versions, or a range outside the nav selection', () => {
        const originalLine = buildLine('1', '2', '3');
        const makeGuard = () => {
            const guard = createCardCellEditGuard({
                getCardFieldsForLine: () => CARD3,
                isLsdynaDocument: () => true,
                isKeywordLineText: (t) => /^\s*\*/.test(t),
                isProtectEnabled: () => true,
            });
            const before = fakeDoc(['*NODE', originalLine]);
            guard.markA(before, 1, 1, true);
            return guard;
        };
        const change = {
            range: {
                start: { line: 1, character: 11 },
                end: { line: 1, character: 20 },
            },
            rangeLength: 9,
            text: '9',
        };

        const multipleGuard = makeGuard();
        const multipleDoc = fakeDoc(['*NODE', originalLine]);
        multipleDoc.version = 2;
        assert.strictEqual(
            multipleGuard.planPostEditCorrection(multipleDoc, [change, change]),
            null,
        );
        assert.strictEqual(multipleGuard.getNav(), null);

        const staleGuard = makeGuard();
        const staleDoc = fakeDoc(['*NODE', originalLine]);
        staleDoc.version = 3;
        assert.strictEqual(staleGuard.planPostEditCorrection(staleDoc, [change]), null);
        assert.strictEqual(staleGuard.getNav(), null);

        const movedGuard = makeGuard();
        const movedDoc = fakeDoc(['*NODE', originalLine]);
        movedDoc.version = 2;
        assert.strictEqual(movedGuard.planPostEditCorrection(movedDoc, [{
            ...change,
            range: {
                start: { line: 1, character: 12 },
                end: { line: 1, character: 20 },
            },
        }]), null);
        assert.strictEqual(movedGuard.getNav(), null);
    });

    it('does not consume navigation state for a metadata-only document event', () => {
        const originalLine = buildLine('1', '2', '3');
        const document = fakeDoc(['*NODE', originalLine]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(document, 1, 1, true);

        assert.strictEqual(guard.planPostEditCorrection(document, []), null);
        assert.ok(guard.getNav());
        assert.strictEqual(guard.getNav().mode, 'A');
    });

    it('does not consume a newer nav mark when an establishing edit event arrives late', () => {
        const originalLine = buildLine('1', '2', '3');
        const document = fakeDoc(['*NODE', originalLine]);
        document.version = 4;
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(document, 1, 1, true);

        assert.strictEqual(guard.planPostEditCorrection(document, [{
            range: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: originalLine.length },
            },
            rangeLength: originalLine.length,
            text: originalLine,
        }]), null);
        assert.ok(guard.getNav());
        assert.strictEqual(guard.getNav().version, 4);
    });

    it('does not reinterpret an undo change as a native paste or cut', () => {
        const originalLine = buildLine('1', '2', '3');
        const editedLine = buildLine('1', '9.5', '3');
        const beforeUndo = fakeDoc(['*NODE', editedLine]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markAp(beforeUndo, 1, 1, 20);

        const afterUndo = fakeDoc(['*NODE', originalLine]);
        afterUndo.version = 2;
        assert.strictEqual(guard.planPostEditCorrection(afterUndo, [{
            range: {
                start: { line: 1, character: 17 },
                end: { line: 1, character: 20 },
            },
            rangeLength: 3,
            text: '  2',
        }], 1), null);
        assert.strictEqual(guard.getNav(), null);
    });

    it('repairs an Ap caret paste by appending inside the same field', () => {
        const originalLine = buildLine('1', '12', '3');
        const before = fakeDoc(['*NODE', originalLine]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markAp(before, 1, 1);
        const caret = 20;

        const pastedLine = originalLine.slice(0, caret) + '34' + originalLine.slice(caret);
        const after = fakeDoc(['*NODE', pastedLine]);
        after.version = 2;
        const plan = guard.planPostEditCorrection(after, [{
            range: {
                start: { line: 1, character: caret },
                end: { line: 1, character: caret },
            },
            rangeLength: 0,
            text: '34',
        }]);

        assert.ok(plan);
        assert.strictEqual(plan.blocked, false);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '1234');
        assert.strictEqual(readCellValue(plan.newText, CARD3, 2), '3');
    });

    it('repairs an Ap paste at the exact mid-value caret captured by the host', () => {
        const originalLine = buildLine('1', '1234', '3');
        const before = fakeDoc(['*NODE', originalLine]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        const caret = 18;
        guard.markAp(before, 1, 1, caret);

        const pastedLine = originalLine.slice(0, caret) + 'X' + originalLine.slice(caret);
        const after = fakeDoc(['*NODE', pastedLine]);
        after.version = 2;
        const plan = guard.planPostEditCorrection(after, [{
            range: {
                start: { line: 1, character: caret },
                end: { line: 1, character: caret },
            },
            rangeLength: 0,
            text: 'X',
        }]);

        assert.ok(plan);
        assert.strictEqual(plan.blocked, false);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '12X34');
        assert.strictEqual(readCellValue(plan.newText, CARD3, 2), '3');
    });

    it('tracks an Ap in-cell selection and replaces it without shifting neighbors', () => {
        const originalLine = buildLine('1', '1234', '3');
        const before = fakeDoc(['*NODE', originalLine]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markAp(before, 1, 1);
        guard.onSelectionChange({
            document: before,
            selection: {
                start: { line: 1, character: 17 },
                end: { line: 1, character: 19 },
                isEmpty: false,
            },
            selections: [{}],
        });
        assert.strictEqual(guard.getNav().expectedStart, 17);
        assert.strictEqual(guard.getNav().expectedEnd, 19);

        const pastedLine = originalLine.slice(0, 17) + 'X' + originalLine.slice(19);
        const after = fakeDoc(['*NODE', pastedLine]);
        after.version = 2;
        const plan = guard.planPostEditCorrection(after, [{
            range: {
                start: { line: 1, character: 17 },
                end: { line: 1, character: 19 },
            },
            rangeLength: 2,
            text: 'X',
        }]);

        assert.ok(plan);
        assert.strictEqual(plan.blocked, false);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '1X4');
        assert.strictEqual(readCellValue(plan.newText, CARD3, 2), '3');
    });

    it('repairs an Ap cut by clearing only the selected value characters', () => {
        const originalLine = buildLine('1', '1234', '3');
        const before = fakeDoc(['*NODE', originalLine]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markAp(before, 1, 1);
        guard.onSelectionChange({
            document: before,
            selection: {
                start: { line: 1, character: 17 },
                end: { line: 1, character: 19 },
                isEmpty: false,
            },
            selections: [{}],
        });

        const cutLine = originalLine.slice(0, 17) + originalLine.slice(19);
        const after = fakeDoc(['*NODE', cutLine]);
        after.version = 2;
        const plan = guard.planPostEditCorrection(after, [{
            range: {
                start: { line: 1, character: 17 },
                end: { line: 1, character: 19 },
            },
            rangeLength: 2,
            text: '',
        }]);

        assert.ok(plan);
        assert.strictEqual(plan.blocked, false);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '14');
        assert.strictEqual(readCellValue(plan.newText, CARD3, 2), '3');
    });

    it('repairs a rapid Ap cut from its in-cell change range before selection sync', () => {
        const originalLine = buildLine('1', '1234', '3');
        const before = fakeDoc(['*NODE', originalLine]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markAp(before, 1, 1);

        const cutLine = originalLine.slice(0, 17) + originalLine.slice(19);
        const after = fakeDoc(['*NODE', cutLine]);
        after.version = 2;
        const plan = guard.planPostEditCorrection(after, [{
            range: {
                start: { line: 1, character: 17 },
                end: { line: 1, character: 19 },
            },
            rangeLength: 2,
            text: '',
        }]);

        assert.ok(plan);
        assert.strictEqual(plan.blocked, false);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '14');
        assert.strictEqual(readCellValue(plan.newText, CARD3, 2), '3');
    });

    it('rejects a rapid Ap native edit outside the marked field or with mismatched post-edit text', () => {
        const originalLine = buildLine('1', '1234', '345');
        const makeGuard = () => {
            const before = fakeDoc(['*NODE', originalLine]);
            const guard = createCardCellEditGuard({
                getCardFieldsForLine: () => CARD3,
                isLsdynaDocument: () => true,
                isKeywordLineText: (t) => /^\s*\*/.test(t),
                isProtectEnabled: () => true,
            });
            guard.markAp(before, 1, 1);
            return guard;
        };

        const outsideGuard = makeGuard();
        const outsideLine = originalLine.slice(0, 21) + originalLine.slice(22);
        const outsideDoc = fakeDoc(['*NODE', outsideLine]);
        outsideDoc.version = 2;
        assert.strictEqual(outsideGuard.planPostEditCorrection(outsideDoc, [{
            range: {
                start: { line: 1, character: 21 },
                end: { line: 1, character: 22 },
            },
            rangeLength: 1,
            text: '',
        }]), null);

        const mismatchGuard = makeGuard();
        const mismatchDoc = fakeDoc(['*NODE', originalLine.slice(0, 17) + originalLine.slice(19) + 'X']);
        mismatchDoc.version = 2;
        assert.strictEqual(mismatchGuard.planPostEditCorrection(mismatchDoc, [{
            range: {
                start: { line: 1, character: 17 },
                end: { line: 1, character: 19 },
            },
            rangeLength: 2,
            text: '',
        }]), null);
    });

    it('A+D: empty space-wall row Delete plans line removal to prev last field', () => {
        const prev = buildLine('1', '2', '3');
        const empty = buildLine('', '', '');
        const document = fakeDoc(['*SET_SEGMENT', prev, empty]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        // Caret anywhere on empty row (nav A on last field of empty row)
        guard.markA(document, 2, 2, true);
        const plan = guard.planDelete(
            document,
            {
                start: { line: 2, character: 20 },
                end: { line: 2, character: 30 },
                isEmpty: false,
            },
            'right',
        );
        assert.ok(plan);
        assert.strictEqual(plan.deleteLine, true);
        assert.strictEqual(plan.lineNum, 2);
        assert.strictEqual(plan.targetLine, 1);
        assert.ok(plan.markA);
        assert.strictEqual(plan.markA.fieldIndex, 2);
        // Last field of CARD3 is [20, 30); keep-separator starts at 21 when prev field has value
        assert.strictEqual(plan.selEnd, 30);
        assert.ok(plan.selStart === 20 || plan.selStart === 21);
    });

    it('A+D: empty row Backspace also deletes the line', () => {
        const prev = buildLine('10', '20', '30');
        const empty = '                              '; // space wall
        const document = fakeDoc(['*NODE', prev, empty]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        const plan = guard.planDelete(
            document,
            {
                start: { line: 2, character: 5 },
                end: { line: 2, character: 5 },
                isEmpty: true,
            },
            'left',
        );
        assert.ok(plan);
        assert.strictEqual(plan.deleteLine, true);
        assert.strictEqual(plan.targetLine, 1);
        assert.strictEqual(plan.markA.fieldIndex, 2);
    });

    it('A+D: whole-line selection falls through (null plan)', () => {
        const line = buildLine('1', '2', '3');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        const plan = guard.planDelete(
            document,
            {
                start: { line: 1, character: 0 },
                end: { line: 1, character: line.length },
                isEmpty: false,
            },
            'right',
        );
        assert.strictEqual(plan, null);
    });

    it('A+D: non-empty row still clears cell (does not delete line)', () => {
        const line = buildLine('1', '', '3');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(document, 1, 1, true);
        const plan = guard.planDelete(
            document,
            {
                start: { line: 1, character: 11 },
                end: { line: 1, character: 20 },
                isEmpty: false,
            },
            'right',
        );
        assert.ok(plan);
        assert.ok(!plan.deleteLine);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 0), '1');
        assert.strictEqual(readCellValue(plan.newText, CARD3, 2), '3');
    });

    it('A+D: empty first data line deletes with caret to line 0 start', () => {
        const empty = buildLine('', '', '');
        const document = fakeDoc([empty]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: (doc, n) => (n === 0 ? CARD3 : null),
            isLsdynaDocument: () => true,
            isKeywordLineText: () => false,
            isProtectEnabled: () => true,
        });
        const plan = guard.planDelete(
            document,
            { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true },
            'right',
        );
        assert.ok(plan);
        assert.strictEqual(plan.deleteLine, true);
        assert.strictEqual(plan.targetLine, 0);
        assert.strictEqual(plan.clearNav, true);
    });

    it('Backspace on last field value shortens (not stuck / not line-delete)', () => {
        const line = buildLine('1', '2', '99');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        // Caret after value in last field (Ap path) — exclusive end of "99" R1 in [20,30]
        guard.markAp(document, 1, 2);
        const caret = 30; // after last digit (may equal field exclusive end)
        const plan = guard.planDelete(
            document,
            { start: { line: 1, character: caret }, end: { line: 1, character: caret }, isEmpty: true },
            'left',
        );
        assert.ok(plan);
        assert.ok(!plan.deleteLine);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 2), '9');
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '2');
        assert.strictEqual(plan.markAp, true);
        // Caret after remaining digit — char to the left of caret is that digit
        assert.strictEqual(plan.newText[plan.selStart - 1], '9');
    });

    it('Backspace on empty last field jumps to previous field A', () => {
        const line = buildLine('1', '2', '');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        const plan = guard.planDelete(
            document,
            { start: { line: 1, character: 25 }, end: { line: 1, character: 25 }, isEmpty: true },
            'left',
        );
        assert.ok(plan);
        assert.ok(!plan.deleteLine);
        assert.ok(plan.markA);
        assert.strictEqual(plan.markA.fieldIndex, 1);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '2');
    });

    it('Backspace at next-field start deletes previous field last digit (visual after-value)', () => {
        // R1: after typing in middle field, exclusive end caret sits at next field start.
        // User sees "I finished this number"; BS must not eat the next field.
        const line = buildLine('1', '99', '3');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        // Caret at col 20 = start of field 2, no nav pin
        const plan = guard.planDelete(
            document,
            { start: { line: 1, character: 20 }, end: { line: 1, character: 20 }, isEmpty: true },
            'left',
        );
        assert.ok(plan);
        assert.ok(!plan.deleteLine);
        assert.strictEqual(readCellValue(plan.newText, CARD3, 1), '9');
        assert.strictEqual(readCellValue(plan.newText, CARD3, 2), '3');
        assert.strictEqual(plan.fieldIndex, 1);
        assert.strictEqual(plan.markAp, true);
    });

    it('A clear then Backspace on non-empty-row jumps prev (does not stuck-clear)', () => {
        // Only last field empty after clear; row still has values → jump prev, not line delete
        const line = buildLine('1', '2', '');
        const document = fakeDoc(['*NODE', line]);
        const guard = createCardCellEditGuard({
            getCardFieldsForLine: () => CARD3,
            isLsdynaDocument: () => true,
            isKeywordLineText: (t) => /^\s*\*/.test(t),
            isProtectEnabled: () => true,
        });
        guard.markA(document, 1, 2, true);
        const plan = guard.planDelete(
            document,
            {
                start: { line: 1, character: 21 },
                end: { line: 1, character: 30 },
                isEmpty: false,
            },
            'left',
        );
        assert.ok(plan);
        assert.ok(!plan.deleteLine);
        assert.ok(plan.markA);
        assert.strictEqual(plan.markA.fieldIndex, 1);
    });

    describe('free-format (comma) lines fall through to default editor', () => {
        const guardFor = (document) =>
            createCardCellEditGuard({
                getCardFieldsForLine: () => CARD3,
                isLsdynaDocument: () => true,
                isKeywordLineText: (t) => /^\s*\*/.test(t),
                isProtectEnabled: () => true,
            });

        it('planDelete returns null on a comma line (no R1 rewrite)', () => {
            const document = fakeDoc(['*NODE', '100,200,300']);
            const guard = guardFor(document);
            const plan = guard.planDelete(
                document,
                { start: { line: 1, character: 5 }, end: { line: 1, character: 5 }, isEmpty: true },
                'left',
            );
            assert.strictEqual(plan, null);
        });

        it('shouldCellEditActive is false on a comma line', () => {
            const document = fakeDoc(['*NODE', '100,200,300']);
            const guard = guardFor(document);
            const active = guard.shouldCellEditActive({
                document,
                selection: {
                    start: { line: 1, character: 5 },
                    end: { line: 1, character: 5 },
                    isEmpty: true,
                },
                selections: [{}],
            });
            assert.strictEqual(active, false);
        });

        it('planType returns null on a comma line even after markA', () => {
            const document = fakeDoc(['*NODE', '100,200,300']);
            const guard = guardFor(document);
            guard.markA(document, 1, 1, true);
            const plan = guard.planType(
                document,
                { start: { line: 1, character: 4 }, end: { line: 1, character: 7 }, isEmpty: false },
                '9',
            );
            assert.strictEqual(plan, null);
        });

        it('intact fixed-column line still protected (regression)', () => {
            const line = buildLine('1', '2', '3');
            const document = fakeDoc(['*NODE', line]);
            const guard = guardFor(document);
            const active = guard.shouldCellEditActive({
                document,
                selection: {
                    start: { line: 1, character: 5 },
                    end: { line: 1, character: 5 },
                    isEmpty: true,
                },
                selections: [{}],
            });
            assert.strictEqual(active, true);
        });
    });

    describe('unsafe schema geometry falls through to the default editor', () => {
        const OVERLAPPING_CARD = [
            { n: 'A', p: 0, w: 10 },
            { n: 'B', p: 0, w: 10 },
        ];

        it('does not activate or type over an overlapping field layout', () => {
            const document = fakeDoc(['*CONTROL_CPU', '         1']);
            const guard = createCardCellEditGuard({
                getCardFieldsForLine: () => OVERLAPPING_CARD,
                isLsdynaDocument: () => true,
                isKeywordLineText: (t) => /^\s*\*/.test(t),
                isProtectEnabled: () => true,
            });
            const selection = {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 10 },
                isEmpty: false,
            };

            assert.strictEqual(guard.getCardIfCellLine(document, 1), null);
            assert.strictEqual(guard.shouldCellEditActive({
                document,
                selection,
                selections: [selection],
            }), false);

            guard.markA(document, 1, 0, false);
            assert.strictEqual(guard.planType(document, selection, '9'), null);
        });
    });
});
