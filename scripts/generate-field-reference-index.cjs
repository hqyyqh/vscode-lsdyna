'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const fieldDataPath = path.join(repoRoot, 'keywords', 'field_data.json');
const outputPath = path.join(repoRoot, 'keywords', 'field_reference_index.json');
const { getRenderedCards } = require('../out/core/keywordSchema');

function normalizeKeywordName(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function normalizeFieldName(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeTargetKinds(values) {
    const allowed = new Set(['curve', 'table', 'functionCurve']);
    return [...new Set((values || []).filter(value => allowed.has(value)))];
}

function normalizeFieldType(field) {
    return String(field && field.t || '').trim().toLowerCase();
}

function keyFor(cardIndex, fieldName) {
    return `${cardIndex}:${normalizeFieldName(fieldName)}`;
}

function helpMentionsCurve(field) {
    const help = String(field.h || '');
    const name = normalizeFieldName(field.n);
    if (normalizeFieldType(field) === 'real' && !helpMentionsDirectRealReference(field, 'curve')) {
        return false;
    }
    if (/(^|[\s.;:(])(?:optional\s+)?load\s+curve\s+(?:id|number|defining|specifying|for|used|which|to|versus)/i.test(help)) {
        return true;
    }
    if (/(^|[\s.;:(])(?:id\s+of\s+)?(?:a\s+)?\*DEFINE_CURVE/i.test(help)) {
        return true;
    }
    return /\*DEFINE_CURVE(?:_FUNCTION)?/i.test(help) && /^(LC|TB|CURV|TABLE|LCID|LCSS|LCSR)/.test(name);
}

function helpMentionsTable(field) {
    const help = String(field.h || '');
    const name = normalizeFieldName(field.n);
    if (normalizeFieldType(field) === 'real' && !helpMentionsDirectRealReference(field, 'table')) {
        return false;
    }
    if (/(^|[\s.;:(])table\s+(?:id|number|defining|for|used|which)/i.test(help)) {
        return true;
    }
    return /\*DEFINE_TABLE/i.test(help) && /^(LC|TB|CURV|TABLE|LCSS)/.test(name);
}

function helpMentionsDirectRealReference(field, kind) {
    const help = String(field.h || '');
    const fieldName = normalizeFieldName(field.n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const target = kind === 'table' ? '(?:table|\\*DEFINE_TABLE)' : '(?:load\\s+curve|curve|\\*DEFINE_CURVE)';
    const idText = `${target}\\s+(?:id|number)`;
    const fieldPrefix = `(?:${fieldName}|["']${fieldName}["']|\\|\\s*${fieldName}\\s*\\|)`;

    return new RegExp(`${fieldPrefix}\\s+(?:is|becomes|references?)\\s+(?:either\\s+)?(?:a\\s+|the\\s+)?${idText}`, 'i').test(help) ||
        new RegExp(`(?:give|input|enter|define)\\s+(?:a\\s+|the\\s+)?${idText}`, 'i').test(help) ||
        new RegExp(`(?:LT|LE|EQ)\\s*\\.\\s*-?\\s*\\d+(?:\\.\\d+)?[^\\n.]{0,220}${idText}`, 'i').test(help);
}

function helpMentionsSignedSwitch(field) {
    const help = String(field.h || '');
    return /(?:LT|LE)\s*\.\s*-?\s*\d+(?:\.\d+)?/i.test(help) ||
        /EQ\s*\.\s*-\s*[A-Z0-9]/i.test(help) ||
        /\bnegative\b/i.test(help) ||
        /\babsolute\s+value\b/i.test(help) ||
        /\|[^|]+\|\s+is\s+(?:either\s+)?(?:a\s+)?(?:load\s+curve|curve|table)\s+id/i.test(help);
}

function inferReference(field) {
    const fieldType = normalizeFieldType(field);
    if (!field || !['integer', 'real'].includes(fieldType)) {
        return null;
    }
    const targetKinds = [];
    if (helpMentionsCurve(field)) {
        targetKinds.push('curve');
    }
    if (helpMentionsTable(field)) {
        targetKinds.push('table');
    }
    if (targetKinds.length === 0) {
        return null;
    }
    return {
        targetKinds,
        confidence: 'high',
        source: 'schema-help',
        allowSignedSwitch: true,
        requiresSignedSwitch: fieldType === 'real' && helpMentionsSignedSwitch(field),
    };
}

function collectDefinitionKeywords(schema) {
    const scanned = Object.keys(schema)
        .filter(keyword => /^DEFINE_(CURVE|TABLE)/.test(keyword))
        .sort();
    const drawable = scanned.filter(keyword =>
        /^DEFINE_CURVE(_TITLE|_FUNCTION|_FUNCTION_TITLE)?$/.test(keyword) ||
        /^DEFINE_TABLE(_TITLE|_2D|_2D_TITLE|_3D|_3D_TITLE|_4D|_4D_TITLE)?$/.test(keyword)
    );
    const indexOnly = scanned.filter(keyword => !drawable.includes(keyword));
    return { scanned, drawable, indexOnly };
}

function buildIndex(schema) {
    const references = {};

    for (const [keyword, entry] of Object.entries(schema)) {
        const normalizedKeyword = normalizeKeywordName(keyword);
        const keywordRules = {};

        // Resolve canonical base keyword entry and active options
        const activeOptions = entry.active || [];
        const canonicalName = entry.x && schema[normalizeKeywordName(entry.x)]
            ? normalizeKeywordName(entry.x)
            : keyword;
        const canonicalEntry = schema[canonicalName] || entry;

        // Render the cards with active options
        const renderedCards = getRenderedCards(canonicalEntry, activeOptions);

        for (const [cardOffset, card] of renderedCards.entries()) {
            const cardIndex = cardOffset + 1;
            for (const field of card || []) {
                const fieldName = normalizeFieldName(field.n);
                if (!fieldName) {
                    continue;
                }

                const inferred = inferReference(field);
                if (!inferred) {
                    continue;
                }

                keywordRules[`${cardIndex}:${fieldName}`] = {
                    keyword: normalizedKeyword,
                    cardIndex,
                    fieldName,
                    fieldType: field.t,
                    position: field.p,
                    width: field.w,
                    targetKinds: normalizeTargetKinds(inferred.targetKinds),
                    confidence: inferred.confidence,
                    source: inferred.source,
                    allowSignedSwitch: inferred.allowSignedSwitch !== false,
                    ...(inferred.requiresSignedSwitch ? { requiresSignedSwitch: true } : {}),
                };
            }
        }

        if (Object.keys(keywordRules).length > 0) {
            references[normalizedKeyword] = Object.fromEntries(Object.entries(keywordRules).sort(([a], [b]) => a.localeCompare(b)));
        }
    }

    return {
        schemaVersion: 1,
        generatedFrom: {
            fieldData: 'keywords/field_data.json',
        },
        definitionKeywords: collectDefinitionKeywords(schema),
        references: Object.fromEntries(Object.entries(references).sort(([a], [b]) => a.localeCompare(b))),
    };
}

function main() {
    const schema = JSON.parse(fs.readFileSync(fieldDataPath, 'utf8'));
    const index = buildIndex(schema);
    fs.writeFileSync(outputPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${outputPath}`);
    console.log(`Indexed ${Object.keys(index.references).length} keywords with curve/table field references.`);
    console.log(`Scanned ${index.definitionKeywords.scanned.length} DEFINE_CURVE/DEFINE_TABLE keyword schema entries.`);
}

if (require.main === module) {
    main();
}

module.exports = {
    buildIndex,
    inferReference,
};
