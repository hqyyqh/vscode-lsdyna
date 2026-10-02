const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanKeywordSkeletonFromFile } = require('../../../out/core/scanner/keywordSkeletonScanner');

function createGeneratedDeck(targetSizeBytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-benchmark-'));
    const filePath = path.join(dir, 'generated.k');
    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, '*KEYWORD\n*NODE\n');
    let written = 15;
    let nodeId = 1;
    while (written < targetSizeBytes) {
        const line = `${nodeId},0.0,0.0,0.0\n`;
        fs.writeSync(fd, line);
        written += Buffer.byteLength(line);
        nodeId++;
        if (nodeId % 100000 === 0) {
            fs.writeSync(fd, '*ELEMENT_SHELL\n');
            written += 15;
        }
    }
    fs.writeSync(fd, '*END\n');
    fs.closeSync(fd);
    return filePath;
}

describe('scanner benchmark smoke test', function () {
    this.timeout(20000);

    it('scans a generated 10MB deck without splitting every line into strings', async () => {
        const filePath = createGeneratedDeck(10 * 1024 * 1024);
        const startedAt = Date.now();
        const blocks = await scanKeywordSkeletonFromFile(filePath);
        const durationMs = Date.now() - startedAt;
        assert.ok(blocks.length >= 3);
        assert.equal(blocks[0].keyword, '*KEYWORD');
        assert.equal(blocks[blocks.length - 1].keyword, '*END');
        assert.ok(durationMs < 20000);
    });
});
