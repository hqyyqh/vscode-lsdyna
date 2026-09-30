'use strict';

import {
    classifyInlineCommentedKeyword,
    classifyOpaqueCommentDirective,
} from '../parser/opaqueCommentRange';

export type ToggleLineKind =
    | 'code'
    | 'line-comment'
    | 'keyword'
    | 'disabled-keyword'
    | 'blank'
    | 'field-header'
    | 'opaque-control'
    | 'opaque-body'
    | 'unknown';

export type ToggleLineEntry = {
    line: number;
    text: string;
    kind?: ToggleLineKind;
};

export type LineCommentEdit = {
    line: number;
    type: 'insert' | 'delete' | 'insert-keyword-comment' | 'delete-keyword-comment';
    endCharacter?: number;
};

export type LineCommentPlan = {
    status: 'ready' | 'noop' | 'rejected';
    mode: 'comment' | 'uncomment' | 'noop';
    edits: LineCommentEdit[];
    eligibleLineCount: number;
    reason?: string;
};

export const LINE_COMMENT_TOGGLE_LIMITS = Object.freeze({
    maxSelectedLines: 10_000,
    maxEdits: 10_000,
    maxSelectedCharacters: 8 * 1024 * 1024,
    maxSingleLineCharacters: 64 * 1024,
});

function inferKind(text: string): ToggleLineKind {
    if (classifyInlineCommentedKeyword(text)) return 'disabled-keyword';
    if (classifyOpaqueCommentDirective(text)) return 'opaque-control';
    if (/^\*[A-Za-z0-9_]/.test(text)) return 'keyword';
    if (/^[ \t]*\$#/.test(text)) return 'field-header';
    if (/^[ \t]*$/.test(text)) return 'blank';
    if (text.startsWith('$')) return 'line-comment';
    return 'code';
}

function rejected(reason: string): LineCommentPlan {
    return {
        status: 'rejected',
        mode: 'noop',
        edits: [],
        eligibleLineCount: 0,
        reason,
    };
}

/** Pure, deterministic planner for LS-DYNA column-zero `$` toggles. */
export function planLineCommentToggle(
    lineEntries: ToggleLineEntry[] = [],
    limits: Partial<typeof LINE_COMMENT_TOGGLE_LIMITS> = {},
): LineCommentPlan {
    const budget = { ...LINE_COMMENT_TOGGLE_LIMITS, ...limits };
    const byLine = new Map<number, ToggleLineEntry>();

    for (const entry of lineEntries || []) {
        if (!entry || !Number.isInteger(entry.line) || entry.line < 0 || typeof entry.text !== 'string') {
            return rejected('invalid-entry');
        }
        if (entry.text.length > budget.maxSingleLineCharacters) return rejected('line-too-long');
        const normalizedEntry = { ...entry, kind: entry.kind || inferKind(entry.text) };
        const previous = byLine.get(entry.line);
        if (previous && (previous.text !== normalizedEntry.text || previous.kind !== normalizedEntry.kind)) {
            return rejected('invalid-entry');
        }
        if (!previous) byLine.set(entry.line, normalizedEntry);
        if (byLine.size > budget.maxSelectedLines) return rejected('selection-budget-exceeded');
    }

    const entries = [...byLine.values()].sort((left, right) => left.line - right.line);
    if (entries.length > budget.maxSelectedLines) return rejected('selection-budget-exceeded');
    const selectedCharacters = entries.reduce((sum, entry) => sum + entry.text.length, 0);
    if (selectedCharacters > budget.maxSelectedCharacters) return rejected('character-budget-exceeded');

    const keywordEligible = [];
    const lineEligible = [];
    for (const entry of entries) {
        const kind = entry.kind || inferKind(entry.text);
        if (![
            'code', 'line-comment', 'keyword', 'disabled-keyword', 'blank', 'field-header',
            'opaque-control', 'opaque-body', 'unknown',
        ].includes(kind)) return rejected('invalid-entry');
        if (kind === 'unknown') return rejected('opaque-state-unknown');
        if (kind === 'keyword' || kind === 'disabled-keyword') {
            keywordEligible.push({ ...entry, kind });
        } else if (kind === 'code' || kind === 'line-comment' || kind === 'field-header') {
            lineEligible.push({ ...entry, kind });
        }
    }

    // A selected keyword control owns its following data until the next column-zero
    // keyword.  Operate only on keyword controls in that case: changing body lines as
    // well would make the second toggle unable to see and restore those now-opaque edits.
    const eligible = keywordEligible.length > 0 ? keywordEligible : lineEligible;
    const hasActive = keywordEligible.length > 0
        ? keywordEligible.some(entry => entry.kind === 'keyword')
        : lineEligible.some(entry => entry.kind === 'code' || entry.kind === 'field-header');
    const hasComment = keywordEligible.length > 0
        ? keywordEligible.some(entry => entry.kind === 'disabled-keyword')
        : lineEligible.some(entry => entry.kind === 'line-comment');
    if (!hasActive && !hasComment) {
        return { status: 'noop', mode: 'noop', edits: [], eligibleLineCount: 0, reason: 'no-eligible-lines' };
    }

    const mode = hasActive ? 'comment' : 'uncomment';
    const edits: LineCommentEdit[] = [];
    for (const entry of eligible) {
        if (keywordEligible.length > 0) {
            if (mode === 'comment') {
                // Layer an outer COMMENT even over an already disabled keyword.  Removing
                // one layer later therefore restores authored nested COMMENT text exactly.
                edits.push({ line: entry.line, type: 'insert-keyword-comment' });
            } else if (entry.kind === 'disabled-keyword') {
                const inline = classifyInlineCommentedKeyword(entry.text);
                if (!inline) return rejected('invalid-entry');
                edits.push({
                    line: entry.line,
                    type: 'delete-keyword-comment',
                    endCharacter: inline.keywordStart,
                });
            }
        } else if (mode === 'comment') {
            // Layer `$` over active code, authored ordinary comments, and `$#` field
            // headers. This makes a mixed comment -> uncomment round trip lossless.
            edits.push({ line: entry.line, type: 'insert' });
        } else if (entry.kind === 'line-comment') {
            edits.push({ line: entry.line, type: 'delete' });
        }
    }
    if (edits.length > budget.maxEdits) return rejected('edit-budget-exceeded');
    if (edits.length === 0) return { status: 'noop', mode: 'noop', edits: [], eligibleLineCount: eligible.length, reason: 'no-eligible-lines' };
    return { status: 'ready', mode, edits, eligibleLineCount: eligible.length };
}

module.exports = { LINE_COMMENT_TOGGLE_LIMITS, planLineCommentToggle };
