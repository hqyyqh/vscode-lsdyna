const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');

describe('buildFileIndex', () => {
    it('builds keyword and include data from one skeleton scan', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-index-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '*KEYWORD\n*INCLUDE\nsub/body.k\n*INCLUDE_PATH_RELATIVE\nincludes\n*END\n');

        const index = await buildFileIndex(filePath, { highWaterMark: 7 });
        assert.equal(index.filePath, filePath);
        assert.equal(index.scannerVersion, 1);
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
});
