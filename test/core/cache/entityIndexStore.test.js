'use strict';
const assert = require('node:assert/strict');
const path = require('node:path'), os = require('node:os');
const { EntityIndexStore } = require('../../../out/core/cache/entityIndexStore');
const { trackTempDirectories } = require('../../support/tempDirectories');

describe('SQLite entity index generations', function() {
    this.timeout(15000);
    const stores = [];
    afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
    const temporary = trackTempDirectories();
    const open = async (root, options) => {
        const store = await EntityIndexStore.open(root, options); stores.push(store); return store;
    };
    const record = (id, line = 0, context = 'root') => ({ key: `${id}:${typeof id}:${line}:${context}`, kind: 'NODE', id,
        role: 'definition', file: 'model.k', block: 'nodes', line, start: 0, end: 8, context, payload: { id, line, context } });
    const complete = { state: 'complete', reasons: [] };

    it('keeps builds invisible and publishes atomically; reopening retains exact numeric and string IDs', async () => {
        const root = temporary(path.join(os.tmpdir(), 'entity-store-'));
        const store = await open(root);
        const build = await store.begin('main:NODE', 'v1');
        await store.append(build, [record(2147483648), record('2147483648'), record('named'), record(2147483648, 0, 'include:2')]);
        assert.equal((await store.page(build.key, 'v1', 'NODE', 2147483648, 'definition')).state, 'miss');
        await store.publish(build, complete);
        await store.close();
        const reopened = await open(root);
        const numeric = await reopened.page(build.key, 'v1', 'NODE', 2147483648, 'definition');
        assert.equal(numeric.records.length, 2);
        assert.equal(numeric.records[0].id, 2147483648);
        assert.deepEqual((await reopened.page(build.key, 'v1', 'NODE', '2147483648', 'definition')).records, [{ id: '2147483648', line: 0, context: 'root' }]);
        assert.equal((await reopened.page(build.key, 'v2', 'NODE', 2147483648, 'definition')).state, 'miss');
        assert.equal((await reopened.page(build.key, 'v1', 'CURVE', 2147483648, 'definition')).records.length, 0);
    });

    it('returns bounded pages and rejects cursors after publication or query changes', async () => {
        const store = await open(temporary(path.join(os.tmpdir(), 'entity-pages-')));
        const build = await store.begin('main', 'one');
        for (let start = 0; start < 450; start += 150)
            await store.append(build, Array.from({ length: 150 }, (_, i) => record(1, start + 149 - i)));
        await store.publish(build, { state: 'partial', reasons: ['unresolved-parameter'] });
        const first = await store.page('main', 'one', 'NODE', 1, 'definition');
        const second = await store.page('main', 'one', 'NODE', 1, 'definition', first.next);
        const third = await store.page('main', 'one', 'NODE', 1, 'definition', second.next);
        assert.deepEqual([first.records.length, second.records.length, third.records.length], [200, 200, 50]);
        assert.equal(third.next, undefined);
        assert.equal(first.coverage.state, 'partial');
        assert.equal(new Set([...first.records, ...second.records, ...third.records].map(row => row.line)).size, 450);
        assert.deepEqual(first.records.map(row => row.line), Array.from({ length: 200 }, (_, i) => i));
        assert.equal((await store.page('main', 'one', 'NODE', 2, 'definition', first.next)).state, 'expired');
        const replacement = await store.begin('main', 'one');
        await store.publish(replacement, complete);
        assert.equal((await store.page('main', 'one', 'NODE', 1, 'definition', first.next)).state, 'expired');
    });

    it('publishes bounded fact pages atomically and rejects a replaced generation', async () => {
        const store = await open(temporary(path.join(os.tmpdir(), 'index-facts-')));
        const build = await store.begin('resolved', 'v1');
        const rows = Array.from({ length: 450 }, (_, ordinal) => ({ section: 'reference', ordinal, payload: { ordinal } }));
        await store.appendFacts(build, rows);
        assert.equal((await store.factPage('resolved', undefined, 'reference')).state, 'miss');
        await store.publish(build, complete);
        const first = await store.factPage('resolved', 'v1', 'reference');
        const second = await store.factPage('resolved', 'v1', 'reference', first.next, undefined, first.generation);
        assert.deepEqual([first.records.length, second.records.length], [200, 200]);
        assert.equal(second.records[0].ordinal, 200);
        const replacement = await store.begin('resolved', 'v1');
        const cancelled = { isCancellationRequested: true };
        await assert.rejects(store.appendFacts(replacement, rows, cancelled), { name: 'CancellationError' });
        await store.publish(replacement, complete);
        assert.equal((await store.factPage('resolved', 'v1', 'reference', second.next, undefined, first.generation)).state, 'expired');
        await assert.rejects(store.factPage('resolved', 'v1', 'reference', 0, cancelled), { name: 'CancellationError' });
    });

    it('coordinates builders across connections and prevents an expired owner from publishing', async () => {
        let now = 1000;
        const root = temporary(path.join(os.tmpdir(), 'entity-lease-'));
        const a = await open(root, { now: () => now }), b = await open(root, { now: () => now });
        const original = await a.begin('main', 'v1');
        assert.equal(await b.begin('main', 'v1'), null);
        now += 30001;
        const replacement = await b.begin('main', 'v1');
        assert.ok(replacement);
        await assert.rejects(a.publish(original, complete), /lease expired/);
        await b.append(replacement, [record(1)]);
        await b.publish(replacement, complete);
        assert.equal((await a.page('main', 'v1', 'NODE', 1, 'definition')).records.length, 1);
    });
    it('clears published generations while preserving another connection active build', async () => {
        const root = temporary(path.join(os.tmpdir(), 'entity-clear-'));
        const a = await open(root), b = await open(root);
        const published = await a.begin('published', 'v1'); await a.append(published, [record(1)]); await a.publish(published, complete);
        const active = await b.begin('active', 'v1'); await b.append(active, [record(2)]);
        assert.equal((await a.clear()).removed, 1);
        assert.equal((await a.page('published', 'v1', 'NODE', 1, 'definition')).state, 'miss');
        await b.publish(active, complete);
        assert.equal((await a.page('active', 'v1', 'NODE', 2, 'definition')).records.length, 1);
    });

    it('rolls back cancelled batches and never publishes cancellation as completion', async () => {
        const store = await open(temporary(path.join(os.tmpdir(), 'entity-cancel-')));
        const build = await store.begin('main', 'v1');
        let calls = 0;
        const token = { get isCancellationRequested() { return ++calls >= 3; } };
        await assert.rejects(store.append(build, [record(1), record(2), record(3)], token), { name: 'CancellationError' });
        await assert.rejects(store.publish(build, { state: 'cancelled', reasons: [] }), /cannot publish/);
        await store.publish(build, complete);
        assert.deepEqual((await store.page('main', 'v1', 'NODE', 1, 'definition')).records, []);
        await assert.rejects(store.page('main', 'v1', 'NODE', 1, 'definition', undefined, { isCancellationRequested: true }), { name: 'CancellationError' });
    });
    it('interrupts a long SQLite write and leaves its transaction usable after cancellation', async () => {
        const store = await open(temporary(path.join(os.tmpdir(), 'entity-interrupt-')));
        const sql = text => new Promise((resolve, reject) => store.db.exec(text, error => error ? reject(error) : resolve()));
        await sql(`CREATE TRIGGER slow_insert BEFORE INSERT ON records BEGIN
            SELECT (WITH RECURSIVE counter(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM counter WHERE x<100000000)
                SELECT SUM(x) FROM counter); END;`);
        const build = await store.begin('main', 'v1'), token = { isCancellationRequested: false };
        let requestedAt;
        const timer = setTimeout(() => { requestedAt = performance.now(); token.isCancellationRequested = true; }, 20);
        try {
            await assert.rejects(store.append(build, [record(1)], token), { name: 'CancellationError' });
            assert.ok(performance.now() - requestedAt < 250);
        } finally { clearTimeout(timer); }
        await sql('DROP TRIGGER slow_insert');
        await store.append(build, [record(2)]); await store.publish(build, complete);
        assert.equal((await store.page('main', 'v1', 'NODE', 1, 'definition')).records.length, 0);
        assert.equal((await store.page('main', 'v1', 'NODE', 2, 'definition')).records.length, 1);
    });

    it('stores source and block facts separately, accounts for all cache files, and prunes expired builds', async () => {
        let now = 1000;
        const root = temporary(path.join(os.tmpdir(), 'entity-metadata-'));
        const store = await open(root, { now: () => now });
        const build = await store.begin('main', 'v1');
        const file = path.join(root, 'model.k');
        await store.metadata(build, { files: [{ file, revision: 'stat identity', parser: 'parser-v1' }],
            blocks: [{ file, anchor: 'nodes', line: 12, offset: 120 }],
            contexts: [{ context: 'include:2', file, parent: 'root', facts: { nodeOffset: 100 } }] });
        await store.publish(build, complete);
        assert.deepEqual((await store.filePage('main', 'v1')).files, [{ file, revision: 'stat identity', parser: 'parser-v1' }]);
        const abandoned = await store.begin('other', 'v1');
        await store.append(abandoned, [record(1)]);
        now += 30001;
        assert.equal((await store.prune()).removed, 1);
        await assert.rejects(store.publish(abandoned, complete), /lease expired/);
        const fs = require('node:fs');
        const before = await store.stats();
        fs.writeFileSync(path.join(store.directory, 'temporary-build.bin'), Buffer.alloc(12345));
        assert.equal((await store.stats()).bytes, before.bytes + 12345);
        now += 31 * 24 * 60 * 60 * 1000;
        assert.equal((await store.prune()).removed, 1);
        assert.equal((await store.page('main', 'v1', 'NODE', 1, 'definition')).state, 'miss');
    });

    it('counts older cache formats against the same disk budget without deleting their files', async () => {
        const fs = require('node:fs');
        const root = temporary(path.join(os.tmpdir(), 'entity-old-format-budget-'));
        const store = await open(root, { diskBytes: 8 * 1024 * 1024 });
        const before = await store.stats();
        const old = path.join(root, 'entity-index-v1'); fs.mkdirSync(old);
        const file = path.join(old, 'index.sqlite'); fs.writeFileSync(file, Buffer.alloc(7 * 1024 * 1024));
        assert.equal((await store.stats()).bytes, before.bytes + 7 * 1024 * 1024);
        await assert.rejects(store.begin('main', 'v1'), /disk budget exhausted/);
        assert.equal(fs.statSync(file).size, 7 * 1024 * 1024);
    });

    it('rejects oversized records and includes temporary files when enforcing the disk budget', async () => {
        const root = temporary(path.join(os.tmpdir(), 'entity-budget-'));
        const store = await open(root, { diskBytes: 8 * 1024 * 1024 });
        const build = await store.begin('main', 'v1');
        assert.throws(() => store.append(build, [{ ...record(1), payload: 'x'.repeat(100000) }]), /record exceeds/);
        assert.throws(() => store.append(build, [{ ...record(1), payload: undefined }]), /Invalid.*payload/);
        await assert.rejects(store.append(build, [{ ...record(1), template: 'missing' }]), /FOREIGN KEY/);
        const fs = require('node:fs');
        fs.writeFileSync(path.join(store.directory, 'temporary-build.bin'), Buffer.alloc(7 * 1024 * 1024));
        await assert.rejects(store.append(build, [record(1)]), /disk budget exhausted/);
        await store.abandon(build);
        assert.equal((await store.page('main', 'v1', 'NODE', 1, 'definition')).state, 'miss');
    });
    it('evicts cold published generations on capacity pressure while keeping the new build atomic', async () => {
        let now = 1000;
        const store = await open(temporary(path.join(os.tmpdir(), 'entity-eviction-')), { diskBytes: 8 * 1024 * 1024, now: () => now });
        const fill = async build => {
            for (let start = 0; start < 400; start += 40) await store.append(build,
                Array.from({ length: 40 }, (_, offset) => ({ ...record(start + offset + 1), payload: { text: 'x'.repeat(2000) } })));
        };
        const cold = await store.begin('cold', 'v1'); await fill(cold); await store.publish(cold, complete);
        now += 31000;
        const next = await store.begin('next', 'v1'); await fill(next);
        assert.equal((await store.page('next', 'v1', 'NODE', 1, 'definition')).state, 'miss');
        await store.publish(next, complete);
        assert.equal((await store.page('next', 'v1', 'NODE', 1, 'definition')).records.length, 1);
        assert.equal((await store.page('cold', 'v1', 'NODE', 1, 'definition')).state, 'miss');
        assert.ok((await store.stats()).bytes <= 8 * 1024 * 1024);
        now += 20000;
        await store.page('next', 'v1', 'NODE', 1, 'definition');
        now += 20000;
        const pressure = await store.begin('pressure', 'v1');
        await assert.rejects(fill(pressure), error => error.code === 'SQLITE_FULL');
        assert.equal((await store.page('next', 'v1', 'NODE', 1, 'definition')).records.length, 1);
        assert.equal((await store.page('pressure', 'v1', 'NODE', 1, 'definition')).state, 'miss');
        await store.abandon(pressure);
    });

    it('fails closed on corruption without deleting data and retains recently queried generations', async () => {
        const fs = require('node:fs');
        const root = temporary(path.join(os.tmpdir(), 'entity-corrupt-'));
        const directory = path.join(root, 'entity-index-v2');
        fs.mkdirSync(directory);
        const database = path.join(directory, 'index.sqlite');
        fs.writeFileSync(database, 'not a database');
        await assert.rejects(EntityIndexStore.open(root), /database/);
        assert.equal(fs.readFileSync(database, 'utf8'), 'not a database');
        let now = 1000;
        const store = await open(temporary(path.join(os.tmpdir(), 'entity-access-')), { now: () => now });
        const build = await store.begin('main', 'v1');
        await store.append(build, [record(1)]); await store.publish(build, complete);
        now += 29 * 24 * 60 * 60 * 1000;
        await store.page('main', 'v1', 'NODE', 1, 'definition');
        now += 2 * 24 * 60 * 60 * 1000;
        assert.equal((await store.prune()).removed, 0);
    });
});
