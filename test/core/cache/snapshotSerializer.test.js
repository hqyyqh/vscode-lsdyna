'use strict';

const assert = require('assert');
const path = require('path');

const { ProjectGraph } = require('../../../src/core/project/projectGraph');
const { SCANNER_VERSION } = require('../../../src/core/scanner/scannerContracts');

describe('snapshotSerializer', () => {
    it('round-trips project snapshots with graph and keywordMap hydration', () => {
        const { hydrateProjectSnapshot, serializeProjectSnapshot } = require('../../../src/core/cache/snapshotSerializer');
        const rootFile = path.resolve('project', 'main.k');
        const childFile = path.resolve('project', 'child.key');
        const graph = new ProjectGraph();
        graph.addIncludeEdge(rootFile, childFile, {
            filePath: childFile,
            fileName: 'child.key',
            lineIndex: 4,
            startChar: 0,
            endChar: 9,
            keyword: '*INCLUDE_TRANSFORM',
            keywordLine: 3,
            transform: {
                keyword: '*INCLUDE_TRANSFORM',
                keywordLine: 3,
                offsets: {
                    idfoff: { kind: 'numeric', raw: '0', value: 0 },
                },
                tranid: { kind: 'numeric', raw: '9', value: 9 },
                rawCards: [{ cardNumber: 2, lineIndex: 5, raw: '0 0 0 0 0 0 0' }],
                parseCompleteness: { state: 'complete', reasons: [] },
            },
        });
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
                    scannerVersion: SCANNER_VERSION,
                    referenceDefinitions: {
                        curves: [{ kind: 'curve', id: 1001, filePath: childFile, keyword: '*DEFINE_CURVE', startLine: 2, endLine: 4, points: [] }],
                        tables: [],
                    },
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
        assert.equal(hydrated.fileIndexes.get(childFile).referenceDefinitions.curves[0].id, 1001);
        assert.equal(hydrated.graph.includeOccurrences.length, 2);
        assert.equal(hydrated.graph.includeOccurrences[0].lineIndex, 4);
        assert.equal(hydrated.graph.includeOccurrences[0].transform.offsets.idfoff.value, 0);
        assert.equal(hydrated.graph.includeOccurrences[0].transform.rawCards[0].raw, '0 0 0 0 0 0 0');
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

    it('round-trips effectiveSearchPathsByFile Map (ancestor PATH inheritance cache)', () => {
        const { hydrateProjectSnapshot, serializeProjectSnapshot } = require('../../../src/core/cache/snapshotSerializer');
        const rootFile = path.resolve('project', 'main.k');
        const bodyFile = path.resolve('project', 'body.k');
        const matsDir = path.resolve('project', 'mats');
        const graph = new ProjectGraph();
        graph.addIncludeEdge(rootFile, bodyFile);

        const snapshot = {
            rootFile,
            files: [rootFile, bodyFile],
            graph,
            keywordMap: new Map(),
            fileIndexes: new Map(),
            missingFiles: graph.missingFiles,
            cycles: graph.cycles,
            effectiveSearchPathsByFile: new Map([
                [rootFile, [path.dirname(rootFile), matsDir]],
                [bodyFile, [path.dirname(bodyFile), matsDir]],
            ]),
            stats: { scannedFileCount: 2, reusedFileCount: 0 },
        };

        const serialized = JSON.parse(JSON.stringify(serializeProjectSnapshot(snapshot)));
        assert.ok(Array.isArray(serialized.effectiveSearchPathsByFile));
        assert.equal(serialized.effectiveSearchPathsByFile.length, 2);

        const hydrated = hydrateProjectSnapshot(serialized);
        assert.ok(hydrated.effectiveSearchPathsByFile instanceof Map);
        assert.deepEqual(
            hydrated.effectiveSearchPathsByFile.get(bodyFile),
            [path.dirname(bodyFile), matsDir]
        );
        assert.deepEqual(
            hydrated.effectiveSearchPathsByFile.get(rootFile),
            [path.dirname(rootFile), matsDir]
        );
    });

    it('hydrates missing effectiveSearchPathsByFile as empty Map', () => {
        const { hydrateProjectSnapshot, serializeProjectSnapshot } = require('../../../src/core/cache/snapshotSerializer');
        const rootFile = path.resolve('project', 'main.k');
        const graph = new ProjectGraph();
        graph.addFile(rootFile);
        const snapshot = {
            rootFile,
            files: [rootFile],
            graph,
            keywordMap: new Map(),
            fileIndexes: new Map(),
            missingFiles: [],
            cycles: [],
            stats: {},
        };
        const serialized = JSON.parse(JSON.stringify(serializeProjectSnapshot(snapshot)));
        delete serialized.effectiveSearchPathsByFile;
        const hydrated = hydrateProjectSnapshot(serialized);
        assert.ok(hydrated.effectiveSearchPathsByFile instanceof Map);
        assert.equal(hydrated.effectiveSearchPathsByFile.size, 0);
    });
});
