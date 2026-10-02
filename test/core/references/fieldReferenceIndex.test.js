const assert = require('assert');
const path = require('path');

describe('field reference index', () => {
    it('contains source-locked LS-PrePost relations and compact definition layouts', () => {
        const index = require(path.join('..', '..', '..', 'keywords', 'runtime', 'references', 'field_reference_index.json'));

        assert.equal(index.schemaVersion, 2);
        assert.ok(Object.keys(index.references).length > 0);
        assert.match(index.generatedFrom.lsppDatabaseSha256, /^[0-9a-f]{64}$/);
        assert.match(index.generatedFrom.lsppHandoffSha256, /^[0-9a-f]{64}$/);
        assert.equal(index.definitionKeywords.generic.SET_PART, undefined);
        assert.equal(index.lsppReferenceCoverage.publishedSourceRelations +
            index.lsppReferenceCoverage.blockedRelations,
        index.lsppReferenceCoverage.relationBranches);
        assert.match(index.generatedFrom.manualSemanticRuntimeId, /^[0-9a-f]{64}$/);
        assert.match(index.generatedFrom.manualSemanticManifestSha256, /^[0-9a-f]{64}$/);
        assert.ok(index.definitionKeywords.scanned.includes('DEFINE_CURVE'));
        assert.ok(index.definitionKeywords.scanned.includes('DEFINE_CURVE_FUNCTION'));
        assert.ok(index.definitionKeywords.scanned.includes('DEFINE_TABLE_2D'));
        assert.ok(!index.definitionKeywords.scanned.includes('DEFINE_CURVE_FEEDBACK'));
        assert.ok(index.definitionKeywords.generic.DEFINE_CPM_CHAMBER);
        assert.equal(
            index.definitionKeywords.generic.DEFINE_CPM_CHAMBER_TITLE.target,
            'DEFINE_CPM_CHAMBER',
        );
        assert.equal(index.definitionKeywords.generic.PART.targetKind, 'part');
        assert.equal(index.definitionKeywords.generic.MAT_ELASTIC.targetKind, 'material');
        assert.equal(index.definitionKeywords.onDemand.NODE.targetKind, 'node');
        assert.equal(index.definitionKeywords.blocked.length, 0);
    });

    it('keeps every definition descriptor aligned with a unique rendered schema field', () => {
        const index = require(path.join('..', '..', '..', 'keywords', 'runtime', 'references', 'field_reference_index.json'));
        const schema = require(path.join('..', '..', '..', 'keywords', 'runtime', 'schema', 'field_data.json'));
        const { getRenderedCards, lookupKeywordSchema } = require('../../../out/core/keywordSchema');
        const descriptors = {
            ...index.definitionKeywords.generic,
            ...index.definitionKeywords.onDemand,
        };

        assert.ok(Object.keys(index.references).length > 0);
        assert.ok(Object.keys(descriptors).length >= 700);
        assert.ok(Object.keys(index.definitionKeywords.onDemand).length > 0);

        for (const [keyword, descriptor] of Object.entries(descriptors)) {
            const lookup = lookupKeywordSchema(keyword, schema);
            assert.ok(lookup, `missing schema lookup for ${keyword}`);
            const card = getRenderedCards(lookup.entry, lookup.activeOptions)[descriptor.cardIndex - 1];
            const field = card && card[descriptor.fieldIndex];
            assert.ok(field, `missing ${keyword} descriptor field`);
            assert.deepEqual(
                [field.n, field.t, field.p, field.w],
                [descriptor.fieldName, descriptor.fieldType, descriptor.position, descriptor.width],
                `${keyword} descriptor layout mismatch`,
            );
            if (descriptor.source === "keyword-catalog") {
                assert.ok(Number.isInteger(descriptor.linkCode));
            } else {
                assert.match(descriptor.ruleId, /^rule:/);
                assert.ok(descriptor.evidenceIds.every(id => /^evidence:/.test(id)));
            }
        }
    });
});
