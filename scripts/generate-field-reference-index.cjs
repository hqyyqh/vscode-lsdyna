'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const fieldDataPath = path.join(repoRoot, 'keywords', 'field_data.json');
const overridesPath = path.join(repoRoot, 'keywords', 'field_reference_overrides.json');
const outputPath = path.join(repoRoot, 'keywords', 'field_reference_index.json');

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

function keyFor(cardIndex, fieldName) {
    return `${cardIndex}:${normalizeFieldName(fieldName)}`;
}

function helpMentionsCurve(field) {
    const help = String(field.h || '');
    const name = normalizeFieldName(field.n);
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
    if (/(^|[\s.;:(])table\s+(?:id|number|defining|for|used|which)/i.test(help)) {
        return true;
    }
    return /\*DEFINE_TABLE/i.test(help) && /^(LC|TB|CURV|TABLE|LCSS)/.test(name);
}

function inferReference(field) {
    if (!field || field.t !== 'integer') {
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
    };
}

function collectDefinitionKeywords(schema) {
    const scanned = Object.keys(schema)
        .filter(keyword => /^DEFINE_(CURVE|TABLE)/.test(keyword))
        .sort();
    const drawable = scanned.filter(keyword =>
        /^DEFINE_CURVE(_TITLE|_FUNCTION|_FUNCTION_TITLE)?$/.test(keyword) ||
        /^DEFINE_TABLE(_TITLE|_2D|_2D_TITLE|_3D|_3D_TITLE)?$/.test(keyword)
    );
    const indexOnly = scanned.filter(keyword => !drawable.includes(keyword));
    return { scanned, drawable, indexOnly };
}

function applyOverride(reference, override) {
    const targetKinds = normalizeTargetKinds(override.targetKinds);
    if (targetKinds.length === 0) {
        return null;
    }
    return {
        ...reference,
        ...override,
        targetKinds,
        confidence: 'explicit',
        source: 'override',
        allowSignedSwitch: override.allowSignedSwitch !== false && override.allowNegative !== false,
    };
}

function buildIndex(schema, overrides) {
    const references = {};

    for (const [keyword, entry] of Object.entries(schema)) {
        const normalizedKeyword = normalizeKeywordName(keyword);
        const keywordRules = {};
        const explicitRules = overrides[normalizedKeyword] || {};

        for (const [cardOffset, card] of (entry.c || []).entries()) {
            const cardIndex = cardOffset + 1;
            for (const field of card || []) {
                const fieldName = normalizeFieldName(field.n);
                if (!fieldName) {
                    continue;
                }
                const refKey = keyFor(cardIndex, fieldName);
                const explicit = explicitRules[refKey];
                const inferred = inferReference(field);
                const reference = explicit
                    ? applyOverride(inferred || {}, explicit)
                    : inferred;
                if (!reference) {
                    continue;
                }
                keywordRules[refKey] = {
                    keyword: normalizedKeyword,
                    cardIndex,
                    fieldName,
                    fieldType: field.t,
                    position: field.p,
                    width: field.w,
                    targetKinds: normalizeTargetKinds(reference.targetKinds),
                    confidence: reference.confidence,
                    source: reference.source,
                    allowSignedSwitch: reference.allowSignedSwitch !== false,
                    ...(reference.label ? { label: reference.label } : {}),
                };
            }
        }

        for (const [refKey, explicit] of Object.entries(explicitRules)) {
            if (keywordRules[refKey]) {
                continue;
            }
            const [rawCardIndex, rawFieldName] = refKey.split(':');
            const reference = applyOverride({}, explicit);
            if (!reference) {
                continue;
            }
            keywordRules[refKey] = {
                keyword: normalizedKeyword,
                cardIndex: Number.parseInt(rawCardIndex, 10),
                fieldName: normalizeFieldName(rawFieldName),
                targetKinds: reference.targetKinds,
                confidence: reference.confidence,
                source: reference.source,
                allowSignedSwitch: reference.allowSignedSwitch !== false,
                ...(reference.label ? { label: reference.label } : {}),
            };
        }

        if (Object.keys(keywordRules).length > 0) {
            references[normalizedKeyword] = Object.fromEntries(Object.entries(keywordRules).sort(([a], [b]) => a.localeCompare(b)));
        }
    }

    return {
        schemaVersion: 1,
        generatedFrom: {
            fieldData: 'keywords/field_data.json',
            overrides: 'keywords/field_reference_overrides.json',
        },
        definitionKeywords: collectDefinitionKeywords(schema),
        references: Object.fromEntries(Object.entries(references).sort(([a], [b]) => a.localeCompare(b))),
    };
}

function main() {
    const schema = JSON.parse(fs.readFileSync(fieldDataPath, 'utf8'));
    const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    const index = buildIndex(schema, overrides);
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
