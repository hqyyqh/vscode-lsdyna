'use strict';
const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock: vscode } = require('../../helpers');
const extension = require('../../../src/extension');
const { KeywordOptionsWebviewProvider } = require('../../../src/client/KeywordOptionsWebviewProvider');

describe('closed keyword manager event work', () => {
    for (const change of ['cursor', 'editor', 'closed', 'split-editor', 'same-cursor', 'same-editor']) it(`handles a pending open after ${change} events`, async () => {
        const unchanged = change.startsWith('same-');
        const callbacks = { onDidChangeActiveTextEditor: [], onDidChangeTextEditorSelection: [] };
        const originals = {}, commands = new Map(), context = { subscriptions: [], extensionPath: process.cwd() };
        const register = vscode.commands.registerCommand, previousEditor = vscode.window.activeTextEditor;
        const createPanel = vscode.window.createWebviewPanel;
        const panels = [];
        vscode.window.createWebviewPanel = (viewType, title, viewColumn) => {
            const panel = {
                viewType, title, viewColumn, visible: true,
                webview: {
                    cspSource: 'vscode-resource:', asWebviewUri: uri => uri,
                    postMessage: async () => true,
                    onDidReceiveMessage: () => ({ dispose() {} }),
                },
                reveal() {},
                onDidDispose(callback) { this.disposeCallback = callback; return { dispose() {} }; },
                dispose() { this.disposeCallback?.(); },
            };
            panels.push(panel);
            return panel;
        };
        const catalog = extension._internals.getCatalogInputFormCatalogV4({ allowUnaudited: false });
        const prepare = catalog.prepareKeyword;
        let entered, release;
        const started = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        for (const name of Object.keys(callbacks)) {
            originals[name] = vscode.window[name];
            vscode.window[name] = callback => { callbacks[name].push(callback); return { dispose() {} }; };
        }
        vscode.commands.registerCommand = (name, callback) => { commands.set(name, callback); return { dispose() {} }; };
        vscode.window.activeTextEditor = undefined;
        try {
            await extension.activate(context);
            const document = fakeDoc('*KEYWORD\n*MAT_ELASTIC\n         7    7.8e-9    210000       0.3\n*END', `/pending-manager/${change}.k`);
            document.languageId = 'lsdyna'; document.version = 1; document.isClosed = false;
            const selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0));
            const editor = { document, selection, selections: [selection], setDecorations() {} };
            vscode.window.activeTextEditor = editor;
            catalog.prepareKeyword = async function(keyword) {
                if (keyword.replace(/^\*/, '') === 'MAT_ELASTIC') { entered(); await gate; }
                return prepare.call(this, keyword);
            };
            const pending = commands.get('extension.lsdynaChooseKeywordOptions')(1);
            await started;
            assert.equal(panels.length, 1, 'The loading panel must exist before preparation finishes');
            if (change === 'closed') document.isClosed = true;
            else if (change.endsWith('cursor')) {
                const next = unchanged ? selection : new vscode.Selection(new vscode.Position(3, 0), new vscode.Position(3, 0));
                editor.selection = next;
                for (const callback of callbacks.onDidChangeTextEditorSelection) await callback({ textEditor: editor, selections: [next] });
            } else {
                const next = unchanged ? editor : change === 'split-editor'
                    ? { ...editor, selection: new vscode.Selection(new vscode.Position(3, 0), new vscode.Position(3, 0)) }
                    : { ...editor, document: fakeDoc('*KEYWORD\n*END', '/pending-manager/other.k') };
                vscode.window.activeTextEditor = next;
                for (const callback of callbacks.onDidChangeActiveTextEditor) await callback(next);
            }
            release();
            // An explicit open keeps its requested target even when focus moves.
            if (change !== 'closed') assert.equal((await pending)?.currentKeyword, '*MAT_ELASTIC');
            else {
                assert.equal(await pending, null);
                assert.equal(extension._internals.keywordManagerInstanceDirectories.has(document), false);
            }
        } finally {
            release(); catalog.prepareKeyword = prepare;
            for (const disposable of context.subscriptions) await disposable?.dispose?.();
            for (const name of Object.keys(callbacks)) vscode.window[name] = originals[name];
            vscode.commands.registerCommand = register;
            vscode.window.createWebviewPanel = createPanel;
            vscode.window.activeTextEditor = previousEditor;
        }
    });
    it('does not construct and publish manager state on file or cursor changes before opening', async () => {
        const callbacks = { onDidChangeActiveTextEditor: [], onDidChangeTextEditorSelection: [] };
        const originals = {};
        const publish = KeywordOptionsWebviewProvider.prototype.publish;
        const previousEditor = vscode.window.activeTextEditor;
        const context = { subscriptions: [] };
        let publications = 0;
        for (const name of Object.keys(callbacks)) {
            originals[name] = vscode.window[name];
            vscode.window[name] = callback => {
                callbacks[name].push(callback);
                return { dispose() {} };
            };
        }
        KeywordOptionsWebviewProvider.prototype.publish = function (...args) {
            publications++;
            return publish.apply(this, args);
        };
        vscode.window.activeTextEditor = undefined;
        try {
            await extension.activate(context);
            const document = fakeDoc('*KEYWORD\n*MAT_ELASTIC\n       7     7.8     210     0.3\n*END', '/idle-manager/model.k');
            document.languageId = 'lsdyna';
            document.version = 1;
            const position = new vscode.Position(1, 0);
            const selection = new vscode.Selection(position, position);
            const editor = { document, selection, selections: [selection], setDecorations() {} };
            vscode.window.activeTextEditor = editor;
            const initialPublications = publications;
            for (const callback of callbacks.onDidChangeActiveTextEditor) await callback(editor);
            for (const callback of callbacks.onDidChangeTextEditorSelection) {
                await callback({ textEditor: editor, selections: [selection] });
            }
            assert.equal(publications, initialPublications);
        } finally {
            for (const disposable of context.subscriptions) await disposable?.dispose?.();
            for (const name of Object.keys(callbacks)) vscode.window[name] = originals[name];
            KeywordOptionsWebviewProvider.prototype.publish = publish;
            vscode.window.activeTextEditor = previousEditor;
        }
    });
});
