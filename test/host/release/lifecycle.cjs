'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vscode = require('vscode');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
exports.run = async () => {
    const root = process.env.LSDYNA_RELEASE_HOST_ROOT, phase = process.env.LSDYNA_RELEASE_LIFECYCLE;
    const marker = path.join(root, 'lifecycle-state.json'), checks = [];
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    assert.ok(extension);
    const http = require('node:http'), https = require('node:https');
    const saved = [http.request, http.get, https.request, https.get, globalThis.fetch];
    let externalRequests = 0, renderer;
    if (phase === 'offline') {
        const blocked = () => { externalRequests++; throw Error('Unexpected network request during offline acceptance'); };
        http.request = http.get = https.request = https.get = blocked;
        globalThis.fetch = (url, ...args) => {
            // CDP discovery is local test control, not product networking.
            if (String(url).startsWith(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/`)) return saved[4](url, ...args);
            return blocked();
        };
    }
    try {
        await extension.activate();
        const configuration = vscode.workspace.getConfiguration('lsdyna');
        const file = path.join(root, 'workspace/core.k'), original = fs.readFileSync(file);
        const document = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(document);
        const hover = () => vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(2, 1));
        assert.ok((await hover())?.length, 'Installed field hover is unavailable');
        checks.push('installed-activation-and-hover');
        if (phase === 'before-upgrade') {
            assert.equal(extension.packageJSON.version, process.env.LSDYNA_PREVIOUS_VERSION);
            await configuration.update('language', 'en', vscode.ConfigurationTarget.Global);
            fs.writeFileSync(marker, JSON.stringify({ version: extension.packageJSON.version, pid: process.pid }));
            return;
        }
        if (phase === 'upgrade') {
            const previous = JSON.parse(fs.readFileSync(marker));
            assert.ok(require('semver').gt(extension.packageJSON.version, previous.version), 'Upgrade must replace an older release');
            assert.equal(configuration.get('language'), 'en');
            checks.push('prior-release-activated', 'version-increased', 'user-setting-preserved');
        }
        if (phase === 'reload') {
            if (!fs.existsSync(marker)) {
                await configuration.update('language', 'en', vscode.ConfigurationTarget.Global);
                fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, version: extension.packageJSON.version }));
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
                // A reloaded extension host must rerun this driver and finish the scenario.
                await new Promise((_, reject) => setTimeout(() => reject(Error('Window did not reload')), 60000));
            }
            const previous = JSON.parse(fs.readFileSync(marker));
            assert.notEqual(previous.pid, process.pid, 'Reload did not replace the extension host');
            assert.equal(configuration.get('language'), 'en');
            checks.push('window-reloaded', 'new-extension-host', 'setting-preserved');
        }
        if (phase === 'offline' || phase === 'missing-external-manual') {
            renderer = await require('../../support/release/rendered.cjs').connect(process.env.LSDYNA_RELEASE_CDP_PORT,
                { offline: phase === 'offline' });
            await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions', 1);
            await renderer.wait(`typeof document !== 'undefined' && document.querySelector('main')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.fieldEditor input, .fieldEditor select').length >= 5`);
            if (phase === 'offline') {
                await vscode.commands.executeCommand('extension.manual.openReader');
                await renderer.wait(`typeof document !== 'undefined' && !!document.querySelector('.katex') && document.body.textContent.includes('release-formula') && !document.querySelector('.katex-error')`);
                await require('./sqlite.cjs').check(extension, root, checks);
                assert.equal(externalRequests, 0);
                checks.push('offline-rendered-form-and-manual', 'no-extension-host-http-requests');
            } else {
                assert.equal(fs.existsSync(path.join(root, 'workspace/lsdyna_manual_pack')), false);
                const i18n = require(path.join(extension.extensionPath, 'out/core/i18n'));
                const directoryBefore = configuration.get('manualsDir');
                const labels = [i18n.get('manualSetupSelectFolder'),
                    ...(i18n.getLanguage() === 'zh-cn' ? [i18n.get('manualDownloadBilingual')] : []),
                    i18n.get('manualDownloadEnglish')];
                const opening = vscode.commands.executeCommand('extension.manual.openReader').then(() => undefined, error => error);
                try {
                    await renderer.wait(`(() => {
                        const picker = document.querySelector('.quick-input-widget');
                        const rows = [...(picker?.querySelectorAll('.quick-input-list .monaco-list-row') || [])];
                        return picker?.getClientRects().length && picker.innerText.includes(${JSON.stringify(i18n.get('manualSetupTitle'))}) &&
                            rows.length === ${labels.length} && ${JSON.stringify(labels)}.every(label => rows.some(row => row.innerText.includes(label)));
                    })()`);
                } finally {
                    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
                    assert.equal(await opening, undefined, 'Manual setup command failed');
                }
                assert.equal(configuration.get('manualsDir'), directoryBefore, 'Cancelling setup must preserve the configured directory');
                assert.ok(!vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => /lsdynaManualReader/.test(tab.input?.viewType || '')),
                    'A missing pack must not open an empty reader');
                const help = await hover();
                assert.ok(help?.length, 'Missing manual must not disable editing help');
                assert.ok(help.some(item => item.contents.some(content => String(content.value ?? content).includes('command:extension.configureManualsDir'))),
                    'Hover must retain the manual setup action');
                checks.push('manual-setup-options-visible', 'setup-cancel-preserves-directory', 'no-empty-reader', 'editing-help-and-manual-action-preserved');
            }
        }
        if (phase === 'ordinary-project-f5') {
            assert.equal(process.platform, 'win32');
            const workspace = path.join(root, 'workspace'), output = path.join(root, 'debug-executed.json');
            fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
            fs.writeFileSync(path.join(workspace, 'app.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({pid:process.pid}));`);
            fs.writeFileSync(path.join(workspace, '.vscode/launch.json'), JSON.stringify({ version: '0.2.0', configurations: [
                { name: 'Ordinary Node project', type: 'node', request: 'launch', program: '${workspaceFolder}/app.cjs', console: 'internalConsole' },
            ] }));
            let session, terminated = false;
            const start = vscode.debug.onDidStartDebugSession(value => { session = value; });
            const end = vscode.debug.onDidTerminateDebugSession(value => { if (value.id === session?.id) terminated = true; });
            try {
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(workspace, 'app.cjs')));
                await vscode.commands.executeCommand('workbench.action.debug.start');
                const deadline = Date.now() + 60000;
                while ((!terminated || !fs.existsSync(output)) && Date.now() < deadline) await delay(50);
                assert.ok(['node', 'pwa-node'].includes(session?.type), 'Expected the built-in Node debug adapter'); assert.ok(terminated); assert.ok(fs.existsSync(output));
            } finally { start.dispose(); end.dispose(); if (session && !terminated) await vscode.debug.stopDebugging(session); }
            checks.push('ordinary-project-debug-command', 'program-executed', 'debug-session-terminated');
        }
        assert.deepEqual(fs.readFileSync(file), original);
        fs.writeFileSync(path.join(root, 'lifecycle-result.json'), JSON.stringify({ phase, passed: true, checks,
            vscodeVersion: vscode.version, platform: process.platform, arch: process.arch,
            packageVersion: extension.packageJSON.version,
            ...(phase === 'offline' ? { networkScope: 'extension-host HTTP/fetch interception and Webview CDP offline emulation; no OS firewall change' } : {}),
        }, null, 2));
    } finally {
        renderer?.close();
        [http.request, http.get, https.request, https.get, globalThis.fetch] = saved;
    }
};
