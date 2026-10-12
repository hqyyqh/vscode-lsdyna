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
            'DEFINE_CPM_CHAMBER_TITLE',
        );
        assert.equal(index.definitionKeywords.generic.PART.targetKind, 'part');
        assert.equal(index.definitionKeywords.generic.MAT_ELASTIC.targetKind, 'material');
        assert.equal(index.definitionKeywords.onDemand.NODE.targetKind, 'node');
        assert.equal(index.definitionKeywords.blocked.length, 0);
    });

    it('keeps every definition descriptor aligned with a rendered field or exact original native field', function () {
        this.timeout(10_000); // Verifies more than 700 descriptors, including cold native-form loads.
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
        const repeatedInterfaces = new Set(['NODE', 'SEGMENT', 'SPH'].flatMap(kind =>
            ['ID', 'TITLE'].map(suffix => `INTERFACE_COMPONENT_${kind}_${suffix}`)));
        const seenRepeatedInterfaces = new Set();

        for (const [keyword, descriptor] of Object.entries(descriptors)) {
            const lookup = lookupKeywordSchema(keyword, schema);
            const card = lookup && getRenderedCards(lookup.entry, lookup.activeOptions)[descriptor.cardIndex - 1];
            const field = card && card[descriptor.fieldIndex];
            if (!field && descriptor.source === "keyword-catalog") {
                const form = require("../../../out/core/semantics/catalogInputFormCatalogV4")
                    .getCatalogInputFormCatalogV4().formForKeyword(keyword);
                assert.equal(form?.source.datasetSha256, "1e631456cbcdea5193fc695a2d1bc2a4c8075e88a7a0dc00451d76b24e9504bb", keyword);
                const nativeFields = Object.values(form.rules).filter(rule => rule.cardSetId === descriptor.nativeCardArrayAddress)
                    .flatMap(rule => (rule.cards || []).flatMap(card => card.fields.filter(candidate => candidate.fieldRecordId === descriptor.nativeFieldAddress)));
                assert.equal(nativeFields.length, 1, `${keyword}: native field identity must be unique`);
                const native = nativeFields[0];
                assert.deepEqual([native.name, native.type, native.fieldIndex, native.position, native.width],
                    [descriptor.fieldName, 1, descriptor.fieldIndex, descriptor.position, descriptor.width], keyword);
                assert.equal(descriptor.cardIndex, descriptor.dataRecordOrdinal + 1, keyword);
                if (repeatedInterfaces.has(keyword)) {
                    assert.equal(descriptor.recordMode, 'repeat-data-record-template', keyword);
                    assert.deepEqual([descriptor.targetKind, descriptor.fieldName, descriptor.dataRecordOrdinal,
                        descriptor.recordStride], ['interface-id', 'ID', 0, 2], keyword);
                    seenRepeatedInterfaces.add(keyword);
                } else assert.equal(descriptor.recordMode, 'exact-data-record-ordinal', keyword);
                assert.ok(require('../../../out/core/semantics/descriptorIdentity').isDescriptorIdentity(descriptor.nativeMapAddress));
                assert.ok(descriptor.selectorRuleId && descriptor.selectorEvidenceIds.length, keyword);
                assert.deepEqual(descriptor.formatContracts.map(format => format.format).sort(), ['comma','i10','long','standard']);
                continue;
            }
            assert.ok(field, `missing ${keyword} descriptor field`);
            assert.deepEqual(
                [field.n, field.t, field.p, field.w],
                [descriptor.fieldName, descriptor.fieldType, descriptor.position, descriptor.width],
                `${keyword} descriptor layout mismatch`,
            );
            if (descriptor.source === "keyword-catalog") {
                if (descriptor.linkCode === null) {
                    // Original stores can define a namespace without a GUI link.
                    // Require the exact proven binding instead of inventing a link.
                    assert.equal(keyword, 'EM_RANDLES_MESHLESS');
                    assert.equal(descriptor.sourceKind, 'native-original-file-store');
                    assert.equal(descriptor.recordMode, 'exact-data-record-ordinal');
                    assert.deepEqual([descriptor.nativeMapAddress, descriptor.nativeCardArrayAddress, descriptor.nativeFieldAddress,
                        descriptor.nativeInputNamespace, descriptor.nativeOffsetKey],
                    ["record:0dc9b948cccc96167cba03df:a76f8609d46a440eab40f160", "record:19cb4c055da4d2118799c066:9b7d531e6ce08a24f3b2a44d", "record:19cb4c055da4d2118799c066:30678262cd021cb758fbc23d", 1274, 'idroff']);
                    assert.ok(descriptor.selectorEvidenceIds.includes("lspp-native-entity-store:record:32353cc72088f32d8efa0caa:2898fd89428eae58afdc073b:namespace1274:EM_RANDLES_MESHLESS"));
                } else assert.ok(Number.isInteger(descriptor.linkCode), keyword);
            } else {
                assert.match(descriptor.ruleId, /^rule:/);
                assert.ok(descriptor.evidenceIds.every(id => /^evidence:/.test(id)));
            }
        }
        assert.deepEqual(seenRepeatedInterfaces, repeatedInterfaces);
    });
});
