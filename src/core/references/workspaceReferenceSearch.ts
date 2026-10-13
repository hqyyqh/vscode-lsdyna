'use strict';

const DEFAULT_WORKSPACE_SEARCH_EXTENSIONS = ['.k', '.key', '.dyna'];

function isSafeReferenceId(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function normalizeWorkspaceSearchExtensions(values) {
    const source = Array.isArray(values) ? values : DEFAULT_WORKSPACE_SEARCH_EXTENSIONS;
    const normalized = [];
    const seen = new Set();
    for (const value of source) {
        const suffix = String(value || '').trim().replace(/^\.+/, '').toLowerCase();
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(suffix)) continue;
        const extension = `.${suffix}`;
        if (seen.has(extension)) continue;
        seen.add(extension);
        normalized.push(extension);
    }
    return normalized.length > 0
        ? normalized
        : [...DEFAULT_WORKSPACE_SEARCH_EXTENSIONS];
}

function buildWorkspaceSearchFilesToInclude(values) {
    return normalizeWorkspaceSearchExtensions(values)
        .map(extension => `**/*${extension}`)
        .join(',');
}

function effectiveWorkspaceSearchId(referenceValue, analysis = null) {
    if (!referenceValue) return null;
    const reasons = new Set(analysis && analysis.reasons || []);
    if (reasons.has('project-root-ambiguous') ||
        reasons.has('signed-switch-transform-unverified') ||
        reasons.has('reference-role-not-active')) {
        return null;
    }
    if (analysis && analysis.transformResolution &&
        analysis.transformResolution.resolved !== true) {
        return null;
    }
    if (['parameter', 'expression'].includes(referenceValue.kind) &&
        !(analysis && analysis.parameterResolution && analysis.parameterResolution.resolved)) {
        return null;
    }

    const candidate = analysis && isSafeReferenceId(analysis.id)
        ? analysis.id
        : referenceValue.kind === 'numeric' && isSafeReferenceId(referenceValue.id)
            ? referenceValue.id
            : null;
    return isSafeReferenceId(candidate) ? candidate : null;
}

function shouldOfferWorkspaceReferenceSearch(referenceValue, analysis, candidateCount = 0) {
    if (candidateCount > 0) return false;
    if (analysis && (analysis.state === 'exact' || analysis.state === 'ambiguous')) return false;
    return effectiveWorkspaceSearchId(referenceValue, analysis) !== null;
}

module.exports = {
    DEFAULT_WORKSPACE_SEARCH_EXTENSIONS,
    buildWorkspaceSearchFilesToInclude,
    effectiveWorkspaceSearchId,
    normalizeWorkspaceSearchExtensions,
    shouldOfferWorkspaceReferenceSearch,
};

export {};
