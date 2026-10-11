'use strict';

const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { parseNumericInput } = require('./referenceInputValue');
const {
    resolveIntegerParameter,
} = require('./parameterEnvironment');
const {
    globalInputFormatFromKeywordLine,
    keywordInputFormat,
    stripKeywordInputFormatMarker,
} = require('../parser/inputFormat');
const { getReferenceRuleCatalog } = require('./referenceRuleCatalog');
const { familyDefinitionKeywords } = require('./familyDefinitionScannerCatalog');
const { nativeOccurrenceOffset } = require('./nativeIncludeOffsets');

const DEFAULT_MAX_STORED_MATCHES = 256;
const DISK_STREAM_HIGH_WATER_MARK = 256 * 1024;
const runtimeDefinitionKeywordCache = new Map();

function addResultReasons(result, ...reasons) {
    for (const reason of reasons.flat()) {
        if (reason && !result.reasons.includes(reason)) result.reasons.push(reason);
    }
}

function normalizeKeyword(value) {
    return stripKeywordInputFormatMarker(String(value || '')
        .trim()
        .replace(/^\*/, '')
        .toUpperCase()
        .split(/[\s,$]/)[0]);
}

function normalizeFilePathKey(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizedTargets(targets) {
    return new Set((targets || []).map(normalizeKeyword).filter(Boolean));
}

function runtimeDefinitionKeywords({ allowCandidate = false } = {}) {
    const family = familyDefinitionKeywords({ allowCandidate });
    const cacheKey = allowCandidate ? 'candidate' : 'approved';
    const cached = runtimeDefinitionKeywordCache.get(cacheKey);
    if (cached?.family === family.onDemand) return cached.value;
    const value = {
        generic: getReferenceRuleCatalog().metadata('definitionKeywords')?.generic || {},
        onDemand: {
            // Curve/table previews may end before their ID header. Reuse the
            // approved scanned-keyword set and its existing title/header layout.
            ...Object.fromEntries((getReferenceRuleCatalog().metadata('definitionKeywords')?.scanned || [])
                .filter(keyword => /^DEFINE_(CURVE|TABLE)(_|$)/.test(keyword))
                .map(keyword => [keyword, {
                    target: keyword,
                    targetKind: keyword.startsWith('DEFINE_CURVE') ? 'curve' : 'table',
                    fieldName: 'ID', fieldType: 'integer', fieldIndex: 0, position: 0, width: 10,
                    recordMode: 'exact-data-record-ordinal',
                    dataRecordOrdinal: keyword.includes('TITLE') ? 1 : 0,
                }])),
            ...(family.onDemand || {}),
            ...(getReferenceRuleCatalog().metadata('definitionKeywords')?.onDemand || {}),
            // Exact original selectors also need disk recovery when their header
            // was omitted by the definition preview limit.
            ...Object.fromEntries(Object.entries(getReferenceRuleCatalog().metadata('definitionKeywords')?.generic || {})
                .filter(([_keyword, descriptor]) => descriptorIsSupported(descriptor))),
        },
    };
    runtimeDefinitionKeywordCache.set(cacheKey, { family: family.onDemand, value });
    return value;
}

function selectOnDemandDefinitionDescriptors(
    targetKinds,
    targetDefinitions,
    definitionKeywords = getReferenceRuleCatalog().metadata('definitionKeywords')
) {
    const kinds = new Set(targetKinds || []);
    const definitions = normalizedTargets(targetDefinitions);
    const selected = [];
    for (const [keyword, descriptor] of Object.entries(
        definitionKeywords && definitionKeywords.onDemand || {}
    ) as Array<[string, any]>) {
        const target = normalizeKeyword(descriptor.target || keyword);
        const family = normalizeKeyword(descriptor.targetToken || '');
        const physicalKeyword = normalizeKeyword(keyword);
        const explicitDefinitionMatch = definitions.has(target) || definitions.has(family) ||
            definitions.has(physicalKeyword);
        if (definitions.size > 0 ? !explicitDefinitionMatch : !kinds.has(descriptor.targetKind)) continue;
        selected.push({
            ...descriptor,
            keyword: normalizeKeyword(keyword),
            target,
        });
    }
    selected.sort((left, right) => left.keyword.localeCompare(right.keyword));
    return selected;
}

function definitionRecordMode(descriptor) {
    if (descriptor?.recordMode === 'repeat-all-data-records' ||
        descriptor?.recordMode === 'exact-data-record-ordinal' ||
        descriptor?.recordMode === 'repeat-data-record-template') return descriptor.recordMode;
    if (descriptor?.targetKind === 'node' || descriptor?.targetKind === 'element') {
        return 'repeat-all-data-records';
    }
    return null;
}

function descriptorIsSupported(descriptor) {
    const recordMode = definitionRecordMode(descriptor);
    const identityFieldSupported = descriptor?.fieldType === 'integer' ||
        descriptor?.fieldType === 'identifier' ||
        (descriptor?.identityType === 'label' && descriptor?.fieldType === 'string');
    return !!descriptor &&
        descriptor.fieldIndex === 0 &&
        descriptor.position === 0 &&
        identityFieldSupported &&
        !!recordMode &&
        (recordMode !== 'exact-data-record-ordinal' ||
            Number.isInteger(descriptor.dataRecordOrdinal) && descriptor.dataRecordOrdinal >= 0) &&
        (recordMode !== 'repeat-data-record-template' || Number.isSafeInteger(descriptor.recordStride) &&
            descriptor.recordStride > 0 && Number.isInteger(descriptor.dataRecordOrdinal) &&
            descriptor.dataRecordOrdinal >= 0 && descriptor.dataRecordOrdinal < descriptor.recordStride) &&
        Number.isInteger(descriptor.width) &&
        descriptor.width > 0;
}

function fixedCandidateWidths(descriptor, formatMode = 'standard') {
    const contract = descriptor.formatContracts?.find(contract => contract.format === formatMode && contract.mode === 'fixed');
    if (Number.isInteger(contract?.width) && contract.width > 0) return [contract.width];
    if (formatMode === 'long') return [20];
    if (formatMode === 'i10' && descriptor.width === 8) return [10];
    return [descriptor.width];
}

function candidateFromCell(text, startCharacter, endCharacter, descriptor, formatMode) {
    const cell = text.slice(startCharacter, endCharacter);
    const raw = cell.trim();
    if (!raw) return null;
    const offset = cell.indexOf(raw);
    let input = parseNumericInput(raw, {
        integerOnly: true,
        nonZero: true,
    });
    if (input.kind === 'invalid' && [
        'positive-integer-or-alphanumeric-label',
        'label-or-positive-integer',
    ].includes(descriptor?.valueDomain?.kind)) {
        const numberInput = parseNumericInput(raw, { integerOnly: false });
        const maximum = formatMode === 'long'
            ? descriptor.valueDomain.labelLongMaxCharacters
            : descriptor.valueDomain.labelStandardMaxCharacters;
        if (numberInput.kind === 'invalid' && numberInput.reason === 'unsupported-numeric-input' &&
            (maximum === undefined || raw.length <= maximum)) {
            input = { kind: 'label', raw, value: raw };
        }
    }
    if (input.kind === 'invalid' || input.kind === 'blank') return null;
    return {
        raw,
        input,
        startCharacter: startCharacter + offset,
        endCharacter: startCharacter + offset + raw.length,
    };
}

/**
 * Extracts only officially allowed first-field representations. General
 * whitespace tokenization is intentionally excluded: LS-DYNA free format is
 * comma-delimited, while fixed NODE/ELEMENT IDs use I8/I10/I20 forms.
 */
function parseOnDemandIdCandidates(line, descriptor, options: { formatMode?: string } = {}) {
    const text = String(line || '');
    const trimmed = text.trimStart();
    if (!trimmed || trimmed.startsWith('$') || trimmed.startsWith('*')) return [];

    const candidates = [];
    if (text.includes(',')) {
        let start = 0;
        for (let index = 0; index <= descriptor.fieldIndex; index++) {
            const comma = text.indexOf(',', start);
            const end = comma >= 0 ? comma : text.length;
            if (index === descriptor.fieldIndex) {
                const candidate = candidateFromCell(text, start, end, descriptor, options.formatMode);
                if (candidate) candidates.push(candidate);
                break;
            }
            if (comma < 0) break;
            start = comma + 1;
        }
    } else {
        for (const width of fixedCandidateWidths(descriptor, options.formatMode)) {
            const candidate = candidateFromCell(
                text, descriptor.position, descriptor.position + width, descriptor, options.formatMode
            );
            if (candidate) candidates.push(candidate);
        }
    }

    return candidates;
}

function fileIndexEntries(fileIndexes) {
    if (!fileIndexes) return [];
    return fileIndexes instanceof Map
        ? [...fileIndexes.entries()]
        : Object.entries(fileIndexes);
}

function lookupPathEntry(map, filePath) {
    if (!map || !filePath) return null;
    if (map instanceof Map && map.has(filePath)) return map.get(filePath);
    if (!(map instanceof Map) && map[filePath]) return map[filePath];
    const key = normalizeFilePathKey(filePath);
    for (const [candidatePath, value] of fileIndexEntries(map)) {
        if (normalizeFilePathKey(candidatePath) === key) return value;
    }
    return null;
}

function parameterBindingsAtLine(context, lineIndex) {
    const bindings = new Map(context && context.initialBindings || []);
    const reasons = new Set(context && context.initialUncertaintyReasons || []);
    for (const point of context && context.timeline || []) {
        if (point.lineIndex > lineIndex) continue;
        for (const [name, binding] of point.updates || []) {
            if (binding) bindings.set(name, binding);
            else bindings.delete(name);
        }
        for (const reason of point.uncertaintyReasons || []) reasons.add(reason);
    }
    return { bindings, reasons: [...reasons] };
}

function syntheticLocalContext(filePath) {
    return {
        occurrenceId: `local:${filePath}`,
        occurrencePath: [`local:${filePath}`],
        occurrencePathLabels: [`local:${filePath}`],
        idfoffOffset: 0,
        inputFormatMode: 'standard',
        initialBindings: new Map(),
        initialUncertaintyReasons: [],
        timeline: [],
    };
}

function occurrenceContextsForFile(referenceIndex, filePath, projectScoped) {
    if (!projectScoped) return [syntheticLocalContext(filePath)];
    const contexts = lookupPathEntry(referenceIndex?.parameterContextsByFile, filePath);
    return Array.isArray(contexts) ? contexts : [];
}

function resolveCandidateSourceId(candidate, context, lineIndex) {
    if (candidate.input.kind === 'label') {
        return { resolved: true, value: candidate.input.value, reasons: [] };
    }
    if (candidate.input.kind === 'numeric') {
        if (!Number.isSafeInteger(candidate.input.value) || candidate.input.value <= 0) {
            return { resolved: false, reasons: ['on-demand-definition-id-invalid'] };
        }
        return { resolved: true, value: candidate.input.value, reasons: [] };
    }
    if (candidate.input.kind !== 'parameter') {
        return { resolved: false, reasons: ['on-demand-definition-expression'] };
    }
    const point = parameterBindingsAtLine(context, lineIndex);
    const resolution = resolveIntegerParameter(
        point.bindings,
        candidate.input.name,
        candidate.input.negated
    );
    const reasons = new Set(point.reasons || []);
    if (!resolution.resolved) reasons.add(resolution.reason || 'parameter-unresolved');
    if (resolution.resolved && (!Number.isSafeInteger(resolution.value) || resolution.value <= 0)) {
        reasons.add('parameter-definition-nonpositive');
    }
    return reasons.size === 0
        ? { resolved: true, value: resolution.value, resolution, reasons: [] }
        : { resolved: false, resolution, reasons: [...reasons] };
}

function resolveCandidateEffectiveId(candidate, context, lineIndex, descriptor): any {
    const sourceResolution = resolveCandidateSourceId(candidate, context, lineIndex);
    if (!sourceResolution.resolved) return sourceResolution;
    const offset = nativeOccurrenceOffset(context, [descriptor.targetKind], [descriptor.keyword]);
    if (!Number.isSafeInteger(offset)) {
        return { resolved: false, reasons: ['transform-offset-unresolved'] };
    }
    if (typeof sourceResolution.value === 'string' && offset !== 0) {
        return { resolved: false, reasons: ['label-idfoff-unsupported'] };
    }
    const effectiveId = typeof sourceResolution.value === 'string'
        ? sourceResolution.value
        : sourceResolution.value + offset;
    if (typeof effectiveId !== 'string' &&
        (!Number.isSafeInteger(effectiveId) || effectiveId <= 0)) {
        return { resolved: false, reasons: ['reference-id-offset-unsafe'] };
    }
    return {
        resolved: true,
        sourceId: sourceResolution.value,
        effectiveId,
        resolution: sourceResolution.resolution,
        reasons: [],
    };
}

function definitionFromMatch({
    block,
    descriptor,
    candidate,
    context,
    lineIndex,
    sourceId,
    effectiveId,
    parameterResolution,
}) {
    const idfoffOffset = nativeOccurrenceOffset(context, [descriptor.targetKind], [descriptor.keyword]);
    return {
        kind: 'generic',
        id: effectiveId,
        idRaw: candidate.raw,
        idInput: candidate.input,
        ...(parameterResolution ? { parameterResolution } : {}),
        keyword: `*${descriptor.keyword}`,
        targetKeyword: descriptor.targetToken || descriptor.target || descriptor.keyword,
        targetKind: descriptor.targetKind,
        filePath: block.filePath,
        startLine: block.startLine,
        endLine: block.endLine,
        idLine: lineIndex,
        idStartChar: candidate.startCharacter,
        idEndChar: candidate.endCharacter,
        sourceId,
        effectiveId,
        idfoffOffset,
        evidenceRule: idfoffOffset !== 0 ? 'E-T02' : null,
        ruleId: descriptor.ruleId,
        evidenceIds: [...(descriptor.evidenceIds || [])],
        occurrenceId: context.occurrenceId,
        occurrencePath: [...(context.occurrencePath || [])],
        occurrencePathLabels: [...(context.occurrencePathLabels || [])],
        uncertaintyReasons: [...new Set(context.uncertaintyReasons || [])],
        onDemand: true,
    };
}

function emptyDefinitionOrigin(state = 'none', reasons = []) {
    return {
        state,
        query: null,
        definitions: [],
        declarations: [],
        reasons: [...new Set(reasons)],
    };
}

function definitionOriginIdentityKey(definition) {
    return JSON.stringify([
        typeof definition.effectiveId,
        definition.effectiveId,
        definition.targetKind,
        normalizeKeyword(definition.targetKeyword),
    ]);
}

/**
 * Resolves the ID token under a cursor using the same approved descriptor and
 * physical-record rules as the project-wide on-demand scanner. The caller must
 * provide the current document line reader; no stale disk fallback is allowed.
 */
function queryOnDemandDefinitionAtPosition({
    referenceIndex,
    fileIndex,
    filePath,
    position,
    projectScoped = false,
    lineAt,
    definitionKeywords = runtimeDefinitionKeywords(),
} = {} as any) {
    if (!fileIndex || !Array.isArray(fileIndex.keywordBlocks) || !filePath ||
        !position || !Number.isInteger(position.line) || !Number.isInteger(position.character) ||
        typeof lineAt !== 'function') {
        return emptyDefinitionOrigin('incomplete', ['definition-origin-structure-unavailable']);
    }
    const blocks = fileIndex.keywordBlocks.filter(block =>
        Number.isInteger(block.startLine) && Number.isInteger(block.endLine) &&
        position.line >= block.startLine && position.line <= block.endLine
    );
    if (blocks.length === 0) return emptyDefinitionOrigin();
    if (blocks.length !== 1) {
        return emptyDefinitionOrigin('incomplete', ['definition-origin-block-ambiguous']);
    }
    const block = { ...blocks[0], filePath: blocks[0].filePath || filePath };
    const keyword = normalizeKeyword(block.keyword);
    const descriptors = Object.entries(definitionKeywords?.onDemand || {})
        .filter(([physicalKeyword]) => normalizeKeyword(physicalKeyword) === keyword)
        .map(([, descriptor]: any) => ({ ...descriptor, keyword }));
    if (descriptors.length === 0) return emptyDefinitionOrigin();
    if (descriptors.length !== 1 || !descriptorIsSupported(descriptors[0])) {
        return emptyDefinitionOrigin('incomplete', ['definition-origin-descriptor-ambiguous']);
    }
    const descriptor = descriptors[0];
    const contexts = occurrenceContextsForFile(referenceIndex, filePath, projectScoped);
    if (contexts.length === 0) {
        return emptyDefinitionOrigin('incomplete', ['on-demand-occurrence-unavailable']);
    }
    if (contexts.some(context => (context.uncertaintyReasons || []).length > 0)) {
        return emptyDefinitionOrigin('incomplete', ['definition-occurrence-indeterminate']);
    }

    const formatModeByContext = new Map(
        contexts.map(context => [context, context.inputFormatMode || 'standard'])
    );
    for (const header of fileIndex.keywordBlocks) {
        if (!Number.isInteger(header.startLine) || header.startLine > block.startLine) continue;
        if (normalizeKeyword(header.keyword) !== 'KEYWORD') continue;
        const headerText = lineAt(header.startLine);
        if (typeof headerText !== 'string') {
            return emptyDefinitionOrigin('incomplete', ['on-demand-format-header-unavailable']);
        }
        for (const context of contexts) {
            formatModeByContext.set(
                context,
                globalInputFormatFromKeywordLine(
                    headerText,
                    formatModeByContext.get(context) || 'standard'
                )
            );
        }
    }

    const recordMode = definitionRecordMode(descriptor);
    let dataRecordOrdinal = -1;
    if (recordMode === 'exact-data-record-ordinal' || recordMode === 'repeat-data-record-template') {
        for (let lineIndex = block.startLine + 1; lineIndex <= position.line; lineIndex++) {
            const text = lineAt(lineIndex);
            if (typeof text !== 'string') {
                return emptyDefinitionOrigin('incomplete', ['definition-origin-line-unavailable']);
            }
            const trimmed = text.trimStart();
            if (trimmed.startsWith('$') || trimmed.startsWith('*')) continue;
            dataRecordOrdinal += 1;
            if (recordMode === 'exact-data-record-ordinal' && dataRecordOrdinal > descriptor.dataRecordOrdinal) return emptyDefinitionOrigin();
        }
        if ((recordMode === 'repeat-data-record-template' ? dataRecordOrdinal % descriptor.recordStride : dataRecordOrdinal)
            !== descriptor.dataRecordOrdinal) return emptyDefinitionOrigin();
        if (recordMode === 'repeat-data-record-template') {
            let remaining = descriptor.recordStride - descriptor.dataRecordOrdinal - 1;
            for (let lineIndex = position.line + 1; remaining > 0 && lineIndex <= block.endLine; lineIndex++) {
                const text = lineAt(lineIndex);
                if (typeof text !== 'string') return emptyDefinitionOrigin('incomplete', ['definition-origin-line-unavailable']);
                if (text.trimStart().startsWith('*')) break;
                if (!text.trimStart().startsWith('$')) remaining--;
            }
            if (remaining > 0) return emptyDefinitionOrigin('incomplete', ['on-demand-definition-record-template-incomplete']);
        }
    }

    const line = lineAt(position.line);
    const keywordLineText = lineAt(block.startLine);
    if (typeof line !== 'string' || typeof keywordLineText !== 'string') {
        return emptyDefinitionOrigin('incomplete', ['definition-origin-line-unavailable']);
    }
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('$') || trimmed.startsWith('*')) return emptyDefinitionOrigin();

    const definitions = [];
    const reasons = [];
    for (const context of contexts) {
        const formatMode = keywordInputFormat(
            keywordLineText,
            formatModeByContext.get(context) || 'standard'
        );
        const candidates = parseOnDemandIdCandidates(line, descriptor, { formatMode })
            .filter(candidate => position.character >= candidate.startCharacter &&
                position.character < candidate.endCharacter);
        if (candidates.length === 0) return emptyDefinitionOrigin();
        const mapped = resolveCandidateEffectiveId(candidates[0], context, position.line, descriptor);
        if (!mapped.resolved) {
            reasons.push(...(mapped.reasons || ['definition-occurrence-indeterminate']));
            continue;
        }
        definitions.push(definitionFromMatch({
            block,
            descriptor,
            candidate: candidates[0],
            context,
            lineIndex: position.line,
            sourceId: mapped.sourceId,
            effectiveId: mapped.effectiveId,
            parameterResolution: mapped.resolution,
        }));
    }
    if (reasons.length > 0 || definitions.length !== contexts.length) {
        return emptyDefinitionOrigin('incomplete', reasons.length > 0
            ? reasons
            : ['definition-occurrence-indeterminate']);
    }
    const identities = new Map();
    for (const definition of definitions) {
        identities.set(definitionOriginIdentityKey(definition), definition);
    }
    if (identities.size !== 1) {
        return {
            ...emptyDefinitionOrigin('ambiguous', ['definition-occurrence-ambiguous']),
            definitions,
        };
    }
    const definition = identities.values().next().value;
    const declaration = {
        filePath: definition.filePath,
        line: definition.idLine,
        startCharacter: definition.idStartChar,
        endCharacter: definition.idEndChar,
        declaration: true,
    };
    return {
        state: 'ready',
        query: {
            id: definition.effectiveId,
            targetKinds: definition.targetKind ? [definition.targetKind] : [],
            targetDefinitions: [normalizeKeyword(definition.targetKeyword)],
        },
        definitions,
        declarations: [declaration],
        reasons: [],
    };
}

async function scanBlockLinesFromDisk(block, visitLine, cancellationToken = null, options: { dataRecordLimit?: number } = {}) {
    if (!Number.isInteger(block.startOffset) || block.startOffset < 0 ||
        !Number.isInteger(block.endOffset) || block.endOffset <= block.startOffset) {
        return { complete: false, reason: 'on-demand-block-range-unavailable', lineCount: 0 };
    }
    const input = fs.createReadStream(block.filePath, {
        start: block.startOffset,
        end: block.endOffset - 1,
        highWaterMark: options.dataRecordLimit ? 4096 : DISK_STREAM_HIGH_WATER_MARK,
    });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let lineIndex = Number.isInteger(block.startLine) ? block.startLine : 0;
    let lineCount = 0;
    let firstLine = true;
    let keywordLineText = '';
    let dataRecords = 0;
    const limit = Number.isSafeInteger(options.dataRecordLimit) && options.dataRecordLimit > 0
        ? options.dataRecordLimit : Infinity;
    try {
        for await (const line of lines) {
            if (cancellationToken?.isCancellationRequested) {
                return { complete: false, cancelled: true, lineCount };
            }
            if (!firstLine) {
                const pending = visitLine(String(line), lineIndex, { keywordLineText });
                if (pending && typeof pending.then === 'function') await pending;
                lineCount += 1;
                if (!String(line).trimStart().startsWith('$') && !String(line).trimStart().startsWith('*')) dataRecords++;
                if (dataRecords >= limit) return { complete: true, lineCount, keywordLineText };
            } else {
                keywordLineText = String(line);
            }
            firstLine = false;
            lineIndex += 1;
        }
        return { complete: true, lineCount, keywordLineText };
    } catch (_error) {
        if (cancellationToken?.isCancellationRequested) {
            return { complete: false, cancelled: true, lineCount };
        }
        return { complete: false, reason: 'on-demand-file-read-failed', lineCount };
    } finally {
        lines.close();
        input.destroy();
    }
}

async function scanOnDemandDefinitions({
    referenceIndex,
    fileIndexes,
    effectiveId,
    targetKinds = [],
    targetDefinitions = [],
    projectScoped = false,
    cancellationToken = null,
    scanBlockLines = scanBlockLinesFromDisk,
    maxStoredMatches = DEFAULT_MAX_STORED_MATCHES,
    collectAllIds = false,
    acceptDefinition = null,
    retainDefinitions = true,
    definitionKeywords = runtimeDefinitionKeywords(),
} = {} as any) {
    if (!retainDefinitions && typeof acceptDefinition !== 'function')
        throw new TypeError('Streaming definitions requires a record consumer');
    const descriptors = selectOnDemandDefinitionDescriptors(
        targetKinds,
        targetDefinitions,
        definitionKeywords
    );
    const result: any = {
        state: 'complete',
        definitions: [],
        reasons: [],
        descriptors,
        scannedBlockCount: 0,
        scannedLineCount: 0,
        totalMatchCount: 0,
        cacheable: true,
    };
    if (cancellationToken?.isCancellationRequested) {
        result.state = 'cancelled';
        return result;
    }
    const effectiveIdentityValid = typeof effectiveId === 'string'
        ? effectiveId.length > 0
        : Number.isSafeInteger(effectiveId) && effectiveId > 0;
    if (!effectiveIdentityValid && !collectAllIds) {
        result.state = 'partial';
        addResultReasons(result, 'on-demand-reference-id-unresolved');
        return result;
    }
    if (descriptors.length === 0) {
        result.state = 'partial';
        addResultReasons(result, 'on-demand-descriptor-unavailable');
        return result;
    }
    if (!fileIndexes || fileIndexEntries(fileIndexes).length === 0) {
        result.state = 'partial';
        addResultReasons(result, 'on-demand-scan-unavailable');
        return result;
    }

    const descriptorByKeyword = new Map();
    for (const descriptor of descriptors) {
        if (!descriptorIsSupported(descriptor)) {
            addResultReasons(result, 'on-demand-descriptor-unsupported');
            result.state = 'partial';
            continue;
        }
        descriptorByKeyword.set(descriptor.keyword, descriptor);
    }

    const seenMatches = new Set();
    for (const [filePath, fileIndex] of fileIndexEntries(fileIndexes)) {
        if (cancellationToken?.isCancellationRequested) {
            result.state = 'cancelled';
            return result;
        }
        if (!fileIndex || !Array.isArray(fileIndex.keywordBlocks)) {
            addResultReasons(result, 'on-demand-structure-index-unavailable');
            result.state = 'partial';
            continue;
        }
        if (Number.isInteger(fileIndex.documentVersion)) result.cacheable = false;
        const contexts = occurrenceContextsForFile(referenceIndex, filePath, projectScoped);
        if (contexts.length === 0) {
            addResultReasons(result, 'on-demand-occurrence-unavailable');
            result.state = 'partial';
            continue;
        }

        const formatModeByContext = new Map(
            contexts.map(context => [context, context.inputFormatMode || 'standard'])
        );
        for (const sourceBlock of fileIndex.keywordBlocks) {
            if (normalizeKeyword(sourceBlock.keyword) === 'KEYWORD') {
                const headerBlock = {
                    ...sourceBlock,
                    filePath: sourceBlock.filePath || filePath,
                };
                const headerResult = await scanBlockLines(
                    headerBlock,
                    () => {},
                    cancellationToken
                );
                if (headerResult && headerResult.cancelled || cancellationToken?.isCancellationRequested) {
                    result.state = 'cancelled';
                    return result;
                }
                if (!headerResult || headerResult.complete !== true) {
                    result.state = 'partial';
                    addResultReasons(result,
                        headerResult && headerResult.reason || 'on-demand-format-header-unavailable'
                    );
                } else {
                    for (const context of contexts) {
                        formatModeByContext.set(
                            context,
                            globalInputFormatFromKeywordLine(
                                headerResult.keywordLineText,
                                formatModeByContext.get(context) || 'standard'
                            )
                        );
                    }
                }
                continue;
            }
            const descriptor = descriptorByKeyword.get(normalizeKeyword(sourceBlock.keyword));
            if (!descriptor) continue;
            for (const context of contexts) {
                if ((context.uncertaintyReasons || []).length > 0) {
                    result.state = 'partial';
                    addResultReasons(result, context.uncertaintyReasons);
                }
            }
            const block = {
                ...sourceBlock,
                filePath: sourceBlock.filePath || filePath,
            };
            const recordMode = definitionRecordMode(descriptor);
            let dataRecordOrdinal = -1;
            let pendingTemplateRecord: any = null;
            const blockResult = await scanBlockLines(
                block,
                (line, lineIndex, metadata: any = {}) => {
                    const physicalText = String(line || '');
                    const physicalTrimmed = physicalText.trimStart();
                    if (physicalTrimmed.startsWith('$') || physicalTrimmed.startsWith('*')) return;
                    dataRecordOrdinal += 1;
                    if (recordMode === 'exact-data-record-ordinal' &&
                        dataRecordOrdinal !== descriptor.dataRecordOrdinal) return;
                    if (recordMode === 'repeat-data-record-template') {
                        if (dataRecordOrdinal % descriptor.recordStride === descriptor.dataRecordOrdinal)
                            pendingTemplateRecord = { line, lineIndex, metadata };
                        if (dataRecordOrdinal % descriptor.recordStride !== descriptor.recordStride - 1 || !pendingTemplateRecord) return;
                        ({ line, lineIndex, metadata } = pendingTemplateRecord);
                        pendingTemplateRecord = null;
                    }
                    const candidatesByMode = new Map();
                    // Each reader visits a physical record once. Bound deduplication
                    // to its contexts even when retained matches reach capacity.
                    const seenLineMatches = new Set();
                    for (const context of contexts) {
                        const formatMode = keywordInputFormat(
                            metadata.keywordLineText || sourceBlock.rawKeyword || sourceBlock.keyword,
                            formatModeByContext.get(context) || 'standard'
                        );
                        if (!candidatesByMode.has(formatMode)) {
                            candidatesByMode.set(
                                formatMode,
                                parseOnDemandIdCandidates(line, descriptor, { formatMode })
                            );
                        }
                        for (const candidate of candidatesByMode.get(formatMode)) {
                            const mapped = resolveCandidateEffectiveId(candidate, context, lineIndex, descriptor);
                            if (!mapped.resolved) {
                                addResultReasons(result, mapped.reasons);
                                result.state = 'partial';
                                continue;
                            }
                            if (!collectAllIds && mapped.effectiveId !== effectiveId) continue;
                            const definition = definitionFromMatch({
                                block,
                                descriptor,
                                candidate,
                                context,
                                lineIndex,
                                sourceId: mapped.sourceId,
                                effectiveId: mapped.effectiveId,
                                parameterResolution: mapped.resolution,
                            });
                            const key = JSON.stringify([
                                normalizeFilePathKey(definition.filePath),
                                definition.idLine,
                                definition.idStartChar,
                                definition.idEndChar,
                                definition.occurrencePath.length ? definition.occurrencePath : definition.occurrenceId,
                            ]);
                            if (seenMatches.has(key) || seenLineMatches.has(key)) continue;
                            seenLineMatches.add(key);
                            result.totalMatchCount += 1;
                            if (!retainDefinitions && (definition.uncertaintyReasons || []).length) {
                                result.state = 'partial';
                                addResultReasons(result, definition.uncertaintyReasons);
                            }
                            if (acceptDefinition && acceptDefinition(definition) === false) {
                                if (!retainDefinitions) {
                                    result.state = 'partial';
                                    addResultReasons(result, 'on-demand-definition-consumer-rejected');
                                }
                                return;
                            }
                            if (retainDefinitions && result.definitions.length < maxStoredMatches) {
                                seenMatches.add(key);
                                result.definitions.push(definition);
                            }
                        }
                    }
                },
                cancellationToken,
                recordMode === 'exact-data-record-ordinal' ? { dataRecordLimit: descriptor.dataRecordOrdinal + 1 } : {}
            );
            result.scannedBlockCount += 1;
            result.scannedLineCount += blockResult && blockResult.lineCount || 0;
            if (blockResult && blockResult.cancelled || cancellationToken?.isCancellationRequested) {
                result.state = 'cancelled';
                return result;
            }
            if (!blockResult || blockResult.complete !== true) {
                result.state = 'partial';
                addResultReasons(
                    result,
                    blockResult && blockResult.reason || 'on-demand-scan-unavailable'
                );
            }
            if (pendingTemplateRecord) {
                result.state = 'partial';
                addResultReasons(result, 'on-demand-definition-record-template-incomplete');
            }
        }
    }

    if (retainDefinitions && result.totalMatchCount > result.definitions.length) {
        result.state = 'partial';
        addResultReasons(result, 'on-demand-results-truncated');
    }
    for (const definition of result.definitions) {
        if ((definition.uncertaintyReasons || []).length > 0) {
            result.state = 'partial';
            addResultReasons(result, definition.uncertaintyReasons);
        }
    }
    result.reasons = [...new Set(result.reasons)];
    return result;
}

function mergeOnDemandDefinitions(analysis, lookup, referenceIndex = null) {
    if (!analysis || !lookup || lookup.state === 'cancelled') return analysis;
    let definitions = [
        ...(analysis.definitions || []),
        ...(lookup.definitions || []),
    ];
    const reasons = (analysis.reasons || []).filter(reason =>
        lookup.state !== 'complete' ||
        ![
            'target-kind-on-demand',
            'target-definition-on-demand',
            'target-kind-unindexed',
            'target-definition-unindexed',
            'lspp-target-priority-unresolved',
        ].includes(reason)
    );
    let targetSelection = analysis.targetSelection;
    if (analysis.targetSearch) {
        const { selectReferenceTargetSearch } = require('./projectReferenceIndex');
        targetSelection = selectReferenceTargetSearch({ ...(referenceIndex || {}),
            queryDefinitionLookup: { ...lookup, definitions, id: analysis.id,
                targetKinds: (lookup.descriptors || []).map(descriptor => descriptor.targetKind).filter(Boolean),
                targetDefinitions: (lookup.descriptors || []).map(descriptor => normalizeKeyword(descriptor.keyword)) } },
            analysis.id, analysis.targetSearch);
        definitions = targetSelection.definitions;
        reasons.push(...targetSelection.reasons);
    }
    reasons.push(...(lookup.reasons || []));
    const uniqueReasons = [...new Set(reasons)];
    return {
        ...analysis,
        state: uniqueReasons.length > 0
            ? 'uncertain'
            : definitions.length === 0
                ? 'missing'
                : definitions.length === 1
                    ? 'exact'
                    : 'ambiguous',
        definitions,
        reasons: uniqueReasons,
        onDemandLookup: lookup,
        ...(analysis.targetSearch ? { targetSelection, targetKinds: targetSelection.target?.targetKinds || [],
            targetDefinitions: targetSelection.target?.targetKeywords || [] } : {}),
    };
}

module.exports = {
    definitionRecordMode,
    fixedCandidateWidths,
    globalInputFormatFromKeywordLine,
    keywordInputFormat,
    mergeOnDemandDefinitions,
    parseOnDemandIdCandidates,
    queryOnDemandDefinitionAtPosition,
    runtimeDefinitionKeywords,
    scanBlockLinesFromDisk,
    scanOnDemandDefinitions,
    selectOnDemandDefinitionDescriptors,
};

export {};
