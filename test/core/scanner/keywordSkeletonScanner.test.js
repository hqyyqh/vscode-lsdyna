const assert = require('assert');
const makeTempDirectory = require('../../support/tempDirectories').trackTempDirectories();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanKeywordSkeletonFromFile } = require('../../../out/core/scanner/keywordSkeletonScanner');

function writeFixture(name, text) {
    const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-skeleton-'));
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, text);
    return filePath;
}

describe('scanKeywordSkeletonFromFile', () => {
    it('records conservative parameter candidates in mesh fast paths and final lines', async () => {
        const text = '*NODE\n1,0,0,0\n2,&base,0,0\n*ELEMENT_MASS\n1,2,<base+1>\n*NODE\n3,0,0,0\n*NODE\n4,&last,0,0';
        for (const highWaterMark of [7, 1024]) {
            const blocks = await scanKeywordSkeletonFromFile(writeFixture('parameter-markers.k', text), { highWaterMark });
            assert.deepEqual(blocks.map(block => block.parameterCandidates), [true, true, false, true]);
        }
    });

    it('counts mesh rows after prefix capture without changing physical positions', async () => {
        const text = '*NODE\r\n1,0,0,0\r\n  2,1,0,0\r\n$ comment\r\n\r\n  3,2,0,0\r\n*END\r\n';
        const file = writeFixture('mesh-prefix.k', text);
        const positions = [];
        let captured = 0;
        const blocks = await scanKeywordSkeletonFromFile(file, {
            highWaterMark: 13,
            onLineStart: (line, offset) => positions.push([line, offset]),
            createBlockSummaryAccumulator: () => ({
                acceptLine: () => { captured++; return captured === 1; },
                isCaptureComplete: () => captured >= 1,
                finish: ({ dataLineCount }) => ({ count: dataLineCount }),
            }),
        });
        assert.equal(captured, 1);
        assert.equal(blocks[0].dataLineCount, 3);
        assert.equal(blocks[0].displayIdentity.count, 3);
        assert.equal(blocks[0].displaySourceEndLine, 1);
        assert.deepEqual(positions.map(([line, offset]) => [line, text.slice(offset).split('\r\n')[0]]),
            text.split('\r\n').slice(0, -1).map((text, line) => [line, text]));
        assert.equal(blocks[1].startOffset, text.indexOf('*END'));
    });

    it('preserves global and separated local format controls across chunks without changing keyword identities', async () => {
        const lines = ['*KEYWORD LONG=Y', '\t*contact_nurbs_tied_edge_to_edge +',
            '*PART, %', '*NODE - $ LONG=Y', '*ELEMENT_BEAM+', '*KEYWORD $ LONG=Y'];
        const blocks = await scanKeywordSkeletonFromFile(writeFixture('format-controls.k', lines.join('\r\n')),
            { highWaterMark: 5 });
        const { keywordInputFormat, globalInputFormatFromKeywordLine } = require('../../../out/core/parser/inputFormat');
        assert.deepEqual(blocks.map(block => block.keyword), ['*KEYWORD', '*CONTACT_NURBS_TIED_EDGE_TO_EDGE',
            '*PART', '*NODE', '*ELEMENT_BEAM+', '*KEYWORD']);
        assert.deepEqual(blocks.map(block => block.rawKeyword), ['*KEYWORD LONG=Y',
            '*contact_nurbs_tied_edge_to_edge +', '*PART, %', '*NODE -', '*ELEMENT_BEAM+', '*KEYWORD']);
        assert.equal(globalInputFormatFromKeywordLine(blocks[0].rawKeyword), 'long');
        assert.deepEqual(blocks.slice(1, 5).map(block => keywordInputFormat(block.rawKeyword, 'long')),
            ['long', 'i10', 'standard', 'long']);
        assert.equal(globalInputFormatFromKeywordLine(blocks[5].rawKeyword), 'standard');
        assert.equal(blocks[1].keywordStartChar, 1);
    });

    it('yields during a sub-megabyte scan without changing record identities or offsets', async () => {
        const filePath = writeFixture('responsive.k', '*DATABASE_BINARY_BLSTFOR\n10,1,1,1,1\n'.repeat(2000) + '*END\n');
        const expected = await scanKeywordSkeletonFromFile(filePath, { yieldInterval: 50000 });
        const original = global.setImmediate;
        let yields = 0;
        global.setImmediate = (...args) => { yields++; return original(...args); };
        try {
            assert.deepStrictEqual(await scanKeywordSkeletonFromFile(filePath), expected);
            assert.ok(yields > 0, 'A small file with many blocks must not run in one synchronous chunk');
        } finally { global.setImmediate = original; }
    });
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

    it('handles lowercase keywords, CRLF, chunk boundaries, and final line without newline', async () => {
        const filePath = writeFixture('crlf.k', '*keyword\r\n\t*part\r\n$ comment\r\n*end');
        const blocks = await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 5 });

        assert.deepEqual(blocks.map(block => block.keyword), ['*KEYWORD', '*PART', '*END']);
        assert.equal(blocks[0].startLine, 0);
        assert.equal(blocks[1].startLine, 1);
        assert.equal(blocks[1].keywordStartChar, 1);
        assert.equal(blocks[2].endLine, 3);
        assert.equal(blocks[2].endOffset, fs.statSync(filePath).size);
    });

    it('keeps COMMENT bodies opaque until a column-zero asterisk', async () => {
        const filePath = writeFixture('comment.k', [
            '*KEYWORD',
            '*COMMENT   *INCLUDE',
            'fake-child.k',
            '  *NODE',
            '$*END',
            '*COMMENT_NOECHO',
            '*PRIVATE_TERMINATOR',
            '*END',
        ].join('\n'));
        const blocks = await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 7 });

        assert.deepEqual(blocks.map(block => block.keyword), [
            '*KEYWORD', '*COMMENT', '*COMMENT_NOECHO', '*PRIVATE_TERMINATOR', '*END',
        ]);
        assert.equal(blocks[1].opaqueKind, 'comment');
        assert.equal(blocks[1].opaqueStartCharacter, 8);
        assert.equal(blocks[1].startLine, 1);
        assert.equal(blocks[1].endLine, 4);
        assert.equal(blocks[1].dataLineCount, 0);
        assert.equal(blocks[2].opaqueKind, 'comment-noecho');
        assert.equal(blocks[2].endLine, 5);
        assert.equal(blocks[3].startLine, 6);
    });

    it('ends an opaque range on a bare column-zero asterisk without attributing later text', async () => {
        const filePath = writeFixture('bare-boundary.k', [
            '*COMMENT',
            'hidden',
            '*',
            'not keyword data',
            '  *PART',
            '*END',
        ].join('\n'));
        const blocks = await scanKeywordSkeletonFromFile(filePath, { highWaterMark: 4 });

        assert.deepEqual(blocks.map(block => block.keyword), ['*COMMENT', '*PART', '*END']);
        assert.equal(blocks[0].endLine, 1);
        assert.equal(blocks[1].startLine, 4);
        assert.equal(blocks[1].dataLineCount, 0);
    });
});
