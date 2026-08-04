'use strict';

/**
 * @fileoverview Fixed-width card field "cell" editing math (pure, no VS Code).
 * @module core/edit/cardCellModel
 *
 * Clear/overwrite always rewrites logical [p, p+w); neighbors never shift.
 */

export type CardField = {
    n?: string;
    p: number;
    w: number;
    t?: string;
};

export type GridMode = 'off' | 'intact' | 'messy';

export type CellSelectionClass = 'A' | 'Ap' | 'B' | 'C' | 'D' | 'E';

export type LineSel = {
    startChar: number;
    endChar: number;
    isEmpty: boolean;
};

export type ClassifySelectionOptions = {
    /** True when Tab produced keep-separator [p+1, p+w) for non-first fields. */
    navKeepSeparator?: boolean;
    /** Caller already knows A′ (after first key); pure geometry alone cannot. */
    afterFirstKey?: boolean;
    multiCursor?: boolean;
    multiLine?: boolean;
};

function isStringyField(f: CardField): boolean {
    const t = String(f.t || '').toLowerCase();
    if (t === 'string' || t === 'character' || t === 'char') return true;
    if (f.w >= 40) return true;
    return false;
}

export function cardTotalWidth(card: CardField[]): number {
    if (!card || card.length === 0) return 0;
    const last = card[card.length - 1];
    return last.p + last.w;
}

/**
 * Fixed-column editing requires one unambiguous, forward-only slice per field.
 * Conditional/alternative schema fields may legitimately share a column, but the
 * editor cannot know which alternative is active. Those cards must fail closed.
 */
export function isSafeCardGeometry(card: CardField[]): boolean {
    if (!card || card.length === 0) return false;
    let previousEnd = -1;
    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        if (!Number.isSafeInteger(f.p) || f.p < 0) return false;
        if (!Number.isSafeInteger(f.w) || f.w <= 0) return false;
        const end = f.p + f.w;
        if (!Number.isSafeInteger(end)) return false;
        if (i > 0 && f.p < previousEnd) return false;
        previousEnd = end;
    }
    return true;
}

export function padLineToCard(line: string, card: CardField[]): string {
    const total = cardTotalWidth(card);
    if (total <= 0) return String(line || '');
    const s = String(line || '');
    return s.length >= total ? s : s.padEnd(total, ' ');
}

export function formatCellR1(value: string, width: number): string {
    const w = Math.max(0, Number(width) || 0);
    if (w === 0) return '';
    let v = value == null ? '' : String(value);
    if (v.length > w) v = v.slice(0, w);
    return v.padStart(w, ' ');
}

export function formatCellL1(value: string, width: number): string {
    const w = Math.max(0, Number(width) || 0);
    if (w === 0) return '';
    let v = value == null ? '' : String(value);
    if (v.length > w) v = v.slice(0, w);
    return v.padEnd(w, ' ');
}

function formatFieldCell(value: string, f: CardField): string {
    if (f.n && String(f.n).startsWith('PRMR')) {
        return formatCellL1(value, f.w);
    }
    if (isStringyField(f)) {
        return formatCellL1(value, f.w);
    }
    return formatCellR1(value, f.w);
}

/**
 * Replace [p, p+w) without changing any other character positions.
 */
export function replaceCellSlice(line: string, card: CardField[], fieldIndex: number, cellText: string): string {
    if (!card || fieldIndex < 0 || fieldIndex >= card.length) return String(line || '');
    const f = card[fieldIndex];
    const padded = padLineToCard(line, card);
    const cell = cellText.length === f.w ? cellText : (cellText + ' '.repeat(f.w)).slice(0, f.w);
    return padded.slice(0, f.p) + cell + padded.slice(f.p + f.w);
}

export function readCellValue(line: string, card: CardField[], fieldIndex: number): string {
    if (!card || fieldIndex < 0 || fieldIndex >= card.length) return '';
    const f = card[fieldIndex];
    const padded = padLineToCard(line, card);
    return padded.slice(f.p, f.p + f.w).trim();
}

export function clearCell(line: string, card: CardField[], fieldIndex: number): string {
    if (!card || fieldIndex < 0 || fieldIndex >= card.length) return String(line || '');
    const f = card[fieldIndex];
    return replaceCellSlice(line, card, fieldIndex, ' '.repeat(f.w));
}

/**
 * True when the line has no non-whitespace content (empty or space-wall card row).
 * Used for empty-row Delete → remove line (A+D).
 */
export function isLineAllEmpty(line: string, _card?: CardField[] | null): boolean {
    return !String(line || '').trim();
}

export function writeCellR1(line: string, card: CardField[], fieldIndex: number, value: string): string {
    if (!card || fieldIndex < 0 || fieldIndex >= card.length) return String(line || '');
    const f = card[fieldIndex];
    return replaceCellSlice(line, card, fieldIndex, formatFieldCell(value, f));
}

/**
 * Caret column after an R1/L1 write — after the last non-space in the cell,
 * or at field start if empty (ready to type).
 *
 * Returns the exclusive end of the value (may equal p+w when the value fills the
 * cell). That is the natural "I finished this number" caret: Backspace then
 * deletes the last digit (character to the left), matching normal editors.
 *
 * Note: p+w is also the next field's start. Callers must use fieldIndexForDelete
 * / nav Ap ownership so Backspace still edits this field, not the next one.
 */
export function caretAfterCellValue(line: string, card: CardField[], fieldIndex: number): number {
    if (!card || fieldIndex < 0 || fieldIndex >= card.length) return 0;
    const f = card[fieldIndex];
    if (f.w <= 0) return f.p;
    const padded = padLineToCard(line, card);
    const slice = padded.slice(f.p, f.p + f.w);
    const val = slice.trim();
    if (!val) return f.p;
    const lead = slice.match(/^\s*/)?.[0].length || 0;
    // Exclusive end after the trimmed value in R1 layout
    return Math.min(f.p + lead + val.length, f.p + f.w);
}

export function fieldIndexAt(_line: string, card: CardField[], col: number): number {
    if (!card || card.length === 0) return -1;
    const c = Math.max(0, col);
    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        const next = card[i + 1];
        const end = next ? next.p : f.p + f.w;
        if (c >= f.p && c < end) return i;
    }
    const last = card[card.length - 1];
    if (c >= last.p) return card.length - 1;
    return 0;
}

/**
 * Field ownership for Delete/Backspace with an empty caret.
 *
 * R1 values sit against the right edge of a cell, so the natural "after last digit"
 * caret is the exclusive end p+w — which is also the next field's start. Visually the
 * user is still finishing the previous field; Backspace must edit that previous field,
 * not the next field's leading pad / first digit.
 *
 * Delete (right) keeps geometric fieldIndexAt (remove the char after the caret).
 */
export function fieldIndexForDelete(
    _line: string,
    card: CardField[],
    col: number,
    direction: 'left' | 'right',
): number {
    const fi = fieldIndexAt(_line, card, col);
    if (fi < 0 || !card || card.length === 0) return fi;
    if (direction !== 'left') return fi;

    const c = Math.max(0, col);
    // Exactly at a field boundary start → Backspace belongs to the previous field.
    for (let i = 1; i < card.length; i++) {
        if (c === card[i].p) {
            return i - 1;
        }
    }
    return fi;
}

/**
 * Field ownership for Tab (+1) and SelectCell (0).
 *
 * At a shared boundary column (next field start), if the previous field is non-empty
 * and its value exclusive end equals that column (true for R1 right-aligned values),
 * the caret is treated as still finishing the previous field — so Tab advances to
 * this field instead of skipping past it.
 *
 * Unlike fieldIndexForDelete('left'), empty previous fields keep geometric ownership
 * so Tab into an empty cell can advance again (no stuck loop).
 *
 * Shift+Tab must use fieldIndexAt only — left ownership would skip the previous cell.
 */
export function fieldIndexForTabNav(line: string, card: CardField[], col: number): number {
    const fi = fieldIndexAt(line, card, col);
    if (fi < 0 || !card || card.length === 0) return fi;

    const c = Math.max(0, col);
    for (let i = 1; i < card.length; i++) {
        if (c !== card[i].p) continue;
        const prev = i - 1;
        const prevVal = readCellValue(line, card, prev);
        if (prevVal && caretAfterCellValue(line, card, prev) === c) {
            return prev;
        }
        return fi;
    }
    return fi;
}

export function classifyGrid(line: string, card: CardField[]): GridMode {
    if (!isSafeCardGeometry(card)) return 'off';
    if (card.length === 1 && card[0].w >= 40) return 'off';

    const text = String(line || '');
    if (text.includes(',')) return 'messy';

    const total = cardTotalWidth(card);
    const trimmedLen = text.trimEnd().length;
    if (trimmedLen > total) return 'messy';

    let hasInvalidInternalSpace = false;
    let physNonEmpty = 0;
    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        if (f.p >= text.length) continue;
        const raw = text.slice(f.p, Math.min(text.length, f.p + f.w));
        const val = raw.trim();
        if (val.length > 0) physNonEmpty++;
        if (val.length > 0 && /\s/.test(val) && !isStringyField(f)) {
            hasInvalidInternalSpace = true;
        }
    }
    if (hasInvalidInternalSpace) return 'messy';

    // Free-format tokens on a short line (collapsed) — more tokens than physical non-empty cells.
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && tokens.length > physNonEmpty && trimmedLen < total) {
        return 'messy';
    }

    return 'intact';
}

function normalizeSel(sel: LineSel): { a: number; b: number; isEmpty: boolean } {
    const a = Math.min(sel.startChar, sel.endChar);
    const b = Math.max(sel.startChar, sel.endChar);
    const isEmpty = sel.isEmpty || a === b;
    return { a, b, isEmpty };
}

export function classifySelection(
    line: string,
    card: CardField[],
    sel: LineSel,
    opts: ClassifySelectionOptions = {},
): { kind: CellSelectionClass; fieldIndex: number } {
    if (opts.multiCursor || opts.multiLine) {
        return { kind: 'E', fieldIndex: -1 };
    }
    if (!card || card.length === 0) {
        return { kind: 'E', fieldIndex: -1 };
    }
    if (card.length === 1 && card[0].w >= 40) {
        return { kind: 'E', fieldIndex: -1 };
    }

    const { a, b, isEmpty } = normalizeSel(sel);
    const mid = isEmpty ? a : Math.floor((a + b) / 2);
    const fieldIndex = fieldIndexAt(line, card, isEmpty ? a : mid);
    if (fieldIndex < 0) return { kind: 'E', fieldIndex: -1 };

    const f = card[fieldIndex];
    const p = f.p;
    const w = f.w;

    if (isEmpty) {
        if (a >= p && a <= p + w) {
            return { kind: opts.afterFirstKey ? 'Ap' : 'C', fieldIndex };
        }
        return { kind: 'E', fieldIndex: -1 };
    }

    // Spans multiple fields?
    const startFi = fieldIndexAt(line, card, a);
    const endFi = fieldIndexAt(line, card, Math.max(a, b - 1));
    if (startFi !== endFi && startFi >= 0 && endFi >= 0) {
        return { kind: 'D', fieldIndex: startFi };
    }

    // Full logical cell
    if (a === p && b === p + w) {
        return { kind: 'A', fieldIndex };
    }
    // Keep-separator nav selection (non-first field)
    if (fieldIndex > 0 && a === p + 1 && b === p + w && opts.navKeepSeparator !== false) {
        // Treat as A when geometry matches keep-separator (default allow)
        return { kind: 'A', fieldIndex };
    }

    if (a >= p && b <= p + w) {
        return { kind: 'B', fieldIndex };
    }

    return { kind: 'E', fieldIndex: -1 };
}

export function alignLineInPlace(line: string, card: CardField[]): string {
    if (!card || card.length === 0) return String(line || '');
    let out = padLineToCard(line, card);
    for (let i = 0; i < card.length; i++) {
        const val = readCellValue(out, card, i);
        out = writeCellR1(out, card, i, val);
    }
    return out;
}

/**
 * Document [start, end) of the trimmed value inside a field (R1/L1 pad excluded).
 * Empty field → null (pad-only; no value to clear).
 */
export function cellValueRange(
    line: string,
    card: CardField[],
    fieldIndex: number,
): { start: number; end: number } | null {
    if (!card || fieldIndex < 0 || fieldIndex >= card.length) return null;
    const f = card[fieldIndex];
    if (f.w <= 0) return null;
    const padded = padLineToCard(line, card);
    const slice = padded.slice(f.p, f.p + f.w);
    const val = slice.trim();
    if (!val) return null;
    const lead = slice.match(/^\s*/)?.[0].length || 0;
    const start = f.p + lead;
    return { start, end: start + val.length };
}

/**
 * Clear fields whose **value** intersects [start, end).
 *
 * R1 pad between a filled cell and the next value is geometrically the next field;
 * dragging a selection across that pad must not wipe the next field's value.
 * Pad-only intersection (empty field, or only leading/trailing spaces) is ignored.
 */
export function clearCellsIntersecting(line: string, card: CardField[], startChar: number, endChar: number): string {
    if (!card || card.length === 0) return String(line || '');
    const a = Math.min(startChar, endChar);
    const b = Math.max(startChar, endChar);
    if (a === b) return String(line || '');
    let out = padLineToCard(line, card);
    for (let i = 0; i < card.length; i++) {
        const range = cellValueRange(out, card, i);
        if (!range) continue;
        if (a < range.end && b > range.start) {
            out = clearCell(out, card, i);
        }
    }
    return out;
}

export type InCellDeleteResult = {
    line: string;
    caretCol: number;
    /**
     * No character removed: caret is at the empty-cell edge (or value edge with
     * nothing left to delete in that direction). Caller may jump to a neighbor field.
     */
    hitBoundary?: 'left' | 'right';
};

/**
 * Map document column → index into the trimmed cell value (0..val.length).
 * Leading R1 padding maps to 0; columns past the value map to val.length.
 */
export function valueIndexAtCaret(line: string, card: CardField[], fieldIndex: number, caretCol: number): number {
    if (!card || fieldIndex < 0 || fieldIndex >= card.length) return 0;
    const f = card[fieldIndex];
    const val = readCellValue(line, card, fieldIndex);
    if (!val) return 0;
    const padded = padLineToCard(line, card);
    const slice = padded.slice(f.p, f.p + f.w);
    const lead = slice.match(/^\s*/)?.[0].length || 0;
    const valueStart = f.p + lead;
    const valueEnd = valueStart + val.length;
    if (caretCol <= valueStart) return 0;
    if (caretCol >= valueEnd) return val.length;
    return caretCol - valueStart;
}

/**
 * Document column for a value index (insertion point).
 * valueIndex === val.length → exclusive end after the last digit (may equal p+w).
 * Empty value → field start.
 */
export function caretAtValueIndex(line: string, card: CardField[], fieldIndex: number, valueIndex: number): number {
    if (!card || fieldIndex < 0 || fieldIndex >= card.length) return 0;
    const f = card[fieldIndex];
    const val = readCellValue(line, card, fieldIndex);
    if (!val) return f.p;
    const padded = padLineToCard(line, card);
    const slice = padded.slice(f.p, f.p + f.w);
    const lead = slice.match(/^\s*/)?.[0].length || 0;
    const i = Math.max(0, Math.min(val.length, valueIndex));
    // Allow exclusive end p+w so caret sits after the last digit (normal editor).
    return Math.min(f.p + lead + i, f.p + f.w);
}

export function applyInCellDelete(
    line: string,
    card: CardField[],
    fieldIndex: number,
    caretOrSel: LineSel,
    direction: 'left' | 'right',
): InCellDeleteResult | null {
    if (!card || fieldIndex < 0 || fieldIndex >= card.length) return null;
    const f = card[fieldIndex];
    const { a, b, isEmpty } = normalizeSel(caretOrSel);
    let val = readCellValue(line, card, fieldIndex);

    if (!isEmpty) {
        // Delete the selected span from the logical value (no internal hole).
        // Map the document-column selection onto value indices so a mid-value
        // selection like "2" in "123" yields "13", not "1 3" (which would be an
        // illegal numeric token and shift later fields on the next Tab re-rack).
        // valueIndexAtCaret clamps to [0, val.length], so selections spilling into
        // the R1 pad or past the value are handled without extra boundary math.
        const from = valueIndexAtCaret(line, card, fieldIndex, a);
        const to = valueIndexAtCaret(line, card, fieldIndex, b);
        val = val.slice(0, from) + val.slice(to);
        const next = writeCellR1(line, card, fieldIndex, val);
        const caretCol = val
            ? caretAtValueIndex(next, card, fieldIndex, from)
            : f.p;
        return { line: next, caretCol };
    }

    // Empty cell: do not rewrite; signal boundary so the guard can jump / delete line.
    if (!val) {
        const col = Math.max(f.p, Math.min(f.p + f.w, a));
        return {
            line: String(line || ''),
            caretCol: col,
            hitBoundary: direction === 'left' ? 'left' : 'right',
        };
    }

    // Standard editor semantics on the logical value:
    // - Backspace deletes the character to the LEFT of the caret
    // - Delete deletes the character to the RIGHT of (at) the caret
    // Leading R1 pad maps to index 0; past/at exclusive end maps to val.length.
    const idx = valueIndexAtCaret(line, card, fieldIndex, a);

    if (direction === 'left') {
        if (idx <= 0) {
            // Caret at/before first digit (or in leading pad) — nothing left to delete in-cell.
            return { line: String(line || ''), caretCol: a, hitBoundary: 'left' };
        }
        val = val.slice(0, idx - 1) + val.slice(idx);
        const next = writeCellR1(line, card, fieldIndex, val);
        return {
            line: next,
            caretCol: val ? caretAtValueIndex(next, card, fieldIndex, idx - 1) : f.p,
        };
    }

    // Delete (right)
    if (idx >= val.length) {
        return { line: String(line || ''), caretCol: a, hitBoundary: 'right' };
    }
    val = val.slice(0, idx) + val.slice(idx + 1);
    const next = writeCellR1(line, card, fieldIndex, val);
    return {
        line: next,
        caretCol: val ? caretAtValueIndex(next, card, fieldIndex, idx) : f.p,
    };
}

export function applyInCellInsert(
    line: string,
    card: CardField[],
    fieldIndex: number,
    caretCol: number,
    text: string,
): { line: string; caretCol: number } | null {
    if (!card || fieldIndex < 0 || fieldIndex >= card.length) return null;
    if (!text) return null;
    const f = card[fieldIndex];
    let val = readCellValue(line, card, fieldIndex);
    // P0 R1: append printable (Ap path). For mid-value insert, approximate by append if caret at end of value.
    const padded = padLineToCard(line, card);
    const valueEnd = caretAfterCellValue(padded, card, fieldIndex);
    if (caretCol < valueEnd && val.length > 0) {
        // Insert into value by mapping caret into value index from the right-aligned layout
        const slice = padded.slice(f.p, f.p + f.w);
        const lead = slice.match(/^\s*/)?.[0].length || 0;
        const rel = Math.max(0, caretCol - f.p - lead);
        const i = Math.min(val.length, rel);
        val = val.slice(0, i) + text + val.slice(i);
    } else {
        val = val + text;
    }
    if (val.length > f.w) val = val.slice(0, f.w);
    const next = writeCellR1(line, card, fieldIndex, val);
    return { line: next, caretCol: caretAfterCellValue(next, card, fieldIndex) };
}

/**
 * Visual selection range for nav A state (keep-separator for non-first fields).
 */
export function navSelectionRange(
    card: CardField[],
    fieldIndex: number,
    opts?: { keepSeparator?: boolean; previousFieldHasValue?: boolean },
): { start: number; end: number } | null {
    if (!card || fieldIndex < 0 || fieldIndex >= card.length) return null;
    const f = card[fieldIndex];
    const keep =
        opts?.keepSeparator !== false &&
        fieldIndex > 0 &&
        opts?.previousFieldHasValue !== false;
    const start = keep ? f.p + 1 : f.p;
    return { start, end: f.p + f.w };
}

module.exports = {
    cardTotalWidth,
    isSafeCardGeometry,
    padLineToCard,
    formatCellR1,
    formatCellL1,
    replaceCellSlice,
    readCellValue,
    clearCell,
    isLineAllEmpty,
    writeCellR1,
    caretAfterCellValue,
    caretAtValueIndex,
    valueIndexAtCaret,
    fieldIndexAt,
    fieldIndexForDelete,
    fieldIndexForTabNav,
    classifyGrid,
    classifySelection,
    alignLineInPlace,
    cellValueRange,
    clearCellsIntersecting,
    applyInCellDelete,
    applyInCellInsert,
    navSelectionRange,
};

export {};
