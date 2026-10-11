'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), z = require('node:zlib');
const { keywordDataPath } = require('../../../src/core/keywordDataPath');
const { resolveReferenceValueSemantics } = require('../../../src/core/references/fieldReferenceClassifier');
const index = require(keywordDataPath('references/field_reference_index.json'));
const policy = JSON.parse(z.gunzipSync(fs.readFileSync('keywords/sources/semantic-inputs/entity_reference_user_exclusions.v2.json.gz')));

describe('user-excluded static reference projection', () => {
    it('projects the exact author exclusions and omits their static blockers', () => {
        assert.equal(index.userReferenceExclusions.contentSha256, policy.contentSha256);
        assert.equal(index.userReferenceExclusions.excludedSourceBranches, 4165);
        assert.equal(index.userReferenceExclusions.excludedPublishedFields, 7);
        assert.equal(index.lsppReferenceCoverage.blockedRelations, 4165);
        assert.equal(index.lsppReferenceCoverage.completenessClaim, false);
        assert.equal(index.lsppBlockedReferences.recordCount, 0);
        for (const excluded of policy.excludedReferences) {
            const record = index.references[excluded.keyword].find(row => row.fieldName === excluded.fieldName &&
                JSON.stringify(row.nativeSources) === JSON.stringify(excluded.nativeSources));
            assert.equal(record.userExclusion.status, 'user-excluded');
            for (const value of [73, -73, 0, 1.5, '&VALUE'])
                assert.equal(resolveReferenceValueSemantics(record.relation, value).state, 'non-reference');
        }
    });
    it('preserves confirmed ANG semantics and its unresolved parameter state', () => {
        const ang = index.references.EM_CONTROL_SOLUTION.find(row => row.fieldName === 'ANG');
        const negative = resolveReferenceValueSemantics(ang.relation, -73);
        assert.deepEqual(negative.targetKinds, ['curve']); assert.equal(negative.id, 73);
        assert.equal(resolveReferenceValueSemantics(ang.relation, '&ANG').state, 'indeterminate');
        assert.equal(index.references.DEFINE_FRICTION.some(row => row.userExclusion), false);
    });
});
