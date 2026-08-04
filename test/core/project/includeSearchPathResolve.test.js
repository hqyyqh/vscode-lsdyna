'use strict';

const assert = require('assert');
const path = require('path');
const {
    uniqueSearchPaths,
    localDeclaredSearchPaths,
    mergeEffectiveSearchPaths,
    inheritedPathsForChild,
    effectiveSearchPathsFromScan,
} = require('../../../src/core/project/includeSearchPathResolve');

describe('includeSearchPathResolve', () => {
    it('uniqueSearchPaths keeps first order and drops dupes', () => {
        const a = path.normalize('/model/mats');
        const b = path.normalize('/model/load');
        const list = uniqueSearchPaths([a, b, a, b]);
        assert.deepStrictEqual(list, [a, b]);
    });

    it('localDeclaredSearchPaths drops fileDir seed from searchPaths', () => {
        const fileDir = path.normalize('/deck');
        const mats = path.normalize('/deck/mats');
        const local = localDeclaredSearchPaths({
            fileDir,
            searchPaths: [fileDir, mats],
        });
        assert.deepStrictEqual(local, [mats]);
    });

    it('localDeclaredSearchPaths prefers pathEntries', () => {
        const fileDir = path.normalize('/deck');
        const mats = path.normalize('/deck/mats');
        const local = localDeclaredSearchPaths({
            fileDir,
            searchPaths: [fileDir, path.normalize('/other')],
            pathEntries: [{ searchPath: mats }],
        });
        assert.deepStrictEqual(local, [mats]);
    });

    it('mergeEffectiveSearchPaths: dir, local cards, then inherited', () => {
        const fileDir = path.normalize('/body');
        const local = path.normalize('/body/extra');
        const fromParent = path.normalize('/main/mats');
        const effective = mergeEffectiveSearchPaths({
            fileDir,
            localDeclaredPaths: [local],
            inheritedPaths: [fromParent],
        });
        assert.deepStrictEqual(effective, [fileDir, local, fromParent]);
    });

    it('inheritedPathsForChild prepends local PATH cards (nearest first)', () => {
        const near = path.normalize('/setup/paths');
        const far = path.normalize('/main/mats');
        const childInh = inheritedPathsForChild({
            localDeclaredPaths: [near],
            inheritedPaths: [far],
        });
        assert.deepStrictEqual(childInh, [near, far]);
    });

    it('effectiveSearchPathsFromScan wires scanner shape', () => {
        const filePath = path.normalize('/job/body.k');
        const fileDir = path.dirname(filePath);
        const mats = path.normalize('/job/mats');
        const effective = effectiveSearchPathsFromScan({
            filePath,
            searchPaths: [fileDir],
            inheritedPaths: [mats],
        });
        assert.deepStrictEqual(effective, [fileDir, mats]);
    });
});
