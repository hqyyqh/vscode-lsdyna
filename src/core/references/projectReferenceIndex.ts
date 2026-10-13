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
    resolveIntegerParameterInput,
} = require('./parameterEnvironment');
const { resolveReferenceValueSemantics } = require('./fieldReferenceClassifier');
const { getDefinitionRegistryCatalog } = require('./definitionRegistry');
const { getReferenceRuleCatalog } = require('./referenceRuleCatalog');
const { familyDefinitionKeywords } = require('./familyDefinitionScannerCatalog');
const { isEntityIdentity, isLabelIdentity } = require('./entityIdentity');
const { stripKeywordInputFormatMarker } = require('../parser/inputFormat');
const { INCLUDE_OFFSET_KEYS, initialIncludeOffsets, nativeOccurrenceOffset,
    nativeSignedOffsetVerified, nativeOffsetReasons } = require('./nativeIncludeOffsets');

function definitionCoverage() {
    const generic = getReferenceRuleCatalog().metadata('definitionKeywords')?.generic || {};
    const onDemand = {
        ...(getReferenceRuleCatalog().metadata('definitionKeywords')?.onDemand || {}),
        ...(familyDefinitionKeywords().onDemand || {}),
    };
    const indexedTargetKinds = new Set(['curve', 'table']);
    const indexedTargetDefinitions = new Set();
    const onDemandTargetKinds = new Set();
    const onDemandTargetDefinitions = new Set();
    for (const keyword of getReferenceRuleCatalog().metadata('definitionKeywords')?.scanned || []) {
        indexedTargetDefinitions.add(normalizeKeyword(keyword));
    }
    for (const descriptor of Object.values(generic) as any[]) {
        if (descriptor.targetKind) indexedTargetKinds.add(descriptor.targetKind);
        if (descriptor.target) indexedTargetDefinitions.add(normalizeKeyword(descriptor.target));
    }
    for (const descriptor of Object.values(onDemand) as any[]) {
        const target = descriptor.target || descriptor.targetToken;
        if (descriptor.targetKind && normalizeKeyword(target) !== normalizeKeyword(descriptor.keyword)) {
            onDemandTargetKinds.add(descriptor.targetKind);
        }
        if (target) onDemandTargetDefinitions.add(normalizeKeyword(target));
    }
    for (const record of getDefinitionRegistryCatalog().definitionRecords()) {
        const targetKind = record.relation?.targetKind;
        if (typeof targetKind === 'string' && targetKind) indexedTargetKinds.add(targetKind);
        const target = normalizeKeyword(record.field?.keywordForm || record.field?.keyword);
        if (target) indexedTargetDefinitions.add(target);
    }
    return {
        indexedTargetKinds,
        indexedTargetDefinitions,
        onDemandTargetKinds,
        onDemandTargetDefinitions,
    };
}

let defaultDefinitionCoverage;

function normalizeKeyword(value) {
    return stripKeywordInputFormatMarker(String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0]);
}

function emptyReferenceIndex(files = []) {
    // Do not load the complete relation catalog merely by importing the extension.
    const DEFAULT_DEFINITION_COVERAGE = defaultDefinitionCoverage ||= definitionCoverage();
    return {
        curvesById: new Map(),
        tablesById: new Map(),
        unresolvedCurves: [],
        unresolvedTables: [],
        genericDefinitionsByKeyword: new Map(),
        unresolvedGenericDefinitionsByKeyword: new Map(),
        entityDefinitionsByKind: new Map(),
        unresolvedEntityDefinitionsByKind: new Map(),
        indexedTargetKinds: new Set(DEFAULT_DEFINITION_COVERAGE.indexedTargetKinds),
        indexedTargetDefinitions: new Set(DEFAULT_DEFINITION_COVERAGE.indexedTargetDefinitions),
        onDemandTargetKinds: new Set(DEFAULT_DEFINITION_COVERAGE.onDemandTargetKinds),
        onDemandTargetDefinitions: new Set(DEFAULT_DEFINITION_COVERAGE.onDemandTargetDefinitions),
        completenessReasons: [],
        files,
        occurrenceCount: 0,
        parameterContextsByFile: new Map(),
        allDefinitionOccurrences: [],
        registryReferenceOccurrences: [],
        registryValueDomainOccurrences: [],
        registryReferenceScanComplete: false,
        registryReferenceScanReasons: [],
        registryReferenceCoverageGaps: [],
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
    if (!definition || !isEntityIdentity(definition.id)) {
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
    if (input.kind === 'label' && isLabelIdentity(definition.id) &&
        ['MAT', 'MAT_THERMAL', 'EOS', 'SECTION'].includes(normalizeKeyword(
            definition.targetKeyword || definition.keyword
        ))) return null;
    if (definition.parameterResolution && definition.parameterResolution.resolved) return null;
    if (input.kind === 'parameter') return 'parameter-unresolved';
    if (input.kind === 'expression') return 'parameter-expression-unresolved';
    return 'reference-id-unresolved';
}

function targetCollections(index, kind, keyword, targetKind = null) {
    if (kind === 'generic') {
        const target = normalizeKeyword(keyword);
        if (!index.genericDefinitionsByKeyword.has(target)) {
            index.genericDefinitionsByKeyword.set(target, new Map());
            index.unresolvedGenericDefinitionsByKeyword.set(target, []);
        }
        const collections = [{
            map: index.genericDefinitionsByKeyword.get(target),
            unresolved: index.unresolvedGenericDefinitionsByKeyword.get(target),
        }];
        if (targetKind) {
            if (!index.entityDefinitionsByKind.has(targetKind)) {
                index.entityDefinitionsByKind.set(targetKind, new Map());
                index.unresolvedEntityDefinitionsByKind.set(targetKind, []);
            }
            collections.push({
                map: index.entityDefinitionsByKind.get(targetKind),
                unresolved: index.unresolvedEntityDefinitionsByKind.get(targetKind),
            });
        }
        return collections;
    }
    return [kind === 'table'
        ? { map: index.tablesById, unresolved: index.unresolvedTables }
        : { map: index.curvesById, unresolved: index.unresolvedCurves }];
}

function resolveParameterizedDefinition(definition, bindings) {
    const input = definition && definition.idInput;
    if (!input || !['parameter', 'expression'].includes(input.kind)) return definition;
    const resolution = resolveIntegerParameterInput(bindings, input);
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
    const registryRecord = getDefinitionRegistryCatalog().definitionRecordForOccurrence(definition);
    const approvedDefinition = registryRecord ? {
        ...definition,
        definitionRegistry: {
            approved: true,
            authoringRelationId: registryRecord.authoringRelationId,
            coordinateId: registryRecord.coordinateId,
            sourceRuleId: registryRecord.sourceRuleId,
            decisionId: registryRecord.review?.decisionId || registryRecord.authoringRelationId,
            retainedReviewState: registryRecord.review?.retainedReviewState || 'operational-default',
            operationalProjection: registryRecord.operationalProjection || null,
        },
    } : definition;
    const effectiveDefinition = resolveParameterizedDefinition(approvedDefinition, bindings);
    const runtimeOccurrenceId = occurrenceContext.occurrencePath.join(' > ');
    const sourceId = effectiveDefinition.id;
    const targetKinds = [effectiveDefinition.targetKind || effectiveDefinition.kind];
    const targetDefinitions = [effectiveDefinition.keyword || effectiveDefinition.targetKeyword];
    const idfoffOffset = nativeOccurrenceOffset(occurrenceContext, targetKinds, targetDefinitions);
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
            ...nativeOffsetReasons(occurrenceContext, targetKinds, targetDefinitions),
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
    } else if (isLabelIdentity(sourceId) && idfoffOffset !== 0) {
        candidate.uncertaintyReasons.push('label-idfoff-unsupported');
    }
    const targets = targetCollections(
        index,
        effectiveDefinition.kind,
        effectiveDefinition.targetKeyword || effectiveDefinition.keyword,
        effectiveDefinition.targetKind
    );
    const idReason = definitionReason(effectiveDefinition);
    if (idReason) {
        candidate.uncertaintyReasons.push(idReason);
    }
    candidate.uncertaintyReasons = [...new Set(candidate.uncertaintyReasons)];
    index.allDefinitionOccurrences.push(candidate);
    if (isEntityIdentity(candidate.id) && candidate.uncertaintyReasons.length === 0) {
        for (const target of targets) addDefinition(target.map, candidate);
    } else {
        for (const target of targets) target.unresolved.push(candidate);
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
    context,
    bindings
) {
    const reasons = [];
    let transformDepth = context.transformDepth;
    const includeOffsets = { ...context.includeOffsets };
    const offsetDepths = { ...context.offsetDepths };
    const transform = edge && edge.transform;
    if (!transform) {
        if (String(edge && edge.keyword || '').toUpperCase().startsWith('*INCLUDE_TRANSFORM')) {
            transformDepth += 1;
            for (const key of INCLUDE_OFFSET_KEYS) includeOffsets[key] = null;
        }
    } else {
        transformDepth += 1;
        for (const key of INCLUDE_OFFSET_KEYS) {
            const input = transform.offsets?.[key];
            const value = !input || input.kind === 'blank' ? 0 : input.kind === 'numeric' ? input.value :
                ['parameter', 'expression'].includes(input.kind) ? resolveIntegerParameterInput(bindings, input).value : null;
            if (value === 0) continue;
            offsetDepths[key] = (offsetDepths[key] || 0) + 1;
            const sum = includeOffsets[key] + value;
            includeOffsets[key] = offsetDepths[key] > 1 ||
                !Number.isSafeInteger(includeOffsets[key]) || !Number.isSafeInteger(value) ||
                !Number.isSafeInteger(sum) ? null : sum;
        }
    }
    if (transformDepth > 0 && fileHasKeyword(childFileIndex, '*PARAMETER_TYPE')) {
        reasons.push('parameter-type-transform-unsupported');
    }
    return { reasons, relevantTransformCount: offsetDepths.idfoff || 0, transformDepth,
        idfoffOffset: includeOffsets.idfoff, includeOffsets, offsetDepths };
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
        runtimeContext.initialUncertaintyReasons = [...new Set([
            ...(runtimeContext.uncertaintyReasons || []), ...state.uncertaintyReasons,
        ])];
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
    return point;
}

function* buildOccurrenceAwareIndex(index, snapshot, fileIndexes) {
    const occurrencesByParent = groupOccurrencesByParent(snapshot.graph);
    const visitCountsByFile = new Map();
    const parameterState = createParameterRuntimeState();
    const nativeEmState = require('../semantics/nativeEmReadState').createNativeEmReadState();

    function* visit(filePath, context, ancestry) {
        yield;
        index.occurrenceCount += 1;
        const priorVisitCount = visitCountsByFile.get(filePath) || 0;
        visitCountsByFile.set(filePath, priorVisitCount + 1);
        const reusedOccurrenceSearchContext = priorVisitCount > 0;
        const fileIndex = getFileIndex(fileIndexes, filePath);
        if (!fileIndex) nativeEmState.invalidate('native-em-file-index-unavailable');
        let nativeInputFormat = context.inputFormatMode;
        const runtimeParameterContext = {
            occurrenceId: context.occurrencePath.join(' > '),
            occurrencePath: [...context.occurrencePath],
            occurrencePathLabels: [...context.occurrencePathLabels],
            uncertaintyReasons: [...context.uncertaintyReasons],
            idfoffOffset: context.idfoffOffset,
            includeOffsets: context.includeOffsets,
            offsetDepths: context.offsetDepths,
            inputFormatMode: context.inputFormatMode,
            timeline: [],
            initialBindings: null,
            initialUncertaintyReasons: [],
            nativeEmReadLayouts: new Map(),
        };
        enterParameterFile(parameterState, context.occurrenceId, filePath);
        recordParameterPoint(index, filePath, runtimeParameterContext, -1, parameterState);
        yield runtimeParameterContext;

        const actions = [
            ...(fileIndex?.nativeReadEvents || []).map(event => ({
                type: 'native-read', lineIndex: event.startLine, sequence: 0, event,
            })),
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
            yield;
            if (action.type === 'native-read') {
                if (action.event.kind === 'input-format') {
                    nativeInputFormat = require('../parser/inputFormat').globalInputFormatFromKeywordLine(action.event.rawKeyword, nativeInputFormat);
                    continue;
                }
                const selected = nativeEmState.apply(action.event.variants?.[nativeInputFormat] || action.event, raw => {
                    if (!/[&<]/.test(raw)) return raw;
                    const parsed = require('./referenceInputValue').parseNumericInput(raw);
                    if (!['parameter', 'expression'].includes(parsed.kind)) return raw;
                    const value = resolveIntegerParameterInput(snapshotVisibleParameterBindings(parameterState), parsed, true);
                    return value.resolved ? String(value.value) : raw;
                });
                if (selected) { runtimeParameterContext.nativeEmReadLayouts.set(action.event.startLine, selected); yield selected; }
                continue;
            }
            if (action.type === 'parameter') {
                applyParameterEvent(parameterState, action.event);
                yield recordParameterPoint(
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
                    ['parameter', 'expression'].includes(action.definition.idInput.kind)
                    ? snapshotVisibleParameterBindings(parameterState)
                    : null;
                addDefinitionOccurrence(
                    index,
                    action.definition,
                    context,
                    bindings,
                    bindings ? [...parameterState.uncertaintyReasons] : []
                );
                yield index.allDefinitionOccurrences[index.allDefinitionOccurrences.length - 1];
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
                nativeEmState.invalidate('missing-include');
                childReasons.push('missing-include');
                index.completenessReasons.push('missing-include');
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
            if (!childPath) { nativeEmState.invalidate('include-read-order-unavailable'); continue; }
            if (ancestry.includes(childPath) || edge.cycle) {
                nativeEmState.invalidate('include-cycle');
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
                context,
                snapshotVisibleParameterBindings(parameterState)
            );
            childReasons.push(...transformState.reasons);
            const globalChangeStart = parameterState.globalChanges.length;
            yield* visit(childPath, {
                occurrenceId: edge.occurrenceId,
                occurrencePath: [...context.occurrencePath, edge.occurrenceId],
                occurrencePathLabels: [...context.occurrencePathLabels, occurrenceLabel],
                uncertaintyReasons: [...new Set(childReasons)],
                relevantTransformCount: transformState.relevantTransformCount,
                transformDepth: transformState.transformDepth,
                idfoffOffset: transformState.idfoffOffset,
                includeOffsets: transformState.includeOffsets,
                offsetDepths: transformState.offsetDepths,
                inputFormatMode: edge.inputFormatOverride || nativeInputFormat,
            }, [...ancestry, childPath]);
            yield recordParameterPoint(
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

    yield* visit(snapshot.rootFile, {
        occurrenceId: 'root',
        occurrencePath: ['root'],
        occurrencePathLabels: ['root'],
        uncertaintyReasons: [],
        relevantTransformCount: 0,
        transformDepth: 0,
        idfoffOffset: 0,
        includeOffsets: initialIncludeOffsets(),
        offsetDepths: {},
        inputFormatMode: 'standard',
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

function* buildProjectReferenceIndexSteps(snapshot) {
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
    yield index;
    index.rootFile = snapshot.rootFile || null;
    if (snapshot.failedFiles?.length) index.completenessReasons.push('project-scan-unavailable');
    const occurrences = snapshot.graph && snapshot.graph.includeOccurrences;

    if (snapshot.rootFile &&
        Array.isArray(occurrences) &&
        snapshot.graph.includeOccurrencesComplete !== false) {
        yield* buildOccurrenceAwareIndex(index, snapshot, fileIndexes);
    } else {
        buildLegacyFileIndex(index, files, fileIndexes);
        index.completenessReasons.push('project-scan-unavailable');
    }

    let registryReferenceScanComplete = files.length > 0;
    for (const filePath of files) {
        yield;
        const fileIndex = getFileIndex(fileIndexes, filePath);
        const registryReferences = fileIndex?.registryReferences;
        index.registryReferenceOccurrences.push(...(registryReferences?.referenceOccurrences || []).map(occurrence => ({
            ...occurrence,
            filePath: occurrence.filePath || filePath,
        })));
        index.registryValueDomainOccurrences.push(...(registryReferences?.valueDomainOccurrences || []).map(occurrence => ({
            ...occurrence,
            filePath: occurrence.filePath || filePath,
        })));

        let gaps;
        if (registryReferences?.referenceCoverage &&
            Array.isArray(registryReferences.referenceCoverage.gaps)) {
            gaps = registryReferences.referenceCoverage.gaps;
            if (registryReferences.referenceCoverage.complete !== true && gaps.length === 0) {
                gaps = [{ reason: 'registry-reference-scan-unavailable', scope: 'all',
                    targetKinds: [], targetDefinitions: [] }];
            }
        } else if (registryReferences?.complete === true) {
            gaps = [];
        } else {
            const reasons = registryReferences?.reasons?.length > 0
                ? registryReferences.reasons
                : ['registry-reference-scan-unavailable'];
            gaps = reasons.map(reason => ({ reason, scope: 'all', targetKinds: [], targetDefinitions: [] }));
        }
        for (const gap of gaps) {
            const normalized = {
                ...gap,
                filePath,
                scope: gap?.scope === 'namespaces' ? 'namespaces' : 'all',
                targetKinds: Array.isArray(gap?.targetKinds) ? gap.targetKinds : [],
                targetDefinitions: Array.isArray(gap?.targetDefinitions) ? gap.targetDefinitions : [],
            };
            index.registryReferenceCoverageGaps.push(normalized);
            index.registryReferenceScanReasons.push(
                `${filePath}:${Number.isInteger(gap?.startLine) ? `${gap.startLine + 1}:` : ''}${gap?.reason || 'registry-reference-scan-unavailable'}`,
            );
        }
        if (gaps.length > 0) registryReferenceScanComplete = false;
    }
    index.registryReferenceScanComplete = registryReferenceScanComplete;
    index.registryReferenceScanReasons = [...new Set(index.registryReferenceScanReasons)].sort();
    index.registryReferenceCoverageGaps.sort((left, right) =>
        normalizeFilePathKey(left.filePath).localeCompare(normalizeFilePathKey(right.filePath)) ||
        (left.startLine ?? -1) - (right.startLine ?? -1) ||
        String(left.reason || '').localeCompare(String(right.reason || ''))
    );

    return index;
}

function buildProjectReferenceIndex(snapshot) {
    const steps = buildProjectReferenceIndexSteps(snapshot);
    for (;;) { const next = steps.next(); if (next.done) return next.value; }
}

async function buildProjectReferenceIndexAsync(snapshot, token, budget = 64 * 1024 * 1024) {
    const steps = buildProjectReferenceIndexSteps(snapshot);
    let started = performance.now(), retained = 0;
    const { estimateMemorySize } = require('../cache/memorySize');
    for (;;) {
        require('../scanner/scannerContracts').throwIfCancellationRequested(token);
        const next = steps.next();
        if (next.done) return next.value;
        if (next.value) {
            retained += estimateMemorySize(next.value, budget - retained);
            if (retained > budget) throw new RangeError(`Reference context exceeds build budget (${budget} bytes; ${Object.keys(next.value).join(',')})`);
        }
        if (performance.now() - started >= 8) {
            await new Promise(resolve => setImmediate(resolve));
            started = performance.now();
        }
    }
}

function resolveReferenceDefinitions(referenceIndex, id, targetKinds, targetDefinitions = []) {
    if (!referenceIndex || !isEntityIdentity(id)) {
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
    for (const kind of kinds) {
        if (kind === 'curve' || kind === 'functionCurve' || kind === 'table') continue;
        const definitionsById = referenceIndex.entityDefinitionsByKind &&
            referenceIndex.entityDefinitionsByKind.get(kind);
        const matches = definitionsById && definitionsById.get(id);
        if (matches) definitions.push(...matches);
    }
    for (const target of targetDefinitions) {
        const definitionsById = referenceIndex.genericDefinitionsByKeyword &&
            referenceIndex.genericDefinitionsByKeyword.get(normalizeKeyword(target));
        const matches = definitionsById && definitionsById.get(id);
        if (matches) {
            definitions.push(...matches);
        }
    }
    const lookup = referenceIndex.queryDefinitionLookup;
    if (lookup && lookup.id === id) {
        const targets = new Set(targetDefinitions.map(normalizeKeyword));
        definitions.push(...lookup.definitions.filter(definition => kinds.has(definition.targetKind) ||
            targets.has(normalizeKeyword(definition.targetKeyword || definition.keyword))));
    }
    return [...new Set(definitions)];
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
    for (const kind of kinds) {
        if (kind === 'curve' || kind === 'functionCurve' || kind === 'table') continue;
        unresolved.push(...(
            referenceIndex.unresolvedEntityDefinitionsByKind &&
            referenceIndex.unresolvedEntityDefinitionsByKind.get(kind) ||
            []
        ));
    }
    for (const target of targetDefinitions) {
        unresolved.push(...(
            referenceIndex.unresolvedGenericDefinitionsByKeyword &&
            referenceIndex.unresolvedGenericDefinitionsByKeyword.get(normalizeKeyword(target)) ||
            []
        ));
    }
    return [...new Set(unresolved)];
}

function targetCoverageReasons(referenceIndex, targetKinds, targetDefinitions = [], id = undefined) {
    if (!referenceIndex) return ['project-scan-unavailable'];
    const reasons = [];
    for (const kind of targetKinds || []) {
        if (referenceIndex.queryDefinitionLookup?.id === id && referenceIndex.queryDefinitionLookup.state === 'complete' &&
            referenceIndex.queryDefinitionLookup.targetKinds.includes(kind)) continue;
        if (referenceIndex.onDemandTargetKinds?.has(kind)) {
            reasons.push('target-kind-on-demand');
        } else if (!referenceIndex.indexedTargetKinds?.has(kind)) {
            reasons.push('target-kind-unindexed');
        }
    }
    for (const target of targetDefinitions || []) {
        const normalized = normalizeKeyword(target);
        if (referenceIndex.queryDefinitionLookup?.id === id && referenceIndex.queryDefinitionLookup.state === 'complete' &&
            referenceIndex.queryDefinitionLookup.targetDefinitions.includes(normalized)) continue;
        if (referenceIndex.onDemandTargetDefinitions?.has(normalized)) {
            reasons.push('target-definition-on-demand');
        } else if (!referenceIndex.indexedTargetDefinitions?.has(normalized)) {
            reasons.push('target-definition-unindexed');
        }
    }
    return [...new Set(reasons)];
}

/** A fallback namespace is usable only after earlier namespaces were searched. */
function selectReferenceTargetSearch(referenceIndex, id, targetSearch, transformForTarget = undefined) {
    let firstTransform;
    for (const target of targetSearch) {
        const transform = transformForTarget?.(target);
        firstTransform ||= transform;
        const extra = transform ? { transformResolution: transform } : {};
        if (transform?.resolved === false) return { ready: false, target: null, definitions: [],
            reasons: transform.reasons, ...extra };
        const targetId = transform ? transform.effectiveId : id;
        const keywords = new Set((target.targetKeywords || []).map(normalizeKeyword));
        if (target.targetDefinitionUnavailable && !keywords.size) return {
            ready: false, target: null, definitions: [], reasons: ['lspp-target-priority-unresolved'], ...extra,
        };
        const kinds = keywords.size ? [] : target.targetKinds;
        const definitions = resolveReferenceDefinitions(referenceIndex, targetId, target.targetKinds, target.targetKeywords)
            .filter(definition => !keywords.size ||
                keywords.has(normalizeKeyword(definition.targetKeyword)) || keywords.has(normalizeKeyword(definition.keyword)));
        if (definitions.length) return { ready: true, target, definitions, reasons: [], ...extra };
        const reasons = [...(referenceIndex.completenessReasons || []),
            ...targetCoverageReasons(referenceIndex, kinds, target.targetKeywords, targetId),
            ...unresolvedForKinds(referenceIndex, kinds, target.targetKeywords)
                .flatMap(definition => definition.uncertaintyReasons || [])];
        if (target.targetDefinitionUnavailable || reasons.length) return { ready: false, target: null, definitions: [],
            reasons: [...new Set(['lspp-target-priority-unresolved', ...reasons])], ...extra };
    }
    return { ready: true, target: null, definitions: [], reasons: [],
        ...(firstTransform ? { transformResolution: firstTransform } : {}) };
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

function occurrenceContextsForDocument(referenceIndex, documentPath, occurrenceId?) {
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
    return occurrenceId === undefined ? contexts : contexts.filter(context => context.occurrenceId === occurrenceId);
}

/** The same file may be read more than once. Never pick one occurrence's EM layout. */
function nativeEmReadLayoutAtLocation(referenceIndex, documentPath, startLine, occurrenceId?) {
    const contexts = occurrenceContextsForDocument(referenceIndex, documentPath, occurrenceId);
    const layouts = contexts.map(context => context.nativeEmReadLayouts?.get(startLine));
    if (!layouts.length || layouts.some(layout => layout?.state !== 'ready')) return {
        state: 'unknown', reason: 'native-em-read-order-unresolved',
    };
    const keys = new Set(layouts.map(layout => JSON.stringify(layout.cardIndexes)));
    return keys.size === 1 ? layouts[0] : { state: 'unknown', reason: 'native-em-occurrence-layout-ambiguous' };
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
    const contexts = occurrenceContextsForDocument(referenceIndex, documentPath, options?.occurrenceId);
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
        for (const reason of point.reasons) {
            reasons.add(reason);
        }
        const expressionResult = referenceValue.expression
            ? require('./parameterExpression').evaluateParameterExpression(referenceValue.expression, name => point.bindings.get(name)) : null;
        const result = expressionResult
            ? expressionResult.resolved && options?.allowRealValue !== true && !Number.isSafeInteger(expressionResult.value)
                ? { resolved: false, reason: 'parameter-value-unsafe' } : expressionResult
            : (options?.allowRealValue === true ? require('./parameterEnvironment').resolveNumericParameter : resolveIntegerParameter)(
            point.bindings,
            referenceValue.parameterName,
            referenceValue.isSignedSwitch,
            options?.allowRealInteger === true
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
    if (values[0] === 0 && options?.allowZero !== true) {
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

/** A layout controller is a value, not a reference ID: zero remains meaningful. */
function analyzeIntegerParameterValueAtLocation(referenceIndex, rawValue, options) {
    const parsed = require('./referenceInputValue').parseNumericInput(rawValue);
    if (parsed.kind === 'expression') return resolveParameterReferenceAtLocation(referenceIndex,
        { expression: parsed.raw.slice(1, -1) }, { ...options, allowZero: true, allowRealInteger: true });
    if (parsed.kind !== 'parameter') return { resolved: false, reasons: ['parameter-syntax-unresolved'] };
    return resolveParameterReferenceAtLocation(referenceIndex, {
        parameterName: parsed.name, isSignedSwitch: parsed.negated,
    }, { ...options, allowZero: true, allowRealInteger: true });
}

function analyzeNumericParameterValueAtLocation(referenceIndex, rawValue, options) {
    const parsed = require('./referenceInputValue').parseNumericInput(rawValue);
    if (parsed.kind === 'expression') return resolveParameterReferenceAtLocation(referenceIndex,
        { expression: parsed.raw.slice(1, -1) }, { ...options, allowZero: true, allowRealValue: true });
    if (parsed.kind !== 'parameter') return { resolved: false, reasons: ['parameter-syntax-unresolved'] };
    return resolveParameterReferenceAtLocation(referenceIndex, {
        parameterName: parsed.name, isSignedSwitch: parsed.negated,
    }, { ...options, allowZero: true, allowRealValue: true });
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

function resolveReferenceTransformAtLocation(referenceIndex, sourceId, isSignedSwitch, targetKinds, targetDefinitions, options) {
    const documentPath = options && options.documentPath;
    if (!documentPath && options?.projectScoped !== true) {
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
    const contexts = occurrenceContextsForDocument(referenceIndex, documentPath, options?.occurrenceId);
    if (contexts.length === 0) {
        return {
            resolved: false,
            sourceId,
            results: [],
            reasons: ['reference-source-context-unavailable'],
        };
    }

    const results = [];
    const reasons = new Set();
    for (const context of contexts) {
        const offset = nativeOccurrenceOffset(context, targetKinds, targetDefinitions);
        if (!Number.isSafeInteger(offset)) {
            for (const reason of nativeOffsetReasons(context, targetKinds, targetDefinitions)) reasons.add(reason);
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
    if (isLabelIdentity(sourceId)) {
        if (isSignedSwitch || offset !== 0) {
            return {
                resolved: false,
                sourceId,
                offset,
                results,
                reasons: [offset !== 0 ? 'label-idfoff-unsupported' : 'label-signed-switch-unsupported'],
            };
        }
        return {
            resolved: true,
            sourceId,
            effectiveId: sourceId,
            offset: 0,
            evidenceRule: null,
            results,
            reasons: [],
        };
    }
    if (isSignedSwitch && offset !== 0 && !nativeSignedOffsetVerified(contexts, targetKinds, targetDefinitions)) {
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
        occurrenceId?: string;
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
    let effectiveTargetKinds = referenceValue.targetKinds || targetKinds || [];
    let effectiveTargetDefinitions = referenceValue.targetDefinitions || options.targetDefinitions || [];
    let targetSearch = referenceValue.targetSearch || referenceValue.semanticRelation?.targetSearch;
    let parameterResolution = null;
    if (referenceValue.kind === 'parameter' || referenceValue.kind === 'expression') {
        parameterResolution = resolveParameterReferenceAtLocation(
            referenceIndex,
            referenceValue.kind === 'expression' ? { ...referenceValue, expression: referenceValue.raw.slice(1, -1) } : referenceValue,
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
        if (referenceValue.semanticRelation) {
            const semantic = resolveReferenceValueSemantics(
                referenceValue.semanticRelation,
                parameterResolution.value
            );
            if (semantic.state !== 'reference') {
                return {
                    state: 'uncertain',
                    definitions: [],
                    reasons: [semantic.reason || 'reference-role-not-active'],
                    raw: referenceValue.raw,
                    parameterResolution,
                    semanticResolution: semantic,
                };
            }
            effectiveTargetKinds = semantic.targetKinds;
            effectiveTargetDefinitions = semantic.targetDefinitions;
            targetSearch = semantic.targetSearch;
            effectiveReferenceValue = {
                kind: 'numeric',
                id: semantic.id,
                raw: referenceValue.raw,
                isSignedSwitch: semantic.idTransform !== 'identity',
                idTransform: semantic.idTransform,
            };
        } else {
            effectiveReferenceValue = {
                kind: 'numeric',
                id: Math.abs(parameterResolution.value),
                raw: referenceValue.raw,
                isSignedSwitch: parameterResolution.value < 0,
            };
        }
    }

    let transformResolution = resolveReferenceTransformAtLocation(
        referenceIndex,
        effectiveReferenceValue.id,
        effectiveReferenceValue.isSignedSwitch,
        effectiveTargetKinds,
        effectiveTargetDefinitions,
        options
    );
    if (transformResolution.resolved) {
        effectiveReferenceValue = {
            ...effectiveReferenceValue,
            id: transformResolution.effectiveId,
        };
    }

    const targetSelection = targetSearch
        ? selectReferenceTargetSearch(referenceIndex, effectiveReferenceValue.id, targetSearch, target =>
            resolveReferenceTransformAtLocation(referenceIndex, transformResolution.sourceId,
                effectiveReferenceValue.isSignedSwitch, target.targetKinds || [], target.targetKeywords || [], options)) : null;
    if (targetSelection?.transformResolution) {
        transformResolution = targetSelection.transformResolution;
        if (transformResolution.resolved) effectiveReferenceValue = {
            ...effectiveReferenceValue, id: transformResolution.effectiveId,
        };
    }
    if (targetSelection?.ready) {
        effectiveTargetKinds = targetSelection.target?.targetKinds || [];
        effectiveTargetDefinitions = targetSelection.target?.targetKeywords || [];
    }
    const definitions = targetSelection ? targetSelection.definitions : resolveReferenceDefinitions(
        referenceIndex,
        effectiveReferenceValue.id,
        effectiveTargetKinds,
        effectiveTargetDefinitions
    );
    const unresolved = unresolvedForKinds(
        referenceIndex,
        effectiveTargetKinds,
        effectiveTargetDefinitions
    );
    const reasons = [...new Set([
        ...(referenceIndex.completenessReasons || []),
        ...unresolved.flatMap(candidate => candidate.uncertaintyReasons || []),
        ...(transformResolution.reasons || []),
        ...targetCoverageReasons(referenceIndex, effectiveTargetKinds, effectiveTargetDefinitions, effectiveReferenceValue.id),
        ...(targetSelection?.reasons || []),
    ])];
    if ((options as any).projectScoped === false) {
        reasons.push('project-scan-unavailable');
    }
    if (effectiveReferenceValue.isSignedSwitch &&
        !nativeSignedOffsetVerified(occurrenceContextsForDocument(referenceIndex, options.documentPath, options.occurrenceId),
            effectiveTargetKinds, effectiveTargetDefinitions) &&
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
            ...(targetSearch ? { targetSearch, targetSelection, targetKinds: effectiveTargetKinds,
                targetDefinitions: effectiveTargetDefinitions } : {}),
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
        ...(targetSearch ? { targetSearch, targetSelection, targetKinds: effectiveTargetKinds,
            targetDefinitions: effectiveTargetDefinitions } : {}),
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
    buildProjectReferenceIndexAsync,
    resolveReferenceDefinitions,
    selectReferenceTargetSearch,
    analyzeReference,
    analyzeParameterReferenceAtLocation,
    analyzeIntegerParameterValueAtLocation,
    analyzeNumericParameterValueAtLocation,
    parameterContextsForDocument: occurrenceContextsForDocument,
    nativeEmReadLayoutAtLocation,
    attachResolvedTableChildren,
};

export {};
