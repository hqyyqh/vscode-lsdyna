'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');
const { fetchJson, openSocket, createCdp } = require('../../support/devtools.cjs');
const { createEvidenceDirectory } = require('../../../scripts/host/temp-runs.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.check = async (root, checks) => {
    const evidence = createEvidenceDirectory('parameter-navigation');
    console.log('Parameter navigation evidence: ' + evidence);
    const mainFile = path.join(root, 'workspace', 'parameters.k'), childFile = path.join(root, 'workspace', 'child.k');
    fs.writeFileSync(mainFile, '*KEYWORD\n*PARAMETER_MUTABLE\nRbase,2\n*INCLUDE\nchild.k\n*PARAMETER\nRbase,3\n*NODE\n1,&base,0,0\n*END');
    fs.writeFileSync(childFile, '*PARAMETER_EXPRESSION\nRsum,base+1\n*PARAMETER_LOCAL\nRbase,8\n*NODE\n2,&base,0,0\n*END');
    const main = await vscode.workspace.openTextDocument(mainFile);
    await vscode.window.showTextDocument(main);
    await vscode.commands.executeCommand('extension.scanIncludeTree');
    const child = await vscode.workspace.openTextDocument(childFile);
    const editor = await vscode.window.showTextDocument(child);
    const position = new vscode.Position(1, 6);
    const definition = () => vscode.commands.executeCommand('vscode.executeDefinitionProvider', child.uri, position);
    let definitions;
    const deadline = performance.now() + 10000;
    do { definitions = await definition(); if (!definitions.length) await delay(100); }
    while (!definitions.length && performance.now() < deadline);
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].uri.fsPath.toLowerCase(), mainFile.toLowerCase());
    assert.equal(definitions[0].range.start.line, 2);
    const refs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', main.uri, new vscode.Position(2, 2));
    assert.ok(refs.some(ref => ref.uri.fsPath.toLowerCase() === childFile.toLowerCase() && ref.range.start.line === 1));
    assert.ok(!refs.some(ref => ref.uri.fsPath.toLowerCase() === childFile.toLowerCase() && ref.range.start.line === 5));
    assert.ok(!refs.some(ref => ref.uri.fsPath.toLowerCase() === mainFile.toLowerCase() && ref.range.start.line === 8));
    const local = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', child.uri, new vscode.Position(5, 4));
    assert.equal(local[0].uri.fsPath.toLowerCase(), childFile.toLowerCase()); assert.equal(local[0].range.start.line, 3);
    checks.push('cross-file-bare-definition-and-binding-specific-references');
    const samples = [];
    for (let i = 0; i < 20; i++) { const start = performance.now(); await definition(); samples.push(performance.now() - start); }
    samples.sort((a,b)=>a-b);
    const targets = await fetchJson(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/json/list`);
    const cdp = createCdp(await openSocket(targets.find(t => t.type === 'page' && t.url.includes('workbench')).webSocketDebuggerUrl));
    try {
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('notifications.clearAll');
        editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand('editor.action.peekDefinition');
        await delay(700);
        const dom = await cdp.call('Runtime.evaluate', { returnByValue: true,
            expression: `document.querySelector('.peekview-widget')?.innerText || ''` });
        assert.ok(dom.result.value.includes('parameters.k'), dom.result.value);
        fs.writeFileSync(path.join(evidence, 'peek.txt'), dom.result.value);
        fs.writeFileSync(path.join(evidence, 'peek.png'), Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64'));
        await vscode.commands.executeCommand('closeReferenceSearch');
        const original = child.getText();
        const edit = new vscode.WorkspaceEdit(); edit.replace(child.uri, new vscode.Range(1, 5, 1, 9), 'ghost');
        assert.ok(await vscode.workspace.applyEdit(edit));
        assert.ok(child.isDirty);
        await delay(400);
        assert.deepEqual(await definition(), []);
        const language = vscode.workspace.getConfiguration('lsdyna').get('language');
        const chinese = language === 'zh-cn' || language === 'auto' && vscode.env.language.startsWith('zh');
        const notice = chinese ? '当前位置尚无可确认的参数定义' : 'No parameter definition is confirmed';
        let status;
        const noticeDeadline = performance.now() + 5000;
        do {
            await definition(); await delay(100);
            status = await cdp.call('Runtime.evaluate', { returnByValue: true,
                expression: `document.querySelector('.part.statusbar')?.innerText || ''` });
        } while (!status.result.value.includes(notice) && performance.now() < noticeDeadline);
        assert.ok(status.result.value.includes(notice), status.result.value);
        fs.writeFileSync(path.join(evidence, 'unresolved-status.txt'), status.result.value);
        const changedRefs = await vscode.commands.executeCommand('vscode.executeReferenceProvider', main.uri, new vscode.Position(2, 2));
        assert.ok(!changedRefs.some(ref => ref.uri.fsPath.toLowerCase() === childFile.toLowerCase() && ref.range.start.line === 1));
        assert.equal(fs.readFileSync(childFile, 'utf8'), original);
        await vscode.window.showTextDocument(child); await vscode.commands.executeCommand('undo'); await delay(400);
        assert.equal(child.getText(), original);
        assert.equal((await definition())[0].range.start.line, 2);
        const scratch = await vscode.workspace.openTextDocument({ language: 'lsdyna',
            content: '*PARAMETER\nRbase,2\n*NODE\n1,&base,0,0' });
        await vscode.window.showTextDocument(scratch);
        assert.deepEqual(await vscode.commands.executeCommand('vscode.executeDefinitionProvider', scratch.uri,
            new vscode.Position(3, 4)), []);
        checks.push('native-peek-and-unsaved-source-refresh-without-writing-files');
    } finally {
        cdp.close();
        fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ vscode: vscode.version,
            pluginLanguage: vscode.workspace.getConfiguration('lsdyna').get('language'), checks,
            warmDefinitionMs: { p50: samples[10], p95: samples[19] } }, null, 2));
    }
};
