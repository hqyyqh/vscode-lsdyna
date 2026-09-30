'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    LARGE_FILE_LINE_MAX_BYTES,
    readLargeFileWindow,
    searchLargeFileLiteral,
} = require('../../../out/core/scanner/largeFileWindowReader');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');

describe('largeFileWindowReader', () => {
    let root;

    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-large-window-')); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    it('builds sparse byte checkpoints during the existing skeleton pass', async () => {
        const filePath = path.join(root, 'mapped.key');
        const lines = ['\ufeff*KEYWORD'];
        for (let index = 1; index < 8200; index++) lines.push(`line-${index}`);
        fs.writeFileSync(filePath, lines.join('\r\n'));

        const index = await buildFileIndex(filePath, { largeFileThresholdBytes: 1, highWaterMark: 73 });
        assert.equal(index.largeFileLineMap.stride, 4096);
        assert.equal(index.largeFileLineMap.lineCount, lines.length);
        assert.equal(index.largeFileLineMap.offsets.length, 3);

        const window = await readLargeFileWindow(filePath, index.largeFileLineMap, 4097);
        assert.equal(window.stale, false);
        assert.equal(window.lines[0].lineNumber, 4097);
        assert.equal(window.lines[0].text, 'line-4097');
        assert.ok(window.lines.length <= 240);
    });

    it('bounds pathological lines and detects stale signatures', async () => {
        const filePath = path.join(root, 'long.key');
        fs.writeFileSync(filePath, `*KEYWORD\n${'X'.repeat(LARGE_FILE_LINE_MAX_BYTES + 100)}\n*END`);
        const index = await buildFileIndex(filePath, { largeFileThresholdBytes: 1 });
        const window = await readLargeFileWindow(filePath, index.largeFileLineMap, 1);
        assert.equal(window.lines[0].text.length, LARGE_FILE_LINE_MAX_BYTES);
        assert.equal(window.lines[0].truncated, true);

        const stale = await readLargeFileWindow(filePath, index.largeFileLineMap, 0, {
            expectedSignature: { size: index.size + 1, mtimeMs: index.mtimeMs },
        });
        assert.equal(stale.stale, true);
        assert.deepEqual(stale.lines, []);
    });

    it('searches case-insensitive literals and caps verified matches', async () => {
        const filePath = path.join(root, 'search.key');
        fs.writeFileSync(filePath, Array.from({ length: 510 }, (_, index) => `Curve Match ${index}`).join('\n'));
        const result = await searchLargeFileLiteral(filePath, 'curve match');
        assert.equal(result.matches.length, 500);
        assert.equal(result.matches[0].lineNumber, 0);
        assert.equal(result.truncated, true);
        assert.equal(result.stale, false);
    });
});
