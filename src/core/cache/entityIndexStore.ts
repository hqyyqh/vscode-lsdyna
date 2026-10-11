import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database } from '@vscode/sqlite3';
const { entityIdentityKey } = require('../references/entityIdentity');
const { throwIfCancellationRequested } = require('../scanner/scannerContracts');

const SCHEMA = 2;
const LEASE_MS = 30_000;
const BATCH_BYTES = 256 * 1024;
type Token = { isCancellationRequested: boolean };
export type EntityIndexRecord = {
    key: string; kind: string; id: string | number; role: 'definition' | 'reference';
    file: string; block: string; line: number; start: number; end: number;
    context: string; payload: unknown;
    template?: string;
};
export type EntityIndexBuild = { key: string; revision: string; generation: string; owner: string };
export type EntityIndexCursor = { generation: string; kind: string; id: string; role: string;
    after: [string, number, number, string] };
type Options = { memoryBytes?: number; diskBytes?: number; now?: () => number };
export type EntityIndexMetadata = {
    files?: { file: string; revision: string; parser: string }[];
    blocks?: { file: string; anchor: string; line: number; offset: number }[];
    contexts?: { context: string; parent?: string; file: string; facts: unknown }[];
};

/** Owns only the versioned extension cache. Model files are never opened for writing. */
export class EntityIndexStore {
    private tail: Promise<unknown> = Promise.resolve();
    private closed = false;
    private rollingBack = false;
    private readonly now: () => number;
    private constructor(private db: Database, readonly directory: string, private options: Options) {
        this.now = options.now || Date.now;
    }

    static async open(storageDirectory: string, options: Options = {}) {
        const memoryBytes = options.memoryBytes ?? 32 * 1024 * 1024;
        const diskBytes = options.diskBytes ?? 4 * 1024 ** 3;
        if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1024 * 1024 ||
            !Number.isSafeInteger(diskBytes) || diskBytes < 8 * 1024 * 1024)
            throw new Error('Invalid entity index budget');
        const root = path.resolve(storageDirectory);
        if (/^(?:\\\\|\/\/)/.test(root)) throw new Error('Entity index requires local storage');
        await fs.promises.mkdir(root, { recursive: true });
        const realRoot = await fs.promises.realpath(root);
        if (/^(?:\\\\|\/\/)/.test(realRoot)) throw new Error('Entity index requires local storage');
        const directory = path.join(realRoot, `entity-index-v${SCHEMA}`);
        await fs.promises.mkdir(directory, { recursive: true });
        if ((await fs.promises.lstat(directory)).isSymbolicLink() || await fs.promises.realpath(directory) !== directory)
            throw new Error('Entity index directory must not redirect outside local storage');
        for (const name of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm', 'index.sqlite-journal']) {
            const stat = await fs.promises.lstat(path.join(directory, name)).catch(error => {
                if (error.code !== 'ENOENT') throw error;
                return undefined;
            });
            if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Unsafe entity index cache file');
        }
        // Lazy loading keeps the existing bounded query path usable if the native driver cannot load.
        const sqlite: typeof import('@vscode/sqlite3') = require('@vscode/sqlite3');
        const db = await new Promise<Database>((resolve, reject) => {
            const value = new sqlite.Database(path.join(directory, 'index.sqlite'), error => error ? reject(error) : resolve(value));
        });
        const store = new EntityIndexStore(db, directory, { ...options, memoryBytes, diskBytes });
        try {
            await store.exec(`PRAGMA busy_timeout=100; PRAGMA foreign_keys=ON;
                PRAGMA temp_store=MEMORY; PRAGMA cache_size=-${Math.floor(memoryBytes / 2 / 1024)};
                PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=DELETE;
                PRAGMA journal_size_limit=1048576;
                PRAGMA max_page_count=${Math.floor(diskBytes / 4 / 4096)};`);
            const version = await store.get('PRAGMA user_version');
            if (version.user_version !== 0 && version.user_version !== SCHEMA) throw new Error('Incompatible entity index schema');
            await store.exec(`CREATE TABLE IF NOT EXISTS generations (
                generation TEXT PRIMARY KEY, shard TEXT NOT NULL, revision TEXT NOT NULL,
                state TEXT NOT NULL, owner TEXT NOT NULL, lease INTEGER NOT NULL,
                accessed INTEGER NOT NULL, coverage TEXT);
                CREATE INDEX IF NOT EXISTS generations_shard ON generations(shard, revision, state);
                CREATE TABLE IF NOT EXISTS published (shard TEXT PRIMARY KEY, generation TEXT NOT NULL
                    REFERENCES generations(generation) ON DELETE CASCADE);
                CREATE TABLE IF NOT EXISTS records (
                    ordinal INTEGER PRIMARY KEY, generation TEXT NOT NULL REFERENCES generations(generation) ON DELETE CASCADE,
                    record_key TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL,
                    file TEXT NOT NULL, block TEXT NOT NULL, line INTEGER NOT NULL,
                    start INTEGER NOT NULL, end INTEGER NOT NULL, context TEXT NOT NULL, payload TEXT NOT NULL,
                    template TEXT,
                    UNIQUE(generation, kind, id, role, record_key),
                    FOREIGN KEY(generation,template) REFERENCES record_templates(generation,template) ON DELETE CASCADE);
                CREATE INDEX IF NOT EXISTS records_query ON records(generation, kind, id, role, file, line, start, record_key);
                CREATE TABLE IF NOT EXISTS record_templates (
                    generation TEXT NOT NULL REFERENCES generations(generation) ON DELETE CASCADE,
                    template TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(generation,template));
                CREATE TABLE IF NOT EXISTS files (
                    generation TEXT NOT NULL REFERENCES generations(generation) ON DELETE CASCADE,
                    file TEXT NOT NULL, revision TEXT NOT NULL, parser TEXT NOT NULL, PRIMARY KEY(generation,file));
                CREATE TABLE IF NOT EXISTS blocks (
                    generation TEXT NOT NULL REFERENCES generations(generation) ON DELETE CASCADE,
                    file TEXT NOT NULL, anchor TEXT NOT NULL, line INTEGER NOT NULL, offset INTEGER NOT NULL,
                    PRIMARY KEY(generation,file,anchor));
                CREATE TABLE IF NOT EXISTS contexts (
                    generation TEXT NOT NULL REFERENCES generations(generation) ON DELETE CASCADE,
                    context TEXT NOT NULL, parent TEXT, file TEXT NOT NULL, facts TEXT NOT NULL,
                    PRIMARY KEY(generation,context));
                CREATE TABLE IF NOT EXISTS facts (
                    generation TEXT NOT NULL REFERENCES generations(generation) ON DELETE CASCADE,
                    section TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL,
                    PRIMARY KEY(generation,section,ordinal));
                PRAGMA user_version=${SCHEMA};`);
            await store.assertCapacity();
            return store;
        } catch (error) { await store.close(); throw error; }
    }

    private exec(sql: string): Promise<void> {
        return new Promise((resolve, reject) => this.db.exec(sql, error => error ? reject(error) : resolve()));
    }
    private run(sql: string, args: unknown[] = []): Promise<number> {
        return new Promise((resolve, reject) => this.db.run(sql, args, function(error) {
            if (error) reject(error); else resolve(this.changes);
        }));
    }
    private get(sql: string, args: unknown[] = []): Promise<any> {
        return new Promise((resolve, reject) => this.db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));
    }
    private all(sql: string, args: unknown[] = []): Promise<any[]> {
        return new Promise((resolve, reject) => this.db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
    }
    private serial<T>(operation: () => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(new Error('Entity index is closed'));
        const pending = this.tail.then(operation);
        this.tail = pending.catch(() => {});
        return pending;
    }
    private async transaction<T>(operation: () => Promise<T>): Promise<T> {
        await this.exec('BEGIN IMMEDIATE');
        try { const value = await operation(); await this.exec('COMMIT'); return value; }
        catch (error) {
            this.rollingBack = true;
            try { await this.exec('ROLLBACK').catch(() => {}); }
            finally { this.rollingBack = false; }
            throw error;
        }
    }
    private async appendWithEviction(operation: () => Promise<void>, token?: Token) {
        for (let evictions = 0; ; evictions++) {
            throwIfCancellationRequested(token);
            try { return await this.transaction(operation); }
            catch (error) {
                throwIfCancellationRequested(token);
                if (error.code !== 'SQLITE_FULL' || evictions >= 8) throw error;
                // Limit each retry's work; never evict a building generation or a recent reader.
                const removed = await this.transaction(async () => {
                    const oldest = await this.get(`SELECT generation FROM generations WHERE state='published'
                        AND accessed<? ORDER BY accessed,generation LIMIT 1`, [this.now() - LEASE_MS]);
                    throwIfCancellationRequested(token);
                    if (!oldest) return 0;
                    return this.run('DELETE FROM generations WHERE generation=?', [oldest.generation]);
                });
                if (!removed) throw error;
            }
        }
    }
    private async cancellable<T>(operation: () => Promise<T>, token?: Token): Promise<T> {
        throwIfCancellationRequested(token);
        const timer = token ? setInterval(() => {
            // Retry across queued native statements, but always let rollback finish.
            if (token.isCancellationRequested && !this.rollingBack) this.db.interrupt();
        }, 10) : undefined;
        try { const result = await operation(); throwIfCancellationRequested(token); return result; }
        catch (error) { throwIfCancellationRequested(token); throw error; }
        finally { clearInterval(timer); }
    }
    private async assertCapacity() {
        const stats = await this.diskStats();
        // The database is capped at one quarter of the total budget. Rollback journals
        // stay bounded by database pages, including when another window holds a reader.
        if (stats.bytes + BATCH_BYTES * 8 > this.options.diskBytes) throw new Error('Entity index disk budget exhausted');
    }
    private async diskStats() {
        let bytes = 0;
        const root = path.dirname(this.directory);
        for (const version of await fs.promises.readdir(root, { withFileTypes: true })) {
            if (!/^entity-index-v[0-9]+$/.test(version.name)) continue;
            if (!version.isDirectory() || version.isSymbolicLink()) throw new Error('Unsafe entity index cache directory');
            const directory = path.join(root, version.name);
            for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
                if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unexpected entity index cache entry');
                const stat = await fs.promises.lstat(path.join(directory, entry.name)).catch(error => {
                    if (error.code !== 'ENOENT') throw error;
                    return undefined;
                });
                if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Unsafe entity index cache file');
                bytes += stat?.size || 0;
            }
        }
        return { bytes, maxBytes: this.options.diskBytes, pageCacheBytes: Math.floor(this.options.memoryBytes / 2),
            memoryBytes: this.options.memoryBytes };
    }

    begin(key: string, revision: string, token?: Token): Promise<EntityIndexBuild | null> {
        return this.serial(() => this.transaction(async () => {
            throwIfCancellationRequested(token);
            await this.assertCapacity();
            const existing = await this.get('SELECT generation FROM generations WHERE shard=? AND state=? AND lease>?',
                [key, 'building', this.now()]);
            if (existing) return null;
            const build = { key, revision, generation: randomUUID(), owner: randomUUID() };
            await this.run('INSERT INTO generations VALUES (?,?,?,?,?,?,?,NULL)',
                [build.generation, key, revision, 'building', build.owner, this.now() + LEASE_MS, this.now()]);
            return build;
        }));
    }
    private async own(build: EntityIndexBuild) {
        const changed = await this.run(`UPDATE generations SET lease=? WHERE generation=? AND shard=? AND revision=?
            AND owner=? AND state='building' AND lease>?`,
            [this.now() + LEASE_MS, build.generation, build.key, build.revision, build.owner, this.now()]);
        if (!changed) throw new Error('Entity index build lease expired');
    }
    renew(build: EntityIndexBuild) { return this.serial(() => this.own(build)); }

    metadata(build: EntityIndexBuild, metadata: EntityIndexMetadata, token?: Token) {
        if (Buffer.byteLength(JSON.stringify(metadata)) > BATCH_BYTES) throw new Error('Entity index metadata batch exceeds memory budget');
        return this.serial(() => this.transaction(async () => {
            throwIfCancellationRequested(token); await this.assertCapacity(); await this.own(build);
            for (const file of metadata.files || []) {
                if (!path.isAbsolute(file.file) || !file.revision || !file.parser) throw new Error('Invalid entity file metadata');
                if (Buffer.byteLength(JSON.stringify(file)) > Math.min(16 * 1024, this.options.memoryBytes / 4096))
                    throw new Error('Entity file metadata exceeds memory budget');
                await this.run('INSERT INTO files VALUES (?,?,?,?)', [build.generation, file.file, file.revision, file.parser]);
                throwIfCancellationRequested(token);
            }
            for (const block of metadata.blocks || []) {
                if (!block.anchor || ![block.line, block.offset].every(value => Number.isSafeInteger(value) && value >= 0))
                    throw new Error('Invalid entity block metadata');
                await this.run('INSERT INTO blocks VALUES (?,?,?,?,?)', [build.generation, block.file, block.anchor, block.line, block.offset]);
                throwIfCancellationRequested(token);
            }
            for (const context of metadata.contexts || []) {
                if (!context.context || !context.file) throw new Error('Invalid entity context metadata');
                await this.run('INSERT INTO contexts VALUES (?,?,?,?,?)',
                    [build.generation, context.context, context.parent || null, context.file, JSON.stringify(context.facts)]);
                throwIfCancellationRequested(token);
            }
        }));
    }

    filePage(key: string, revision?: string, cursor?: { generation: string; after: string }, token?: Token) {
        return this.serial(async () => {
            throwIfCancellationRequested(token);
            await this.exec('BEGIN');
            try {
                const generation = await this.get(`SELECT g.generation,g.revision FROM published p
                    JOIN generations g ON g.generation=p.generation WHERE p.shard=?
                    ${revision === undefined ? '' : 'AND g.revision=?'}`, [key, ...(revision === undefined ? [] : [revision])]);
                if (!generation) return { state: 'miss' as const };
                if (cursor && (cursor.generation !== generation.generation || typeof cursor.after !== 'string'))
                    return { state: 'expired' as const };
                const files = await this.all(`SELECT file,revision,parser FROM files WHERE generation=? AND file>?
                    ORDER BY file LIMIT 201`, [generation.generation, cursor?.after || '']);
                throwIfCancellationRequested(token);
                const more = files.length > 200;
                if (more) files.pop();
                return { state: 'ready' as const, ...generation, files,
                    next: more ? { generation: generation.generation, after: files[files.length - 1].file } : undefined };
            } finally { await this.exec('COMMIT'); }
        });
    }

    append(build: EntityIndexBuild, records: EntityIndexRecord[], token?: Token,
        templates: { key: string; payload: unknown }[] = []) {
        const rows = records.map(record => {
            const id = entityIdentityKey(record.id);
            if (!id || !record.key || !record.kind || !record.file || !record.block ||
                !['definition', 'reference'].includes(record.role) ||
                ![record.line, record.start, record.end].every(n => Number.isSafeInteger(n) && n >= 0) || record.end < record.start)
                throw new Error('Invalid entity index record');
            const payload = JSON.stringify(record.payload);
            if (payload === undefined) throw new Error('Invalid entity index payload');
            const row = [build.generation, record.key, record.kind, id, record.role, record.file,
                record.block, record.line, record.start, record.end, record.context, payload, record.template || null];
            // One decoded result page stays within its share of the managed budget.
            if (Buffer.byteLength(JSON.stringify(row)) > Math.min(16 * 1024, this.options.memoryBytes / 4096))
                throw new Error('Entity index record exceeds memory budget');
            return row;
        });
        const templateRows = templates.map(template => {
            const payload = JSON.stringify(template.payload);
            if (!template.key || !payload || Buffer.byteLength(payload) > Math.min(16 * 1024, this.options.memoryBytes / 4096))
                throw new Error('Invalid entity record template');
            return [build.generation, template.key, payload];
        });
        if (Buffer.byteLength(JSON.stringify([rows, templateRows])) > Math.min(1024 * 1024, this.options.memoryBytes / 8))
            throw new Error('Entity index batch exceeds memory budget');
        return this.serial(() => this.cancellable(() => this.appendWithEviction(async () => {
            throwIfCancellationRequested(token);
            await this.assertCapacity(); await this.own(build);
            for (const row of templateRows) {
                throwIfCancellationRequested(token);
                await this.run('INSERT INTO record_templates VALUES (?,?,?)', row);
            }
            for (let offset = 0; offset < rows.length; offset += 64) {
                throwIfCancellationRequested(token);
                const chunk = rows.slice(offset, offset + 64);
                await this.run(`INSERT INTO records (generation,record_key,kind,id,role,file,block,line,start,end,context,payload,template)
                    VALUES ${chunk.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}
                    ON CONFLICT(generation,kind,id,role,record_key) DO NOTHING`, chunk.flat());
            }
            throwIfCancellationRequested(token);
        }, token), token));
    }

    publish(build: EntityIndexBuild, coverage: { state: string; reasons: string[] }, token?: Token) {
        if (!Array.isArray(coverage.reasons) || !coverage.reasons.every(reason => typeof reason === 'string'))
            throw new Error('Invalid entity index coverage');
        const encoded = JSON.stringify(coverage);
        if (Buffer.byteLength(encoded) > BATCH_BYTES) throw new Error('Entity index coverage exceeds memory budget');
        return this.serial(() => this.transaction(async () => {
            throwIfCancellationRequested(token); await this.assertCapacity(); await this.own(build);
            if (!['complete', 'partial', 'incomplete'].includes(coverage.state)) throw new Error('Unfinished entity index cannot publish');
            await this.run("UPDATE generations SET state='published',coverage=?,accessed=? WHERE generation=?", [encoded, this.now(), build.generation]);
            await this.run('INSERT INTO published VALUES (?,?) ON CONFLICT(shard) DO UPDATE SET generation=excluded.generation', [build.key, build.generation]);
            throwIfCancellationRequested(token);
        }));
    }
    abandon(build: EntityIndexBuild) {
        return this.serial(() => this.run("DELETE FROM generations WHERE generation=? AND owner=? AND state='building'", [build.generation, build.owner]));
    }

    page(key: string, revision: string, kind: string, id: string | number, role: 'definition' | 'reference',
        cursor?: EntityIndexCursor, token?: Token) {
        return this.serial(async () => {
            const identity = entityIdentityKey(id);
            if (!identity || !['definition', 'reference'].includes(role)) throw new Error('Invalid entity index query');
            throwIfCancellationRequested(token);
            // A read transaction sees one publication even if another window publishes or evicts.
            await this.exec('BEGIN');
            let accessed: any;
            try {
                const generation = await this.get(`SELECT g.* FROM published p JOIN generations g ON g.generation=p.generation
                    WHERE p.shard=? AND g.revision=? AND g.state='published'`, [key, revision]);
                if (!generation) return { state: 'miss' as const };
                accessed = generation;
                if (cursor && (cursor.generation !== generation.generation || cursor.kind !== kind ||
                    cursor.id !== identity || cursor.role !== role || !Array.isArray(cursor.after) || cursor.after.length !== 4 ||
                    typeof cursor.after[0] !== 'string' || typeof cursor.after[3] !== 'string' ||
                    !cursor.after.slice(1, 3).every(value => Number.isSafeInteger(value) && Number(value) >= 0)))
                    return { state: 'expired' as const };
                const rows = await this.all(`SELECT r.file,r.line,r.start,r.record_key,r.payload,t.payload AS template_payload
                    FROM records r LEFT JOIN record_templates t ON t.generation=r.generation AND t.template=r.template
                    WHERE r.generation=? AND r.kind=? AND r.id=? AND r.role=?
                    ${cursor ? 'AND (r.file,r.line,r.start,r.record_key)>(?,?,?,?)' : ''}
                    ORDER BY r.file,r.line,r.start,r.record_key LIMIT 201`,
                    [generation.generation, kind, identity, role, ...(cursor?.after || [])]);
                throwIfCancellationRequested(token);
                const more = rows.length > 200;
                if (more) rows.pop();
                return { state: 'ready' as const, generation: generation.generation,
                    coverage: JSON.parse(generation.coverage), records: rows.map(row => row.template_payload
                        ? { ...JSON.parse(row.template_payload), ...JSON.parse(row.payload) } : JSON.parse(row.payload)),
                    next: more ? { generation: generation.generation, kind, id: identity, role,
                        after: [rows[rows.length - 1].file, rows[rows.length - 1].line, rows[rows.length - 1].start,
                            rows[rows.length - 1].record_key] as [string, number, number, string] } : undefined };
            } finally {
                await this.exec('COMMIT');
                if (accessed && accessed.accessed < this.now() - LEASE_MS / 2) {
                    await this.run('UPDATE generations SET accessed=? WHERE generation=?',
                        [this.now(), accessed.generation]).catch(error => {
                            if (error.code !== 'SQLITE_BUSY') throw error;
                        });
                }
            }
        });
    }

    get maxFactBytes() { return Math.min(16 * 1024, this.options.memoryBytes / 2048); }

    appendFacts(build: EntityIndexBuild, rows: { section: string; ordinal: number; payload: unknown }[], token?: Token) {
        const values = rows.map(row => {
            const payload = JSON.stringify(row.payload);
            if (!row.section || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0 || payload === undefined ||
                Buffer.byteLength(payload) > this.maxFactBytes)
                throw new Error('Invalid index fact');
            return [build.generation, row.section, row.ordinal, payload];
        });
        if (Buffer.byteLength(JSON.stringify(values)) > BATCH_BYTES) throw new Error('Index fact batch exceeds budget');
        return this.serial(() => this.cancellable(() => this.appendWithEviction(async () => {
            await this.assertCapacity(); await this.own(build);
            for (let offset = 0; offset < values.length; offset += 240) {
                throwIfCancellationRequested(token);
                const batch = values.slice(offset, offset + 240);
                await this.run(`INSERT INTO facts VALUES ${batch.map(() => '(?,?,?,?)').join(',')}`, batch.flat());
            }
        }, token), token));
    }

    /** Ordinals are the final semantic result order, not the order of raw candidates. */
    factPage(key: string, revision: string | undefined, section: string, offset = 0, token?: Token,
        expectedGeneration?: string) {
        if (!section || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid fact cursor');
        return this.serial(async () => {
            throwIfCancellationRequested(token);
            await this.exec('BEGIN');
            let generation: any;
            try {
                generation = await this.get(`SELECT g.* FROM published p JOIN generations g ON g.generation=p.generation
                    WHERE p.shard=? AND g.state='published' ${revision === undefined ? '' : 'AND g.revision=?'}`,
                    [key, ...(revision === undefined ? [] : [revision])]);
                if (!generation) return { state: 'miss' as const };
                if (expectedGeneration && expectedGeneration !== generation.generation) return { state: 'expired' as const };
                const rows = await this.all(`SELECT ordinal,payload FROM facts WHERE generation=? AND section=?
                    AND ordinal>=? ORDER BY ordinal LIMIT 201`, [generation.generation, section, offset]);
                throwIfCancellationRequested(token);
                const more = rows.length > 200;
                if (more) rows.pop();
                return { state: 'ready' as const, generation: generation.generation, revision: generation.revision,
                    coverage: JSON.parse(generation.coverage), records: rows.map(row => JSON.parse(row.payload)),
                    next: more ? rows[rows.length - 1].ordinal + 1 : undefined };
            } finally {
                await this.exec('COMMIT');
                if (generation && generation.accessed < this.now() - LEASE_MS / 2)
                    await this.run('UPDATE generations SET accessed=? WHERE generation=?', [this.now(), generation.generation])
                        .catch(error => { if (error.code !== 'SQLITE_BUSY') throw error; });
            }
        });
    }

    stats() { return this.serial(async () => ({ ...await this.diskStats(),
        ...await this.get("SELECT COUNT(*) AS generations,SUM(state='building') AS builds FROM generations") })); }
    clear() {
        return this.serial(async () => {
            const before = await this.diskStats();
            const removed = await this.transaction(() => this.run(
                "DELETE FROM generations WHERE state='published' OR lease<=?", [this.now()]));
            // A different window may own a live build. Its lease and data remain valid.
            await this.exec('PRAGMA incremental_vacuum(256);');
            const after = await this.diskStats();
            return { removed, reclaimedBytes: Math.max(0, before.bytes - after.bytes), ...after };
        });
    }
    prune(maxAgeMs = 30 * 24 * 60 * 60 * 1000, token?: Token) {
        if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw new Error('Invalid entity index expiry');
        return this.serial(() => this.cancellable(async () => {
            const removed = await this.transaction(async () => {
                // SQLite readers hold a shared lock, so eviction waits or returns SQLITE_BUSY.
                return this.run(`DELETE FROM generations WHERE (state='building' AND lease<=?) OR
                    (state='published' AND (accessed<? OR generation NOT IN (SELECT generation FROM published)))`,
                    [this.now(), this.now() - maxAgeMs]);
            });
            await this.exec('PRAGMA incremental_vacuum(256);');
            return { removed, ...await this.diskStats() };
        }, token));
    }
    async close() {
        if (this.closed) return;
        this.closed = true;
        await this.tail;
        await new Promise<void>((resolve, reject) => this.db.close(error => error ? reject(error) : resolve()));
    }
}
