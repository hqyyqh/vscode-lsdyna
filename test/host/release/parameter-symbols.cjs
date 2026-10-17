'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');
const { fetchJson, openSocket, createCdp } = require('../../support/devtools.cjs');
const { createEvidenceDirectory } = require('../../../scripts/host/temp-runs.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.check = async (root, checks) => {
    const evidence = createEvidenceDirectory('parameter-symbols');
    console.log('Parameter symbols evidence: ' + evidence);
    const row = '1'.padStart(8) + '&ba'.padStart(16) + '0'.padStart(16).repeat(2) + '0'.padStart(8).repeat(2);
    const file = path.join(root, 'workspace', 'symbols.k');
    fs.writeFileSync(file, ['*KEYWORD', '*PARAMETER', 'Rbase,2', 'Ccaption,text', '*NODE', row,
        '*PARAMETER', 'Rback,3', '*END', ''].join('\n'));
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document);
    if (process.env.LSDYNA_SYMBOL_THEME) await vscode.workspace.getConfiguration('workbench')
        .update('colorTheme', process.env.LSDYNA_SYMBOL_THEME, vscode.ConfigurationTarget.Global);
    if (process.env.LSDYNA_SYMBOL_FONT) await vscode.workspace.getConfiguration('editor')
        .update('fontSize', Number(process.env.LSDYNA_SYMBOL_FONT), vscode.ConfigurationTarget.Global);
    const position = new vscode.Position(5, 24), original = document.getText();
    const complete = () => vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position);
    const first = await complete();
    const base = first.items.find(item => (item.label.label || item.label) === 'BASE');
    assert.ok(base, 'BASE must be visible before BACK is defined');
    assert.ok(!first.items.some(item => ['BACK', 'CAPTION'].includes(item.label.label || item.label)));
    assert.match(base.detail, /2/);
    assert.equal(document.getText(), original);
    editor.selections = [new vscode.Selection(position, position), new vscode.Selection(5, 40, 5, 40)];
    assert.ok(!(await complete()).items.some(item => (item.label.label || item.label) === 'BASE'));
    assert.equal(document.getText(), original);
    editor.selection = new vscode.Selection(position, position);
    const samples = [];
    for (let i = 0; i < 20; i++) {
        const start = performance.now(); await complete(); samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    checks.push('visible-parameter-completion-excludes-future-and-character-definitions');
    const targets = await fetchJson(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/json/list`);
    const target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
    const cdp = createCdp(await openSocket(target.webSocketDebuggerUrl));
    try {
        editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('notifications.clearAll');
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await vscode.commands.executeCommand('editor.action.triggerSuggest');
        await delay(700);
        const dom = await cdp.call('Runtime.evaluate', { returnByValue: true,
            expression: `document.querySelector('.suggest-widget.visible')?.innerText || ''` });
        assert.ok(dom.result.value.includes('BASE'), dom.result.value);
        await vscode.commands.executeCommand('toggleSuggestionDetails');
        await delay(200);
        fs.writeFileSync(path.join(evidence, 'completion.png'), Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64'));
        await vscode.commands.executeCommand('acceptSelectedSuggestion');
        await delay(250);
        assert.equal(document.lineAt(5).text.slice(8, 24).trim(), '&BASE');
        assert.equal(document.lineAt(5).text.slice(24), row.slice(24));
        assert.equal(document.lineAt(5).text.slice(0, 8), row.slice(0, 8));
        await vscode.commands.executeCommand('undo'); await delay(150);
        assert.equal(document.getText(), original);
        checks.push('native-suggest-ui-accept-keeps-columns-and-undo-restores-bytes');
        editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand('editor.action.triggerSuggest'); await delay(300);
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        for (const width of [480, 360]) {
            await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
            await delay(200);
            const popup = await cdp.call('Runtime.evaluate', { returnByValue: true,
                expression: `document.querySelector('.suggest-widget.visible')?.innerText || ''` });
            assert.ok(popup.result.value.includes('BASE'));
            fs.writeFileSync(path.join(evidence, `completion-${width}.txt`), popup.result.value);
            fs.writeFileSync(path.join(evidence, `completion-${width}.png`),
                Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64'));
        }
        await cdp.call('Emulation.clearDeviceMetricsOverride');
        await vscode.commands.executeCommand('hideSuggestWidget');
        for (const [width, name, negative] of [[10, 'BASE', false], [20, 'BASE', false],
            [10, 'LONGNAME9', false], [10, 'LONGNAME9', true], [20, 'LONGNAME9', true]]) {
            const prefix = name === 'BASE' ? 'ba' : 'lo', sign = negative ? '-' : '';
            const record = 'Ruse'.padStart(width) + `${sign}&${prefix}`.padStart(width) + 'Rother'.padStart(width) + '3'.padStart(width);
            const fixedFile = path.join(root, 'workspace', `fixed-${width}-${name}-${negative}.k`);
            fs.writeFileSync(fixedFile,
                ['*KEYWORD', '*PARAMETER', 'Rbase,2,Rlong,3,Rlongname9,4', width === 20 ? '*PARAMETER+' : '*PARAMETER', record, '*END'].join('\n'));
            const saved = await vscode.workspace.openTextDocument(fixedFile);
            await vscode.window.showTextDocument(saved);
            let list, ready;
            const deadline = performance.now() + 5000;
            do {
                list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', saved.uri,
                    new vscode.Position(4, width * 2));
                ready = list.items.some(item => (item.label.label || item.label) === (name === 'BASE' ? 'BASE' : 'LONG'));
                if (!ready) await delay(100);
            } while (!ready && performance.now() < deadline);
            assert.ok(ready, 'fixed PARAMETER source must be ready');
            const choice = list.items.find(item => (item.label.label || item.label) === name);
            if (width === 10 && negative) { assert.equal(choice, undefined, 'negated name must not overflow'); continue; }
            assert.ok(choice, 'fixed PARAMETER value completion');
            assert.equal(choice.range.start.character, width);
            assert.equal(choice.range.end.character, width * 2);
            const edit = new vscode.WorkspaceEdit(); edit.replace(saved.uri, choice.range, choice.insertText);
            assert.ok(await vscode.workspace.applyEdit(edit));
            assert.equal(saved.lineAt(4).text, record.slice(0, width) + `${sign}&${name}`.padStart(width) + record.slice(width * 2));
            if (width === 10 && name === 'LONGNAME9') {
                await delay(150);
                fs.writeFileSync(path.join(evidence, 'exact-fit.png'), Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64'));
            }
            await vscode.commands.executeCommand('undo'); await delay(100);
            assert.equal(saved.lineAt(4).text, record);
        }
        checks.push('standard-long-exact-fit-negated-overflow-and-multicursor-completion-boundaries');
    } finally {
        cdp.close();
        fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ vscode: vscode.version,
            pluginLanguage: vscode.workspace.getConfiguration('lsdyna').get('language'),
            warmCompletionMs: { p50: samples[10], p95: samples[19] }, checks }, null, 2));
    }
};
