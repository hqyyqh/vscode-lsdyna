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
});
