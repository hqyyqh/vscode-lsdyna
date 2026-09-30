'use strict';

const path = require('path');

const UNINDEXED_REASONS = new Set([
    'project-scan-unavailable',
    'target-kind-on-demand',
    'target-kind-unindexed',
    'target-definition-on-demand',
    'target-definition-unindexed',
]);

const OUT_OF_CLOSURE_REASONS = new Set([
    'definition-out-of-closure',
    'include-out-of-closure',
    'missing-include',
    'target-out-of-closure',
]);

function normalizeFilePathKey(filePath) {
    if (!filePath) return '';
    const resolved = path.resolve(String(filePath));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isDynamicReason(reason) {
    const value = String(reason || '');
    return value.startsWith('parameter-') ||
        value.startsWith('transform-') ||
        value.startsWith('reference-value-') ||
        value.startsWith('reference-predicate-') ||
        value.startsWith('reference-id-') ||
        value.startsWith('on-demand-definition-') ||
        value.startsWith('on-demand-reference-') ||
        value === 'reference-role-not-active' ||
        value === 'signed-switch-transform-unverified' ||
        value === 'nested-transform-unsupported';
}

/**
 * Maps the lower-level resolver result to stable, UI-neutral navigation states.
 * The mapping does not infer any LS-DYNA semantics; it only reports the coverage
 * and certainty already carried by an official-manual analysis result.
 */
function classifyReferenceNavigationState(analysis) {
    const state = analysis && analysis.state;
    if (state === 'exact') return 'resolved';
    if (state === 'ambiguous') return 'ambiguous';
    if (state === 'missing') return 'missing';

    const reasons = [...new Set(analysis && analysis.reasons || [])];
    if (reasons.some(isDynamicReason)) return 'dynamic';
    if (reasons.includes('project-root-ambiguous')) return 'ambiguous';
    if (reasons.some(reason => OUT_OF_CLOSURE_REASONS.has(String(reason)))) {
        return 'out-of-closure';
    }
    if (reasons.some(reason => UNINDEXED_REASONS.has(String(reason)))) return 'unindexed';
    return 'dynamic';
}

function definitionNavigationCandidate(definition) {
    if (!definition || typeof definition.filePath !== 'string' || !definition.filePath) {
        return null;
    }
    const line = Number.isInteger(definition.idLine) && definition.idLine >= 0
        ? definition.idLine
        : Number.isInteger(definition.startLine) && definition.startLine >= 0
            ? definition.startLine
            : null;
    if (line === null) return null;

    const startCharacter = Number.isInteger(definition.idStartChar) && definition.idStartChar >= 0
        ? definition.idStartChar
        : 0;
    const endCharacter = Number.isInteger(definition.idEndChar) &&
        definition.idEndChar >= startCharacter
        ? definition.idEndChar
        : startCharacter;
    return {
        filePath: definition.filePath,
        line,
        startCharacter,
        endCharacter,
        definition,
    };
}

function dedupePhysicalCandidates(definitions) {
    const candidates = [];
    const seen = new Set();
    for (const definition of definitions || []) {
        const candidate = definitionNavigationCandidate(definition);
        if (!candidate) continue;
        const key = [
            normalizeFilePathKey(candidate.filePath),
            candidate.line,
            candidate.startCharacter,
            candidate.endCharacter,
        ].join(':');
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
    }
    return candidates;
}

function compareText(left, right) {
    const a = String(left || '');
    const b = String(right || '');
    return a === b ? 0 : a < b ? -1 : 1;
}

function provisionalCandidateScore(candidate) {
    const definition = candidate && candidate.definition || {};
    let score = 0;
    if (candidate && candidate.filePath) score += 4;
    if (Number.isInteger(candidate && candidate.line) && candidate.line >= 0) score += 2;
    if (definition.matchKind === 'exact' || definition.bindingState === 'exact') score += 8;
    if (definition.targetKind && definition.kind && definition.targetKind === definition.kind) score += 2;
    if (definition.origin === 'current-file') score += 1;
    return score;
}

/** Stable authoring-preview ordering; strict state/certainty remains untouched. */
function selectProvisionalCandidate(candidates) {
    const ranked = (candidates || []).map((candidate, index) => ({ candidate, index }))
        .sort((left, right) => {
            const score = provisionalCandidateScore(right.candidate) - provisionalCandidateScore(left.candidate);
            if (score !== 0) return score;
            const pathOrder = compareText(
                normalizeFilePathKey(left.candidate.filePath),
                normalizeFilePathKey(right.candidate.filePath),
            );
            if (pathOrder !== 0) return pathOrder;
            return (left.candidate.line - right.candidate.line) ||
                (left.candidate.startCharacter - right.candidate.startCharacter) ||
                (left.candidate.endCharacter - right.candidate.endCharacter) ||
                (left.index - right.index);
        })
        .map(item => item.candidate);
    return {
        primary: ranked[0] || null,
        alternatives: ranked.slice(1),
        ranked,
    };
}

function buildReferenceNavigation(analysis) {
    const effectiveAnalysis = analysis || {
        state: 'uncertain',
        definitions: [],
        reasons: ['reference-value-unresolved'],
    };
    const candidates = dedupePhysicalCandidates(effectiveAnalysis.definitions || []);
    const selection = selectProvisionalCandidate(candidates);
    const exactUnique = effectiveAnalysis.state === 'exact' && candidates.length === 1;
    return {
        state: classifyReferenceNavigationState(effectiveAnalysis),
        bindingState: effectiveAnalysis.state,
        reasons: [...new Set(effectiveAnalysis.reasons || [])],
        candidates,
        candidateCertainty: effectiveAnalysis.state === 'uncertain'
            ? 'known-candidate'
            : 'verified',
        provisional: !!selection.primary && !exactUnique,
        provisionalPrimary: selection.primary,
        provisionalAlternatives: selection.alternatives,
        rankedCandidates: selection.ranked,
        provisionalSelectionReason: exactUnique
            ? 'exact-candidate'
            : selection.primary
                ? selection.alternatives.length === 0 ? 'unique-namespace-candidate' : 'highest-ranked-candidate'
                : 'no-candidate',
    };
}

module.exports = {
    buildReferenceNavigation,
    classifyReferenceNavigationState,
    dedupePhysicalCandidates,
    definitionNavigationCandidate,
    selectProvisionalCandidate,
};

export {};
