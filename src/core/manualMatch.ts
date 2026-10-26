import { loadKeywordSchema, lookupKeywordSchema, type KeywordSchema } from './keywordSchema';
import { contactKeywordParts } from './contactKeywordName';

export type ManualMatchKind = 'exact' | 'section' | 'approximate';

function normalizeKeywordName(value: string): string {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase();
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
    let schema: KeywordSchema;
    try {
        schema = loadKeywordSchema();
    } catch {
        return 'approximate';
    }

    const requestedLookup = lookupKeywordSchema(requested, schema);
    const suffix = requested.startsWith(matched + '_') ? requested.slice(matched.length + 1) : '';
    const structuralSuffix = /^(ID|TITLE|HEADING|ID_TITLE|ID_HEADING|BLANK)$/.test(suffix);
    const bases = new Set([matched, ...equivalentMatchedKeywords.map(normalizeKeywordName)]);
    for (const base of bases) {
        // Equal manual locations can prove a numbered material's alternate spelling.
        if (suffix && base !== matched && lookupKeywordSchema(`${base}_${suffix}`, schema)) return 'section';
        if (requestedLookup && structuralSuffix && schema[requested]) return 'section';
        const baseLookup = lookupKeywordSchema(base, schema);
        if (!baseLookup || !requestedLookup) continue;
        if (requestedLookup.canonicalName === baseLookup.canonicalName &&
            baseLookup.activeOptions.every(option => requestedLookup.activeOptions.includes(option))) return 'section';
        const requestedContact = contactKeywordParts(requested), baseContact = contactKeywordParts(base);
        if (requestedContact && baseContact && requestedContact.type === baseContact.type &&
            baseContact.options.every(option => requestedContact.options.includes(option))) return 'section';
    }
    return 'approximate';
}
