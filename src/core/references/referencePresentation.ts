'use strict';

const path = require('path');

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
    const documentKey = normalizeFilePathKey(context.documentPath);
    const relation = effectiveAnalysis.state === 'uncertain'
        ? 'possible-match'
        : 'confirmed-match';
    const candidates = (effectiveAnalysis.definitions || []).map(definition => {
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
            previewMode,
            previewBlockedReasons: previewBlockedReasons(definition, previewMode),
        };
    });

    return {
        bindingState: effectiveAnalysis.state,
        reasons,
        candidates,
        projectCoverageAvailable: !reasons.includes('project-scan-unavailable'),
        showProjectScanAction: reasons.includes('project-scan-unavailable'),
    };
}

module.exports = {
    buildReferencePresentation,
    candidatePreviewMode,
    normalizeFilePathKey,
};

export {};
