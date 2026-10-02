'use strict';

const assert = require('assert');
const fieldData = require("../../keywords/runtime/schema/field_data.json");
const crosswalk = require("../../keywords/runtime/categories/keyword_category_crosswalk.json");
const runtimeCatalog = require("../../keywords/runtime/categories/lspp_keyword_categories.runtime.json");
const { buildArtifacts } = require("../../scripts/build/generate-keyword-category-crosswalk.cjs");
const {
    getKeywordCategory,
    listKeywordCategories,
    resolveKeywordCategory,
} = require('../../src/core/keywordCategory');

describe("keyword catalog keyword categories", () => {
    it('classifies every built-in schema keyword with no silent fallback', () => {
        assert.equal(crosswalk.summary.schemaKeywordCount, Object.keys(fieldData).length);
        assert.equal(crosswalk.summary.confidenceCounts.fallback, 0);
        assert.equal(Object.keys(crosswalk.keywordToCategory).length, Object.keys(fieldData).length);
        for (const keyword of Object.keys(fieldData)) {
            const result = resolveKeywordCategory(keyword);
            assert.ok(result.primaryCategory, keyword);
            assert.notEqual(result.source, 'custom-keyword', keyword);
        }
    });

    it('keeps module-specific primary categories and alternate LS-PrePost registrations', () => {
        const blast = resolveKeywordCategory('DEFINE_PARTICLE_BLAST');
        assert.equal(blast.primaryCategory, 'PARTICLE');
        assert.ok(blast.aliases.includes('DEFINE'));

        assert.equal(resolveKeywordCategory('MAT_ELASTIC_TITLE').primaryCategory, 'MAT');
        assert.equal(resolveKeywordCategory('RIGID_DEFORMABLE_D2R').primaryCategory, 'DELETE');
    });

    it('classifies future family keywords conservatively and custom keywords as OTHER', () => {
        const future = resolveKeywordCategory('*MAT_FUTURE_TEAM_MODEL');
        assert.equal(future.primaryCategory, 'MAT');
        assert.equal(future.confidence, 'inferred');

        const custom = resolveKeywordCategory('*ACME_PRIVATE_CARD');
        assert.equal(custom.primaryCategory, 'OTHER');
        assert.equal(getKeywordCategory('*ACME_PRIVATE_CARD').synthetic, true);
    });

    it('preserves LS-PrePost display order and hides the empty EXCLUDE category by default', () => {
        const categories = listKeywordCategories();
        assert.equal(categories[0].name, 'AIRBAG');
        assert.equal(categories.at(-1).name, 'OTHER');
        assert.ok(!categories.some(category => category.name === 'EXCLUDE'));
        assert.ok(listKeywordCategories({ includeEmpty: true }).some(category => category.name === 'EXCLUDE'));
    });

    it('keeps generated provenance and category references structurally auditable', () => {
        assert.match(crosswalk.source.catalogSha256, /^[a-f0-9]{64}$/);
        assert.match(crosswalk.source.fieldDataSha256, /^[a-f0-9]{64}$/);
        assert.deepEqual(crosswalk.source, runtimeCatalog.source);
        const names = new Set(runtimeCatalog.categories.map(category => category.name));
        const displayIndexes = runtimeCatalog.categories.map(category => category.displayIndex);
        assert.equal(new Set(displayIndexes).size, displayIndexes.length);
        assert.deepEqual(displayIndexes, displayIndexes.slice().sort((left, right) => left - right));
        for (const [keyword, entry] of Object.entries(crosswalk.keywordToCategory)) {
            assert.ok(names.has(entry.primaryCategory), `${keyword}: ${entry.primaryCategory}`);
            for (const alias of entry.aliases) assert.ok(names.has(alias), `${keyword}: ${alias}`);
        }
    });

    it('keeps hyphenated and underscored source names distinct during generation', () => {
        const catalog = Buffer.from(JSON.stringify({
            source: { datasetVersion: 'test' },
            categories: [
                {
                    code: 'AA', name: 'AIRBAG', ordinal: 1, displayIndex: 0,
                    keywordRecordCount: 1, uniqueKeywordCount: 1,
                    keywords: [{ normalizedName: 'FOO-BAR', definitionFiles: ['FOO-BAR'] }],
                },
                {
                    code: 'DD', name: 'DEFINE', ordinal: 2, displayIndex: 1,
                    keywordRecordCount: 1, uniqueKeywordCount: 1,
                    keywords: [{ normalizedName: 'FOO_BAR', definitionFiles: ['FOO_BAR'] }],
                },
            ],
        }));
        const schema = Buffer.from(JSON.stringify({
            'FOO-BAR': { c: [] },
            FOO_BAR: { c: [] },
        }));
        const artifacts = buildArtifacts(catalog, schema);
        assert.equal(artifacts.crosswalk.keywordToCategory['FOO-BAR'].primaryCategory, 'AIRBAG');
        assert.equal(artifacts.crosswalk.keywordToCategory.FOO_BAR.primaryCategory, 'DEFINE');
    });
});
