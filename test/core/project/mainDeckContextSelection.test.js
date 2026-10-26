'use strict';

const assert = require('assert');
const path = require('path');
const {
    createMainDeckContextSelector,
} = require('../../../src/core/project/mainDeckContextSelection');

describe('mainDeckContextSelection', () => {
    const shared = path.resolve('cases', 'shared.k');
    const rootA = path.resolve('cases', 'condition-a.k');
    const rootB = path.resolve('cases', 'condition-b.k');
    const projectA = { rootFile: rootA };
    const projectB = { rootFile: rootB };

    it('keeps an exact root authoritative', () => {
        const selector = createMainDeckContextSelector();
        assert.equal(selector.select(shared, rootB, [projectA, projectB]), true);

        const context = selector.resolve(rootA, {
            exactProject: projectA,
            containingProjects: [projectA, projectB],
        });

        assert.equal(context.state, 'exact');
        assert.equal(context.rootFile, rootA);
        assert.strictEqual(context.project, projectA);
    });

    it('stays ambiguous until the user selects and can switch roots', () => {
        const selector = createMainDeckContextSelector();
        const initial = selector.resolve(shared, {
            containingProjects: [projectB, projectA],
        });
        assert.equal(initial.state, 'ambiguous');
        assert.deepEqual(initial.candidates.map(project => project.rootFile), [rootA, rootB]);

        assert.equal(selector.select(shared, rootA, [projectB, projectA]), true);
        assert.equal(selector.resolve(shared, {
            containingProjects: [projectB, projectA],
        }).rootFile, rootA);

        assert.equal(selector.select(shared, rootB, [projectA, projectB]), true);
        assert.equal(selector.resolve(shared, {
            containingProjects: [projectA, projectB],
        }).rootFile, rootB);

        assert.equal(selector.clearDocument(shared), true);
        assert.equal(selector.resolve(shared, {
            containingProjects: [projectA, projectB],
        }).state, 'ambiguous');
    });

    it('rejects unknown roots and does not pin a unique project', () => {
        const selector = createMainDeckContextSelector();
        assert.equal(selector.select(shared, path.resolve('cases', 'other.k'), [projectA, projectB]), false);
        assert.equal(selector.select(shared, rootA, [projectA]), false);
        assert.equal(selector.resolve(shared, {
            containingProjects: [projectA],
        }).state, 'unique');
    });

    it('clears selections when their root is invalidated or disappears', () => {
        const selector = createMainDeckContextSelector();
        selector.select(shared, rootA, [projectA, projectB]);
        assert.equal(selector.clearRoot(rootA), 1);
        assert.equal(selector.resolve(shared, {
            containingProjects: [projectA, projectB],
        }).state, 'ambiguous');

        selector.select(shared, rootA, [projectA, projectB]);
        const reduced = selector.resolve(shared, {
            containingProjects: [projectB],
        });
        assert.equal(reduced.state, 'unique');
        assert.equal(reduced.rootFile, rootB);
    });
});
