'use strict';

const assert = require('assert');
const {
    keywordSkeleton,
    keywordTokens,
    scoreKeywordName,
    scorePathText,
    scorePathFields,
    scoreFuzzyText,
    highlightFuzzyLabel,
    builtinFilterLikelyMatches,
} = require('../../../src/core/search/lsdynaTextMatch');

describe('lsdynaTextMatch', () => {
    describe('keywordSkeleton / keywordTokens', () => {
        it('strips star and separators into a continuous skeleton', () => {
            assert.equal(keywordSkeleton('control time'), 'CONTROLTIME');
            assert.equal(keywordSkeleton('*CONTROL_TIMESTEP'), 'CONTROLTIMESTEP');
            assert.equal(keywordSkeleton('parts_shell.k'), 'PARTSSHELLK');
        });

        it('splits tokens on LS-DYNA separators', () => {
            assert.deepEqual(keywordTokens('control time'), ['CONTROL', 'TIME']);
            assert.deepEqual(keywordTokens('*CONTROL_TIMESTEP'), ['CONTROL', 'TIMESTEP']);
        });
    });

    describe('scoreFuzzyText / thorough character fuzzy', () => {
        it('matches ordered character subsequence and segment tokens', () => {
            assert.ok(scoreFuzzyText('rgv', 'rogue-v3.key') > 0);
            assert.ok(scoreFuzzyText('rov3', 'rogue-v3.key') > 0);
            assert.ok(scoreFuzzyText('ro v3', 'rogue-v3.key') > 0);
            assert.ok(scoreFuzzyText('ro v3', 'roguev3.key') > 0);
        });

        it('matches con en against CONTROL_ENERGY via token prefixes', () => {
            assert.ok(scoreKeywordName('con en', 'CONTROL_ENERGY') > 0);
            assert.ok(scoreKeywordName('con en', '*CONTROL_ENERGY') > 0);
            assert.ok(scoreKeywordName('conen', 'CONTROL_ENERGY') > 0);
            assert.ok(scoreKeywordName('ctl en', '*CONTROL_ENERGY') > 0);
        });

        it('returns 0 when characters cannot form a subsequence', () => {
            assert.equal(scoreFuzzyText('shell', 'NODE'), 0);
            assert.equal(scoreFuzzyText('zzz', 'rogue-v3.key'), 0);
        });

        it('ranks tighter hits above sparse subsequence', () => {
            assert.ok(scoreFuzzyText('rogue', 'rogue-v3.key') > scoreFuzzyText('rgv', 'rogue-v3.key'));
            assert.ok(scoreKeywordName('mat', 'MAT_001') > scoreKeywordName('mat', 'X_MAT_Y'));
        });
    });

    describe('scoreKeywordName', () => {
        it('matches spaces to underscores (control time → CONTROL_TIMESTEP)', () => {
            assert.ok(scoreKeywordName('control time', '*CONTROL_TIMESTEP') > 0);
            assert.ok(scoreKeywordName('control_time', 'CONTROL_TIMESTEP') > 0);
            assert.ok(scoreKeywordName('CONTROL TIME', '*CONTROL_TIMESTEP') > 0);
        });

        it('prefers prefix-like ranks over weak contains', () => {
            assert.ok(scoreKeywordName('mat', 'MAT_001') > scoreKeywordName('mat', 'X_MAT_Y'));
        });

        it('returns 0 for unrelated queries', () => {
            assert.equal(scoreKeywordName('shell', 'NODE'), 0);
        });

        it('treats empty query as match-all', () => {
            assert.ok(scoreKeywordName('', 'anything') > 0);
        });

        it('ranks CONTROL_TIMESTEP above CONTROL_ONLY for control time', () => {
            const timestep = scoreKeywordName('control time', '*CONTROL_TIMESTEP');
            const only = scoreKeywordName('control time', '*CONTROL_ONLY');
            assert.ok(timestep > 0);
            assert.ok(timestep >= only);
        });
    });

    describe('scorePathFields (basename / label only)', () => {
        it('matches label basename only', () => {
            assert.ok(scorePathFields('parts', {
                label: 'parts.k', description: 'sub', filePath: '/p/sub/parts.k',
            }) > 0);
        });

        it('does not match via description or absolute path', () => {
            assert.equal(scorePathFields('sub', {
                label: 'parts.k', description: 'sub', filePath: '/p/sub/parts.k',
            }), 0);
            assert.equal(scorePathFields('ro', {
                label: 'main.k',
                description: 'Project/models',
                filePath: 'D:\\Project\\models\\main.k',
            }), 0);
            assert.ok(scorePathFields('ro', {
                label: 'rogue-v3.key',
                description: '',
                filePath: 'D:\\Project\\rogue-v3.key',
            }) > 0);
        });

        it('matches separator-insensitive and fuzzy file names on label', () => {
            assert.ok(scorePathFields('parts shell', {
                label: 'parts_shell.k',
                description: 'mesh',
                filePath: '/x/mesh/parts_shell.k',
            }) > 0);
            assert.ok(scorePathText('ro v3', 'rogue-v3.key') > 0);
            assert.ok(scorePathText('control time', 'control_timestep.k') > 0);
        });
    });

    describe('highlightFuzzyLabel', () => {
        it('underlines matched characters for multi-token queries', () => {
            const out = highlightFuzzyLabel('CONTROL_ENERGY', 'con en');
            assert.ok(out.includes('\u0332'));
            // Still starts with C (before combining mark)
            assert.ok(out.startsWith('C'));
            assert.ok(out.includes('E'));
        });

        it('underlines matches on file basenames', () => {
            const out = highlightFuzzyLabel('rogue-v3.key', 'ro v3');
            assert.ok(out.includes('\u0332'));
        });
    });

    describe('builtinFilterLikelyMatches (native QuickPick paint path)', () => {
        it('allows native path for single-token queries VS Code can highlight', () => {
            assert.ok(builtinFilterLikelyMatches('con', 'CONTROL_ENERGY'));
            assert.ok(builtinFilterLikelyMatches('conen', 'CONTROL_ENERGY'));
            assert.ok(builtinFilterLikelyMatches('rgv', 'rogue-v3.key'));
        });

        it('forces non-native path for any whitespace query (VS Code re-hides multi-word)', () => {
            assert.ok(!builtinFilterLikelyMatches('con en', 'CONTROL_ENERGY'));
            assert.ok(!builtinFilterLikelyMatches('ro v3', 'rogue-v3.key'));
            assert.ok(!builtinFilterLikelyMatches('ctl en', 'CONTROL_ENERGY'));
            assert.ok(!builtinFilterLikelyMatches('parts shell', 'parts_shell.k'));
        });

        it('rejects queries that cannot map onto the label', () => {
            assert.ok(!builtinFilterLikelyMatches('zzz', 'rogue-v3.key'));
            assert.ok(!builtinFilterLikelyMatches('shell', 'NODE'));
        });
    });
});
