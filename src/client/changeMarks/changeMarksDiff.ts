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

/** Soft cap for O(n*m) DP; beyond this use index-wise fallback. */
const ALIGN_MAX = 4000;

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
): ChangeMarksDiffResult {
    const origin = splitLines(originText);
    const save = splitLines(savePointText);
    const current = splitLines(currentText);

    if (currentText === savePointText) {
        if (currentText === originText) {
            return emptyChangeMarks();
        }
        return classifyCleanVsOrigin(origin, current);
    }

    if (origin.length === current.length && save.length === current.length) {
        return classifyIndexWise(origin, save, current);
    }

    return classifyWithAlignment(origin, save, current);
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
    const aligned = alignLines(origin, current);
    for (const row of aligned) {
        if (row.currentIndex < 0) continue;
        if (row.originIndex < 0) {
            out.savedInsertedLines.push(row.currentIndex);
        } else if (current[row.currentIndex] !== origin[row.originIndex]) {
            out.savedModifiedLines.push(row.currentIndex);
        }
    }
    for (const anchor of computeDeleteAnchors(origin, current)) {
        out.savedDeletedLines.push(anchor);
    }
    return finalize(out);
}

export type AlignRow = { originIndex: number; currentIndex: number };

function classifyWithAlignment(
    origin: string[],
    save: string[],
    current: string[],
): ChangeMarksDiffResult {
    const vsSave = alignLines(save, current);
    const vsOrigin = alignLines(origin, current);

    const originByCurrent = new Map<number, number>();
    const originInsert = new Set<number>();
    for (const row of vsOrigin) {
        if (row.currentIndex < 0) continue;
        if (row.originIndex < 0) {
            originInsert.add(row.currentIndex);
        } else {
            originByCurrent.set(row.currentIndex, row.originIndex);
        }
    }

    const out = emptyChangeMarks();
    const covered = new Set<number>();

    for (const row of vsSave) {
        if (row.currentIndex < 0) continue;
        const ci = row.currentIndex;
        covered.add(ci);
        const c = current[ci];

        if (row.originIndex < 0) {
            out.unsavedInsertedLines.push(ci);
            continue;
        }
        const s = save[row.originIndex];
        if (c !== s) {
            out.unsavedModifiedLines.push(ci);
            continue;
        }
        if (originInsert.has(ci) || !originByCurrent.has(ci)) {
            out.savedInsertedLines.push(ci);
        } else {
            const oi = originByCurrent.get(ci)!;
            if (c !== origin[oi]) {
                out.savedModifiedLines.push(ci);
            }
        }
    }

    for (let i = 0; i < current.length; i++) {
        if (!covered.has(i)) {
            out.unsavedInsertedLines.push(i);
        }
    }

    for (const anchor of computeDeleteAnchors(save, current)) {
        out.unsavedDeletedLines.push(anchor);
    }
    for (const anchor of computeDeleteAnchors(origin, current)) {
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

/** Build DP table: match 0 / sub (1,2] / ins 1 / del 1. */
function buildEditDp(left: string[], right: string[]): number[][] {
    const n = left.length;
    const m = right.length;
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) dp[i][0] = i;
    for (let j = 1; j <= m; j++) dp[0][j] = j;
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const diag = dp[i - 1][j - 1] + subCost(left[i - 1], right[j - 1]);
            const del = dp[i - 1][j] + 1;
            const ins = dp[i][j - 1] + 1;
            dp[i][j] = Math.min(diag, del, ins);
        }
    }
    return dp;
}

/**
 * Align left↔right. Substitutions keep modified lines solid; unpaired right = insert.
 * Pure deletes omitted (see computeDeleteAnchors).
 */
export function alignLines(left: string[], right: string[]): AlignRow[] {
    const n = left.length;
    const m = right.length;
    if (m === 0) return [];
    if (n > ALIGN_MAX || m > ALIGN_MAX) {
        return fallbackAlign(left, right);
    }

    const dp = buildEditDp(left, right);
    const rev: AlignRow[] = [];
    let i = n;
    let j = m;
    // Float eps for cost compare after weighted sub
    const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0) {
            const sc = subCost(left[i - 1], right[j - 1]);
            if (eq(dp[i][j], dp[i - 1][j - 1] + sc)) {
                rev.push({ originIndex: i - 1, currentIndex: j - 1 });
                i--;
                j--;
                continue;
            }
        }
        // Prefer delete over insert on remaining ties so inserts stay on the right side.
        if (i > 0 && eq(dp[i][j], dp[i - 1][j] + 1)) {
            i--;
            continue;
        }
        if (j > 0 && eq(dp[i][j], dp[i][j - 1] + 1)) {
            rev.push({ originIndex: -1, currentIndex: j - 1 });
            j--;
            continue;
        }
        // Fallback
        if (i > 0 && j > 0) {
            rev.push({ originIndex: i - 1, currentIndex: j - 1 });
            i--;
            j--;
        } else if (i > 0) {
            i--;
        } else {
            rev.push({ originIndex: -1, currentIndex: j - 1 });
            j--;
        }
    }
    rev.reverse();
    return rev;
}

/**
 * Neighbor anchors for pure deletes under the same DP.
 * Anchor on the first right line after the delete, else last right line.
 */
export function computeDeleteAnchors(left: string[], right: string[]): number[] {
    const n = left.length;
    const m = right.length;
    if (m === 0 || n === 0) return [];
    if (n > ALIGN_MAX || m > ALIGN_MAX) {
        if (n > m) return [m - 1];
        return [];
    }

    const dp = buildEditDp(left, right);
    const anchors = new Set<number>();
    let i = n;
    let j = m;
    const eq = (a: number, b: number) => Math.abs(a - b) < 1e-9;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0) {
            const sc = subCost(left[i - 1], right[j - 1]);
            if (eq(dp[i][j], dp[i - 1][j - 1] + sc)) {
                i--;
                j--;
                continue;
            }
        }
        if (i > 0 && eq(dp[i][j], dp[i - 1][j] + 1)) {
            anchors.add(j < m ? j : m - 1);
            i--;
            continue;
        }
        if (j > 0 && eq(dp[i][j], dp[i][j - 1] + 1)) {
            j--;
            continue;
        }
        if (i > 0 && j > 0) {
            i--;
            j--;
        } else if (i > 0) {
            anchors.add(j < m ? j : m - 1);
            i--;
        } else {
            j--;
        }
    }
    return uniqueSorted([...anchors]);
}

function fallbackAlign(left: string[], right: string[]): AlignRow[] {
    const rows: AlignRow[] = [];
    const len = Math.max(left.length, right.length);
    for (let k = 0; k < len; k++) {
        if (k < right.length) {
            rows.push({
                originIndex: k < left.length ? k : -1,
                currentIndex: k,
            });
        }
    }
    return rows;
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
