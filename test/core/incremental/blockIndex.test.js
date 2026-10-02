'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BlockIndex } = require('../../../src/core/incremental/blockIndex');
const { createKeywordIdentityAccumulatorFactory } = require('../../../src/core/keywordDisplayIdentity');

describe('BlockIndex', () => {
    it('builds block index from line reader', () => {
        const lines = [
            '*KEYWORD',
            '*CONTROL_TERMINATION',
            '123',
            '*NODE',
            '1,2,3',
            '*END'
        ];
        const blockIndex = new BlockIndex('test.k');
        blockIndex.buildIndex(lines.length, i => lines[i]);

        assert.deepEqual(blockIndex.blocks, [
            { keyword: 'KEYWORD', startLine: 0, endLine: 0 },
            { keyword: 'CONTROL_TERMINATION', startLine: 1, endLine: 2 },
            { keyword: 'NODE', startLine: 3, endLine: 4 },
            { keyword: 'END', startLine: 5, endLine: 5 }
        ]);

        assert.deepEqual(blockIndex.getKeywords(), [
            { keyword: 'KEYWORD', filePath: 'test.k', lineIndex: 0 },
            { keyword: 'CONTROL_TERMINATION', filePath: 'test.k', lineIndex: 1 },
            { keyword: 'NODE', filePath: 'test.k', lineIndex: 3 },
            { keyword: 'END', filePath: 'test.k', lineIndex: 5 }
        ]);
    });

    it('handles incremental updates with line count additions', () => {
        let lines = [
            '*KEYWORD',
            '*CONTROL_TERMINATION',
            '123',
            '*NODE',
            '1,2,3',
            '*END'
        ];

        const blockIndex = new BlockIndex('test.k');
        blockIndex.buildIndex(lines.length, i => lines[i]);

        // Insert 2 lines inside *NODE block (between lines 3 and 4)
        // Edit old range [4, 4] with 3 lines: '1,2,3', '4,5,6', '7,8,9'
        const newText = '1,2,3\n4,5,6\n7,8,9';
        lines = [
            '*KEYWORD',
            '*CONTROL_TERMINATION',
            '123',
            '*NODE',
            '1,2,3',
            '4,5,6',
            '7,8,9',
            '*END'
        ];

        blockIndex.updateIndex(
            { startLine: 4, endLine: 4 },
            newText,
            lines.length,
            i => lines[i]
        );

        assert.deepEqual(blockIndex.blocks, [
            { keyword: 'KEYWORD', startLine: 0, endLine: 0 },
            { keyword: 'CONTROL_TERMINATION', startLine: 1, endLine: 2 },
            { keyword: 'NODE', startLine: 3, endLine: 6 },
            { keyword: 'END', startLine: 7, endLine: 7 }
        ]);
    });

    it('handles incremental updates with line count deletions', () => {
        let lines = [
            '*KEYWORD',
            '*CONTROL_TERMINATION',
            '123',
            '*NODE',
            '1,2,3',
            '4,5,6',
            '*END'
        ];

        const blockIndex = new BlockIndex('test.k');
        blockIndex.buildIndex(lines.length, i => lines[i]);

        // Delete lines 4-5 ('1,2,3\n4,5,6') and replace with '8,8,8' (1 line)
        // lineDelta = 1 - 2 = -1
        lines = [
            '*KEYWORD',
            '*CONTROL_TERMINATION',
            '123',
            '*NODE',
            '8,8,8',
            '*END'
        ];

        blockIndex.updateIndex(
            { startLine: 4, endLine: 5 },
            '8,8,8',
            lines.length,
            i => lines[i]
        );

        assert.deepEqual(blockIndex.blocks, [
            { keyword: 'KEYWORD', startLine: 0, endLine: 0 },
            { keyword: 'CONTROL_TERMINATION', startLine: 1, endLine: 2 },
            { keyword: 'NODE', startLine: 3, endLine: 4 },
            { keyword: 'END', startLine: 5, endLine: 5 }
        ]);
    });

    it('splits a block when a new keyword is inserted', () => {
        let lines = [
            '*KEYWORD',
            '*CONTROL_TERMINATION',
            '123',
            '*NODE',
            '1,2,3',
            '*END'
        ];

        const blockIndex = new BlockIndex('test.k');
        blockIndex.buildIndex(lines.length, i => lines[i]);

        // Insert '*ELEMENT_SHELL\n999' inside *NODE block (lines 4-4)
        // Replacing '1,2,3' with '1,2,3\n*ELEMENT_SHELL\n999'
        lines = [
            '*KEYWORD',
            '*CONTROL_TERMINATION',
            '123',
            '*NODE',
            '1,2,3',
            '*ELEMENT_SHELL',
            '999',
            '*END'
        ];

        blockIndex.updateIndex(
            { startLine: 4, endLine: 4 },
            '1,2,3\n*ELEMENT_SHELL\n999',
            lines.length,
            i => lines[i]
        );

        assert.deepEqual(blockIndex.blocks, [
            { keyword: 'KEYWORD', startLine: 0, endLine: 0 },
            { keyword: 'CONTROL_TERMINATION', startLine: 1, endLine: 2 },
            { keyword: 'NODE', startLine: 3, endLine: 4 },
            { keyword: 'ELEMENT_SHELL', startLine: 5, endLine: 6 },
            { keyword: 'END', startLine: 7, endLine: 7 }
        ]);
    });

    it('merges blocks when a keyword line is deleted', () => {
        let lines = [
            '*KEYWORD',
            '*CONTROL_TERMINATION',
            '123',
            '*NODE',
            '1,2,3',
            '*ELEMENT_SHELL',
            '999',
            '*END'
        ];

        const blockIndex = new BlockIndex('test.k');
        blockIndex.buildIndex(lines.length, i => lines[i]);

        // Delete '*ELEMENT_SHELL' at line 5
        // Replacing lines 5-5 with empty string
        lines = [
            '*KEYWORD',
            '*CONTROL_TERMINATION',
            '123',
            '*NODE',
            '1,2,3',
            '999',
            '*END'
        ];

        blockIndex.updateIndex(
            { startLine: 5, endLine: 5 },
            '',
            lines.length,
            i => lines[i]
        );

        assert.deepEqual(blockIndex.blocks, [
            { keyword: 'KEYWORD', startLine: 0, endLine: 0 },
            { keyword: 'CONTROL_TERMINATION', startLine: 1, endLine: 2 },
            { keyword: 'NODE', startLine: 3, endLine: 5 },
            { keyword: 'END', startLine: 6, endLine: 6 }
        ]);
    });

    it('builds a live document index in cancellable chunks without publishing partial results', async () => {
        const blockIndex = new BlockIndex('test.k');
        blockIndex.buildIndex(2, index => ['*KEYWORD', '*END'][index]);
        const originalBlocks = blockIndex.blocks.map(block => ({ ...block }));
        const lines = [
            '*KEYWORD',
            '*PART',
            'Door inner',
            '10,20,30',
            '*NODE',
            '1,0,0,0',
            '*END',
        ];
        let cancellationChecks = 0;
        const completed = await blockIndex.buildIndexAsync(
            lines.length,
            index => lines[index],
            {
                yieldInterval: 2,
                shouldCancel: () => ++cancellationChecks > 1,
            },
        );

        assert.equal(completed, false);
        assert.deepEqual(blockIndex.blocks, originalBlocks);
        assert.equal(blockIndex.lineCount, 2);

        const rebuilt = await blockIndex.buildIndexAsync(
            lines.length,
            index => lines[index],
            { yieldInterval: 2 },
        );
        assert.equal(rebuilt, true);
        assert.deepEqual(blockIndex.blocks.map(block => block.keyword), ['KEYWORD', 'PART', 'NODE', 'END']);
    });

    it('keeps a deep numeric edit in a million-row NODE block bounded', () => {
        const blockIndex = new BlockIndex('huge.k', {
            createBlockSummaryAccumulator: createKeywordIdentityAccumulatorFactory(),
            maxIncrementalRescanLines: 1000,
        });
        blockIndex.lineCount = 1000002;
        blockIndex.blocks = [
            {
                keyword: 'NODE',
                startLine: 0,
                endLine: 1000000,
                dataLineCount: 1000000,
                displaySourceEndLine: 32,
                displayIdentity: {
                    kind: 'collection',
                    keyword: 'NODE',
                    canonicalKeyword: 'NODE',
                    collection: { kind: 'data-lines', count: 1000000 },
                    dataLineCount: 1000000,
                    confidence: 'verified',
                },
            },
            { keyword: 'END', startLine: 1000001, endLine: 1000001 },
        ];
        let lineReads = 0;
        const updated = blockIndex.updateIndex(
            { startLine: 900000, endLine: 900000, startCharacter: 12, endCharacter: 20 },
            '1.25',
            1000002,
            lineIndex => {
                lineReads++;
                return lineIndex === 1000001 ? '*END' : `${lineIndex},0,0,0`;
            },
        );

        assert.equal(updated, true);
        assert.ok(lineReads <= 2, `deep value edit read ${lineReads} lines`);
        assert.equal(blockIndex.blocks[0].endLine, 1000000);
        assert.equal(blockIndex.blocks[0].displayIdentity.collection.count, 1000000);
    });

    it('keeps the published disk index unchanged when a file scan is cancelled', async () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'block-index-cancel-'));
        const filePath = path.join(tempRoot, 'main.k');
        fs.writeFileSync(filePath, '*KEYWORD\n*PART\npart\n*END\n', 'utf8');
        const blockIndex = new BlockIndex(filePath);
        blockIndex.blocks = [{ keyword: 'PREVIOUS', startLine: 0, endLine: 0 }];
        blockIndex.lineCount = 1;

        try {
            await assert.rejects(
                blockIndex.buildIndexFromFile(filePath, {
                    cancellationToken: { isCancellationRequested: true },
                }),
                error => error?.name === 'CancellationError',
            );
            assert.deepEqual(blockIndex.blocks, [{ keyword: 'PREVIOUS', startLine: 0, endLine: 0 }]);
            assert.equal(blockIndex.lineCount, 1);
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('defers an oversized structural rescan without mutating the published index', () => {
        const blockIndex = new BlockIndex('huge.k', { maxIncrementalRescanLines: 1000 });
        blockIndex.lineCount = 1000002;
        blockIndex.blocks = [
            { keyword: 'NODE', startLine: 0, endLine: 1000000 },
            { keyword: 'END', startLine: 1000001, endLine: 1000001 },
        ];
        const originalBlocks = blockIndex.blocks.map(block => ({ ...block }));
        const updated = blockIndex.updateIndex(
            { startLine: 500000, endLine: 500000, startCharacter: 0, endCharacter: 0 },
            '*ELEMENT_SHELL\n1,1,2,3,4',
            1000003,
            () => { throw new Error('oversized rescan must be deferred before reading lines'); },
        );

        assert.equal(updated, false);
        assert.equal(blockIndex.lineCount, 1000002);
        assert.deepEqual(blockIndex.blocks, originalBlocks);
    });

    it('models COMMENT control metadata and ignores indented pseudo-keywords in its body', () => {
        const lines = [
            '*KEYWORD',
            '*COMMENT *INCLUDE',
            'fake.k',
            '  *NODE',
            '$*END',
            '*PART',
            '*END',
        ];
        const blockIndex = new BlockIndex('comment.k');
        blockIndex.buildIndex(lines.length, index => lines[index]);

        assert.deepEqual(blockIndex.blocks, [
            { keyword: 'KEYWORD', startLine: 0, endLine: 0 },
            {
                keyword: 'COMMENT',
                startLine: 1,
                endLine: 4,
                opaqueKind: 'comment',
                opaqueStartCharacter: 8,
            },
            { keyword: 'PART', startLine: 5, endLine: 5 },
            { keyword: 'END', startLine: 6, endLine: 6 },
        ]);
    });

    it('rebuilds COMMENT boundaries when a terminator moves to column zero', () => {
        let lines = [
            '*COMMENT',
            '  *PART',
            'hidden',
            '*END',
        ];
        const blockIndex = new BlockIndex('comment.k');
        blockIndex.buildIndex(lines.length, index => lines[index]);
        assert.equal(blockIndex.blocks[0].endLine, 2);

        lines = [
            '*COMMENT',
            '*PART',
            'active',
            '*END',
        ];
        const updated = blockIndex.updateIndex(
            { startLine: 1, endLine: 1, startCharacter: 0, endCharacter: 2 },
            '',
            lines.length,
            index => lines[index],
        );
        assert.equal(updated, true);
        assert.deepEqual(blockIndex.blocks.map(block => [block.keyword, block.startLine, block.endLine]), [
            ['COMMENT', 0, 0],
            ['PART', 1, 2],
            ['END', 3, 3],
        ]);
    });

    it('rebuilds an adjacent COMMENT when a bare asterisk boundary is removed', () => {
        let lines = ['*COMMENT', 'hidden', '*', 'active text', '  *PART', '*END'];
        const blockIndex = new BlockIndex('comment.k');
        blockIndex.buildIndex(lines.length, index => lines[index]);
        assert.deepEqual(blockIndex.blocks.map(block => [block.keyword, block.startLine, block.endLine]), [
            ['COMMENT', 0, 1],
            ['PART', 4, 4],
            ['END', 5, 5],
        ]);

        lines = ['*COMMENT', 'hidden', ' *', 'active text', '  *PART', '*END'];
        const updated = blockIndex.updateIndex(
            { startLine: 2, endLine: 2, startCharacter: 0, endCharacter: 0 },
            ' ',
            lines.length,
            index => lines[index],
        );
        assert.equal(updated, true);
        assert.deepEqual(blockIndex.blocks.map(block => [block.keyword, block.startLine, block.endLine]), [
            ['COMMENT', 0, 4],
            ['END', 5, 5],
        ]);
    });
});
