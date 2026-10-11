'use strict';

const path = require('node:path');
const { analyzeReference, resolveReferenceDefinitions } = require('./projectReferenceIndex');
const { entityIdentityEquals, isEntityIdentity } = require('./entityIdentity');

const NON_BINDING_COVERAGE_REASONS = new Set([
    'target-kind-on-demand',
    'target-definition-on-demand',
    'target-kind-unindexed',
    'target-definition-unindexed',
]);
const DEFAULT_MAX_MATCHES = 10_000;

function normalizeKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0]
        .replace(/[+%\-]$/, '');
}

function normalizeFilePath(value) {
    const resolved = path.resolve(String(value || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizedSet(values, normalizer = value => String(value || '').trim()) {
    return new Set((values || []).map(normalizer).filter(Boolean));
}

function namespaceMatches(query, occurrence) {
    const queryKinds = normalizedSet(query?.targetKinds);
    const occurrenceKinds = normalizedSet(occurrence?.targetKinds);
    const queryDefinitions = normalizedSet(query?.targetDefinitions, normalizeKeyword);
    const occurrenceDefinitions = normalizedSet(occurrence?.targetDefinitions, normalizeKeyword);
    const kindMatch = [...queryKinds].some(value => occurrenceKinds.has(value));
    const definitionMatch = [...queryDefinitions].some(value => occurrenceDefinitions.has(value));
    return kindMatch || definitionMatch;
}

function coverageGapMatches(query, gap) {
    return gap?.scope !== 'namespaces' || namespaceMatches(query, gap);
}

function coverageGapReason(gap) {
    const parts = [gap?.filePath];
    if (Number.isInteger(gap?.startLine)) parts.push(String(gap.startLine + 1));
    parts.push(gap?.reason || 'registry-reference-scan-unavailable');
    return parts.filter(Boolean).join(':');
}

function definitionNamespace(definition) {
    if (definition?.kind === 'curve' || definition?.kind === 'functionCurve') {
        return { targetKinds: ['curve'], targetDefinitions: [] };
    }
    if (definition?.kind === 'table') {
        return { targetKinds: ['table'], targetDefinitions: [] };
    }
    if (definition?.kind !== 'generic') return null;
    const targetKinds = definition.targetKind ? [definition.targetKind] : [];
    const target = normalizeKeyword(definition.targetKeyword || definition.keyword);
    return { targetKinds, targetDefinitions: target ? [target] : [] };
}

function definitionAtPosition(referenceIndex, documentPath, position) {
    if (!referenceIndex || !documentPath || !position ||
        !Number.isInteger(position.line) || !Number.isInteger(position.character)) {
        return { state: 'none', query: null, definitions: [], reasons: [] };
    }
    const fileKey = normalizeFilePath(documentPath);
    const physical = (referenceIndex.allDefinitionOccurrences || []).filter(definition =>
        definition?.definitionRegistry?.approved === true &&
        normalizeFilePath(definition.filePath) === fileKey &&
        definition.idLine === position.line &&
        Number.isInteger(definition.idStartChar) && Number.isInteger(definition.idEndChar) &&
        position.character >= definition.idStartChar && position.character < definition.idEndChar
    );
    if (physical.length === 0) return { state: 'none', query: null, definitions: [], reasons: [] };

    const usable = physical.filter(definition =>
        isEntityIdentity(definition.effectiveId ?? definition.id) &&
        (definition.uncertaintyReasons || []).length === 0 && definitionNamespace(definition)
    );
    if (usable.length !== physical.length) {
        return {
            state: 'incomplete',
            query: null,
            definitions: physical,
            reasons: ['definition-occurrence-indeterminate'],
        };
    }
    const identities = new Map();
    for (const definition of usable) {
        const namespace = definitionNamespace(definition);
        const id = definition.effectiveId ?? definition.id;
        const key = JSON.stringify([id, [...namespace.targetKinds].sort(), [...namespace.targetDefinitions].sort()]);
        if (!identities.has(key)) identities.set(key, { id, ...namespace });
    }
    if (identities.size !== 1) {
        return {
            state: 'ambiguous',
            query: null,
            definitions: usable,
            reasons: ['definition-occurrence-ambiguous'],
        };
    }
    return {
        state: 'ready',
        query: identities.values().next().value,
        definitions: usable,
        reasons: [],
    };
}

function queryFromReferenceSource(
    referenceIndex,
    source,
    options: { documentPath?: string; lineIndex?: number } = {},
) {
    if (!source?.referenceValue) {
        return { state: 'none', query: null, analysis: null, reasons: [] };
    }
    const targetKinds = source.referenceValue.targetKinds?.length
        ? source.referenceValue.targetKinds : source.referenceInfo?.targetKinds || [];
    const targetDefinitions = source.referenceValue.targetDefinitions?.length
        ? source.referenceValue.targetDefinitions : source.referenceInfo?.targetDefinitions || [];
    const analysis = analyzeReference(
        referenceIndex,
        source.referenceValue,
        targetKinds,
        {
            projectScoped: true,
            documentPath: options.documentPath,
            lineIndex: options.lineIndex,
            targetDefinitions,
        },
    );
    const blockingReasons = (analysis.reasons || []).filter(reason =>
        !NON_BINDING_COVERAGE_REASONS.has(reason)
    );
    if (!isEntityIdentity(analysis.id) || blockingReasons.length > 0 ||
        analysis.transformResolution?.resolved === false ||
        (source.referenceValue.kind === 'parameter' && analysis.parameterResolution?.resolved !== true)) {
        return {
            state: 'incomplete',
            query: null,
            analysis,
            reasons: blockingReasons.length > 0 ? blockingReasons : ['reference-source-indeterminate'],
        };
    }
    return {
        state: 'ready',
        query: { id: analysis.id, targetKinds: analysis.targetKinds || targetKinds,
            targetDefinitions: analysis.targetDefinitions || targetDefinitions },
        analysis,
        reasons: [],
    };
}

function occurrenceBinding(referenceIndex, occurrence, { bindingOnly = false, query = null } = {} as any) {
    if (query && occurrence.occurrenceId === undefined) {
        const contexts = require('./projectReferenceIndex').parameterContextsForDocument(referenceIndex, occurrence.filePath);
        if (contexts.length > 1) {
            const bindings = contexts.map(context => occurrenceBinding(referenceIndex,
                { ...occurrence, occurrenceId: context.occurrenceId }, { bindingOnly }));
            const selected = bindings.find(binding => binding.ready && entityIdentityEquals(binding.analysis.id, query.id) &&
                (!binding.analysis.targetSelection || namespaceMatches(query, binding.analysis))) ||
                bindings.find(binding => binding.ready) || bindings[0];
            return { ...selected, unresolvedOccurrenceReasons: [...new Set(bindings.filter(binding => !binding.ready)
                .flatMap(binding => binding.blockingReasons.length ? binding.blockingReasons : ['reference-binding-indeterminate']))] };
        }
    }
    const analysis = analyzeReference(
        referenceIndex,
        occurrence.referenceValue,
        occurrence.targetKinds,
        {
            projectScoped: true,
            documentPath: occurrence.filePath,
            occurrenceId: occurrence.occurrenceId,
            lineIndex: occurrence.lineIndex,
            targetDefinitions: occurrence.targetDefinitions,
        },
    );
    const blockingReasons = bindingOnly
        ? [...new Set([
            ...(analysis.transformResolution?.reasons || []),
            ...(analysis.targetSelection?.ready === false ? analysis.targetSelection.reasons : []),
            ...(occurrence.referenceValue.kind === 'parameter' &&
                analysis.parameterResolution?.resolved !== true
                ? analysis.parameterResolution?.reasons || ['parameter-unresolved']
                : []),
        ])]
        : (analysis.reasons || []).filter(reason =>
            !NON_BINDING_COVERAGE_REASONS.has(reason)
        );
    const ready = isEntityIdentity(analysis.id) &&
        blockingReasons.length === 0 && analysis.transformResolution?.resolved !== false &&
        (occurrence.referenceValue.kind !== 'parameter' || analysis.parameterResolution?.resolved === true);
    return { ready, analysis, blockingReasons };
}

function collectRegistryReferenceMatches(
    referenceIndex,
    query,
    options: {
        maxMatches?: number;
        cancellationToken?: { isCancellationRequested?: boolean };
        retainVerifiedMatchesOnIncomplete?: boolean;
        resolvedCoverageGaps?: Set<any>;
    } = {},
) {
    const result = {
        state: 'complete',
        locations: [],
        reasons: [],
        inspected: 0,
        namespaceCandidates: 0,
        indeterminateCandidates: 0,
    };
    if (!isEntityIdentity(query?.id) ||
        ((query.targetKinds || []).length === 0 && (query.targetDefinitions || []).length === 0)) {
        return { ...result, state: 'incomplete', reasons: ['registry-reference-query-invalid'] };
    }
    const hasScopedCoverage = Array.isArray(referenceIndex?.registryReferenceCoverageGaps);
    const relevantGaps = hasScopedCoverage
        ? referenceIndex.registryReferenceCoverageGaps.filter(gap => coverageGapMatches(query, gap) &&
            !options.resolvedCoverageGaps?.has(gap))
        : [];
    if (relevantGaps.length > 0) {
        if (options.retainVerifiedMatchesOnIncomplete === true) {
            result.state = 'incomplete';
            result.reasons.push(...relevantGaps.map(coverageGapReason));
        } else {
            return { ...result, state: 'incomplete', reasons: relevantGaps.map(coverageGapReason) };
        }
    } else if (!hasScopedCoverage && !referenceIndex?.registryReferenceScanComplete) {
        const scanReasons = Array.isArray(referenceIndex?.registryReferenceScanReasons)
            ? referenceIndex.registryReferenceScanReasons : [];
        // Older project snapshots recorded opaque relation values as a file-wide
        // failure. Keep their already indexed numeric occurrences usable; new
        // scans no longer emit this reason.
        const blockingScanReasons = scanReasons.filter(reason =>
            !String(reason).endsWith('registry-reference-input-unsupported'));
        if (scanReasons.length > 0 && blockingScanReasons.length === 0) {
            // Continue with the retained occurrences below.
        } else {
        return {
            ...result,
            state: 'incomplete',
            reasons: blockingScanReasons.length > 0
                ? blockingScanReasons
                : ['registry-reference-scan-unavailable'],
        };
        }
    }
    const maxMatches = Number.isInteger(options.maxMatches)
        ? Math.max(1, options.maxMatches)
        : DEFAULT_MAX_MATCHES;
    if (options.retainVerifiedMatchesOnIncomplete === true &&
        (referenceIndex.completenessReasons || []).length > 0) {
        result.state = 'incomplete';
        result.reasons.push(...referenceIndex.completenessReasons);
    }
    const seen = new Set();
    for (const occurrence of referenceIndex.registryReferenceOccurrences || []) {
        if (options.cancellationToken?.isCancellationRequested) {
            return { ...result, state: 'cancelled', locations: [], reasons: ['cancelled'] };
        }
        result.inspected += 1;
        if (!namespaceMatches(query, occurrence)) continue;
        result.namespaceCandidates += 1;
        const binding = occurrenceBinding(referenceIndex, occurrence, {
            bindingOnly: options.retainVerifiedMatchesOnIncomplete === true,
            query,
        });
        if (binding.unresolvedOccurrenceReasons?.length) {
            result.state = 'incomplete';
            result.reasons.push(...binding.unresolvedOccurrenceReasons);
        }
        if (!binding.ready) {
            result.state = 'incomplete';
            result.indeterminateCandidates += 1;
            result.reasons.push(...(
                binding.blockingReasons.length > 0
                    ? binding.blockingReasons.map(reason => `${occurrence.filePath}:${occurrence.lineIndex}:${reason}`)
                    : [`${occurrence.filePath}:${occurrence.lineIndex}:reference-binding-indeterminate`]
            ));
            continue;
        }
        if (!entityIdentityEquals(binding.analysis.id, query.id)) continue;
        if (binding.analysis.targetSelection && !namespaceMatches(query, binding.analysis)) continue;
        if (occurrence.targetDefinitionUnavailable) {
            result.state = 'incomplete';
            result.reasons.push('lspp-target-definition-layout-unresolved');
        }
        const key = [
            normalizeFilePath(occurrence.filePath),
            occurrence.lineIndex,
            occurrence.startCharacter,
            occurrence.endCharacter,
        ].join(':');
        if (seen.has(key)) continue;
        seen.add(key);
        if (result.locations.length >= maxMatches) {
            const reasons = [...new Set([...result.reasons,
                'registry-reference-results-capacity-exceeded'])].sort();
            return options.retainVerifiedMatchesOnIncomplete === true
                ? { ...result, state: 'partial', reasons }
                : { ...result, state: 'incomplete', locations: [], reasons };
        }
        result.locations.push({
            filePath: occurrence.filePath,
            line: occurrence.lineIndex,
            startCharacter: occurrence.startCharacter,
            endCharacter: occurrence.endCharacter,
            authoringRelationId: occurrence.authoringRelationId,
            coordinateId: occurrence.coordinateId,
            sourceRuleId: occurrence.sourceRuleId,
            id: binding.analysis.id,
        });
    }
    result.locations.sort((left, right) =>
        normalizeFilePath(left.filePath).localeCompare(normalizeFilePath(right.filePath)) ||
        left.line - right.line || left.startCharacter - right.startCharacter
    );
    result.reasons = [...new Set(result.reasons)].sort();
    if (result.reasons.length > 0) {
        if (options.retainVerifiedMatchesOnIncomplete === true) {
            result.state = 'partial';
        } else {
            result.state = 'incomplete';
            result.locations = [];
        }
    }
    return result;
}

function definitionLocations(referenceIndex, query) {
    if (!referenceIndex || !query) return [];
    const seen = new Set();
    const locations = [];
    for (const definition of resolveReferenceDefinitions(
        referenceIndex,
        query.id,
        query.targetKinds,
        query.targetDefinitions,
    )) {
        if (!Number.isInteger(definition.idLine) || !Number.isInteger(definition.idStartChar) ||
            !Number.isInteger(definition.idEndChar) || !definition.filePath) continue;
        const key = [
            normalizeFilePath(definition.filePath),
            definition.idLine,
            definition.idStartChar,
            definition.idEndChar,
        ].join(':');
        if (seen.has(key)) continue;
        seen.add(key);
        locations.push({
            filePath: definition.filePath,
            line: definition.idLine,
            startCharacter: definition.idStartChar,
            endCharacter: definition.idEndChar,
            declaration: true,
        });
    }
    return locations.sort((left, right) =>
        normalizeFilePath(left.filePath).localeCompare(normalizeFilePath(right.filePath)) ||
        left.line - right.line || left.startCharacter - right.startCharacter
    );
}

module.exports = {
    DEFAULT_MAX_MATCHES,
    NON_BINDING_COVERAGE_REASONS,
    collectRegistryReferenceMatches,
    definitionAtPosition,
    definitionLocations,
    definitionNamespace,
    namespaceMatches,
    coverageGapMatches,
    occurrenceBinding,
    queryFromReferenceSource,
};

export {};
