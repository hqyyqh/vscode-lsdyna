import { loadKeywordSchema, type KeywordEntry, type KeywordSchema } from './keywordSchema';

export type ManualMatchKind = 'exact' | 'section' | 'approximate';

const STRUCTURAL_SECTION_SUFFIXES = new Set([
    'ID',
    'TITLE',
    'HEADING',
    'ID_TITLE',
    'ID_HEADING',
    'BLANK',
]);

function normalizeKeywordName(value: string): string {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase();
}

function splitTokens(value: string): string[] {
    return normalizeKeywordName(value).split('_').filter(Boolean);
}

function titleOptions(entry: KeywordEntry): string[][] {
    return (entry.o || [])
        .filter(option => (option.to || 0) > 0)
        .map(option => splitTokens(option.n))
        .filter(tokens => tokens.length > 0)
        .sort((left, right) => right.length - left.length);
}

function suffixUsesKnownOptions(entry: KeywordEntry, suffix: string): boolean {
    const suffixTokens = splitTokens(suffix);
    if (suffixTokens.length === 0) return true;

    const options = titleOptions(entry);
    let cursor = 0;
    while (cursor < suffixTokens.length) {
        const match = options.find(option =>
            option.every((token, index) => suffixTokens[cursor + index] === token)
        );
        if (!match) return false;
        cursor += match.length;
    }
    return true;
}

function schemaProvesSectionVariant(
    base: string,
    suffix: string,
    schema: KeywordSchema,
    allowEquivalentAlias: boolean,
): boolean {
    const normalizedBase = normalizeKeywordName(base);
    const normalizedSuffix = normalizeKeywordName(suffix);
    const candidate = `${normalizedBase}_${normalizedSuffix}`;
    const baseEntry = schema[normalizedBase];

    if (allowEquivalentAlias && schema[candidate]) {
        return true;
    }
    if (STRUCTURAL_SECTION_SUFFIXES.has(normalizedSuffix) && schema[candidate]) {
        return true;
    }
    if (!baseEntry) return false;
    if (baseEntry.v && Object.keys(baseEntry.v).some(name => normalizeKeywordName(name) === candidate)) {
        return true;
    }
    if (suffixUsesKnownOptions(baseEntry, normalizedSuffix)) {
        return true;
    }
    const candidateEntry = schema[candidate];
    return Boolean(candidateEntry?.x && normalizeKeywordName(candidateEntry.x) === normalizedBase);
}

/**
 * Classifies an underscore-boundary manual fallback without treating every
 * valid keyword option as an approximate result.
 *
 * `equivalentMatchedKeywords` are index keys that point to the same manual
 * location. They let a numeric alias such as MAT_024 borrow the schema-backed
 * option relationship of MAT_PIECEWISE_LINEAR_PLASTICITY.
 */
export function classifyManualMatch(
    requestedKeyword: string,
    matchedKeyword: string,
    equivalentMatchedKeywords: string[] = [],
): ManualMatchKind {
    const requested = normalizeKeywordName(requestedKeyword);
    const matched = normalizeKeywordName(matchedKeyword);
    if (!requested || !matched) return 'approximate';
    if (requested === matched) return 'exact';
    if (!requested.startsWith(`${matched}_`)) return 'approximate';

    const suffix = requested.slice(matched.length + 1);
    if (!suffix) return 'approximate';
    let schema: KeywordSchema;
    try {
        schema = loadKeywordSchema();
    } catch {
        return 'approximate';
    }

    const bases = new Set([matched, ...equivalentMatchedKeywords.map(normalizeKeywordName)]);
    for (const base of bases) {
        if (base && schemaProvesSectionVariant(base, suffix, schema, base !== matched)) {
            return 'section';
        }
    }
    return 'approximate';
}
