'use strict';

export type KeywordInputFormatMode = 'standard' | 'long' | 'i10';

/**
 * Returns the per-keyword input-format override proved by Keyword Manual Vol I
 * physical pages 397-398.  The marker may be attached to the keyword token or
 * separated by whitespace/comma.
 */
export function keywordInputFormatOverride(keywordLine: string): KeywordInputFormatMode | null {
    const text = String(keywordLine || '').trim();
    if (!text.startsWith('*')) return null;
    const token = text.split(/[\s,]/)[0] || '';
    const attached = /([+%\-])$/.exec(token)?.[1] || null;
    const remainder = text.slice(token.length);
    const separated = /^[\s,]+([+%\-])(?:[\s,]|$)/.exec(remainder)?.[1] || null;
    const marker = attached || separated;
    if (marker === '+') return 'long';
    if (marker === '-') return 'standard';
    if (marker === '%') return 'i10';
    return null;
}

/**
 * Applies deck-header input controls.  LONG concerns input and is deliberately
 * independent from the structured-deck output mode: Y/K read long, S reads
 * standard.  I10=Y/N selects or clears the alternate I10 input layout.
 */
export function globalInputFormatFromKeywordLine(
    keywordLine: string,
    priorMode: KeywordInputFormatMode = 'standard',
): KeywordInputFormatMode {
    const text = String(keywordLine || '').trim();
    const token = (text.split(/[\s,]/)[0] || '').replace(/[+%\-]$/, '');
    if (!/^\*KEYWORD$/i.test(token)) return priorMode;
    if (/\bLONG\s*=\s*[YK]\b/i.test(text)) return 'long';
    if (/\bLONG\s*=\s*S\b/i.test(text)) return 'standard';
    if (/\bI10\s*=\s*Y\b/i.test(text)) return 'i10';
    if (/\bI10\s*=\s*N\b/i.test(text)) return 'standard';
    return priorMode;
}

export function keywordInputFormat(
    keywordLine: string,
    globalMode: KeywordInputFormatMode = 'standard',
): KeywordInputFormatMode {
    return keywordInputFormatOverride(keywordLine) || globalMode;
}

export function stripKeywordInputFormatMarker(keyword: string): string {
    return String(keyword || '').replace(/[+%\-]$/, '');
}
