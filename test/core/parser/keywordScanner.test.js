'use strict';
const makeTempDirectory = require('../../support/tempDirectories').trackTempDirectories();

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    collectKeywordsFromFile,
    collectKeywordsFromLineReader,
} = require('../../../src/core/parser/keywordScanner');

describe('keywordScanner', () => {
    it('suppresses pseudo-keywords inside COMMENT ranges for live line readers', () => {
        const lines = ['*COMMENT', '  *NODE', '$*END', '*PART'];
        const keywords = collectKeywordsFromLineReader(lines.length, index => lines[index], 'live.k');
        assert.deepEqual(keywords.map(entry => entry.keyword), ['COMMENT', 'PART']);
    });

    it('normalizes indented mixed-case keyword usages', async () => {
        const tempDir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-keyword-case-'));
        const filePath = path.join(tempDir, 'mixed-case.k');
        fs.writeFileSync(filePath, ' \t*Keyword\ndata\n\t*node\n', 'utf8');

        const keywords = await collectKeywordsFromFile(filePath);

        assert.deepStrictEqual(
            keywords.map(({ keyword, lineIndex }) => ({ keyword, lineIndex })),
            [
                { keyword: 'KEYWORD', lineIndex: 0 },
                { keyword: 'NODE', lineIndex: 2 },
            ]
        );
    });

    it('streams keyword usages with file path and line indexes', async () => {
        const tempDir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-keyword-scanner-'));
        const filePath = path.join(tempDir, 'keywords.k');

        fs.writeFileSync(
            filePath,
            '*KEYWORD\n*CONTROL_TERMINATION\n123\n*NODE\n1,2,3\n*END\n',
            'utf8'
        );

        const keywords = await collectKeywordsFromFile(filePath);

        assert.deepEqual(
            keywords.map(({ keyword, lineIndex }) => ({ keyword, lineIndex })),
            [
                { keyword: 'KEYWORD', lineIndex: 0 },
                { keyword: 'CONTROL_TERMINATION', lineIndex: 1 },
                { keyword: 'NODE', lineIndex: 3 },
                { keyword: 'END', lineIndex: 5 },
            ]
        );
        assert.ok(keywords.every(entry => entry.filePath === filePath));
    });

    it('ignores non-keyword lines while preserving order', async () => {
        const tempDir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-keyword-scanner-'));
        const filePath = path.join(tempDir, 'mixed.k');

        fs.writeFileSync(
            filePath,
            '$ comment\n\n*PART\npart data\n*MAT_ELASTIC\n',
            'utf8'
        );

        const keywords = await collectKeywordsFromFile(filePath);

        assert.deepEqual(
            keywords.map(entry => entry.keyword),
            ['PART', 'MAT_ELASTIC']
        );
    });

    it('does not miss middle keywords in large files with default or legacy scan options', async () => {
        const tempDir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-keyword-large-'));
        const filePath = path.join(tempDir, 'large.k');
        const lines = ['*KEYWORD'];
        const filler = '0'.repeat(72);
        for (let index = 1; index < 40000; index++) {
            if (index === 5000) {
                lines.push('*INCLUDE');
            } else {
                lines.push(`${index.toString().padStart(8, '0')} ${filler}`);
            }
        }
        lines.push('*END');
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        const keywords = await collectKeywordsFromFile(filePath);
        for (const fullScanLargeFiles of [false, true]) {
            assert.deepEqual(await collectKeywordsFromFile(filePath, { fullScanLargeFiles }), keywords);
        }

        assert.deepEqual(
            keywords.map(item => item.keyword),
            ['KEYWORD', 'INCLUDE', 'END']
        );
    });
});
