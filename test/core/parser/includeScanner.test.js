'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectIncludeDirectivesFromFile } = require('../../../src/core/parser/includeScanner');

const FIXTURE_DIR = path.join(__dirname, '..', '..', 'Bolt_A_Explicit');

describe('includeScanner', () => {
    it('handles leading whitespace and mixed-case include keywords', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-case-'));
        const filePath = path.join(tempDir, 'mixed-case.k');
        fs.writeFileSync(filePath, ' \t*Include\nchild.k\n  *Include_Path\n/extra/path\n', 'utf8');

        const result = await collectIncludeDirectivesFromFile(filePath);

        assert.deepStrictEqual(result.includeEntries.map(entry => entry.fileName), ['child.k']);
        assert.ok(result.searchPaths.includes('/extra/path'));
    });

    it('streams include directives from a real fixture file', async () => {
        const fixturePath = path.join(FIXTURE_DIR, 'mainboltaexpl.k');

        const result = await collectIncludeDirectivesFromFile(fixturePath);

        const names = result.includeEntries.map(entry => entry.fileName);
        assert.ok(names.includes('includes.k'));
        assert.ok(names.includes('material_props.k'));
        assert.ok(names.includes('missing_geometry.k'));
        assert.ok(result.searchPaths.includes(path.join(FIXTURE_DIR, 'submodels')));
    });

    it('preserves continued include filenames and segments when scanning files', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-scanner-'));
        const filePath = path.join(tempDir, 'continued.k');

        fs.writeFileSync(filePath, '*INCLUDE\npart_a +\npart_b.key\n', 'utf8');

        const result = await collectIncludeDirectivesFromFile(filePath);

        assert.equal(result.includeEntries.length, 1);
        assert.equal(result.includeEntries[0].fileName, 'part_apart_b.key');
        assert.equal(result.includeEntries[0].segments.length, 2);
    });

    it('handles *INCLUDE_PATH with continuation lines (path > 80 chars)', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-path-'));
        const filePath = path.join(tempDir, 'longpath.k');
        const longPath = '/very/long/directory/path/that/exceeds/eighty/characters/in/length/so/it/needs/continuation/lines';

        // Split path at a point to simulate continuation
        const part1 = longPath.slice(0, 50);
        const part2 = longPath.slice(50);
        fs.writeFileSync(filePath, `*INCLUDE_PATH\n${part1} +\n${part2}\n`, 'utf8');

        const result = await collectIncludeDirectivesFromFile(filePath);

        assert.ok(result.searchPaths.includes(longPath));
    });

    it('handles *INCLUDE_PATH_RELATIVE with continuation lines', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-path-rel-'));
        const filePath = path.join(tempDir, 'longrelpath.k');
        const relPath = 'submodels/very/deep/nested/directory/structure/that/exceeds/eighty/characters/total';

        const part1 = relPath.slice(0, 40);
        const part2 = relPath.slice(40);
        fs.writeFileSync(filePath, `*INCLUDE_PATH_RELATIVE\n${part1} +\n${part2}\n`, 'utf8');

        const result = await collectIncludeDirectivesFromFile(filePath);

        assert.ok(result.searchPaths.includes(path.resolve(tempDir, relPath)));
    });

    it('handles *INCLUDE_PATH with multiple continuation lines', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-path-multi-'));
        const filePath = path.join(tempDir, 'multiline.k');

        fs.writeFileSync(filePath, '*INCLUDE_PATH\n/part/one +\n/part/two +\n/part/three\n', 'utf8');

        const result = await collectIncludeDirectivesFromFile(filePath);

        assert.ok(result.searchPaths.includes('/part/one/part/two/part/three'));
    });

    it('handles mixed short and long paths under *INCLUDE_PATH', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-path-mixed-'));
        const filePath = path.join(tempDir, 'mixed.k');

        fs.writeFileSync(filePath, '*INCLUDE_PATH\n/short/path\n/long/path/that +\n/continues/here\n', 'utf8');

        const result = await collectIncludeDirectivesFromFile(filePath);

        assert.ok(result.searchPaths.includes('/short/path'));
        assert.ok(result.searchPaths.includes('/long/path/that/continues/here'));
    });

    it('flushes pending path at end of file', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-path-eof-'));
        const filePath = path.join(tempDir, 'eof.k');

        // Path with continuation but no closing line (end of file)
        fs.writeFileSync(filePath, '*INCLUDE_PATH\n/incomplete/path +\n/final\n', 'utf8');

        const result = await collectIncludeDirectivesFromFile(filePath);

        assert.ok(result.searchPaths.includes('/incomplete/path/final'));
    });

    it('flushes pending path when new keyword starts', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-path-kw-'));
        const filePath = path.join(tempDir, 'kwflush.k');

        fs.writeFileSync(filePath, '*INCLUDE_PATH\n/some/long +\n/path\n*INCLUDE\nfile.k\n', 'utf8');

        const result = await collectIncludeDirectivesFromFile(filePath);

        assert.ok(result.searchPaths.includes('/some/long/path'));
        assert.equal(result.includeEntries.length, 1);
        assert.equal(result.includeEntries[0].fileName, 'file.k');
    });

    it('returns empty results quickly for files without *INCLUDE (early termination)', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-early-'));
        const filePath = path.join(tempDir, 'noinclude.k');

        // Write a file with keywords but no *INCLUDE
        fs.writeFileSync(filePath, '*PART\npart data\n*MAT_ELASTIC\nmat data\n*NODE\n1,0,0,0\n', 'utf8');

        const result = await collectIncludeDirectivesFromFile(filePath);

        assert.deepEqual(result.includeEntries, []);
        assert.deepEqual(result.searchPaths, [tempDir]);
    });

    it('handles small files with buffer-based parsing (under 1MB)', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-buffer-'));
        const filePath = path.join(tempDir, 'small.k');

        fs.writeFileSync(filePath, '*INCLUDE\nchild.k\n*INCLUDE_PATH\n/extra/path\n', 'utf8');

        const result = await collectIncludeDirectivesFromFile(filePath);

        assert.equal(result.includeEntries.length, 1);
        assert.equal(result.includeEntries[0].fileName, 'child.k');
        assert.ok(result.searchPaths.includes('/extra/path'));
    });

    it('does not miss middle include directives in large files when fullScanLargeFiles is false', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-include-large-'));
        const filePath = path.join(tempDir, 'large.k');
        const filler = '0'.repeat(72);
        const lines = ['*KEYWORD'];
        for (let index = 1; index < 40000; index++) {
            if (index === 5000) {
                lines.push('*INCLUDE');
                lines.push('middle.k');
                lines.push('*NODE');
            } else {
                lines.push(`${index.toString().padStart(8, '0')} ${filler}`);
            }
        }
        lines.push('*END');
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');

        try {
            const result = await collectIncludeDirectivesFromFile(filePath, { fullScanLargeFiles: false });
            assert.deepEqual(result.includeEntries.map(entry => entry.fileName), ['middle.k']);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('handles collectIncludeDirectivesFromBuffer directly', () => {
        const { collectIncludeDirectivesFromBuffer } = require('../../../src/core/parser/includeScanner');
        const buffer = Buffer.from('*INCLUDE\nmy_file.k\n*PART\ndata\n');
        const basePath = '/test/dir';

        const result = collectIncludeDirectivesFromBuffer(buffer, basePath);

        assert.equal(result.includeEntries.length, 1);
        assert.equal(result.includeEntries[0].fileName, 'my_file.k');
        assert.deepEqual(result.searchPaths, [basePath]);
    });

    it('collectIncludeDirectivesFromBuffer returns empty for files without *INCLUDE', () => {
        const { collectIncludeDirectivesFromBuffer } = require('../../../src/core/parser/includeScanner');
        const buffer = Buffer.from('*PART\npart data\n*NODE\n1,0,0,0\n');
        const basePath = '/test/dir';

        const result = collectIncludeDirectivesFromBuffer(buffer, basePath);

        assert.deepEqual(result.includeEntries, []);
        assert.deepEqual(result.searchPaths, [basePath]);
    });
});
