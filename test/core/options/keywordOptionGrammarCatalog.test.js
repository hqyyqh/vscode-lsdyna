'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
    keywordOptionGrammarRuntimePath,
    loadKeywordOptionGrammarRuntime,
    lookupKeywordOptionGrammar,
    clearKeywordOptionGrammarRuntimeCacheForTesting,
} = require('../../../out/core/options/keywordOptionGrammarCatalog');

describe('official keyword option grammar catalog', () => {
    afterEach(() => clearKeywordOptionGrammarRuntimeCacheForTesting());

    it('packages the v2 concrete spelling inventory with per-target mutation permission', () => {
        const runtime = loadKeywordOptionGrammarRuntime();
        assert.ok(runtime);
        assert.equal(runtime.schemaVersion, 2);
        assert.equal(runtime.summary.optionTargets, 4475);
        assert.equal(runtime.summary.editableOptionTargets, 4475);
        assert.equal(runtime.permissions.optionDisplay, true);
        assert.equal(runtime.permissions.optionMutationByTarget, true);
        assert.equal(runtime.permissions.completenessClaim, false);
        assert.equal(fs.existsSync(keywordOptionGrammarRuntimePath()), true);
        assert.equal(fs.existsSync(require('node:path').join(keywordOptionGrammarRuntimePath(), 'manifest.json')), true);
    });

    it('keeps model-default targets editable without an evidence gate', () => {
        const spelling = '*BATTERY_DATABASE_HISTORY_NODELIST_ON_ELESET';
        const grammar = lookupKeywordOptionGrammar(spelling);
        const target = grammar.targets.find(item => item.spelling === spelling);

        assert.equal(target.writePermission, true);
        assert.equal(target.disposition, 'editable');
        assert.equal(target.writeBlocker, null);
    });

    it('does not reinterpret title-token options as optional post-card layouts', () => {
        const grammar = lookupKeywordOptionGrammar('*PARAMETER_EXPRESSION');
        const target = grammar.targets.find(item => item.spelling === '*PARAMETER_EXPRESSION');

        assert.equal(target.writePermission, true);
        assert.equal(target.writeBlocker, null);
        assert.deepEqual(target.layouts.map(candidate => candidate.postCount), [0]);
        assert.deepEqual(target.layouts.map(candidate => candidate.layout.records.length), [1]);
    });

    it('uses layout migration where complete and spelling-only preservation otherwise', () => {
        const runtime = loadKeywordOptionGrammarRuntime();
        const targets = runtime.grammars.flatMap(grammar => grammar.targets);
        const writable = targets.filter(target => target.writePermission === true);
        const keywordOnly = targets.filter(target =>
            target.applicationMode === 'keyword-only-preserve-block');

        assert.equal(writable.length, 4475);
        assert.equal(targets.length - writable.length, 0);
        assert.equal(keywordOnly.length, 73);
        assert.ok(keywordOnly.every(target => target.writePermission === true));
        for (const target of writable.filter(item => item.applicationMode === 'layout-migration')) {
            assert.ok(target.layouts.length > 0, target.spelling);
            for (const candidate of target.layouts) {
                assert.ok(candidate.layout.sourceIdentity?.canonicalKeyword ||
                    candidate.layout.sourceIdentity?.canonicalSectionId, target.spelling);
                const fields = candidate.layout.records.flatMap(record => record.fields);
                const boundTargets = new Set(candidate.bindings.map(binding =>
                    binding.targetFieldMigrationId));
                assert.ok(fields.every(field => boundTargets.has(field.fieldMigrationId)),
                    target.spelling);
            }
        }
    });

    it('closes every writable layout-state pair by canonical identity', () => {
        const runtime = loadKeywordOptionGrammarRuntime();
        let states = 0;
        let editableEdges = 0;
        let blockedCrossCanonicalEdges = 0;
        for (const grammar of runtime.grammars) {
            const writableStates = grammar.targets
                .filter(target => target.writePermission === true)
                .flatMap(target => target.layouts.map(candidate => ({
                    stateId: `${target.targetId}:${candidate.postCount}`,
                    canonicalIdentity: candidate.layout.sourceIdentity.canonicalKeyword ||
                        candidate.layout.sourceIdentity.canonicalSectionId,
                })));
            states += writableStates.length;
            for (const source of writableStates) for (const target of writableStates) {
                if (source.stateId === target.stateId) continue;
                if (source.canonicalIdentity && source.canonicalIdentity === target.canonicalIdentity) editableEdges++;
                else blockedCrossCanonicalEdges++;
            }
        }

        assert.equal(states, 4535);
        assert.equal(editableEdges, 130090);
        assert.equal(blockedCrossCanonicalEdges, 77730);
        assert.equal(runtime.summary.optionMutationStates, states);
        assert.equal(runtime.summary.editableOptionMutationEdges, editableEdges);
        assert.equal(runtime.summary.blockedCrossCanonicalOptionMutationEdges,
            blockedCrossCanonicalEdges);
    });

    it('publishes database-backed heading dimensions without inventing spellings', () => {
        const runtime = loadKeywordOptionGrammarRuntime();
        const headingGrammars = runtime.grammars.filter(grammar =>
            grammar.dimensions?.some(dimension => dimension.dimensionId === 'heading'));
        const headingTargets = runtime.grammars.flatMap(grammar => grammar.targets)
            .filter(target => /(?:^|_)(TITLE|HEADING)(?:_|$)/.test(target.spelling));

        assert.equal(headingGrammars.length, 387);
        assert.equal(headingTargets.length, 963);
        for (const grammar of headingGrammars) {
            const spellings = new Set(grammar.targets.map(target => target.spelling));
            assert.ok(grammar.targets.every(target => spellings.has(target.spelling)));
        }
    });

    it('uses exact official spellings and never a prefix guess', () => {
        const mat = lookupKeywordOptionGrammar('*MAT_024');
        assert.ok(mat);
        assert.ok(mat.targets.some(target => target.spelling === '*MAT_024'));
        assert.ok(mat.targets.some(target => target.spelling === '*MAT_024_TITLE'));
        assert.equal(lookupKeywordOptionGrammar('*MAT_024_NOT_AN_OFFICIAL_OPTION'), null);
    });
});
