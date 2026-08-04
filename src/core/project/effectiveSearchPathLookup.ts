'use strict';

/**
 * @fileoverview Lookup effective *INCLUDE* search paths from project snapshots.
 * @module core/project/effectiveSearchPathLookup
 *
 * After a main-job index, each file has an effective search-path list (local dir +
 * local PATH cards + ancestor PATH cards). Editor features should prefer that list
 * when a snapshot is available; otherwise fall back to file-local scan paths.
 */

const path = require('path');

/**
 * Normalize a file path for Map keys (absolute + win32 lower-case).
 */
export function normalizeSearchPathFileKey(filePath: string): string {
    if (!filePath) return '';
    const resolved = path.resolve(String(filePath));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Read effective paths for one file from a single snapshot, or null if unknown.
 */
export function getEffectiveSearchPathsFromSnapshot(
    filePath: string,
    snapshot: {
        effectiveSearchPathsByFile?: Map<string, string[]> | Array<[string, string[]]>;
        files?: string[];
    } | null | undefined
): string[] | null {
    if (!filePath || !snapshot) return null;
    const fileKey = normalizeSearchPathFileKey(filePath);
    const raw = snapshot.effectiveSearchPathsByFile;
    if (!raw) return null;

    const map = raw instanceof Map ? raw : new Map(Array.isArray(raw) ? raw : []);
    if (map.has(filePath)) {
        const paths = map.get(filePath);
        return Array.isArray(paths) && paths.length ? paths : null;
    }
    for (const [entryPath, paths] of map.entries()) {
        if (normalizeSearchPathFileKey(entryPath) === fileKey) {
            return Array.isArray(paths) && paths.length ? paths : null;
        }
    }
    return null;
}

/**
 * Use an exact root match, a unique containing root, or identical paths shared by
 * every containing root. Never choose a load case from cache order.
 *
 * @param {string} filePath
 * @param {Array<object>} snapshots - Ordered preferred-first.
 * @returns {string[]|null}
 */
export function lookupEffectiveSearchPaths(
    filePath: string,
    snapshots: Array<{
        rootFile?: string;
        effectiveSearchPathsByFile?: Map<string, string[]> | Array<[string, string[]]>;
    }> = []
): string[] | null {
    if (!filePath || !Array.isArray(snapshots)) return null;
    const fileKey = normalizeSearchPathFileKey(filePath);
    const exactRoot = snapshots.find(snapshot =>
        normalizeSearchPathFileKey(snapshot && snapshot.rootFile || '') === fileKey
    );
    if (exactRoot) {
        return getEffectiveSearchPathsFromSnapshot(filePath, exactRoot);
    }
    const matches = snapshots
        .map(snapshot => getEffectiveSearchPathsFromSnapshot(filePath, snapshot))
        .filter(paths => Array.isArray(paths) && paths.length) as string[][];
    if (matches.length === 0) return null;
    const signature = (paths) => paths.map(normalizeSearchPathFileKey).join('\0');
    return matches.every(paths => signature(paths) === signature(matches[0]))
        ? matches[0]
        : null;
}

/**
 * In-memory multi-root cache with ambiguity-safe lookup.
 */
export function createEffectiveSearchPathCache() {
    /** @type {Array<{ rootKey: string, rootFile: string, pathsByFile: Map<string, string[]> }>} */
    const roots: Array<{
        rootKey: string;
        rootFile: string;
        pathsByFile: Map<string, string[]>;
    }> = [];

    function cacheFromSnapshot(snapshot: {
        rootFile?: string;
        effectiveSearchPathsByFile?: Map<string, string[]> | Array<[string, string[]]>;
    } | null | undefined) {
        if (!snapshot || !snapshot.rootFile) return;
        const rootFile = path.resolve(snapshot.rootFile);
        const rootKey = normalizeSearchPathFileKey(rootFile);
        const pathsByFile = new Map<string, string[]>();
        const raw = snapshot.effectiveSearchPathsByFile;
        const entries = raw instanceof Map
            ? raw.entries()
            : (Array.isArray(raw) ? raw : []);
        for (const [filePath, paths] of entries) {
            if (!filePath || !Array.isArray(paths) || !paths.length) continue;
            pathsByFile.set(normalizeSearchPathFileKey(filePath), paths);
        }
        const next = roots.filter(r => r.rootKey !== rootKey);
        next.unshift({ rootKey, rootFile, pathsByFile });
        roots.length = 0;
        roots.push(...next);
    }

    function lookup(filePath: string): string[] | null {
        if (!filePath) return null;
        const fileKey = normalizeSearchPathFileKey(filePath);
        const exactRoot = roots.find(root => root.rootKey === fileKey);
        if (exactRoot && exactRoot.pathsByFile.has(fileKey)) {
            return exactRoot.pathsByFile.get(fileKey) || null;
        }
        const matches = roots
            .map(root => root.pathsByFile.get(fileKey))
            .filter(paths => Array.isArray(paths) && paths.length) as string[][];
        if (matches.length === 0) return null;
        const signature = (paths) => paths.map(normalizeSearchPathFileKey).join('\0');
        return matches.every(paths => signature(paths) === signature(matches[0]))
            ? matches[0]
            : null;
    }

    function lookupForRoot(filePath: string, rootFile: string): string[] | null {
        if (!filePath || !rootFile) return null;
        const fileKey = normalizeSearchPathFileKey(filePath);
        const rootKey = normalizeSearchPathFileKey(rootFile);
        const root = roots.find(candidate => candidate.rootKey === rootKey);
        if (!root) return null;
        return root.pathsByFile.get(fileKey) || null;
    }

    function clearRoot(rootFile: string) {
        if (!rootFile) return;
        const rootKey = normalizeSearchPathFileKey(rootFile);
        const next = roots.filter(r => r.rootKey !== rootKey);
        roots.length = 0;
        roots.push(...next);
    }

    function clearAll() {
        roots.length = 0;
    }

    function listRoots(): string[] {
        return roots.map(r => r.rootFile);
    }

    return {
        cacheFromSnapshot,
        lookup,
        lookupForRoot,
        clearRoot,
        clearAll,
        listRoots,
    };
}

/**
 * Compare PATH card lists (absolute searchPath) for graphUpdater full-rebuild gate.
 */
export function pathCardsChanged(
    oldPathEntries: Array<{ searchPath?: string; pathName?: string }> | null | undefined,
    newPathEntries: Array<{ searchPath?: string; pathName?: string }> | null | undefined
): boolean {
    const normalize = (entries) => {
        const list = [];
        for (const e of entries || []) {
            if (!e) continue;
            const p = e.searchPath || e.pathName;
            if (!p) continue;
            list.push(path.normalize(String(p)));
        }
        return list.join('\0');
    };
    return normalize(oldPathEntries) !== normalize(newPathEntries);
}

module.exports = {
    normalizeSearchPathFileKey,
    getEffectiveSearchPathsFromSnapshot,
    lookupEffectiveSearchPaths,
    createEffectiveSearchPathCache,
    pathCardsChanged,
};

export {};
