const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanKeywordSkeletonFromFile } = require('../../../out/core/scanner/keywordSkeletonScanner');
const { readBlockText } = require('../../../out/core/scanner/blockReader');

describe('readBlockText', () => {
    it('reads only the requested LS-DYNA keyword block byte range', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-block-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '*KEYWORD\n*INCLUDE\nbody.k\n*END\n');

        const blocks = await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 6 });
        const includeBlock = blocks.find(block => block.keyword === '*INCLUDE');
        const text = await readBlockText(includeBlock);
        assert.equal(text, '*INCLUDE\nbody.k\n');
    });
});
