const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = require('../support/tempDirectories').trackTempDirectories();
const { vscodeMock: vscode, fakeDoc } = require('../support/helpers');
const extension = require('../../src/extension');
const { LargeFileViewerProvider } = require('../../src/client/LargeFileViewerProvider');

describe('shared LS-DYNA navigation', () => {
    it('routes threshold boundaries and preserves keyword and side destinations', async () => {
        const root = temp(path.join(os.tmpdir(), 'navigation-'));
        const file = path.join(root, 'model.k');
        fs.writeFileSync(file, '*END');
        const commands = new Map(), opened = [], context = { subscriptions: [] };
        const original = { execute: vscode.commands.executeCommand, register: vscode.commands.registerCommand, open: vscode.workspace.openTextDocument,
            show: vscode.window.showTextDocument, large: LargeFileViewerProvider.prototype.openAt };
        vscode.commands.registerCommand = (id, fn) => { commands.set(id, fn); return { dispose() {} }; };
        vscode.workspace.openTextDocument = async uri => fakeDoc('*END', uri.fsPath);
        vscode.commands.executeCommand = async (id, _uri, options) => {
            if (id === 'vscode.open') opened.push({ kind: 'text', options });
        };
        LargeFileViewerProvider.prototype.openAt = async (...args) => { opened.push({ kind: 'large', args }); return true; };
        try {
            await extension.activate(context);
            for (const size of [50 * 1024 * 1024 - 1, 50 * 1024 * 1024, 50 * 1024 * 1024 + 1]) {
                fs.truncateSync(file, size);
                await commands.get('extension.goToKeywordUsage')(file, 17);
                const last = opened.at(-1);
                assert.equal(last.kind, size < 50 * 1024 * 1024 ? 'text' : 'large');
                assert.equal(last.kind === 'text' ? last.options.selection.start.line : last.args[1], 17);
            }
            await commands.get('extension.openToSide')({ filePath: file, lineIndex: 9 });
            assert.equal(opened.at(-1).args[1], 9);
            assert.equal(opened.at(-1).args[2], vscode.ViewColumn.Beside);
            await commands.get('extension.openLsdynaReferenceDefinition')({ filePath: file, lineIndex: 4, character: 10 });
            assert.equal(opened.at(-1).args[3], 10);
        } finally {
            context.subscriptions.forEach(d => d?.dispose?.());
            vscode.commands.executeCommand = original.execute;
            vscode.commands.registerCommand = original.register;
            vscode.workspace.openTextDocument = original.open;
            vscode.window.showTextDocument = original.show;
            LargeFileViewerProvider.prototype.openAt = original.large;
        }
    });
});
