'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildProjectIndex, createProjectIndexer, resolveIncludeFromSearchPathsAsync, createConcurrencyLimiter } = require('../../../src/core/project/projectIndexer');
const { SCANNER_VERSION } = require('../../../src/core/scanner/scannerContracts');

describe('projectIndexer', () => {
    it('loads each file index once and derives keywords plus includes from that result', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-file-index-'));
        const rootFile = path.join(tempRoot, 'main.k');
        fs.writeFileSync(rootFile, '*KEYWORD\n', 'utf8');

        let loadCount = 0;
        const indexer = createProjectIndexer({
            loadFileIndex: async (filePath) => {
                loadCount++;
                return {
                    filePath,
                    size: 10,
                    mtimeMs: 1,
                    scannerVersion: SCANNER_VERSION,
                    keywordBlocks: [{ keyword: '*KEYWORD', filePath, startLine: 0 }],
                    includeEntries: [],
                    searchPaths: [path.dirname(filePath)],
                    pathEntries: [],
                    scanStats: { mode: 'stream-skeleton', durationMs: 1, decodedLineCount: 0, keywordCount: 1 },
                };
            },
            getFileSignature: async () => ({ mtimeMs: 1, size: 10 }),
        });

        try {
            const snapshot = await indexer.buildProjectIndex(rootFile);
            assert.equal(loadCount, 1);
            assert.deepEqual(snapshot.keywordMap.get('KEYWORD').map(entry => entry.filePath), [rootFile]);
            assert.equal(snapshot.fileIndexes.get(rootFile).scannerVersion, SCANNER_VERSION);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('records every deduplicated missing include candidate in search order', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-candidates-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const searchA = path.join(tempRoot, 'search-a');
        const searchB = path.join(tempRoot, 'search-b');
        fs.writeFileSync(rootFile, '*INCLUDE\nmissing.key\n', 'utf8');
        // Legacy mock searchPaths omit dirname seed; effective paths always prepend dirname(file).
        const indexer = createProjectIndexer({
            collectIncludeDirectivesFromFile: async () => ({
                includeEntries: [{ fileName: 'missing.key', lineIndex: 1, startChar: 0, endChar: 11 }],
                searchPaths: [searchA, searchB, searchA],
            }),
            collectKeywordsFromFile: async () => [],
        });

        try {
            const snapshot = await indexer.buildProjectIndex(rootFile);

            assert.deepStrictEqual(snapshot.missingFiles[0].candidatePaths, [
                path.resolve(path.dirname(rootFile), 'missing.key'),
                path.resolve(searchA, 'missing.key'),
                path.resolve(searchB, 'missing.key'),
            ]);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('recursively aggregates included files and keyword usages into one project snapshot', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-index-'));
        const submodelsDir = path.join(tempRoot, 'submodels');
        const rootFile = path.join(tempRoot, 'main.k');
        const aFile = path.join(tempRoot, 'a.key');
        const bFile = path.join(submodelsDir, 'b.key');

        fs.mkdirSync(submodelsDir);
        fs.writeFileSync(rootFile, '*INCLUDE_PATH_RELATIVE\nsubmodels\n*INCLUDE\na.key\nb.key\n', 'utf8');
        fs.writeFileSync(aFile, '*PART\npart line\n', 'utf8');
        fs.writeFileSync(bFile, '*MAT_ELASTIC\nmat line\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);

            assert.deepEqual(snapshot.files.sort(), [rootFile, aFile, bFile].sort());
            assert.deepEqual(
                snapshot.keywordMap.get('PART').map(entry => entry.filePath),
                [aFile]
            );
            assert.deepEqual(
                snapshot.keywordMap.get('MAT_ELASTIC').map(entry => entry.filePath),
                [bFile]
            );
            assert.deepEqual(snapshot.missingFiles, []);
            assert.deepEqual(snapshot.cycles, []);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('records missing includes without aborting the rest of the project scan', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-index-'));
        const rootFile = path.join(tempRoot, 'main.k');

        fs.writeFileSync(rootFile, '*INCLUDE\nmissing.key\n*PART\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);

            assert.deepEqual(snapshot.files, [rootFile]);
            assert.equal(snapshot.missingFiles.length, 1);
            assert.equal(snapshot.missingFiles[0].fromFile, rootFile);
            assert.equal(snapshot.missingFiles[0].fileName, 'missing.key');
            assert.deepEqual(
                snapshot.keywordMap.get('PART').map(entry => entry.filePath),
                [rootFile]
            );
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('builds a project graph with forward and reverse include edges', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-index-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.key');

        fs.writeFileSync(rootFile, '*INCLUDE\nchild.key\n', 'utf8');
        fs.writeFileSync(childFile, '*PART\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);

            assert.deepEqual(snapshot.graph.getChildren(rootFile), [childFile]);
            assert.deepEqual(snapshot.graph.getParents(childFile), [rootFile]);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('keeps repeated transformed includes as distinct occurrences while aggregating the file graph', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-occurrences-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.key');
        const transformBlock = idfoff => [
            '*INCLUDE_TRANSFORM',
            'child.key',
            `0 0 0 0 0 ${idfoff} 0`,
            '0',
            '1 1 1 1 1',
            '0',
        ].join('\n');
        fs.writeFileSync(rootFile, `${transformBlock(0)}\n${transformBlock(100)}\n*END\n`, 'utf8');
        fs.writeFileSync(childFile, '*DEFINE_CURVE\n1\n0 0\n*END\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);
            const occurrences = snapshot.graph.includeOccurrences.filter(item =>
                item.fromFile === rootFile && item.filePath === childFile
            );

            assert.deepEqual(snapshot.graph.getChildren(rootFile), [childFile]);
            assert.equal(snapshot.graph.getIncludeEntries(rootFile).length, 1);
            assert.equal(occurrences.length, 2);
            assert.notEqual(occurrences[0].occurrenceId, occurrences[1].occurrenceId);
            assert.deepEqual(
                occurrences.map(item => item.transform.offsets.idfoff.value),
                [0, 100]
            );
            assert.deepEqual(
                occurrences.map(item => item.lineIndex),
                [1, 7]
            );
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('materializes a nested include tree from the project graph in include order', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-index-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const aFile = path.join(tempRoot, 'a.key');
        const bFile = path.join(tempRoot, 'b.key');
        const cFile = path.join(tempRoot, 'c.key');

        fs.writeFileSync(rootFile, '*INCLUDE\na.key\nb.key\n', 'utf8');
        fs.writeFileSync(aFile, '*INCLUDE\nc.key\n', 'utf8');
        fs.writeFileSync(bFile, '*PART\n', 'utf8');
        fs.writeFileSync(cFile, '*MAT_ELASTIC\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);

            assert.deepEqual(snapshot.graph.toTree(rootFile), {
                filePath: rootFile,
                children: [
                    {
                        filePath: aFile,
                        children: [
                            {
                                filePath: cFile,
                                children: [],
                            },
                        ],
                    },
                    {
                        filePath: bFile,
                        children: [],
                    },
                ],
            });
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('preserves missing includes as tree nodes in include order', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-index-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const aFile = path.join(tempRoot, 'a.key');
        const bFile = path.join(tempRoot, 'b.key');
        const missingFile = path.join(tempRoot, 'missing.key');

        fs.writeFileSync(rootFile, '*INCLUDE\na.key\nmissing.key\nb.key\n', 'utf8');
        fs.writeFileSync(aFile, '*PART\n', 'utf8');
        fs.writeFileSync(bFile, '*MAT_ELASTIC\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);

            assert.deepEqual(snapshot.graph.toTree(rootFile), {
                filePath: rootFile,
                children: [
                    {
                        filePath: aFile,
                        children: [],
                    },
                    {
                        filePath: missingFile,
                        fileName: 'missing.key',
                        missing: true,
                        lineIndex: 2,
                        startChar: 0,
                        endChar: 11,
                        children: [],
                    },
                    {
                        filePath: bFile,
                        children: [],
                    },
                ],
            });
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('preserves duplicate missing includes as separate tree nodes in stable order', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-index-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const childFile = path.join(tempRoot, 'child.key');
        const missingFile = path.join(tempRoot, 'missing.key');

        fs.writeFileSync(rootFile, '*INCLUDE\nmissing.key\nmissing.key\nchild.key\n', 'utf8');
        fs.writeFileSync(childFile, '*PART\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);

            assert.deepEqual(snapshot.graph.toTree(rootFile), {
                filePath: rootFile,
                children: [
                    {
                        filePath: missingFile,
                        fileName: 'missing.key',
                        missing: true,
                        lineIndex: 1,
                        startChar: 0,
                        endChar: 11,
                        children: [],
                    },
                    {
                        filePath: missingFile,
                        fileName: 'missing.key',
                        missing: true,
                        lineIndex: 2,
                        startChar: 0,
                        endChar: 11,
                        children: [],
                    },
                    {
                        filePath: childFile,
                        children: [],
                    },
                ],
            });
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('reuses unchanged file scans when rebuilding after a child file change', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-index-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const aFile = path.join(tempRoot, 'a.key');
        const bFile = path.join(tempRoot, 'b.key');
        const projectDir = path.dirname(rootFile);
        const scanCounts = new Map();
        const includeFixtures = new Map([
            [rootFile, {
                includeEntries: [{ fileName: 'a.key' }, { fileName: 'b.key' }],
                searchPaths: [projectDir],
            }],
            [aFile, {
                includeEntries: [],
                searchPaths: [projectDir],
            }],
            [bFile, {
                includeEntries: [],
                searchPaths: [projectDir],
            }],
        ]);
        const keywordFixtures = new Map([
            [rootFile, []],
            [aFile, [{ keyword: 'PART', filePath: aFile, line: 0 }]],
            [bFile, [{ keyword: 'MAT_ELASTIC', filePath: bFile, line: 0 }]],
        ]);
        const signatures = new Map([
            [rootFile, { mtimeMs: 10, size: 100 }],
            [aFile, { mtimeMs: 10, size: 200 }],
            [bFile, { mtimeMs: 10, size: 300 }],
        ]);
        const indexer = createProjectIndexer({
            getFileSignature: async (filePath) => signatures.get(filePath),
            collectKeywordsFromFile: async (filePath) => {
                scanCounts.set(`keywords:${filePath}`, (scanCounts.get(`keywords:${filePath}`) || 0) + 1);
                return keywordFixtures.get(filePath);
            },
            collectIncludeDirectivesFromFile: async (filePath) => {
                scanCounts.set(`includes:${filePath}`, (scanCounts.get(`includes:${filePath}`) || 0) + 1);
                return includeFixtures.get(filePath);
            },
        });

        fs.writeFileSync(rootFile, '*KEYWORD\n', 'utf8');
        fs.writeFileSync(aFile, '*KEYWORD\n', 'utf8');
        fs.writeFileSync(bFile, '*KEYWORD\n', 'utf8');

        try {
            const initialSnapshot = await indexer.buildProjectIndex(rootFile);
            assert.deepEqual(initialSnapshot.stats, {
                scannedFileCount: 3,
                reusedFileCount: 0,
                includeOccurrenceCount: 2,
            });

            signatures.set(bFile, { mtimeMs: 20, size: 300 });
            keywordFixtures.set(bFile, [{ keyword: 'SECTION', filePath: bFile, line: 0 }]);

            const updatedSnapshot = await indexer.buildProjectIndex(rootFile);
            assert.deepEqual(updatedSnapshot.stats, {
                scannedFileCount: 1,
                reusedFileCount: 2,
                includeOccurrenceCount: 2,
            });
            assert.deepEqual(updatedSnapshot.keywordMap.get('PART').map(entry => entry.filePath), [aFile]);
            assert.deepEqual(updatedSnapshot.keywordMap.get('SECTION').map(entry => entry.filePath), [bFile]);
            assert.equal(updatedSnapshot.keywordMap.has('MAT_ELASTIC'), false);
            assert.equal(scanCounts.get(`keywords:${rootFile}`), 1);
            assert.equal(scanCounts.get(`includes:${rootFile}`), 1);
            assert.equal(scanCounts.get(`keywords:${aFile}`), 1);
            assert.equal(scanCounts.get(`includes:${aFile}`), 1);
            assert.equal(scanCounts.get(`keywords:${bFile}`), 2);
            assert.equal(scanCounts.get(`includes:${bFile}`), 2);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('scans files in parallel using BFS traversal with concurrency control', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-index-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const aFile = path.join(tempRoot, 'a.key');
        const bFile = path.join(tempRoot, 'b.key');
        const cFile = path.join(tempRoot, 'c.key');

        // root includes a and b, a includes c
        fs.writeFileSync(rootFile, '*INCLUDE\na.key\nb.key\n', 'utf8');
        fs.writeFileSync(aFile, '*INCLUDE\nc.key\n', 'utf8');
        fs.writeFileSync(bFile, '*PART\npart data\n', 'utf8');
        fs.writeFileSync(cFile, '*MAT_ELASTIC\nmat data\n', 'utf8');

        try {
            const indexer = createProjectIndexer({ concurrency: 2 });
            const snapshot = await indexer.buildProjectIndex(rootFile);

            assert.deepEqual(snapshot.files.sort(), [rootFile, aFile, bFile, cFile].sort());
            assert.deepEqual(snapshot.graph.getChildren(rootFile).sort(), [aFile, bFile].sort());
            assert.deepEqual(snapshot.graph.getChildren(aFile), [cFile]);
            assert.equal(snapshot.stats.scannedFileCount, 4);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('detects cycles correctly with BFS parallel traversal', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-index-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const aFile = path.join(tempRoot, 'a.key');

        // root includes a, a includes root (cycle)
        fs.writeFileSync(rootFile, '*INCLUDE\na.key\n', 'utf8');
        fs.writeFileSync(aFile, '*INCLUDE\nmain.k\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);

            assert.deepEqual(snapshot.files.sort(), [rootFile, aFile].sort());
            assert.equal(snapshot.cycles.length, 1);
            assert.equal(snapshot.cycles[0].fromFile, aFile);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('uses async resolution cache to avoid redundant filesystem lookups', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-index-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const sharedFile = path.join(tempRoot, 'shared.key');

        // root includes shared.key multiple times via different include blocks
        fs.writeFileSync(rootFile, '*INCLUDE\nshared.key\n*SECTION_SHELL\ndata\n*INCLUDE\nshared.key\n', 'utf8');
        fs.writeFileSync(sharedFile, '*PART\npart data\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);

            // shared.key should appear once in files (deduplication)
            assert.deepEqual(snapshot.files.sort(), [rootFile, sharedFile].sort());
            assert.equal(snapshot.stats.scannedFileCount, 2);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('inherits *INCLUDE_PATH from main so child short names resolve (vehicle deck pattern)', async () => {
        // Expert pattern: PATH only on main; body.k uses bare steel.k under mats/
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ancestor-path-'));
        const matsDir = path.join(tempRoot, 'mats');
        const rootFile = path.join(tempRoot, 'main.k');
        const bodyFile = path.join(tempRoot, 'body.k');
        const steelFile = path.join(matsDir, 'steel.k');

        fs.mkdirSync(matsDir);
        // RELATIVE so mats is resolved against main's directory (vehicle relative PATH habit).
        fs.writeFileSync(rootFile, '*INCLUDE_PATH_RELATIVE\nmats\n*INCLUDE\nbody.k\n', 'utf8');
        fs.writeFileSync(bodyFile, '*INCLUDE\nsteel.k\n', 'utf8');
        fs.writeFileSync(steelFile, '*MAT_ELASTIC\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);

            assert.deepEqual(snapshot.files.sort(), [rootFile, bodyFile, steelFile].sort());
            assert.deepEqual(snapshot.missingFiles, []);
            assert.deepEqual(snapshot.graph.getChildren(bodyFile), [steelFile]);

            assert.ok(snapshot.effectiveSearchPathsByFile instanceof Map);
            const bodyPaths = snapshot.effectiveSearchPathsByFile.get(bodyFile);
            assert.ok(Array.isArray(bodyPaths), 'body should have effective search paths');
            const matsAbs = path.normalize(matsDir);
            assert.ok(
                bodyPaths.some(p => path.normalize(p) === matsAbs),
                `expected mats in body effective paths, got ${JSON.stringify(bodyPaths)}`
            );

            // Without ancestor context (file-local only), steel.k is not found from body dir.
            const includeScanner = require('../../../src/core/parser/includeScanner');
            const local = await includeScanner.collectIncludeDirectivesFromFile(bodyFile);
            const localHit = await resolveIncludeFromSearchPathsAsync('steel.k', local.searchPaths, new Map());
            assert.equal(localHit, null, 'local-only scan of body must not find steel.k');
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('inherits *INCLUDE_PATH declared on intermediate setup (main → setup → body)', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-setup-path-'));
        const setupDir = path.join(tempRoot, 'setup');
        const matsDir = path.join(tempRoot, 'mats');
        const rootFile = path.join(tempRoot, 'main.k');
        const setupFile = path.join(setupDir, 'paths.k');
        const bodyFile = path.join(tempRoot, 'body.k');
        const steelFile = path.join(matsDir, 'steel.k');

        fs.mkdirSync(setupDir);
        fs.mkdirSync(matsDir);
        fs.writeFileSync(rootFile, '*INCLUDE\nsetup/paths.k\n', 'utf8');
        // PATH relative to setup/ → ../mats
        fs.writeFileSync(setupFile, '*INCLUDE_PATH_RELATIVE\n../mats\n*INCLUDE\n../body.k\n', 'utf8');
        fs.writeFileSync(bodyFile, '*INCLUDE\nsteel.k\n', 'utf8');
        fs.writeFileSync(steelFile, '*MAT_ELASTIC\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);

            assert.ok(snapshot.files.includes(steelFile), 'steel.k must resolve via setup PATH');
            assert.deepEqual(snapshot.missingFiles, []);
            assert.deepEqual(snapshot.graph.getChildren(bodyFile), [steelFile]);

            const bodyPaths = snapshot.effectiveSearchPathsByFile.get(bodyFile);
            const matsAbs = path.normalize(matsDir);
            assert.ok(
                bodyPaths && bodyPaths.some(p => path.normalize(p) === matsAbs),
                `expected mats in body effective paths, got ${JSON.stringify(bodyPaths)}`
            );
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});

describe('resolveIncludeFromSearchPathsAsync', () => {
    it('resolves file from search paths asynchronously', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-resolve-'));
        const file = path.join(tempRoot, 'target.k');
        fs.writeFileSync(file, 'data', 'utf8');

        try {
            const cache = new Map();
            const result = await resolveIncludeFromSearchPathsAsync('target.k', [tempRoot], cache);
            assert.equal(result, file);

            // Second call should use cache
            const result2 = await resolveIncludeFromSearchPathsAsync('target.k', [tempRoot], cache);
            assert.equal(result2, file);
            assert.equal(cache.size, 1);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('returns null and caches miss for non-existing files', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-resolve-'));

        try {
            const cache = new Map();
            const result = await resolveIncludeFromSearchPathsAsync('nofile.k', [tempRoot], cache);
            assert.equal(result, null);
            assert.equal(cache.size, 1);
            assert.equal(cache.get('nofile.k\0' + tempRoot), null);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});

describe('createConcurrencyLimiter', () => {
    it('limits concurrent execution', async () => {
        let active = 0;
        let maxActive = 0;
        const limit = createConcurrencyLimiter(2);

        const task = () => limit(async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise(r => setTimeout(r, 10));
            active--;
        });

        await Promise.all([task(), task(), task(), task(), task()]);
        assert.equal(maxActive, 2);
    });

    it('returns results from tasks', async () => {
        const limit = createConcurrencyLimiter(3);
        const results = await Promise.all([
            limit(async () => 'a'),
            limit(async () => 'b'),
            limit(async () => 'c'),
        ]);
        assert.deepEqual(results, ['a', 'b', 'c']);
    });

    it('propagates errors correctly', async () => {
        const limit = createConcurrencyLimiter(2);
        await assert.rejects(
            () => limit(async () => { throw new Error('test'); }),
            /test/
        );
    });
});
