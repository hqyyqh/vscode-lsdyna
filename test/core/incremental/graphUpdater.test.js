'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProjectGraph } = require('../../../src/core/project/projectGraph');
const { createGraphUpdater } = require('../../../src/core/incremental/graphUpdater');

describe('createGraphUpdater', () => {
    it('preserves the previous graph and keywords when default include access fails', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-graph-access-'));
        const root = path.join(directory, 'main.k'), child = path.join(directory, 'child.k');
        fs.writeFileSync(root, '*INCLUDE\nchild.k\n*NODE\n1,0,0,0\n');
        fs.writeFileSync(child, '*NODE\n2,0,0,0\n');
        const graph = new ProjectGraph();graph.addIncludeEdge(root, child);
        const snapshot = { rootFile: root, files: [root, child], graph,
            keywordMap: new Map([['PART', [{ keyword: 'PART', filePath: root, lineIndex: 2 }]]]),
            missingFiles: graph.missingFiles, cycles: graph.cycles };
        const state = () => ({ files: snapshot.files, keywordMap: snapshot.keywordMap,
            includes: graph.includeOccurrences, missing: snapshot.missingFiles });
        const before = structuredClone(state()), access = fs.promises.access;
        const fault = Object.assign(new Error('controlled include access failure'), { code: 'EIO' });
        fs.promises.access = async function (file, ...args) {
            if (path.resolve(String(file)) === child) throw fault;
            return access.call(this, file, ...args);
        };
        try {
            await assert.rejects(createGraphUpdater().updateFile(root, snapshot), error => error === fault);
            assert.deepEqual(state(), before);
            fs.promises.access = access;
            await createGraphUpdater().updateFile(root, snapshot);
            assert.ok(snapshot.keywordMap.has('NODE'));
            assert.deepEqual(graph.getChildren(root), [child]);
            assert.deepEqual(snapshot.missingFiles, []);
        } finally {
            fs.promises.access = access;
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
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
        // The new child's descendants and rich indexes have not been scanned by this API.
        assert.equal(result.requiresFullRebuild, true);
        assert.equal(snapshot.graph.includeOccurrencesComplete, false);
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

    for (const scenario of ['chain', 'cycle', 'shared descendant', 'shared cycle']) {
        it(`prunes only root-unreachable files after detaching a ${scenario}`, async () => {
            const [root, a, b, c] = ['main.k', 'a.k', 'b.k', 'c.k'].map(name => path.resolve('/project', name));
            const graph = new ProjectGraph();
            graph.addIncludeEdge(root, a);
            graph.addIncludeEdge(a, b);
            if (scenario.includes('cycle')) graph.addIncludeEdge(b, a);
            const shared = scenario.startsWith('shared');
            if (shared) {
                graph.addIncludeEdge(root, c);
                graph.addIncludeEdge(c, b);
            }
            const files = shared ? [root, a, b, c] : [root, a, b];
            const keywordMap = new Map([['PART', files.map(filePath => ({ keyword: 'PART', filePath, lineIndex: 0 }))]]);
            const snapshot = createSnapshot(root, files, graph, keywordMap);
            const updater = createGraphUpdater({
                collectIncludeDirectivesFromFile: async () => ({ includeEntries: shared ? [{ fileName: 'c.k' }] : [], searchPaths: [] }),
                collectKeywordsFromFile: async () => [{ keyword: 'PART', filePath: root, lineIndex: 0 }],
                resolveInclude: async () => c,
            });
            const result = await updater.updateFile(root, snapshot);
            const removed = shared ? (scenario.includes('cycle') ? [] : [a]) : [a, b];
            assert.deepEqual(result.removedFiles.sort(), removed.sort());
            const retained = files.filter(file => !removed.includes(file));
            assert.deepEqual(snapshot.files.sort(), retained.sort());
            assert.deepEqual(keywordMap.get('PART').map(entry => entry.filePath).sort(), retained.sort());
            for (const file of removed) {
                assert.equal(graph.children.has(file), false);
                assert.equal(graph.parents.has(file), false);
                assert.equal(graph.includeEntries.has(file), false);
                assert.equal(graph.includeOccurrences.some(entry => entry.fromFile === file || entry.filePath === file), false);
            }
            if (shared) assert.deepEqual(graph.getParents(b).sort(), (scenario.includes('cycle') ? [a, c] : [c]).sort());
            assert.ok(snapshot.files.includes(root));
        });
    }

    it('removes detached file metadata and preserves metadata from the shared branch', () => {
        const [root, a, b, c, missing] = ['main.k', 'a.k', 'b.k', 'c.k', 'missing.k'].map(name => path.resolve('/project', name));
        const graph = new ProjectGraph();
        graph.addIncludeEdge(root, a);
        graph.addIncludeEdge(a, b);
        graph.addIncludeEdge(root, c);
        graph.addIncludeEdge(c, b);
        graph.addMissingFile({ fromFile: a, filePath: missing, fileName: 'missing.k', lineIndex: 2 });
        graph.addMissingFile({ fromFile: c, filePath: missing, fileName: 'missing.k', lineIndex: 3 });
        graph.addCycle({ fromFile: b, path: [root, a, b, a], lineIndex: 4 });
        const snapshot = createSnapshot(root, [root, a, b, c], graph);
        snapshot.fileIndexes = new Map([a, b, c].map(file => [file, { pathEntries: [] }]));
        snapshot.effectiveSearchPathsByFile = new Map([a, b, c].map(file => [file, [path.dirname(file)]]));
        const result = createGraphUpdater().removeFile(a, snapshot);
        assert.deepEqual(result.removedFiles, [a]);
        assert.deepEqual(graph.getParents(b), [c]);
        assert.equal(graph.includeOccurrences.some(entry => entry.fromFile === a || entry.filePath === a), false);
        assert.deepEqual(snapshot.missingFiles.map(record => record.fromFile), [c]);
        assert.deepEqual(snapshot.cycles, []);
        assert.equal(snapshot.fileIndexes.has(a), false);
        assert.equal(snapshot.effectiveSearchPathsByFile.has(a), false);
        assert.ok(snapshot.fileIndexes.has(b));
        assert.strictEqual(snapshot.missingFiles, graph.missingFiles);
        assert.strictEqual(snapshot.cycles, graph.cycles);
    });

    it('removing the root also removes its now-unreachable cycle', () => {
        const [root, a, b] = ['main.k', 'a.k', 'b.k'].map(name => path.resolve('/project', name));
        const graph = new ProjectGraph();
        graph.addIncludeEdge(root, a);
        graph.addIncludeEdge(a, b);
        graph.addIncludeEdge(b, a);
        const snapshot = createSnapshot(root, [root, a, b], graph, new Map([['PART', [{ filePath: b }]]]));
        const result = createGraphUpdater().removeFile(root, snapshot);
        assert.deepEqual(result.removedFiles.sort(), [root, a, b].sort());
        assert.deepEqual(snapshot.files, []);
        assert.equal(snapshot.keywordMap.size, 0);
        assert.equal(graph.children.size, 0);
        assert.deepEqual(graph.includeOccurrences, []);
    });

    it('refreshes repeated statements and their metadata without resolving a statement twice', async () => {
        const [root, child] = ['main.k', 'child.k'].map(name => path.resolve('/project', name));
        const graph = new ProjectGraph();
        graph.addIncludeEdge(root, child, { filePath: child, lineIndex: 1 });
        const snapshot = createSnapshot(root, [root, child], graph);
        const entries = [
            { fileName: 'child.k', lineIndex: 9, startChar: 2, endChar: 9, keyword: '*INCLUDE_TRANSFORM', keywordLine: 8,
                transform: { offsets: { idfoff: { kind: 'numeric', value: 100 } } }, parameterizedFileName: false },
            { fileName: 'child.k', lineIndex: 15, startChar: 0, endChar: 7, keyword: '*INCLUDE', keywordLine: 14,
                inputFormatOverride: 'long', parameterizedFileName: false },
        ];
        let resolutions = 0;
        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async () => ({ includeEntries: entries, searchPaths: [] }),
            collectKeywordsFromFile: async () => [],
            resolveInclude: async () => { resolutions++; return child; },
        });
        const result = await updater.updateFile(root, snapshot);
        assert.equal(result.changed, true);
        assert.equal(resolutions, entries.length);
        assert.deepEqual(graph.getChildren(root), [child]);
        assert.deepEqual(graph.includeOccurrences.map(entry => entry.lineIndex), [9, 15]);
        assert.deepEqual(graph.includeOccurrences.map(({ occurrenceId, fromFile, ...entry }) => entry),
            entries.map(entry => ({ ...entry, filePath: child })));
        assert.notEqual(graph.includeOccurrences[0].occurrenceId, graph.includeOccurrences[1].occurrenceId);
        assert.equal(graph.getIncludeEntries(root).length, 1);
    });

    it('refreshes missing-only statements even when both resolved child sets are empty', async () => {
        const [root, missing] = ['main.k', 'missing.k'].map(name => path.resolve('/project', name));
        const graph = new ProjectGraph();
        graph.addMissingFile({ fromFile: root, filePath: missing, fileName: 'missing.k', lineIndex: 1 });
        graph.includeOccurrencesComplete = false;
        const snapshot = createSnapshot(root, [root], graph);
        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async () => ({ includeEntries: [{ fileName: 'other.k', lineIndex: 8,
                inputFormatOverride: 'standard', keyword: '*INCLUDE' }], searchPaths: [path.dirname(root), path.dirname(root)] }),
            collectKeywordsFromFile: async () => [],
            resolveInclude: async () => null,
        });
        await updater.updateFile(root, snapshot);
        assert.equal(snapshot.missingFiles.length, 1);
        assert.equal(snapshot.missingFiles[0].fileName, 'other.k');
        assert.equal(snapshot.missingFiles[0].lineIndex, 8);
        assert.equal(snapshot.missingFiles[0].candidatePaths.length, 1);
        assert.deepEqual(graph.includeOccurrences.map(entry => [entry.fileName, entry.lineIndex, entry.inputFormatOverride]),
            [['other.k', 8, 'standard']]);
        assert.strictEqual(snapshot.missingFiles, graph.missingFiles);
        assert.equal(graph.includeOccurrencesComplete, false);
    });

    it('replaces a resolved include once, retaining its details and requiring a subtree rebuild', async () => {
        const [root, a, b] = ['main.k', 'a.k', 'b.k'].map(name => path.resolve('/project', name));
        const graph = new ProjectGraph();
        graph.addIncludeEdge(root, a, { filePath: a, lineIndex: 1 });
        const snapshot = createSnapshot(root, [root, a], graph);
        let resolutions = 0;
        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async () => ({ includeEntries: [{ fileName: 'b.k', lineIndex: 9 }], searchPaths: [] }),
            collectKeywordsFromFile: async () => [],
            resolveInclude: async () => { resolutions++; return resolutions === 1 ? b : null; },
        });
        const result = await updater.updateFile(root, snapshot);
        assert.equal(resolutions, 1);
        assert.deepEqual(graph.getChildren(root), [b]);
        assert.deepEqual(graph.includeOccurrences.map(entry => [entry.filePath, entry.lineIndex]), [[b, 9]]);
        assert.deepEqual(result.removedFiles, [a]);
        assert.equal(result.requiresFullRebuild, true);
        assert.equal(graph.includeOccurrencesComplete, false);
    });

    it('does not mutate keywords or graph records when include resolution fails', async () => {
        const root = path.resolve('/project/main.k');
        const graph = new ProjectGraph();
        graph.addFile(root);
        const snapshot = createSnapshot(root, [root], graph, new Map([['PART', [{ keyword: 'PART', filePath: root }]]]));
        const before = JSON.stringify(graph.toJSON());
        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async () => ({ includeEntries: [{ fileName: 'child.k' }], searchPaths: [] }),
            collectKeywordsFromFile: async () => [],
            resolveInclude: async () => { throw new Error('resolution failed'); },
        });
        await assert.rejects(updater.updateFile(root, snapshot), /resolution failed/);
        assert.equal(JSON.stringify(graph.toJSON()), before);
        assert.equal(snapshot.keywordMap.has('PART'), true);
    });

    it('refreshes real disk Include metadata and signals that rich indexes must be rebuilt', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-updater-disk-'));
        const root = path.join(directory, 'main.k');
        const child = path.join(directory, 'child.k');
        const { buildProjectIndex } = require('../../../src/core/project/projectIndexer');
        const { buildProjectReferenceIndex } = require('../../../src/core/references/projectReferenceIndex');
        try {
            fs.writeFileSync(child, '*DEFINE_CURVE\n1\n0 0\n*END\n');
            fs.writeFileSync(root, '*INCLUDE +\nchild.k\n*END\n');
            const snapshot = await buildProjectIndex(root);
            fs.writeFileSync(root, '$ moved include\n*INCLUDE -\nchild.k\n*INCLUDE\nchild.k\n*END\n');
            const result = await createGraphUpdater().updateFile(root, snapshot);
            const fresh = await buildProjectIndex(root);
            const details = graph => graph.includeOccurrences.map(entry => ({ filePath: entry.filePath, lineIndex: entry.lineIndex,
                keywordLine: entry.keywordLine, inputFormatOverride: entry.inputFormatOverride, occurrenceId: entry.occurrenceId }));
            assert.deepEqual(details(snapshot.graph), details(fresh.graph));
            assert.equal(result.requiresFullRebuild, true);
            assert.equal(snapshot.graph.includeOccurrencesComplete, false);
            assert.ok(buildProjectReferenceIndex(snapshot).completenessReasons.includes('project-scan-unavailable'));
            assert.equal(fresh.graph.includeOccurrencesComplete, true);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('refreshes self-cycle metadata and removes it when the statement is deleted', async () => {
        const root = path.resolve('/project/main.k');
        const graph = new ProjectGraph();
        graph.addFile(root);
        const snapshot = createSnapshot(root, [root], graph);
        let entries = [{ fileName: 'main.k', lineIndex: 7 }];
        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async () => ({ includeEntries: entries, searchPaths: [] }),
            collectKeywordsFromFile: async () => [],
            resolveInclude: async () => root,
        });
        const first = await updater.updateFile(root, snapshot);
        assert.equal(first.requiresFullRebuild, true);
        assert.equal(graph.includeOccurrences[0].cycle, true);
        assert.deepEqual(snapshot.cycles[0].path, [root, root]);
        assert.equal(snapshot.cycles[0].lineIndex, 7);
        assert.strictEqual(snapshot.cycles, graph.cycles);
        entries = [];
        await updater.updateFile(root, snapshot);
        assert.deepEqual(graph.includeOccurrences, []);
        assert.deepEqual(snapshot.cycles, []);
        assert.equal(graph.includeOccurrencesComplete, false);
    });

    it('retains files reached through previously cyclic statements in a real disk snapshot', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-updater-cycle-'));
        const [root, a, b, c] = ['main.k', 'a.k', 'b.k', 'c.k'].map(name => path.join(directory, name));
        const { buildProjectIndex } = require('../../../src/core/project/projectIndexer');
        try {
            fs.writeFileSync(root, '*INCLUDE\na.k\nc.k\n*END\n');
            fs.writeFileSync(a, '*INCLUDE\nb.k\n*END\n');
            fs.writeFileSync(b, '*INCLUDE\na.k\n*END\n');
            fs.writeFileSync(c, '*INCLUDE\nb.k\n*END\n');
            const snapshot = await buildProjectIndex(root);
            assert.ok(snapshot.graph.includeOccurrences.some(entry => entry.fromFile === b && entry.filePath === a && entry.cycle));
            fs.writeFileSync(root, '*INCLUDE\nc.k\n*END\n');
            const result = await createGraphUpdater().updateFile(root, snapshot);
            const fresh = await buildProjectIndex(root);
            assert.deepEqual(result.removedFiles, []);
            assert.deepEqual(snapshot.files.slice().sort(), fresh.files.slice().sort());
            assert.deepEqual(snapshot.files.slice().sort(), [root, a, b, c].sort());
            assert.equal(result.requiresFullRebuild, true);
            assert.equal(snapshot.graph.includeOccurrencesComplete, false);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('keeps canonical graph ownership for a Windows case variant of a tracked file', async function () {
        if (process.platform !== 'win32') this.skip();
        const [root, child] = ['Main.k', 'Child.k'].map(name => path.resolve('/Project', name));
        const graph = new ProjectGraph();
        graph.addIncludeEdge(root, child);
        const snapshot = createSnapshot(root, [root, child], graph);
        let scannedFile;
        const updater = createGraphUpdater({
            collectIncludeDirectivesFromFile: async file => { scannedFile = file; return { includeEntries: [], searchPaths: [] }; },
            collectKeywordsFromFile: async () => [],
        });
        const result = await updater.updateFile(root.toLowerCase(), snapshot);
        assert.equal(scannedFile, root);
        assert.deepEqual(result.removedFiles, [child]);
        assert.deepEqual([...graph.children.keys()], [root]);
        assert.deepEqual(graph.includeOccurrences, []);
    });
});
