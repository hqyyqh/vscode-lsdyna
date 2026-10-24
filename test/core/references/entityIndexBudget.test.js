const assert = require('node:assert/strict');
const path = require('node:path');
const { EntityReferenceQueryService } = require('../../../out/core/references/entityReferenceQueryService');
const { buildProjectReferenceIndexAsync } = require('../../../out/core/references/projectReferenceIndex');
const { EntityQueryBudgetError } = require('../../../out/core/references/entityQueryBudgetError');
const { estimateMemorySize } = require('../../../out/core/cache/memorySize');

describe('project reference index budget', function () {
    this.timeout(30000);
    function snapshot(count) {
        const filePath = path.resolve('model/level1/level2/level3/level4/level5/materials.k');
        const definitions = Array.from({ length: count }, (_, i) => ({ kind: 'material', targetKind: 'material',
            keyword: '*MAT_ELASTIC', id: i + 1, filePath, startLine: i, endLine: i }));
        return { rootFile: filePath, files: [filePath], graph: { includeOccurrences: [], includeOccurrencesComplete: true },
            fileIndexes: new Map([[filePath, { referenceDefinitions: { genericDefinitions: definitions } }]]) };
    }
    it('builds 40000 definitions with the service budget and releases its reservation', async () => {
        const service = new EntityReferenceQueryService(64 * 1024 * 1024);
        const input = snapshot(40000);
        const index = await service.indexAsync(input, null);
        assert.equal(index.allDefinitionOccurrences.length, 40000);
        assert.equal(index.allDefinitionOccurrences.at(-1).id, 40000);
        assert(estimateMemorySize(index, service.cache.maxBytes) <= service.cache.maxBytes);
        assert.equal(service.cache.stats().reservedBytes, 0);
        assert.equal(await service.indexAsync(input, null), index);
    });
    it('still rejects an oversized index and releases the reservation', async () => {
        const service = new EntityReferenceQueryService(1024);
        await assert.rejects(service.indexAsync(snapshot(100), null), error =>
            error instanceof EntityQueryBudgetError && error.reason === 'entity-query-index-budget' && error.budgetBytes === 1024);
        assert.equal(service.cache.stats().reservedBytes, 0);
    });
    it('lets different snapshots finish when their builds overlap', async () => {
        const service = new EntityReferenceQueryService(64 * 1024 * 1024);
        const results = await Promise.all([service.indexAsync(snapshot(12000), null), service.indexAsync(snapshot(12001), null)]);
        assert.deepEqual(results.map(index => index.allDefinitionOccurrences.length), [12000, 12001]);
        assert.equal(service.cache.stats().reservedBytes, 0);
    });
    it('cancels a queued build without cancelling its predecessor or poisoning the queue', async () => {
        const service = new EntityReferenceQueryService(64 * 1024 * 1024);
        const token = { isCancellationRequested: false };
        const first = service.indexAsync(snapshot(12000), null);
        const queued = service.indexAsync(snapshot(12001), token);
        setTimeout(() => { token.isCancellationRequested = true; }, 0);
        await assert.rejects(queued, { name: 'CancellationError' });
        assert.equal((await first).allDefinitionOccurrences.length, 12000);
        assert.equal((await service.indexAsync(snapshot(1), null)).allDefinitionOccurrences.length, 1);
        assert.equal(service.cache.stats().reservedBytes, 0);
    });
    it('includes late-growing containers in the final budget check', async () => {
        const input = snapshot(0);
        input.fileIndexes.get(input.rootFile).registryReferences = {
            referenceCoverage: { complete: false, gaps: [{ reason: 'x'.repeat(4000) }] } };
        await assert.rejects(buildProjectReferenceIndexAsync(input, null, 4096), error =>
            error.reason === 'entity-query-index-budget');
    });
    it('handles 150000 registered references without spreading them into call arguments', async () => {
        const input = snapshot(0);
        input.fileIndexes.get(input.rootFile).registryReferences = {
            referenceOccurrences: Array.from({ length: 150000 }, (_, id) => ({ id })), complete: true };
        const index = await buildProjectReferenceIndexAsync(input, null, 64 * 1024 * 1024);
        assert.equal(index.registryReferenceOccurrences.length, 150000);
        assert.equal(index.registryReferenceOccurrences.at(-1).id, 149999);
    });
    it('counts shared payload once across build steps but retains distinct values', () => {
        const shared = { text: 'shared'.repeat(1000) };
        const accounting = { seen: new WeakSet(), strings: new Set() };
        const first = estimateMemorySize({ shared }, Infinity, accounting);
        const second = estimateMemorySize({ shared }, Infinity, accounting);
        assert(first > 10000); assert(second < 100);
        assert(estimateMemorySize({ text: 'different'.repeat(1000) }, Infinity, accounting) > 10000);
    });
});
