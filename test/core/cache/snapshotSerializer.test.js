'use strict';

const assert = require('assert');
const path = require('path');

const { ProjectGraph } = require('../../../src/core/project/projectGraph');

describe('snapshotSerializer', () => {
    it('round-trips project snapshots with graph and keywordMap hydration', () => {
        const { hydrateProjectSnapshot, serializeProjectSnapshot } = require('../../../src/core/cache/snapshotSerializer');
        const rootFile = path.resolve('project', 'main.k');
        const childFile = path.resolve('project', 'child.key');
        const graph = new ProjectGraph();
        graph.addIncludeEdge(rootFile, childFile);
        graph.addMissingFile({
            fromFile: rootFile,
            fileName: 'missing.key',
            filePath: path.resolve('project', 'missing.key'),
            candidatePaths: [path.resolve('project', 'missing.key'), path.resolve('search', 'missing.key')],
        });
        graph.addCycle({
            fromFile: childFile,
            toFile: rootFile,
            path: [rootFile, childFile, rootFile],
        });
        const snapshot = {
            rootFile,
            files: [rootFile, childFile],
            graph,
            keywordMap: new Map([
                ['KEYWORD', [{ keyword: 'KEYWORD', filePath: childFile, lineIndex: 1 }]],
            ]),
            fileIndexes: new Map([
                [childFile, {
                    filePath: childFile,
                    scannerVersion: 1,
                    keywordBlocks: [{ keyword: '*KEYWORD', startLine: 1, endLine: 1 }],
                    includeEntries: [],
                    searchPaths: [path.dirname(childFile)],
                    pathEntries: [],
                }],
            ]),
            missingFiles: graph.missingFiles,
            cycles: graph.cycles,
            stats: { scannedFileCount: 1, reusedFileCount: 1 },
        };

        const serialized = JSON.parse(JSON.stringify(serializeProjectSnapshot(snapshot)));
        const hydrated = hydrateProjectSnapshot(serialized);

        assert.ok(hydrated.keywordMap instanceof Map);
        assert.ok(hydrated.fileIndexes instanceof Map);
        assert.deepEqual(hydrated.keywordMap.get('KEYWORD'), snapshot.keywordMap.get('KEYWORD'));
        assert.deepEqual(hydrated.fileIndexes.get(childFile), snapshot.fileIndexes.get(childFile));
        assert.deepEqual(hydrated.graph.toTree(rootFile), {
            filePath: rootFile,
            children: [
                {
                    filePath: childFile,
                    children: [],
                },
                {
                    filePath: path.resolve('project', 'missing.key'),
                    fileName: 'missing.key',
                    missing: true,
                    children: [],
                },
            ],
        });
        assert.strictEqual(hydrated.missingFiles, hydrated.graph.missingFiles);
        assert.deepEqual(hydrated.missingFiles[0].candidatePaths, [
            path.resolve('project', 'missing.key'),
            path.resolve('search', 'missing.key'),
        ]);
        assert.strictEqual(hydrated.cycles, hydrated.graph.cycles);
    });
});
