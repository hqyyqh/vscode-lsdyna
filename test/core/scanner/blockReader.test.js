const assert = require('assert');
const makeTempDirectory = require('../../support/tempDirectories').trackTempDirectories();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanKeywordSkeletonFromFile } = require('../../../out/core/scanner/keywordSkeletonScanner');
const { readBlockBuffer, readBlockText } = require('../../../out/core/scanner/blockReader');

describe('readBlockText', () => {
    it('rejects a stale block range instead of returning a silently incomplete block', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-block-stale-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '*NODE\n1,0,0,0\n');
        const endOffset = fs.statSync(filePath).size;
        fs.truncateSync(filePath, 6);
        await assert.rejects(readBlockText({ filePath, startOffset: 0, endOffset }),
            /unexpected end of file/);
    });

    it('reads only the requested LS-DYNA keyword block byte range', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-block-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '*KEYWORD\n*INCLUDE\nbody.k\n*END\n');

        const blocks = await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 6 });
        const includeBlock = blocks.find(block => block.keyword === '*INCLUDE');
        const text = await readBlockText(includeBlock);
        assert.equal(text, '*INCLUDE\nbody.k\n');
    });

    it('caps definition previews by bytes and reports truncation without allocating the full block', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-block-cap-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '0123456789abcdefghijklmnopqrstuvwxyz');
        const truncated = [];

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
    });

    it('checks cancellation between bounded file-read chunks', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-block-cancel-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, 'x'.repeat(128));
        let checks = 0;
        const cancellationToken = {
            get isCancellationRequested() {
                checks += 1;
                return checks >= 4;
            },
        };

        await assert.rejects(
            readBlockBuffer({ filePath, startOffset: 0, endOffset: 128 }, {
                chunkBytes: 8,
                cancellationToken,
            }),
            error => error?.name === 'CancellationError',
        );
        assert.ok(checks >= 4);
    });
});


describe('shared block handle', () => {
    it('keeps the caller handle open across reads and truncation failures', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-handle-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '0123456789');
        const handle = await fs.promises.open(filePath, 'r');
        try {
            assert.equal(await readBlockText({ filePath, startOffset: 2, endOffset: 5 }, 'utf8', { handle }), '234');
            await assert.rejects(readBlockText({ filePath, startOffset: 8, endOffset: 15 }, 'utf8', { handle }), /unexpected end/);
            assert.equal(await readBlockText({ filePath, startOffset: 5, endOffset: 8 }, 'utf8', { handle }), '567');
        } finally { await handle.close(); }
    });
});


describe('bounded block read window', () => {
    it('reuses adjacent reads, reloads on seeks and rejects incomplete ranges', async () => {
        const source = Buffer.from('0123456789abcdefghijklmn');
        let reads = 0;
        const handle = require('../../../out/core/scanner/blockReader').createBlockReadWindow({
            async read(buffer, offset, length, position) {
                reads++;
                const bytesRead = Math.max(0, Math.min(length, source.length - position));
                source.copy(buffer, offset, position, position + bytesRead);
                return { bytesRead, buffer };
            },
        }, 8);
        const read = (startOffset, endOffset) => readBlockText({ startOffset, endOffset }, 'utf8', { handle });
        assert.equal(await read(0, 3), '012');
        assert.equal(await read(3, 6), '345');
        assert.equal(reads, 1);
        assert.equal(await read(12, 15), 'cde');
        assert.equal(await read(1, 4), '123');
        assert.equal(reads, 3);
        assert.equal(await read(0, 12), '0123456789ab');
        await assert.rejects(read(20, 30), /unexpected end of file/);
    });
});


it('excludes mesh card spellings with format markers without excluding node sets', () => {
    const { isMeshKeyword, isMeshEntityKind } = require('../../../out/core/scanner/scannerContracts');
    for (const keyword of ['*NODE', '*NODE+', '*NODE%', '*NODE-', '*ELEMENT_SHELL+', '*ELEMENT_SOLID'])
        assert.equal(isMeshKeyword(keyword), true, keyword);
    for (const keyword of ['*SET_NODE_LIST', '*PART', '*DEFINE_CURVE']) assert.equal(isMeshKeyword(keyword), false);
    assert.equal(isMeshEntityKind('node-set'), false);
    assert.equal(isMeshEntityKind('element-shell'), true);
});


describe('definition header reads', () => {
    it('reads only a bounded prefix of a large member list while preserving header line positions', async () => {
        const { readBlockHeaderText } = require('../../../out/core/scanner/blockReader');
        const prefix = '*SET_NODE_LIST_TITLE\r\n$ comment\r\n\r\nA set\r\n42,0,0\r\n';
        const source = Buffer.from(prefix + '1,2,3,4,5,6,7,8\r\n'.repeat(100000));
        let bytes = 0, truncated = false;
        const text = await readBlockHeaderText({ startOffset: 0, endOffset: source.length }, 2, {
            maxBytes: source.length, onTruncated: () => truncated = true,
            handle: { read: async (buffer, offset, size, position) => {
                bytes += size; source.copy(buffer, offset, position, position + size); return { bytesRead: size };
            } },
        });
        assert.equal(text, prefix.replace(/\r\n/g, '\n').trimEnd());
        assert.equal(bytes, 4096); assert.equal(truncated, false);
    });
    it('keeps byte-limit uncertainty when comments prevent reaching the definition header', async () => {
        const { readBlockHeaderText } = require('../../../out/core/scanner/blockReader');
        const source = Buffer.from('*SET_NODE_LIST\n$' + 'x'.repeat(20000) + '\n42\n1,2\n');
        let truncated;
        const text = await readBlockHeaderText({ startOffset: 0, endOffset: source.length }, 1, {
            maxBytes: 8192, onTruncated: value => truncated = value,
            handle: { read: async (buffer, offset, size, position) => {
                source.copy(buffer, offset, position, position + size); return { bytesRead: size };
            } },
        });
        assert.equal(Buffer.byteLength(text), 8192); assert.equal(truncated.readBytes, 8192);
    });
    it('stops exact definition disk scans after the ID record, but preserves ordinary full scans', async () => {
        const { scanBlockLinesFromDisk } = require('../../../out/core/references/onDemandDefinitionScanner');
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-set-header-'));
        const filePath = path.join(dir, 'set.k');
        fs.writeFileSync(filePath, '*SET_NODE_LIST_TITLE\n$ comment\nSet name\n42\n' + '1,2,3,4\n'.repeat(10000));
        const block = { filePath, startOffset: 0, endOffset: fs.statSync(filePath).size, startLine: 7 };
        const visited = [];
        const header = await scanBlockLinesFromDisk(block, (line, index) => visited.push([line,index]), null, { dataRecordLimit: 2 });
        assert.equal(header.complete, true); assert.deepEqual(visited, [['$ comment',8],['Set name',9],['42',10]]);
        const { scanOnDemandDefinitions } = require('../../../out/core/references/onDemandDefinitionScanner');
        const definitionKeywords = { onDemand: { SET_NODE_LIST_TITLE: {
            target: 'SET_NODE_LIST_TITLE', targetKind: 'node-set', fieldName: 'SID', fieldType: 'integer',
            fieldIndex: 0, position: 0, width: 10, recordMode: 'exact-data-record-ordinal', dataRecordOrdinal: 1,
        } } };
        const query = await scanOnDemandDefinitions({ effectiveId: 42, targetKinds: ['node-set'], definitionKeywords,
            fileIndexes: new Map([[filePath, { keywordBlocks: [{ ...block, keyword: '*SET_NODE_LIST_TITLE' }] }]]) });
        assert.equal(query.state, 'complete'); assert.equal(query.definitions[0].id, 42);
        assert.equal(query.definitions[0].idLine, 10); assert.equal(query.scannedLineCount, 3);
        const full = await scanBlockLinesFromDisk(block, () => {});
        assert.equal(full.lineCount, 10003);
        assert.equal((await scanBlockLinesFromDisk(block, () => {}, { isCancellationRequested: true }, { dataRecordLimit: 2 })).cancelled, true);
    });
});
