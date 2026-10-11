'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const makeTemp = require('../support/tempDirectories').trackTempDirectories();
const { fakeDoc, vscodeMock: vscode } = require('../support/helpers');
const i18n = require('../../src/core/i18n');
const extension = require('../../src/extension');
const { LsdynaIncludeTreeProvider } = require('../../src/client/providers/includeTreeProvider');

describe('registered include search open failures', () => {
    it('distinguishes a real directory read failure from known absence and permits recovery in both languages', async () => {
        const root = makeTemp(path.join(os.tmpdir(), 'dynasense-include-open-'));
        const file = path.join(root, 'child.k'), entry = { filePath: file, label: 'child.k', missing: false };
        const originals = {
            register: vscode.commands.registerCommand, picker: vscode.window.createQuickPick,
            open: vscode.workspace.openTextDocument, show: vscode.window.showTextDocument,
            warning: vscode.window.showWarningMessage, configuration: vscode.workspace.getConfiguration,
            entries: LsdynaIncludeTreeProvider.prototype.listSearchEntries,
        };
        const context = { subscriptions: [] }, commands = new Map(), warnings = [];
        let opened = 0, reads = 0;
        vscode.commands.registerCommand = (id, callback) => { commands.set(id, callback); return { dispose() {} }; };
        LsdynaIncludeTreeProvider.prototype.listSearchEntries = () => [entry];
        vscode.window.createQuickPick = () => {
            let accept, hide;
            return {
                onDidChangeValue: () => ({ dispose() {} }),
                onDidAccept: callback => { accept = callback; return { dispose() {} }; },
                onDidHide: callback => { hide = callback; return { dispose() {} }; },
                show() { queueMicrotask(() => { this.selectedItems = this.items; accept(); }); },
                hide() { hide(); }, dispose() {},
            };
        };
        vscode.window.showWarningMessage = message => { warnings.push(message); };
        vscode.workspace.openTextDocument = async uri => {
            reads++;
            return fakeDoc(await fs.promises.readFile(uri.fsPath, 'utf8'), uri.fsPath);
        };
        vscode.window.showTextDocument = async () => { opened++; };
        try {
            await extension.activate(context);
            for (const language of ['en', 'zh-cn']) {
                vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'language' ? language : fallback });
                i18n.updateLanguage();
                fs.mkdirSync(file); entry.missing = false;
                await commands.get('extension.searchIncludeTree')();
                assert.equal(warnings.at(-1), i18n.get('treeSearchOpenFileWarning', file));
                assert.notEqual(warnings.at(-1), i18n.get('treeSearchMissingFileWarning', file));
                assert.ok(fs.statSync(file).isDirectory());
                fs.rmdirSync(file); fs.writeFileSync(file, '*KEYWORD\n*END\n');
                const warningCount = warnings.length, previousOpened = opened;
                await commands.get('extension.searchIncludeTree')();
                assert.equal(opened, previousOpened + 1); assert.equal(warnings.length, warningCount);
                assert.equal(fs.readFileSync(file, 'utf8'), '*KEYWORD\n*END\n');
                fs.unlinkSync(file); entry.missing = true;
                const previousReads = reads;
                await commands.get('extension.searchIncludeTree')();
                assert.equal(warnings.at(-1), i18n.get('treeSearchMissingFileWarning', file));
                assert.equal(reads, previousReads, 'Known missing entry must not attempt to open');
            }
        } finally {
            for (const disposable of context.subscriptions) disposable?.dispose?.();
            vscode.commands.registerCommand = originals.register;
            if (originals.picker) vscode.window.createQuickPick = originals.picker; else delete vscode.window.createQuickPick;
            vscode.workspace.openTextDocument = originals.open; vscode.window.showTextDocument = originals.show;
            vscode.window.showWarningMessage = originals.warning; vscode.workspace.getConfiguration = originals.configuration;
            LsdynaIncludeTreeProvider.prototype.listSearchEntries = originals.entries;
            i18n.updateLanguage();
        }
    });
});
