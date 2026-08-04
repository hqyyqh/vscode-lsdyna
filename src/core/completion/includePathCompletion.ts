'use strict';

/**
 * @fileoverview Include-path completion: browse-by-level (B) + name search (A).
 * @module core/completion/includePathCompletion
 *
 * Vehicle-model intuition: type `/` or `\` to walk search roots level by level;
 * type a bare filename to search with full relative paths in the label.
 * Inserted text always uses forward slashes.
 */

const fs = require('fs');
const path = require('path');
const {
    getIncludeDirectiveRule,
    isIncludeFilenameDataLine,
} = require('../parser/includeDirectiveRules');
const { scoreFuzzyText } = require('../search/lsdynaTextMatch');

/** Directory names skipped while browsing or walking. */
export const IGNORE_DIR_NAMES = new Set([
    'node_modules',
    'venv',
    '.git',
    '.github',
    '.vscode',
    'build',
    'dist',
    'out',
    'target',
]);

export const DEFAULT_SEARCH_MAX_DEPTH = 4;
export const DEFAULT_SEARCH_MAX_FILES = 400;
export const DEFAULT_SEARCH_TOP_N = 40;

export type IncludePathMode = 'browse' | 'search';

export type NormalizedIncludePrefix = {
    raw: string;
    norm: string;
    dirPrefix: string;
    namePrefix: string;
    mode: IncludePathMode;
};

export type IncludePathEntryKind = 'file' | 'directory';

export type IncludePathEntry = {
    kind: IncludePathEntryKind;
    /** Relative path using `/`; directories end with `/`. */
    relPath: string;
    /** Absolute search root this entry was found under. */
    searchRoot: string;
    score?: number;
};

export type ResolveSearchDirsOptions = {
    existsSync?: (p: string) => boolean;
    statSync?: (p: string) => { isDirectory(): boolean };
};

export type ListBrowseOptions = {
    readdirSync?: (dir: string, opts: { withFileTypes: true }) => Array<{
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
    }>;
};

export type ListSearchOptions = {
    readdirSync?: ListBrowseOptions['readdirSync'];
    maxDepth?: number;
    maxFiles?: number;
    topN?: number;
};

const browsePathCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
});

/**
 * Normalize a typed include prefix for matching and mode selection.
 * Backslashes become `/`; a single leading `./` is stripped; leading `/` is treated as root-relative.
 */
export function normalizeIncludePathPrefix(prefix: string): NormalizedIncludePrefix {
    const raw = String(prefix || '');
    // Completely empty card: Mode A with empty query → no candidates (do not dump tree).
    // Browse root is entered only when the user types / \ or ./ (trigger characters).
    if (!raw.trim()) {
        return { raw, norm: '', dirPrefix: '', namePrefix: '', mode: 'search' };
    }

    let norm = raw.replace(/\\/g, '/');
    // Preserve the user's explicit intent before removing root-relative prefixes.
    // `/mat`, `\mat`, `./mat`, and `.\mat` must stay in browse mode while typing.
    const explicitlyBrowsing = norm.startsWith('/') || norm.startsWith('./');

    // Treat leading "./" as relative root (common when users type ./sub/...)
    while (norm.startsWith('./')) {
        norm = norm.slice(2);
    }
    // Leading "/" means "from search root", not disk absolute, for deck paths.
    if (norm.startsWith('/')) {
        norm = norm.slice(1);
    }

    const hasSlash = norm.includes('/');
    // Empty after normalize (user typed only / \ ./) → browse root.
    if (!norm) {
        return { raw, norm: '', dirPrefix: '', namePrefix: '', mode: 'browse' };
    }

    if (!explicitlyBrowsing && !hasSlash) {
        return { raw, norm, dirPrefix: '', namePrefix: norm, mode: 'search' };
    }

    const lastSlash = norm.lastIndexOf('/');
    const dirPrefix = norm.slice(0, lastSlash + 1);
    const namePrefix = norm.slice(lastSlash + 1);
    return { raw, norm, dirPrefix, namePrefix, mode: 'browse' };
}

/**
 * Directory-first, case-insensitive natural ordering for one-level browse results.
 */
export function compareBrowseEntries(a: IncludePathEntry, b: IncludePathEntry): number {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;

    const natural = browsePathCollator.compare(a.relPath, b.relPath);
    if (natural !== 0) return natural;

    // Stable deterministic fallback when the primary collator treats names as equivalent.
    return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
}

/**
 * Resolve configured search path strings to existing directories on disk.
 */
export function resolveValidSearchDirs(
    searchPaths: string[],
    documentDir: string,
    options: ResolveSearchDirsOptions = {},
): string[] {
    const existsSync = options.existsSync || fs.existsSync;
    const statSync = options.statSync || fs.statSync;
    const valid: string[] = [];
    const seen = new Set<string>();

    for (const p of searchPaths || []) {
        if (!p) continue;
        let targetPath = p;
        if (!path.isAbsolute(p)) {
            targetPath = path.resolve(documentDir, p);
        }
        try {
            if (!existsSync(targetPath)) continue;
            const stats = statSync(targetPath);
            if (!stats.isDirectory()) continue;
            const key = path.normalize(targetPath);
            if (seen.has(key)) continue;
            seen.add(key);
            valid.push(targetPath);
        } catch (_e) {
            // ignore missing / inaccessible roots
        }
    }
    return valid;
}

function shouldSkipDirName(name: string): boolean {
    if (!name || name.startsWith('.')) return true;
    return IGNORE_DIR_NAMES.has(name);
}

function nameMatchesPrefix(name: string, namePrefix: string): boolean {
    if (!namePrefix) return true;
    const n = name.toLowerCase();
    const q = namePrefix.toLowerCase();
    if (n.startsWith(q)) return true;
    // Light fuzzy for long names (vehicle LC_Frontal style)
    return scoreFuzzyText(namePrefix, name) >= 70;
}

/**
 * Mode B: list one directory level under each search root for dirPrefix.
 */
export function listBrowseLevel(
    searchRoots: string[],
    dirPrefix: string,
    namePrefix: string,
    options: ListBrowseOptions = {},
): IncludePathEntry[] {
    const readdirSync = options.readdirSync || ((dir, opts) => fs.readdirSync(dir, opts));
    const byRel = new Map<string, IncludePathEntry>();

    const relDir = String(dirPrefix || '').replace(/\\/g, '/');
    // Ensure dir prefix form: '' or 'foo/' or 'foo/bar/'
    const normalizedDir =
        !relDir ? '' : relDir.endsWith('/') ? relDir : relDir + '/';

    for (const root of searchRoots || []) {
        const absDir = normalizedDir
            ? path.join(root, ...normalizedDir.split('/').filter(Boolean))
            : root;
        let entries;
        try {
            entries = readdirSync(absDir, { withFileTypes: true });
        } catch (_e) {
            continue;
        }
        for (const entry of entries) {
            const name = entry.name;
            if (shouldSkipDirName(name) && entry.isDirectory()) continue;
            if (name.startsWith('.')) continue;
            if (!nameMatchesPrefix(name, namePrefix)) continue;

            let relPath: string;
            let kind: IncludePathEntryKind;
            if (entry.isDirectory()) {
                kind = 'directory';
                relPath = normalizedDir + name + '/';
            } else if (entry.isFile()) {
                kind = 'file';
                relPath = normalizedDir + name;
            } else {
                continue;
            }

            const existing = byRel.get(relPath);
            if (!existing) {
                byRel.set(relPath, { kind, relPath, searchRoot: root });
            }
            // Prefer first search root order for detail; keep first.
        }
    }

    const list = Array.from(byRel.values());
    list.sort(compareBrowseEntries);
    return list;
}

/**
 * Score a candidate relative path against a search query (Mode A).
 * Higher is better; 0 = no match.
 */
export function scoreIncludeCandidate(query: string, relPath: string): number {
    const q = String(query || '').trim().replace(/\\/g, '/');
    if (!q) return 1;
    const rel = String(relPath || '').replace(/\\/g, '/');
    if (!rel) return 0;

    const qLower = q.toLowerCase();
    const relLower = rel.toLowerCase();
    const base = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
    const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
    const baseLower = base.toLowerCase();
    const stemLower = stem.toLowerCase();

    let best = 0;
    const bump = (n: number) => {
        if (n > best) best = n;
    };

    if (relLower === qLower) bump(100);
    if (relLower.startsWith(qLower)) bump(95);
    if (baseLower === qLower || stemLower === qLower) bump(92);
    if (baseLower.startsWith(qLower) || stemLower.startsWith(qLower)) bump(88);
    if (qLower.length >= 2 && relLower.includes(qLower)) bump(75);

    const fuzzyBase = scoreFuzzyText(q, base);
    const fuzzyStem = scoreFuzzyText(q, stem);
    const fuzzyRel = scoreFuzzyText(q, rel);
    if (fuzzyBase > 0) bump(Math.min(85, 50 + fuzzyBase * 0.35));
    if (fuzzyStem > 0) bump(Math.min(84, 48 + fuzzyStem * 0.35));
    if (fuzzyRel > 0) bump(Math.min(70, 40 + fuzzyRel * 0.25));

    return best;
}

/**
 * Mode A: walk search roots and return top-N file matches by score.
 * Empty query returns [] (never dump the whole tree).
 */
export function listSearchByName(
    searchRoots: string[],
    query: string,
    options: ListSearchOptions = {},
): IncludePathEntry[] {
    const q = String(query || '').trim().replace(/\\/g, '/');
    if (!q) return [];

    const readdirSync = options.readdirSync || ((dir, opts) => fs.readdirSync(dir, opts));
    const maxDepth = options.maxDepth ?? DEFAULT_SEARCH_MAX_DEPTH;
    const maxFiles = options.maxFiles ?? DEFAULT_SEARCH_MAX_FILES;
    const topN = options.topN ?? DEFAULT_SEARCH_TOP_N;

    const found: IncludePathEntry[] = [];
    let fileCount = 0;

    function walk(dir: string, baseDir: string, depth: number) {
        if (depth > maxDepth || fileCount >= maxFiles) return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch (_e) {
            return;
        }
        for (const entry of entries) {
            if (fileCount >= maxFiles) break;
            const name = entry.name;
            if (name.startsWith('.')) continue;
            const full = path.join(dir, name);
            if (entry.isDirectory()) {
                if (shouldSkipDirName(name)) continue;
                walk(full, baseDir, depth + 1);
            } else if (entry.isFile()) {
                fileCount += 1;
                const relPath = path.relative(baseDir, full).replace(/\\/g, '/');
                const score = scoreIncludeCandidate(q, relPath);
                if (score > 0) {
                    found.push({ kind: 'file', relPath, searchRoot: baseDir, score });
                }
            }
        }
    }

    for (const root of searchRoots || []) {
        if (fileCount >= maxFiles) break;
        walk(root, root, 0);
    }

    // Dedupe by relPath keeping highest score / first root
    const byRel = new Map<string, IncludePathEntry>();
    for (const e of found) {
        const prev = byRel.get(e.relPath);
        if (!prev || (e.score || 0) > (prev.score || 0)) {
            byRel.set(e.relPath, e);
        }
    }

    return Array.from(byRel.values())
        .sort((a, b) => {
            const ds = (b.score || 0) - (a.score || 0);
            if (ds !== 0) return ds;
            return a.relPath.localeCompare(b.relPath, undefined, { sensitivity: 'base' });
        })
        .slice(0, topN);
}

/**
 * Collect include path candidates for the current typed prefix.
 */
export function collectIncludePathEntries(
    searchRoots: string[],
    prefix: string,
    options: ListBrowseOptions & ListSearchOptions = {},
): { mode: IncludePathMode; entries: IncludePathEntry[]; normalized: NormalizedIncludePrefix } {
    const normalized = normalizeIncludePathPrefix(prefix);
    if (normalized.mode === 'browse') {
        return {
            mode: 'browse',
            normalized,
            entries: listBrowseLevel(
                searchRoots,
                normalized.dirPrefix,
                normalized.namePrefix,
                options,
            ),
        };
    }
    return {
        mode: 'search',
        normalized,
        entries: listSearchByName(searchRoots, normalized.namePrefix, options),
    };
}

/**
 * Whether the line/position is a valid *INCLUDE filename card for completion.
 * Pure check over line texts (testable without full VS Code document).
 *
 * Aligns with includeScanner: only the filename data card (or ` +` continuation)
 * under multi-card keywords such as *INCLUDE_TRANSFORM; not offset/scale cards.
 */
export function isIncludeFilenameLineContext(params: {
    lineText: string;
    positionCharacter: number;
    /** Lines from document start through the current line (inclusive), for keyword backtrack. */
    linesBeforeAndCurrent: string[];
    isKeywordLineText: (text: string) => boolean;
    classifyKeywordLine: (text: string) => { normalizedKeyword: string };
}): boolean {
    const {
        lineText,
        positionCharacter,
        linesBeforeAndCurrent,
        isKeywordLineText,
        classifyKeywordLine,
    } = params;

    // Empty string is a valid empty filename card; only reject non-strings / comments.
    if (typeof lineText !== 'string') return false;
    if (lineText.trimStart().startsWith('$')) return false;

    const trimmedStart = lineText.length - lineText.trimStart().length;
    if (positionCharacter < trimmedStart) return false;

    const currentIndex = linesBeforeAndCurrent.length - 1;
    let kwLine = -1;
    for (let i = currentIndex; i >= 0; i--) {
        if (isKeywordLineText(linesBeforeAndCurrent[i])) {
            kwLine = i;
            break;
        }
    }
    if (kwLine === -1 || currentIndex === kwLine) return false;

    const kwText = classifyKeywordLine(linesBeforeAndCurrent[kwLine]).normalizedKeyword;
    const rule = getIncludeDirectiveRule(kwText);
    if (!rule) return false;

    return isIncludeFilenameDataLine({
        lines: linesBeforeAndCurrent,
        kwLine,
        currentIndex,
        rule,
    });
}

module.exports = {
    IGNORE_DIR_NAMES,
    DEFAULT_SEARCH_MAX_DEPTH,
    DEFAULT_SEARCH_MAX_FILES,
    DEFAULT_SEARCH_TOP_N,
    compareBrowseEntries,
    normalizeIncludePathPrefix,
    resolveValidSearchDirs,
    listBrowseLevel,
    listSearchByName,
    scoreIncludeCandidate,
    collectIncludePathEntries,
    isIncludeFilenameLineContext,
};

export {};
