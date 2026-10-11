const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const temporary = require('../../support/tempDirectories').trackTempDirectories();
const { buildFileStructure } = require('../../../out/core/scanner/fileIndexBuilder');
const { populateEntityPageDisplay } = require('../../../out/core/references/entityPageDisplay');
const { EntityQueryCache } = require('../../../out/core/references/entityQueryCache');

describe('entity page display', () => {
    it('reads only visible blocks, preserves names and IDs, and reuses unchanged prefixes', async () => {
        const root = temporary(path.join(os.tmpdir(), 'entity-display-')), file = path.join(root, 'model.k');
        fs.writeFileSync(file, '*KEYWORD\n' + Array.from({ length: 30 }, (_, i) =>
            `*PART\nPart ${i + 1}\n${i + 1},1,1\n`).join('') + '*END\n');
        const index = await buildFileStructure(file, { deferDisplayIdentity: true });
        assert.equal(index.keywordBlocks.some(block => block.displayIdentity), false);
        index.sourceRevision = 'first';
        const snapshot = { fileIndexes: new Map([[file, index]]) }, cache = new EntityQueryCache(1024 * 1024);
        const rows = () => [1, 30].map(id => ({ filePath: file, line: index.keywordBlocks[id].startLine + 2, role: 'reference' }));
        const original = fs.promises.open;
        let reads = 0;
        fs.promises.open = async (...args) => { if (args[0] === file) reads++; return original(...args); };
        try {
            const first = rows();
            await populateEntityPageDisplay(snapshot, first, { id: 1, targetKind: 'material' }, cache);
            assert.deepEqual(first.map(row => [row.entityId, row.entityName]), [['1', 'Part 1'], ['30', 'Part 30']]);
            assert.equal(reads, 2);
            await populateEntityPageDisplay(snapshot, rows(), { id: 2, targetKind: 'material' }, cache);
            assert.equal(reads, 2);
            index.sourceRevision = 'edited';
            await populateEntityPageDisplay(snapshot, rows(), { id: 2, targetKind: 'material' }, cache);
            assert.equal(reads, 4);
        } finally { fs.promises.open = original; }
    });
});


it('reports deliberately excluded mesh queries as unsupported for object-backed snapshots', async () => {
    const service = new (require('../../../out/core/references/entityReferenceQueryService').EntityReferenceQueryService)();
    const result = await service.queryById({ rootFile: 'model.k', fileIndexes: {
        'model.k': { excludeMeshEntities: true },
    } }, 1, 'node');
    assert.equal(result.state, 'unsupported');
    assert.deepEqual(result.locations, []);
});
