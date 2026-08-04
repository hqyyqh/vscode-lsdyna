'use strict';

/**
 * Pure helpers for Include Tree "Copy..." path/name options.
 * @module client/services/includeTreeCopy
 */

const path = require('path');

export type IncludeCopyChoiceId = 'basename' | 'workspaceRelative' | 'absolute';

export type IncludeCopyChoice = {
    id: IncludeCopyChoiceId;
    value: string;
};

export type BuildIncludeCopyChoicesOptions = {
    /**
     * Return a workspace-relative path for fsPath, or the absolute path / empty when unavailable.
     * When the result normalizes equal to the absolute path, the relative option is omitted.
     */
    asRelativePath?: (fsPath: string) => string | undefined | null;
};

/**
 * Normalize path for equality checks (slashes + trailing trim).
 *
 * @param {string} p
 * @returns {string}
 */
function normalizePathKey(p: string): string {
    return String(p || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase();
}

/**
 * Build clipboard copy choices for an include-tree file path.
 *
 * @param {string} filePath
 * @param {BuildIncludeCopyChoicesOptions} [options]
 * @returns {IncludeCopyChoice[]}
 */
export function buildIncludeCopyChoices(
    filePath: string,
    options: BuildIncludeCopyChoicesOptions = {},
): IncludeCopyChoice[] {
    const raw = String(filePath || '').trim();
    if (!raw) {
        return [];
    }

    const absolute = path.normalize(raw);
    const basename = path.basename(absolute);
    const choices: IncludeCopyChoice[] = [];

    if (basename) {
        choices.push({ id: 'basename', value: basename });
    }

    const asRelativePath = options.asRelativePath;
    if (typeof asRelativePath === 'function') {
        let rel: string | undefined | null;
        try {
            rel = asRelativePath(absolute);
        } catch {
            rel = undefined;
        }
        const relStr = rel == null ? '' : String(rel).trim();
        if (
            relStr
            && normalizePathKey(relStr) !== normalizePathKey(absolute)
        ) {
            choices.push({ id: 'workspaceRelative', value: relStr });
        }
    }

    choices.push({ id: 'absolute', value: absolute });
    return choices;
}

/**
 * Truncate a path for toast previews (keep start and end when long).
 *
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string}
 */
export function truncateForToast(text: string, maxLen = 80): string {
    const s = String(text || '');
    if (s.length <= maxLen) {
        return s;
    }
    if (maxLen < 8) {
        return s.slice(0, maxLen);
    }
    const keep = Math.floor((maxLen - 3) / 2);
    return `${s.slice(0, keep)}...${s.slice(s.length - keep)}`;
}

module.exports = {
    buildIncludeCopyChoices,
    truncateForToast,
};
