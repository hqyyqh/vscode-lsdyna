'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    copyDirectoryExact,
    diffSnapshots,
    snapshotDirectory,
} = require('./fileOracle');

describe('editor-safety file oracle', () => {
    let tempRoot;

    beforeEach(() => {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-editor-safety-'));
    });

    afterEach(() => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('reports a byte-identical directory as clean even when timestamps change', async () => {
        const filePath = path.join(tempRoot, 'model.key');
        fs.writeFileSync(filePath, '*KEYWORD\r\n*END\r\n', 'utf8');
        const before = await snapshotDirectory(tempRoot);

        const changedTime = new Date(Date.now() + 60_000);
        fs.utimesSync(filePath, changedTime, changedTime);
        const after = await snapshotDirectory(tempRoot);

        assert.equal(diffSnapshots(before, after).clean, true);
        assert.deepEqual(before.summary, after.summary);
    });

    it('reports modified, added, and removed files with normalized relative paths', async () => {
        fs.mkdirSync(path.join(tempRoot, 'case-a'));
        fs.writeFileSync(path.join(tempRoot, 'case-a', 'main.key'), 'before\r\n');
        fs.writeFileSync(path.join(tempRoot, 'removed.k'), 'remove me\n');
        const before = await snapshotDirectory(tempRoot);

        fs.writeFileSync(path.join(tempRoot, 'case-a', 'main.key'), 'after\r\n');
        fs.unlinkSync(path.join(tempRoot, 'removed.k'));
        fs.writeFileSync(path.join(tempRoot, 'added.k'), 'new\n');
        const after = await snapshotDirectory(tempRoot);
        const diff = diffSnapshots(before, after);

        assert.equal(diff.clean, false);
        assert.deepEqual(diff.added.map(item => item.path), ['added.k']);
        assert.deepEqual(diff.removed.map(item => item.path), ['removed.k']);
        assert.deepEqual(diff.modified.map(item => item.path), ['case-a/main.key']);
    });

    it('detects same-size byte changes', async () => {
        const filePath = path.join(tempRoot, 'same-size.key');
        fs.writeFileSync(filePath, '1234567890');
        const before = await snapshotDirectory(tempRoot);

        fs.writeFileSync(filePath, '123456789X');
        const after = await snapshotDirectory(tempRoot);
        const diff = diffSnapshots(before, after);

        assert.equal(diff.modified.length, 1);
        assert.equal(diff.modified[0].before.size, diff.modified[0].after.size);
        assert.notEqual(diff.modified[0].before.sha256, diff.modified[0].after.sha256);
    });

    it('supports a deterministic file filter', async () => {
        fs.writeFileSync(path.join(tempRoot, 'model.key'), 'deck');
        fs.writeFileSync(path.join(tempRoot, 'notes.txt'), 'notes');

        const snapshot = await snapshotDirectory(tempRoot, {
            fileFilter: relativePath => relativePath.endsWith('.key'),
        });

        assert.deepEqual(Object.keys(snapshot.files), ['model.key']);
        assert.equal(snapshot.summary.fileCount, 1);
    });

    it('copies an isolated fixture byte-for-byte without linking it to the source', async () => {
        const source = path.join(tempRoot, 'source');
        const target = path.join(tempRoot, 'isolated');
        fs.mkdirSync(path.join(source, 'condition'), { recursive: true });
        fs.writeFileSync(path.join(source, 'combine.key'), '*INCLUDE\r\ncondition\\load.k\r\n');
        fs.writeFileSync(path.join(source, 'condition', 'load.k'), '*END\r\n');
        const sourceBefore = await snapshotDirectory(source);

        await copyDirectoryExact(source, target);
        const targetBefore = await snapshotDirectory(target);
        fs.writeFileSync(path.join(target, 'condition', 'load.k'), '*KEYWORD\r\n*END\r\n');
        const sourceAfter = await snapshotDirectory(source);

        assert.deepEqual(sourceBefore.summary, targetBefore.summary);
        assert.equal(diffSnapshots(sourceBefore, sourceAfter).clean, true);
        assert.equal(diffSnapshots(targetBefore, await snapshotDirectory(target)).clean, false);
    });

    it('refuses to place an isolation target inside the source directory', async () => {
        const source = path.join(tempRoot, 'source');
        fs.mkdirSync(source);

        await assert.rejects(
            copyDirectoryExact(source, path.join(source, 'nested-copy')),
            /must not be inside the source/,
        );
    });
});
