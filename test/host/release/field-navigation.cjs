'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');
const { fetchJson, openSocket, createCdp } = require('../../support/devtools.cjs');
const { createEvidenceDirectory } = require('../../../scripts/host/temp-runs.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.check = async (root, checks) => {
    const evidence = createEvidenceDirectory('field-navigation');
    console.log('Field navigation evidence: ' + evidence);
    const document = await vscode.workspace.openTextDocument(path.join(root, 'workspace', 'core.k'));
    const editor = await vscode.window.showTextDocument(document);
    const original = document.getText(), row = document.lineAt(2).text;
    const targets = await fetchJson(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/json/list`);
    const target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
    assert.ok(target);
    const cdp = createCdp(await openSocket(target.webSocketDebuggerUrl));
    const selected = (start, end) => {
        assert.equal(editor.selection.start.line, 2);
        assert.equal(editor.selection.start.character, start);
        assert.equal(editor.selection.end.character, end);
    };
    // Send actual keys through the workbench so command enablement is also tested.
    const tab = async (reverse = false) => {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await delay(150);
        for (const type of ['keyDown', 'keyUp']) await cdp.call('Input.dispatchKeyEvent',
            { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: reverse ? 8 : 0 });
        await delay(250);
    };
    try {
        await vscode.commands.executeCommand('notifications.clearAll');
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        for (const reverse of [false, true]) {
            editor.selection = new vscode.Selection(2, 12, 2, 12);
            await tab(reverse);
            selected(9, 24);
            assert.equal(document.getText(), original);
            await tab(reverse);
            selected(reverse ? 0 : 25, reverse ? 8 : 40);
        }
        checks.push('first-tab-and-shift-tab-select-current-then-navigate');
        editor.selection = new vscode.Selection(2, 12, 2, 12);
        await tab();
        await vscode.commands.executeCommand('type', { text: '12.5' });
        await delay(200);
        const changed = document.lineAt(2).text;
        assert.equal(changed.slice(8, 24).trim(), '12.5');
        assert.equal(changed.slice(0, 8), row.slice(0, 8));
        assert.equal(changed.slice(24), row.slice(24));
        await tab();
        selected(25, 40);
        await vscode.commands.executeCommand('undo');
        await delay(200);
        assert.equal(document.getText(), original);
        checks.push('selected-field-type-preserves-neighbours-and-undo');
        for (const theme of ['Default Light Modern', 'Default Dark Modern']) {
            await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
            editor.selection = new vscode.Selection(2, 30, 2, 30);
            await tab(true);
            selected(25, 40);
            await delay(300);
            fs.writeFileSync(path.join(evidence, theme.replaceAll(' ', '-') + '.png'),
                Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64'));
        }
        checks.push('moved-caret-selects-new-current-field-light-and-dark');
    } finally {
        cdp.close();
        fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ vscode: vscode.version,
            hostLanguage: vscode.env.language, pluginLanguage: vscode.workspace.getConfiguration('lsdyna').get('language'), checks }, null, 2));
    }
};
