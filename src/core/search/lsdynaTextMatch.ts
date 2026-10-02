'use strict';

/**
 * Fuzzy text match for tree / keyword QuickPick (small lists: tens of items).
 *
 * Include tree: match **basename (label) only** — never full path / description.
 * Keywords: separator-aware token prefix + ordered character subsequence.
 * @module core/search/lsdynaTextMatch
 */

/** Strip leading * and separators into a continuous upper skeleton. */
export function keywordSkeleton(raw: string): string {
    return String(raw || '')
        .trim()
        .toUpperCase()
        .replace(/^\*+/, '')
        .replace(/[\s_\-./\\]+/g, '');
}

/** Split on LS-DYNA-ish separators. */
export function keywordTokens(raw: string): string[] {
    const upper = String(raw || '').trim().toUpperCase().replace(/^\*+/, '');
    if (!upper) return [];
    return upper.split(/[\s_\-./\\]+/).filter(Boolean);
}

/** Lowercase alphanumerics only. */
function fuzzyChars(raw: string): string {
    return String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/^\*+/, '')
        .replace(/[^a-z0-9]+/g, '');
}

/**
 * Ordered subsequence of needle in haystack (both already normalized).
 * Returns end index (exclusive) in haystack after match, or -1.
 */
function subsequenceEnd(needle: string, haystack: string, from = 0): number {
    if (!needle) return from;
    let hi = from;
    for (let ni = 0; ni < needle.length; ni++) {
        const ch = needle[ni];
        let found = -1;
        for (let j = hi; j < haystack.length; j++) {
            if (haystack[j] === ch) {
                found = j;
                break;
            }
        }
        if (found < 0) return -1;
        hi = found + 1;
    }
    return hi;
}

function isSubsequence(needle: string, haystack: string): boolean {
    return subsequenceEnd(needle, haystack, 0) >= 0;
}

/**
 * Mark label indices matched by ordered query characters (alphanumerics, case-insensitive).
 * Returns null if the full query cannot be realized as a subsequence.
 */
function matchIndicesInLabel(label: string, query: string): number[] | null {
    const q = fuzzyChars(query);
    if (!q) return [];
    const indices: number[] = [];
    let qi = 0;
    for (let li = 0; li < label.length && qi < q.length; li++) {
        const c = label[li].toLowerCase();
        if (c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
            if (c === q[qi]) {
                indices.push(li);
                qi += 1;
            }
        }
    }
    return qi === q.length ? indices : null;
}

/**
 * Prefer segment-aware marks: each query token highlights inside successive target regions.
 * Falls back to full-query subsequence marks.
 */
function collectHighlightIndices(label: string, query: string): number[] {
    const rawQuery = String(query || '').trim();
    if (!rawQuery || !label) return [];

    const qTokens = keywordTokens(rawQuery).map(t => t.toLowerCase());
    const tTokens = keywordTokens(label);

    // Token-prefix path: each query token prefixes some remaining target token (order-preserving).
    if (qTokens.length >= 1 && tTokens.length >= 1) {
        const marks: number[] = [];
        // Map each target token to character ranges in original label (rough scan).
        const ranges = tokenRangesInLabel(label);
        let rangeIdx = 0;
        let allOk = true;
        for (const qt of qTokens) {
            const piece = qt.replace(/[^a-z0-9]+/g, '');
            if (!piece) continue;
            let found = false;
            for (let r = rangeIdx; r < ranges.length; r++) {
                const { start, text } = ranges[r];
                const tLow = text.toLowerCase();
                if (tLow.startsWith(piece) || isSubsequence(piece, tLow)) {
                    // Mark matched chars of this token inside the range.
                    let pi = 0;
                    for (let i = 0; i < text.length && pi < piece.length; i++) {
                        if (text[i].toLowerCase() === piece[pi]) {
                            marks.push(start + i);
                            pi += 1;
                        }
                    }
                    if (pi === piece.length) {
                        rangeIdx = r + 1;
                        found = true;
                        break;
                    }
                    // subsequence partial failure — clear and try next range
                    while (marks.length && marks[marks.length - 1] >= start) {
                        marks.pop();
                    }
                }
            }
            if (!found) {
                allOk = false;
                break;
            }
        }
        if (allOk && marks.length) {
            return marks;
        }
    }

    return matchIndicesInLabel(label, rawQuery) || [];
}

/** Locate alphanumeric token spans in a label (skips * _ - . etc.). */
function tokenRangesInLabel(label: string): Array<{ start: number; text: string }> {
    const ranges: Array<{ start: number; text: string }> = [];
    let i = 0;
    const s = String(label || '');
    // skip leading *
    while (i < s.length && s[i] === '*') i += 1;
    while (i < s.length) {
        while (i < s.length && /[\s_\-./\\]/.test(s[i])) i += 1;
        if (i >= s.length) break;
        const start = i;
        while (i < s.length && !/[\s_\-./\\]/.test(s[i])) i += 1;
        const text = s.slice(start, i);
        if (text) ranges.push({ start, text });
    }
    return ranges;
}

/**
 * Decorate matched characters with combining underline (U+0332) for QuickPick labels.
 * VS Code QuickPick has no highlight API; this gives a visible match cue.
 */
export function highlightFuzzyLabel(label: string, query: string): string {
    const raw = String(label || '');
    const rawQuery = String(query || '').trim();
    if (!rawQuery || !raw) return raw;

    const indices = new Set(collectHighlightIndices(raw, rawQuery));
    if (!indices.size) return raw;

    let out = '';
    for (let i = 0; i < raw.length; i++) {
        out += raw[i];
        if (indices.has(i)) {
            out += '\u0332'; // combining low line
        }
    }
    return out;
}

/**
 * Score query against a single name (keyword or basename).
 * Higher is better; 0 = no match. Empty query → 1.
 */
export function scoreFuzzyText(query: string, text: string): number {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) return 1;
    const rawText = String(text || '');
    if (!rawText) return 0;

    const qPlain = rawQuery.replace(/^\*+/, '');
    const tPlain = rawText.replace(/^\*+/, '');
    const qLower = qPlain.toLowerCase();
    const tLower = tPlain.toLowerCase();
    const qSkel = keywordSkeleton(rawQuery);
    const tSkel = keywordSkeleton(rawText);
    const qFuzzy = fuzzyChars(rawQuery);
    const tFuzzy = fuzzyChars(rawText);
    const qTokens = keywordTokens(rawQuery);
    const tTokens = keywordTokens(rawText);

    let best = 0;
    const bump = (n: number) => {
        if (n > best) best = n;
    };

    // Tight literal / skeleton
    if (tSkel && qSkel && tSkel === qSkel) bump(100);
    if (tLower === qLower) bump(98);
    if (qSkel.length >= 1 && tSkel.startsWith(qSkel)) bump(92);
    if (tLower.startsWith(qLower)) bump(90);
    if (qSkel.length >= 2 && tSkel.includes(qSkel)) bump(82);
    if (qLower.length >= 2 && tLower.includes(qLower)) bump(80);

    // Segment-aware: each query token prefixes (or is subsequence of) a target token in order.
    // This is what makes "con en" → CONTROL_ENERGY reliable (CON→CONTROL, EN→ENERGY).
    if (qTokens.length >= 1 && tTokens.length >= 1) {
        let ti = 0;
        let ok = true;
        let prefixHits = 0;
        for (const qt of qTokens) {
            const q = qt.toLowerCase();
            let hit = false;
            for (let j = ti; j < tTokens.length; j++) {
                const t = tTokens[j].toLowerCase();
                if (t.startsWith(q)) {
                    prefixHits += 1;
                    ti = j + 1;
                    hit = true;
                    break;
                }
                if (q.length >= 1 && isSubsequence(q, t)) {
                    ti = j + 1;
                    hit = true;
                    break;
                }
            }
            if (!hit) {
                ok = false;
                break;
            }
        }
        if (ok) {
            // All query tokens assigned to successive target segments.
            const base = 70 + Math.min(15, qTokens.length * 4);
            const bonus = prefixHits === qTokens.length ? 10 : 0;
            bump(Math.min(95, base + bonus));
        }
    }

    // Full-query ordered character subsequence (rgv → rogue-v3, ctltime → CONTROL_TIMESTEP)
    if (qFuzzy && tFuzzy && isSubsequence(qFuzzy, tFuzzy)) {
        const end = subsequenceEnd(qFuzzy, tFuzzy, 0);
        const span = Math.max(1, end);
        const density = qFuzzy.length / span;
        const compact = qFuzzy.length / Math.max(1, tFuzzy.length);
        bump(Math.min(78, Math.round(58 + density * 12 + compact * 8)));
    }

    return best;
}

/** Keyword name score (same fuzzy rules). */
export function scoreKeywordName(query: string, keyword: string): number {
    return scoreFuzzyText(query, keyword);
}

/**
 * Score a path-ish string — **basename / stem only** when multi-segment.
 * Never scores intermediate directory noise from absolute paths.
 */
export function scorePathText(query: string, text: string): number {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) return 1;
    const rawText = String(text || '');
    if (!rawText) return 0;

    const tNorm = rawText.replace(/\\/g, '/');
    if (!tNorm.includes('/')) {
        return scoreFuzzyText(rawQuery, rawText);
    }
    const base = tNorm.slice(tNorm.lastIndexOf('/') + 1);
    const stem = base.replace(/\.[^.]+$/, '');
    return Math.max(
        scoreFuzzyText(rawQuery, base),
        scoreFuzzyText(rawQuery, stem),
    );
}

/**
 * Include-tree scoring: **label (filename) only**.
 * Description / filePath are display metadata and must not affect filtering.
 */
export function scorePathFields(
    query: string,
    fields: { label?: string; description?: string; filePath?: string },
): number {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) return 1;
    // Intentionally ignore description and filePath for matching.
    return scoreFuzzyText(rawQuery, fields.label || '');
}

/**
 * Whether we can safely leave alwaysShow=false so VS Code paints native highlights.
 *
 * Important: multi-word queries (any whitespace) must return **false**.
 * Even when each word is a substring of the label, QuickPick's built-in multi-word
 * filter often **hides** items that our scorer kept — that is why "con" worked but
 * "con en" disappeared from the keyword list. Multi-word results always need
 * alwaysShow + optional underline fallback.
 *
 * Single-token queries: true when label has contiguous word match or ordered
 * alnum subsequence (covers "con", "conen", "rgv").
 */
export function builtinFilterLikelyMatches(query: string, label: string): boolean {
    const q = String(query || '').trim().toLowerCase();
    const L = String(label || '').toLowerCase();
    if (!q) return true;
    if (!L) return false;

    // Spaces / multi-segment queries: never trust native keep (causes empty lists).
    if (/\s/.test(q)) {
        return false;
    }

    if (L.includes(q)) {
        return true;
    }

    const qSticky = fuzzyChars(q);
    const lSticky = fuzzyChars(L);
    if (qSticky && lSticky && isSubsequence(qSticky, lSticky)) {
        return true;
    }

    return false;
}

// --- Compatibility helpers ---

export function tokenMatches(queryToken: string, targetToken: string): boolean {
    if (!queryToken || !targetToken) return false;
    const q = queryToken.toLowerCase();
    const t = targetToken.toLowerCase();
    if (t.startsWith(q)) return true;
    if (/^\d+$/.test(q) && t.length > q.length && t.endsWith(q)) return true;
    return isSubsequence(q, t);
}

export function orderedTokensInSkeleton(queryTokens: string[], tSkel: string): boolean {
    if (!queryTokens.length || !tSkel) return false;
    return isSubsequence(queryTokens.join('').toLowerCase(), tSkel.toLowerCase());
}

export function stickyQueryMatches(qSkel: string, targetTokens: string[]): boolean {
    if (!qSkel || !targetTokens.length) return false;
    return isSubsequence(qSkel.toLowerCase(), targetTokens.join('').toLowerCase());
}

module.exports = {
    keywordSkeleton,
    keywordTokens,
    tokenMatches,
    orderedTokensInSkeleton,
    stickyQueryMatches,
    scoreFuzzyText,
    scoreKeywordName,
    scorePathText,
    scorePathFields,
    highlightFuzzyLabel,
    builtinFilterLikelyMatches,
};
