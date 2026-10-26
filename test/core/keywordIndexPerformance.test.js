'use strict';

const assert = require('assert');
const path = require('path');
const functionalOnly = process.env.LSDYNA_CI_FUNCTIONAL_ONLY === '1';
const { BlockIndex } = require('../../src/core/incremental/blockIndex');
const { createKeywordIdentityAccumulatorFactory } = require('../../src/core/keywordDisplayIdentity');
const { LsdynaKeywordIndexProvider } = require('../../src/client/providers/keywordIndexProvider');

describe('keyword index large-deck performance', function () {
    this.timeout(30000);

    it('streams a million-row NODE block while retaining only the bounded display prefix', async () => {
        const nodeRows = 1000000;
        const lineCount = nodeRows + 3;
        const index = new BlockIndex('million-node.k', {
            createBlockSummaryAccumulator: createKeywordIdentityAccumulatorFactory(),
        });
        let lineReads = 0;
        const startedAt = Date.now();
        const completed = await index.buildIndexAsync(
            lineCount,
            line => {
                lineReads++;
                if (line === 0) return '*KEYWORD';
                if (line === 1) return '*NODE';
                if (line === lineCount - 1) return '*END';
                return `${line - 1},0.0,0.0,0.0`;
            },
            { yieldInterval: 10000 },
        );
        const elapsedMs = Date.now() - startedAt;

        assert.equal(completed, true);
        assert.equal(lineReads, lineCount);
        assert.deepEqual(index.blocks.map(block => block.keyword), ['KEYWORD', 'NODE', 'END']);
        const nodeBlock = index.blocks[1];
        assert.equal(nodeBlock.dataLineCount, nodeRows);
        assert.equal(nodeBlock.displayIdentity.collection.count, nodeRows);
        assert.ok(nodeBlock.displaySourceEndLine <= 33, `display prefix ended at ${nodeBlock.displaySourceEndLine}`);
        if (!functionalOnly) assert.ok(elapsedMs < 20000, `million-row live scan took ${elapsedMs}ms`);
    });

    it('keeps 100,000 fragmented occurrences paged and cursor lookup logarithmic', () => {
        const occurrenceCount = 100000;
        const filePath = path.resolve('project', 'fragmented.k');
        const blocks = Array.from({ length: occurrenceCount }, (_, index) => ({
            keyword: '*NODE',
            startLine: index * 2,
            endLine: index * 2 + 1,
            dataLineCount: 1,
            displayIdentity: {
                kind: 'collection',
                keyword: 'NODE',
                canonicalKeyword: 'NODE',
                collection: { kind: 'data-lines', count: 1 },
                dataLineCount: 1,
                confidence: 'verified',
            },
        }));
        const provider = new LsdynaKeywordIndexProvider({ initialLayout: 'alphabetical' });
        const projectionStartedAt = Date.now();
        provider._buildRootsFromSnapshot({
            files: [filePath],
            fileIndexes: new Map([[filePath, { keywordBlocks: blocks }]]),
        }, path.dirname(filePath));
        const projectionMs = Date.now() - projectionStartedAt;

        assert.equal(provider.roots.length, 1);
        const pages = provider.getChildren(provider.roots[0]);
        assert.equal(pages.length, Math.ceil(occurrenceCount / 200));
        assert.equal(pages[0]._children, null);

        const lookupStartedAt = Date.now();
        const boundaries = [0, 1, 198, 199, 200, 201, 49999, 50000, 99799, 99800, 99998, 99999];
        for (let index = 0; index < (functionalOnly ? boundaries.length : 20000); index++) {
            const occurrenceIndex = functionalOnly ? boundaries[index] : (index * 7919) % occurrenceCount;
            const occurrence = provider.findOccurrence(filePath, occurrenceIndex * 2 + 1);
            assert.equal(occurrence.startLine, occurrenceIndex * 2);
        }
        const lookupMs = Date.now() - lookupStartedAt;

        const switchesStartedAt = Date.now();
        provider.setLayout('order');
        provider.setLayout('category');
        const switchesMs = Date.now() - switchesStartedAt;

        if (!functionalOnly) assert.ok(projectionMs < 10000, `100k occurrence projection took ${projectionMs}ms`);
        if (!functionalOnly) assert.ok(lookupMs < 3000, `20k cursor lookups took ${lookupMs}ms`);
        if (!functionalOnly) assert.ok(switchesMs < 10000, `two 100k layout switches took ${switchesMs}ms`);
    });

    it('preserves repeated unknown LS-PrePost connection blocks', async () => {
        const keywords = [
            '*CONNECTION_START_SPOTWELD',
            '*CONNECTION_LAYER_PART_ID',
            '*CONNECTION_ENTITIES',
            '*CONNECTION_END_SPOTWELD',
        ];
        const blockCount = functionalOnly ? keywords.length * 2 : 25000;
        const index = new BlockIndex('connection-metadata.k', {
            createBlockSummaryAccumulator: createKeywordIdentityAccumulatorFactory(),
        });
        const startedAt = Date.now();
        await index.buildIndexAsync(
            blockCount * 2,
            line => line % 2 === 0
                ? keywords[(line / 2) % keywords.length]
                : '1,2,3,4',
            { yieldInterval: 5000 },
        );
        const elapsedMs = Date.now() - startedAt;

        assert.equal(index.blocks.length, blockCount);
        index.blocks.forEach((block, ordinal) => {
            assert.equal(block.keyword, keywords[ordinal % keywords.length].slice(1));
            assert.equal(block.startLine, ordinal * 2);
            assert.equal(block.dataLineCount, 1);
        });
        if (!functionalOnly) assert.ok(elapsedMs < 5000, `25k repeated custom blocks took ${elapsedMs}ms`);
    });
});
