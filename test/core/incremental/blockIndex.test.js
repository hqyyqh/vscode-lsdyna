'use strict';

const assert = require('assert');
const { BlockIndex } = require('../../../src/core/incremental/blockIndex');

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
});
