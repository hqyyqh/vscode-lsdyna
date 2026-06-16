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

const ALIAS_MAP = {
    "CONTROL_TIMESTEP": "CONTROL_TIME_STEP",
    "MAT_034": "MAT_FABRIC",
    "MAT_058": "MAT_LAMINATED_COMPOSITE_FABRIC",
    "MAT_058_SOLID": "MAT_LAMINATED_COMPOSITE_FABRIC_SOLID",
    "MAT_077_H": "MAT_HYPERELASTIC_RUBBER",
    "MAT_077_O": "MAT_OGDEN_RUBBER",
    "MAT_MODIFIED_JOHNSON_COOK": "MAT_107",
    "MAT_124": "MAT_PLASTICITY_COMPRESSION_TENSION",
    "MAT_181": "MAT_SIMPLIFIED_RUBBER/FOAM",
    "MAT_138": "MAT_COHESIVE_MIXED_MODE",
    "MAT_196": "MAT_GENERAL_SPRING_DISCRETE_BEAM",
    "MAT_023": "MAT_TEMPERATURE_DEPENDENT_ORTHOTROPIC",
    "MAT_295": "MAT_ANISOTROPIC_HYPERELASTIC",
    "SET_NODE_LIST": "SET_NODE",
    "SET_PART_LIST": "SET_PART"
};

const BIDIRECTIONAL_ALIASES = {};
for (const k of Object.keys(ALIAS_MAP)) {
    const v = ALIAS_MAP[k];
    if (!BIDIRECTIONAL_ALIASES[k]) BIDIRECTIONAL_ALIASES[k] = [];
    if (!BIDIRECTIONAL_ALIASES[v]) BIDIRECTIONAL_ALIASES[v] = [];
    if (!BIDIRECTIONAL_ALIASES[k].includes(v)) BIDIRECTIONAL_ALIASES[k].push(v);
    if (!BIDIRECTIONAL_ALIASES[v].includes(k)) BIDIRECTIONAL_ALIASES[v].push(k);
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
    const aliases = [
        ...(BIDIRECTIONAL_ALIASES[name] || []),
        ...(loadGeneratedAliases()[name] || [])
    ];
    return [...new Set(aliases)].map(a => prefix + a);
}

module.exports = {
    stripTitleSuffix,
    getAliases
};

export {};
