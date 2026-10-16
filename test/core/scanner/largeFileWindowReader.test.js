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
        const bounded = await readLargeFileWindow(filePath, { stride: 4096, lineCount: lines.length,
            baseLine: 4096, offsets: [index.largeFileLineMap.offsets[1]] }, 4097);
        assert.deepEqual(bounded.lines, window.lines);
    });

    it('continues before indexing, preserving byte cursors across BOM, CRLF and truncated lines', async () => {
        const filePath = path.join(root, 'progress.key');
        const rows = ['\ufeff*KEYWORD', '中'.repeat(30000), ...Array.from({ length: 1000 }, (_, i) => `row-${i}`)];
        fs.writeFileSync(filePath, rows.join('\r\n'));
        let page = await readLargeFileWindow(filePath, null, 0, { maxLines: 2 });
        assert.equal(page.lineCount, undefined);
        assert.equal(page.lines[1].truncated, true);
        assert.deepEqual(page.cursor, { line: 2, offset: Buffer.byteLength(rows.slice(0, 2).join('\r\n') + '\r\n') });
        const partial = { stride: 4096, offsets: [0], lineCount: 2, complete: false };
        page = await readLargeFileWindow(filePath, partial, 2, { cursor: page.cursor, maxLines: 300 });
        assert.equal(page.lines[0].text, 'row-0');
        assert.equal(page.lines.at(-1).text, 'row-299');
        while (page.lineCount === undefined) page = await readLargeFileWindow(filePath, partial, page.cursor.line, { cursor: page.cursor });
        assert.equal(page.lineCount, rows.length);
        assert.equal(page.lines.at(-1).text, 'row-999');
        const beyond = await readLargeFileWindow(filePath, partial, rows.length + 200);
        assert.equal(beyond.lineCount, rows.length);
        assert.deepEqual(beyond.lines, []);
    });

    it('reports actual scanned bytes and only closed keyword blocks before completion', async () => {
        const filePath = path.join(root, 'partial.key');
        fs.writeFileSync(filePath, '*KEYWORD I10\r\n*MAT_ELASTIC\r\n         7\r\n*NODE\r\n' + '       1       0\r\n'.repeat(1000) + '*END');
        const samples = [];
        const index = await buildFileIndex(filePath, { largeFileThresholdBytes: 0, highWaterMark: 101,
            onLargeFileProgress: value => samples.push({ bytes: value.scannedBytes, lines: value.largeFileLineMap.lineCount,
                keywords: value.keywordBlocks.map(block => block.keyword) }) });
        assert(samples.some(value => value.bytes > 0 && value.bytes < index.size && value.keywords.includes('*MAT_ELASTIC') && !value.keywords.includes('*NODE')));
        assert.equal(samples.at(-1).bytes, index.size);
        assert.equal(samples.at(-1).lines, index.largeFileLineMap.lineCount);
        assert(samples.every((value, i) => !i || value.bytes >= samples[i - 1].bytes));
    });

    it('does not send byte progress to the existing semantic progress callback', async () => {
        const filePath = path.join(root, 'small.key');
        fs.writeFileSync(filePath, '*KEYWORD\n*MAT_ELASTIC\n         7    7.8e-9    210000       0.3\n*END');
        const events=[];
        await buildFileIndex(filePath, { highWaterMark:16,onProgress:event=>events.push(event) });
        assert(events.length > 0);
        assert(events.every(event=>typeof event === 'object' && event.phase === 'references'));
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
