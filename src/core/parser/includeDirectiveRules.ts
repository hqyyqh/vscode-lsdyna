'use strict';

/**
 * @fileoverview Shared *INCLUDE* directive rules for scanner and path completion.
 * @module core/parser/includeDirectiveRules
 *
 * Filename-card index is 1-based and matches includeScanner cardCount:
 * blank and `$` lines are not cards; path ` +` continuations do not increment cardCount.
 */

export type IncludeDirectiveRule = {
    /** True when every data card is a filename (`*INCLUDE` multi-file). */
    repeatable: boolean;
    /** 1-based data-card index that holds the include filename. */
    filenameCard: number;
};

/**
 * Returns parsing / completion rules for an include-file keyword.
 * PATH directives return null (not file-include cards).
 *
 * @param {string} keyword - Normalized keyword (e.g. `*INCLUDE_TRANSFORM`).
 * @returns {IncludeDirectiveRule|null}
 */
export function getIncludeDirectiveRule(keyword: string): IncludeDirectiveRule | null {
    const kw = String(keyword || '').trim().toUpperCase();
    if (!kw) return null;

    if (kw === '*INCLUDE') {
        return { repeatable: true, filenameCard: 1 };
    }
    // Card 1 = id/type; card 2 = filename (both MULTISCALE and MULTISCALE_SPOTWELD).
    if (kw.startsWith('*INCLUDE_MULTISCALE')) {
        return { repeatable: false, filenameCard: 2 };
    }
    if (kw.startsWith('*INCLUDE') && !kw.startsWith('*INCLUDE_PATH')) {
        return { repeatable: false, filenameCard: 1 };
    }
    return null;
}

/**
 * Whether a data line ends with LS-DYNA path continuation (` +`).
 * @param {string} line
 * @returns {boolean}
 */
export function lineAwaitsIncludeContinuation(line: string): boolean {
    return String(line || '').trim().endsWith(' +');
}

/**
 * Whether the line at currentIndex is a filename card (or path continuation)
 * under the include keyword at kwLine, using the same card/continuation model
 * as includeScanner.processIncludeDirectiveLine.
 *
 * @param {object} params
 * @param {string[]} params.lines - Lines through current (inclusive).
 * @param {number} params.kwLine - Index of the *INCLUDE* keyword line.
 * @param {number} params.currentIndex - Index of the line under the cursor.
 * @param {IncludeDirectiveRule} params.rule - Rule for that keyword.
 * @returns {boolean}
 */
export function isIncludeFilenameDataLine(params: {
    lines: string[];
    kwLine: number;
    currentIndex: number;
    rule: IncludeDirectiveRule;
}): boolean {
    const { lines, kwLine, currentIndex, rule } = params;
    if (currentIndex <= kwLine || currentIndex >= lines.length) return false;

    let cardCount = 0;
    let awaitingContinuation = false;

    for (let i = kwLine + 1; i <= currentIndex; i++) {
        const line = lines[i] ?? '';
        const trimmed = line.trim();

        // Blank / `$` lines are not cards (scanner skips them). The current line may still
        // be an empty filename card the user is about to type — treat as the next card.
        if (!trimmed || trimmed.startsWith('$')) {
            if (i === currentIndex) {
                if (trimmed.startsWith('$')) return false;
                if (awaitingContinuation) return true;
                const nextCard = cardCount + 1;
                return rule.repeatable || nextCard === rule.filenameCard;
            }
            continue;
        }

        if (awaitingContinuation) {
            if (i === currentIndex) return true;
            awaitingContinuation = lineAwaitsIncludeContinuation(line);
            continue;
        }

        cardCount++;
        const isFilenameCard = rule.repeatable || cardCount === rule.filenameCard;
        if (isFilenameCard) {
            if (i === currentIndex) return true;
            awaitingContinuation = lineAwaitsIncludeContinuation(line);
        } else if (i === currentIndex) {
            return false;
        }
    }

    return false;
}

module.exports = {
    getIncludeDirectiveRule,
    lineAwaitsIncludeContinuation,
    isIncludeFilenameDataLine,
};

export {};
