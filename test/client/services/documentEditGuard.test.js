'use strict';
const makeTemp = require('../../support/tempDirectories').trackTempDirectories();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDocumentEditGuard, isDocumentReadonlyForAutomaticEdit } = require('../../../src/client/services/documentEditGuard');

function host(stat = async () => ({ permissions: 0 })) {
    return {
        FilePermission: { Readonly: 1 },
        languages: { match: () => 0 },
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }), fs: { stat } },
    };
}

describe('document edit permission and identity boundary', () => {
    it('honors provider readonly without enabling readonlyFromPermissions', async () => {
        const document = { version: 1, uri: { scheme: 'remote', fsPath: '/deck.k' } };
        assert.equal(await isDocumentReadonlyForAutomaticEdit(document, host(async () => ({ permissions: 1 }))), true);
    });

    it('rejects an OS readonly file even when the provider omits permissions', async () => {
        const root = makeTemp(path.join(os.tmpdir(), 'dynasense-edit-permission-'));
        const file = path.join(root, 'deck.k');
        const bytes = '*KEYWORD\n*END\n';
        fs.writeFileSync(file, bytes);
        try {
            const document = { version: 1, uri: { scheme: 'file', fsPath: file } };
            assert.equal(await isDocumentReadonlyForAutomaticEdit(document, host()), false);
            fs.chmodSync(file, 0o444);
            assert.equal(await isDocumentReadonlyForAutomaticEdit(document, host()), true);
            assert.equal(fs.readFileSync(file, 'utf8'), bytes);
        } finally {
            fs.chmodSync(file, 0o666);
        }
    });

    for (const change of ['version', 'close', 'uri']) {
        it(`rejects ${change} changes while permission checks are pending`, async () => {
            const document = { version: 1, uri: { scheme: 'remote', fsPath: '/deck.k' } };
            let release;
            const pending = isDocumentReadonlyForAutomaticEdit(document, host(() => new Promise(resolve => { release = resolve; })));
            if (change === 'version') document.version++;
            if (change === 'close') document.isClosed = true;
            if (change === 'uri') document.uri = { scheme: 'remote', fsPath: '/other.k' };
            release({ permissions: 0 });
            assert.equal(await pending, true);
        });
    }

    it('rejects a replacement document with the same URI and version', () => {
        const document = { version: 1, uri: { scheme: 'file', fsPath: '/deck.k' } };
        const editor = { document };
        const current = createDocumentEditGuard(document, editor);
        assert.equal(current(), true);
        editor.document = { ...document };
        assert.equal(current(), false);
    });

    it('permits an open untitled document without asking the disk provider', async () => {
        const document = { version: 1, uri: { scheme: 'untitled', fsPath: 'Untitled-1' } };
        assert.equal(await isDocumentReadonlyForAutomaticEdit(document, host(() => { throw Error('unexpected disk access'); })), false);
        document.isClosed = true;
        assert.equal(await isDocumentReadonlyForAutomaticEdit(document, host()), true);
    });
});
