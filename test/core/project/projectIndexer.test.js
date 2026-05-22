'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildProjectIndex } = require('../../../src/core/project/projectIndexer');

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
                        children: [],
                    },
                    {
                        filePath: missingFile,
                        fileName: 'missing.key',
                        missing: true,
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
});
