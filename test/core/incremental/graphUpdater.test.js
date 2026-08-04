'use strict';

const assert = require('assert');
const path = require('path');

const { ProjectGraph } = require('../../../src/core/project/projectGraph');
const { createGraphUpdater } = require('../../../src/core/incremental/graphUpdater');

describe('createGraphUpdater', () => {
    function createSnapshot(rootFile, files, graph, keywordMap) {
        return {
            rootFile,
            files: [...files],
            graph,
            keywordMap: keywordMap || new Map(),
            missingFiles: graph.missingFiles,
            cycles: graph.cycles,
        };
    }

    it('updates keywords when a tracked file changes', async () => {
        const rootFile = path.resolve('/project/main.k');
        const childFile = path.resolve('/project/child.k');

        const graph = new ProjectGraph();
        graph.addIncludeEdge(rootFile, childFile);

        const keywordMap = new Map();
        keywordMap.set('PART', [{ keyword: 'PART', filePath: childFile, lineIndex: 0 }]);
        keywordMap.set('INCLUDE', [{ keyword: 'INCLUDE', filePath: rootFile, lineIndex: 0 }]);

        const snapshot = createSnapshot(rootFile, [rootFile, childFile], graph, keywordMap);

        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async () => ({
                includeEntries: [],
                searchPaths: [path.resolve('/project')],
            }),
            collectKeywordsFromFile: async (filePath) => {
                if (filePath === childFile) {
                    return [{ keyword: 'MAT_ELASTIC', filePath: childFile, lineIndex: 0 }];
                }
                return [];
            },
        });

        const result = await updater.updateFile(childFile, snapshot);

        assert.equal(result.changed, true);
        assert.equal(result.keywordsChanged, true);
        assert.equal(keywordMap.has('PART'), false);
        assert.deepEqual(keywordMap.get('MAT_ELASTIC'), [{ keyword: 'MAT_ELASTIC', filePath: childFile, lineIndex: 0 }]);
        // Root file keywords unaffected
        assert.deepEqual(keywordMap.get('INCLUDE'), [{ keyword: 'INCLUDE', filePath: rootFile, lineIndex: 0 }]);
    });

    it('detects and patches include changes', async () => {
        const rootFile = path.resolve('/project/main.k');
        const childA = path.resolve('/project/a.k');
        const childB = path.resolve('/project/b.k');

        const graph = new ProjectGraph();
        graph.addIncludeEdge(rootFile, childA);

        const keywordMap = new Map();
        const snapshot = createSnapshot(rootFile, [rootFile, childA], graph, keywordMap);

        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async () => ({
                includeEntries: [{ fileName: 'b.k', lineIndex: 1, startChar: 0, endChar: 3 }],
                searchPaths: [path.resolve('/project')],
            }),
            collectKeywordsFromFile: async () => [],
            resolveInclude: async (fileName, searchPaths) => {
                if (fileName === 'b.k') return childB;
                return null;
            },
        });

        const result = await updater.updateFile(rootFile, snapshot);

        assert.equal(result.includesChanged, true);
        assert.deepEqual(result.addedFiles, [childB]);
        assert.deepEqual(graph.getChildren(rootFile), [childB]);
    });

    it('returns no changes for untracked files', async () => {
        const rootFile = path.resolve('/project/main.k');
        const graph = new ProjectGraph();
        graph.addFile(rootFile);

        const snapshot = createSnapshot(rootFile, [rootFile], graph, new Map());

        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async () => ({ includeEntries: [], searchPaths: [] }),
            collectKeywordsFromFile: async () => [],
        });

        const result = await updater.updateFile('/project/untracked.k', snapshot);
        assert.equal(result.changed, false);
    });

    it('removes a file from the graph correctly', () => {
        const rootFile = path.resolve('/project/main.k');
        const childFile = path.resolve('/project/child.k');

        const graph = new ProjectGraph();
        graph.addIncludeEdge(rootFile, childFile);

        const keywordMap = new Map();
        keywordMap.set('PART', [{ keyword: 'PART', filePath: childFile, lineIndex: 0 }]);

        const snapshot = createSnapshot(rootFile, [rootFile, childFile], graph, keywordMap);

        const updater = createGraphUpdater();
        const result = updater.removeFile(childFile, snapshot);

        assert.equal(result.changed, true);
        assert.deepEqual(result.removedFiles, [childFile]);
        assert.equal(snapshot.files.length, 1);
        assert.equal(snapshot.files[0], rootFile);
        assert.equal(keywordMap.has('PART'), false);
    });

    it('handles include list unchanged (no structural change)', async () => {
        const rootFile = path.resolve('/project/main.k');
        const childFile = path.resolve('/project/child.k');

        const graph = new ProjectGraph();
        graph.addIncludeEdge(rootFile, childFile);

        const keywordMap = new Map();
        keywordMap.set('PART', [{ keyword: 'PART', filePath: rootFile, lineIndex: 0 }]);

        const snapshot = createSnapshot(rootFile, [rootFile, childFile], graph, keywordMap);

        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async () => ({
                includeEntries: [{ fileName: 'child.k', lineIndex: 1, startChar: 0, endChar: 7 }],
                searchPaths: [path.resolve('/project')],
            }),
            collectKeywordsFromFile: async () => [{ keyword: 'PART', filePath: rootFile, lineIndex: 0 }],
            resolveInclude: async (fileName) => {
                if (fileName === 'child.k') return childFile;
                return null;
            },
        });

        const result = await updater.updateFile(rootFile, snapshot);

        // Keywords same, includes same → no structural change
        assert.equal(result.includesChanged, false);
        assert.equal(result.requiresFullRebuild, false);
    });

    it('resolves child short names via snapshot effectiveSearchPathsByFile', async () => {
        const rootFile = path.resolve('/project/main.k');
        const bodyFile = path.resolve('/project/body.k');
        const steelFile = path.resolve('/project/mats/steel.k');
        const matsDir = path.resolve('/project/mats');

        const graph = new ProjectGraph();
        graph.addIncludeEdge(rootFile, bodyFile);

        const snapshot = createSnapshot(rootFile, [rootFile, bodyFile], graph, new Map());
        snapshot.effectiveSearchPathsByFile = new Map([
            [bodyFile, [path.dirname(bodyFile), matsDir]],
        ]);
        snapshot.fileIndexes = new Map([
            [bodyFile, { pathEntries: [] }],
        ]);

        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async () => ({
                includeEntries: [{ fileName: 'steel.k', lineIndex: 1, startChar: 0, endChar: 7 }],
                searchPaths: [path.dirname(bodyFile)], // local only — steel not here
                pathEntries: [],
            }),
            collectKeywordsFromFile: async () => [],
            resolveInclude: async (fileName, searchPaths) => {
                for (const sp of searchPaths) {
                    if (path.resolve(sp, fileName) === steelFile) return steelFile;
                }
                return null;
            },
        });

        const result = await updater.updateFile(bodyFile, snapshot);
        assert.equal(result.requiresFullRebuild, false);
        assert.equal(result.includesChanged, true);
        assert.deepEqual(graph.getChildren(bodyFile), [steelFile]);
        assert.ok(snapshot.files.some(f => path.resolve(f) === steelFile));
    });

    it('flags requiresFullRebuild when *INCLUDE_PATH cards change', async () => {
        const rootFile = path.resolve('/project/main.k');
        const matsDir = path.resolve('/project/mats');
        const matsV2 = path.resolve('/project/mats_v2');

        const graph = new ProjectGraph();
        graph.addFile(rootFile);

        const snapshot = createSnapshot(rootFile, [rootFile], graph, new Map());
        snapshot.fileIndexes = new Map([
            [rootFile, { pathEntries: [{ searchPath: matsDir }] }],
        ]);
        snapshot.effectiveSearchPathsByFile = new Map([
            [rootFile, [path.dirname(rootFile), matsDir]],
        ]);

        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async () => ({
                includeEntries: [],
                searchPaths: [path.dirname(rootFile), matsV2],
                pathEntries: [{ searchPath: matsV2 }],
            }),
            collectKeywordsFromFile: async () => [],
        });

        const result = await updater.updateFile(rootFile, snapshot);
        assert.equal(result.requiresFullRebuild, true);
        assert.equal(result.changed, true);
    });
});
