'use strict';
const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock: vscode } = require('../support/helpers');
const { handlePickSimilarKeywordHelpCommand, buildUnknownKeywordHoverMarkdown, rememberSimilarKeywordChoice } = require('../../src/extension')._internals;

describe('compiled similar keyword help ownership', () => {
    it('keeps the real session choice on its originating document after editor switching', async () => {
        const a = fakeDoc('*UNKNOWN\n*UNKNOWN', '/ownership-a.k'), b = fakeDoc('*UNKNOWN\n*UNKNOWN', '/ownership-b.k');
        for (const document of [a, b]) {
            const file = document.uri.fsPath;
            // The repository URI mock has no toString; real VS Code URIs are unique.
            Object.assign(document, { uri: { ...vscode.Uri.file(file), toString: () => 'file://' + file }, version: 1, isClosed: false });
        }
        const editor = document => ({ document, selection: new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 0)) });
        const ea = editor(a), eb = editor(b), selectionB = eb.selection, unknown = 'UNRECOGNIZED_OWNERSHIP_TEST';
        const saved = { editor: vscode.window.activeTextEditor, picker: vscode.window.showQuickPick,
            command: vscode.commands.executeCommand, documents: vscode.workspace.textDocuments };
        const commands = [];
        let pick;
        vscode.workspace.textDocuments = [a, b]; vscode.window.activeTextEditor = ea;
        vscode.window.showQuickPick = () => new Promise(resolve => { pick = resolve; });
        vscode.commands.executeCommand = async command => commands.push(command);
        try {
            const pending = handlePickSimilarKeywordHelpCommand({ keyword: unknown, line: 1, suggestions: ['NODE'], uri: a.uri.toString() });
            assert.equal(typeof pick, 'function');
            vscode.window.activeTextEditor = eb; pick({ keyword: 'NODE' }); await pending;
            assert.equal(buildUnknownKeywordHoverMarkdown(unknown, { document: a, line: 1 }).suggestHelpKeyword, 'NODE');
            assert.equal(buildUnknownKeywordHoverMarkdown(unknown, { document: b, line: 1 }).suggestHelpKeyword, null);
            assert.equal(eb.selection, selectionB); assert.deepEqual(commands, []);
        } finally {
            for (const document of [a, b]) rememberSimilarKeywordChoice(document, 1, unknown, null);
            vscode.workspace.textDocuments = saved.documents; vscode.window.activeTextEditor = saved.editor;
            vscode.window.showQuickPick = saved.picker; vscode.commands.executeCommand = saved.command;
        }
    });
});
