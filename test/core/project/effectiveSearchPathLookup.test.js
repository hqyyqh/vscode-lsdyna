'use strict';

const assert = require('assert');
const path = require('path');
const {
    getEffectiveSearchPathsFromSnapshot,
    lookupEffectiveSearchPaths,
    createEffectiveSearchPathCache,
    pathCardsChanged,
    normalizeSearchPathFileKey,
} = require('../../../src/core/project/effectiveSearchPathLookup');

describe('effectiveSearchPathLookup', () => {
    const rootFile = path.resolve('/job/main.k');
    const bodyFile = path.resolve('/job/body.k');
    const matsDir = path.resolve('/job/mats');

    it('getEffectiveSearchPathsFromSnapshot returns paths by file key', () => {
        const snapshot = {
            rootFile,
            effectiveSearchPathsByFile: new Map([
                [bodyFile, [path.dirname(bodyFile), matsDir]],
            ]),
        };
        const found = getEffectiveSearchPathsFromSnapshot(bodyFile, snapshot);
        assert.deepStrictEqual(found, [path.dirname(bodyFile), matsDir]);
        assert.equal(getEffectiveSearchPathsFromSnapshot(path.resolve('/other/x.k'), snapshot), null);
    });

    it('lookupEffectiveSearchPaths refuses conflicting roots for a shared file', () => {
        const matsA = path.resolve('/jobA/mats');
        const matsB = path.resolve('/jobB/mats');
        const shared = path.resolve('/shared/body.k');
        const snapA = {
            rootFile: path.resolve('/jobA/main.k'),
            effectiveSearchPathsByFile: new Map([[shared, [matsA]]]),
        };
        const snapB = {
            rootFile: path.resolve('/jobB/main.k'),
            effectiveSearchPathsByFile: new Map([[shared, [matsB]]]),
        };
        assert.equal(lookupEffectiveSearchPaths(shared, [snapA, snapB]), null);
        assert.equal(lookupEffectiveSearchPaths(shared, [snapB, snapA]), null);
        assert.deepStrictEqual(lookupEffectiveSearchPaths(shared, [snapA]), [matsA]);
    });

    it('createEffectiveSearchPathCache does not choose a root by cache order', () => {
        const cache = createEffectiveSearchPathCache();
        const shared = path.resolve('/shared/body.k');
        const matsA = path.resolve('/jobA/mats');
        const matsB = path.resolve('/jobB/mats');

        cache.cacheFromSnapshot({
            rootFile: path.resolve('/jobA/main.k'),
            effectiveSearchPathsByFile: new Map([[shared, [matsA]]]),
        });
        cache.cacheFromSnapshot({
            rootFile: path.resolve('/jobB/main.k'),
            effectiveSearchPathsByFile: new Map([[shared, [matsB]]]),
        });

        assert.equal(cache.lookup(shared), null);

        cache.clearRoot(path.resolve('/jobB/main.k'));
        assert.deepStrictEqual(cache.lookup(shared), [matsA]);

        cache.clearAll();
        assert.equal(cache.lookup(shared), null);
    });

    it('reuses identical effective paths shared by multiple roots', () => {
        const cache = createEffectiveSearchPathCache();
        const shared = path.resolve('/shared/body.k');
        const common = [path.resolve('/shared'), path.resolve('/common/mats')];
        cache.cacheFromSnapshot({
            rootFile: path.resolve('/jobA/main.k'),
            effectiveSearchPathsByFile: new Map([[shared, common]]),
        });
        cache.cacheFromSnapshot({
            rootFile: path.resolve('/jobB/main.k'),
            effectiveSearchPathsByFile: new Map([[shared, [...common]]]),
        });

        assert.deepStrictEqual(cache.lookup(shared), common);
    });

    it('uses an explicitly requested root for conflicting shared paths', () => {
        const cache = createEffectiveSearchPathCache();
        const shared = path.resolve('/shared/body.k');
        const rootA = path.resolve('/jobA/main.k');
        const rootB = path.resolve('/jobB/main.k');
        const matsA = [path.resolve('/jobA/mats')];
        const matsB = [path.resolve('/jobB/mats')];
        cache.cacheFromSnapshot({
            rootFile: rootA,
            effectiveSearchPathsByFile: new Map([[shared, matsA]]),
        });
        cache.cacheFromSnapshot({
            rootFile: rootB,
            effectiveSearchPathsByFile: new Map([[shared, matsB]]),
        });

        assert.deepStrictEqual(cache.lookupForRoot(shared, rootA), matsA);
        assert.deepStrictEqual(cache.lookupForRoot(shared, rootB), matsB);
        assert.equal(cache.lookup(shared), null);
    });

    it('normalizeSearchPathFileKey is stable', () => {
        const a = normalizeSearchPathFileKey(bodyFile);
        const b = normalizeSearchPathFileKey(bodyFile);
        assert.equal(a, b);
        assert.ok(a);
    });

    it('pathCardsChanged detects PATH card edits', () => {
        assert.equal(
            pathCardsChanged(
                [{ searchPath: matsDir }],
                [{ searchPath: matsDir }]
            ),
            false
        );
        assert.equal(
            pathCardsChanged(
                [{ searchPath: matsDir }],
                [{ searchPath: path.resolve('/job/mats_v2') }]
            ),
            true
        );
        assert.equal(pathCardsChanged([], [{ searchPath: matsDir }]), true);
        assert.equal(pathCardsChanged(null, null), false);
    });
});
