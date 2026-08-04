const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { SCANNER_VERSION } = require('../../../out/core/scanner/scannerContracts');

describe('buildFileIndex', () => {
    it('builds keyword and include data from one skeleton scan', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-index-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '*KEYWORD\n*INCLUDE\nsub/body.k\n*INCLUDE_PATH_RELATIVE\nincludes\n*END\n');

        const index = await buildFileIndex(filePath, { highWaterMark: 7 });
        assert.equal(index.filePath, filePath);
        assert.equal(index.scannerVersion, SCANNER_VERSION);
        assert.deepEqual(index.keywordBlocks.map(block => block.keyword), [
            '*KEYWORD',
            '*INCLUDE',
            '*INCLUDE_PATH_RELATIVE',
            '*END'
        ]);
        assert.equal(index.includeEntries.length, 1);
        assert.equal(index.includeEntries[0].fileName, 'sub/body.k');
        assert.ok(index.searchPaths.some(searchPath => searchPath.endsWith('includes')));
    });

    it('adds curve and table reference definitions while building the file index', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-index-ref-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_CURVE',
            '      1001',
            '       0.0       1.0',
            '*DEFINE_TABLE',
            '      2001',
            '       0.0      1001',
            '*END',
        ].join('\n'));

        try {
            const index = await buildFileIndex(filePath, { highWaterMark: 16 });

            assert.equal(index.scannerVersion, SCANNER_VERSION);
            assert.equal(index.referenceDefinitions.curves.length, 1);
            assert.equal(index.referenceDefinitions.curves[0].id, 1001);
            assert.equal(index.referenceDefinitions.tables.length, 1);
            assert.equal(index.referenceDefinitions.tables[0].id, 2001);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('adds parameter events without scanning unrelated files in the directory', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-index-param-'));
        const filePath = path.join(dir, 'condition-a.k');
        const unrelatedFile = path.join(dir, 'condition-b-old.k');
        fs.writeFileSync(filePath, [
            '*PARAMETER',
            'ICID            100',
            '*END',
        ].join('\n'));
        fs.writeFileSync(unrelatedFile, [
            '*PARAMETER',
            'ICID            999',
            '*END',
        ].join('\n'));

        try {
            const index = await buildFileIndex(filePath);

            assert.equal(index.parameterEvents.length, 1);
            assert.equal(index.parameterEvents[0].name, 'CID');
            assert.equal(index.parameterEvents[0].value, 100);
            assert.ok(!index.parameterEvents.some(event => event.value === 999));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
