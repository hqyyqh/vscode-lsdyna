'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
module.exports = async (document, command, expected) => {
    const editor = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), document.uri.toString());
    await vscode.commands.executeCommand(command);
    // As in dynamic-hover/host.cjs: execute once, then await the document event.
    const deadline = Date.now() + 5000;
    while (editor.document.getText() !== expected && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(editor.document.getText(), expected, command);
};
