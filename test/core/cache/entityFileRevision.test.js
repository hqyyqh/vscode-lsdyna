'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { entityFileRevision, entityFilesUnchanged } = require('../../../out/core/cache/entityFileRevision');
describe('Entity index source identity', () => {
    const temporary = require('../../support/tempDirectories').trackTempDirectories();
    it('detects same-size edits and replacement even with a restored modification timestamp', async () => {
        const root = temporary(path.join(os.tmpdir(), 'entity-revision-'));
        const file = path.join(root, 'model.k');
        fs.writeFileSync(file, 'first');
        const stat = fs.statSync(file), revision = await entityFileRevision(file);
        assert.equal(await entityFilesUnchanged([{ file, revision }]), true);
        fs.writeFileSync(file, 'other');
        fs.utimesSync(file, stat.atime, stat.mtime);
        assert.equal(await entityFilesUnchanged([{ file, revision }]), false);
        const editedRevision = await entityFileRevision(file);
        const replacement = path.join(root, 'replacement.k');
        fs.writeFileSync(replacement, 'other'); fs.utimesSync(replacement, stat.atime, stat.mtime);
        fs.renameSync(file, path.join(root, 'old.k')); fs.renameSync(replacement, file);
        assert.equal(await entityFilesUnchanged([{ file, revision: editedRevision }]), false);
        assert.equal(await entityFilesUnchanged([{ file: path.join(root, 'missing.k'), revision }]), false);
    });
});
