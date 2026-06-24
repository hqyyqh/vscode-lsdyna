'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const fieldDataPath = path.join(repoRoot, 'keywords', 'field_data.json');
const overridesPath = path.join(repoRoot, 'keywords', 'field_reference_overrides.json');
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

function keyFor(cardIndex, fieldName) {
    return `${cardIndex}:${normalizeFieldName(fieldName)}`;
}

function findBaseCardIndex(renderedCard, baseCards) {
    if (!baseCards) return -1;
    const renderedNames = renderedCard.map(f => normalizeFieldName(f.n)).join(',');
    for (let i = 0; i < baseCards.length; i++) {
        const baseNames = baseCards[i].map(f => normalizeFieldName(f.n)).join(',');
        if (renderedNames === baseNames) {
            return i + 1; // 1-based base card index
        }
    }
    return -1;
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

        // Resolve canonical base keyword entry and active options
        const activeOptions = entry.active || [];
        const canonicalName = entry.x && schema[normalizeKeywordName(entry.x)]
            ? normalizeKeywordName(entry.x)
            : keyword;
        const canonicalEntry = schema[canonicalName] || entry;

        // Render the cards with active options
        const renderedCards = getRenderedCards(canonicalEntry, activeOptions);

        // Overrides can be defined on this keyword or on the canonical base keyword
        const explicitRules = overrides[normalizedKeyword] || overrides[canonicalName] || {};

        for (const [cardOffset, card] of renderedCards.entries()) {
            const cardIndex = cardOffset + 1;
            for (const field of card || []) {
                const fieldName = normalizeFieldName(field.n);
                if (!fieldName) {
                    continue;
                }

                // Determine base card index to match overrides written in terms of base cards
                const baseCardIdx = findBaseCardIndex(card, canonicalEntry.c);

                // Look up overrides using both baseCardIdx (if matched) and rendered cardIndex
                let explicit = null;
                if (baseCardIdx !== -1) {
                    explicit = explicitRules[`${baseCardIdx}:${fieldName}`];
                }
                if (!explicit) {
                    explicit = explicitRules[`${cardIndex}:${fieldName}`];
                }

                const inferred = inferReference(field);
                const reference = explicit
                    ? applyOverride(inferred || {}, explicit)
                    : inferred;
                if (!reference) {
                    continue;
                }

                keywordRules[`${cardIndex}:${fieldName}`] = {
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

        // Fallback for rules in overrides that weren't matched in schema cards
        for (const [refKey, explicit] of Object.entries(explicitRules)) {
            const [rawCardIndex, rawFieldName] = refKey.split(':');
            const fieldName = normalizeFieldName(rawFieldName);

            // Check if this fieldName is already in keywordRules (with any cardIndex)
            const alreadyMatched = Object.values(keywordRules).some(
                r => r.fieldName === fieldName
            );
            if (alreadyMatched) {
                continue;
            }

            const reference = applyOverride({}, explicit);
            if (!reference) {
                continue;
            }
            const cardIndex = Number.parseInt(rawCardIndex, 10);
            keywordRules[`${cardIndex}:${fieldName}`] = {
                keyword: normalizedKeyword,
                cardIndex,
                fieldName,
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
