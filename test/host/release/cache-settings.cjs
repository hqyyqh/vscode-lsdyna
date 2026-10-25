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
    const info = await fetchJson(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/json/version`);
    const cdp = createCdp(await openSocket(info.webSocketDebuggerUrl));
    const evidence = { locale, scenarios: [] };
    try {
        const { targetInfos } = await cdp.call('Target.getTargets');
        const workbench = targetInfos.find(target => target.type === 'page' && target.url.includes('workbench'));
        assert.ok(workbench);
        const { sessionId } = await cdp.call('Target.attachToTarget', { targetId: workbench.targetId, flatten: true });
        const evaluate = async expression => {
            const response = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
            if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
            return response.result.value;
        };
        const groups = JSON.parse(fs.readFileSync(path.join(extension.extensionPath, 'package.json'), 'utf8')).contributes.configuration;
        const properties = Object.assign({}, ...groups.map(group => group.properties));
        const keys = Object.keys(properties);
        assert.equal(keys.length, 29);
        assert.equal(groups.length, 5);
        const copy = key => strings[(properties[key].markdownDescription || properties[key].description).slice(1, -1)];
        const normalize = text => text.replace(/\*\*|`|>/g, '').replace(/\s+/g, ' ').trim();
        const title = key => { const name = key.split('.').at(-1); return name[0].toUpperCase() + name.slice(1).replace(/[A-Z]/g, value => ' ' + value); };
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        // Native Settings follows the VS Code locale, independently of the plugin runtime locale.
        for (const language of ['auto', 'zh-cn', 'en']) {
            await vscode.workspace.getConfiguration('lsdyna').update('language', language, vscode.ConfigurationTarget.Global);
            for (const key of keys) {
                await vscode.commands.executeCommand('workbench.action.openSettings', `@id:${key}`);
                const description = copy(key);
                const deadline = Date.now() + 15000;
                let text;
                do {
                    text = await evaluate('document.body.innerText');
                    if (normalize(text).includes(normalize(description)) && text.includes(title(key))) break;
                    await delay(50);
                } while (Date.now() < deadline);
                evidence.current = { language, key, text };
                assert.ok(normalize(text).includes(normalize(description)), `Missing ${locale} settings description: ${key}`);
                assert.ok(text.includes(title(key)), `Wrong settings row: ${key}`);
                evidence.scenarios.push({ language, key, description, rendered: true });
            }
        }
        for (const [theme, name] of [['Default Dark Modern', 'dark'], ['Default Light Modern', 'light'], ['Default High Contrast', 'contrast']]) {
            await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
            for (const width of [360, 480, 1000]) for (const zoom of [0, 1]) {
                await vscode.workspace.getConfiguration('window').update('zoomLevel', zoom, vscode.ConfigurationTarget.Global);
                await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
                await evaluate('window.dispatchEvent(new Event("resize"))');
                for (const key of ['lsdyna.columnGuides.enabled', 'lsdyna.cache.entityIndexMemoryMaxMiB']) {
                    await vscode.commands.executeCommand('workbench.action.openSettings', `@id:${key}`);
                    let dom;
                    const deadline = Date.now() + 15000;
                    do {
                        dom = await evaluate(`({text:document.body.innerText,labels:[...document.querySelectorAll('[aria-label]')].map(x=>x.getAttribute('aria-label'))})`);
                        if (normalize(dom.text).includes(normalize(copy(key))) && dom.text.includes(title(key))) break;
                        await delay(50);
                    } while (Date.now() < deadline);
                    evidence.current = { theme, width, zoom, key, ...dom };
                    assert.ok(normalize(dom.text).includes(normalize(copy(key))));
                    assert.ok(dom.text.includes(title(key)), `Wrong captured settings row: ${key}`);
                    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
                    const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' }, sessionId);
                    const namePart = `${locale}-${name}-${width}-${zoom}-${key}`;
                    fs.writeFileSync(path.join(root, `cache-settings-${namePart}.png`), Buffer.from(screenshot.data, 'base64'));
                    evidence.scenarios.push({ theme, themeKind: vscode.window.activeColorTheme.kind, width, zoom, key, ...dom });
                }
            }
        }
        await vscode.workspace.getConfiguration('window').update('zoomLevel', 0, vscode.ConfigurationTarget.Global);
        await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:hqyyqh.dynasense');
        await delay(300);
        evidence.overview = await evaluate('document.body.innerText');
        for (const group of groups) assert.ok(evidence.overview.includes(strings[group.title.slice(1, -1)]), `Missing settings group: ${group.id}`);
        const overview = await cdp.call('Page.captureScreenshot', { format: 'png' }, sessionId);
        fs.writeFileSync(path.join(root, 'settings-overview.png'), Buffer.from(overview.data, 'base64'));
        checks.push(`settings ${locale}: 29 controls in five groups; auto/zh-cn/en; DOM and screenshots at 360/480/1000 px; normal/enlarged; dark/light/high contrast; shared model-index budgets remain configurable`);
    } finally {
        fs.writeFileSync(path.join(root, 'cache-settings.json'), JSON.stringify(evidence, null, 2));
        cdp.close();
    }
};
