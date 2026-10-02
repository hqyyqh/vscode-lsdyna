'use strict';

/**
 * @fileoverview Cross-platform include path case fidelity checks.
 * @module core/fs/pathCaseFidelity
 *
 * OS resolve follows the host filesystem (case-insensitive on typical Windows NTFS).
 * Case fidelity walks directory entries and compares path segments literally so
 * Win-authored decks can surface Linux LS-DYNA include failures early.
 */

const fs = require('fs');
const path = require('path');

export type PathCaseSegmentDiff = {
    index: number;
    deck: string;
    disk: string;
};

export type PathCaseCheckResult =
    | { status: 'exact'; resolvedPath: string; realPath: string }
    | { status: 'case-mismatch'; resolvedPath: string; realPath: string; diffs: PathCaseSegmentDiff[]; deckRelative: string; diskRelative: string }
    | { status: 'missing' }
    | { status: 'skipped'; reason: 'io-error' | 'ambiguous-segment'; detail?: string };

export type PathCaseFs = {
    access: (target: string, mode?: number) => Promise<void>;
    readdir: (dir: string, options: { withFileTypes: true }) => Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;
};

export type PathCaseCheckMode = 'crossPlatform' | 'off' | 'strict';

const defaultFs: PathCaseFs = {
    access: (target, mode) => fs.promises.access(target, mode ?? fs.constants.F_OK),
    readdir: (dir, options) => fs.promises.readdir(dir, options) as Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>,
};

function splitPathSegments(fileName: string): string[] {
    return String(fileName || '')
        .replace(/\\/g, '/')
        .split('/')
        .filter(segment => segment.length > 0 && segment !== '.');
}

function joinRelative(segments: string[], preferBackslash: boolean): string {
    const sep = preferBackslash ? '\\' : '/';
    return segments.join(sep);
}

function prefersBackslash(fileName: string): boolean {
    return String(fileName || '').includes('\\') && !String(fileName || '').includes('/');
}

/**
 * Resolve fileName against searchPaths using OS existence checks (host FS semantics).
 */
export async function resolveIncludeOsPath(
    fileName: string,
    searchPaths: string[],
    io: PathCaseFs = defaultFs
): Promise<string | null> {
    for (const searchPath of searchPaths || []) {
        if (!searchPath) continue;
        const fullPath = path.resolve(searchPath, fileName);
        try {
            await io.access(fullPath, fs.constants.F_OK);
            return fullPath;
        } catch (_error) {
            // continue
        }
    }
    return null;
}

/**
 * Walk from absoluteRoot, matching each deck segment case-insensitively against
 * directory entries, recording literal casing differences.
 */
export async function comparePathSegmentsToDisk(
    absoluteRoot: string,
    deckSegments: string[],
    io: PathCaseFs = defaultFs
): Promise<
    | { status: 'exact' | 'case-mismatch'; realSegments: string[]; diffs: PathCaseSegmentDiff[] }
    | { status: 'skipped'; reason: 'io-error' | 'ambiguous-segment'; detail?: string }
> {
    const diffs: PathCaseSegmentDiff[] = [];
    const realSegments: string[] = [];
    let current = absoluteRoot;

    for (let index = 0; index < deckSegments.length; index++) {
        const deckSeg = deckSegments[index];
        let entries: Array<{ name: string }>;
        try {
            entries = await io.readdir(current, { withFileTypes: true });
        } catch (error) {
            return {
                status: 'skipped',
                reason: 'io-error',
                detail: error instanceof Error ? error.message : String(error),
            };
        }

        const lower = deckSeg.toLowerCase();
        const matches = entries.filter(entry => entry.name.toLowerCase() === lower);
        if (matches.length === 0) {
            return {
                status: 'skipped',
                reason: 'io-error',
                detail: `segment not listed: ${deckSeg}`,
            };
        }
        if (matches.length > 1) {
            // Prefer exact match if present among case variants.
            const exact = matches.find(entry => entry.name === deckSeg);
            if (!exact) {
                return {
                    status: 'skipped',
                    reason: 'ambiguous-segment',
                    detail: deckSeg,
                };
            }
            realSegments.push(exact.name);
            current = path.join(current, exact.name);
            continue;
        }

        const diskSeg = matches[0].name;
        realSegments.push(diskSeg);
        if (diskSeg !== deckSeg) {
            diffs.push({ index, deck: deckSeg, disk: diskSeg });
        }
        current = path.join(current, diskSeg);
    }

    return {
        status: diffs.length ? 'case-mismatch' : 'exact',
        realSegments,
        diffs,
    };
}

/**
 * OS-resolve include/path text, then verify literal segment casing against disk.
 *
 * @param fileName Deck-literal relative or absolute path (as written after continuation join).
 * @param searchPaths Ordered search roots (include: parent search paths; path directives: [base]).
 */
export async function resolveIncludeWithCaseCheck(
    fileName: string,
    searchPaths: string[],
    options: { fs?: PathCaseFs } = {}
): Promise<PathCaseCheckResult> {
    const io = options.fs || defaultFs;
    const raw = String(fileName || '').trim();
    if (!raw) return { status: 'missing' };

    const resolvedPath = await resolveIncludeOsPath(raw, searchPaths, io);
    if (!resolvedPath) return { status: 'missing' };

    // Absolute deck paths: compare trailing segments under path.parse root.
    const isAbs = path.isAbsolute(raw);
    let rootForWalk: string;
    let deckSegments: string[];

    if (isAbs) {
        const parsed = path.parse(path.normalize(raw));
        rootForWalk = parsed.root;
        deckSegments = splitPathSegments(raw.slice(parsed.root.length));
        // Drive letter casing alone is ignored by not comparing root.
    } else {
        // Find which search root was used (first successful root).
        rootForWalk = '';
        for (const searchPath of searchPaths || []) {
            if (!searchPath) continue;
            const candidate = path.resolve(searchPath, raw);
            if (path.normalize(candidate) === path.normalize(resolvedPath)
                || (process.platform === 'win32'
                    && candidate.toLowerCase() === resolvedPath.toLowerCase())) {
                rootForWalk = path.resolve(searchPath);
                break;
            }
        }
        if (!rootForWalk) {
            rootForWalk = path.dirname(resolvedPath);
            deckSegments = [path.basename(raw)];
        } else {
            deckSegments = splitPathSegments(raw);
        }
    }

    if (deckSegments.length === 0) {
        return { status: 'exact', resolvedPath, realPath: resolvedPath };
    }

    const comparison = await comparePathSegmentsToDisk(rootForWalk, deckSegments, io);
    if (comparison.status === 'skipped') {
        return { status: 'skipped', reason: comparison.reason, detail: comparison.detail };
    }

    const preferBs = prefersBackslash(raw);
    const diskRelative = isAbs
        ? path.join(path.parse(path.normalize(raw)).root, ...comparison.realSegments)
        : joinRelative(comparison.realSegments, preferBs);
    const deckRelative = isAbs ? raw : joinRelative(deckSegments, preferBs);
    const realPath = isAbs
        ? path.normalize(diskRelative)
        : path.resolve(rootForWalk, ...comparison.realSegments);

    if (comparison.status === 'exact') {
        return { status: 'exact', resolvedPath, realPath };
    }

    return {
        status: 'case-mismatch',
        resolvedPath,
        realPath,
        diffs: comparison.diffs,
        deckRelative,
        diskRelative,
    };
}

/**
 * Whether OS-resolved path should be treated as a successful navigation target.
 */
export function isIncludeResolveAccepted(
    result: PathCaseCheckResult,
    mode: PathCaseCheckMode
): boolean {
    if (!result || result.status === 'missing') return false;
    if (result.status === 'case-mismatch' && mode === 'strict') return false;
    return result.status === 'exact' || result.status === 'case-mismatch' || result.status === 'skipped';
}

export function normalizePathCaseCheckMode(value: unknown): PathCaseCheckMode {
    if (value === 'off' || value === 'strict' || value === 'crossPlatform') return value;
    return 'crossPlatform';
}

module.exports = {
    resolveIncludeWithCaseCheck,
    resolveIncludeOsPath,
    comparePathSegmentsToDisk,
    isIncludeResolveAccepted,
    normalizePathCaseCheckMode,
    splitPathSegments,
};

export {};
