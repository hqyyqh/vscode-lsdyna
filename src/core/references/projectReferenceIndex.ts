'use strict';

const path = require('path');
const {
    createParameterRuntimeState,
    enterParameterFile,
    leaveParameterFile,
    applyParameterEvent,
    snapshotVisibleParameterBindings,
    getVisibleParameterBinding,
    resolveIntegerParameter,
} = require('./parameterEnvironment');

function normalizeKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function emptyReferenceIndex(files = []) {
    return {
        curvesById: new Map(),
        tablesById: new Map(),
        unresolvedCurves: [],
        unresolvedTables: [],
        genericDefinitionsByKeyword: new Map(),
        unresolvedGenericDefinitionsByKeyword: new Map(),
        completenessReasons: [],
        files,
        occurrenceCount: 0,
        parameterContextsByFile: new Map(),
        rootFile: null,
    };
}

function getFileIndex(fileIndexes, filePath) {
    if (!fileIndexes) {
        return null;
    }
    if (fileIndexes instanceof Map) {
        return fileIndexes.get(filePath) || null;
    }
    return fileIndexes[filePath] || null;
}

function normalizeFilePathKey(filePath) {
    const resolved = path.resolve(String(filePath || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function addDefinition(targetMap, definition) {
    if (!definition || !Number.isFinite(definition.id)) {
        return;
    }
    if (!targetMap.has(definition.id)) {
        targetMap.set(definition.id, []);
    }
    targetMap.get(definition.id).push(definition);
}

function definitionReason(definition) {
    const input = definition && definition.idInput;
    if (!input || input.kind === 'numeric') return null;
    if (definition.parameterResolution && definition.parameterResolution.resolved) return null;
    if (input.kind === 'parameter') return 'parameter-unresolved';
    if (input.kind === 'expression') return 'parameter-expression-unresolved';
    return 'reference-id-unresolved';
}

function targetCollection(index, kind, keyword) {
    if (kind === 'generic') {
        const target = normalizeKeyword(keyword);
        if (!index.genericDefinitionsByKeyword.has(target)) {
            index.genericDefinitionsByKeyword.set(target, new Map());
            index.unresolvedGenericDefinitionsByKeyword.set(target, []);
        }
        return {
            map: index.genericDefinitionsByKeyword.get(target),
            unresolved: index.unresolvedGenericDefinitionsByKeyword.get(target),
        };
    }
    return kind === 'table'
        ? { map: index.tablesById, unresolved: index.unresolvedTables }
        : { map: index.curvesById, unresolved: index.unresolvedCurves };
}

function resolveParameterizedDefinition(definition, bindings) {
    const input = definition && definition.idInput;
    if (!input || input.kind !== 'parameter') return definition;
    const resolution = resolveIntegerParameter(bindings, input.name, input.negated);
    if (!resolution.resolved || resolution.value <= 0) {
        return {
            ...definition,
            parameterResolution: {
                ...resolution,
                resolved: false,
                reason: resolution.resolved
                    ? 'parameter-definition-nonpositive'
                    : resolution.reason,
            },
        };
    }
    return {
        ...definition,
        id: resolution.value,
        parameterResolution: {
            ...resolution,
            resolved: true,
            parameterName: input.name,
            raw: input.raw,
        },
    };
}

function addDefinitionOccurrence(
    index,
    definition,
    occurrenceContext,
    bindings = null,
    parameterUncertaintyReasons = []
) {
    if (!definition) return;
    const effectiveDefinition = resolveParameterizedDefinition(definition, bindings);
    const runtimeOccurrenceId = occurrenceContext.occurrencePath.join(' > ');
    const sourceId = effectiveDefinition.id;
    const idfoffOffset = occurrenceContext.idfoffOffset;
    let effectiveId = sourceId;
    const candidate = {
        ...effectiveDefinition,
        occurrenceId: runtimeOccurrenceId,
        occurrencePath: [...occurrenceContext.occurrencePath],
        occurrencePathLabels: [...(occurrenceContext.occurrencePathLabels || [])],
        sourceId,
        effectiveId,
        idfoffOffset,
        evidenceRule: Number.isSafeInteger(idfoffOffset) && idfoffOffset !== 0
            ? 'E-T02'
            : null,
        uncertaintyReasons: [
            ...occurrenceContext.uncertaintyReasons,
            ...parameterUncertaintyReasons,
        ],
    };
    if (Number.isFinite(sourceId) && idfoffOffset !== null && idfoffOffset !== undefined) {
        effectiveId = sourceId + idfoffOffset;
        if (sourceId <= 0 ||
            !Number.isSafeInteger(sourceId) ||
            !Number.isSafeInteger(idfoffOffset) ||
            !Number.isSafeInteger(effectiveId) ||
            effectiveId <= 0) {
            candidate.uncertaintyReasons.push('reference-id-offset-unsafe');
        } else {
            candidate.id = effectiveId;
            candidate.effectiveId = effectiveId;
        }
    }
    const target = targetCollection(
        index,
        effectiveDefinition.kind,
        effectiveDefinition.targetKeyword || effectiveDefinition.keyword
    );
    const idReason = definitionReason(effectiveDefinition);
    if (idReason) {
        candidate.uncertaintyReasons.push(idReason);
    }
    candidate.uncertaintyReasons = [...new Set(candidate.uncertaintyReasons)];
    if (Number.isFinite(candidate.id) && candidate.uncertaintyReasons.length === 0) {
        addDefinition(target.map, candidate);
    } else {
        target.unresolved.push(candidate);
    }
}

function fileHasKeyword(fileIndex, keywordPrefix) {
    return !!fileIndex && (fileIndex.keywordBlocks || []).some(block =>
        String(block.keyword || '').toUpperCase().startsWith(keywordPrefix)
    );
}

function transformReasons(
    edge,
    childFileIndex,
    ancestorRelevantTransformCount,
    ancestorTransformDepth,
    ancestorIdfoffOffset
) {
    const reasons = [];
    let relevantTransformCount = ancestorRelevantTransformCount;
    let transformDepth = ancestorTransformDepth;
    let idfoffOffset = ancestorIdfoffOffset;
    const transform = edge && edge.transform;
    if (!transform) {
        if (String(edge && edge.keyword || '').toUpperCase().startsWith('*INCLUDE_TRANSFORM')) {
            transformDepth += 1;
            reasons.push('transform-offset-unresolved');
            relevantTransformCount += 1;
            idfoffOffset = null;
            if (relevantTransformCount > 1) {
                reasons.push('nested-transform-unsupported');
            }
        }
        if (transformDepth > 0 && fileHasKeyword(childFileIndex, '*PARAMETER_TYPE')) {
            reasons.push('parameter-type-transform-unsupported');
        }
        return { reasons, relevantTransformCount, transformDepth, idfoffOffset };
    }

    transformDepth += 1;
    const idfoff = transform.offsets && transform.offsets.idfoff;
    const isSafeNumeric = idfoff &&
        idfoff.kind === 'numeric' &&
        Number.isSafeInteger(idfoff.value);
    const isKnownZero = isSafeNumeric && idfoff.value === 0;
    if (!isKnownZero) {
        relevantTransformCount += 1;
        if (!isSafeNumeric ||
            relevantTransformCount > 1 ||
            !Number.isSafeInteger(idfoffOffset)) {
            reasons.push('transform-offset-unresolved');
            idfoffOffset = null;
        } else {
            idfoffOffset += idfoff.value;
            if (!Number.isSafeInteger(idfoffOffset)) {
                reasons.push('transform-offset-unresolved');
                idfoffOffset = null;
            }
        }
    }
    if (relevantTransformCount > 1) {
        reasons.push('nested-transform-unsupported');
        idfoffOffset = null;
    }
    if (fileHasKeyword(childFileIndex, '*PARAMETER_TYPE')) {
        reasons.push('parameter-type-transform-unsupported');
    }
    return { reasons, relevantTransformCount, transformDepth, idfoffOffset };
}

function groupOccurrencesByParent(graph) {
    const grouped = new Map();
    for (const occurrence of graph && Array.isArray(graph.includeOccurrences)
        ? graph.includeOccurrences
        : []) {
        if (!grouped.has(occurrence.fromFile)) {
            grouped.set(occurrence.fromFile, []);
        }
        grouped.get(occurrence.fromFile).push(occurrence);
    }
    return grouped;
}

function addFileDefinitions(index, fileIndex, context) {
    const definitions = fileIndex && fileIndex.referenceDefinitions;
    if (!definitions) return;
    for (const curve of definitions.curves || []) {
        addDefinitionOccurrence(index, curve, context);
    }
    for (const table of definitions.tables || []) {
        addDefinitionOccurrence(index, table, context);
    }
    for (const definition of definitions.genericDefinitions || []) {
        addDefinitionOccurrence(index, definition, context);
    }
}

function fileDefinitions(fileIndex) {
    const definitions = fileIndex && fileIndex.referenceDefinitions;
    return [
        ...(definitions && definitions.curves || []),
        ...(definitions && definitions.tables || []),
        ...(definitions && definitions.genericDefinitions || []),
    ];
}

function recordParameterPoint(
    index,
    filePath,
    runtimeContext,
    lineIndex,
    state,
    updatedNames = []
) {
    if (!runtimeContext.initialBindings) {
        runtimeContext.initialBindings = snapshotVisibleParameterBindings(state);
        runtimeContext.initialUncertaintyReasons = [...state.uncertaintyReasons];
    }
    const updates = new Map();
    for (const name of [...new Set(updatedNames)]) {
        const binding = getVisibleParameterBinding(state, name);
        updates.set(name, binding || null);
    }
    const point = {
        lineIndex,
        updates,
        uncertaintyReasons: [...state.uncertaintyReasons],
    };
    runtimeContext.timeline.push(point);
    if (!index.parameterContextsByFile.has(filePath)) {
        index.parameterContextsByFile.set(filePath, []);
    }
    if (!index.parameterContextsByFile.get(filePath).includes(runtimeContext)) {
        index.parameterContextsByFile.get(filePath).push(runtimeContext);
    }
}

function buildOccurrenceAwareIndex(index, snapshot, fileIndexes) {
    const occurrencesByParent = groupOccurrencesByParent(snapshot.graph);
    const visitCountsByFile = new Map();
    const parameterState = createParameterRuntimeState();

    function visit(filePath, context, ancestry) {
        index.occurrenceCount += 1;
        const priorVisitCount = visitCountsByFile.get(filePath) || 0;
        visitCountsByFile.set(filePath, priorVisitCount + 1);
        const reusedOccurrenceSearchContext = priorVisitCount > 0;
        const fileIndex = getFileIndex(fileIndexes, filePath);
        const runtimeParameterContext = {
            occurrenceId: context.occurrenceId,
            occurrencePath: [...context.occurrencePath],
            occurrencePathLabels: [...context.occurrencePathLabels],
            idfoffOffset: context.idfoffOffset,
            timeline: [],
            initialBindings: null,
            initialUncertaintyReasons: [],
        };
        enterParameterFile(parameterState, context.occurrenceId, filePath);
        recordParameterPoint(index, filePath, runtimeParameterContext, -1, parameterState);

        const actions = [
            ...(fileIndex && fileIndex.parameterEvents || []).map(event => ({
                type: 'parameter',
                lineIndex: Number.isInteger(event.lineIndex) ? event.lineIndex : 0,
                sequence: Number.isInteger(event.sequence) ? event.sequence : 0,
                event,
            })),
            ...fileDefinitions(fileIndex).map(definition => ({
                type: 'definition',
                lineIndex: Number.isInteger(definition.startLine) ? definition.startLine : 0,
                sequence: 0,
                definition,
            })),
            ...(occurrencesByParent.get(filePath) || []).map(edge => ({
                type: 'include',
                lineIndex: Number.isInteger(edge.keywordLine)
                    ? edge.keywordLine
                    : Number.isInteger(edge.lineIndex)
                        ? edge.lineIndex
                        : 0,
                sequence: 0,
                edge,
            })),
        ].sort((left, right) =>
            left.lineIndex - right.lineIndex ||
            (left.type === 'parameter' ? -1 : left.type === 'include' ? 0 : 1) -
                (right.type === 'parameter' ? -1 : right.type === 'include' ? 0 : 1) ||
            left.sequence - right.sequence
        );

        for (const action of actions) {
            if (action.type === 'parameter') {
                applyParameterEvent(parameterState, action.event);
                recordParameterPoint(
                    index,
                    filePath,
                    runtimeParameterContext,
                    action.lineIndex,
                    parameterState,
                    action.event.type === 'definition' ? [action.event.name] : []
                );
                continue;
            }
            if (action.type === 'definition') {
                const bindings = action.definition && action.definition.idInput &&
                    action.definition.idInput.kind === 'parameter'
                    ? snapshotVisibleParameterBindings(parameterState)
                    : null;
                addDefinitionOccurrence(
                    index,
                    action.definition,
                    context,
                    bindings,
                    bindings ? [...parameterState.uncertaintyReasons] : []
                );
                continue;
            }

            const edge = action.edge;
            const childPath = edge.filePath;
            const childReasons = [...context.uncertaintyReasons];
            if (reusedOccurrenceSearchContext) {
                childReasons.push('occurrence-search-path-unavailable');
            }
            if (edge.parameterizedFileName || /&[A-Za-z_][A-Za-z0-9_-]{0,8}/.test(edge.fileName || '')) {
                childReasons.push('parameterized-include-unresolved');
            }
            if (edge.missing) {
                childReasons.push('missing-include');
                index.unresolvedCurves.push({
                    kind: 'unknownCurveDefinition',
                    occurrenceId: edge.occurrenceId,
                    occurrencePath: [...context.occurrencePath, edge.occurrenceId],
                    uncertaintyReasons: [...new Set(childReasons)],
                });
                index.unresolvedTables.push({
                    kind: 'unknownTableDefinition',
                    occurrenceId: edge.occurrenceId,
                    occurrencePath: [...context.occurrencePath, edge.occurrenceId],
                    uncertaintyReasons: [...new Set(childReasons)],
                });
                continue;
            }
            if (!childPath) continue;
            if (ancestry.includes(childPath) || edge.cycle) {
                childReasons.push('include-cycle');
                index.unresolvedCurves.push({
                    kind: 'unknownCurveDefinition',
                    occurrenceId: edge.occurrenceId,
                    occurrencePath: [...context.occurrencePath, edge.occurrenceId],
                    uncertaintyReasons: [...new Set(childReasons)],
                });
                index.unresolvedTables.push({
                    kind: 'unknownTableDefinition',
                    occurrenceId: edge.occurrenceId,
                    occurrencePath: [...context.occurrencePath, edge.occurrenceId],
                    uncertaintyReasons: [...new Set(childReasons)],
                });
                continue;
            }

            const childFileIndex = getFileIndex(fileIndexes, childPath);
            const sourceLine = Number.isInteger(edge.lineIndex)
                ? `:${edge.lineIndex + 1}`
                : '';
            const occurrenceLabel =
                `${edge.fromFile || filePath}${sourceLine} -> ${edge.fileName || childPath}`;
            const transformState = transformReasons(
                edge,
                childFileIndex,
                context.relevantTransformCount,
                context.transformDepth,
                context.idfoffOffset
            );
            childReasons.push(...transformState.reasons);
            const globalChangeStart = parameterState.globalChanges.length;
            visit(childPath, {
                occurrenceId: edge.occurrenceId,
                occurrencePath: [...context.occurrencePath, edge.occurrenceId],
                occurrencePathLabels: [...context.occurrencePathLabels, occurrenceLabel],
                uncertaintyReasons: [...new Set(childReasons)],
                relevantTransformCount: transformState.relevantTransformCount,
                transformDepth: transformState.transformDepth,
                idfoffOffset: transformState.idfoffOffset,
            }, [...ancestry, childPath]);
            recordParameterPoint(
                index,
                filePath,
                runtimeParameterContext,
                action.lineIndex,
                parameterState,
                parameterState.globalChanges.slice(globalChangeStart)
            );
        }

        leaveParameterFile(parameterState);
    }

    visit(snapshot.rootFile, {
        occurrenceId: 'root',
        occurrencePath: ['root'],
        occurrencePathLabels: ['root'],
        uncertaintyReasons: [],
        relevantTransformCount: 0,
        transformDepth: 0,
        idfoffOffset: 0,
    }, [snapshot.rootFile]);
}

function buildLegacyFileIndex(index, files, fileIndexes) {
    for (const filePath of files) {
        addFileDefinitions(index, getFileIndex(fileIndexes, filePath), {
            occurrenceId: `legacy:${filePath}`,
            occurrencePath: [`legacy:${filePath}`],
            occurrencePathLabels: [`legacy:${filePath}`],
            uncertaintyReasons: [],
            relevantTransformCount: 0,
            transformDepth: 0,
            idfoffOffset: 0,
        });
        index.occurrenceCount += 1;
    }
}

function buildProjectReferenceIndex(snapshot) {
    if (!snapshot) {
        return emptyReferenceIndex();
    }
    const fileIndexes = snapshot.fileIndexes || new Map();
    const files = Array.isArray(snapshot.files)
        ? snapshot.files.slice()
        : fileIndexes instanceof Map
            ? [...fileIndexes.keys()]
            : Object.keys(fileIndexes);
    const index = emptyReferenceIndex(files);
    index.rootFile = snapshot.rootFile || null;
    const occurrences = snapshot.graph && snapshot.graph.includeOccurrences;

    if (snapshot.rootFile &&
        Array.isArray(occurrences) &&
        snapshot.graph.includeOccurrencesComplete !== false) {
        buildOccurrenceAwareIndex(index, snapshot, fileIndexes);
    } else {
        buildLegacyFileIndex(index, files, fileIndexes);
        index.completenessReasons.push('project-scan-unavailable');
    }

    return index;
}

function resolveReferenceDefinitions(referenceIndex, id, targetKinds, targetDefinitions = []) {
    if (!referenceIndex || !Number.isFinite(id)) {
        return [];
    }
    const kinds = new Set(targetKinds || []);
    const definitions = [];
    if (kinds.has('curve') || kinds.has('functionCurve')) {
        const curves = referenceIndex.curvesById && referenceIndex.curvesById.get(id);
        if (curves) {
            definitions.push(...curves);
        }
    }
    if (kinds.has('table')) {
        const tables = referenceIndex.tablesById && referenceIndex.tablesById.get(id);
        if (tables) {
            definitions.push(...tables);
        }
    }
    for (const target of targetDefinitions) {
        const definitionsById = referenceIndex.genericDefinitionsByKeyword &&
            referenceIndex.genericDefinitionsByKeyword.get(normalizeKeyword(target));
        const matches = definitionsById && definitionsById.get(id);
        if (matches) {
            definitions.push(...matches);
        }
    }
    return definitions;
}

function unresolvedForKinds(referenceIndex, targetKinds, targetDefinitions = []) {
    const kinds = new Set(targetKinds || []);
    const unresolved = [];
    if (kinds.has('curve') || kinds.has('functionCurve')) {
        unresolved.push(...(referenceIndex.unresolvedCurves || []));
    }
    if (kinds.has('table')) {
        unresolved.push(...(referenceIndex.unresolvedTables || []));
    }
    for (const target of targetDefinitions) {
        unresolved.push(...(
            referenceIndex.unresolvedGenericDefinitionsByKeyword &&
            referenceIndex.unresolvedGenericDefinitionsByKeyword.get(normalizeKeyword(target)) ||
            []
        ));
    }
    return unresolved;
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

function occurrenceContextsForDocument(referenceIndex, documentPath) {
    if (!documentPath) return [];
    const contextsByFile = referenceIndex && referenceIndex.parameterContextsByFile;
    let contexts = contextsByFile && contextsByFile.get(documentPath) || [];
    if (contexts.length === 0 && contextsByFile) {
        const documentKey = normalizeFilePathKey(documentPath);
        for (const [filePath, candidates] of contextsByFile) {
            if (normalizeFilePathKey(filePath) === documentKey) {
                contexts = candidates;
                break;
            }
        }
    }
    return contexts;
}

function resolveParameterReferenceAtLocation(referenceIndex, referenceValue, options) {
    const documentPath = options && options.documentPath;
    if (!documentPath) {
        return {
            resolved: false,
            reasons: ['parameter-unresolved'],
        };
    }
    const lineIndex = Number.isInteger(options && options.lineIndex)
        ? options.lineIndex
        : Number.MAX_SAFE_INTEGER;
    const contexts = occurrenceContextsForDocument(referenceIndex, documentPath);
    if (contexts.length === 0) {
        return {
            resolved: false,
            reasons: ['parameter-unresolved'],
        };
    }

    const results = [];
    const reasons = new Set();
    for (const context of contexts) {
        const point = parameterBindingsAtLine(context, lineIndex);
        if (!point || !point.bindings) {
            reasons.add('parameter-environment-unavailable');
            continue;
        }
        for (const reason of point.reasons || []) {
            reasons.add(reason);
        }
        const result = resolveIntegerParameter(
            point.bindings,
            referenceValue.parameterName,
            referenceValue.isSignedSwitch
        );
        if (!result.resolved) {
            reasons.add(result.reason || 'parameter-unresolved');
            continue;
        }
        results.push({
            ...result,
            occurrencePath: [...context.occurrencePath],
            occurrencePathLabels: [...context.occurrencePathLabels],
        });
    }

    if (reasons.size > 0 || results.length !== contexts.length) {
        return {
            resolved: false,
            results,
            reasons: reasons.size > 0 ? [...reasons] : ['parameter-unresolved'],
        };
    }
    const values = [...new Set(results.map(result => result.value))];
    if (values.length !== 1) {
        return {
            resolved: false,
            results,
            reasons: ['parameter-occurrence-ambiguous'],
        };
    }
    if (values[0] === 0) {
        return {
            resolved: false,
            results,
            reasons: ['parameter-reference-zero'],
        };
    }
    return {
        resolved: true,
        value: values[0],
        results,
        reasons: [],
    };
}

function analyzeParameterReferenceAtLocation(
    referenceIndex,
    parameterName,
    options: { documentPath?: string; lineIndex?: number } = {}
) {
    const normalizedName = String(parameterName || '').replace(/^&/, '').trim().toUpperCase();
    if (!normalizedName) {
        return {
            resolved: false,
            results: [],
            reasons: ['parameter-unresolved'],
        };
    }
    return resolveParameterReferenceAtLocation(
        referenceIndex,
        {
            parameterName: normalizedName,
            isSignedSwitch: false,
        },
        options
    );
}

function resolveReferenceTransformAtLocation(referenceIndex, sourceId, isSignedSwitch, options) {
    const documentPath = options && options.documentPath;
    if (!documentPath) {
        return {
            resolved: true,
            sourceId,
            effectiveId: sourceId,
            offset: 0,
            evidenceRule: null,
            results: [],
            reasons: [],
        };
    }
    const contexts = occurrenceContextsForDocument(referenceIndex, documentPath);
    if (contexts.length === 0) {
        return {
            resolved: true,
            sourceId,
            effectiveId: sourceId,
            offset: 0,
            evidenceRule: null,
            results: [],
            reasons: [],
        };
    }

    const results = [];
    const reasons = new Set();
    for (const context of contexts) {
        const offset = context.idfoffOffset;
        if (!Number.isSafeInteger(offset)) {
            reasons.add('transform-offset-unresolved');
            continue;
        }
        results.push({
            offset,
            occurrencePath: [...context.occurrencePath],
            occurrencePathLabels: [...context.occurrencePathLabels],
        });
    }
    if (reasons.size > 0 || results.length !== contexts.length) {
        return {
            resolved: false,
            sourceId,
            results,
            reasons: reasons.size > 0 ? [...reasons] : ['transform-offset-unresolved'],
        };
    }

    const offsets = [...new Set(results.map(result => result.offset))];
    if (offsets.length !== 1) {
        return {
            resolved: false,
            sourceId,
            results,
            reasons: ['transform-occurrence-ambiguous'],
        };
    }
    const offset = offsets[0];
    if (isSignedSwitch && offset !== 0) {
        return {
            resolved: false,
            sourceId,
            offset,
            results,
            reasons: ['signed-switch-transform-unverified'],
        };
    }
    const effectiveId = sourceId + offset;
    if (sourceId <= 0 ||
        !Number.isSafeInteger(sourceId) ||
        !Number.isSafeInteger(effectiveId) ||
        effectiveId <= 0) {
        return {
            resolved: false,
            sourceId,
            offset,
            results,
            reasons: ['reference-id-offset-unsafe'],
        };
    }
    return {
        resolved: true,
        sourceId,
        effectiveId,
        offset,
        evidenceRule: offset !== 0 ? 'E-T02' : null,
        results,
        reasons: [],
    };
}

/**
 * @param {any} referenceIndex
 * @param {any} referenceValue
 * @param {string[]} targetKinds
 * @param {{projectScoped?: boolean, documentPath?: string, lineIndex?: number, targetDefinitions?: string[]}} [options]
 */
function analyzeReference(
    referenceIndex,
    referenceValue,
    targetKinds,
    options: {
        projectScoped?: boolean;
        documentPath?: string;
        lineIndex?: number;
        targetDefinitions?: string[];
    } = {}
) {
    if (!referenceValue) {
        return { state: 'uncertain', definitions: [], reasons: ['reference-value-unresolved'] };
    }
    if (!referenceIndex) {
        return {
            state: 'uncertain',
            definitions: [],
            reasons: ['project-scan-unavailable'],
            id: referenceValue.id,
            raw: referenceValue.raw,
        };
    }

    let effectiveReferenceValue = referenceValue;
    let parameterResolution = null;
    if (referenceValue.kind === 'parameter') {
        parameterResolution = resolveParameterReferenceAtLocation(
            referenceIndex,
            referenceValue,
            options
        );
        if (!parameterResolution.resolved) {
            return {
                state: 'uncertain',
                definitions: [],
                reasons: parameterResolution.reasons,
                raw: referenceValue.raw,
                parameterResolution,
            };
        }
        effectiveReferenceValue = {
            kind: 'numeric',
            id: Math.abs(parameterResolution.value),
            raw: referenceValue.raw,
            isSignedSwitch: parameterResolution.value < 0,
        };
    }

    const transformResolution = resolveReferenceTransformAtLocation(
        referenceIndex,
        effectiveReferenceValue.id,
        effectiveReferenceValue.isSignedSwitch,
        options
    );
    if (transformResolution.resolved) {
        effectiveReferenceValue = {
            ...effectiveReferenceValue,
            id: transformResolution.effectiveId,
        };
    }

    const definitions = resolveReferenceDefinitions(
        referenceIndex,
        effectiveReferenceValue.id,
        targetKinds,
        options.targetDefinitions
    );
    const unresolved = unresolvedForKinds(
        referenceIndex,
        targetKinds,
        options.targetDefinitions
    );
    const reasons = [...new Set([
        ...(referenceIndex.completenessReasons || []),
        ...unresolved.flatMap(candidate => candidate.uncertaintyReasons || []),
        ...(transformResolution.reasons || []),
    ])];
    if ((options as any).projectScoped === false) {
        reasons.push('project-scan-unavailable');
    }
    if (effectiveReferenceValue.isSignedSwitch &&
        definitions.some(definition =>
            Number.isSafeInteger(definition.idfoffOffset) &&
            definition.idfoffOffset !== 0
        )) {
        reasons.push('signed-switch-transform-unverified');
    }
    if (effectiveReferenceValue.isSignedSwitch && reasons.includes('transform-offset-unresolved')) {
        reasons.push('signed-switch-transform-unverified');
    }
    if (reasons.length > 0) {
        return {
            state: 'uncertain',
            definitions,
            unresolved,
            reasons: [...new Set(reasons)],
            id: effectiveReferenceValue.id,
            sourceId: transformResolution.sourceId,
            effectiveId: transformResolution.effectiveId,
            offset: transformResolution.offset,
            raw: referenceValue.raw,
            parameterResolution,
            transformResolution,
        };
    }
    return {
        state: definitions.length === 0
            ? 'missing'
            : definitions.length === 1
                ? 'exact'
                : 'ambiguous',
        definitions,
        unresolved: [],
        reasons: [],
        id: effectiveReferenceValue.id,
        sourceId: transformResolution.sourceId,
        effectiveId: transformResolution.effectiveId,
        offset: transformResolution.offset,
        raw: referenceValue.raw,
        parameterResolution,
        transformResolution,
    };
}

function analyzeEffectiveTarget(
    referenceIndex,
    effectiveId,
    targetKinds,
    options: { projectScoped?: boolean } = {}
) {
    const definitions = resolveReferenceDefinitions(referenceIndex, effectiveId, targetKinds);
    const unresolved = unresolvedForKinds(referenceIndex, targetKinds);
    const reasons = [...new Set([
        ...(referenceIndex && referenceIndex.completenessReasons || []),
        ...unresolved.flatMap(candidate => candidate.uncertaintyReasons || []),
        ...(options.projectScoped === false ? ['project-scan-unavailable'] : []),
    ])];
    return {
        state: reasons.length > 0
            ? 'uncertain'
            : definitions.length === 0
                ? 'missing'
                : definitions.length === 1
                    ? 'exact'
                    : 'ambiguous',
        effectiveChildId: effectiveId,
        definitions,
        unresolved,
        reasons,
    };
}

function unresolvedTableChildAnalysis(row, reasons) {
    return {
        state: 'uncertain',
        effectiveChildId: undefined,
        definitions: [],
        unresolved: [],
        reasons: [...new Set(reasons)],
        raw: row && row.childIdRaw,
    };
}

function attachResolvedTableChildren(
    definition,
    referenceIndex,
    options: { projectScoped?: boolean } = {}
) {
    if (!definition || definition.kind !== 'table') {
        return definition;
    }
    const hasOccurrenceOffset = Object.prototype.hasOwnProperty.call(definition, 'idfoffOffset');
    const offset = hasOccurrenceOffset ? definition.idfoffOffset : 0;
    const rows = (definition.rows || []).map(row => {
        if (row.childIdInput && row.childIdInput.kind === 'blank') {
            return { ...row, childAnalysis: null };
        }
        if (!Number.isFinite(row.childId)) {
            const inputKind = row.childIdInput && row.childIdInput.kind;
            const reason = inputKind === 'parameter'
                ? 'parameter-unresolved'
                : inputKind === 'expression'
                    ? 'parameter-expression-unresolved'
                    : 'reference-value-unresolved';
            return {
                ...row,
                childAnalysis: unresolvedTableChildAnalysis(row, [reason]),
            };
        }
        if (!Number.isSafeInteger(offset)) {
            return {
                ...row,
                childAnalysis: unresolvedTableChildAnalysis(row, ['transform-offset-unresolved']),
            };
        }
        const effectiveChildId = row.childId + offset;
        if (!Number.isSafeInteger(row.childId) ||
            row.childId <= 0 ||
            !Number.isSafeInteger(effectiveChildId) ||
            effectiveChildId <= 0) {
            return {
                ...row,
                childAnalysis: unresolvedTableChildAnalysis(row, ['reference-id-offset-unsafe']),
            };
        }
        const targetKinds = row.childKind === 'table' ? ['table'] : ['curve'];
        return {
            ...row,
            childAnalysis: analyzeEffectiveTarget(
                referenceIndex,
                effectiveChildId,
                targetKinds,
                options
            ),
        };
    });
    return {
        ...definition,
        rows,
    };
}

module.exports = {
    buildProjectReferenceIndex,
    resolveReferenceDefinitions,
    analyzeReference,
    analyzeParameterReferenceAtLocation,
    attachResolvedTableChildren,
};

export {};
