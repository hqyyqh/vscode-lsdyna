const assert = require('assert');
const path = require('path');
const {
    buildReferenceNavigation,
    classifyReferenceNavigationState,
    definitionNavigationCandidate,
    selectProvisionalCandidate,
} = require('../../../out/core/references/referenceNavigation');

describe('referenceNavigation', () => {
    it('maps resolver certainty and coverage to stable navigation states', () => {
        assert.equal(classifyReferenceNavigationState({ state: 'exact' }), 'resolved');
        assert.equal(classifyReferenceNavigationState({ state: 'ambiguous' }), 'ambiguous');
        assert.equal(classifyReferenceNavigationState({ state: 'missing' }), 'missing');
        assert.equal(classifyReferenceNavigationState({
            state: 'uncertain', reasons: ['project-scan-unavailable'],
        }), 'unindexed');
        assert.equal(classifyReferenceNavigationState({
            state: 'uncertain', reasons: ['target-kind-on-demand'],
        }), 'unindexed');
        assert.equal(classifyReferenceNavigationState({
            state: 'uncertain', reasons: ['project-root-ambiguous'],
        }), 'ambiguous');
        assert.equal(classifyReferenceNavigationState({
            state: 'uncertain', reasons: ['target-out-of-closure'],
        }), 'out-of-closure');
        assert.equal(classifyReferenceNavigationState({
            state: 'uncertain', reasons: ['missing-include'],
        }), 'out-of-closure');
        assert.equal(classifyReferenceNavigationState({
            state: 'uncertain', reasons: ['parameter-unresolved', 'project-scan-unavailable'],
        }), 'dynamic');
        assert.equal(classifyReferenceNavigationState({
            state: 'uncertain', reasons: ['signed-switch-transform-unverified'],
        }), 'dynamic');
        assert.equal(classifyReferenceNavigationState({
            state: 'uncertain', reasons: [
                'on-demand-definition-expression',
                'target-kind-on-demand',
            ],
        }), 'dynamic');
    });

    it('uses an exact ID token range and falls back to the keyword line', () => {
        assert.deepEqual(definitionNavigationCandidate({
            filePath: '/model/curve.k',
            startLine: 10,
            idLine: 12,
            idStartChar: 6,
            idEndChar: 10,
        }), {
            filePath: '/model/curve.k',
            line: 12,
            startCharacter: 6,
            endCharacter: 10,
            definition: {
                filePath: '/model/curve.k',
                startLine: 10,
                idLine: 12,
                idStartChar: 6,
                idEndChar: 10,
            },
        });
        const fallback = definitionNavigationCandidate({
            filePath: '/model/legacy.k',
            startLine: 7,
        });
        assert.equal(fallback.line, 7);
        assert.equal(fallback.startCharacter, 0);
        assert.equal(fallback.endCharacter, 0);
    });

    it('deduplicates one physical definition reached through multiple Include occurrences', () => {
        const filePath = path.resolve('model', 'shared-curves.k');
        const physical = {
            kind: 'curve',
            id: 1001,
            filePath,
            startLine: 3,
            idLine: 4,
            idStartChar: 6,
            idEndChar: 10,
        };
        const navigation = buildReferenceNavigation({
            state: 'ambiguous',
            reasons: [],
            definitions: [
                { ...physical, occurrenceId: 'root:a' },
                { ...physical, occurrenceId: 'root:b' },
                { ...physical, filePath: path.resolve('model', 'other-curves.k') },
            ],
        });

        assert.equal(navigation.state, 'ambiguous');
        assert.equal(navigation.candidateCertainty, 'verified');
        assert.equal(navigation.candidates.length, 2);
    });

    it('keeps uncertain local matches navigable without labeling them resolved', () => {
        const navigation = buildReferenceNavigation({
            state: 'uncertain',
            reasons: ['project-scan-unavailable'],
            definitions: [{
                filePath: '/model/local.k',
                startLine: 20,
            }],
        });

        assert.equal(navigation.state, 'unindexed');
        assert.equal(navigation.candidateCertainty, 'known-candidate');
        assert.equal(navigation.candidates.length, 1);
        assert.equal(navigation.provisional, true);
        assert.equal(navigation.provisionalSelectionReason, 'unique-namespace-candidate');
    });

    it('selects a deterministic provisional primary while preserving alternatives', () => {
        const candidates = [
            { filePath: 'z.k', line: 2, startCharacter: 0, endCharacter: 0, definition: { filePath: 'z.k', startLine: 2 } },
            { filePath: 'a.k', line: 1, startCharacter: 0, endCharacter: 0, definition: { filePath: 'a.k', startLine: 1, matchKind: 'exact' } },
        ];
        const selection = selectProvisionalCandidate(candidates);
        assert.equal(selection.primary.filePath, 'a.k');
        assert.equal(selection.alternatives.length, 1);
    });
});
