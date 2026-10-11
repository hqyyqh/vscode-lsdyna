'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');
const { fetchJson, openSocket, createCdp } = require('../../support/devtools.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.check = async (extension, root, checks) => {
    const locale = vscode.env.language;
    assert.equal(locale, process.env.LSDYNA_RELEASE_LOCALE || 'en');
    const strings = JSON.parse(fs.readFileSync(path.join(extension.extensionPath,
        locale === 'zh-cn' ? 'package.nls.zh-cn.json' : 'package.nls.json'), 'utf8'));
    const deprecation = strings['config.cache.legacyDiskBudget.markdownDeprecationMessage'].replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    const info = await fetchJson(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/json/version`);
    const cdp = createCdp(await openSocket(info.webSocketDebuggerUrl));
    const evidence = { locale, scenarios: [] };
    try {
        // VS Code hides deprecated settings unless a user already configured them.
        for (const key of ['projectSnapshotDiskMaxMiB', 'fileScanDiskMaxMiB'])
            await vscode.workspace.getConfiguration('lsdyna.cache').update(key, 128, vscode.ConfigurationTarget.Global);
        const { targetInfos } = await cdp.call('Target.getTargets');
        const workbench = targetInfos.find(target => target.type === 'page' && target.url.includes('workbench'));
        assert.ok(workbench);
        const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: workbench.targetId, flatten: true });
        const evaluate = async expression => {
            const response = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
            if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
            return response.result.value;
        };
        const keys = ['entityIndexMemoryMaxMiB', 'entityIndexDiskMaxMiB', 'projectSnapshotDiskMaxMiB', 'fileScanDiskMaxMiB', 'maxAgeDays'];
        const title = key => key[0].toUpperCase() + key.slice(1).replace(/[A-Z]/g, value => ' ' + value);
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        // Native Settings follows the VS Code locale, independently of the plugin runtime locale.
        for (const language of ['auto', 'zh-cn', 'en']) {
            await vscode.workspace.getConfiguration('lsdyna').update('language', language, vscode.ConfigurationTarget.Global);
            for (const key of keys) {
                await vscode.commands.executeCommand('workbench.action.openSettings', `@id:lsdyna.cache.${key}`);
                const description = strings[`config.cache.${key}.description`];
                const deadline = Date.now() + 15000;
                let text;
                do {
                    text = await evaluate('document.body.innerText');
                    if (text.includes(description) && text.includes(title(key))) break;
                    await delay(50);
                } while (Date.now() < deadline);
                evidence.current = { language, key, text };
                assert.ok(text.includes(description), `Missing ${locale} settings description: ${key}`);
                assert.ok(text.includes(title(key)), `Wrong settings row: ${key}`);
                if (['projectSnapshotDiskMaxMiB', 'fileScanDiskMaxMiB'].includes(key))
                    assert.ok(text.includes(deprecation));
                evidence.scenarios.push({ language, key, description, rendered: true });
            }
        }
        await vscode.commands.executeCommand('workbench.action.openSettings', '@id:lsdyna.cache.fileScanDiskMaxMiB');
        await delay(200);
        assert.ok(await evaluate(`(()=>{const link=[...document.querySelectorAll('a')].find(a=>a.getAttribute('data-href')==='#lsdyna.cache.entityIndexDiskMaxMiB'||a.getAttribute('href')==='#lsdyna.cache.entityIndexDiskMaxMiB');if(!link)return false;link.click();return true})()`));
        await delay(300);
        assert.ok((await evaluate('document.body.innerText')).includes(strings['config.cache.entityIndexDiskMaxMiB.description']));
        // The shared budget description is the longest active setting; include both deprecated controls in captures.
        for (const [theme, name] of [['Default Dark Modern', 'dark'], ['Default Light Modern', 'light'], ['Default High Contrast', 'contrast']]) {
            await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
            for (const width of [360, 480, 1000]) for (const zoom of [0, 1]) {
                await vscode.workspace.getConfiguration('window').update('zoomLevel', zoom, vscode.ConfigurationTarget.Global);
                await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
                await evaluate('window.dispatchEvent(new Event("resize"))');
                for (const key of ['entityIndexMemoryMaxMiB', 'projectSnapshotDiskMaxMiB', 'fileScanDiskMaxMiB']) {
                    await vscode.commands.executeCommand('workbench.action.openSettings', `@id:lsdyna.cache.${key}`);
                    let dom;
                    const deadline = Date.now() + 15000;
                    do {
                        dom = await evaluate(`({text:document.body.innerText,labels:[...document.querySelectorAll('[aria-label]')].map(x=>x.getAttribute('aria-label'))})`);
                        if (dom.text.includes(strings[`config.cache.${key}.description`]) && dom.text.includes(title(key))) break;
                        await delay(50);
                    } while (Date.now() < deadline);
                    evidence.current = { theme, width, zoom, key, ...dom };
                    assert.ok(dom.text.includes(strings[`config.cache.${key}.description`]));
                    assert.ok(dom.text.includes(title(key)), `Wrong captured settings row: ${key}`);
                    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
                    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' }, sessionId);
                    const namePart = `${locale}-${name}-${width}-${zoom}-${key}`;
                    fs.writeFileSync(path.join(root, `cache-settings-${namePart}.png`), Buffer.from(screenshot.data, 'base64'));
                    evidence.scenarios.push({ theme, themeKind: vscode.window.activeColorTheme.kind, width, zoom, key, ...dom });
                }
            }
        }
        checks.push(`cache settings ${locale}: auto/zh-cn/en; 360/480/1000 px; normal/enlarged; dark/light/high contrast; replacement link opens shared budget`);
    } finally {
        fs.writeFileSync(path.join(root, 'cache-settings.json'), JSON.stringify(evidence, null, 2));
        cdp.close();
    }
};
