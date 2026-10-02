'use strict';

export type OpaqueCommentKind = 'comment' | 'comment-noecho';

export type OpaqueCommentDirective = {
    kind: OpaqueCommentKind;
    tokenStart: 0;
    tokenEnd: number;
};

export type InlineCommentedKeyword = OpaqueCommentDirective & {
    keywordStart: number;
};

export type OpaqueLocationState = 'active' | 'opaque' | 'unknown';

export type OpaqueLocationResult = {
    state: OpaqueLocationState;
    reason?: string;
    directiveLine?: number;
    opaqueStartCharacter?: number;
    endLineExclusive?: number;
};

type OpaqueBlock = {
    keyword?: string;
    rawKeyword?: string;
    startLine?: number;
    endLine?: number;
    opaqueKind?: OpaqueCommentKind;
    opaqueStartCharacter?: number;
};

type BoundedResolveBudget = {
    maxLookbackLines?: number;
    maxTotalCharacters?: number;
    maxLineCharacters?: number;
};

const COMMENT_TOKEN = '*COMMENT';
const COMMENT_NOECHO_TOKEN = '*COMMENT_NOECHO';
const DEFAULT_MAX_LOOKBACK_LINES = 256;
const DEFAULT_MAX_TOTAL_CHARACTERS = 256 * 1024;
const DEFAULT_MAX_LINE_CHARACTERS = 64 * 1024;

function asciiUpperCode(code: number): number {
    return code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
}

function sourceLength(text: string | Buffer): number {
    return text.length;
}

function sourceCodeAt(text: string | Buffer, index: number): number {
    return typeof text === 'string' ? text.charCodeAt(index) : text[index];
}

function matchesAsciiToken(text: string | Buffer, token: string): boolean {
    if (sourceLength(text) < token.length) return false;
    for (let index = 0; index < token.length; index++) {
        if (asciiUpperCode(sourceCodeAt(text, index)) !== token.charCodeAt(index)) return false;
    }
    return true;
}

function isDirectiveSeparator(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x2c || code === 0x0d || code === 0x0a;
}

/**
 * Recognizes only the column-zero LS-DYNA COMMENT control tokens.  In particular,
 * indented tokens and COMMENTARY-like prefixes do not activate opaque semantics.
 */
export function classifyOpaqueCommentDirective(text: string | Buffer): OpaqueCommentDirective | null {
    if (typeof text !== 'string' && !Buffer.isBuffer(text)) return null;
    if (sourceCodeAt(text, 0) !== 0x2a) return null;

    const candidates: Array<{ token: string; kind: OpaqueCommentKind }> = [
        { token: COMMENT_NOECHO_TOKEN, kind: 'comment-noecho' },
        { token: COMMENT_TOKEN, kind: 'comment' },
    ];
    for (const candidate of candidates) {
        if (!matchesAsciiToken(text, candidate.token)) continue;
        const tokenEnd = candidate.token.length;
        if (tokenEnd < sourceLength(text) && !isDirectiveSeparator(sourceCodeAt(text, tokenEnd))) {
            continue;
        }
        return { kind: candidate.kind, tokenStart: 0, tokenEnd };
    }
    return null;
}

/**
 * Recognizes the Keyword Manual's inline disabled-keyword form:
 * `*COMMENT  *KEYWORD`.  The returned `keywordStart` is also the exclusive end
 * of the prefix that must be removed to restore the original keyword line.
 */
export function classifyInlineCommentedKeyword(text: string): InlineCommentedKeyword | null {
    if (typeof text !== 'string') return null;
    const directive = classifyOpaqueCommentDirective(text);
    if (!directive) return null;

    let keywordStart = directive.tokenEnd;
    if (keywordStart >= text.length || !/[ \t]/.test(text[keywordStart])) return null;
    while (keywordStart < text.length && /[ \t]/.test(text[keywordStart])) keywordStart++;
    if (text[keywordStart] !== '*' || !/[A-Za-z0-9_]/.test(text[keywordStart + 1] || '')) {
        return null;
    }
    return { ...directive, keywordStart };
}

/** Any physical line whose first byte/character is `*` terminates an opaque range. */
export function isColumnZeroKeywordBoundary(text: string | Buffer): boolean {
    return (typeof text === 'string' || Buffer.isBuffer(text))
        && sourceLength(text) > 0
        && sourceCodeAt(text, 0) === 0x2a;
}

/** Resolves a position against a complete, version-matched keyword block index. */
export function resolveOpaqueLocationFromBlocks(
    blocks: OpaqueBlock[],
    line: number,
    character: number,
): OpaqueLocationResult {
    if (!Array.isArray(blocks) || !Number.isInteger(line) || line < 0
        || !Number.isInteger(character) || character < 0) {
        return { state: 'unknown', reason: 'invalid-query' };
    }

    let low = 0;
    let high = blocks.length - 1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        const block = blocks[middle];
        const startLine = Number(block?.startLine);
        const endLine = Number(block?.endLine);
        if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || endLine < startLine) {
            return { state: 'unknown', reason: 'invalid-block-index' };
        }
        if (line < startLine) {
            high = middle - 1;
        } else if (line > endLine) {
            low = middle + 1;
        } else {
            if (!block.opaqueKind) {
                const keyword = String(block.keyword || block.rawKeyword || '')
                    .trim()
                    .replace(/^\*/, '')
                    .toUpperCase();
                if (keyword === 'COMMENT' || keyword === 'COMMENT_NOECHO') {
                    return { state: 'unknown', reason: 'missing-opaque-metadata' };
                }
                return { state: 'active' };
            }
            const opaqueStartCharacter = Number(block.opaqueStartCharacter);
            if (!Number.isInteger(opaqueStartCharacter) || opaqueStartCharacter < 1) {
                return { state: 'unknown', reason: 'invalid-opaque-block' };
            }
            const opaque = line > startLine || character >= opaqueStartCharacter;
            return {
                state: opaque ? 'opaque' : 'active',
                directiveLine: startLine,
                opaqueStartCharacter,
                endLineExclusive: endLine + 1,
            };
        }
    }
    return { state: 'active' };
}

/**
 * Fail-closed fallback for a live snapshot that has no ready block index.  It scans
 * backward only to the nearest column-zero `*`, because indented keyword-looking
 * lines cannot terminate *COMMENT according to the solver contract.
 */
export function resolveOpaqueLocationBounded(
    readLine: (line: number) => string,
    line: number,
    character: number,
    budget: BoundedResolveBudget = {},
): OpaqueLocationResult {
    if (typeof readLine !== 'function' || !Number.isInteger(line) || line < 0
        || !Number.isInteger(character) || character < 0) {
        return { state: 'unknown', reason: 'invalid-query' };
    }
    const maxLookbackLines = Math.max(0, Number.isFinite(budget.maxLookbackLines)
        ? Math.floor(Number(budget.maxLookbackLines))
        : DEFAULT_MAX_LOOKBACK_LINES);
    const maxTotalCharacters = Math.max(1, Number.isFinite(budget.maxTotalCharacters)
        ? Math.floor(Number(budget.maxTotalCharacters))
        : DEFAULT_MAX_TOTAL_CHARACTERS);
    const maxLineCharacters = Math.max(1, Number.isFinite(budget.maxLineCharacters)
        ? Math.floor(Number(budget.maxLineCharacters))
        : DEFAULT_MAX_LINE_CHARACTERS);
    let totalCharacters = 0;
    const lowestLine = Math.max(0, line - maxLookbackLines);

    for (let currentLine = line; currentLine >= lowestLine; currentLine--) {
        let text: string;
        try {
            text = readLine(currentLine);
        } catch (_error) {
            return { state: 'unknown', reason: 'line-read-failed' };
        }
        if (typeof text !== 'string' || text.length > maxLineCharacters) {
            return { state: 'unknown', reason: 'line-budget-exceeded' };
        }
        totalCharacters += text.length;
        if (totalCharacters > maxTotalCharacters) {
            return { state: 'unknown', reason: 'character-budget-exceeded' };
        }
        if (!isColumnZeroKeywordBoundary(text)) continue;

        const directive = classifyOpaqueCommentDirective(text);
        if (!directive) return { state: 'active' };
        const opaque = currentLine < line || character >= directive.tokenEnd;
        return {
            state: opaque ? 'opaque' : 'active',
            directiveLine: currentLine,
            opaqueStartCharacter: directive.tokenEnd,
        };
    }

    if (lowestLine === 0) return { state: 'active' };
    return { state: 'unknown', reason: 'lookback-budget-exceeded' };
}

module.exports = {
    classifyOpaqueCommentDirective,
    classifyInlineCommentedKeyword,
    isColumnZeroKeywordBoundary,
    resolveOpaqueLocationFromBlocks,
    resolveOpaqueLocationBounded,
};
