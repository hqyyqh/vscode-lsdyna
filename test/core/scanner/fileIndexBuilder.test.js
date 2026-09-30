const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { SCANNER_VERSION } = require('../../../out/core/scanner/scannerContracts');

describe('buildFileIndex', () => {
    it('stores the source-locked LS-PrePost reference inventory', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-lspp-index-'));
        const filePath = path.join(directory, 'transform.k');
        fs.writeFileSync(filePath, [
            '*NODE_TRANSFORM',
            '   1000001',
        ].join('\n'));
        try {
            const index = await buildFileIndex(filePath);
            assert.equal(index.scannerVersion, SCANNER_VERSION);
            assert.equal(index.registryReferences.complete, true);
            const occurrence = index.registryReferences.referenceOccurrences.find(item => item.fieldName === 'TRSID');
            assert.equal(occurrence.referenceValue.id, 1000001);
            assert.deepEqual(occurrence.targetKinds, ['transformation']);
            assert.equal(occurrence.sourceRuleId, 'lspp:40:NODE_TRANSFORM:1:0');
            assert.ok(index.registryReferences.valueDomainOccurrences.length > 0);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });

    it('does not derive include, parameter, or reference children from COMMENT bodies', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-index-comment-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, [
            '*COMMENT *INCLUDE',
            'hidden.k',
            '  *PARAMETER',
            'IHIDDEN,1',
            '  *DEFINE_CURVE',
            '1001',
            '*END',
        ].join('\n'));

        try {
            const index = await buildFileIndex(filePath, { highWaterMark: 8 });
            assert.deepEqual(index.keywordBlocks.map(block => block.keyword), ['*COMMENT', '*END']);
            assert.deepEqual(index.includeEntries, []);
            assert.deepEqual(index.parameterEvents, []);
            assert.deepEqual(index.referenceDefinitions.curves, []);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('builds keyword and include data from one skeleton scan', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-index-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '*KEYWORD\n*INCLUDE\nsub/body.k\n*INCLUDE_PATH_RELATIVE\nincludes\n*END\n');

        const index = await buildFileIndex(filePath, { highWaterMark: 7 });
        assert.equal(index.filePath, filePath);
        assert.equal(index.scannerVersion, SCANNER_VERSION);
        assert.deepEqual(index.keywordBlocks.map(block => block.keyword), [
            '*KEYWORD',
            '*INCLUDE',
            '*INCLUDE_PATH_RELATIVE',
            '*END'
        ]);
        assert.equal(index.includeEntries.length, 1);
        assert.equal(index.includeEntries[0].fileName, 'sub/body.k');
        assert.ok(index.searchPaths.some(searchPath => searchPath.endsWith('includes')));
    });

    it('adds curve and table reference definitions while building the file index', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-index-ref-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_CURVE',
            '      1001',
            '       0.0       1.0',
            '*DEFINE_TABLE',
            '      2001',
            '       0.0      1001',
            '*END',
        ].join('\n'));

        try {
            const index = await buildFileIndex(filePath, { highWaterMark: 16 });

            assert.equal(index.scannerVersion, SCANNER_VERSION);
            assert.equal(index.referenceDefinitions.curves.length, 1);
            assert.equal(index.referenceDefinitions.curves[0].id, 1001);
            assert.equal(index.referenceDefinitions.tables.length, 1);
            assert.equal(index.referenceDefinitions.tables[0].id, 2001);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('adds parameter events without scanning unrelated files in the directory', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-index-param-'));
        const filePath = path.join(dir, 'condition-a.k');
        const unrelatedFile = path.join(dir, 'condition-b-old.k');
        fs.writeFileSync(filePath, [
            '*PARAMETER',
            'ICID            100',
            '*END',
        ].join('\n'));
        fs.writeFileSync(unrelatedFile, [
            '*PARAMETER',
            'ICID            999',
            '*END',
        ].join('\n'));

        try {
            const index = await buildFileIndex(filePath);

            assert.equal(index.parameterEvents.length, 1);
            assert.equal(index.parameterEvents[0].name, 'CID');
            assert.equal(index.parameterEvents[0].value, 100);
            assert.ok(!index.parameterEvents.some(event => event.value === 999));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('marks a curve preview partial when its keyword block exceeds the byte cap', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-file-index-cap-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_CURVE',
            '      1001',
            ...Array.from({ length: 100 }, (_, index) => `${index}.0 ${index + 1}.0`),
            '*END',
        ].join('\n'));

        try {
            const index = await buildFileIndex(filePath, { maxDefinitionBlockBytes: 64 });
            assert.equal(index.referenceDefinitions.curves.length, 1);
            assert.deepEqual(index.referenceDefinitions.curves[0].dataCompleteness, {
                state: 'partial',
                reasons: ['preview-byte-limit'],
            });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('scopes truncated LS-PrePost blocks to their actual object namespaces', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-reference-coverage-'));
        const filePath = path.join(dir, 'large-elements.k');
        fs.writeFileSync(filePath, [
            '*NODE_TRANSFORM',
            ...Array.from({ length: 30 }, (_, index) =>
                String(index + 1).padStart(10)),
            '*NODE',
            ...Array.from({ length: 30 }, (_, index) =>
                `${String(index + 1).padStart(8)}${'0.0'.padStart(16)}${'0.0'.padStart(16)}${'0.0'.padStart(16)}`),
            '*END',
        ].join('\n'));

        try {
            const index = await buildFileIndex(filePath, { maxReferenceBlockBytes: 96 });
            const gaps = index.registryReferences.referenceCoverage.gaps;
            assert.equal(index.registryReferences.referenceCoverage.complete, false);
            assert.ok(gaps.some(gap => gap.keyword === '*NODE_TRANSFORM' &&
                gap.targetKinds.includes('transformation')));
            assert.equal(gaps.some(gap => gap.targetKinds.includes('curve')), false);
            assert.equal(gaps.some(gap => gap.keyword === '*NODE'), false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
