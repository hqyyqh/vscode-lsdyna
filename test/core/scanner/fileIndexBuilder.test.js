const assert = require('assert');
const makeTempDirectory = require('../../support/tempDirectories').trackTempDirectories();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { SCANNER_VERSION } = require('../../../out/core/scanner/scannerContracts');

describe('buildFileIndex', () => {
    it('bounds accumulated parameter metadata even when the keyword skeleton is small', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-parameter-budget-'));
        const file = path.join(dir, 'main.k');
        fs.writeFileSync(file, '*PARAMETER_EXPRESSION\n' +
            Array.from({ length: 200 }, (_, i) => `Rp${i},1.0+2.0\n`).join(''));
        const { buildFileStructure } = require('../../../out/core/scanner/fileIndexBuilder');
        await assert.rejects(buildFileStructure(file, { maxStructureBytes: 4096 }), RangeError);
        const complete = await buildFileStructure(file);
        assert.equal(complete.parameterEvents.length, 200);
        assert(complete.structuralMetadataBytes > 4096);
    });
    it('rebuilds after a physical block shrinks during its first reference read', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-scan-shrinks-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '*DEFINE_CURVE\n1001\n' + '0,0\n'.repeat(50) + '*END\n');
        let changed = false;
        const index = await buildFileIndex(filePath, { onProgress() {
            if (changed) return;
            changed = true;
            fs.writeFileSync(filePath, '*DEFINE_CURVE\n2002\n0,0\n*END\n');
        } });
        assert.equal(changed, true);
        assert.equal(index.size, fs.statSync(filePath).size);
        assert.deepEqual(index.referenceDefinitions.curves.map(curve => curve.id), [2002]);
    });

    it('limits changed-scan retries and preserves other failures without retrying', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-scan-retries-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, '*DEFINE_CURVE\n1001\n0,0\n*END\n');
        for (const [name, expectedCalls] of [['ScanChangedError', 2], ['EACCES', 1]]) {
            const failure = Object.assign(new Error('controlled read-stage fault'), { name });
            let calls = 0;
            await assert.rejects(buildFileIndex(filePath, { onProgress() {
                calls++;
                throw failure;
            } }), error => error === failure);
            assert.equal(calls, expectedCalls);
        }
    });

    it('stores the source-locked LS-PrePost reference inventory', async () => {
        const directory = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-lspp-index-'));
        const filePath = path.join(directory, 'transform.k');
        fs.writeFileSync(filePath, [
            '*NODE_TRANSFORM',
            '   1000001',
        ].join('\n'));
        const index = await buildFileIndex(filePath);
        assert.equal(index.scannerVersion, SCANNER_VERSION);
        assert.equal(index.registryReferences.complete, true);
        const occurrence = index.registryReferences.referenceOccurrences.find(item => item.fieldName === 'TRSID');
        assert.equal(occurrence.referenceValue.id, 1000001);
        assert.deepEqual(occurrence.targetKinds, ['transformation']);
        assert.equal(occurrence.sourceRuleId, "lspp:40:NODE_TRANSFORM:1:0:record:40a8cc6df9c65f8a9f28a264:7287e6dec409ff3416216e5d");
        assert.ok(index.registryReferences.valueDomainOccurrences.length > 0);
    });

    it('does not derive include, parameter, or reference children from COMMENT bodies', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-file-index-comment-'));
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

        const index = await buildFileIndex(filePath, { highWaterMark: 8 });
        assert.deepEqual(index.keywordBlocks.map(block => block.keyword), ['*COMMENT', '*END']);
        assert.deepEqual(index.includeEntries, []);
        assert.deepEqual(index.parameterEvents, []);
        assert.deepEqual(index.referenceDefinitions.curves, []);
    });

    it('builds keyword and include data from one skeleton scan', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-file-index-'));
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
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-file-index-ref-'));
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

        const index = await buildFileIndex(filePath, { highWaterMark: 16 });

        assert.equal(index.scannerVersion, SCANNER_VERSION);
        assert.equal(index.referenceDefinitions.curves.length, 1);
        assert.equal(index.referenceDefinitions.curves[0].id, 1001);
        assert.equal(index.referenceDefinitions.tables.length, 1);
        assert.equal(index.referenceDefinitions.tables[0].id, 2001);
    });

    it('adds parameter events without scanning unrelated files in the directory', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-file-index-param-'));
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

        const index = await buildFileIndex(filePath);

        assert.equal(index.parameterEvents.length, 1);
        assert.equal(index.parameterEvents[0].name, 'CID');
        assert.equal(index.parameterEvents[0].value, 100);
        assert.ok(!index.parameterEvents.some(event => event.value === 999));
    });

    it('marks a curve preview partial when its keyword block exceeds the byte cap', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-file-index-cap-'));
        const filePath = path.join(dir, 'main.k');
        fs.writeFileSync(filePath, [
            '*DEFINE_CURVE',
            '      1001',
            ...Array.from({ length: 100 }, (_, index) => `${index}.0 ${index + 1}.0`),
            '*END',
        ].join('\n'));

        const index = await buildFileIndex(filePath, { maxDefinitionBlockBytes: 64 });
        assert.equal(index.referenceDefinitions.curves.length, 1);
        assert.deepEqual(index.referenceDefinitions.curves[0].dataCompleteness, {
            state: 'partial',
            reasons: ['preview-byte-limit'],
        });
    });

    it('scopes truncated LS-PrePost blocks to their actual object namespaces', async () => {
        const dir = makeTempDirectory(path.join(os.tmpdir(), 'lsdyna-reference-coverage-'));
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

        const index = await buildFileIndex(filePath, { maxReferenceBlockBytes: 96 });
        const gaps = index.registryReferences.referenceCoverage.gaps;
        assert.equal(index.registryReferences.referenceCoverage.complete, false);
        assert.ok(gaps.some(gap => gap.keyword === '*NODE_TRANSFORM' &&
            gap.targetKinds.includes('transformation')));
        assert.equal(gaps.some(gap => gap.targetKinds.includes('curve')), false);
        assert.equal(gaps.some(gap => gap.keyword === '*NODE'), false);
    });
});
