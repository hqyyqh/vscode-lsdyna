'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {
    getRenderedCardsForLookup,
    loadKeywordSchema,
    lookupKeywordSchema,
} = require('../keywordSchema');
const {
    parseFieldReferenceValue,
    resolveReferenceValueSemantics,
} = require('./fieldReferenceClassifier');
const { getSemanticRuntimeCatalogV2 } = require('../semantics/semanticRuntimeV2');
const fieldReferenceIndex = require('../../../keywords/field_reference_index.json');
const { parseNumericInput } = require('./referenceInputValue');
const { evaluatePredicate } = require('../semantics/predicateEvaluator');
const {
    globalInputFormatFromKeywordLine,
    keywordInputFormat,
} = require('../parser/inputFormat');

const DEFAULT_MAX_REFERENCE_OCCURRENCES = 50_000;
const DEFAULT_MAX_VALUE_DOMAIN_OCCURRENCES = 100_000;

function normalizeKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0]
        .replace(/[+%\-]$/, '');
}

function splitLines(text) {
    return String(text || '').split(/\r\n|\r|\n/);
}

function activeDataEntries(block, text) {
    const lines = splitLines(text);
    const entries = [];
    let pendingBlanks = [];
    for (let offset = 1; offset < lines.length; offset++) {
        const source = lines[offset];
        const trimmed = source.trim();
        if (trimmed.startsWith('$')) continue;
        if (source[0] === '*') break;
        if (!trimmed) {
            if (entries.length > 0) {
                pendingBlanks.push({ text: source, lineIndex: (block.startLine || 0) + offset });
            }
            continue;
        }
        entries.push(...pendingBlanks);
        pendingBlanks = [];
        entries.push({ text: source, lineIndex: (block.startLine || 0) + offset });
    }
    return entries;
}

function lsppReferenceRecordsForKeyword(keyword) {
    return fieldReferenceIndex.references?.[normalizeKeyword(keyword)] || [];
}

function loadCatalogBlockedReferences() {
    const descriptor = fieldReferenceIndex.lsppBlockedReferences;
    if (!descriptor?.file || !/^[0-9a-f]{64}$/.test(descriptor.sha256 || '')) return {};
    const encoded = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', descriptor.file));
    if (encoded.length !== descriptor.compressedBytes ||
        crypto.createHash('sha256').update(encoded).digest('hex') !== descriptor.sha256) {
        throw new Error('reference blocker runtime integrity mismatch');
    }
    const payload = JSON.parse(zlib.gunzipSync(encoded));
    if (payload?.schemaVersion !== 1 || payload?.kind !== 'dynasense-lspp-reference-blockers' ||
        !payload.blockedReferences) {
        throw new Error('Invalid reference blocker runtime');
    }
    return payload.blockedReferences;
}

const LSPP_BLOCKED_REFERENCES = loadCatalogBlockedReferences();

function lsppBlockedRecordsForKeyword(keyword) {
    return LSPP_BLOCKED_REFERENCES[normalizeKeyword(keyword)] || [];
}

function getCatalogFieldReferenceInfo({ keyword, cardIndex, field }) {
    const record = lsppReferenceRecordsForKeyword(keyword).find(candidate =>
        candidate.cardIndex === cardIndex &&
        normalizeKeyword(candidate.fieldName) === normalizeKeyword(field?.n) &&
        candidate.fieldType === field?.t && candidate.position === field?.p &&
        candidate.width === field?.w
    );
    if (!record) return null;
    const coordinateId = `lspp:${record.linkCode}:${normalizeKeyword(keyword)}:${cardIndex}:` +
        `${record.fieldIndex}`;
    return {
        ...record,
        targetKinds: record.relation?.targetKinds || [],
        targetDefinitions: (record.relation?.targetKeywords || []).map(normalizeKeyword),
        conditional: false,
        definitionRegistry: {
            selectorSource: "keyword-catalog",
            authoringRelationId: coordinateId,
            coordinateId,
            sourceRuleId: coordinateId,
            decisionId: null,
            operationalProjection: {
                directTargetFormats: {
                    standard: { mode: 'fixed', position: record.position, width: record.width },
                    i10: { mode: 'fixed', position: record.position, width: record.width },
                    long: { mode: 'fixed', position: record.position * 2, width: record.width * 2 },
                    comma: { mode: 'comma', fieldIndex: record.fieldIndex },
                },
            },
        },
    };
}

const LSPP_REFERENCE_CATALOG = {
    recordsForKeyword: lsppReferenceRecordsForKeyword,
    blockedForKeyword: lsppBlockedRecordsForKeyword,
    infoForField: getCatalogFieldReferenceInfo,
};

function tokenRange(line, field) {
    const cell = String(line || '').slice(field.p, field.p + field.w);
    const raw = cell.trim();
    if (!raw) return null;
    const offset = cell.indexOf(raw);
    if (offset < 0) return null;
    return {
        raw,
        startCharacter: field.p + offset,
        endCharacter: field.p + offset + raw.length,
    };
}

function commaTokenRange(line, fieldIndex) {
    const text = String(line || '');
    let start = 0;
    for (let index = 0; index < fieldIndex; index++) {
        const comma = text.indexOf(',', start);
        if (comma < 0) return null;
        start = comma + 1;
    }
    const comma = text.indexOf(',', start);
    const end = comma < 0 ? text.length : comma;
    const cell = text.slice(start, end);
    const raw = cell.trim();
    if (!raw) return null;
    const offset = cell.indexOf(raw);
    return { raw, startCharacter: start + offset, endCharacter: start + offset + raw.length };
}

function formatTokenRange(line, field, formatMode, approved, options, keyword = '') {
    const effectiveMode = String(line || '').includes(',') ? 'comma' : formatMode;
    const directFormat = approved?.operationalProjection?.directTargetFormats?.[effectiveMode];
    if (directFormat?.mode === 'comma') {
        return commaTokenRange(line, directFormat.fieldIndex);
    }
    if (directFormat?.mode === 'fixed') {
        return tokenRange(line, { p: directFormat.position, w: directFormat.width });
    }
    if (approved?.selectorSource === 'manual-semantic' || approved?.selectorSource === "keyword-catalog") {
        return effectiveMode === 'comma'
            ? commaTokenRange(line, field.fieldIndex ?? 0)
            : tokenRange(line, field);
    }
    const relationKey = approved?.authoringRelationId || approved?.coordinateId || '';
    let formats = options.formatCache.get(relationKey);
    if (formats === undefined) {
        try {
            const records = getSemanticRuntimeCatalogV2().referenceRecordsForKeyword(keyword);
            const record = records.find(candidate =>
                candidate.authoringRelationId === approved?.authoringRelationId ||
                candidate.coordinateId === approved?.coordinateId);
            formats = record?.field?.formats || null;
        } catch (_error) {
            formats = null;
        }
        options.formatCache.set(relationKey, formats);
    }
    const coordinate = formats?.[effectiveMode];
    if (effectiveMode === 'comma') return commaTokenRange(line, coordinate?.fieldIndex ?? field.fieldIndex ?? 0);
    if (coordinate?.mode === 'fixed') {
        return tokenRange(line, { p: coordinate.position, w: coordinate.width });
    }
    return tokenRange(line, field);
}

function resolveSiblingTargetBinding(info, line, formatMode) {
    const binding = info?.definitionRegistry?.operationalProjection?.siblingTargetBinding;
    if (!binding) return { state: 'not-applicable', info };
    const effectiveMode = String(line || '').includes(',') ? 'comma' : formatMode;
    const format = binding.formats?.[effectiveMode];
    if (!format) return { state: 'indeterminate', reason: 'sibling-format-unavailable' };
    const range = format.mode === 'comma'
        ? commaTokenRange(line, format.fieldIndex)
        : tokenRange(line, { p: format.position, w: format.width });
    const value = range?.raw ? String(range.raw).trim().toUpperCase()
        : String(binding.defaultValue ?? '').trim().toUpperCase();
    if (!value) return { state: 'indeterminate', reason: 'sibling-value-unavailable' };
    if (value.startsWith('&') || (value.startsWith('<') && value.endsWith('>'))) {
        return { state: 'indeterminate', reason: 'sibling-value-parameterized' };
    }
    const branch = (binding.branches || []).find(candidate =>
        String(candidate.value).trim().toUpperCase() === value);
    if (!branch) return { state: 'indeterminate', reason: 'sibling-value-unsupported' };
    return {
        state: 'resolved',
        value,
        info: {
            ...info,
            relation: branch.relation,
            targetKinds: branch.relation.targetKinds || [],
            targetDefinitions: (branch.relation.targetKeywords || [])
                .map(target => normalizeKeyword(target)),
            conditional: true,
        },
    };
}

function resolveContextualReferenceBranch(info, entries, formatMode, rawValue) {
    const gate = info?.contextualReferenceBranch;
    if (!gate) return { state: 'not-applicable', info };
    const source = parseNumericInput(rawValue, { integerOnly: true, nonZero: false });
    if (source.kind !== 'numeric') {
        return { state: 'indeterminate', reason: 'contextual-source-value-indeterminate' };
    }
    if (evaluatePredicate(gate.branch?.when, { currentValue: source.value }) !== 'true') {
        return { state: 'not-applicable', info };
    }
    for (const selector of gate.all || []) {
        const entry = entries?.[selector.cardIndex - 1];
        const effectiveMode = String(entry?.text || '').includes(',') ? 'comma' : formatMode;
        const format = selector.formats?.[effectiveMode];
        if (!format) {
            return { state: 'indeterminate', reason: 'contextual-format-unavailable' };
        }
        const range = entry
            ? format.mode === 'comma'
                ? commaTokenRange(entry.text, format.fieldIndex)
                : tokenRange(entry.text, { p: format.position, w: format.width })
            : null;
        const value = range?.raw ?? selector.defaultValue;
        const state = evaluatePredicate(selector.predicate, { currentValue: value });
        if (state === 'indeterminate') {
            return { state, reason: 'contextual-sibling-value-indeterminate' };
        }
        if (state === 'false') {
            return { state: 'excluded', reason: 'contextual-reference-branch-excluded' };
        }
    }
    return {
        state: 'resolved',
        info: {
            ...info,
            relation: { kind: 'value-branch', otherwise: 'unknown', branches: [gate.branch] },
            targetKinds: gate.branch.targetKinds || [],
            targetDefinitions: (gate.branch.targetKeywords || []).map(normalizeKeyword),
            conditional: true,
        },
    };
}

function addReason(result, reason) {
    if (reason && !result.reasons.includes(reason)) result.reasons.push(reason);
}

function relationNamespaces(value, targetKinds = new Set(), targetDefinitions = new Set(), seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) {
        return { targetKinds: [...targetKinds].sort(), targetDefinitions: [...targetDefinitions].sort() };
    }
    seen.add(value);
    for (const kind of value.targetKinds || []) {
        const normalized = String(kind || '').trim();
        if (normalized) targetKinds.add(normalized);
    }
    for (const keyword of [...(value.targetKeywords || []), ...(value.targetDefinitions || [])]) {
        const normalized = normalizeKeyword(keyword);
        if (normalized) targetDefinitions.add(normalized);
    }
    for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
            relationNamespaces(child, targetKinds, targetDefinitions, seen);
        }
    }
    return { targetKinds: [...targetKinds].sort(), targetDefinitions: [...targetDefinitions].sort() };
}

const { createReferenceMetadataInterner } = require('./referenceMetadata');
const metadataInterners = new WeakMap<object, (record: any) => any>();
const coverageKeys = new WeakMap<object, Set<string>>();

function addReferenceCoverageGap(result, reason, block = null, source = null, lineIndex = undefined) {
    const namespaces = relationNamespaces(source);
    const gap = {
        reason,
        ...(block?.keyword ? { keyword: `*${normalizeKeyword(block.keyword)}` } : {}),
        ...(Number.isInteger(lineIndex)
            ? { startLine: lineIndex }
            : Number.isInteger(block?.startLine) ? { startLine: block.startLine } : {}),
        scope: namespaces.targetKinds.length > 0 || namespaces.targetDefinitions.length > 0
            ? 'namespaces'
            : 'all',
        ...namespaces,
    };
    const key = JSON.stringify(gap);
    let keys = coverageKeys.get(result);
    if (!keys) {
        keys = new Set();
        coverageKeys.set(result, keys);
    }
    if (!keys.has(key)) {
        keys.add(key);
        result.referenceCoverage.gaps.push(gap);
        result.referenceCoverage.complete = false;
    }
}

function pushBounded(result, collection, value, limit, reason) {
    if (collection.length >= limit) {
        result.complete = false;
        addReason(result, reason);
        return false;
    }
    let intern = metadataInterners.get(result);
    if (!intern) { intern = createReferenceMetadataInterner(); metadataInterners.set(result, intern); }
    collection.push(intern(value));
    return true;
}

function semanticOccurrence({
    block,
    keyword,
    cardIndex,
    field,
    line,
    lineIndex,
    result,
    options,
    formatMode,
    entries,
}) {
    const infoKey = [normalizeKeyword(keyword), cardIndex, field.n, field.t, field.p, field.w].join(':');
    let info = options.infoCache.get(infoKey);
    if (info === undefined) {
        info = options.referenceCatalog.infoForField({ keyword, cardIndex, field }) || null;
        options.infoCache.set(infoKey, info);
    }
    if (!info) return;
    const approved = info.definitionRegistry;
    const range = formatTokenRange(line, field, formatMode, approved, options, keyword);
    if (!range) return;
    const sibling = resolveSiblingTargetBinding(info, line, formatMode);
    const contextual = sibling.state === 'indeterminate'
        ? { state: 'not-applicable', info: sibling.info || info }
        : resolveContextualReferenceBranch(sibling.info || info, entries, formatMode, range.raw);
    const effectiveInfo = contextual.info || sibling.info || info;
    const input = parseNumericInput(range.raw, { integerOnly: true, nonZero: false });
    let semantic;
    let referenceValue = sibling.state === 'indeterminate' ||
        contextual.state === 'indeterminate' || contextual.state === 'excluded'
        ? null : parseFieldReferenceValue(range.raw, effectiveInfo);
    if (sibling.state === 'indeterminate') {
        semantic = { state: 'indeterminate', reason: sibling.reason };
        result.complete = false;
        addReason(result, 'registry-reference-sibling-discriminator-indeterminate');
        addReferenceCoverageGap(
            result,
            'registry-reference-sibling-discriminator-indeterminate',
            block,
            info,
            lineIndex,
        );
    } else if (contextual.state === 'indeterminate') {
        semantic = { state: 'indeterminate', reason: contextual.reason };
        result.complete = false;
        addReason(result, 'registry-reference-contextual-predicate-indeterminate');
        addReferenceCoverageGap(
            result,
            'registry-reference-contextual-predicate-indeterminate',
            block,
            effectiveInfo,
            lineIndex,
        );
    } else if (contextual.state === 'excluded') {
        semantic = { state: 'non-reference', role: 'context-excluded',
            reason: contextual.reason };
    } else if (input.kind === 'numeric') {
        semantic = resolveReferenceValueSemantics(effectiveInfo, input.value);
        if (semantic.state === 'reference' && !referenceValue) {
            semantic = { state: 'indeterminate', reason: 'reference-id-zero-or-unsafe' };
        }
    } else if (input.kind === 'parameter') {
        semantic = referenceValue
            ? { state: 'reference-potential', role: 'reference' }
            : { state: 'indeterminate', reason: 'parameter-reference-role-indeterminate' };
    } else if (referenceValue?.kind === 'label') {
        semantic = { state: 'reference', role: 'reference', idTransform: 'identity' };
    } else {
        // An opaque value in one relation field must not invalidate the whole
        // file scan. It is simply not an object reference for this occurrence;
        // numeric and parameterized occurrences remain handled above.
        semantic = { state: 'non-reference', role: 'unparsed-input' };
    }

    const base = {
        filePath: block.filePath,
        keyword: `*${normalizeKeyword(keyword)}`,
        cardIndex,
        fieldName: field.n,
        fieldType: field.t,
        position: field.p,
        width: field.w,
        lineIndex,
        startCharacter: range.startCharacter,
        endCharacter: range.endCharacter,
        rawValue: range.raw,
        authoringRelationId: approved.authoringRelationId,
        coordinateId: approved.coordinateId,
        sourceRuleId: approved.sourceRuleId,
        decisionId: approved.decisionId,
        operationalProjection: approved.operationalProjection || null,
        semantic,
    };
    pushBounded(
        result,
        result.valueDomainOccurrences,
        base,
        options.maxValueDomainOccurrences,
        'registry-value-domain-capacity-exceeded',
    );
    if (!referenceValue) return;
    const stored = pushBounded(
        result,
        result.referenceOccurrences,
        {
            ...base,
            referenceValue: info.conditional
                ? referenceValue
                : (() => {
                    const { semanticRelation: _semanticRelation, ...compact } = referenceValue;
                    return compact;
                })(),
            targetKinds: referenceValue.targetKinds || effectiveInfo.targetKinds || [],
            targetDefinitions: referenceValue.targetDefinitions ||
                effectiveInfo.targetDefinitions || [],
        },
        options.maxReferenceOccurrences,
        'registry-reference-capacity-exceeded',
    );
    if (!stored) {
        addReferenceCoverageGap(
            result,
            'registry-reference-capacity-exceeded',
            block,
            referenceValue,
            lineIndex,
        );
    }
}

function tableDefinitionForBlock(referenceDefinitions, block) {
    return (referenceDefinitions?.tables || []).find(definition =>
        definition.startLine === block.startLine &&
        normalizeKeyword(definition.keyword) === normalizeKeyword(block.keyword)
    ) || null;
}

function uniqueApprovedTableReferenceField(keyword, cards, referenceCatalog = LSPP_REFERENCE_CATALOG) {
    const candidates = [];
    for (let cardOffset = 0; cardOffset < cards.length; cardOffset++) {
        for (const field of cards[cardOffset] || []) {
            const info = referenceCatalog.infoForField({
                keyword,
                cardIndex: cardOffset + 1,
                field,
            });
            if (info) candidates.push({ cardIndex: cardOffset + 1, field });
        }
    }
    return candidates.length === 1 ? candidates[0] : null;
}

function scanApprovedBlock({
    block,
    text,
    lookup,
    referenceDefinitions,
    result,
    options,
    formatMode,
    relations,
    dataEntries = null,
}) {
    const cards = getRenderedCardsForLookup(lookup);
    const entries = dataEntries || activeDataEntries(block, text);
    const keyword = normalizeKeyword(block.keyword);
    const table = tableDefinitionForBlock(referenceDefinitions, block);
    const tableDimension = Number.parseInt(String(table?.tableType || ''), 10);
    if (table && tableDimension >= 3) {
        const approvedField = uniqueApprovedTableReferenceField(keyword, cards, options.referenceCatalog);
        if (!approvedField) {
            result.complete = false;
            addReason(result, 'registry-table-reference-layout-unavailable');
            addReferenceCoverageGap(
                result,
                'registry-table-reference-layout-unavailable',
                block,
                relations,
            );
            return;
        }
        for (const row of table.rows || []) {
            const entry = entries.find(candidate => candidate.lineIndex === row.lineIndex);
            if (!entry) {
                result.complete = false;
                addReason(result, 'registry-table-reference-row-unavailable');
                addReferenceCoverageGap(
                    result,
                    'registry-table-reference-row-unavailable',
                    block,
                    relations,
                    row.lineIndex,
                );
                continue;
            }
            semanticOccurrence({
                block,
                keyword,
                cardIndex: approvedField.cardIndex,
                field: approvedField.field,
                line: entry.text,
                lineIndex: entry.lineIndex,
                result,
                options,
                formatMode,
                entries,
            });
        }
        return;
    }

    for (let index = 0; index < entries.length && index < cards.length; index++) {
        const card = cards[index] || [];
        for (const field of card) {
            semanticOccurrence({
                block,
                keyword,
                cardIndex: index + 1,
                field,
                line: entries[index].text,
                lineIndex: entries[index].lineIndex,
                result,
                options,
                formatMode,
                entries,
            });
        }
    }
}

function scanOperationalBlock({ block, text, relations, result, options, formatMode, dataEntries = null }) {
    const entries = dataEntries || activeDataEntries(block, text);
    const coordinates = new Map();
    for (const record of relations || []) {
        const field = record?.field || record;
        if (!field || !Number.isInteger(field.cardIndex) || field.cardIndex < 1 ||
            !Number.isInteger(field.fieldIndex) || field.fieldIndex < 0) continue;
        const key = [field.cardIndex, field.fieldIndex, field.fieldName, field.position, field.width].join(':');
        if (!coordinates.has(key)) coordinates.set(key, { field, record });
    }
    for (const { field, record } of coordinates.values()) {
        const entry = entries[field.cardIndex - 1];
        if (!entry) {
            result.complete = false;
            addReason(result, 'registry-reference-record-unavailable');
            addReferenceCoverageGap(
                result,
                'registry-reference-record-unavailable',
                block,
                record,
            );
            continue;
        }
        semanticOccurrence({
            block,
            keyword: normalizeKeyword(block.keyword),
            cardIndex: field.cardIndex,
            field: { n: field.fieldName, t: field.fieldType, p: field.position,
                w: field.width, fieldIndex: field.fieldIndex },
            line: entry.text,
            lineIndex: entry.lineIndex,
            result,
            options,
            formatMode,
            entries,
        });
    }
}

function scanBlockedRelations({ block, text, records, result, formatMode, dataEntries = null }) {
    if (!records?.length) return;
    const entries = dataEntries || activeDataEntries(block, text);
    for (const record of records || []) {
        let entry = null;
        if (Number.isInteger(record.cardIndex) && record.cardIndex > 0) {
            entry = entries[record.cardIndex - 1];
            if (!entry) continue;
            const effectiveMode = entry.text.includes(',') ? 'comma' : formatMode;
            const range = effectiveMode === 'comma'
                ? commaTokenRange(entry.text, record.fieldIndex || 0)
                : tokenRange(entry.text, {
                    p: effectiveMode === 'long' ? record.position * 2 : record.position,
                    w: effectiveMode === 'long' ? record.width * 2 : record.width,
                });
            if (!range) continue;
            if (record.mode === 'option' && String(range.raw).trim().toUpperCase() !==
                String(record.optionValue).trim().toUpperCase()) continue;
            const numeric = parseNumericInput(range.raw, { integerOnly: true, nonZero: false });
            if (record.mode === 'direct' && numeric.kind === 'numeric' && numeric.value === 0) continue;
        }
        result.complete = false;
        addReason(result, 'lspp-reference-relations-blocked');
        addReferenceCoverageGap(result, `lspp-${record.reason}`, block, {
            targetKinds: record.targetKind ? [record.targetKind] : [],
            targetKeywords: record.targetKeywords || [],
        }, entry?.lineIndex);
    }
}

async function scanRegistryReferenceOccurrencesFromFileIndex(
    fileIndex,
    readBlockText,
    options: {
        cancellationToken?: { isCancellationRequested?: boolean };
        maxReferenceOccurrences?: number;
        maxValueDomainOccurrences?: number;
        truncatedStartLines?: Set<number>;
        referenceCatalog?: {
            recordsForKeyword: (keyword: string) => any[];
            blockedForKeyword?: (keyword: string) => any[];
            infoForField: (options: any) => any;
        };
    } = {},
) {
    const limits = {
        maxReferenceOccurrences: Number.isInteger(options.maxReferenceOccurrences)
            ? Math.max(1, options.maxReferenceOccurrences)
            : DEFAULT_MAX_REFERENCE_OCCURRENCES,
        maxValueDomainOccurrences: Number.isInteger(options.maxValueDomainOccurrences)
            ? Math.max(1, options.maxValueDomainOccurrences)
            : DEFAULT_MAX_VALUE_DOMAIN_OCCURRENCES,
        infoCache: new Map(),
        formatCache: new Map(),
        referenceCatalog: options.referenceCatalog || LSPP_REFERENCE_CATALOG,
    };
    const result: any = {
        complete: true,
        reasons: [],
        referenceOccurrences: [],
        valueDomainOccurrences: [],
        referenceCoverage: { complete: true, gaps: [] },
        scannedBlocks: 0,
        approvedBlocks: 0,
    };
    if (!fileIndex || !Array.isArray(fileIndex.keywordBlocks) || typeof readBlockText !== 'function') {
        result.complete = false;
        addReason(result, 'registry-reference-structure-unavailable');
        addReferenceCoverageGap(result, 'registry-reference-structure-unavailable');
        return result;
    }
    const schema = loadKeywordSchema(() => 'en');
    let globalFormatMode = 'standard';
    for (const block of fileIndex.keywordBlocks) {
        if (options.cancellationToken?.isCancellationRequested) {
            return { ...result, complete: false, cancelled: true, reasons: ['cancelled'] };
        }
        result.scannedBlocks += 1;
        const rawKeyword = String(block.rawKeyword || block.keyword || '');
        if (normalizeKeyword(block.keyword) === 'KEYWORD') {
            globalFormatMode = globalInputFormatFromKeywordLine(rawKeyword, globalFormatMode);
            continue;
        }
        const lookup = lookupKeywordSchema(block.keyword, schema);
        const inputKeyword = normalizeKeyword(block.keyword);
        const canonical = normalizeKeyword(lookup?.canonicalName || block.keyword);
        const inputRelations = limits.referenceCatalog.recordsForKeyword(inputKeyword);
        const inputBlocked = limits.referenceCatalog.blockedForKeyword?.(inputKeyword) || [];
        // Prefer the exact spelling; use the schema canonical only for aliases.
        const approvedRelations = inputRelations.length > 0 || inputKeyword === canonical
            ? inputRelations
            : limits.referenceCatalog.recordsForKeyword(canonical);
        const blockedRelations = inputBlocked.length > 0 || inputKeyword === canonical
            ? inputBlocked
            : limits.referenceCatalog.blockedForKeyword?.(canonical) || [];
        if (approvedRelations.length === 0 && blockedRelations.length === 0) continue;
        result.approvedBlocks += 1;
        const formatMode = keywordInputFormat(rawKeyword, globalFormatMode);
        const text = await readBlockText(block);
        if (text === null || text === undefined || options.cancellationToken?.isCancellationRequested) {
            return { ...result, complete: false, cancelled: true, reasons: ['cancelled'] };
        }
        if (options.truncatedStartLines?.has(block.startLine)) {
            result.complete = false;
            addReason(result, 'registry-reference-preview-byte-limit');
            addReferenceCoverageGap(
                result,
                'registry-reference-preview-byte-limit',
                block,
                approvedRelations,
            );
        }
        const dataEntries = activeDataEntries(block, text);
        scanBlockedRelations({ block, text, records: blockedRelations, result, formatMode, dataEntries });
        if (approvedRelations.length === 0) continue;
        if (lookup) {
            scanApprovedBlock({
                block,
                text,
                lookup,
                referenceDefinitions: fileIndex.referenceDefinitions,
                result,
                options: limits,
                formatMode,
                relations: approvedRelations,
                dataEntries,
            });
        } else {
            scanOperationalBlock({ block, text, relations: approvedRelations, result,
                options: limits, formatMode, dataEntries });
        }
    }
    result.reasons = [...new Set(result.reasons)].sort();
    result.referenceCoverage.gaps.sort((left, right) =>
        String(left.keyword || '').localeCompare(String(right.keyword || '')) ||
        (left.startLine ?? -1) - (right.startLine ?? -1) ||
        left.reason.localeCompare(right.reason)
    );
    coverageKeys.delete(result);
    metadataInterners.delete(result);
    return result;
}

module.exports = {
    DEFAULT_MAX_REFERENCE_OCCURRENCES,
    DEFAULT_MAX_VALUE_DOMAIN_OCCURRENCES,
    activeDataEntries,
    scanRegistryReferenceOccurrencesFromFileIndex,
    tokenRange,
    commaTokenRange,
    formatTokenRange,
    uniqueApprovedTableReferenceField,
    scanOperationalBlock,
    relationNamespaces,
    getCatalogFieldReferenceInfo,
    lsppReferenceRecordsForKeyword,
    lsppBlockedRecordsForKeyword,
};

export {};
