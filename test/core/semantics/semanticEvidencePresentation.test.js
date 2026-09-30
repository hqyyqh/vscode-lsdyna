'use strict';

const assert = require('assert');
const {
    semanticEvidenceTargets,
    semanticEvidenceTargetLabel,
} = require('../../../out/core/semantics/semanticEvidencePresentation');

function authority(profile, index, revision = 'master@abc123def (01/02/26)') {
    return {
        sourceProfileId: profile,
        indexSha256: index,
        flavor: 'en',
        displayName: 'English',
        documents: [{
            manualId: 'manual-vol-ii',
            title: 'LS-DYNA Keyword Manual Vol II',
            revision,
        }],
    };
}

describe('semantic evidence presentation', () => {
    const profile = 'a'.repeat(64);
    const index = 'b'.repeat(64);
    const evidenceAuthority = {
        sourceProfileId: profile,
        indexSha256: index,
        documents: [{ manualId: 'manual-vol-ii', revision: 'master@abc123def (01/02/26)' }],
    };
    const items = [{
        ruleId: 'rule:one',
        evidence: [
            { evidenceId: 'evidence:one', manualId: 'manual-vol-ii', page: 832, sourceProfileId: profile },
            { evidenceId: 'evidence:two', manualId: 'manual-vol-ii', page: 832, sourceProfileId: profile },
        ],
    }];

    it('dedupes one physical target and uses an engineer-readable manual label', () => {
        const targets = semanticEvidenceTargets(items, authority(profile, index), evidenceAuthority);
        assert.equal(targets.length, 1);
        assert.equal(targets[0].evidenceId, 'evidence:one');
        assert.equal(semanticEvidenceTargetLabel(targets[0]), 'Vol II · P832');
    });

    it('silently hides evidence when the configured profile is not published', () => {
        assert.deepEqual(
            semanticEvidenceTargets(items, authority('c'.repeat(64), 'd'.repeat(64)), evidenceAuthority),
            [],
        );
        assert.deepEqual(semanticEvidenceTargets(items, null, evidenceAuthority), []);
    });

    it('silently hides evidence while no current pack authority is available', () => {
        assert.deepEqual(semanticEvidenceTargets(items, null, evidenceAuthority), []);
    });

    it('can render the locked target before the manual-pack lifecycle is available', () => {
        const targets = semanticEvidenceTargets(items, undefined, evidenceAuthority);
        assert.equal(targets.length, 1);
        assert.equal(targets[0].page, 832);
    });

    it('selects only the current location from a multi-profile registry', () => {
        const bilingualProfile = 'c'.repeat(64);
        const bilingualIndex = 'd'.repeat(64);
        const registry = {
            schemaVersion: 2,
            defaultSourceProfileId: profile,
            profiles: [
                {
                    sourceProfileId: profile,
                    indexSha256: index,
                    documents: [{
                        manualId: 'manual-vol-ii',
                        title: 'LS-DYNA Keyword Manual Vol II',
                        revision: 'master@abc123def (01/02/26)',
                    }],
                },
                {
                    sourceProfileId: bilingualProfile,
                    indexSha256: bilingualIndex,
                    documents: [{
                        manualId: 'manual-vol-ii',
                        title: 'LS-DYNA Keyword Manual Vol II',
                        revision: 'master@def456abc (12/31/25)',
                    }],
                },
            ],
        };
        const profileItems = [{
            ruleId: 'rule:profile',
            evidence: [
                {
                    evidenceId: 'evidence:profile',
                    manualId: 'manual-vol-ii',
                    page: 832,
                    sourceProfileId: profile,
                },
                {
                    evidenceId: 'evidence:profile',
                    manualId: 'manual-vol-ii',
                    page: 814,
                    sourceProfileId: bilingualProfile,
                },
            ],
        }];

        assert.deepEqual(
            semanticEvidenceTargets(profileItems, authority(profile, index), registry)
                .map(target => target.page),
            [832],
        );
        assert.deepEqual(
            semanticEvidenceTargets(
                profileItems,
                authority(bilingualProfile, bilingualIndex),
                registry,
            ).map(target => target.page),
            [814],
        );
        assert.deepEqual(
            semanticEvidenceTargets(profileItems, undefined, registry)
                .map(target => target.page),
            [832],
            'no lifecycle snapshot may use only the reviewed default profile',
        );
        assert.deepEqual(
            semanticEvidenceTargets(
                profileItems,
                authority(bilingualProfile, 'e'.repeat(64)),
                registry,
            ),
            [],
        );
    });
});
