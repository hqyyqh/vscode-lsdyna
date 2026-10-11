'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');

exports.check = async checks => {
    for (const keyword of ['*MAT_ELASTIC', '*MAT_ELASTIC_TITLE', '*AIRBAG_CPG', '*SECTION_BEAM']) {
        const document = await vscode.workspace.openTextDocument({ language: 'lsdyna', content: '*' });
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(0, 1, 0, 1);
        const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, editor.selection.active);
        const item = completions.items.find(item => item.label === keyword);
        assert.ok(item?.insertText instanceof vscode.SnippetString, keyword);
        assert.ok(await editor.insertSnippet(item.insertText));
        const inserted = document.getText();
        assert.equal(document.lineAt(0).text, keyword);
        assert.equal(document.getText(editor.selection).trim(), '', 'First ID/title has no default');
        assert.ok(!editor.selection.isEmpty, 'Blank tab stop preserves its physical width');
        const first = editor.selection;
        await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
        assert.ok(!editor.selection.isEqual(first), 'Tab advances past a blank field');
        assert.equal(document.getText(), inserted, 'Skipping an empty field does not insert its name');
        for (let i = 0; i < 2; i++) await vscode.commands.executeCommand('jumpToNextSnippetPlaceholder');
        assert.equal(document.getText(), inserted);
        await vscode.commands.executeCommand('leaveSnippet');
        const data = inserted.split(/\r?\n/).filter(line => !line.startsWith('*') && !line.startsWith('$'));
        assert.ok(!data.some(line => /\b(MID|TITLE|SID1|RO|ELFORM)\b/.test(line)));
        if (keyword === '*MAT_ELASTIC') assert.equal(data[1].slice(0, 10).trim(), 'P', 'Preserve real text default');
        await vscode.commands.executeCommand('undo');
        assert.equal(document.getText(), '*', 'Insertion is undoable in one step');
        checks.push(keyword + ': blank slots, defaults, Tab and Undo');
    }
};
