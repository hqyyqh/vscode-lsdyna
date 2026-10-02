'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const referenceIndex = require("../../../keywords/runtime/references/field_reference_index.json");
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { indexedEntityKinds, queryIndexedEntityId } =
    require('../../../out/core/references/indexedEntityQuery');
const { scanRegistryReferenceOccurrencesFromFileIndex } =
    require('../../../out/core/references/registryReferenceScanner');

async function scan(keyword, text) {
    const block = { filePath: '/fixture/relations.key', keyword: `*${keyword}`,
        rawKeyword: `*${keyword}`, startLine: 0, endLine: text.split('\n').length - 1 };
    return scanRegistryReferenceOccurrencesFromFileIndex(
        { keywordBlocks: [block], referenceDefinitions: {} }, async () => text);
}

describe("keyword catalog reference scanner", () => {
    it('publishes the complete Transformation relation family from link code 40', async () => {
        assert.ok(indexedEntityKinds().includes('transformation'));
        for (const keyword of [
            'DEFINE_TRANSFORM', 'DEFINE_TRANSFORMATION',
            'DEFINE_TRANSFORM_TITLE', 'DEFINE_TRANSFORMATION_TITLE',
        ]) {
            assert.equal(referenceIndex.definitionKeywords.generic[keyword].targetKind,
                'transformation', keyword);
        }
        assert.deepEqual(Object.keys(referenceIndex.references)
            .filter(keyword => referenceIndex.references[keyword].some(item => item.linkCode === 40))
            .sort(), [
            'INCLUDE_TRANSFORM', 'INCLUDE_TRANSFORM_BINARY', 'NODE_TRANSFORM', 'PART_DUPLICATE',
        ]);

        const node = await scan('NODE_TRANSFORM', '*NODE_TRANSFORM\n   1000001');
        const part = await scan('PART_DUPLICATE', [
            '*PART_DUPLICATE',
            [1, 2, 3, 4, 5, 1000001].map(value => String(value).padStart(10)).join(''),
        ].join('\n'));
        for (const [result, fieldName] of [[node, 'TRSID'], [part, 'TRANID']]) {
            const occurrence = result.referenceOccurrences.find(item => item.fieldName === fieldName);
            assert.equal(occurrence.referenceValue.id, 1000001);
            assert.deepEqual(occurrence.targetKinds, ['transformation']);
            assert.equal(occurrence.sourceRuleId.startsWith('lspp:40:'), true);
        }
    });

    it('finds INCLUDE_TRANSFORM/TRANID across its intentionally blank card', async () => {
        const result = await scan('INCLUDE_TRANSFORM', [
            '*INCLUDE_TRANSFORM',
            'test2/wall2.key',
            '  10000000  10000000  10000000  10000000  10000000  10000000  10000000',
            '  10000000',
            '',
            '$#  tranid',
            '   1000001',
        ].join('\n'));
        const occurrence = result.referenceOccurrences.find(item => item.fieldName === 'TRANID');
        assert.equal(result.complete, true, JSON.stringify(result.reasons));
        assert.equal(occurrence.cardIndex, 5);
        assert.equal(occurrence.lineIndex, 6);
        assert.equal(occurrence.referenceValue.id, 1000001);
    });

    it('resolves the definition and reference through the indexed object query', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lspp-transform-reference-'));
        const filePath = path.join(directory, 'main.key');
        fs.writeFileSync(filePath, [
            '*KEYWORD',
            '*DEFINE_TRANSFORMATION',
            '   1000001',
            '*INCLUDE_TRANSFORM',
            'test2/wall2.key',
            '  10000000  10000000  10000000  10000000  10000000  10000000  10000000',
            '  10000000',
            '',
            '$#  tranid',
            '   1000001',
            '*END',
        ].join('\n'));
        try {
            const fileIndex = await buildFileIndex(filePath);
            const result = await queryIndexedEntityId({
                snapshot: { scope: 'single-file', rootFile: filePath, files: [filePath],
                    graph: { includeOccurrences: [], includeOccurrencesComplete: true },
                    fileIndexes: new Map([[filePath, fileIndex]]) },
                id: 1000001,
                targetKind: 'transformation',
            });
            assert.equal(result.state, 'complete', JSON.stringify(result.reasons));
            assert.deepEqual(result.locations.map(item => [item.role, item.keyword, item.fieldName,
                item.line]), [
                ['definition', '*DEFINE_TRANSFORMATION', 'TRANID', 2],
                ['reference', '*INCLUDE_TRANSFORM', 'TRANID', 9],
            ]);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
