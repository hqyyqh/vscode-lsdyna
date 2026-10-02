'use strict';

/**
 * @fileoverview Suggest similar LS-DYNA keywords for unknown / mistyped names.
 * High confidence → single best guess for in-hover help.
 * Medium confidence → short list for a picker.
 * @module core/keywordSuggest
 */

import { loadKeywordSchema } from './keywordSchema';

export type SuggestTier = 'high' | 'medium' | 'none';

export type KeywordSuggestion = {
    keyword: string;
    score: number;
    reason: 'edit-distance' | 'token-permutation' | 'family-near';
};

export type SuggestResult = {
    tier: SuggestTier;
    items: KeywordSuggestion[];
};

export type SuggestOptions = {
    /** Plain keyword name list. Defaults to loaded English schema keys. */
    candidates?: string[];
    maxMedium?: number;
    /** When set, force this keyword as the sole high suggestion if present. */
    preferredKeyword?: string | null;
};

let cachedCandidateList: string[] | null = null;
let cachedCandidateSet: Set<string> | null = null;

const OPTION_LIKE_TOKENS = new Set([
    'ID',
    'MPP',
    'TITLE',
    'HEADING',
    'BLANK',
    'OFFSET',
    'BEAM',
    'CONSTRAINED',
    'THERMAL',
    'ORTHO',
    'FRICTION',
]);

function normalizeName(raw: string): string {
    return String(raw || '')
        .trim()
        .toUpperCase()
        .replace(/^\*+/, '')
        .split(/[\s,$]/)[0];
}

function tokensOf(name: string): string[] {
    return normalizeName(name).split('_').filter(Boolean);
}

function resolveCandidates(options?: SuggestOptions): string[] {
    if (options && Array.isArray(options.candidates)) {
        return [...new Set(options.candidates.map(normalizeName).filter(Boolean))];
    }
    if (!cachedCandidateList) {
        const schema = loadKeywordSchema(() => 'en');
        cachedCandidateList = Object.keys(schema);
        cachedCandidateSet = new Set(cachedCandidateList);
    }
    return cachedCandidateList;
}

/** Test helper: clear process-level candidate cache. */
export function resetKeywordSuggestCache(): void {
    cachedCandidateList = null;
    cachedCandidateSet = null;
}

/**
 * Classic Levenshtein with early exit when distance would exceed maxDist.
 */
export function editDistance(a: string, b: string, maxDist = 4): number {
    const m = a.length;
    const n = b.length;
    if (Math.abs(m - n) > maxDist) return maxDist + 1;
    if (a === b) return 0;
    if (m === 0) return n;
    if (n === 0) return m;

    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        let rowMin = curr[0];
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            if (curr[j] < rowMin) rowMin = curr[j];
        }
        if (rowMin > maxDist) return maxDist + 1;
        const tmp = prev;
        prev = curr;
        curr = tmp;
    }
    return prev[n];
}

function sortedJoin(tokens: string[]): string {
    return tokens.slice().sort().join('\u0001');
}

/**
 * Longest shared underscore-token prefix length.
 */
function sharedPrefixTokenCount(a: string[], b: string[]): number {
    const n = Math.min(a.length, b.length);
    let i = 0;
    for (; i < n; i++) {
        if (a[i] !== b[i]) break;
    }
    return i;
}

/**
 * True when multisets of tokens match (pure permutation).
 */
function isTokenPermutation(a: string[], b: string[]): boolean {
    if (a.length !== b.length || a.length === 0) return false;
    return sortedJoin(a) === sortedJoin(b);
}

/**
 * Base tokens = tokens until the first option-like token (from the right cluster).
 * Heuristic: strip trailing run of option-like tokens.
 */
function splitBaseAndOptions(toks: string[]): { base: string[]; options: string[] } {
    let i = toks.length;
    while (i > 0 && OPTION_LIKE_TOKENS.has(toks[i - 1])) {
        i -= 1;
    }
    // Keep multi-word option phrases like BEAM_OFFSET together as option side
    return { base: toks.slice(0, i), options: toks.slice(i) };
}

function maxEditDistForLength(len: number): number {
    if (len <= 8) return 1;
    if (len <= 20) return 2;
    return 3;
}

type Ranked = KeywordSuggestion & { dist: number; prefixTokens: number };

function rankAgainst(query: string, candidates: string[]): Ranked[] {
    const q = normalizeName(query);
    if (!q) return [];
    const qToks = tokensOf(q);
    const qLen = q.length;
    const maxDist = maxEditDistForLength(qLen);
    const out: Ranked[] = [];

    for (const raw of candidates) {
        const k = normalizeName(raw);
        if (!k || k === q) continue;

        const kToks = tokensOf(k);
        const prefixTokens = sharedPrefixTokenCount(qToks, kToks);

        // Family gate: require meaningful shared prefix for long names
        if (qToks.length >= 3) {
            if (prefixTokens < 2 && !isTokenPermutation(qToks, kToks)) continue;
        } else if (qToks.length >= 1) {
            if (kToks[0] !== qToks[0] && editDistance(q, k, 1) > 1) continue;
        }

        // Pure token permutation of same multiset → strong structural match
        if (isTokenPermutation(qToks, kToks)) {
            out.push({
                keyword: k,
                score: 100,
                reason: 'token-permutation',
                dist: 0,
                prefixTokens,
            });
            continue;
        }

        // Same base, option tokens are permutation or near (e.g. ID_OFFSET vs OFFSET_ID)
        const qSplit = splitBaseAndOptions(qToks);
        const kSplit = splitBaseAndOptions(kToks);
        if (
            qSplit.base.length >= 2
            && qSplit.base.join('_') === kSplit.base.join('_')
            && qSplit.options.length > 0
            && kSplit.options.length > 0
        ) {
            if (isTokenPermutation(qSplit.options, kSplit.options)) {
                out.push({
                    keyword: k,
                    score: 98,
                    reason: 'token-permutation',
                    dist: 0,
                    prefixTokens,
                });
                continue;
            }
            // Option multiset differs by at most one token and shared base is long
            const qOpt = sortedJoin(qSplit.options);
            const kOpt = sortedJoin(kSplit.options);
            if (qOpt !== kOpt && prefixTokens >= Math.min(4, qSplit.base.length)) {
                const optDist = editDistance(qSplit.options.join('_'), kSplit.options.join('_'), 4);
                if (optDist <= 3) {
                    out.push({
                        keyword: k,
                        score: 70 - optDist,
                        reason: 'family-near',
                        dist: optDist,
                        prefixTokens,
                    });
                }
            }
        }

        if (Math.abs(k.length - qLen) > maxDist + 1) continue;

        const dist = editDistance(q, k, maxDist);
        if (dist > maxDist) continue;

        // Prefer closer edit distance; boost shared prefix
        const score = 90 - dist * 12 + Math.min(10, prefixTokens * 2);
        out.push({
            keyword: k,
            score,
            reason: dist <= 1 ? 'edit-distance' : 'family-near',
            dist,
            prefixTokens,
        });
    }

    out.sort((a, b) => b.score - a.score || a.dist - b.dist || a.keyword.localeCompare(b.keyword));

    // Dedupe by keyword keeping best
    const seen = new Set<string>();
    const deduped: Ranked[] = [];
    for (const item of out) {
        if (seen.has(item.keyword)) continue;
        seen.add(item.keyword);
        deduped.push(item);
    }
    return deduped;
}

function toSuggestion(r: Ranked): KeywordSuggestion {
    return { keyword: r.keyword, score: r.score, reason: r.reason };
}

/**
 * Suggest similar keywords for an unknown / mistyped name.
 */
export function suggestSimilarKeywords(rawName: string, options: SuggestOptions = {}): SuggestResult {
    const query = normalizeName(rawName);
    if (!query) {
        return { tier: 'none', items: [] };
    }

    const candidates = resolveCandidates(options);
    const candidateSet = new Set(candidates);

    if (options.preferredKeyword) {
        const pref = normalizeName(options.preferredKeyword);
        if (pref && candidateSet.has(pref)) {
            return {
                tier: 'high',
                items: [{ keyword: pref, score: 100, reason: 'edit-distance' }],
            };
        }
    }

    // Exact hit is not "unknown" — callers usually skip; return none.
    if (candidateSet.has(query)) {
        return { tier: 'none', items: [] };
    }

    const ranked = rankAgainst(query, candidates);
    if (ranked.length === 0) {
        return { tier: 'none', items: [] };
    }

    const best = ranked[0];
    const maxMedium = options.maxMedium ?? 5;

    // High: single strong guess (edit distance ≤1 or full option-token permutation).
    if (best.reason === 'token-permutation' && best.score >= 98) {
        return { tier: 'high', items: [toSuggestion(best)] };
    }
    if (best.reason === 'edit-distance' && best.dist <= 1) {
        return { tier: 'high', items: [toSuggestion(best)] };
    }

    const mediumItems = ranked
        .filter(r => r.score >= 55 || r.dist <= 3)
        .slice(0, maxMedium)
        .map(toSuggestion);

    if (mediumItems.length === 0) {
        return { tier: 'none', items: [] };
    }
    if (mediumItems.length === 1 && (mediumItems[0].score >= 80 || ranked[0].dist <= 1)) {
        return { tier: 'high', items: mediumItems };
    }
    return { tier: 'medium', items: mediumItems };
}

export function isKnownKeywordName(rawName: string, options: SuggestOptions = {}): boolean {
    const name = normalizeName(rawName);
    if (!name) return false;
    const candidates = resolveCandidates(options);
    return candidates.includes(name);
}
