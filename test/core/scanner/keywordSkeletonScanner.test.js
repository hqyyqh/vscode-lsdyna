const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanKeywordSkeletonFromFile } = require('../../../out/core/scanner/keywordSkeletonScanner');

function writeFixture(name, text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-skeleton-'));
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, text);
    return filePath;
}

describe('scanKeywordSkeletonFromFile', () => {
    it('detects LS-DYNA keyword blocks without decoding data cards', async () => {
        const filePath = writeFixture('main.k', [
            '$ *PART inside comment',
            '*KEYWORD',
            '  *include',
            'body.k',
            '*NODE',
            '1,0,0,0',
            '2,1,0,0',
            '*ELEMENT_SHELL',
            '1,1,1,2,3,4',
            '*END'
        ].join('\n'));

        const blocks = await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 8 });
        assert.deepEqual(blocks.map(block => block.keyword), [
            '*KEYWORD',
            '*INCLUDE',
            '*NODE',
            '*ELEMENT_SHELL',
            '*END'
        ]);
        assert.equal(blocks[1].startLine, 2);
        assert.equal(blocks[1].keywordStartChar, 2);
        assert.equal(blocks[2].flags.isNodeBlock, true);
        assert.equal(blocks[3].flags.isElementBlock, true);
        assert.ok(blocks[1].endOffset > blocks[1].startOffset);
    });
});
