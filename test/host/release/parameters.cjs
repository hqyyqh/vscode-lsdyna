'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');
const { fetchJson, openSocket, createCdp } = require('../../support/devtools.cjs');
const { createEvidenceDirectory } = require('../../../scripts/host/temp-runs.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.check = async (root, checks) => {
    const evidence = createEvidenceDirectory('parameters');
    console.log('Parameter evidence: ' + evidence);
    const source = ['*KEYWORD', '*PARAMETER', 'Rbase,2', 'Rfixed    1.0',
        '*PARAMETER_EXPRESSION', 'Clabel,base', '          base',
        'Rresult   min(1,2)', '          +3', 'Rpower,-3**2', '*END', ''].join('\n');
    const file = path.join(root, 'workspace', 'parameters.k');
    fs.writeFileSync(file, source);
    const document = await vscode.workspace.openTextDocument(file);
    const editor = await vscode.window.showTextDocument(document);
    // Exercise registered commands against a real document, not exported test helpers.
    for (const line of [2, 3, 5, 6, 7, 8, 9]) {
        editor.selection = new vscode.Selection(line, 0, line, 0);
        for (const command of ['extension.lsdynaTab', 'extension.lsdynaTab', 'extension.lsdynaShiftTab']) {
            await vscode.commands.executeCommand(command);
            assert.equal(document.getText(), source, command + ' must preserve source');
            assert.equal(editor.selection.isEmpty, true);
        }
    }
    await vscode.commands.executeCommand('editor.action.formatDocument');
    assert.equal(document.getText(), source);
    assert.equal(document.isDirty, false);
    const rename = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri,
        new vscode.Position(2, 2), 'other');
    assert.ok(rename);
    assert.ok(!rename.entries().flatMap(([, edits]) => edits).some(edit => [5, 6].includes(edit.range.start.line)),
        'character text must not be renamed');
    checks.push('parameter-tab-shift-tab-format-preserve-bytes-and-clean-state', 'parameter-rename-preserves-character-text');

    const targets = await fetchJson(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/json/list`);
    const target = targets.find(t => t.type === 'page' && t.url.includes('workbench'));
    assert.ok(target);
    const cdp = createCdp(await openSocket(target.webSocketDebuggerUrl));
    const captures = [];
    try {
        await vscode.commands.executeCommand('notifications.clearAll');
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Two, preserveFocus: true });
        await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
        const language = vscode.workspace.getConfiguration('lsdyna').get('language');
        const chinese = language === 'zh-cn' || language === 'auto' && vscode.env.language.toLowerCase() === 'zh-cn';
        const expected = chinese ? '字符' : 'C (character)';
        for (const theme of ['Default Light Modern', 'Default Dark Modern']) {
            await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
            for (const fontSize of [14, 22]) {
                const area = await cdp.call('Runtime.evaluate', { returnByValue: true,
                    expression: `document.querySelector('.part.editor').clientWidth` });
                const fraction = (fontSize === 14 ? 480 : 360) / area.result.value;
                await vscode.commands.executeCommand('vscode.setEditorLayout', { orientation: 0,
                    groups: [{ size: fraction }, { size: 1 - fraction }] });
                await vscode.workspace.getConfiguration('editor').update('fontSize', fontSize, vscode.ConfigurationTarget.Global);
                editor.selection = new vscode.Selection(3, 6, 3, 6);
                editor.revealRange(editor.selection);
                await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                await delay(600);
                const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(3, 6));
                assert.ok(hovers?.some(hover => hover.contents.some(content => String(content.value || content).includes(expected))),
                    'registered hover provider must return localized help');
                await vscode.commands.executeCommand('editor.action.showHover', { focus: 'autoFocusImmediately' });
                let text = '', stable = 0;
                const deadline = Date.now() + 8000;
                do {
                    await delay(150);
                    const reply = await cdp.call('Runtime.evaluate', { returnByValue: true,
                        expression: `(() => {
                            const roots = [document], texts = [];
                            for (const root of roots) {
                                for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
                                for (const hover of root.querySelectorAll('.monaco-hover, .monaco-editor-hover')) {
                                    const rect = hover.getBoundingClientRect();
                                    if (rect.width && rect.height && rect.top < innerHeight && rect.left < innerWidth &&
                                        getComputedStyle(hover).visibility !== 'hidden') texts.push(hover.textContent);
                                }
                            }
                            return texts.join(' ');
                        })()` });
                    assert.ok(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
                    text = reply.result.value || '';
                    stable = text.includes(expected) ? stable + 1 : 0;
                    if (!stable) await vscode.commands.executeCommand('editor.action.showHover', { focus: 'autoFocusImmediately' });
                } while (stable < 3 && Date.now() < deadline);
                if (!text.includes(expected)) fs.writeFileSync(path.join(evidence, 'failure.png'),
                    Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64'));
                assert.ok(text.includes(expected), 'localized parameter hover: ' + text);
                assert.ok(/1[–—\-～~]9/.test(text), 'nine-character rule: ' + text);
                assert.ok(!text.includes('7 characters'));
                const name = theme.replaceAll(' ', '-') + '-' + fontSize;
                fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64'));
                captures.push({ theme, fontSize, text });
                await vscode.commands.executeCommand('editor.action.hideHover');
            }
        }
        checks.push('parameter-help-actual-dom-current-manual-localized');
        assert.equal(await vscode.commands.executeCommand('extension.openLsdynaLargeFileViewer',
            { uri: document.uri, line: 3 }), true);
        const browser = await fetchJson(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/json/version`);
        const socket = await openSocket(browser.webSocketDebuggerUrl), views = createCdp(socket);
        const contexts = new Map(), attached = new Set();
        socket.addEventListener('message', event => {
            const message = JSON.parse(String(event.data));
            if (message.method === 'Runtime.executionContextCreated') contexts.set(`${message.sessionId}:${message.params.context.id}`,
                { contextId: message.params.context.id, sessionId: message.sessionId });
            if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(`${message.sessionId}:${message.params.executionContextId}`);
        });
        try {
            let help = '', stable = 0;
            const deadline = Date.now() + 15000;
            while (stable < 3 && Date.now() < deadline) {
                help = '';
                const { targetInfos } = await views.call('Target.getTargets');
                for (const target of targetInfos.filter(target => ['page', 'iframe'].includes(target.type))) {
                    if (attached.has(target.targetId)) continue;
                    const { sessionId } = await views.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                    attached.add(target.targetId);
                    await views.call('Runtime.enable', {}, sessionId);
                }
                for (const context of contexts.values()) {
                    try {
                        const reply = await views.call('Runtime.evaluate', { contextId: context.contextId, returnByValue: true,
                            expression: `(() => {
                                if (document.querySelector('.index-progress')) return '';
                                const row = [...document.querySelectorAll('.line')].find(row => row.querySelector('.line-number')?.textContent === '4');
                                if (!document.querySelector('.field-help')) row?.querySelector('button.field')?.click();
                                const details = document.querySelector('.field-help details');
                                if (details && !details.open) { details.querySelector('summary')?.click(); return ''; }
                                return document.querySelector('.field-help p')?.getBoundingClientRect().height
                                    ? document.querySelector('.field-help').innerText : '';
                            })()` }, context.sessionId);
                        if (reply.result?.value) help = reply.result.value;
                    } catch { /* The webview can replace its initial execution context during loading. */ }
                }
                stable = help.includes(expected) ? stable + 1 : 0;
                await delay(100);
            }
            assert.ok(help.includes(expected) && help.includes('1-9'), 'large-file parameter help: ' + help);
            await delay(200);
            fs.writeFileSync(path.join(evidence, 'large-file.png'), Buffer.from((await cdp.call('Page.captureScreenshot')).data, 'base64'));
            captures.push({ view: 'large-file', text: help });
            checks.push('large-file-parameter-help-actual-dom-current-manual-localized');
        } finally { views.close(); }
    } finally {
        cdp.close();
        fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ vscode: vscode.version,
            hostLanguage: vscode.env.language, pluginLanguage: vscode.workspace.getConfiguration('lsdyna').get('language'),
            captures, checks }, null, 2));
    }
};
