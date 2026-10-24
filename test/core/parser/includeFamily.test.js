'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tempDirectory = require('../../support/tempDirectories').trackTempDirectories();
const { loadKeywordSchema } = require('../../../src/core/keywordSchema');
const { getIncludeDirectiveRule } = require('../../../src/core/parser/includeDirectiveRules');
const { collectIncludeDirectivesFromBuffer, collectIncludeDirectivesFromFile,
    collectIncludeDirectivesFromDocumentBlocks } = require('../../../src/core/parser/includeScanner');
const { buildFileStructure } = require('../../../src/core/scanner/fileIndexBuilder');
const { createProjectIndexer } = require('../../../src/core/project/projectIndexer');

describe('include family shared file discovery', () => {
    it('matches every catalog filename card across buffer, disk, block and recursive project scans', async function () {
        this.timeout(30000);
        const directory = tempDirectory(path.join(os.tmpdir(), 'include-family-'));
        const main = path.join(directory, 'main.k');
        const lines = ['*KEYWORD'];
        const expected = [];
        for (const [keyword, schema] of Object.entries(loadKeywordSchema())) {
            if (!keyword.startsWith('INCLUDE')) continue;
            const filenameCard = schema.c.findIndex(card => card.some(field => field.n === 'FILENAME')) + 1;
            const rule = getIncludeDirectiveRule('*' + keyword);
            if (!filenameCard) {
                assert.equal(rule, null, keyword + ' does not introduce a file');
                if (!keyword.startsWith('INCLUDE_PATH')) lines.push('*' + keyword, '1,0,0,0');
                continue;
            }
            assert.equal(rule.filenameCard, filenameCard, keyword);
            const fileName = keyword.toLowerCase() + '.k';
            lines.push('*' + keyword, ...Array(filenameCard - 1).fill('1'), fileName);
            if (keyword.startsWith('INCLUDE_TRANSFORM')) lines.push('0,0,0,0,0,0,0', '0', '1,1,1,0,0,0', '0');
            fs.writeFileSync(path.join(directory, fileName), '*INCLUDE\nleaf.k\n');
            expected.push(fileName);
        }
        lines.push('*END');
        fs.writeFileSync(main, lines.join('\n'));
        fs.writeFileSync(path.join(directory, 'leaf.k'), '*KEYWORD\n*END\n');
        const buffer = collectIncludeDirectivesFromBuffer(Buffer.from(lines.join('\n')), directory);
        const disk = await collectIncludeDirectivesFromFile(main);
        const blocks = await buildFileStructure(main);
        const live = await collectIncludeDirectivesFromDocumentBlocks({ uri: { fsPath: main },
            lineAt: line => ({ text: lines[line] }) }, blocks.keywordBlocks);
        // Cross the disk scanner's 1 MiB streaming boundary without changing directives.
        fs.appendFileSync(main, '\n' + ('$' + ' '.repeat(1022) + '\n').repeat(2048));
        const streamed = await collectIncludeDirectivesFromFile(main);
        for (const result of [buffer, disk, blocks, live, streamed]) {
            assert.deepEqual(result.includeEntries.map(entry => entry.fileName), expected);
            assert.equal(result.includeEntries.filter(entry => entry.transform).length, 2);
        }
        const project = await createProjectIndexer().buildProjectIndex(main);
        assert.equal(project.files.length, expected.length + 2);
        assert.equal(project.missingFiles.length, 0);
        assert.equal(project.graph.includeOccurrences.length, expected.length * 2);
    });
});
