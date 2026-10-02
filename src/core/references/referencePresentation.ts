'use strict';

const path = require('path');
const { selectProvisionalCandidate } = require('./referenceNavigation');

function normalizeFilePathKey(filePath) {
    if (!filePath) return '';
    const resolved = path.resolve(String(filePath));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function candidatePreviewMode(definition) {
    if (!definition) return 'location-only';
    if (definition.kind === 'generic') return 'location-only';
    if (definition.kind === 'functionCurve') return 'summary';
    if (definition.dataCompleteness && definition.dataCompleteness.state !== 'complete') {
        return 'summary';
    }
    if (definition.kind === 'curve') {
        const points = definition.points || [];
        return points.length >= 2 && points.every(point =>
            Number.isFinite(point.x) && Number.isFinite(point.y)
        )
            ? 'visual'
            : 'summary';
    }
    if (definition.kind === 'table') {
        return (definition.rows || []).length > 0 ? 'visual' : 'summary';
    }
    return 'location-only';
}

function previewBlockedReasons(definition, previewMode) {
    if (previewMode !== 'summary') return [];
    if (definition && definition.dataCompleteness &&
        Array.isArray(definition.dataCompleteness.reasons)) {
        return [...definition.dataCompleteness.reasons];
    }
    return [];
}

function buildReferencePresentation(analysis, context: { documentPath?: string } = {}) {
    const effectiveAnalysis = analysis || {
        state: 'uncertain',
        definitions: [],
        reasons: ['reference-value-unresolved'],
    };
    const reasons = [...new Set(effectiveAnalysis.reasons || [])];
    const definitions = effectiveAnalysis.definitions || [];
    const previewAllowed = definitions.length === 1;
    const provisionalSelection = selectProvisionalCandidate(definitions.map(definition => ({
        filePath: definition && definition.filePath,
        line: Number.isInteger(definition && definition.idLine)
            ? definition.idLine
            : Number.isInteger(definition && definition.startLine) ? definition.startLine : 0,
        startCharacter: 0,
        endCharacter: 0,
        definition,
    })));
    const provisional = !!provisionalSelection.primary &&
        !(effectiveAnalysis.state === 'exact' && definitions.length === 1);
    const documentKey = normalizeFilePathKey(context.documentPath);
    const relation = effectiveAnalysis.state === 'uncertain'
        ? 'possible-match'
        : 'confirmed-match';
    const candidates = definitions.map(definition => {
        const definitionKey = normalizeFilePathKey(definition && definition.filePath);
        const previewMode = candidatePreviewMode(definition);
        return {
            definition,
            origin: documentKey && definitionKey === documentKey
                ? 'current-file'
                : 'project-file',
            relation,
            navigable: !!(
                definition &&
                typeof definition.filePath === 'string' &&
                definition.filePath.length > 0 &&
                Number.isInteger(definition.startLine) &&
                definition.startLine >= 0
            ),
            previewAllowed,
            previewMode,
            previewBlockedReasons: previewBlockedReasons(definition, previewMode),
            provisional,
            provisionalPrimary: provisional && definition === provisionalSelection.primary?.definition,
        };
    });
    const provisionalPrimary = candidates.find(candidate => candidate.provisionalPrimary) || null;
    const provisionalAlternatives = candidates.filter(candidate => candidate !== provisionalPrimary);

    return {
        bindingState: effectiveAnalysis.state,
        reasons,
        candidates,
        previewAllowed,
        projectCoverageAvailable: !reasons.includes('project-scan-unavailable'),
        showProjectScanAction: reasons.includes('project-scan-unavailable'),
        provisional,
        provisionalPrimary,
        provisionalAlternatives,
        provisionalSelectionReason: effectiveAnalysis.state === 'exact' && definitions.length === 1
            ? 'exact-candidate'
            : provisionalSelection.primary
                ? provisionalSelection.alternatives.length === 0 ? 'unique-namespace-candidate' : 'highest-ranked-candidate'
                : 'no-candidate',
    };
}

module.exports = {
    buildReferencePresentation,
    candidatePreviewMode,
    normalizeFilePathKey,
};

export {};
