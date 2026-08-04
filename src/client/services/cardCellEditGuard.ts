'use strict';

/**
 * @fileoverview VS Code-facing cell edit guard: nav A/A′ state + delete handlers.
 * @module client/services/cardCellEditGuard
 *
 * Pure math lives in core/edit/cardCellModel; this module tracks editor state and
 * plans Delete/Backspace cell clears. planType intercepts typing only when nav is
 * A/Ap (Tab / SelectCell established). No nav → never type-over (strict A-gate).
 */

const cellModel = require('../../core/edit/cardCellModel');

export type CardField = {
    n?: string;
    p: number;
    w: number;
    t?: string;
};

export type NavMode = 'A' | 'Ap';

export type NavCellState = {
    uri: string;
    line: number;
    fieldIndex: number;
    version: number;
    mode: NavMode;
    /** Keep-separator visual was used for this nav. */
    keepSeparator: boolean;
    /** Exact line and native selection/caret captured when navigation was established. */
    originalLine: string;
    expectedStart: number;
    expectedEnd: number;
};

export type CardCellEditGuardDeps = {
    getCardFieldsForLine: (document: any, lineNum: number) => CardField[] | null | undefined;
    isLsdynaDocument?: (document: any) => boolean;
    isKeywordLineText?: (text: string) => boolean;
    isTextCardLine?: (document: any, lineNum: number) => boolean;
    /** When false, never intercept. */
    isProtectEnabled?: (document?: any) => boolean;
    /** Optional: skip when completion UI is open. */
    isSuggestVisible?: () => boolean;
};

function uriKey(document: any): string {
    try {
        return document?.uri?.toString?.() || document?.uri?.fsPath || String(document?.fileName || '');
    } catch {
        return '';
    }
}

function lineSelFromSelection(selection: any): {
    startChar: number;
    endChar: number;
    isEmpty: boolean;
    startLine: number;
    endLine: number;
} {
    const start = selection.start;
    const end = selection.end;
    const a = start.character;
    const b = end.character;
    const isEmpty = !!(selection.isEmpty || (start.line === end.line && a === b));
    return {
        startChar: Math.min(a, b),
        endChar: Math.max(a, b),
        isEmpty,
        startLine: start.line,
        endLine: end.line,
    };
}

/**
 * Create a cell-edit guard bound to host deps.
 */
export function createCardCellEditGuard(deps: CardCellEditGuardDeps) {
    let nav: NavCellState | null = null;

    function clearNav() {
        nav = null;
    }

    function markA(document: any, line: number, fieldIndex: number, keepSeparator: boolean) {
        if (!document) return;
        const originalLine = String(document.lineAt(line).text || '');
        const card = deps.getCardFieldsForLine(document, line) || [];
        const previousFieldHasValue =
            fieldIndex > 0 && fieldIndex < card.length
                ? cellModel.readCellValue(originalLine, card, fieldIndex - 1).length > 0
                : false;
        const range = cellModel.navSelectionRange(card, fieldIndex, {
            keepSeparator: !!keepSeparator,
            previousFieldHasValue,
        });
        nav = {
            uri: uriKey(document),
            line,
            fieldIndex,
            version: document.version,
            mode: 'A',
            keepSeparator: !!keepSeparator,
            originalLine,
            expectedStart: range?.start ?? -1,
            expectedEnd: range?.end ?? -1,
        };
    }

    function markAp(document: any, line: number, fieldIndex: number, caretCol?: number) {
        if (!document) return;
        const originalLine = String(document.lineAt(line).text || '');
        const card = deps.getCardFieldsForLine(document, line) || [];
        let caret = -1;
        if (Number.isSafeInteger(caretCol)) {
            caret = Number(caretCol);
        } else if (fieldIndex >= 0 && fieldIndex < card.length) {
            caret = cellModel.caretAfterCellValue(originalLine, card, fieldIndex);
        }
        nav = {
            uri: uriKey(document),
            line,
            fieldIndex,
            version: document.version,
            mode: 'Ap',
            keepSeparator: false,
            originalLine,
            expectedStart: caret,
            expectedEnd: caret,
        };
    }

    function getNav(): NavCellState | null {
        return nav;
    }

    function navMatches(document: any, line: number): boolean {
        if (!nav || !document) return false;
        return nav.uri === uriKey(document) &&
            nav.line === line &&
            nav.version === document.version;
    }

    type PostEditCorrectionPlan = {
        blocked: boolean;
        lineNum: number;
        fieldIndex: number;
        postEditVersion: number;
        originalText: string;
        newText: string;
        caret: number;
        restoreMode: NavMode;
        keepSeparator: boolean;
        restoreStart: number;
        restoreEnd: number;
    };

    /**
     * Plan a conservative repair after VS Code performs a native paste/cut over
     * a Tab-established selection. The event range uses pre-edit coordinates,
     * while `document` already contains the native result.
     *
     * A subsequent same-document text version consumes the old nav mark. Only
     * One exact A range is accepted. A-prime also accepts the event's exact
     * in-cell range so rapid selection→cut/paste does not depend on a queued
     * selection event; cross-field and ambiguous changes fail closed.
     */
    function planPostEditCorrection(
        document: any,
        contentChanges: any[],
        changeReason?: unknown,
    ): PostEditCorrectionPlan | null {
        if (!nav || !document) return null;
        if (nav.uri !== uriKey(document)) return null;
        // VS Code also emits metadata-only document events with no text changes.
        // They must not consume a valid navigation mark.
        if (!Array.isArray(contentChanges) || contentChanges.length === 0) return null;
        // A queued event from the edit that established the current nav can be
        // delivered after markA/markAp. A real subsequent text edit must advance
        // the document version.
        if (document.version === nav.version) return null;

        const captured = nav;
        clearNav();

        // VS Code marks undo/redo document events with a reason. Those changes
        // belong to the user's undo stack and must never be mistaken for a new
        // native paste/cut that needs a corrective undo of its own.
        if (changeReason !== undefined && changeReason !== null) return null;
        if (!isEligibleDocument(document)) return null;
        if (document.version !== captured.version + 1) return null;
        if (contentChanges.length !== 1) return null;
        if (captured.expectedStart < 0 || captured.expectedEnd < captured.expectedStart) return null;

        const change = contentChanges[0];
        const range = change?.range;
        if (!range?.start || !range?.end) return null;
        if (range.start.line !== captured.line || range.end.line !== captured.line) return null;
        const changeStart = range.start.character;
        const changeEnd = range.end.character;
        if (
            typeof change.rangeLength === 'number' &&
            change.rangeLength !== changeEnd - changeStart
        ) {
            return null;
        }

        const card = deps.getCardFieldsForLine(document, captured.line);
        if (!card || captured.fieldIndex < 0 || captured.fieldIndex >= card.length) return null;
        if (cellModel.classifyGrid(captured.originalLine, card) !== 'intact') return null;

        const f = card[captured.fieldIndex];
        const insertedText = typeof change.text === 'string' ? change.text : '';
        const exactCapturedRange =
            changeStart === captured.expectedStart &&
            changeEnd === captured.expectedEnd;
        let effectiveStart = captured.expectedStart;
        let effectiveEnd = captured.expectedEnd;
        if (!exactCapturedRange) {
            // A selection is authoritative only while it still exactly matches the
            // Tab-established range. A-prime may receive a native cut/paste before
            // VS Code publishes the corresponding selection event; accept only the
            // event's exact range wholly inside the already-marked field.
            if (
                captured.mode !== 'Ap' ||
                changeStart < f.p ||
                changeStart >= f.p + f.w ||
                changeEnd < changeStart ||
                changeEnd > f.p + f.w
            ) {
                return null;
            }
            effectiveStart = changeStart;
            effectiveEnd = changeEnd;
        }
        const insertedLines = insertedText.split(/\r\n|\r|\n/);
        const containsLineBreak = insertedLines.length > 1;
        const expectedNativeLines = containsLineBreak
            ? [
                captured.originalLine.slice(0, effectiveStart) + insertedLines[0],
                ...insertedLines.slice(1, -1),
                insertedLines[insertedLines.length - 1] + captured.originalLine.slice(effectiveEnd),
            ]
            : [
                captured.originalLine.slice(0, effectiveStart) +
                insertedText +
                captured.originalLine.slice(effectiveEnd),
            ];
        if (captured.line + expectedNativeLines.length > document.lineCount) return null;
        for (let index = 0; index < expectedNativeLines.length; index++) {
            if (String(document.lineAt(captured.line + index).text || '') !== expectedNativeLines[index]) {
                return null;
            }
        }

        const containsUnsafeControl = /[\t\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(insertedText);
        let insertionBase = captured.originalLine;
        let insertionCaret = effectiveStart;
        if (captured.mode === 'Ap' && effectiveEnd > effectiveStart) {
            const afterDelete = cellModel.applyInCellDelete(
                captured.originalLine,
                card,
                captured.fieldIndex,
                {
                    startChar: effectiveStart,
                    endChar: effectiveEnd,
                    isEmpty: false,
                },
                'right',
            );
            if (!afterDelete) return null;
            insertionBase = afterDelete.line;
            insertionCaret = afterDelete.caretCol;
        }
        const existingValue = cellModel.readCellValue(
            insertionBase,
            card,
            captured.fieldIndex,
        );
        const overWidth =
            captured.mode === 'A'
                ? insertedText.length > f.w
                : existingValue.length + insertedText.length > f.w;
        const blocked = containsLineBreak || containsUnsafeControl || overWidth;

        if (blocked) {
            return {
                blocked: true,
                lineNum: captured.line,
                fieldIndex: captured.fieldIndex,
                postEditVersion: document.version,
                originalText: captured.originalLine,
                newText: captured.originalLine,
                caret: effectiveStart,
                restoreMode: captured.mode,
                keepSeparator: captured.keepSeparator,
                restoreStart: effectiveStart,
                restoreEnd: effectiveEnd,
            };
        }

        let safeLine: string;
        let caret: number;
        if (captured.mode === 'A') {
            safeLine = cellModel.writeCellR1(
                captured.originalLine,
                card,
                captured.fieldIndex,
                insertedText,
            );
            caret = cellModel.caretAfterCellValue(safeLine, card, captured.fieldIndex);
        } else {
            if (!insertedText) {
                safeLine = insertionBase;
                caret = insertionCaret;
            } else {
                const inserted = cellModel.applyInCellInsert(
                    insertionBase,
                    card,
                    captured.fieldIndex,
                    insertionCaret,
                    insertedText,
                );
                if (!inserted) return null;
                safeLine = inserted.line;
                caret = inserted.caretCol;
            }
        }

        return {
            blocked: false,
            lineNum: captured.line,
            fieldIndex: captured.fieldIndex,
            postEditVersion: document.version,
            originalText: captured.originalLine,
            newText: safeLine,
            caret,
            restoreMode: 'Ap',
            keepSeparator: false,
            restoreStart: caret,
            restoreEnd: caret,
        };
    }

    function isEligibleDocument(document: any): boolean {
        if (!document) return false;
        if (deps.isLsdynaDocument && !deps.isLsdynaDocument(document)) return false;
        if (deps.isProtectEnabled && !deps.isProtectEnabled(document)) return false;
        return true;
    }

    function getCardIfCellLine(document: any, lineNum: number): CardField[] | null {
        if (!isEligibleDocument(document)) return null;
        if (lineNum < 0 || lineNum >= document.lineCount) return null;
        const text = document.lineAt(lineNum).text;
        const trimmed = text.trimStart();
        if (deps.isKeywordLineText && deps.isKeywordLineText(text)) return null;
        if (deps.isTextCardLine && deps.isTextCardLine(document, lineNum)) return null;
        if (trimmed.startsWith('$')) return null;
        const card = deps.getCardFieldsForLine(document, lineNum);
        if (!card || card.length === 0) return null;
        if (card.length === 1 && card[0].w >= 40) return null;
        // Only an unambiguous, intact fixed-column grid is safe for slice editing.
        // Free-format, overflow, long-format, and overlapping/conditional schema
        // geometries are handed back to the default editor without a guessed rewrite.
        if (cellModel.classifyGrid(text, card) !== 'intact') return null;
        return card;
    }

    /**
     * Whether context key lsdyna.cellEditActive should be true for current selection.
     */
    function shouldCellEditActive(editor: any): boolean {
        if (!editor || !editor.document || !editor.selection) return false;
        if (!isEligibleDocument(editor.document)) return false;
        if (editor.selections && editor.selections.length > 1) return false;
        const sel = lineSelFromSelection(editor.selection);
        if (sel.startLine !== sel.endLine) return false;
        const card = getCardIfCellLine(editor.document, sel.startLine);
        if (!card) return false;
        const line = editor.document.lineAt(sel.startLine).text;
        const classified = cellModel.classifySelection(
            line,
            card,
            { startChar: sel.startChar, endChar: sel.endChar, isEmpty: sel.isEmpty },
            {
                navKeepSeparator: true,
                afterFirstKey: navMatches(editor.document, sel.startLine) && nav?.mode === 'Ap',
                multiLine: false,
                multiCursor: false,
            },
        );
        return classified.kind !== 'E';
    }

    /**
     * Sync nav state after selection change: demote A if selection no longer matches.
     */
    function onSelectionChange(editor: any) {
        if (!nav || !editor?.document) return;
        if (uriKey(editor.document) !== nav.uri) {
            clearNav();
            return;
        }
        if (editor.document.version !== nav.version) {
            clearNav();
            return;
        }
        if (editor.selections && editor.selections.length > 1) {
            clearNav();
            return;
        }
        const sel = lineSelFromSelection(editor.selection);
        if (sel.startLine !== nav.line || sel.endLine !== nav.line) {
            clearNav();
            return;
        }
        if (nav.mode === 'Ap') {
            // Stay Ap while caret remains in the same logical cell.
            // R1 places caret at the right edge; exclusive end p+w is also the next
            // field start — treat [p, p+w] inclusive so multi-digit typing does not jump.
            const card = getCardIfCellLine(editor.document, nav.line);
            if (!card) {
                clearNav();
                return;
            }
            const f = card[nav.fieldIndex];
            if (!f) {
                clearNav();
                return;
            }
            // Inclusive p+w: exclusive end after a full-width / R1 value is the natural
            // "after last digit" caret and must keep Ap on this field (not jump to next).
            if (sel.startChar >= f.p && sel.endChar <= f.p + f.w) {
                nav.expectedStart = sel.startChar;
                nav.expectedEnd = sel.endChar;
                return;
            }
            clearNav();
            return;
        }
        // mode A: keep if still full/keep-separator on same field
        const card = getCardIfCellLine(editor.document, nav.line);
        if (!card) {
            clearNav();
            return;
        }
        const line = editor.document.lineAt(nav.line).text;
        const classified = cellModel.classifySelection(
            line,
            card,
            { startChar: sel.startChar, endChar: sel.endChar, isEmpty: sel.isEmpty },
            { navKeepSeparator: true },
        );
        if (classified.kind !== 'A' || classified.fieldIndex !== nav.fieldIndex) {
            // User collapsed selection → leave pure geometry B/C without nav mark
            clearNav();
        }
    }

    /**
     * Whole-line selection (A+D): fall through so the editor can delete the line.
     * Multi-line is already rejected by the caller; this covers single-line full select.
     */
    function isWholeLineSelection(sel: ReturnType<typeof lineSelFromSelection>, lineText: string): boolean {
        if (sel.isEmpty) return false;
        const len = String(lineText || '').length;
        return sel.startChar <= 0 && sel.endChar >= len;
    }

    /**
     * Empty card row + Delete/Backspace → remove the line and land on the previous
     * line's last field (LS-DYNA card habit; A+D).
     */
    function planEmptyRowLineDelete(
        document: any,
        lineNum: number,
    ): null | {
        lineNum: number;
        deleteLine: true;
        newText: string;
        selStart: number;
        selEnd: number;
        targetLine: number;
        markA?: { fieldIndex: number; keepSeparator: boolean };
        clearNav?: boolean;
    } {
        if (lineNum < 0 || lineNum >= document.lineCount) return null;

        const targetLine = Math.max(0, lineNum - 1);
        // Deleting the only / first line: caret stays at start of what becomes line 0.
        if (lineNum === 0) {
            return {
                lineNum,
                deleteLine: true,
                newText: '',
                selStart: 0,
                selEnd: 0,
                targetLine: 0,
                clearNav: true,
            };
        }

        const prevCard = getCardIfCellLine(document, targetLine);
        const prevText = document.lineAt(targetLine).text;
        if (prevCard && prevCard.length > 0) {
            const lastFi = prevCard.length - 1;
            const keepSeparator = lastFi > 0;
            const previousFieldHasValue =
                lastFi > 0 ? cellModel.readCellValue(prevText, prevCard, lastFi - 1).length > 0 : false;
            const range = cellModel.navSelectionRange(prevCard, lastFi, {
                keepSeparator,
                previousFieldHasValue,
            });
            return {
                lineNum,
                deleteLine: true,
                newText: '',
                selStart: range?.start ?? prevCard[lastFi].p,
                selEnd: range?.end ?? prevCard[lastFi].p + prevCard[lastFi].w,
                targetLine,
                markA: { fieldIndex: lastFi, keepSeparator },
            };
        }

        // Previous line is not a multi-field card (keyword / comment / free text).
        const end = String(prevText || '').length;
        return {
            lineNum,
            deleteLine: true,
            newText: '',
            selStart: end,
            selEnd: end,
            targetLine,
            clearNav: true,
        };
    }

    /**
     * Select a field in A-nav style (keep-separator when useful).
     */
    function planSelectFieldA(
        lineNum: number,
        lineText: string,
        card: CardField[],
        fieldIndex: number,
    ): {
        lineNum: number;
        newText: string;
        selStart: number;
        selEnd: number;
        markA: { fieldIndex: number; keepSeparator: boolean };
    } {
        const keepSeparator = fieldIndex > 0;
        const previousFieldHasValue =
            fieldIndex > 0
                ? cellModel.readCellValue(lineText, card, fieldIndex - 1).length > 0
                : false;
        const range = cellModel.navSelectionRange(card, fieldIndex, {
            keepSeparator,
            previousFieldHasValue,
        });
        return {
            lineNum,
            newText: lineText,
            selStart: range?.start ?? card[fieldIndex].p,
            selEnd: range?.end ?? card[fieldIndex].p + card[fieldIndex].w,
            markA: { fieldIndex, keepSeparator },
        };
    }

    /**
     * Empty cell + Backspace/Delete at boundary:
     * - whole row empty → delete line (A+D)
     * - Backspace → jump to previous field (A select), never stuck
     * - Delete on last field with no more content → no-op stay (or jump next if any)
     */
    function planEmptyCellBoundary(
        document: any,
        lineNum: number,
        lineText: string,
        card: CardField[],
        fieldIndex: number,
        direction: 'left' | 'right',
    ): null | {
        lineNum: number;
        newText: string;
        selStart: number;
        selEnd: number;
        markA?: { fieldIndex: number; keepSeparator: boolean };
        clearNav?: boolean;
        deleteLine?: boolean;
        targetLine?: number;
    } {
        if (cellModel.isLineAllEmpty(lineText, card)) {
            return planEmptyRowLineDelete(document, lineNum);
        }

        if (direction === 'left') {
            if (fieldIndex > 0) {
                return planSelectFieldA(lineNum, lineText, card, fieldIndex - 1);
            }
            // First field empty + Backspace: leave line as-is; place caret at field start.
            // Do not fall through to editor (would collapse space-wall / eat prev line).
            const f = card[0];
            return {
                lineNum,
                newText: lineText,
                selStart: f.p,
                selEnd: f.p,
                clearNav: true,
            };
        }

        // Delete (right) on empty cell → next field if any
        if (fieldIndex < card.length - 1) {
            return planSelectFieldA(lineNum, lineText, card, fieldIndex + 1);
        }
        // Last field empty + Delete: stay at cell end (no collapse)
        const f = card[fieldIndex];
        return {
            lineNum,
            newText: lineText,
            selStart: f.p + f.w - 1,
            selEnd: f.p + f.w - 1,
            clearNav: true,
        };
    }

    /**
     * Lower-level: compute edit for delete. Returns null to fall through.
     */
    function planDelete(
        document: any,
        selection: any,
        direction: 'left' | 'right',
    ): null | {
        lineNum: number;
        newText: string;
        selStart: number;
        selEnd: number;
        fieldIndex?: number;
        markAp?: boolean;
        markA?: { fieldIndex: number; keepSeparator: boolean };
        clearNav?: boolean;
        /** When true, remove the whole line (incl. line break); use targetLine for caret. */
        deleteLine?: boolean;
        targetLine?: number;
    } {
        if (!isEligibleDocument(document)) return null;
        if (deps.isSuggestVisible && deps.isSuggestVisible()) return null;

        const sel = lineSelFromSelection(selection);
        // Multi-line / whole-line selection: fall through (editor default delete).
        if (sel.startLine !== sel.endLine) return null;

        const lineNum = sel.startLine;
        const card = getCardIfCellLine(document, lineNum);
        if (!card) return null;

        const lineText = document.lineAt(lineNum).text;
        if (isWholeLineSelection(sel, lineText)) return null;

        // A+D: whole row already empty (space wall / blank) → remove the line.
        // Do this before A-clear so a second BS on a blank row actually deletes it.
        if (cellModel.isLineAllEmpty(lineText, card)) {
            return planEmptyRowLineDelete(document, lineNum);
        }

        const afterFirstKey = navMatches(document, lineNum) && nav?.mode === 'Ap';
        const classified = cellModel.classifySelection(
            lineText,
            card,
            { startChar: sel.startChar, endChar: sel.endChar, isEmpty: sel.isEmpty },
            { navKeepSeparator: true, afterFirstKey },
        );

        // Prefer nav A when marked even if geometry is keep-separator
        let kind = classified.kind;
        let fieldIndex = classified.fieldIndex;
        if (navMatches(document, lineNum) && nav!.mode === 'A' && (kind === 'A' || kind === 'B')) {
            kind = 'A';
            fieldIndex = nav!.fieldIndex;
        }
        if (navMatches(document, lineNum) && nav!.mode === 'Ap') {
            kind = 'Ap';
            fieldIndex = nav!.fieldIndex;
        }

        // Empty caret + Backspace at field boundary: exclusive end of field N is start of
        // field N+1. Geometry alone would edit the next field; remapping matches the
        // visual "I'm finishing the previous number" intent.
        // Nav A/Ap already pins the session field — still remap when the caret is exactly
        // at the next field's start *and* nav is on that next field only if the previous
        // field still has a value to finish (boundary steal from empty next pad).
        if (sel.isEmpty && direction === 'left' && kind !== 'A' && kind !== 'D') {
            const mapped = cellModel.fieldIndexForDelete(lineText, card, sel.startChar, 'left');
            if (mapped >= 0 && mapped !== fieldIndex) {
                // Prefer previous field when nav is not actively editing the geometric field
                // as Ap with a non-empty value (user mid-typing in the next cell).
                const navOwnsNext =
                    navMatches(document, lineNum) &&
                    nav!.mode === 'Ap' &&
                    nav!.fieldIndex === fieldIndex &&
                    cellModel.readCellValue(lineText, card, fieldIndex).length > 0;
                if (!navOwnsNext) {
                    fieldIndex = mapped;
                    kind = 'C';
                }
            }
        }

        if (kind === 'E' || fieldIndex < 0) return null;

        if (kind === 'A') {
            const cellVal = cellModel.readCellValue(lineText, card, fieldIndex);
            // Empty A selection (already cleared, or empty field): jump / line-delete, not stuck clear.
            if (!cellVal) {
                return planEmptyCellBoundary(document, lineNum, lineText, card, fieldIndex, direction);
            }
            // Non-empty A: clear this cell only; stay on same field in A (ready to type or BS again).
            const newText = cellModel.clearCell(lineText, card, fieldIndex);
            return {
                ...planSelectFieldA(lineNum, newText, card, fieldIndex),
                newText,
            };
        }

        if (kind === 'D') {
            // M1: clear fields whose values intersect the selection (pad-only next cell stays).
            const newText = cellModel.clearCellsIntersecting(lineText, card, sel.startChar, sel.endChar);
            return {
                lineNum,
                newText,
                selStart: sel.startChar,
                selEnd: sel.startChar,
                clearNav: true,
            };
        }

        // Ap / B / C — caret-relative in-cell delete
        const result = cellModel.applyInCellDelete(
            lineText,
            card,
            fieldIndex,
            { startChar: sel.startChar, endChar: sel.endChar, isEmpty: sel.isEmpty },
            direction,
        );
        if (!result) return null;

        if (result.hitBoundary) {
            return planEmptyCellBoundary(
                document,
                lineNum,
                lineText,
                card,
                fieldIndex,
                result.hitBoundary,
            );
        }

        return {
            lineNum,
            newText: result.line,
            selStart: result.caretCol,
            selEnd: result.caretCol,
            fieldIndex,
            markAp: true,
        };
    }

    /**
     * Keyword/comment starters: leave cell mode and use default typing.
     */
    function isTypeEscapeText(text: string): boolean {
        return text.startsWith('*') || text.startsWith('$');
    }

    /**
     * Plan a type-over only for Tab-established nav (A or short-lived Ap).
     * Geometry-only A/B/C without nav never intercepts (avoids * / $ / free text mis-hits).
     *
     * @returns null = fallthrough keep nav; { escape: true } = fallthrough + clear nav;
     *          { blocked: true } = consume unsafe over-width input without editing;
     *          edit plan = rewrite line + markAp
     */
    function planType(
        document: any,
        selection: any,
        text: string,
    ): null | { escape: true } | { blocked: true } | {
        lineNum: number;
        newText: string;
        caret: number;
        fieldIndex: number;
        markAp: boolean;
    } {
        if (!text || typeof text !== 'string') return null;
        // Skip newlines / multi-line pastes
        if (text.includes('\n') || text.includes('\r')) return null;
        if (!isEligibleDocument(document)) return null;
        if (deps.isSuggestVisible && deps.isSuggestVisible()) return null;

        const sel = lineSelFromSelection(selection);
        if (sel.startLine !== sel.endLine) return null;

        const lineNum = sel.startLine;
        // G4: only Tab / SelectCell nav — never geometry-alone type-over
        if (!navMatches(document, lineNum) || !nav) return null;
        if (nav.mode !== 'A' && nav.mode !== 'Ap') return null;

        // G7: * / $ escape — host clears nav and uses default:type
        if (isTypeEscapeText(text)) {
            return { escape: true };
        }

        const card = getCardIfCellLine(document, lineNum);
        if (!card) return null;

        const fieldIndex = nav.fieldIndex;
        if (fieldIndex < 0 || fieldIndex >= card.length) return null;

        const lineText = document.lineAt(lineNum).text;
        const f = card[fieldIndex];

        if (nav.mode === 'A') {
            if (
                sel.isEmpty ||
                sel.startChar !== nav.expectedStart ||
                sel.endChar !== nav.expectedEnd
            ) {
                return null;
            }
            if (text.length > f.w) {
                return { blocked: true };
            }
            // Prefer full-cell overwrite while nav A is active (Tab selection).
            // If selection was partially collapsed but still on this field, still A-overwrite
            // only when geometry is A/keep-separator or still covers this field as B/C with nav A.
            const classified = cellModel.classifySelection(
                lineText,
                card,
                { startChar: sel.startChar, endChar: sel.endChar, isEmpty: sel.isEmpty },
                { navKeepSeparator: true },
            );
            // Stay strict: only when selection is still A on the nav field, or nav forces A
            // for same fieldIndex (Tab mark survives minor selection noise only if same field).
            if (classified.fieldIndex !== fieldIndex && classified.kind !== 'E') {
                // Selection moved to another field without clearNav — refuse
                if (classified.fieldIndex >= 0 && classified.fieldIndex !== fieldIndex) {
                    return null;
                }
            }
            // Force A overwrite for nav A on marked field (Tab established intent)
            const newText = cellModel.writeCellR1(lineText, card, fieldIndex, text);
            const caret = cellModel.caretAfterCellValue(newText, card, fieldIndex);
            return { lineNum, newText, caret, fieldIndex, markAp: true };
        }

        // Ap: caret must remain in [p, p+w] inclusive (exclusive end may equal next start)
        const caretCol = sel.isEmpty ? sel.startChar : sel.endChar;
        if (
            sel.startChar < f.p ||
            sel.endChar > f.p + f.w ||
            caretCol < f.p ||
            caretCol > f.p + f.w
        ) {
            return null;
        }

        if (!sel.isEmpty) {
            // Partial selection inside Ap field: delete range then insert
            const afterDel = cellModel.applyInCellDelete(
                lineText,
                card,
                fieldIndex,
                { startChar: sel.startChar, endChar: sel.endChar, isEmpty: false },
                'right',
            );
            if (!afterDel) return null;
            if (cellModel.readCellValue(afterDel.line, card, fieldIndex).length + text.length > f.w) {
                return { blocked: true };
            }
            const afterIns = cellModel.applyInCellInsert(
                afterDel.line,
                card,
                fieldIndex,
                afterDel.caretCol,
                text,
            );
            if (!afterIns) return null;
            return {
                lineNum,
                newText: afterIns.line,
                caret: afterIns.caretCol,
                fieldIndex,
                markAp: true,
            };
        }

        if (cellModel.readCellValue(lineText, card, fieldIndex).length + text.length > f.w) {
            return { blocked: true };
        }
        const afterIns = cellModel.applyInCellInsert(lineText, card, fieldIndex, caretCol, text);
        if (!afterIns) return null;
        return {
            lineNum,
            newText: afterIns.line,
            caret: afterIns.caretCol,
            fieldIndex,
            markAp: true,
        };
    }

    return {
        clearNav,
        markA,
        markAp,
        getNav,
        navMatches,
        getCardIfCellLine,
        shouldCellEditActive,
        onSelectionChange,
        planDelete,
        planType,
        planPostEditCorrection,
        cellModel,
    };
}

module.exports = {
    createCardCellEditGuard,
};

export {};
