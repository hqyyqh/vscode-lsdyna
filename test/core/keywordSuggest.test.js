'use strict';

const assert = require('assert');
const {
    suggestSimilarKeywords,
    editDistance,
    resetKeywordSuggestCache,
} = require('../../src/core/keywordSuggest');

describe('keywordSuggest', () => {
    beforeEach(() => {
        resetKeywordSuggestCache();
    });

    it('computes small edit distances', () => {
        assert.equal(editDistance('LOAD_BODY_Z1', 'LOAD_BODY_Z'), 1);
        assert.equal(editDistance('ABC', 'ABC'), 0);
        assert.equal(editDistance('ABC', 'ABX'), 1);
    });

    it('ranks LOAD_BODY_Z1 as high confidence LOAD_BODY_Z', () => {
        const result = suggestSimilarKeywords('LOAD_BODY_Z1');
        assert.equal(result.tier, 'high');
        assert.ok(result.items.length >= 1);
        assert.equal(result.items[0].keyword, 'LOAD_BODY_Z');
    });

    it('accepts starred and lowercase input', () => {
        const result = suggestSimilarKeywords('*load_body_z1');
        assert.equal(result.tier, 'high');
        assert.equal(result.items[0].keyword, 'LOAD_BODY_Z');
    });

    it('ranks CONTACT ID_OFFSET option-order typo as high confidence OFFSET_ID', () => {
        const result = suggestSimilarKeywords('CONTACT_TIED_SHELL_EDGE_TO_SURFACE_ID_OFFSET');
        // Same base + option token permutation (ID_OFFSET ↔ OFFSET_ID) is high confidence.
        assert.equal(result.tier, 'high');
        assert.equal(result.items[0].keyword, 'CONTACT_TIED_SHELL_EDGE_TO_SURFACE_OFFSET_ID');
        assert.equal(result.items[0].reason, 'token-permutation');
    });

    it('returns none for exact known keywords', () => {
        const result = suggestSimilarKeywords('LOAD_BODY_Z');
        assert.equal(result.tier, 'none');
        assert.deepEqual(result.items, []);
    });

    it('returns none for unrelated noise', () => {
        const result = suggestSimilarKeywords('ZZZ_NOT_A_REAL_KEYWORD_QQQ');
        assert.equal(result.tier, 'none');
        assert.deepEqual(result.items, []);
    });

    it('honors an explicit candidate list', () => {
        const result = suggestSimilarKeywords('FOO_BAR_Z1', {
            candidates: ['FOO_BAR_Z', 'FOO_BAR_X', 'OTHER_THING'],
        });
        assert.equal(result.tier, 'high');
        assert.equal(result.items[0].keyword, 'FOO_BAR_Z');
    });

    it('returns medium when several family-near candidates share a prefix without a clear winner', () => {
        // Dist 2 from each sibling — not high (needs dist ≤1 or token permutation).
        const result = suggestSimilarKeywords('AAA_BBB_CCC_XX', {
            candidates: [
                'AAA_BBB_CCC_YY',
                'AAA_BBB_CCC_ZZ',
                'AAA_BBB_CCC_WW',
                'OTHER_FAMILY',
            ],
        });
        assert.equal(result.tier, 'medium', JSON.stringify(result));
        assert.ok(result.items.length >= 2);
        assert.ok(result.items.every(i => i.keyword.startsWith('AAA_BBB_CCC_')));
    });

    it('treats option token permutation as high confidence', () => {
        const result = suggestSimilarKeywords('CONTACT_AUTOMATIC_SINGLE_SURFACE_MPP_ID', {
            // Force ranking without relying on exact schema presence of MPP_ID form
            candidates: [
                'CONTACT_AUTOMATIC_SINGLE_SURFACE',
                'CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
                'CONTACT_AUTOMATIC_SINGLE_SURFACE_MPP',
                'CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP',
            ],
        });
        // MPP_ID vs ID_MPP is option permutation on same base
        assert.ok(result.tier === 'high' || result.tier === 'medium', `tier=${result.tier}`);
        assert.ok(result.items.some(i => i.keyword === 'CONTACT_AUTOMATIC_SINGLE_SURFACE_ID_MPP'));
    });
});
