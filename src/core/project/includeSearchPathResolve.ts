'use strict';

/**
 * @fileoverview Merge local and ancestor *INCLUDE_PATH* directories for vehicle decks.
 * @module core/project/includeSearchPathResolve
 *
 * Expert rule: paths declared on the main job (or an ancestor setup file) apply to
 * child includes. Without a root scan context, callers use file-local paths only.
 */

const path = require('path');

/**
 * Stable path key for dedupe (normalize + lowercase drive/path on win32).
 */
export function searchPathKey(p: string): string {
    if (!p) return '';
    let n = path.normalize(String(p));
    if (process.platform === 'win32') {
        n = n.replace(/\//g, '\\').toLowerCase();
    }
    return n;
}

/**
 * Deduplicate paths preserving first-seen order.
 */
export function uniqueSearchPaths(paths: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of paths || []) {
        if (!raw) continue;
        const resolved = path.normalize(String(raw));
        const key = searchPathKey(resolved);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(resolved);
    }
    return out;
}

/**
 * Extract *INCLUDE_PATH* card directories from a scanner searchPaths list.
 * Scanner convention: searchPaths[0] is dirname(file); remaining entries are declared paths.
 *
 * Prefer pathEntries when available (explicit card absolutes).
 */
export function localDeclaredSearchPaths(params: {
    fileDir: string;
    searchPaths?: string[];
    pathEntries?: Array<{ searchPath?: string }>;
}): string[] {
    const fileDir = path.normalize(params.fileDir || '');
    const fileKey = searchPathKey(fileDir);

    if (params.pathEntries && params.pathEntries.length) {
        const fromCards: string[] = [];
        for (const e of params.pathEntries) {
            if (e && e.searchPath) fromCards.push(e.searchPath);
        }
        return uniqueSearchPaths(fromCards);
    }

    const list = params.searchPaths || [];
    if (!list.length) return [];

    // Drop leading entries that are the file directory (scanner always seeds dirname).
    let start = 0;
    if (searchPathKey(list[0]) === fileKey) {
        start = 1;
    }
    return uniqueSearchPaths(list.slice(start));
}

/**
 * Build the effective search path list for resolving *INCLUDE names in file F.
 *
 * Order (expert-stable):
 * 1. dirname(F)
 * 2. PATH cards declared in F (file order)
 * 3. inherited PATH cards from ancestors (nearest parent first — caller supplies order)
 *
 * Inherited must be absolute directories already resolved at the declaring file.
 * Do not put ancestor dirnames into inherited (only explicit INCLUDE_PATH cards).
 */
export function mergeEffectiveSearchPaths(params: {
    fileDir: string;
    localDeclaredPaths?: string[];
    inheritedPaths?: string[];
}): string[] {
    const fileDir = path.normalize(params.fileDir || '.');
    return uniqueSearchPaths([
        fileDir,
        ...(params.localDeclaredPaths || []),
        ...(params.inheritedPaths || []),
    ]);
}

/**
 * Paths to pass to a child include as its inherited list:
 * this file's declared PATH cards + what this file already inherited.
 * (Nearest ancestor contributions first when localDeclared is prepended.)
 */
export function inheritedPathsForChild(params: {
    localDeclaredPaths?: string[];
    inheritedPaths?: string[];
}): string[] {
    // Nearest first: current file's PATH cards, then what parent already inherited.
    return uniqueSearchPaths([
        ...(params.localDeclaredPaths || []),
        ...(params.inheritedPaths || []),
    ]);
}

/**
 * Convenience: effective paths from a single-file scanner result + optional inheritance.
 */
export function effectiveSearchPathsFromScan(params: {
    filePath: string;
    searchPaths?: string[];
    pathEntries?: Array<{ searchPath?: string }>;
    inheritedPaths?: string[];
}): string[] {
    const fileDir = path.dirname(path.normalize(params.filePath));
    const localDeclared = localDeclaredSearchPaths({
        fileDir,
        searchPaths: params.searchPaths,
        pathEntries: params.pathEntries,
    });
    return mergeEffectiveSearchPaths({
        fileDir,
        localDeclaredPaths: localDeclared,
        inheritedPaths: params.inheritedPaths,
    });
}

module.exports = {
    searchPathKey,
    uniqueSearchPaths,
    localDeclaredSearchPaths,
    mergeEffectiveSearchPaths,
    inheritedPathsForChild,
    effectiveSearchPathsFromScan,
};

export {};
