const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanKeywordSkeletonFromFile } = require('../../../out/core/scanner/keywordSkeletonScanner');
const { readBlockBuffer, readBlockText } = require('../../../out/core/scanner/blockReader');

describe('readBlockText', () => {
    it('rejects a stale block range instead of returning a silently incomplete block', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-block-stale-'));
        const filePath = path.join(dir, 'main.k');
        try {
            fs.writeFileSync(filePath, '*NODE\n1,0,0,0\n');
            const endOffset = fs.statSync(filePath).size;
            fs.truncateSync(filePath, 6);
            await assert.rejects(readBlockText({ filePath, startOffset: 0, endOffset }),
                /unexpected end of file/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reads only the requested LS-DYNA keyword block byte range', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-block-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '*KEYWORD\n*INCLUDE\nbody.k\n*END\n');

        const blocks = await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 6 });
        const includeBlock = blocks.find(block => block.keyword === '*INCLUDE');
        const text = await readBlockText(includeBlock);
        assert.equal(text, '*INCLUDE\nbody.k\n');
    });

    it('caps definition previews by bytes and reports truncation without allocating the full block', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-block-cap-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '0123456789abcdefghijklmnopqrstuvwxyz');
        const truncated = [];

        try {
            const buffer = await readBlockBuffer({
                filePath,
                startOffset: 0,
                endOffset: 36,
            }, {
                maxBytes: 10,
                chunkBytes: 3,
                onTruncated: details => truncated.push(details),
            });
            assert.equal(buffer.toString('utf8'), '0123456789');
            assert.deepEqual(truncated, [{ totalBytes: 36, readBytes: 10 }]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('checks cancellation between bounded file-read chunks', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-block-cancel-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, 'x'.repeat(128));
        let checks = 0;
        const cancellationToken = {
            get isCancellationRequested() {
                checks += 1;
                return checks >= 4;
            },
        };

        try {
            await assert.rejects(
                readBlockBuffer({ filePath, startOffset: 0, endOffset: 128 }, {
                    chunkBytes: 8,
                    cancellationToken,
                }),
                error => error?.name === 'CancellationError',
            );
            assert.ok(checks >= 4);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});


describe('shared block handle', () => {
    it('keeps the caller handle open across reads and truncation failures', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-handle-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '0123456789');
        const handle = await fs.promises.open(filePath, 'r');
        try {
            assert.equal(await readBlockText({ filePath, startOffset: 2, endOffset: 5 }, 'utf8', { handle }), '234');
            await assert.rejects(readBlockText({ filePath, startOffset: 8, endOffset: 15 }, 'utf8', { handle }), /unexpected end/);
            assert.equal(await readBlockText({ filePath, startOffset: 5, endOffset: 8 }, 'utf8', { handle }), '567');
        } finally { await handle.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
