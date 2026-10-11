'use strict';
const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock: vscode } = require('../support/helpers');
const { LsdynaIncludeTreeProvider } = require('../../out/client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('../../out/client/providers/keywordIndexProvider');

describe('scanning from a Keyword Manager source', () => {
    let editor, tabs, documents, progress, location;
    beforeEach(() => {
        progress = vscode.window.withProgress; location = vscode.ProgressLocation;
        vscode.ProgressLocation = { Window: 10, Notification: 15 };
        vscode.window.withProgress = async (_options, task) => task({ report() {} }, { isCancellationRequested: false });
        editor = vscode.window.activeTextEditor; tabs = vscode.window.tabGroups; documents = vscode.workspace.textDocuments;
        vscode.window.activeTextEditor = undefined;
        vscode.window.tabGroups = { activeTabGroup: { activeTab: { input: { viewType: 'lsdynaKeywordManager' } } } };
    });
    afterEach(() => { vscode.window.activeTextEditor = editor; vscode.window.tabGroups = tabs; vscode.workspace.textDocuments = documents; vscode.window.withProgress = progress; vscode.ProgressLocation = location; });
    const snapshot = filePath => ({ files: [filePath], fileIndexes: {}, graph: { toTree: () => ({ filePath, children: [] }) } });
    it('uses the selected small-file source for both scans without a text editor or tab URI', async () => {
        let current = { fsPath: 'D:/model/small-a.k' };
        const requested = [];
        const options = { resolveActiveUri: () => current, loadProjectSnapshot: async file => { requested.push(file); return snapshot(file); } };
        const includes = new LsdynaIncludeTreeProvider(options), keywords = new LsdynaKeywordIndexProvider(options);
        try {
            assert.equal((await includes.scan()).rootFile, current.fsPath);
            assert.equal(await keywords.scan(), true);
            current = { fsPath: 'D:/model/small-b.k' };
            assert.equal((await includes.scan()).rootFile, current.fsPath);
            assert.equal(await keywords.scan(), true);
            assert.deepEqual(requested, ['D:/model/small-a.k', 'D:/model/small-a.k', 'D:/model/small-b.k', 'D:/model/small-b.k']);
        } finally { keywords.stopAutomaticWork(); }
    });
    it('guards the manager source document rather than an unrelated visible editor', async () => {
        const source = Object.assign(fakeDoc('*KEYWORD\n*END', 'D:/model/source.k'), { version: 1 });
        const other = Object.assign(fakeDoc('*KEYWORD\n*END', 'D:/model/other.k'), { version: 1 });
        vscode.window.activeTextEditor = { document: other };
        vscode.workspace.textDocuments = [source, other];
        const provider = new LsdynaIncludeTreeProvider({ resolveActiveUri: () => source.uri,
            loadProjectSnapshot: async file => { other.version++; return snapshot(file); } });
        assert.equal((await provider.scan()).rootFile, source.uri.fsPath);
        provider.loadProjectSnapshot = async file => { source.version++; return snapshot(file); };
        assert.equal(await provider.scan(), null);
        assert.equal(provider.root, null);
    });
});
