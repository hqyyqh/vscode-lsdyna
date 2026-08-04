'use strict';

const { parseArgs } = require('util');
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

function explicitDefineTargets(field) {
    const help = String(field.h || '');
    const fieldName = normalizeFieldName(field.n);
    return [...new Set(
        [...help.matchAll(/\*DEFINE_([A-Z0-9_]+)/gi)]
            .filter(match => {
                const start = Math.max(0, match.index - 160);
                const end = Math.min(help.length, match.index + match[0].length + 160);
                const context = help.slice(start, end);
                return /(?:^|_)ID(?:\d+)?$/.test(fieldName) ||
                    /\b(?:id|identifier|reference|references|referenced)\b/i.test(context);
            })
            .map(match => `DEFINE_${match[1].toUpperCase()}`)
            .filter(target => !/^DEFINE_(?:CURVE|TABLE)/.test(target))
    )];
}

function definitionTargetWords(target) {
    const ignored = new Set(['CPG', 'CPM', 'DE', 'ISPG', 'PBLAST', 'TO']);
    const aliases = {
        AIRGEO: ['GEOMETRY'],
        TRANSFORMATION: ['TRANSFORM'],
    };
    return normalizeKeywordName(target)
        .replace(/^DEFINE_/, '')
        .split('_')
        .filter(word => word.length >= 3 && !ignored.has(word))
        .flatMap(word => [word, ...(aliases[word] || [])]);
}

function genericIdFieldScore(field, target) {
    if (normalizeFieldType(field) !== 'integer') {
        return 0;
    }
    const name = normalizeFieldName(field.n);
    const help = String(field.h || '').trim();
    if (name === 'ID') {
        return 100;
    }
    if (/^(?:ID_.+|.+_ID)$/.test(name)) {
        return 90;
    }
    if (/\b(?:unique\s+(?:number|id)|identification\s+number|unique\s+id)\b/i.test(help)) {
        return 80;
    }

    const normalizedHelp = help.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const words = definitionTargetWords(target);
    const phrase = words.join(' ');
    if (phrase && new RegExp(`^(?:the\\s+)?${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+ID\\b`, 'i').test(normalizedHelp)) {
        return 75;
    }
    if (words.some(word => new RegExp(`^(?:the\\s+)?${word}\\b.{0,40}\\bID\\b`, 'i').test(normalizedHelp))) {
        return 70;
    }
    if (words.some(word => new RegExp(`^ID\\s+of\\s+(?:an?\\s+)?${word}\\b`, 'i').test(normalizedHelp))) {
        return 70;
    }
    return 0;
}

function selectGenericIdField(target, renderedCards) {
    const candidates = [];
    for (const [cardOffset, card] of renderedCards.entries()) {
        for (const [fieldIndex, field] of (card || []).entries()) {
            const score = genericIdFieldScore(field, target);
            if (score > 0) {
                candidates.push({
                    score,
                    cardIndex: cardOffset + 1,
                    fieldIndex,
                    fieldName: normalizeFieldName(field.n),
                    fieldType: field.t,
                    position: field.p,
                    width: field.w,
                });
            }
        }
    }
    if (candidates.length === 0) {
        return { descriptor: null, candidates: [] };
    }
    candidates.sort((left, right) => right.score - left.score || left.cardIndex - right.cardIndex || left.fieldIndex - right.fieldIndex);
    const bestScore = candidates[0].score;
    const best = candidates.filter(candidate => candidate.score === bestScore);
    return {
        descriptor: best.length === 1 ? best[0] : null,
        candidates,
    };
}

function collectGenericDefinitionKeywords(schema, references) {
    const requestedTargets = [...new Set(
        Object.values(references)
            .flatMap(rules => Object.values(rules))
            .flatMap(rule => rule.targetDefinitions || [])
    )].sort();
    const generic = {};
    const ambiguousIdFields = [];

    for (const target of requestedTargets) {
        if (!Object.hasOwn(schema, target)) {
            ambiguousIdFields.push({ target, reason: 'missing-schema-entry', candidates: [] });
            continue;
        }

        let targetHasDescriptor = false;
        for (const [keyword, entry] of Object.entries(schema)) {
            const canonical = normalizeKeywordName(entry && entry.x || keyword);
            if (canonical !== target) {
                continue;
            }
            const canonicalEntry = schema[canonical] || entry;
            const renderedCards = getRenderedCards(canonicalEntry, entry.active || []);
            const selection = selectGenericIdField(target, renderedCards);
            if (!selection.descriptor) {
                ambiguousIdFields.push({
                    target,
                    keyword: normalizeKeywordName(keyword),
                    reason: selection.candidates.length > 0 ? 'ambiguous-id-field' : 'missing-id-field',
                    candidates: selection.candidates,
                });
                continue;
            }
            generic[normalizeKeywordName(keyword)] = {
                target,
                ...selection.descriptor,
            };
            targetHasDescriptor = true;
        }

        if (!targetHasDescriptor && !ambiguousIdFields.some(item => item.target === target)) {
            ambiguousIdFields.push({ target, reason: 'missing-id-field', candidates: [] });
        }
    }

    return {
        generic: Object.fromEntries(Object.entries(generic).sort(([left], [right]) => left.localeCompare(right))),
        ambiguousIdFields,
    };
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
    const targetDefinitions = explicitDefineTargets(field);
    if (targetKinds.length === 0 && targetDefinitions.length === 0) {
        return null;
    }
    return {
        targetKinds,
        confidence: 'high',
        source: 'schema-help',
        allowSignedSwitch: true,
        requiresSignedSwitch: fieldType === 'real' && helpMentionsSignedSwitch(field),
        ...(targetDefinitions.length > 0 ? { targetDefinitions } : {}),
    };
}

function collectDefinitionKeywords(schema, references) {
    const scanned = Object.keys(schema)
        .filter(keyword => /^DEFINE_(CURVE|TABLE)/.test(keyword))
        .sort();
    const drawable = scanned.filter(keyword =>
        /^DEFINE_CURVE(_TITLE|_FUNCTION|_FUNCTION_TITLE)?$/.test(keyword) ||
        /^DEFINE_TABLE(_TITLE|_2D|_2D_TITLE|_3D|_3D_TITLE|_4D|_4D_TITLE)?$/.test(keyword)
    );
    const indexOnly = scanned.filter(keyword => !drawable.includes(keyword));
    return { scanned, drawable, indexOnly, ...collectGenericDefinitionKeywords(schema, references) };
}

function filterUnsafeGenericReferences(references, definitionKeywords) {
    const allowedTargets = new Set(
        Object.values(definitionKeywords.generic || {}).map(descriptor => descriptor.target)
    );
    for (const [keyword, rules] of Object.entries(references)) {
        for (const [key, rule] of Object.entries(rules)) {
            if (rule.targetDefinitions) {
                rule.targetDefinitions = rule.targetDefinitions.filter(target => allowedTargets.has(target));
                if (rule.targetDefinitions.length === 0) {
                    delete rule.targetDefinitions;
                }
            }
            if ((rule.targetKinds || []).length === 0 && !rule.targetDefinitions) {
                delete rules[key];
            }
        }
        if (Object.keys(rules).length === 0) {
            delete references[keyword];
        }
    }
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
                    ...(inferred.targetDefinitions ? { targetDefinitions: inferred.targetDefinitions } : {}),
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

    const sortedReferences = Object.fromEntries(Object.entries(references).sort(([a], [b]) => a.localeCompare(b)));
    const definitionKeywords = collectDefinitionKeywords(schema, sortedReferences);
    filterUnsafeGenericReferences(sortedReferences, definitionKeywords);

    return {
        schemaVersion: 1,
        generatedFrom: {
            fieldData: 'keywords/field_data.json',
        },
        definitionKeywords,
        references: sortedReferences,
    };
}

function main() {
    const { values } = parseArgs({
        options: {
            'field-data': { type: 'string' },
            output: { type: 'string' },
        },
    });
    const inputPath = values['field-data'] ? path.resolve(values['field-data']) : fieldDataPath;
    const destinationPath = values.output ? path.resolve(values.output) : outputPath;
    const schema = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const index = buildIndex(schema);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${destinationPath}`);
    console.log(`Indexed ${Object.keys(index.references).length} keywords with curve/table field references.`);
    console.log(`Scanned ${index.definitionKeywords.scanned.length} DEFINE_CURVE/DEFINE_TABLE keyword schema entries.`);
}

if (require.main === module) {
    main();
}

module.exports = {
    buildIndex,
    inferReference,
    explicitDefineTargets,
    collectGenericDefinitionKeywords,
};
