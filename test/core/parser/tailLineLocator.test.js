'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectIncludeDirectivesFromFile } = require('../../../src/core/parser/includeScanner');
const { collectKeywordsFromFile } = require('../../../src/core/parser/keywordScanner');

function createLargeTailFixture() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-tail-lines-'));
    const filePath = path.join(tempDir, 'large.k');
    const prefix = '1234567890\n'.repeat(100000);
    const tail = ' \t*Include\nmissing.k\n\t*Node\n1,2,3\n';
    const content = prefix + tail;
    fs.writeFileSync(filePath, content, 'utf8');
    return { filePath, content, totalLines: content.split('\n').length };
}

describe('tailLineLocator', () => {
    it('locates a complete tail line and its real zero-based line index', async () => {
        const { locateTailWindow } = require('../../../out/core/parser/tailLineLocator');
        const { filePath, content } = createLargeTailFixture();
        const stat = fs.statSync(filePath);

        const result = await locateTailWindow(filePath, stat, 256);

        assert.ok(result.startOffset > 0);
        assert.equal(content.charCodeAt(result.startOffset - 1), 0x0a);
        assert.equal(
            result.startLineIndex,
            Buffer.from(content.slice(0, result.startOffset)).filter(byte => byte === 0x0a).length
        );
    });

    it('keeps tail scanner records within the real file line count', async () => {
        const { filePath, totalLines } = createLargeTailFixture();

        const includes = await collectIncludeDirectivesFromFile(filePath);
        const keywords = await collectKeywordsFromFile(filePath);

        assert.equal(includes.includeEntries[0].fileName, 'missing.k');
        assert.ok(includes.includeEntries.every(entry => entry.lineIndex < totalLines));
        assert.ok(keywords.some(entry => entry.keyword === 'NODE'));
        assert.ok(keywords.every(entry => entry.lineIndex < totalLines));
    });
});
