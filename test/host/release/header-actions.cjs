'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');
const { fetchJson, openSocket, createCdp } = require('../../support/devtools.cjs');
const { createEvidenceDirectory } = require('../../../scripts/host/temp-runs.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const views = ['lsdynaIncludeTree', 'lsdynaKeywordIndex', 'lsdynaManuals', 'lsdynaEntityReferences'];
function headers(ids) {
    return ids.map(id => {
        const header = document.querySelector('.view-' + id)?.closest('.pane-header');
        if (!header) return { id, missing: true };
        const actions = header.querySelector('.actions'), pane = header.parentElement;
        return { id, expanded: header.getAttribute('aria-expanded') === 'true',
            always: header.classList.contains('actions-always-visible'),
            visible: !!actions && getComputedStyle(actions).display !== 'none',
            showExpanded: !!actions?.classList.contains('show-expanded'),
            focused: pane.matches(':focus-within'), hovered: pane.matches(':hover'),
            labels: [...header.querySelectorAll('.action-label')].map(e => e.getAttribute('aria-label') || e.title),
            more: !!header.querySelector('.codicon-toolbar-more, .codicon-more'),
            width: header.getBoundingClientRect().width };
    });
}
exports.check = async (root, checks) => {
    const key = 'workbench.view.alwaysShowHeaderActions';
    const config = vscode.workspace.getConfiguration();
    const initial = vscode.workspace.getConfiguration().inspect(key);
    const defaultValue = require('../../../package.json').contributes.configurationDefaults[key] ?? false;
    assert.equal(initial.defaultValue, defaultValue);
    for (const scope of ['globalValue', 'workspaceValue', 'workspaceFolderValue'])
        assert.equal(initial[scope], undefined, `${scope} must not mask the extension default`);
    assert.equal(vscode.workspace.getConfiguration().get(key), defaultValue);
    const evidence = createEvidenceDirectory('header-actions');
    console.log('Header actions evidence: ' + evidence);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(root, 'workspace', 'core.k')));
    for (const view of views) await vscode.commands.executeCommand(view + '.focus');
    const targets = await fetchJson(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/json/list`);
    const cdp = createCdp(await openSocket(targets.find(t => t.type === 'page' && t.url.includes('workbench')).webSocketDebuggerUrl));
    const observations = [];
    const evaluate = async expression => {
        const result = await cdp.call('Runtime.evaluate', { returnByValue: true, expression });
        assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const observe = async (name, expected) => {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 800, y: 400 });
        let state, error;
        const deadline = Date.now() + 5000;
        do {
            await delay(100);
            state = await evaluate(`(${headers})(${JSON.stringify(views)})`);
            try {
                assert.equal(vscode.workspace.getConfiguration().get(key), expected);
                for (const item of state) {
                    assert.equal(item.expanded, true, item.id);
                    assert.equal(item.focused, false, item.id);
                    assert.equal(item.hovered, false, item.id);
                    assert.equal(item.always, expected, item.id);
                    assert.equal(item.visible, expected || item.showExpanded, item.id);
                    // Manuals currently has no native title actions; its search mode button is inside the Webview.
                    if (item.id !== 'lsdynaManuals') assert.ok(item.labels.length > 0, item.id);
                    if (item.id === 'lsdynaKeywordIndex') assert.equal(item.more, true, 'Low-frequency actions remain in the overflow menu');
                }
                error = undefined;
            } catch (e) { error = e; }
        } while (error && Date.now() < deadline);
        observations.push({ name, expected, state, configuration: vscode.workspace.getConfiguration().inspect(key), error: error?.message });
        const shot = await cdp.call('Page.captureScreenshot');
        fs.writeFileSync(path.join(evidence, name + '.png'), Buffer.from(shot.data, 'base64'));
        if (error) throw error;
    };
    try {
        await vscode.commands.executeCommand('notifications.clearAll');
        await observe('default', defaultValue);
        await config.update(key, false, vscode.ConfigurationTarget.Global);
        await observe('user-false', false);
        if (vscode.workspace.workspaceFolders?.length) {
            await config.update(key, true, vscode.ConfigurationTarget.Workspace);
            await observe('workspace-true-over-user-false', true);
            await config.update(key, true, vscode.ConfigurationTarget.Global);
            await config.update(key, false, vscode.ConfigurationTarget.Workspace);
            await observe('workspace-false-over-user-true', false);
            await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
        }
        await config.update(key, undefined, vscode.ConfigurationTarget.Global);
        await observe('default-restored', defaultValue);
        for (const theme of ['Default Light Modern', 'Default High Contrast', 'Default High Contrast Light']) {
            await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
            await observe(theme.replaceAll(' ', '-'), defaultValue);
        }
        // Collapse and reopen each native pane through its real title control.
        for (const view of views) {
            await evaluate(`document.querySelector('.view-${view}').closest('.pane-header').click()`);
            await evaluate(`document.querySelector('.view-${view}').closest('.pane-header').click()`);
        }
        await observe('reexpanded', defaultValue);
        for (const width of [240, 320]) {
            const rect = await evaluate("document.querySelector('.part.sidebar').getBoundingClientRect().toJSON()");
            const y = rect.y + rect.height / 2;
            const targetX = rect.right + width - observations.at(-1).state[0].width;
            await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.right, y, button: 'left', buttons: 1, clickCount: 1 });
            await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y, button: 'left', buttons: 1 });
            await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y, button: 'left', buttons: 0, clickCount: 1 });
            await observe(`width-${width}`, defaultValue);
            assert.ok(Math.abs(observations.at(-1).state[0].width - width) <= 2, 'Requested sidebar width');
        }
        await vscode.workspace.getConfiguration('window').update('zoomLevel', 1, vscode.ConfigurationTarget.Global);
        await observe('enlarged', defaultValue);
        for (const language of ['auto', 'zh-cn', 'en']) {
            await vscode.workspace.getConfiguration('lsdyna').update('language', language, vscode.ConfigurationTarget.Global);
            await observe(`language-${language}`, defaultValue);
        }
        const scopePickers = [];
        for (const language of ['auto', 'zh-cn', 'en']) {
            const languageChanged = new Promise(resolve => {
                const listener = vscode.workspace.onDidChangeConfiguration(event => {
                    if (event.affectsConfiguration('lsdyna.language')) { listener.dispose(); resolve(); }
                });
            });
            await vscode.workspace.getConfiguration('lsdyna').update('language', language, vscode.ConfigurationTarget.Global);
            await languageChanged;
            const rowsByView = [];
            for (const [view, command, reset] of [
                ['lsdynaKeywordIndex','extension.keywordIndexChooseScope','extension.keywordIndexSetLocal'],
                ['lsdynaEntityReferences','extension.entityReferences.chooseScope','extension.entityReferences.setScopeFile'],
            ]) {
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(root,'workspace','core.k')));
                await vscode.commands.executeCommand(reset);
                const open = vscode.commands.executeCommand(command);
                let rows;
                for (let attempt=0;attempt<100;attempt++) {
                    rows=await evaluate(`(()=>{const w=document.querySelector('.quick-input-widget');return w && getComputedStyle(w).display!=='none' ? [...w.querySelectorAll('.quick-input-list .monaco-list-row')].map(e=>e.innerText):[];})()`);
                    if(rows?.length===2) break;
                    await delay(50);
                }
                assert.equal(rows?.length,2,'Both scopes are available in the native picker');
                await delay(250); // Let the native picker opening animation finish before capturing it.
                const shot=await cdp.call('Page.captureScreenshot');
                fs.writeFileSync(path.join(evidence,`scope-${language}-${view}.png`),Buffer.from(shot.data,'base64'));
                await vscode.commands.executeCommand('workbench.action.closeQuickOpen');await open;
                rowsByView.push(rows);
                const change=vscode.commands.executeCommand(command);
                await delay(150);
                await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
                await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
                await change;
                const description=await evaluate(`document.querySelector('.view-${view}')?.closest('.pane-header')?.innerText`);
                assert.ok(/主文件及其引用文件|Main deck and include files/.test(description),description);
                scopePickers.push({language,view,rows,description});
            }
            assert.deepEqual(rowsByView[0],rowsByView[1],'Entity and keyword scopes use identical labels');
        }
        fs.writeFileSync(path.join(evidence,'scope-pickers.json'),JSON.stringify({hostLocale:vscode.env.language,scopePickers},null,2));
        checks.push('scope-pickers:keyword-and-entity-native-labels-cancel-switch-three-plugin-languages');
        for (const scope of ['globalValue', 'workspaceValue', 'workspaceFolderValue'])
            assert.equal(vscode.workspace.getConfiguration().inspect(key)[scope], undefined, 'Test overrides must be removed');
        checks.push('header-actions-native-default-and-explicit-overrides');
    } finally {
        cdp.close();
        fs.writeFileSync(path.join(evidence, 'observations.json'), JSON.stringify({ version: vscode.version,
            workspace: process.env.LSDYNA_HEADER_WORKSPACE || 'folder', initial, observations }, null, 2));
    }
};
