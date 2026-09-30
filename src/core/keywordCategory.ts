'use strict';

/** Runtime resolver for the LS-PrePost Keyword Manager category catalog. */

const catalog = require('../../keywords/lspp_keyword_categories.runtime.json');
const crosswalk = require('../../keywords/keyword_category_crosswalk.json');
const { lookupKeywordSchema } = require('./keywordSchema');
const { normalizeKeyword } = require('./keywordDisplayIdentity');

const OTHER_CATEGORY = Object.freeze({
    code: 'OT',
    name: 'OTHER',
    ordinal: Number.MAX_SAFE_INTEGER,
    displayIndex: Number.MAX_SAFE_INTEGER,
    keywordRecordCount: 0,
    uniqueKeywordCount: 0,
    keywords: [],
    synthetic: true,
});

const categories = Object.freeze(
    [...(catalog.categories || [])]
        .filter(category => category && category.name)
        .sort((left, right) => left.displayIndex - right.displayIndex)
        .map(category => Object.freeze({ ...category }))
);
const categoryByName = new Map(categories.map(category => [category.name, category]));
const categoryNamesByLength = [...categoryByName.keys()].sort((left, right) => right.length - left.length);
const runtimeResolutionCache = new Map();

function exactResolution(keyword) {
    const entry = crosswalk.keywordToCategory?.[keyword];
    return entry ? {
        primaryCategory: entry.primaryCategory,
        aliases: Array.isArray(entry.aliases) ? entry.aliases.slice() : [],
        source: entry.source,
        confidence: entry.confidence,
    } : null;
}

function resolveKeywordCategory(rawKeyword) {
    const keyword = normalizeKeyword(rawKeyword);
    if (!keyword) {
        return { primaryCategory: 'OTHER', aliases: [], source: 'empty', confidence: 'fallback' };
    }

    const exact = exactResolution(keyword);
    if (exact) return exact;
    const cached = runtimeResolutionCache.get(keyword);
    if (cached) return { ...cached, aliases: cached.aliases.slice() };

    // Custom aliases accepted by the schema (for example SET_NODE_TITLE) inherit the canonical
    // keyword's reviewed category, but arbitrary unknown tokens never receive such an inheritance.
    const lookup = lookupKeywordSchema(keyword);
    if (lookup) {
        const canonical = exactResolution(lookup.inputName) || exactResolution(lookup.canonicalName);
        if (canonical) {
            const result = { ...canonical, source: 'schema-runtime-alias' };
            runtimeResolutionCache.set(keyword, result);
            return { ...result, aliases: result.aliases.slice() };
        }
    }

    const prefix = categoryNamesByLength.find(category =>
        keyword === category || keyword.startsWith(`${category}_`)
    );
    if (prefix) {
        const result = { primaryCategory: prefix, aliases: [], source: 'future-keyword-prefix', confidence: 'inferred' };
        runtimeResolutionCache.set(keyword, result);
        return { ...result, aliases: [] };
    }

    const result = { primaryCategory: 'OTHER', aliases: [], source: 'custom-keyword', confidence: 'fallback' };
    runtimeResolutionCache.set(keyword, result);
    return { ...result, aliases: [] };
}

function getKeywordCategory(rawKeyword) {
    const resolution = resolveKeywordCategory(rawKeyword);
    return categoryByName.get(resolution.primaryCategory) || OTHER_CATEGORY;
}

function getCategory(name) {
    return categoryByName.get(String(name || '').toUpperCase()) || OTHER_CATEGORY;
}

function listKeywordCategories(options: { includeEmpty?: boolean; includeOther?: boolean } = {}) {
    const includeEmpty = !!options.includeEmpty;
    const result = categories.filter(category => includeEmpty || category.uniqueKeywordCount > 0);
    return options.includeOther === false ? result.slice() : [...result, OTHER_CATEGORY];
}

module.exports = {
    OTHER_CATEGORY,
    getCategory,
    getKeywordCategory,
    listKeywordCategories,
    resolveKeywordCategory,
};

export {};
