import type {
    ObservedComment,
    ObservedKeywordBlock,
    ObservedRecord,
} from './types';

export type SourceLine = string | { line: number; text: string };

export type ObserveBlockOptions = {
    keywordLine?: number;
    maximumPhysicalLines?: number;
    maximumRecords?: number;
    boundary?: ObservedKeywordBlock['boundary'];
};

export type ObserveBlockResult = {
    status: 'observed' | 'unsupported-input';
    reason: string;
    block?: ObservedKeywordBlock;
};

function lineValue(source: SourceLine, fallbackLine: number): { line: number; text: string } {
    if (typeof source === 'string') return { line: fallbackLine, text: source };
    return { line: Number.isInteger(source?.line) ? source.line : fallbackLine, text: String(source?.text || '') };
}

function canonicalKeyword(keywordLineText: string): string {
    const token = String(keywordLineText || '').trim().split(/[\s,]+/, 1)[0].toUpperCase();
    return token.startsWith('*') ? token : '';
}

export function isKeywordBoundaryLine(text: string): boolean {
    return /^\s*\*[A-Za-z0-9_]/.test(String(text || ''));
}

function isPreprocessorMetadata(text: string): boolean {
    return /^\s*(?:#\s*(?:if|ifdef|ifndef|elif|else|endif|define|undef)\b|%\s*(?:if|else|endif)\b)/i
        .test(text);
}

function commentKind(text: string): ObservedComment['kind'] {
    return /^\$#/.test(text) || (/^\$/.test(text) && text.includes('|'))
        ? 'field-header'
        : 'comment';
}

/**
 * Observes a single keyword body without assigning any solver meaning to comments.
 * Only a dollar sign in column one makes a line non-consuming; indented `$` text is
 * deliberately retained as a physical data record.
 */
export function observeKeywordBlock(
    keywordLineText: string,
    bodyLines: SourceLine[],
    options: ObserveBlockOptions = {},
): ObserveBlockResult {
    const keyword = canonicalKeyword(keywordLineText);
    if (!keyword) return { status: 'unsupported-input', reason: 'invalid-keyword-line' };
    const keywordLine = Number.isInteger(options.keywordLine) ? options.keywordLine : 0;
    const maximumPhysicalLines = Number.isFinite(options.maximumPhysicalLines)
        ? Math.max(0, Math.floor(Number(options.maximumPhysicalLines)))
        : 256;
    const maximumRecords = Number.isFinite(options.maximumRecords)
        ? Math.max(0, Math.floor(Number(options.maximumRecords)))
        : 128;
    if (bodyLines.length > maximumPhysicalLines) {
        return { status: 'unsupported-input', reason: 'physical-line-budget-exceeded' };
    }

    const records: ObservedRecord[] = [];
    const preprocessorMetadata: Array<{ line: number; text: string }> = [];
    let pendingComments: ObservedComment[] = [];
    let endLine = keywordLine;
    let boundary: ObservedKeywordBlock['boundary'] = options.boundary || 'provided-end';

    for (let index = 0; index < bodyLines.length; index++) {
        const source = lineValue(bodyLines[index], keywordLine + index + 1);
        const text = source.text;
        if (isKeywordBoundaryLine(text)) {
            boundary = 'next-keyword';
            break;
        }
        endLine = source.line;
        if (text.startsWith('$')) {
            pendingComments.push({ line: source.line, text, kind: commentKind(text) });
            continue;
        }
        if (isPreprocessorMetadata(text)) {
            preprocessorMetadata.push({ line: source.line, text });
            continue;
        }
        records.push({
            ordinal: records.length + 1,
            line: source.line,
            text,
            format: text.includes(',') ? 'free' : 'fixed',
            comments: pendingComments,
        });
        pendingComments = [];
        if (records.length > maximumRecords) {
            return { status: 'unsupported-input', reason: 'record-budget-exceeded' };
        }
    }

    return {
        status: 'observed',
        reason: 'block-observed',
        block: {
            keyword,
            rawKeyword: keywordLineText,
            keywordLine,
            endLine,
            records,
            trailingComments: pendingComments,
            preprocessorMetadata,
            boundary,
        },
    };
}

export const recordObservationInternals = {
    canonicalKeyword,
    isPreprocessorMetadata,
};
