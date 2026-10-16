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
    assert.equal(initial.defaultValue, true);
    for (const scope of ['globalValue', 'workspaceValue', 'workspaceFolderValue'])
        assert.equal(initial[scope], undefined, `${scope} must not mask the extension default`);
    assert.equal(vscode.workspace.getConfiguration().get(key), true);
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
                    if (item.id === 'lsdynaKeywordIndex') assert.equal(item.more, false, 'No duplicate layout overflow menu');
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
        await observe('default', true);
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
        await observe('default-restored', true);
        for (const theme of ['Default Light Modern', 'Default High Contrast', 'Default High Contrast Light']) {
            await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
            await observe(theme.replaceAll(' ', '-'), true);
        }
        // Collapse and reopen each native pane through its real title control.
        for (const view of views) {
            await evaluate(`document.querySelector('.view-${view}').closest('.pane-header').click()`);
            await evaluate(`document.querySelector('.view-${view}').closest('.pane-header').click()`);
        }
        await observe('reexpanded', true);
        for (const width of [240, 320]) {
            const rect = await evaluate("document.querySelector('.part.sidebar').getBoundingClientRect().toJSON()");
            const y = rect.y + rect.height / 2;
            const targetX = rect.right + width - observations.at(-1).state[0].width;
            await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.right, y, button: 'left', buttons: 1, clickCount: 1 });
            await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y, button: 'left', buttons: 1 });
            await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y, button: 'left', buttons: 0, clickCount: 1 });
            await observe(`width-${width}`, true);
            assert.ok(Math.abs(observations.at(-1).state[0].width - width) <= 2, 'Requested sidebar width');
        }
        await vscode.workspace.getConfiguration('window').update('zoomLevel', 1, vscode.ConfigurationTarget.Global);
        await observe('enlarged', true);
        for (const language of ['auto', 'zh-cn', 'en']) {
            await vscode.workspace.getConfiguration('lsdyna').update('language', language, vscode.ConfigurationTarget.Global);
            await observe(`language-${language}`, true);
        }
        for (const scope of ['globalValue', 'workspaceValue', 'workspaceFolderValue'])
            assert.equal(vscode.workspace.getConfiguration().inspect(key)[scope], undefined, 'Test overrides must be removed');
        checks.push('header-actions-native-default-and-explicit-overrides');
    } finally {
        cdp.close();
        fs.writeFileSync(path.join(evidence, 'observations.json'), JSON.stringify({ version: vscode.version,
            workspace: process.env.LSDYNA_HEADER_WORKSPACE || 'folder', initial, observations }, null, 2));
    }
};
