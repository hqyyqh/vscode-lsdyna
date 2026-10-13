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
    it('preserves another connection builds and idle published cursors until its owner closes', async () => {
        const root = temporary(path.join(os.tmpdir(), 'entity-clear-'));
        const a = await open(root), b = await open(root);
        const published = await a.begin('published', 'v1');
        await a.append(published, Array.from({ length: 250 }, (_, line) => record(1, line)));
        await a.publish(published, complete);
        const first = await b.page('published', 'v1', 'NODE', 1, 'definition');
        assert.ok(first.next);
        const active = await b.begin('active', 'v1'); await b.append(active, [record(2)]);
        const result = await a.clear();
        assert.equal(result.removed, 0);
        assert.equal(result.retainedReason, 'active-index-owner');
        assert.equal((await b.page('published', 'v1', 'NODE', 1, 'definition')).state, 'ready');
        const next = await b.page('published', 'v1', 'NODE', 1, 'definition', first.next);
        assert.equal(next.records.length, 50); assert.equal(next.records[0].line, 200);
        await b.publish(active, complete);
        assert.equal((await a.page('active', 'v1', 'NODE', 2, 'definition')).records.length, 1);
        await b.close();
        assert.equal((await a.clear()).removed, 2);
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

    it('returns freed disk space on explicit clear and leaves source files untouched', async () => {
        const fs = require('node:fs');
        const root = temporary(path.join(os.tmpdir(), 'entity-reclaim-'));
        const source = path.join(root, 'model.k'), manual = path.join(root, 'manual.pdf');
        fs.writeFileSync(source, '*NODE\n1,0,0,0\n'); fs.writeFileSync(manual, '%PDF original');
        const store = await open(root);
        const build = await store.begin('main', 'one');
        for (let start = 0; start < 500; start += 40) await store.append(build,
            Array.from({ length: 40 }, (_, i) => ({ ...record(start + i + 1), payload: { value: 'x'.repeat(2000) } })));
        await store.publish(build, complete);
        const before = (await store.stats()).bytes;
        const cleared = await store.clear();
        assert.equal(cleared.removed, 1);
        assert.ok(cleared.reclaimedBytes > 512 * 1024);
        assert.equal(cleared.reclaimedBytes, before - (await store.stats()).bytes);
        assert.equal(fs.readFileSync(source, 'utf8'), '*NODE\n1,0,0,0\n');
        assert.equal(fs.readFileSync(manual, 'utf8'), '%PDF original');
        const next = await store.begin('new', 'two'); await store.append(next, [record(2)]); await store.publish(next, complete);
        assert.equal((await store.page('new', 'two', 'NODE', 2, 'definition')).state, 'ready');
    });

    it('protects idle published data from expiry while another connection owns the cache', async () => {
        let now = 1000;
        const root = temporary(path.join(os.tmpdir(), 'entity-owned-expiry-'));
        const a = await open(root, { now: () => now }), b = await open(root, { now: () => now });
        const build = await a.begin('main', 'one'); await a.append(build, [record(1)]); await a.publish(build, complete);
        now += 40 * 24 * 60 * 60 * 1000;
        assert.equal((await a.prune()).removed, 0);
        await b.close();
        assert.equal((await a.prune()).removed, 1);
    });

    it('keeps a live process index and reaps its ownership after abrupt process exit', async () => {
        const { spawn } = require('node:child_process');
        const { once } = require('node:events');
        const root = temporary(path.join(os.tmpdir(), 'entity-process-owner-'));
        const store = await open(root);
        const child = spawn(process.execPath, ['-e', `
            const { EntityIndexStore } = require('./out/core/cache/entityIndexStore');
            (async () => {
                const store = await EntityIndexStore.open(process.argv[1]);
                const build = await store.begin('child', 'one');
                await store.publish(build, { state: 'complete', reasons: [] });
                process.on('message', () => process.exit(0));
                process.send('ready');
            })().catch(error => { process.send({ error: String(error) }); process.exit(1); });
        `, root], { cwd: path.resolve(__dirname, '../../..'), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        let stderr = ''; child.stderr.on('data', value => { stderr += value; });
        const exited = once(child, 'exit');
        try {
            const message = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error(stderr || 'Child exited before ready'); })]);
            assert.equal(message[0], 'ready');
            assert.equal((await store.clear()).retainedReason, 'active-index-owner');
            assert.equal((await store.page('child', 'one', 'NODE', 1, 'definition')).state, 'ready');
            child.send('exit'); await exited;
            assert.equal((await store.clear()).removed, 1);
        } finally { if (child.exitCode === null) { child.kill(); await exited; } }
    });

    it('rejects hard-linked databases and preserves unowned SQLite data byte for byte', async () => {
        const fs = require('node:fs');
        const root = temporary(path.join(os.tmpdir(), 'entity-source-protection-'));
        const databaseRoot = path.join(root, 'entity-index-v4'); fs.mkdirSync(databaseRoot);
        const source = path.join(root, 'original.k'); fs.writeFileSync(source, '*NODE\n1,0,0,0\n');
        const target = path.join(databaseRoot, 'index.sqlite'); fs.linkSync(source, target);
        await assert.rejects(EntityIndexStore.open(root), /Unsafe entity index/);
        assert.equal(fs.readFileSync(source, 'utf8'), '*NODE\n1,0,0,0\n');
        fs.unlinkSync(target);
        const sqlite = require('@vscode/sqlite3'), db = new sqlite.Database(target);
        await new Promise((resolve, reject) => db.exec('CREATE TABLE user_data (value TEXT); INSERT INTO user_data VALUES (\'keep\')',
            error => error ? reject(error) : resolve()));
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
        const before = fs.readFileSync(target);
        await assert.rejects(EntityIndexStore.open(root), /Incompatible entity index/);
        assert.deepEqual(fs.readFileSync(target), before);
    });

    it('makes bounded progress through more than 200 abandoned owner records', async () => {
        let now = 1000;
        const store = await open(temporary(path.join(os.tmpdir(), 'entity-owner-batch-')), { now: () => now });
        const build = await store.begin('main', 'one'); await store.publish(build, complete);
        const originalKill = process.kill;
        process.kill = (pid, signal) => {
            if (pid === 2147483647 && signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
            return originalKill(pid, signal);
        };
        try {
            await new Promise((resolve, reject) => store.db.exec(`WITH RECURSIVE n(value) AS
                (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<201)
                INSERT INTO cache_owners SELECT 'abandoned-'||value,2147483647 FROM n`, error => error ? reject(error) : resolve()));
            now++;
            assert.equal((await store.prune(0)).removed, 0);
            assert.equal((await store.prune(0)).removed, 1);
        } finally { process.kill = originalKill; }
    });

    it('reclaims ownership-aware old caches and preserves unknown versions, files and active owners', async () => {
        const fs = require('node:fs');
        const root = temporary(path.join(os.tmpdir(), 'entity-old-reclaim-'));
        const old = await open(root);
        const build = await old.begin('old', 'one');
        for (let start = 0; start < 200; start += 40) await old.append(build,
            Array.from({ length: 40 }, (_, i) => ({ ...record(start + i + 1), payload: { value: 'x'.repeat(2000) } })));
        await old.publish(build, complete); await old.close();
        const previous = path.join(root, 'entity-index-v3');
        fs.renameSync(old.directory, previous);
        const store = await open(root);
        const sqlite = require('@vscode/sqlite3');
        const db = new sqlite.Database(path.join(previous, 'index.sqlite'));
        const sql = text => new Promise((resolve, reject) => db.exec(text, error => error ? reject(error) : resolve()));
        try {
            await sql(`INSERT INTO cache_owners VALUES ('another-worker',${process.pid})`);
            assert.equal((await store.cleanLegacy()).retained, 1);
            await sql("DELETE FROM cache_owners");
            const result = await store.cleanLegacy();
            assert.equal(result.retained, 0); assert.ok(result.reclaimedBytes > 200 * 1024);
        } finally { await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }
        const unknown = path.join(root, 'entity-index-v1'); fs.mkdirSync(unknown);
        const source = path.join(unknown, 'index.sqlite'); fs.writeFileSync(source, 'user input, not an index');
        const before = fs.readFileSync(source);
        assert.equal((await store.cleanLegacy()).retained, 1);
        assert.deepEqual(fs.readFileSync(source), before);
        fs.writeFileSync(path.join(previous, 'manual.pdf'), 'keep');
        assert.equal((await store.cleanLegacy()).retained, 2);
        assert.equal(fs.readFileSync(path.join(previous, 'manual.pdf'), 'utf8'), 'keep');
    });

    it('schedules at most one hourly maintenance pass and stops scheduling on close', async () => {
        const store = await open(temporary(path.join(os.tmpdir(), 'entity-periodic-')));
        const originalSet = global.setInterval, originalClear = global.clearInterval;
        let callback, calls = 0, cancelled = false, release;
        const gate = new Promise(resolve => { release = resolve; });
        const timer = { unref() {} };
        const originalPrune = store.prune.bind(store);
        store.prune = async age => { assert.equal(age, 12345); calls++; await gate; return originalPrune(age); };
        global.setInterval = (fn, delay) => { assert.equal(delay, 3600000); callback = fn; return timer; };
        global.clearInterval = handle => { assert.equal(handle, timer); cancelled = true; };
        try {
            store.startMaintenance(12345, error => { throw error; });
            callback(); callback(); assert.equal(calls, 1);
            release();
            for (let attempts = 0; store.maintenanceTask && attempts < 10000; attempts++) await new Promise(setImmediate);
            assert.equal(store.maintenanceTask, undefined);
            await store.close(); assert.equal(cancelled, true);
            callback(); assert.equal(calls, 1);
        } finally { release(); global.setInterval = originalSet; global.clearInterval = originalClear; }
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
        const peer = await open(path.dirname(store.directory), { diskBytes: 8 * 1024 * 1024, now: () => now });
        now += 31000;
        const sharedPressure = await store.begin('shared-pressure', 'v1');
        await assert.rejects(fill(sharedPressure), error => error.code === 'SQLITE_FULL');
        assert.equal((await peer.page('next', 'v1', 'NODE', 1, 'definition')).state, 'ready');
        await store.abandon(sharedPressure); await peer.close();
    });

    it('fails closed on corruption without deleting data and retains recently queried generations', async () => {
        const fs = require('node:fs');
        const root = temporary(path.join(os.tmpdir(), 'entity-corrupt-'));
        const directory = path.join(root, 'entity-index-v4');
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
