'use strict';

/**
 * Pure line-level three-way mark computation for session change marks.
 * @module client/changeMarks/changeMarksDiff
 *
 * Model (six-way):
 * - unsaved modified (orange solid): current ≠ save, paired with a save line
 * - unsaved inserted (orange hollow): current is insert vs save
 * - unsaved deleted (orange triangle): save lines removed; anchor on neighbor
 * - saved modified (green solid): current == save, ≠ origin (paired)
 * - saved inserted (green hollow): current == save, insert vs origin
 * - saved deleted (green triangle): origin lines removed (saved); anchor on neighbor
 *
 * Alignment:
 * Unit-cost edit distance with *similarity-weighted substitutes* so that
 * "edit B→BX then insert NEW" keeps BX paired with B (solid modified),
 * not demoted to a pure insert (hollow). Pure exact-LCS cannot do this:
 * BX never matches B, so LCS only anchors A/C and treats BX as insert.
 */

import type { ChangeMarksDiffResult } from './types';
const { emptyChangeMarks } = require('./types');

// ponytail: large changed regions use positional marks; use a bounded diff algorithm
// if exact alignment of large rewrites becomes necessary. Never raise these for file size.
const ALIGN_MAX_CELLS = 65_536;
const ALIGN_MAX_CHAR_COMPARISONS = 8_000_000;

export type AlignmentWork = { tables: number; cells: number; characterComparisons: number; fallbacks: number };

/**
 * Split document text into lines. CRLF/LF normalized.
 * Keeps trailing empty string if file ends with newline (editor line count match).
 */
export function splitLines(text: string): string[] {
    if (text == null || text === '') return [''];
    const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return normalized.split('\n');
}

/**
 * Similarity in [0, 1] for substitute cost weighting.
 * Equal lines → 1. Uses longest common prefix / max length (good for card field edits).
 */
export function lineSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    const sa = a == null ? '' : String(a);
    const sb = b == null ? '' : String(b);
    if (!sa.length || !sb.length) return 0;
    const lim = Math.min(sa.length, sb.length);
    let i = 0;
    while (i < lim && sa.charCodeAt(i) === sb.charCodeAt(i)) i++;
    // Blend prefix with a light length-ratio so full rewrites score near 0.
    const prefix = i / Math.max(sa.length, sb.length);
    return prefix;
}

/** Substitute cost in (1, 2]; more similar → closer to 1. Insert/delete cost = 1. */
function subCost(a: string, b: string): number {
    if (a === b) return 0;
    return 1 + (1 - lineSimilarity(a, b));
}

/**
 * Compute six-way mark line indices for three text snapshots.
 */
export function computeChangeMarks(
    originText: string,
    savePointText: string,
    currentText: string,
    work?: AlignmentWork,
): ChangeMarksDiffResult {
    if (currentText === savePointText && currentText === originText) return emptyChangeMarks();
    const origin = splitLines(originText);
    const save = savePointText === originText ? origin : splitLines(savePointText);
    const current = currentText === savePointText ? save
        : currentText === originText ? origin : splitLines(currentText);

    if (currentText === savePointText) {
        return classifyCleanVsOrigin(origin, current, work);
    }

    if (origin.length === current.length && save.length === current.length) {
        return classifyIndexWise(origin, save, current);
    }

    return classifyWithAlignment(origin, save, current, work);
}

/** Equal lengths: only modified (no inserts/deletes). */
function classifyIndexWise(
    origin: string[],
    save: string[],
    current: string[],
): ChangeMarksDiffResult {
    const out = emptyChangeMarks();
    const n = current.length;
    for (let i = 0; i < n; i++) {
        const c = current[i];
        const s = save[i];
        const o = origin[i];
        if (c !== s) {
            out.unsavedModifiedLines.push(i);
        } else if (c !== o) {
            out.savedModifiedLines.push(i);
        }
    }
    return out;
}

/**
 * current === savePoint but differs from origin (post-save green marks).
 */
function classifyCleanVsOrigin(
    origin: string[],
    current: string[],
    work?: AlignmentWork,
): ChangeMarksDiffResult {
    const out = emptyChangeMarks();
    if (origin.length === current.length) {
        for (let i = 0; i < current.length; i++) {
            if (current[i] !== origin[i]) {
                out.savedModifiedLines.push(i);
            }
        }
        return out;
    }
    const aligned = alignPair(origin, current, work);
    for (let i = 0; i < current.length; i++) {
        const oi = aligned.origins[i];
        if (oi < 0) {
            out.savedInsertedLines.push(i);
        } else if (current[i] !== origin[oi]) {
            out.savedModifiedLines.push(i);
        }
    }
    for (const anchor of aligned.deletions) {
        out.savedDeletedLines.push(anchor);
    }
    return finalize(out);
}

export type AlignRow = { originIndex: number; currentIndex: number };

function classifyWithAlignment(
    origin: string[],
    save: string[],
    current: string[],
    work?: AlignmentWork,
): ChangeMarksDiffResult {
    const vsSave = alignPair(save, current, work);
    const vsOrigin = origin === save ? vsSave : alignPair(origin, current, work);
    const out = emptyChangeMarks();
    for (let ci = 0; ci < current.length; ci++) {
        const c = current[ci];
        const si = vsSave.origins[ci];
        if (si < 0) {
            out.unsavedInsertedLines.push(ci);
            continue;
        }
        const s = save[si];
        if (c !== s) {
            out.unsavedModifiedLines.push(ci);
            continue;
        }
        const oi = vsOrigin.origins[ci];
        if (oi < 0) {
            out.savedInsertedLines.push(ci);
        } else {
            if (c !== origin[oi]) {
                out.savedModifiedLines.push(ci);
            }
        }
    }

    for (const anchor of vsSave.deletions) {
        out.unsavedDeletedLines.push(anchor);
    }
    for (const anchor of vsOrigin.deletions) {
        out.savedDeletedLines.push(anchor);
    }

    return finalize(out);
}

function finalize(out: ChangeMarksDiffResult): ChangeMarksDiffResult {
    const taken = new Set<number>();
    const take = (lines: number[]): number[] => {
        const result: number[] = [];
        for (const n of uniqueSorted(lines)) {
            if (n < 0 || taken.has(n)) continue;
            taken.add(n);
            result.push(n);
        }
        return result;
    };
    return {
        unsavedModifiedLines: take(out.unsavedModifiedLines),
        unsavedInsertedLines: take(out.unsavedInsertedLines),
        unsavedDeletedLines: take(out.unsavedDeletedLines),
        savedModifiedLines: take(out.savedModifiedLines),
        savedInsertedLines: take(out.savedInsertedLines),
        savedDeletedLines: take(out.savedDeletedLines),
    };
}

/** One alignment supplies both matched rows and deletion anchors. */
function alignPair(left: string[], right: string[], work?: AlignmentWork) {
    const origins = new Int32Array(right.length).fill(-1);
    let start = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) {
        origins[start] = start;
        start++;
    }
    let leftEnd = left.length, rightEnd = right.length;
    while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
        origins[--rightEnd] = --leftEnd;
    }
    const n = leftEnd - start, m = rightEnd - start;
    const deletions = new Set<number>();
    const anchor = (offset: number) => {
        if (right.length) deletions.add(Math.min(start + offset, right.length - 1));
    };
    if (n === 0 || m === 0) {
        if (n > 0) anchor(0);
        return { origins, deletions: [...deletions] };
    }
    const cells = (n + 1) * (m + 1);
    let maxLeft = 0, maxRight = 0;
    for (let i = start; i < leftEnd; i++) maxLeft = Math.max(maxLeft, left[i].length);
    for (let j = start; j < rightEnd; j++) maxRight = Math.max(maxRight, right[j].length);
    // Include traceback comparisons in the upper bound.
    const characterComparisons = (n * m + n + m) * Math.max(maxLeft, maxRight);
    if (cells > ALIGN_MAX_CELLS || characterComparisons > ALIGN_MAX_CHAR_COMPARISONS) {
        if (work) work.fallbacks++;
        for (let j = 0; j < Math.min(n, m); j++) origins[start + j] = start + j;
        if (n > m) anchor(m);
        return { origins, deletions: [...deletions] };
    }
    if (work) {
        work.tables++;
        work.cells += cells;
        work.characterComparisons += characterComparisons;
    }
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    for (let i = 1; i <= n; i++) dp[i][0] = i;
    for (let j = 1; j <= m; j++) dp[0][j] = j;
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j - 1] + subCost(left[start + i - 1], right[start + j - 1]),
                dp[i - 1][j] + 1, dp[i][j - 1] + 1,
            );
        }
    }
    let i = n, j = m;
    const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && eq(dp[i][j], dp[i - 1][j - 1] +
            subCost(left[start + i - 1], right[start + j - 1]))) {
            origins[start + --j] = start + --i;
        } else if (i > 0 && eq(dp[i][j], dp[i - 1][j] + 1)) {
            anchor(j);
            i--;
        } else if (j > 0 && eq(dp[i][j], dp[i][j - 1] + 1)) {
            j--;
        } else if (i > 0 && j > 0) {
            origins[start + --j] = start + --i;
        } else if (i > 0) {
            anchor(j);
            i--;
        } else {
            j--;
        }
    }
    return { origins, deletions: uniqueSorted([...deletions]) };
}

export function alignLines(left: string[], right: string[]): AlignRow[] {
    return Array.from(alignPair(left, right).origins, (originIndex, currentIndex) => ({ originIndex, currentIndex }));
}

export function computeDeleteAnchors(left: string[], right: string[]): number[] {
    return alignPair(left, right).deletions;
}

function uniqueSorted(nums: number[]): number[] {
    return [...new Set(nums)].filter(n => n >= 0).sort((a, b) => a - b);
}

export function orderedMarkLines(marks: ChangeMarksDiffResult): number[] {
    const m = marks || emptyChangeMarks();
    const seen = new Set<number>();
    const unsaved: number[] = [];
    const saved: number[] = [];
    for (const n of [
        ...(m.unsavedModifiedLines || []),
        ...(m.unsavedInsertedLines || []),
        ...(m.unsavedDeletedLines || []),
    ]) {
        if (n >= 0 && !seen.has(n)) {
            seen.add(n);
            unsaved.push(n);
        }
    }
    for (const n of [
        ...(m.savedModifiedLines || []),
        ...(m.savedInsertedLines || []),
        ...(m.savedDeletedLines || []),
    ]) {
        if (n >= 0 && !seen.has(n)) {
            seen.add(n);
            saved.push(n);
        }
    }
    unsaved.sort((a, b) => a - b);
    saved.sort((a, b) => a - b);
    return unsaved.concat(saved);
}

module.exports = {
    splitLines,
    computeChangeMarks,
    alignLines,
    computeDeleteAnchors,
    orderedMarkLines,
    emptyChangeMarks,
    lineSimilarity,
};

export {};
