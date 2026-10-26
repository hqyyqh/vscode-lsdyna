const assert = require('node:assert/strict');
const path = require('node:path');
require('../../support/helpers');
const { LsdynaIncludeTreeProvider } = require('../../../src/client/providers/includeTreeProvider');
describe('include tree layout preferences', () => {
    it('keeps structure, deduplicates flat files, sorts naturally and puts unknown sizes last', () => {
        const saved = new Map();
        const workspaceState = { get: k => saved.get(k), update: (k, v) => saved.set(k, v) };
        const provider = new LsdynaIncludeTreeProvider({ workspaceState });
        const node = (name, size) => ({ filePath: path.resolve(name), fileSizeVal: size, children: [], contextValue: 'file' });
        const root = node('root.k', undefined), two = node('sub/part2.k', 100), ten = node('sub/part10.k', 100);
        root.children = [ten, two, two]; provider.root = root;
        assert.deepEqual(provider.getChildren(root), [ten, two, two]);
        provider.setSortMode('flat-size');
        const flatSize = provider.getChildren();
        assert.deepEqual(flatSize.map(n => path.basename(n.filePath)), ['part2.k', 'part10.k', 'root.k']);
        assert.match(flatSize[0].description, /^sub • /);
        provider.setSortMode('flat-name');
        assert.deepEqual(provider.getChildren().map(n => path.basename(n.filePath)), ['part2.k', 'part10.k', 'root.k']);
        assert.equal(new LsdynaIncludeTreeProvider({ workspaceState }).sortMode, 'flat-name');
        provider.setSortMode('tree'); assert.equal(provider.getChildren()[0], root);
    });
});
