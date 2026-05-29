'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildProjectIndex, createProjectIndexer } = require('../../../src/core/project/projectIndexer');

describe('projectIndexer', () => {
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

    it('calls onProgress callback for each file scanned', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-progress-'));
        const rootFile = path.join(tempRoot, 'main.k');
        const aFile = path.join(tempRoot, 'a.key');

        fs.writeFileSync(rootFile, '*INCLUDE\na.key\n', 'utf8');
        fs.writeFileSync(aFile, '*PART\npart line\n', 'utf8');

        try {
            const progressCalls = [];
            const snapshot = await buildProjectIndex(rootFile, {
                onProgress: (info) => progressCalls.push(info),
            });

            assert.ok(progressCalls.length >= 2, 'Should call onProgress at least for each file');
            assert.ok(progressCalls.every(p => typeof p.scannedFileCount === 'number'));
            assert.ok(progressCalls.every(p => typeof p.currentFile === 'string'));
            assert.ok(progressCalls.some(p => p.currentFile === path.resolve(rootFile)));
            assert.ok(progressCalls.some(p => p.currentFile === path.resolve(aFile)));
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('works without onProgress callback (backward compatible)', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-project-noprog-'));
        const rootFile = path.join(tempRoot, 'main.k');

        fs.writeFileSync(rootFile, '*PART\npart line\n', 'utf8');

        try {
            const snapshot = await buildProjectIndex(rootFile);
            assert.ok(snapshot);
            assert.ok(snapshot.keywordMap.has('PART'));
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });
});
