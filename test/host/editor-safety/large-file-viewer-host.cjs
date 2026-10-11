'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
exports.run = async () => {
    const root = process.env.LARGE_VIEWER_EVIDENCE;
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    await extension.activate();
    fs.writeFileSync(path.join(root, 'host.json'), JSON.stringify({ language: vscode.env.language, version: vscode.version }));
    const file = path.join(root, 'large-model.k');
    assert.equal(await vscode.commands.executeCommand('extension.openLsdynaLargeFileViewer', { uri: vscode.Uri.file(file), line: JSON.parse(fs.readFileSync(path.join(root, 'model.json'))).rows + 3, startCharacter: 0, endCharacter: 10 }), true);
    const deadline = Date.now() + 180000;
    while (!fs.existsSync(path.join(root, 'renderer-finished.json'))) {
        if (Date.now() > deadline) throw Error('Large-file viewer renderer validation timed out');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(!vscode.workspace.textDocuments.some(d => d.uri.fsPath === file && d.isDirty));
    const identity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    assert.equal(vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t =>
        t.input?.uri?.fsPath && identity(t.input.uri.fsPath) === identity(file))?.input?.viewType, 'lsdyna.largeFileViewer');
};
