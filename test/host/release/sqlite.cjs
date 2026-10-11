'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
exports.check = async (extension, root, checks) => {
    const directory = path.join(extension.extensionPath, 'node_modules/@vscode/sqlite3');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'build/native-build.json'), 'utf8'));
    assert.equal(manifest.target, `${process.platform}-${process.arch}`);
    assert.equal(manifest.driver, '5.1.14-vscode');
    assert.equal(manifest.sha256, crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(directory, 'build/Release/vscode-sqlite3.node'))).digest('hex'));
    const http = require('node:http'), https = require('node:https');
    const saved = [http.request, https.request, globalThis.fetch];
    const offline = () => { throw Error('SQLite compatibility check attempted network access'); };
    let db;
    const close = () => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    try {
        http.request = https.request = globalThis.fetch = offline;
        const sqlite = require(directory);
        const file = path.join(root, 'sqlite-compatibility.db');
        const open = () => new Promise((resolve, reject) => {
            const value = new sqlite.Database(file, error => error ? reject(error) : resolve(value));
        });
        db = await open();
        const exec = sql => new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
        const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params,
            (error, row) => error ? reject(error) : resolve(row)));
        await exec('PRAGMA journal_mode=WAL; CREATE TABLE facts (id TEXT PRIMARY KEY, value TEXT);');
        await new Promise((resolve, reject) => db.run('INSERT INTO facts VALUES (?, ?)', ['2147483648', '对象 / entity'],
            error => error ? reject(error) : resolve()));
        assert.equal((await get('SELECT value FROM facts WHERE id = ?', ['2147483648'])).value, '对象 / entity');
        const version = await get('SELECT sqlite_version() AS version');
        assert.equal(version.version, manifest.sqlite);
        await close(); db = undefined; db = await open();
        assert.equal((await get('SELECT count(*) AS count FROM facts')).count, 1);
        let cancelledAt;
        const timer = setTimeout(() => { cancelledAt = performance.now(); db.interrupt(); }, 25);
        try {
            await assert.rejects(get('WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1000000000) SELECT sum(n) FROM seq'),
                error => error.code === 'SQLITE_INTERRUPT');
        } finally { clearTimeout(timer); }
        const cancellationMs = performance.now() - cancelledAt;
        assert.ok(Number.isFinite(cancellationMs) && cancellationMs <= 250);
        assert.equal((await get('PRAGMA integrity_check')).integrity_check, 'ok');
        fs.writeFileSync(path.join(root, 'sqlite-compatibility.json'), JSON.stringify({ ...manifest,
            runtimeNode: process.version, runtimeNapi: process.versions.napi, cancellationMs, offline: true, status: 'passed' }, null, 2));
        checks.push('SQLite: exact bundled driver, offline create/query/reopen/cancel/integrity');
    } finally {
        try { if (db) await close(); }
        finally { [http.request, https.request, globalThis.fetch] = saved; }
    }
};
