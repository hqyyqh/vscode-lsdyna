'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectBlocksFromLineReader, collectBlocksFromFile } = require('../../../src/core/parser/blockScanner');

describe('blockScanner', () => {
    it('splits blocks on indented mixed-case keywords', () => {
        const lines = [' \t*Keyword', 'data', '\t*node', '1,2,3'];
        const blocks = collectBlocksFromLineReader(lines.length, i => lines[i]);

        assert.deepStrictEqual(blocks, [
            { keyword: 'KEYWORD', startLine: 0, endLine: 1 },
            { keyword: 'NODE', startLine: 2, endLine: 3 },
        ]);
    });

    it('collects keyword blocks with correct start and end lines from line reader', () => {
        const lines = [
            '*KEYWORD',
            '*CONTROL_TERMINATION',
            '123',
            '*NODE',
            '1,2,3',
            '4,5,6',
            '*END'
        ];
        const blocks = collectBlocksFromLineReader(lines.length, i => lines[i]);
        assert.deepEqual(blocks, [
            { keyword: 'KEYWORD', startLine: 0, endLine: 0 },
            { keyword: 'CONTROL_TERMINATION', startLine: 1, endLine: 2 },
            { keyword: 'NODE', startLine: 3, endLine: 5 },
            { keyword: 'END', startLine: 6, endLine: 6 }
        ]);
    });

    it('collects keyword blocks from file asynchronously', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-block-scanner-'));
        const filePath = path.join(tempDir, 'blocks.k');
        fs.writeFileSync(
            filePath,
            '*KEYWORD\n*CONTROL_TERMINATION\n123\n*NODE\n1,2,3\n*END\n',
            'utf8'
        );

        const blocks = await collectBlocksFromFile(filePath);
        assert.deepEqual(blocks, [
            { keyword: 'KEYWORD', startLine: 0, endLine: 0 },
            { keyword: 'CONTROL_TERMINATION', startLine: 1, endLine: 2 },
            { keyword: 'NODE', startLine: 3, endLine: 4 },
            { keyword: 'END', startLine: 5, endLine: 5 }
        ]);
    });
});
