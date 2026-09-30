const assert = require('assert');
const {
    buildWorkspaceSearchFilesToInclude,
    effectiveWorkspaceSearchId,
    normalizeWorkspaceSearchExtensions,
    shouldOfferWorkspaceReferenceSearch,
} = require('../../../out/core/references/workspaceReferenceSearch');

describe('workspaceReferenceSearch', () => {
    it('builds a bounded LS-DYNA file filter from configured extensions', () => {
        assert.deepEqual(
            normalizeWorkspaceSearchExtensions(['dat', '.INCL', '*.bad', 'x,y', '.KEY', 'key']),
            ['.dat', '.incl', '.key']
        );
        assert.equal(
            buildWorkspaceSearchFilesToInclude(['dat', '.INCL', '*.bad', '.KEY']),
            '**/*.dat,**/*.incl,**/*.key'
        );
        assert.equal(
            buildWorkspaceSearchFilesToInclude(['*', ',']),
            '**/*.k,**/*.key,**/*.dyna'
        );
    });

    it('uses the evaluated effective ID and blocks unresolved transforms', () => {
        const referenceValue = { kind: 'numeric', id: 17, raw: '17' };
        assert.equal(effectiveWorkspaceSearchId(referenceValue, {
            id: 117,
            transformResolution: { resolved: true, sourceId: 17, effectiveId: 117, offset: 100 },
            reasons: [],
        }), 117);
        assert.equal(effectiveWorkspaceSearchId(referenceValue, {
            id: 17,
            transformResolution: { resolved: false },
            reasons: ['transform-occurrence-ambiguous'],
        }), null);
        assert.equal(effectiveWorkspaceSearchId(referenceValue, {
            id: 17,
            reasons: ['project-root-ambiguous'],
        }), null);
        assert.equal(effectiveWorkspaceSearchId(referenceValue, {
            id: 17,
            reasons: ['signed-switch-transform-unverified'],
        }), null);
    });

    it('requires parameter and value-role evaluation before offering a search', () => {
        const parameter = { kind: 'parameter', raw: '&CID', parameterName: 'CID' };
        assert.equal(effectiveWorkspaceSearchId(parameter, {
            reasons: ['parameter-unresolved'],
        }), null);
        assert.equal(effectiveWorkspaceSearchId(parameter, {
            id: 42,
            parameterResolution: { resolved: true, value: 42 },
            transformResolution: { resolved: true, effectiveId: 42 },
            reasons: ['target-kind-on-demand'],
        }), 42);
        assert.equal(effectiveWorkspaceSearchId(parameter, {
            id: 42,
            parameterResolution: { resolved: true, value: 0 },
            reasons: ['reference-role-not-active'],
        }), null);
    });

    it('offers the fallback only when no navigable definition candidate is known', () => {
        const reference = { kind: 'numeric', id: 1001, raw: '1001' };
        const unindexed = {
            state: 'uncertain',
            id: 1001,
            reasons: ['project-scan-unavailable'],
        };
        assert.equal(shouldOfferWorkspaceReferenceSearch(reference, unindexed, 0), true);
        assert.equal(shouldOfferWorkspaceReferenceSearch(reference, unindexed, 1), false);
        assert.equal(shouldOfferWorkspaceReferenceSearch(reference, {
            ...unindexed,
            state: 'exact',
        }, 0), false);
    });
});
