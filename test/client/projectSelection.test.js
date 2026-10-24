'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { fakeDoc, vscodeMock: vscode } = require('../support/helpers');
const makeTemp = require('../support/tempDirectories').trackTempDirectories();
const extension = require('../../src/extension');
const { LsdynaIncludeTreeProvider } = require('../../src/client/providers/includeTreeProvider');
const { LsdynaKeywordIndexProvider } = require('../../src/client/providers/keywordIndexProvider');

describe('explicit shared project selection', () => {
    it('shares one root across sidebars until another scan explicitly selects a different root', async function () {
        this.timeout(15000);
        const root = makeTemp(path.join(os.tmpdir(), 'dynasense-project-selection-'));
        const files = ['a.k', 'b.k'].map(name => path.join(root, name));
        for (const file of files) fs.writeFileSync(file, '*KEYWORD\n*END\n');
        const originals = { register: vscode.commands.registerCommand, tree: vscode.window.createTreeView,
            webview: vscode.window.registerWebviewViewProvider, change: vscode.window.onDidChangeActiveTextEditor,
            editor: vscode.window.activeTextEditor, includeScan: LsdynaIncludeTreeProvider.prototype.scan,
            keywordScan: LsdynaKeywordIndexProvider.prototype.scan };
        const context = { subscriptions: [] }, commands = new Map(), views = new Map(), changes = [], scans = [];
        let entities;
        vscode.commands.registerCommand = (id, fn) => { commands.set(id, fn); return { dispose() {} }; };
        vscode.window.createTreeView = (id, options) => { views.set(id, options.treeDataProvider); return { visible: false, dispose() {} }; };
        vscode.window.registerWebviewViewProvider = (id, provider) => { if (id === 'lsdynaEntityReferences') entities = provider; return { dispose() {} }; };
        vscode.window.onDidChangeActiveTextEditor = fn => { changes.push(fn); return { dispose() {} }; };
        LsdynaIncludeTreeProvider.prototype.scan = async function (file) {
            file ||= this.resolveActiveUri().fsPath;
            scans.push(['includes', file]); this.onSelectProject?.(file);
        };
        LsdynaKeywordIndexProvider.prototype.scan = async function (options = {}) {
            const file = options.rootFile || this.resolveActiveUri().fsPath;
            scans.push(['keywords', file]); this.onSelectProject?.(file); return true;
        };
        try {
            vscode.window.activeTextEditor = undefined;
            await extension.activate(context);
            vscode.window.activeTextEditor = { document: fakeDoc('*KEYWORD\n*END', files[0]), setDecorations() {} };
            await commands.get('extension.scanIncludeTree')();
            assert.deepEqual(scans, [['includes', files[0]], ['keywords', files[0]]]);
            assert.equal(entities.scopeContext.projectRoot, files[0]);
            assert.equal(entities.getScopePreference(), 'project');
            const editor = { document: fakeDoc('*KEYWORD\n*END', files[1]), setDecorations() {} };
            vscode.window.activeTextEditor = editor;
            for (const changed of changes) await changed(editor);
            assert.equal(scans.length, 2, 'editor changes must not rescan either structure consumer');
            assert.equal(entities.scopeContext.projectRoot, files[0]);
            assert.equal(views.get('lsdynaKeywordIndex').resolveProjectUri().fsPath, files[0]);
            assert.equal(views.get('lsdynaKeywordIndex').resolveActiveUri().fsPath, files[1]);
            await commands.get('extension.scanKeywordIndex')();
            assert.deepEqual(scans.slice(2), [['keywords', files[1]], ['includes', files[1]]]);
            assert.equal(entities.scopeContext.projectRoot, files[1]);
        } finally {
            for (const item of context.subscriptions) item?.dispose?.();
            vscode.commands.registerCommand = originals.register; vscode.window.createTreeView = originals.tree;
            vscode.window.registerWebviewViewProvider = originals.webview; vscode.window.onDidChangeActiveTextEditor = originals.change;
            vscode.window.activeTextEditor = originals.editor;
            LsdynaIncludeTreeProvider.prototype.scan = originals.includeScan;
            LsdynaKeywordIndexProvider.prototype.scan = originals.keywordScan;
        }
    });
});
