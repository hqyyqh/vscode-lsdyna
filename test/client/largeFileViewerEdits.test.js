const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const temp = require('../support/tempDirectories').trackTempDirectories();
const { vscodeMock: vscode } = require('../support/helpers');
const { LargeFileViewerProvider } = require('../../src/client/LargeFileViewerProvider');
const { LargeFileEditDocument } = require('../../src/core/edit/largeFileEditDocument');

describe('large viewer recovery and native editing', () => {
    let root, file, provider, document, original, calls, warnings, session, old;
    beforeEach(async () => {
        root = temp(path.join(os.tmpdir(), 'viewer-recovery-')); file = path.join(root, 'deck.k');
        original = '*KEYWORD\r\n*MAT_ELASTIC\r\n         7   210000\r\n*END\r\n';
        await fs.writeFile(file, original);
        provider = new LargeFileViewerProvider('', { get() {}, update() {} }, {}, path.join(root, 'storage'));
        document = await provider.openCustomDocument(vscode.Uri.file(file));
        provider.refreshEdited = async () => {};
        old = { documents: vscode.workspace.textDocuments, execute: vscode.commands.executeCommand,
            warning: vscode.window.showWarningMessage, error: vscode.window.showErrorMessage, save: vscode.window.showSaveDialog };
        calls = []; warnings = [];
        vscode.workspace.textDocuments = [];
        vscode.commands.executeCommand = async (...args) => { calls.push(args); };
        vscode.window.showWarningMessage = async (...args) => { warnings.push(args); };
        vscode.window.showErrorMessage = async () => {};
        session = { document, panel: { viewColumn: 2 }, generation: 0, state: { viewer: 'viewer', revision: 3,
            lines: [{ lineNumber: 2, fields: [{ token: 'mid', startColumn: 10, endColumn: 20 }] }] } };
        provider.sessions.set(process.platform === 'win32' ? file.toLowerCase() : file, session);
    });
    afterEach(async () => {
        vscode.workspace.textDocuments = old.documents; vscode.commands.executeCommand = old.execute;
        vscode.window.showWarningMessage = old.warning; vscode.window.showErrorMessage = old.error; vscode.window.showSaveDialog = old.save;
        provider.sessions.clear(); await document.edits.dispose(); provider.dispose();
    });
    const request = { viewer: 'viewer', revision: 3, line: 2, token: 'mid' };
    it('copies source field values and exact lines, rejects stale targets and reports clipboard failures', async () => {
        const writeText = vscode.env.clipboard.writeText;
        const errors = [];
        const copied = [];
        vscode.window.showErrorMessage = async message => { errors.push(message); };
        vscode.env.clipboard.writeText = async text => { copied.push(text); };
        session.state.lines[0].text = '         7   -210000  ';
        try {
            assert.equal(await provider.copy(request, true), true);
            assert.equal(copied.pop(), '-210000');
            assert.equal(await provider.copy(request, false), true);
            assert.equal(copied.pop(), session.state.lines[0].text);
            for (const value of ['&density', '0', '']) {
                session.state.lines[0].text = '         7' + value.padStart(10);
                assert.equal(await provider.copy(request, true), true);
                assert.equal(copied.pop(), value);
            }
            for (const invalid of [undefined, { ...request, viewer: 'other' }, { ...request, revision: 2 },
                { ...request, line: 99 }, { ...request, token: 'other' }]) {
                assert.equal(await provider.copy(invalid, true), false);
            }
            session.state.stale = true;
            assert.equal(await provider.copy(request, false), false);
            session.state.stale = false;
            session.state.lines[0].truncated = true;
            assert.equal(await provider.copy(request, false), false);
            assert.equal(copied.length, 0);
            session.state.lines[0].truncated = false;
            vscode.env.clipboard.writeText = async () => { throw Error('clipboard unavailable'); };
            assert.equal(await provider.copy(request, true), false);
            assert.equal(errors.length, 1);
            assert.equal(await fs.readFile(file, 'utf8'), original);
        } finally { vscode.env.clipboard.writeText = writeText; }
    });
    it('uses the native editor explicitly, preserves dirty buffers and passes exact field coordinates', async () => {
        vscode.workspace.textDocuments = [{ uri: document.uri, isDirty: true }];
        assert.equal(await provider.openNative(request), true);
        assert.equal(warnings.length, 1);
        assert.equal(calls[0][0], 'vscode.openWith'); assert.equal(calls[0][2], 'default');
        assert.deepEqual(calls[0][3].selection, new vscode.Range(2, 10, 2, 20));
        assert.equal(calls[0][3].preview, false); assert.equal(calls[0][3].viewColumn, 2);
        assert.equal(await fs.readFile(file, 'utf8'), original);
    });
    it('detects dirty native tabs beyond the text-document API limit and reuses their group', async () => {
        const savedTabs = vscode.window.tabGroups, savedType = vscode.TabInputText;
        vscode.TabInputText = class { constructor(uri) { this.uri = uri; } };
        vscode.window.tabGroups = { all: [{ viewColumn: 1, tabs: [{ isDirty: true, input: new vscode.TabInputText(document.uri) }] }] };
        try {
            assert.equal(await provider.openNative(request), true);
            assert.equal(warnings.length, 1);
            assert.equal(calls[0][3].viewColumn, 1);
            await assert.rejects(provider.saveCustomDocumentAs(document, { ...document.uri, scheme: 'file' }, { isCancellationRequested: false }));
        } finally { vscode.window.tabGroups = savedTabs; vscode.TabInputText = savedType; }
    });
    it('rejects unknown sessions, stale revisions, out-of-window rows and unbound fields', async () => {
        for (const change of [{ viewer: 'other' }, { revision: 2 }, { line: -1 }, { line: 999 }, { token: 'other' }])
            assert.equal(await provider.openNative({ ...request, ...change }), false);
        session.state.stale = true;
        assert.equal(await provider.openNative(request), false);
        assert.equal(calls.length, 0);
    });
    it('reports native open failure without changing the file', async () => {
        vscode.commands.executeCommand = async () => { throw Error('too large'); };
        assert.equal(await provider.openNative(request), false);
        assert.equal(await fs.readFile(file, 'utf8'), original);
    });
    for (const source of ['unchanged', 'changed', 'missing']) it(`restores applied edits plus an unapplied draft with ${source} source, retaining backup`, async () => {
        const legacy = new LargeFileEditDocument(file, path.join(root, 'legacy'));
        await legacy.apply(await legacy.prepare(2, 2), '         8   220000\n');
        const backup = await legacy.backup(path.join(root, 'backup'), { firstLine: 2, lastLine: 2, text: '         9   230000\n$ inserted\n' });
        await legacy.dispose();
        if (source === 'changed') await fs.writeFile(file, 'external\n');
        if (source === 'missing') await fs.unlink(file);
        await document.edits.dispose();
        document = await provider.openCustomDocument(vscode.Uri.file(file), { backupId: backup.id }); session.document = document;
        const recovered = original.replace('         7   210000\r\n', '         9   230000\r\n$ inserted\r\n');
        assert.equal(await fs.readFile(document.edits.contentPath, 'utf8'), recovered);
        assert.equal(document.edits.dirty, true);
        assert.equal(await provider.openNative(request), true); // cancelling keeps everything
        assert.equal(calls.length, 0);
        const copy = path.join(root, 'recovered.k');
        vscode.window.showWarningMessage = async (_message, _options, action) => action;
        vscode.window.showSaveDialog = async () => ({ ...vscode.Uri.file(copy), scheme: 'file' });
        vscode.workspace.textDocuments = [{ uri: document.uri, isDirty: true }];
        assert.equal(await provider.openNative(request), true);
        assert.equal(await fs.readFile(copy, 'utf8'), recovered);
        assert.equal(calls[0][1].fsPath, copy);
        assert.equal(document.edits.dirty, true);
        assert.ok(await fs.stat(backup.id));
        if (source === 'unchanged') assert.equal(await fs.readFile(file, 'utf8'), original);
        if (source === 'changed') assert.equal(await fs.readFile(file, 'utf8'), 'external\n');
        if (source === 'missing') {
            await assert.rejects(fs.stat(file));
            await assert.rejects(provider.revertCustomDocument(document));
            assert.equal(await fs.readFile(document.edits.contentPath, 'utf8'), recovered);
        }
        vscode.workspace.textDocuments = [];
        await assert.rejects(provider.saveCustomDocument(document), /copy|副本/);
        await assert.rejects(provider.saveCustomDocumentAs(document, { ...document.uri, scheme: 'file' }, { isCancellationRequested: false }), /copy|副本/);
        const secondBackup = await provider.backupCustomDocument(document, { destination: vscode.Uri.file(path.join(root, 'second-backup')) });
        const second = await provider.openCustomDocument(document.uri, { backupId: secondBackup.id });
        assert.equal(await fs.readFile(second.edits.contentPath, 'utf8'), recovered);
        await second.edits.dispose();
        await assert.rejects(provider.saveCustomDocument(document, { isCancellationRequested: false }));
    });
    it('limits the context command to records in the large-file webview', () => {
        const menus = require('../../package.json').contributes.menus;
        const command = 'extension.openLargeFileInTextEditor';
        assert.equal(menus['webview/context'].find(item => item.command === command).when,
            'webviewId == lsdyna.largeFileViewer && webviewSection == largeFileRecord');
        assert.ok(!menus['editor/context'].some(item => item.command === command));
        assert.ok(!menus['explorer/context'].some(item => item.command === command));
    });
    it('exposes no record editing requests' , () => {
        const methods = [];
        provider.messenger.onRequest = type => { methods.push(type.method); return { dispose() {} }; };
        provider.messenger.onNotification = () => ({ dispose() {} });
        provider.registerHandlers(session);
        assert.ok(methods.includes('largeFile/openNative'));
        assert.ok(!methods.some(method => /prepareEdit|updateEdit|applyEdit|cancelEdit/.test(method)));
    });
});
