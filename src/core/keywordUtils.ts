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

function addAliasPair(map, left, right) {
    if (!left || !right || left === right) return;
    if (!map[left]) map[left] = [];
    if (!map[right]) map[right] = [];
    if (!map[left].includes(right)) map[left].push(right);
    if (!map[right].includes(left)) map[right].push(left);
}

function loadGeneratedAliases() {
    if (GENERATED_ALIASES) return GENERATED_ALIASES;
    GENERATED_ALIASES = {};
    try {
        const schemaPath = path.join(__dirname, '..', '..', 'keywords', 'field_data.json');
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        for (const [keyword, entry] of Object.entries(schema)) {
            const item = entry as any;
            const canonical = (item && item.x) ? String(item.x).toUpperCase() : String(keyword).toUpperCase();
            if (item && Array.isArray(item.a)) {
                for (const alias of item.a) {
                    addAliasPair(GENERATED_ALIASES, canonical, String(alias).toUpperCase());
                }
            }
            if (item && item.x) {
                addAliasPair(GENERATED_ALIASES, canonical, String(keyword).toUpperCase());
            }
        }
    } catch {
        GENERATED_ALIASES = {};
    }
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
    return [...new Set(aliases)].map(a => prefix + a);
}

module.exports = {
    stripTitleSuffix,
    getAliases
};

export {};
