'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildProjectIndex, createProjectIndexer, resolveIncludeFromSearchPathsAsync, createConcurrencyLimiter } = require('../../../src/core/project/projectIndexer');

describe('projectIndexer', () => {
    it('records every deduplicated missing include candidate in search order', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-candidates-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const searchA = path.join(tempRoot, 'search-a');
        const searchB = path.join(tempRoot, 'search-b');
        fs.writeFileSync(rootFile, '*INCLUDE\nmissing.key\n', 'utf8');
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
            });

            signatures.set(bFile, { mtimeMs: 20, size: 300 });
            keywordFixtures.set(bFile, [{ keyword: 'SECTION', filePath: bFile, line: 0 }]);

            const updatedSnapshot = await indexer.buildProjectIndex(rootFile);
            assert.deepEqual(updatedSnapshot.stats, {
                scannedFileCount: 1,
                reusedFileCount: 2,
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
