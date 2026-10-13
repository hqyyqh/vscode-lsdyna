'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EntityQueryCache } = require('../../../out/core/references/entityQueryCache');
const { scanIndexedTypeDefinitions } = require('../../../out/core/references/entityTypeDefinitionIndex');
const { buildFileIndex } = require('../../../out/core/scanner/fileIndexBuilder');
const { runtimeDefinitionKeywords, scanBlockLinesFromDisk } = require('../../../out/core/references/onDemandDefinitionScanner');
const { trackTempDirectories } = require('../../support/tempDirectories');

describe('entity type definition shards', () => {
    let root;
    const temporary = trackTempDirectories();
    beforeEach(() => { root = temporary(path.join(os.tmpdir(), 'entity-type-shards-')); });
    const deck = ids => '*KEYWORD\n*NODE\n' + ids.map(id => String(id).padStart(8) + '0'.padStart(16).repeat(3)).join('\n') + '\n*END\n';
    async function input() {
        const files = [path.join(root, 'a.k'), path.join(root, 'b.k')];
        files.forEach((file, index) => fs.writeFileSync(file, deck([index + 1])));
        const fileIndexes = new Map(await Promise.all(files.map(async file => [file, await buildFileIndex(file)])));
        const reads = new Map();
        return { files, reads, options: { fileIndexes, projectScoped: false, referenceIndex: {},
            targetKinds: ['node'], targetDefinitions: [], definitionKeywords: runtimeDefinitionKeywords(),
            scanBlockLines: (block, visit, token) => {
                reads.set(block.filePath, (reads.get(block.filePath) || 0) + 1);
                return scanBlockLinesFromDisk(block, visit, token);
            } } };
    }
    it('shares different IDs and replaces only the changed file shard', async () => {
        const { options, files, reads } = await input(), cache = new EntityQueryCache();
        const first = await scanIndexedTypeDefinitions({ ...options, effectiveId: 1 }, cache);
        assert.equal(first.state, 'complete'); assert.equal(first.definitions[0].id, 1);
        const before = new Map(reads);
        const second = await scanIndexedTypeDefinitions({ ...options, effectiveId: 2 }, cache);
        assert.equal(second.definitions[0].id, 2);
        assert.equal(second.scannedLineCount, 0); assert.deepEqual(reads, before);
        fs.writeFileSync(files[0], deck([3]));
        options.fileIndexes.set(files[0], await buildFileIndex(files[0]));
        // Worker/LSP transport recreates even the unchanged file's wrapper.
        options.fileIndexes.set(files[1], JSON.parse(JSON.stringify(options.fileIndexes.get(files[1]))));
        const changed = await scanIndexedTypeDefinitions({ ...options, effectiveId: 3 }, cache);
        assert.equal(changed.definitions[0].id, 3);
        assert.ok(reads.get(files[0]) > before.get(files[0]));
        assert.equal(reads.get(files[1]), before.get(files[1]));
        assert.equal((await scanIndexedTypeDefinitions({ ...options, effectiveId: 1 }, cache)).definitions.length, 0);
    });
    it('publishes a confirmed file result before reading the next file', async () => {
        const { options, files } = await input();
        const batches = [], read = options.scanBlockLines;
        const result = await scanIndexedTypeDefinitions({ ...options, effectiveId: 1,
            onDefinitions: async rows => { batches.push(...rows); },
            scanBlockLines: (block, visit, token) => {
                if (block.filePath === files[1]) assert.equal(batches[0]?.id, 1);
                return read(block, visit, token);
            },
        }, new EntityQueryCache());
        assert.equal(result.state, 'complete');
        assert.equal(batches.length, 1);
    });
    it('falls back without a complete type cache when the managed budget is zero', async () => {
        const { options } = await input(), cache = new EntityQueryCache(0);
        const result = await scanIndexedTypeDefinitions({ ...options, effectiveId: 2 }, cache);
        assert.equal(result.state, 'complete'); assert.equal(result.definitions[0].id, 2);
        assert.equal(cache.stats().bytes, 0); assert.equal(cache.stats().reservedBytes, 0);
    });
    it('keeps the shared type build alive after one ID subscriber cancels', async () => {
        const { options } = await input(), cache = new EntityQueryCache();
        let release, begin;
        const gate = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { begin = resolve; });
        const reader = options.scanBlockLines;
        options.scanBlockLines = async (...args) => { begin(); await gate; return reader(...args); };
        const token = { isCancellationRequested: false };
        const first = scanIndexedTypeDefinitions({ ...options, effectiveId: 1, cancellationToken: token }, cache);
        const second = scanIndexedTypeDefinitions({ ...options, effectiveId: 2 }, cache);
        await started; token.isCancellationRequested = true;
        await assert.rejects(first, { name: 'CancellationError' });
        release(); assert.equal((await second).definitions[0].id, 2);
        assert.equal(cache.stats().reservedBytes, 0);
    });
});
