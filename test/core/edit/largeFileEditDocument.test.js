const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const temp = require('../../support/tempDirectories').trackTempDirectories();
const { LargeFileEditDocument } = require('../../../src/core/edit/largeFileEditDocument');
describe('large-file record edit document', () => {
    let root, file, model;
    beforeEach(async () => {
        root = temp(path.join(os.tmpdir(), 'record-edit-')); file = path.join(root, 'deck.k');
        await fs.writeFile(file, '\uFEFF*KEYWORD\r\n*MAT_ELASTIC\r\n         7   210000\r\n*END');
        model = new LargeFileEditDocument(file, path.join(root, 'storage'));
    });
    afterEach(async () => { await model.dispose(); });
    it('preserves BOM, CRLF, untouched bytes and EOF through edit/save/undo/redo', async () => {
        const before = await fs.readFile(file);
        const draft = await model.prepare(2, 2);
        const edit = await model.apply(draft, '         8   220000\n$ added\n');
        assert.ok(model.dirty);
        assert.deepEqual(await fs.readFile(file), before);
        await model.save(); assert.ok(!model.dirty);
        assert.equal(await fs.readFile(file, 'utf8'), '\uFEFF*KEYWORD\r\n*MAT_ELASTIC\r\n         8   220000\r\n$ added\r\n*END');
        await edit.undo(); assert.ok(model.dirty); await model.save();
        assert.deepEqual(await fs.readFile(file), before);
        await edit.redo(); await model.save();
        assert.match(await fs.readFile(file, 'utf8'), /220000/);
    });
    it('rejects stale drafts, invalid encodings and excessive record ranges', async () => {
        const draft = await model.prepare(2, 2);
        await model.apply(draft, '8\n');
        await assert.rejects(model.apply(draft, '9\n'), /Conflict/);
        await assert.rejects(model.prepare(0, 240), /Bounds/);
        const current = await model.prepare(2, 2);
        await assert.rejects(model.apply(current, 'x'.repeat(65537)), /Bounds/);
        await model.dispose();
        await fs.writeFile(file, Buffer.from([0xff, 10]));
        model = new LargeFileEditDocument(file, path.join(root, 'other'));
        await assert.rejects(model.prepare(0, 0), /Encoding/);
    });
    it('preserves external changes and unsaved edits, allowing save as', async () => {
        await model.apply(await model.prepare(2, 2), '8\n');
        await fs.writeFile(file, 'external');
        await assert.rejects(model.save(), /Conflict/);
        assert.equal(await fs.readFile(file, 'utf8'), 'external'); assert.ok(model.dirty);
        const copy = path.join(root, 'copy.k'); await model.save(copy);
        assert.match(await fs.readFile(copy, 'utf8'), /8\r\n/);
        assert.ok(model.dirty);
    });
    it('restores a self-contained backup and refuses overwriting externally changed source', async () => {
        await model.apply(await model.prepare(2, 2), '9\n');
        const backup = await model.backup(path.join(root, 'backup'));
        await model.dispose();
        model = new LargeFileEditDocument(file, path.join(root, 'restored'));
        await model.restore(backup.id); assert.ok(model.dirty);
        assert.match(await fs.readFile(model.contentPath, 'utf8'), /9\r\n/);
        await model.save(); assert.ok(!model.dirty); await backup.delete();
    });
    it('serializes backup after an in-flight edit without replaying an obsolete draft', async () => {
        const draft = await model.prepare(2, 2);
        const applying = model.apply(draft, '9\n');
        const backingUp = model.backup(path.join(root, 'concurrent-backup'), () => draft.version === model.version ? { text: '9\n' } : undefined);
        const [, backup] = await Promise.all([applying, backingUp]);
        const restored = new LargeFileEditDocument(file, path.join(root, 'concurrent-restored'));
        try {
            assert.equal(await restored.restore(backup.id), undefined);
            assert.match(await fs.readFile(restored.contentPath, 'utf8'), /9\r\n/);
        } finally { await restored.dispose(); await backup.delete(); }
    });
    it('retries a transient Windows lock and rechecks the source before retrying', async function () {
        if (process.platform !== 'win32') this.skip();
        await model.apply(await model.prepare(2, 2), '9\n');
        const rename = fs.rename; let attempts = 0;
        fs.rename = async (...args) => { if (!attempts++) throw Object.assign(new Error('locked'), { code: 'EPERM' }); return rename(...args); };
        try { await model.save(); } finally { fs.rename = rename; }
        assert.equal(attempts, 2); assert.ok(!model.dirty);
        await model.apply(await model.prepare(2, 2), '10\n');
        fs.rename = async () => { await fs.writeFile(file, 'external while locked'); throw Object.assign(new Error('locked'), { code: 'EPERM' }); };
        try { await assert.rejects(model.save(), /Conflict/); } finally { fs.rename = rename; }
        assert.equal(await fs.readFile(file, 'utf8'), 'external while locked'); assert.ok(model.dirty);
    });
    it('retains dirty edits when another writer changes the replacement immediately', async () => {
        await model.apply(await model.prepare(2, 2), '9\n');
        const rename = fs.rename;
        fs.rename = async (...args) => { await rename(...args); await fs.writeFile(file, 'external after replacement'); };
        try { await assert.rejects(model.save(), /Conflict/); }
        finally { fs.rename = rename; }
        assert.ok(model.dirty);
        assert.equal(await fs.readFile(file, 'utf8'), 'external after replacement');
        assert.match(await fs.readFile(model.contentPath, 'utf8'), /9\r\n/);
    });
    it('does not overwrite hardlinks or change source when save is cancelled', async () => {
        await model.apply(await model.prepare(2, 2), '9\n');
        const before = await fs.readFile(file);
        await assert.rejects(model.save(file, () => true), /Cancelled/);
        assert.deepEqual(await fs.readFile(file), before);
        await fs.link(file, path.join(root, 'linked.k'));
        await assert.rejects(model.save(), /ReadOnly/);
        assert.deepEqual(await fs.readFile(file), before);
    });
});
