import { keywordDataPath } from "./keywordDataPath";
'use strict';

const fs = require('fs');
const path = require('path');

const TITLE_SUFFIXES = [
    '_ID_HEADING',
    '_ID_TITLE',
    '_TITLE',
    '_HEADING',
    '_ID',
    '_BLANK'
];

/**
 * Strips the title-related suffix from the keyword name if present.
 * This is kept for manual bookmark normalization only; editor schema lookup
 * should resolve generated variants directly.
 * @param {string} kwName The keyword name.
 * @returns {string} The stripped keyword name.
 */
function stripTitleSuffix(kwName) {
    for (const s of TITLE_SUFFIXES) {
        if (kwName.endsWith(s)) {
            return kwName.substring(0, kwName.length - s.length);
        }
    }
    return kwName;
}

let GENERATED_ALIASES = null;
let aliasRetryAt = 0;

function addAliasPair(map, left, right) {
    if (!left || !right || left === right) return;
    if (!map[left]) map[left] = [];
    if (!map[right]) map[right] = [];
    if (!map[left].includes(right)) map[left].push(right);
    if (!map[right].includes(left)) map[right].push(left);
}

function loadGeneratedAliases() {
    if (GENERATED_ALIASES) return GENERATED_ALIASES;
    if (performance.now() < aliasRetryAt) return {};
    const aliases = {};
    try {
        const schemaPath = keywordDataPath("schema/field_data.json");
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        for (const [keyword, entry] of Object.entries(schema)) {
            const item = entry as any;
            const canonical = (item && item.x) ? String(item.x).toUpperCase() : String(keyword).toUpperCase();
            if (item && Array.isArray(item.a)) {
                for (const alias of item.a) {
                    addAliasPair(aliases, canonical, String(alias).toUpperCase());
                }
            }
            if (item && item.x) {
                addAliasPair(aliases, canonical, String(keyword).toUpperCase());
            }
        }
        const spellingAliases = require(keywordDataPath("engineering/keywordSpellingAliases.json"));
        for (const item of spellingAliases.aliases || []) {
            const canonical = String(item.schemaKeyword || '').toUpperCase();
            const alias = String(item.manualKeyword || '').toUpperCase();
            const card = schema[canonical]?.c?.[Number(item.cardIndex) - 1];
            const expected = item.card || [];
            const layoutMatches = Array.isArray(card) && card.length === expected.length &&
                card.every((field, index) => {
                    const target = expected[index];
                    return String(field.n || '').toUpperCase() === String(target.name || '').toUpperCase() &&
                        String(field.t || '').toLowerCase() === String(target.type || '').toLowerCase() &&
                        field.p === target.position && field.w === target.width;
                });
            if (layoutMatches) addAliasPair(aliases, canonical, alias);
        }
    } catch {
        // ponytail: failed sources retry at most once per second; add explicit invalidation if immediate recovery is required.
        aliasRetryAt = performance.now() + 1000;
        return {};
    }
    GENERATED_ALIASES = aliases;
    return GENERATED_ALIASES;
}

/**
 * Returns an array of equivalent keywords (aliases) for a given keyword name.
 * Handles both with and without '*' prefix.
 * @param {string} kwName The keyword name (e.g., 'SET_NODE_LIST' or '*SET_NODE_LIST')
 * @returns {string[]} An array of aliases (with the same '*' prefix if it was provided).
 */
function getAliases(kwName) {
    let name = kwName.toUpperCase();
    let prefix = '';
    if (name.startsWith('*')) {
        prefix = '*';
        name = name.slice(1);
    }
    const aliases = loadGeneratedAliases()[name] || [];
    return aliases.map(a => prefix + a);
}

module.exports = {
    stripTitleSuffix,
    getAliases
};

export {};
