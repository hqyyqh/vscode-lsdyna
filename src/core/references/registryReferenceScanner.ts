import { keywordDataPath } from "../keywordDataPath";
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
    getRegistryApprovedFieldReferenceInfo,
    parseFieldReferenceValue,
    resolveReferenceValueSemantics,
} = require('./fieldReferenceClassifier');
const { getSemanticRuntimeCatalogV2 } = require('../semantics/semanticRuntimeV2');
const { isMeshEntityKind } = require('../scanner/scannerContracts');
const nativeFileLayout = require("../semantics/catalogNativeFileLayout");
const { getReferenceRuleCatalog } = require('./referenceRuleCatalog');
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
    const normalized = normalizeKeyword(keyword);
    const binding = nativeFileLayout.nativeSpellingBinding(normalized);
    const original = binding?.referenceKeyword || binding?.baseKeyword;
    return getReferenceRuleCatalog().records(normalized) || getReferenceRuleCatalog().records(original) || [];
}

function loadCatalogBlockedReferences() {
    const descriptor = getReferenceRuleCatalog().metadata('lsppBlockedReferences');
    if (typeof descriptor?.file !== 'string' || !descriptor.file ||
        !/^[0-9a-f]{64}$/.test(descriptor.sha256 || '') ||
        !Number.isSafeInteger(descriptor.compressedBytes) || descriptor.compressedBytes <= 0) {
        throw new Error('reference blocker runtime integrity mismatch');
    }
    const encoded = fs.readFileSync(keywordDataPath('references/' + path.basename(descriptor.file)));
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
    const records = lsppReferenceRecordsForKeyword(keyword);
    let record;
    const selected = getReferenceRuleCatalog().matchRecord(records, field?.referenceRecord);
    if (selected) record = selected;
    else if (field?.nativeIdentity) {
        // Native field addresses belong to the file reader's pool, not a manual composition.
        const form = require("../semantics/catalogInputFormCatalogV4").getCatalogInputFormCatalogV4()
            .formForKeyword(nativeFileLayout.nativeFileCatalogKeyword(normalizeKeyword(keyword)), false);
        if (field.nativeIdentity.source !== form?.source.datasetSha256) return null;
        const card = require('../semantics/nativeFileReadContext')
            .nativeKeywordReadContext('*' + normalizeKeyword(keyword), [], 'standard')?.cards.get(field.nativeIdentity.cardIndex);
        if (!card?.fields.some(candidate => candidate.fieldRecordId === field.nativeIdentity.fieldRecordId)) return null;
        const candidates = records.filter(candidate => normalizeKeyword(candidate.fieldName) === normalizeKeyword(field.n) &&
            candidate.nativeSources?.some(source => source.cardSetId === form.rules[
                form.reference.formRuleIds?.[0] as string]?.cardSetId &&
                source.fieldRecordId === field.nativeIdentity.fieldRecordId &&
                source.cardAddress === card.cardRecordId));
        const unique = [...new Map(candidates.map(candidate => [JSON.stringify({ relation: candidate.relation,
            sibling: candidate.siblingTargetBinding }), candidate])).values()];
        if (unique.length !== 1) return null;
        record = unique[0];
    } else record = records.find(candidate =>
        !candidate.nativeLayout &&
        candidate.cardIndex === cardIndex &&
        normalizeKeyword(candidate.fieldName) === normalizeKeyword(field?.n) &&
        candidate.fieldType === field?.t && candidate.position === field?.p &&
        candidate.width === field?.w
    );
    if (!record) return null;
    const coordinateId = `lspp:${record.linkCode}:${normalizeKeyword(keyword)}:${cardIndex}:` +
        `${record.fieldIndex}${record.nativeLayout ? ':' + record.nativeLayout.fieldRecordId : ''}`;
    return {
        ...record,
        ...relationNamespaces(record.relation),
        conditional: !!record.siblingTargetBinding || !!record.relation?.branches?.length || !!record.relation?.targetSearch,
        definitionRegistry: {
            selectorSource: "keyword-catalog",
            authoringRelationId: coordinateId,
            coordinateId,
            sourceRuleId: coordinateId,
            decisionId: null,
            operationalProjection: {
                ...(record.siblingTargetBinding ? { siblingTargetBinding: record.siblingTargetBinding } : {}),
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

function semanticReferenceRecordsForKeyword(keyword) {
    return getSemanticRuntimeCatalogV2().referenceRecordsForKeyword(keyword).filter(record =>
        (record.kind === 'entity-reference' || record.kind === 'value-branch') &&
        !nativeReferenceCoversField({ keyword, cardIndex: record.field.cardIndex,
            field: { n: record.field.fieldName, t: record.field.fieldType,
                p: record.field.position, w: record.field.width } }));
}

function nativeReferenceCoversField({ keyword, cardIndex, field }) {
    // Native file layouts select the physical descriptor, including variant cards.
    // An older name-based projection can flatten that field onto a different row.
    return [...lsppReferenceRecordsForKeyword(keyword), ...lsppBlockedRecordsForKeyword(keyword)].some(record => (record.cardIndex === cardIndex || record.nativeLayout) &&
        normalizeKeyword(record.fieldName) === normalizeKeyword(field?.n) &&
        record.position === field?.p && record.width === field?.w &&
        (record.fieldType === field?.t || record.nativeFieldType === -1 && field?.t === 'real'));
}

const SEMANTIC_REFERENCE_CATALOG = {
    recordsForKeyword: semanticReferenceRecordsForKeyword,
    infoForField: request => nativeReferenceCoversField(request)
        ? null : getRegistryApprovedFieldReferenceInfo(request),
};

function tokenRange(line, field) {
    const cell = String(line || '').slice(field.p, field.p + field.w);
    const raw = cell.trim();
    if (!raw) return null;
    const offset = cell.indexOf(raw);
    return {
        raw,
        startCharacter: field.p + offset,
        endCharacter: field.p + offset + raw.length,
    };
}

function commaTokenRange(line, fieldIndex) {
    const text = String(line || '');
    const span = require('../edit/keywordRecordSerializer').commaRecordSpans(text)[fieldIndex];
    if (!span) return null;
    const raw = text.slice(span.start, span.end);
    if (!raw) return null;
    return { raw, startCharacter: span.start, endCharacter: span.end };
}

function formatTokenRange(line, field, formatMode, approved, options, keyword = '') {
    const effectiveMode = String(line || '').includes(',') ? 'comma' : formatMode;
    if (field.nativeReadSpan) return effectiveMode === 'comma' ? commaTokenRange(line, field.fieldIndex ?? 0)
        : tokenRange(line, { p: field.nativeReadSpan.position, w: field.nativeReadSpan.width });
    if (effectiveMode === 'long' && Number.isInteger(field.nativeLongPosition)) {
        return tokenRange(line, { p: field.nativeLongPosition, w: field.nativeLongWidth });
    }
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
            const projection = approved?.operationalProjection;
            const records = getSemanticRuntimeCatalogV2().referenceRecordsForKeyword(
                normalizeKeyword(projection?.projectedSourceKeyword || keyword));
            const relationIds = projection?.selectedAuthoringRelationId
                ? [projection.selectedAuthoringRelationId]
                : projection?.representationAuthoringRelationIds ||
                    (approved?.authoringRelationId ? [approved.authoringRelationId] : []);
            const groups = relationIds.length ? relationIds.map(id =>
                records.filter(candidate => candidate.authoringRelationId === id))
                : [records.filter(candidate => approved?.coordinateId && candidate.coordinateId === approved.coordinateId)];
            const firstFormats = groups[0]?.[0]?.field?.formats;
            formats = new Set(relationIds).size === relationIds.length && groups.every(group => group.length === 1 &&
                JSON.stringify(group[0].field?.formats) === JSON.stringify(firstFormats)) ? firstFormats || null : null;
        } catch (_error) {
            formats = null;
        }
        options.formatCache.set(relationKey, formats);
    }
    const coordinate = formats?.[effectiveMode];
    if (effectiveMode === 'comma' && coordinate?.mode === 'comma' &&
        Number.isInteger(coordinate.fieldIndex) && coordinate.fieldIndex >= 0) {
        return commaTokenRange(line, coordinate.fieldIndex);
    }
    if (effectiveMode !== 'comma' && coordinate?.mode === 'fixed' &&
        Number.isInteger(coordinate.position) && coordinate.position >= 0 &&
        Number.isInteger(coordinate.width) && coordinate.width > 0) {
        return tokenRange(line, { p: coordinate.position, w: coordinate.width });
    }
    // An unavailable format is different from a verified empty field (null).
    return undefined;
}

function resolveSiblingTargetBinding(info, line, formatMode, entries?, sourceCardIndex?, parameters?, lineIndex?) {
    const binding = info?.definitionRegistry?.operationalProjection?.siblingTargetBinding;
    if (!binding) return { state: 'not-applicable', info };
    const nativeEntries = entries?.some(entry => Number.isInteger(entry.native?.cardIndex));
    const controllerEntry = sourceCardIndex === undefined || binding.cardIndex === undefined || binding.cardIndex === sourceCardIndex
        ? { text: line, lineIndex } : (nativeEntries
            ? entries.find(entry => entry.native?.cardIndex === binding.cardIndex)
            : entries?.[binding.cardIndex - 1]);
    const controllerLine = controllerEntry?.text;
    if (controllerLine === undefined) return { state: 'indeterminate', reason: 'sibling-record-unavailable' };
    const effectiveMode = String(controllerLine || '').includes(',') ? 'comma' : formatMode;
    const format = binding.formats?.[effectiveMode];
    if (!format) return { state: 'indeterminate', reason: 'sibling-format-unavailable' };
    const range = format.mode === 'comma'
        ? commaTokenRange(controllerLine, format.fieldIndex)
        : tokenRange(controllerLine, { p: format.position, w: format.width });
    let value = range?.raw ? String(range.raw).trim().toUpperCase()
        : String(binding.defaultValue ?? '').trim().toUpperCase();
    if (!value && !(binding.controllerValueMode === 'native-string-exact-uppercase' &&
        binding.otherwiseRelation?.kind === 'non-reference')) {
        return { state: 'indeterminate', reason: 'sibling-value-unavailable' };
    }
    if ((value.includes('&') || value.startsWith('<')) && Number.isInteger(controllerEntry?.lineIndex)) {
        const resolved = parameters?.resolve(value, controllerEntry.lineIndex);
        if (resolved?.resolved) value = String(resolved.value);
    }
    if (value.includes('&') || (value.startsWith('<') && value.endsWith('>'))) {
        return { state: 'indeterminate', reason: 'sibling-value-parameterized' };
    }
    if (binding.controllerValueMode === 'native-string-exact-uppercase' && /[&<>\x00-\x1f\x7f-\uffff]/.test(value)) {
        return { state: 'indeterminate', reason: 'sibling-value-unsupported' };
    }
    if (binding.controllerValueMode === 'native-string-choice') {
        const selected = require('../semantics/nativeStringChoice').nativeStringChoice(range?.raw || value, binding.nativeChoiceSelection?.choices || []);
        if (selected === null) return { state: 'indeterminate', reason: 'sibling-value-unsupported' };
        value = selected;
    }
    const nativeRealController = binding.controllerValueMode === 'native-real-float32';
    const numeric = (binding.branches || []).some(candidate => candidate.when)
        ? parseNumericInput(value, { integerOnly: !nativeRealController, nonZero: false }) : null;
    if (nativeRealController) {
        if (numeric?.kind !== 'numeric' || !Number.isFinite(Math.fround(numeric.value))) {
            return { state: 'indeterminate', reason: 'sibling-value-unsupported' };
        }
        numeric.value = Math.fround(numeric.value);
    }
    const branch = (binding.branches || []).find(candidate => candidate.when
        ? numeric?.kind === 'numeric' && numeric.value >= -2147483648 && numeric.value <= 2147483647 &&
            evaluatePredicate(candidate.when, { currentValue: numeric.value }) === 'true'
        : String(candidate.value).trim().toUpperCase() === value);
    const relation = branch?.relation || (binding.otherwiseRelation?.kind === 'non-reference'
        ? binding.otherwiseRelation : null);
    if (!relation) return { state: 'indeterminate', reason: 'sibling-value-unsupported' };
    if (relation.kind === 'unresolved-reference') {
        return { state: 'indeterminate', reason: 'sibling-target-unresolved' };
    }
    return {
        state: 'resolved',
        value,
        info: {
            ...info,
            relation,
            targetKinds: relation.targetKinds || [],
            targetDefinitions: (relation.targetKeywords || [])
                .map(target => normalizeKeyword(target)),
            targetDefinitionUnavailable: Boolean(relation.targetDefinitionUnavailable),
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
    const collect = value => {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        for (const kind of value.targetKinds || []) {
            const normalized = String(kind || '').trim();
            if (normalized) targetKinds.add(normalized);
        }
        if (targetDefinitions) {
            for (const keyword of [...(value.targetKeywords || []), ...(value.targetDefinitions || [])]) {
                const normalized = normalizeKeyword(keyword);
                if (normalized) targetDefinitions.add(normalized);
            }
        }
        for (const child of Object.values(value)) {
            if (child && typeof child === 'object') collect(child);
        }
    };
    collect(value);
    return { targetKinds: [...targetKinds].sort(), targetDefinitions: targetDefinitions ? [...targetDefinitions].sort() : [] };
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
    parameters = undefined,
}) {
    const infoKey = [normalizeKeyword(keyword), cardIndex, field.n, field.t, field.p, field.w,
        field.referenceRecord?.nativeLayout?.fieldRecordId || ''].join(':');
    let info = options.infoCache.get(infoKey);
    if (info === undefined) {
        info = options.referenceCatalog.infoForField({ keyword, cardIndex, field }) || null;
        options.infoCache.set(infoKey, info);
    }
    if (!info || options.needed && !options.needed(info)) return;
    const approved = info.definitionRegistry;
    const range = formatTokenRange(line, field, formatMode, approved, options, keyword);
    if (range === undefined) {
        result.complete = false;
        addReason(result, 'registry-reference-format-unavailable');
        addReferenceCoverageGap(result, 'registry-reference-format-unavailable', block, info, lineIndex);
        return;
    }
    if (!range) return;
    const sibling = resolveSiblingTargetBinding(info, line, formatMode, entries, cardIndex, parameters, lineIndex);
    const contextual = sibling.state === 'indeterminate'
        ? { state: 'not-applicable', info: sibling.info || info }
        : resolveContextualReferenceBranch(sibling.info || info, entries, formatMode, range.raw);
    const effectiveInfo = contextual.info || sibling.info || info;
    const input = parseNumericInput(range.raw, { integerOnly: field.t !== 'real', nonZero: false });
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
        const relation = effectiveInfo.relation || effectiveInfo;
        semantic = input.value === 0 && relation.kind === 'entity-reference' &&
            !relation.branches?.length ? { state: 'non-reference', role: 'zero-id' }
            : resolveReferenceValueSemantics(effectiveInfo, input.value);
        if (semantic.state === 'reference' && !referenceValue) {
            semantic = { state: 'indeterminate', reason: 'reference-id-zero-or-unsafe' };
        }
    } else if (input.kind === 'parameter') {
        semantic = referenceValue
            ? { state: 'reference-potential', role: 'reference' }
            : { state: 'indeterminate', reason: 'parameter-reference-role-indeterminate' };
    } else if (input.kind === 'expression') {
        semantic = referenceValue
            ? { state: 'reference-potential', role: 'reference' }
            : { state: 'indeterminate', reason: 'parameter-expression-unresolved' };
        if (!referenceValue) addReferenceCoverageGap(result, semantic.reason, block, effectiveInfo, lineIndex);
    } else if (referenceValue?.kind === 'label') {
        semantic = { state: 'reference', role: 'reference', idTransform: 'identity' };
    } else {
        // An opaque value in one relation field must not invalidate the whole
        // file scan. It is simply not an object reference for this occurrence;
        // numeric, parameterized and expression occurrences remain handled above.
        semantic = { state: 'non-reference', role: 'unparsed-input' };
    }
    if (semantic.state === 'indeterminate' && input.kind !== 'expression' && sibling.state !== 'indeterminate' &&
        contextual.state !== 'indeterminate') {
        referenceValue = null;
        result.complete = false;
        const reason = semantic.reason || 'registry-reference-value-semantics-indeterminate';
        addReason(result, reason);
        addReferenceCoverageGap(result, reason, block, effectiveInfo, lineIndex);
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
        ...(effectiveInfo.targetDefinitionUnavailable || effectiveInfo.relation?.targetDefinitionUnavailable
            ? { targetDefinitionUnavailable: true } : {}),
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

function nativeRepeatedReferenceLayout(keyword, relations = lsppReferenceRecordsForKeyword(keyword)) {
    const { nativeFileLayoutKind, nativeFileLayoutCards, nativeSpellingBinding } =
        nativeFileLayout;
    const spelling = nativeSpellingBinding(keyword);
    // Saved suffixes can have a different branch grammar from the base pool.
    // Ordinary selection and bounded disk recovery share that exact grammar.
    if (spelling?.layout && !spelling.originalContactPrefix) return null;
    const sequence = require('../semantics/nativeConditionalLayout').nativeConditionalBinding(spelling?.baseKeyword || keyword);
    const simpleTail = sequence?.steps?.length === 2 && sequence.steps[0] === 1 &&
        sequence.steps[1]?.repeatToEnd === 2 && Object.keys(sequence.controls || {}).length === 0;
    const fixedSequence = sequence?.steps?.length > 0 && sequence.steps.length <= 256 &&
        sequence.steps.every(step => Number.isInteger(step) && step > 0) &&
        Object.keys(sequence.controls || {}).length === 0 ? sequence.steps : null;
    const form = require("../semantics/catalogInputFormCatalogV4").getCatalogInputFormCatalogV4().formForKeyword(keyword, false);
    const rules = (form?.reference.formRuleIds || []).map(id => ({ ...form.rules[id], catalogSource: form.source }))
        .filter(rule => {
            const kind = nativeFileLayoutKind(rule, keyword);
            return ['section-fixed', 'generic-fixed', 'ordinal-fixed', 'batch-fixed', 'element-fixed', 'element-solid-records', 'reference-fixed', 'reference-single', 'reference-tail', 'seismic-records', 'seismic-prefix-records', 'interpolation-tail', 'interpolation-local-tail', 'set-list-tail', 'ale-trim-records', 'ale-motion-single', 'controlled-reference-records', 'contact-optional-records'].includes(kind) ||
                ['ordinal-ambient', 'ordinal-d3spcm'].includes(kind) ||
                kind === 'shell' && relations.every(record => record.nativeLayout?.cardAddress === rule.cards[0]?.cardRecordId) ||
                kind?.startsWith('set-general-') || kind === 'conditional-sequence' && (simpleTail || fixedSequence);
        });
    if (rules.length !== 1) return null;
    const rule = rules[0];
    const sourceKind = nativeFileLayoutKind(rule, keyword);
    const cardSequence = sourceKind === 'conditional-sequence' ? fixedSequence : null;
    const kind = cardSequence ? 'reference-single' : sourceKind;
    const cards = nativeFileLayoutCards(rule, keyword).filter(card => !cardSequence || cardSequence.includes(card.cardIndex));
    const fieldsByCard = new Map();
    const mapped = new Set();
    for (const card of cards) {
        const records = relations.filter(record => record.nativeSources?.some(source =>
            source.cardSetId === rule.cardSetId && source.cardAddress === card.cardRecordId &&
            card.fields.some(field => field.fieldRecordId === source.fieldRecordId)));
        fieldsByCard.set(card.cardIndex, records.map(record => {
            mapped.add(record);
            const index = card.fields.findIndex(field => record.nativeSources.some(source => source.fieldRecordId === field.fieldRecordId));
            return { ...record, referenceRecord: record, nativeReadFields: card.fields, nativeReadFieldIndex: index };
        }));
    }
    // A file reader must account for every published field before it can close a block gap.
    if (relations.some(record => !mapped.has(record))) return null;
    const tailBinding = nativeFileLayout.nativeReferenceTailBinding(keyword);
    const headerCount = tailBinding?.headerCount;
    const keywordPrefixCount = spelling?.prefixCard && !spelling.originalContactPrefix &&
        !spelling.interfaceComponent && spelling.prefixScope !== 'instance' ? 1 : 0;
    const title = spelling && !spelling.originalContactPrefix && !spelling.interfaceComponent
        ? !!spelling.prefixCard && !keywordPrefixCount : /_TITLE$/.test(keyword);
    return { kind, rule, cardCount: cardSequence?.length || cards.length, cardSequence, title, keywordPrefixCount,
        nativeCards: new Map(cards.map(card => [card.cardIndex, card])), hlcTail: Boolean(tailBinding?.hlcTail),
        prefixCardCount: kind === 'seismic-prefix-records' ? 1 : 0,
        repeatedTail: keyword === 'CONSTRAINED_GENERALIZED_WELD_COMBINED' ? 2 : kind === 'reference-tail' ? headerCount + 1 :
            kind.startsWith('set-general-') || kind === 'set-list-tail' || kind === 'conditional-sequence' || kind.startsWith('interpolation-') ? 2 : null,
        tailCardCount: keyword === 'CONSTRAINED_GENERALIZED_WELD_COMBINED' ? 2 : kind === 'reference-tail' ? cards.length - headerCount : kind === 'interpolation-local-tail' ? 2 : 1,
        fieldsByCard };
}

function nativeRepeatedReferenceReader(layout, keyword, readMode, resolve?) {
    if (layout.keywordPrefixCount) {
        const body = nativeRepeatedReferenceReader({ ...layout, keywordPrefixCount: 0, title: false },
            nativeFileLayout.nativeSpellingBinding(keyword).baseKeyword, readMode, resolve);
        if (!body) return null;
        let ordinal = 0;
        return { next(text, line) {
            if (ordinal++ === 0) return { cardIndex: 0, instanceStart: 0, instanceComplete: true };
            const record = body.next(text, line);
            return record && { ...record, instanceStart: record.instanceStart + 1 };
        }, complete: () => ordinal > 1 && body.complete(), deferredReferences: body.deferredReferences };
    }
    if (layout.kind === 'shell') return nativeFileLayout
        .nativeShellReferenceRecordReader(layout.nativeCards, readMode, layout.title, resolve);
    if (['ordinal-ambient', 'ordinal-d3spcm'].includes(layout.kind)) return nativeFileLayout
        .nativeOrdinalReferenceRecordReader(layout.kind, layout.nativeCards, readMode, layout.title, resolve);
    if (layout.kind === 'contact-optional-records') {
        const { nativeContactOptionalBinding, nativeContactOptionalRecordReader } = require('../semantics/nativeContactOptionalReferences');
        const binding = nativeContactOptionalBinding(layout.rule, keyword);
        const reader = nativeContactOptionalRecordReader(binding);
        return { next(text, line) {
            const record = reader.next(text, line);
            return { ...record, instanceComplete: record.cardIndex === binding.maximumRecords };
        }, complete: reader.complete };
    }
    if (layout.kind === 'ale-trim-records') return nativeFileLayout.nativeAleTrimRecordReader();
    if (layout.kind === 'ale-motion-single') return nativeFileLayout.nativeAleMotionRecordReader();
    if (layout.kind === 'controlled-reference-records') return nativeFileLayout
        .nativeControlledReferenceRecordReader(keyword, layout.nativeCards, readMode, resolve);
    return layout.hlcTail ? nativeFileLayout
        .nativeSoilPileRecordReader(keyword, layout.nativeCards, readMode, resolve) : null;
}

function nativeRepeatedReferenceRecord(layout, ordinal, title, text = '') {
    if (layout.keywordPrefixCount) {
        if (ordinal === 1) return { cardIndex: 0, instanceStart: 0 };
        const record = nativeRepeatedReferenceRecord({ ...layout, keywordPrefixCount: 0 }, ordinal - 1, false, text);
        return record && { ...record, instanceStart: record.instanceStart + 1 };
    }
    title = layout.title ?? title;
    if (layout.cardSequence) return { cardIndex: ordinal <= Number(title) ? 0 :
        layout.cardSequence[ordinal - Number(title) - 1] || 0, instanceStart: 0, key: `record:${ordinal}` };
    if (!layout.repeatedTail) return nativeFileLayout
        .nativeFixedFileRecord(layout.kind, ordinal, title, layout.cardCount);
    const bodyOrdinal = ordinal - Number(title);
    const headerCount = layout.repeatedTail - 1;
    const cardIndex = bodyOrdinal <= 0 ? 0 : bodyOrdinal <= headerCount ? bodyOrdinal : layout.kind.startsWith('set-general-')
        ? nativeFileLayout.nativeSetGeneralRecordCard(layout.kind, text)
        : layout.repeatedTail + (bodyOrdinal - headerCount - 1) % layout.tailCardCount;
    return cardIndex === null ? null : { cardIndex, instanceStart: bodyOrdinal <= headerCount ? 0 :
        headerCount + Math.floor((bodyOrdinal - headerCount - 1) / layout.tailCardCount) * layout.tailCardCount,
        tail: bodyOrdinal > headerCount };
}

function nativeRepeatedReferenceField(record, line = null, formatMode = 'standard') {
    return { n: record.fieldName, t: record.fieldType, p: record.position,
        w: record.width, fieldIndex: record.fieldIndex,
        referenceRecord: record.referenceRecord || record,
        ...(line !== null ? { nativeReadSpan: require('../edit/keywordRecordSerializer')
            .formattedReadFields(record.nativeReadFields, line, line.includes(',') ? 'comma' : formatMode)[record.nativeReadFieldIndex] } : {}) };
}

function scanNativeLayoutRelations({ block, keyword, entries, relations, result, options, formatMode, parameters = undefined, nativeReadLayout = undefined }) {
    const nativeRelations = relations.filter(record => record.nativeLayout);
    if (!nativeRelations.length || options.referenceCatalog.infoForField !== getCatalogFieldReferenceInfo) return;
    const form = require("../semantics/catalogInputFormCatalogV4").getCatalogInputFormCatalogV4().formForKeyword(keyword, false);
    const ruleIds = [...new Set<string>(nativeRelations.map(record => String(record.nativeLayout.ruleId)))];
    const fail = source => {
        result.complete = false;
        addReason(result, 'registry-reference-native-layout-unavailable');
        addReferenceCoverageGap(result, 'registry-reference-native-layout-unavailable', block, source);
    };
    if (ruleIds.length !== 1 || !form?.rules[ruleIds[0]]) { fail(nativeRelations); return; }
    const rule = { ...form.rules[ruleIds[0]], catalogSource: form.source };
    const context = require('../semantics/nativeFileReadContext').nativeFileReadContext(rule,
        block.rawKeyword || block.keyword, entries.map(entry => entry.text), formatMode,
        entries.map(entry => entry.lineIndex), parameters, nativeReadLayout);
    const selected = context.select();
    if (context.readInputFailure || !selected?.current || selected.current.length !== entries.length) {
        fail(nativeRelations); return;
    }
    if (selected.uncertainty) {
        const uncertain = nativeRelations.filter(relation => selected.unknownCardIndexes?.includes(relation.cardIndex));
        if (uncertain.length) {
            result.complete = false;
            addReason(result, selected.uncertainty);
            addReferenceCoverageGap(result, selected.uncertainty, block, uncertain);
        }
    }
    const { formattedReadFields } = require('../edit/keywordRecordSerializer');
    for (let index = 0; index < selected.current.length; index++) {
        if (result.referenceOccurrences.length >= options.maxReferenceOccurrences ||
            result.valueDomainOccurrences.length >= options.maxValueDomainOccurrences) {
            addReferenceCoverageGap(result, 'registry-reference-capacity-exceeded', block, nativeRelations, entries[index].lineIndex);
            result.complete = false;
            addReason(result, 'registry-reference-capacity-exceeded');
            break;
        }
        const record = selected.current[index], card = context.cards.get(record.cardIndex);
        if (!card || record.cardIndex === 0) continue;
        const mode = entries[index].text.includes(',') ? 'comma' : context.readInput;
        const physical = formattedReadFields(card.fields, entries[index].text, mode);
        for (const relation of nativeRelations) {
            if (options.needed && !options.needed(relation)) continue;
            if (relation.nativeLayout.cardSetId !== rule.cardSetId ||
                relation.nativeLayout.cardAddress !== card.cardRecordId) continue;
            const fieldIndex = card.fields.findIndex(field => field.fieldRecordId === relation.nativeLayout.fieldRecordId);
            if (fieldIndex < 0 || !physical[fieldIndex]) { fail(relation); continue; }
            semanticOccurrence({ block, keyword, cardIndex: relation.cardIndex,
                field: { n: relation.fieldName, t: relation.fieldType, p: relation.position, w: relation.width,
                    fieldIndex: relation.fieldIndex, referenceRecord: relation, nativeReadSpan: physical[fieldIndex] },
                line: entries[index].text, lineIndex: entries[index].lineIndex,
                result, options, formatMode: mode, entries, parameters });
        }
    }
}

function scanNativeRepeatedBlock({ block, keyword, entries, relations, result, options, formatMode }) {
    if (options.referenceCatalog.infoForField !== getCatalogFieldReferenceInfo) return false;
    let layout = options.layoutCache?.get(keyword);
    if (layout === undefined) {
        layout = nativeRepeatedReferenceLayout(keyword, relations);
        options.layoutCache?.set(keyword, layout);
    }
    if (!layout) return false;
    const { nativeReadInputFormat, nativeReadInputFailure } = require('../semantics/nativeInputFormat');
    const readMode = nativeReadInputFormat(layout.rule, block.rawKeyword || block.keyword, formatMode);
    if (nativeReadInputFailure(layout.rule, block.rawKeyword || block.keyword, formatMode)) return false;
    const reader = nativeRepeatedReferenceReader(layout, keyword, readMode);
    const deferredEntries = [];
    for (let index = 0; index < entries.length; index++) {
        if (result.referenceOccurrences.length >= options.maxReferenceOccurrences ||
            result.valueDomainOccurrences.length >= options.maxValueDomainOccurrences) {
            result.complete = false;
            addReason(result, 'registry-reference-capacity-exceeded');
            addReferenceCoverageGap(result, 'registry-reference-capacity-exceeded', block, relations, entries[index].lineIndex);
            break;
        }
        const native = reader ? reader.next(entries[index].text, entries[index].lineIndex) :
            nativeRepeatedReferenceRecord(layout, index + 1, /_TITLE$/.test(keyword), entries[index].text);
        if (!native) {
            result.complete = false;
            addReason(result, 'registry-reference-native-layout-unavailable');
            addReferenceCoverageGap(result, 'registry-reference-native-layout-unavailable', block, relations, entries[index].lineIndex);
            continue;
        }
        const current = { ...entries[index], native };
        if (reader?.deferredReferences) {
            deferredEntries.push(current);
            if (!native.instanceComplete) continue;
        }
        for (const entry of reader?.deferredReferences ? deferredEntries : [current])
        for (const record of layout.fieldsByCard.get(entry.native.cardIndex) || []) {
            if (options.needed && !options.needed(record.referenceRecord || record)) continue;
            semanticOccurrence({ block, keyword, cardIndex: record.cardIndex,
                field: nativeRepeatedReferenceField(record, entry.text, readMode),
                line: entry.text, lineIndex: entry.lineIndex,
                result, options, formatMode,
                entries: reader?.deferredReferences ? deferredEntries : layout.repeatedTail ? [...entries.slice(0, layout.repeatedTail - 1),
                    ...entries.slice(native.instanceStart, native.instanceStart + layout.tailCardCount)] :
                    [...entries.slice(0, layout.prefixCardCount),
                        ...entries.slice(native.instanceStart, native.instanceStart + layout.cardCount - layout.prefixCardCount)] });
        }
        deferredEntries.length = 0;
    }
    const bodyCount = entries.length - layout.keywordPrefixCount;
    const size = layout.cardCount + Number(layout.title && !['ordinal-fixed', 'batch-fixed'].includes(layout.kind));
    if (reader ? !reader.complete() : layout.kind === 'reference-single' ? bodyCount < layout.cardCount + Number(layout.cardSequence && layout.title) :
        bodyCount <= 0 || !layout.repeatedTail && (bodyCount - layout.prefixCardCount) % (size - layout.prefixCardCount) !== 0 || layout.repeatedTail &&
        (bodyCount < layout.repeatedTail - 1 + Number(layout.title) ||
            (bodyCount - layout.repeatedTail + 1 - Number(layout.title)) % layout.tailCardCount !== 0)) {
        result.complete = false;
        addReason(result, 'registry-reference-native-layout-unavailable');
        addReferenceCoverageGap(result, 'registry-reference-native-layout-unavailable', block, relations);
    }
    return true;
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
    const entries = dataEntries || activeDataEntries(block, text);
    const keyword = normalizeKeyword(block.keyword);
    if (scanNativeRepeatedBlock({ block, keyword, entries, relations, result, options, formatMode })) return;
    scanNativeLayoutRelations({ block, keyword, entries, relations, result, options, formatMode });
    if (options.referenceCatalog.infoForField === getCatalogFieldReferenceInfo && relations.every(record => record.nativeLayout)) return;
    const cards = getRenderedCardsForLookup(lookup);
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
    if (entries.length > cards.length && nativeFileLayout.nativeElementBinding(keyword)) {
        result.complete = false;
        addReason(result, 'registry-reference-additional-records-unmapped');
        addReferenceCoverageGap(result, 'registry-reference-additional-records-unmapped', block, relations,
            entries[cards.length].lineIndex);
    }
}

function scanOperationalBlock({ block, text, relations, result, options, formatMode, dataEntries = null }) {
    const entries = dataEntries || activeDataEntries(block, text);
    const keyword = normalizeKeyword(block.keyword);
    if (scanNativeRepeatedBlock({ block, keyword, entries, relations, result, options, formatMode })) return;
    scanNativeLayoutRelations({ block, keyword, entries, relations, result, options, formatMode });
    const coordinates = new Map();
    for (const record of relations || []) {
        if (options.needed && !options.needed(record)) continue;
        if (record.nativeLayout && options.referenceCatalog.infoForField === getCatalogFieldReferenceInfo) continue;
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
        initialInputFormatMode?: string;
        maxReferenceOccurrences?: number;
        maxValueDomainOccurrences?: number;
        truncatedStartLines?: Set<number>;
        targetKinds?: string[];
        excludeMeshEntities?: boolean;
        sharedCache?: any;
        referenceCatalog?: {
            recordsForKeyword: (keyword: string) => any[];
            blockedForKeyword?: (keyword: string) => any[];
            infoForField: (options: any) => any;
        };
    } = {},
) {
    const catalogs = options.referenceCatalog
        ? [options.referenceCatalog] : [LSPP_REFERENCE_CATALOG, SEMANTIC_REFERENCE_CATALOG];
    const cacheFor = (catalog, name) => {
        if (!options.sharedCache || options.referenceCatalog) return new Map();
        const prefix = `scan-grammar:${catalog === LSPP_REFERENCE_CATALOG ? 'lspp' : 'semantic'}:${name}:`;
        return {
            get: key => options.sharedCache.get(prefix + key),
            set: (key, value) => options.sharedCache.set(prefix + key, value),
        };
    };
    // Each source keeps its own rule, target namespace, predicates and selector cache.
    const scans = catalogs.map(referenceCatalog => ({
        maxReferenceOccurrences: Number.isInteger(options.maxReferenceOccurrences)
            ? Math.max(1, options.maxReferenceOccurrences)
            : DEFAULT_MAX_REFERENCE_OCCURRENCES,
        maxValueDomainOccurrences: Number.isInteger(options.maxValueDomainOccurrences)
            ? Math.max(1, options.maxValueDomainOccurrences)
            : DEFAULT_MAX_VALUE_DOMAIN_OCCURRENCES,
        layoutCache: cacheFor(referenceCatalog, 'layout'),
        recordsCache: cacheFor(referenceCatalog, 'records'),
        infoCache: cacheFor(referenceCatalog, 'info'),
        formatCache: cacheFor(referenceCatalog, 'format'),
        referenceCatalog,
    }));
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
    const demanded = options.targetKinds?.length ? new Set(options.targetKinds) : null;
    const demandMatches = new WeakMap<object, boolean>();
    const needed = record => {
        if (!demanded && !options.excludeMeshEntities) return true;
        if (!demandMatches.has(record)) {
            const kinds = [...relationNamespaces(record, undefined, null).targetKinds, ...(record.targetKind ? [record.targetKind] : [])];
            // Unknown namespaces remain visible as uncertainty; never infer that they are irrelevant.
            demandMatches.set(record, !kinds.length ||
                (!options.excludeMeshEntities || !kinds.every(isMeshEntityKind)) &&
                (!demanded || kinds.some(kind => demanded.has(String(kind)))));
        }
        return demandMatches.get(record);
    };
    for (const scan of scans) (scan as any).needed = needed;
    const schema = loadKeywordSchema(() => 'en');
    const plans = new Map();
    let globalFormatMode = options.initialInputFormatMode || 'standard';
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
        const inputKeyword = normalizeKeyword(block.keyword);
        let plan = plans.get(inputKeyword);
        if (!plan) {
            const lookup = lookupKeywordSchema(block.keyword, schema);
            const canonical = normalizeKeyword(lookup?.canonicalName || block.keyword);
            const selected = [];
            for (const limits of scans) {
                const catalog = limits.referenceCatalog as NonNullable<typeof options.referenceCatalog>;
                const records = keyword => {
                    let value = limits.recordsCache.get(keyword);
                    if (!value) {
                        value = { approved: catalog.recordsForKeyword(keyword), blocked: catalog.blockedForKeyword?.(keyword) || [] };
                        limits.recordsCache.set(keyword, value);
                    }
                    return value;
                };
                const { approved: inputRelations, blocked: inputBlocked } = records(inputKeyword);
                const approvedRelations = inputRelations.length > 0 || inputKeyword === canonical
                    ? inputRelations : records(canonical).approved;
                const blockedRelations = (inputBlocked.length > 0 || inputKeyword === canonical
                    ? inputBlocked : records(canonical).blocked).filter(needed);
                if (!approvedRelations.some(needed) && !blockedRelations.length) continue;
                // Keep full grammar for controller fields; only selected references produce records.
                selected.push({ limits, approvedRelations, blockedRelations });
            }
            plan = { lookup, selected };
            plans.set(inputKeyword, plan);
        }
        const { lookup } = plan;
        let text, dataEntries;
        let counted = false;
        for (const { limits, approvedRelations, blockedRelations } of plan.selected) {
            if (!counted) { result.approvedBlocks += 1; counted = true; }
            const formatMode = keywordInputFormat(rawKeyword, globalFormatMode);
            if (text === undefined) text = await readBlockText(block);
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
            dataEntries ??= activeDataEntries(block, text);
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
    }
    if (!options.referenceCatalog && !getSemanticRuntimeCatalogV2().status().ready) {
        result.complete = false;
        addReferenceCoverageGap(result, 'registry-reference-catalog-unavailable');
    }
    result.reasons.sort();
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
    nativeReferenceCoversField,
    lsppReferenceRecordsForKeyword,
    lsppBlockedRecordsForKeyword,
    resolveSiblingTargetBinding,
    nativeRepeatedReferenceLayout,
    nativeRepeatedReferenceRecord,
    nativeRepeatedReferenceReader,
    nativeRepeatedReferenceField,
    semanticOccurrence,
    scanNativeLayoutRelations,
    LSPP_REFERENCE_CATALOG,
};

export {};
