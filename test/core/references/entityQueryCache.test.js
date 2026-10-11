'use strict';
const assert = require('assert');
const { EntityQueryCache } = require('../../../out/core/references/entityQueryCache');

describe('entity query cache ownership', () => {
    it('reuses serialized disk revisions but isolates replaced structure and reopened live documents', () => {
        const cache = new EntityQueryCache();
        const disk = { size: 10, mtimeMs: 1, scannerVersion: 1,
            keywordBlocks: [{ keyword: '*NODE', startLine: 0, endLine: 1, startOffset: 0, endOffset: 10 }] };
        assert.equal(cache.fileRevision(disk), cache.fileRevision(JSON.parse(JSON.stringify(disk))));
        assert.notEqual(cache.fileRevision(disk), cache.fileRevision({ ...disk, keywordBlocks: [] }));
        assert.notEqual(cache.fileRevision(disk), cache.fileRevision({ ...disk, mtimeMs: 2 }));
        assert.notEqual(cache.fileRevision({ ...disk, documentVersion: 1 }), cache.fileRevision({ ...disk, documentVersion: 1 }));
    });
    it('keeps immutable file shards on query invalidation and accounts for in-flight builds', () => {
        const cache = new EntityQueryCache(4096);
        const shardKey = JSON.stringify(['definition-type', 'a.k', 1]);
        const shard = { state: 'complete', byId: new Map([[1, []]]) };
        cache.set(shardKey, shard);
        cache.set('query', { state: 'complete' });
        const reservation = cache.reserveBuild();
        assert.equal(cache.stats().bytes + cache.stats().reservedBytes, 4096);
        assert.equal(cache.reserveBuild().bytes, 0);
        cache.set('other', { state: 'complete', text: 'x'.repeat(4096) });
        assert.equal(cache.get('other'), undefined);
        cache.invalidateQueries();
        assert.equal(cache.get('query'), undefined); assert.equal(cache.get(shardKey), shard);
        reservation.release(); reservation.release();
        assert.equal(cache.stats().reservedBytes, 0);
        cache.clear(); assert.equal(cache.get(shardKey), undefined);
    });
    it('reuses immutable products across wrappers, isolates scope and replaced file products', () => {
        const cache = new EntityQueryCache();
        const file = { size: 10, mtimeMs: 1, scannerVersion: 1 }, graph = { includeOccurrences: [] };
        const snapshot = { rootFile: 'root.k', scope: 'project', graph, fileIndexes: new Map([['root.k', file]]) };
        const revision = cache.revision(snapshot);
        assert.equal(cache.revision({ ...snapshot, fileIndexes: new Map(snapshot.fileIndexes) }), revision);
        assert.notEqual(cache.revision({ ...snapshot, scope: 'single-file' }), revision);
        assert.notEqual(cache.revision({ ...snapshot, fileIndexes: new Map([['root.k', { ...file }]]) }), revision);
        assert.notEqual(cache.revision({ ...snapshot, graph: { ...graph } }), revision);
        assert.notEqual(cache.revision({ ...snapshot, effectiveSearchPathsByFile: new Map([['root.k', ['a']]]) }),
            cache.revision({ ...snapshot, effectiveSearchPathsByFile: new Map([['root.k', ['b']]]) }));
        file.documentVersion = 2;
        assert.notEqual(cache.revision(snapshot), revision);
    });
    it('cancels one subscriber without cancelling another, then reuses the completed result', async () => {
        const cache = new EntityQueryCache(); let release, builds = 0, shared;
        const gate = new Promise(resolve => { release = resolve; });
        const build = async token => { builds++; shared = token; await gate; return { state: 'complete', locations: [] }; };
        const first = { isCancellationRequested: false }, second = { isCancellationRequested: false };
        const a = cache.run('q', first, build), b = cache.run('q', second, build);
        first.isCancellationRequested = true;
        await assert.rejects(a, { name: 'CancellationError' });
        assert.equal(shared.isCancellationRequested, false);
        release(); await b; await cache.run('q', null, build);
        assert.equal(builds, 1);
    });
    it('does not retain incomplete, invalidated or oversized results', async () => {
        const cache = new EntityQueryCache(1024); let builds = 0;
        const partial = async () => { builds++; return { state: 'partial' }; };
        await cache.run('partial', null, partial); await cache.run('partial', null, partial);
        assert.equal(builds, 2);
        cache.set('large', { value: 'x'.repeat(2000) }); assert.equal(cache.get('large'), undefined);
        let release; const gate = new Promise(resolve => { release = resolve; });
        const pending = cache.run('q', null, async () => { await gate; return { state: 'complete' }; });
        cache.clear(); release(); await assert.rejects(pending, { name: 'CancellationError' });
        assert.equal(cache.get('q'), undefined);
        assert.equal(cache.stats().bytes, 0);
    });
    it('evicts oldest entries within the configured budget', () => {
        const cache = new EntityQueryCache(600);
        cache.set('a', { text: 'a'.repeat(60) }); cache.set('b', { text: 'b'.repeat(60) });
        cache.get('a'); cache.set('c', { text: 'c'.repeat(60) });
        assert.ok(cache.get('a')); assert.equal(cache.get('b'), undefined); assert.ok(cache.get('c'));
        assert.ok(cache.stats().bytes <= 600);
    });
});
