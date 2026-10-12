'use strict';
const { fetchJson, openSocket, createCdp } = require('../../test/support/devtools.cjs');
// Real VS Code Webview timings, through its production transport and extension host.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { runTests } = require('./vsix-host.cjs');
const { resolveVSCodeExecutable } = require('./run-editor-safety-extension-host.cjs');
const { writeEvidence } = require('./temp-runs.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function writeRequest(root, name, value) {
    const target = path.join(root, name);
    writeEvidence(target + '.tmp', JSON.stringify(value));
    // ponytail: retry Windows reader locks for 1s; use unique request files if locks persist longer.
    for (let attempt = 0; ; attempt++) {
        try { await fs.promises.rename(target + '.tmp', target); return; }
        catch (error) {
            if (error.code !== 'EPERM' || attempt === 19) throw Object.assign(error, { evidenceSaveFailed: true });
            await delay(50);
        }
    }
}

async function runSelectorGuiHost(options, root) {
    if (process.env.LSDYNA_TEST_VSIX) throw Error('Instance selector GUI currently verifies the development host');
    const driver = path.join(root, 'gui-driver');
    fs.mkdirSync(driver);
    writeEvidence(path.join(driver, 'package.json'), JSON.stringify({name:'selector-gui-driver',publisher:'local',
        version:'0.0.0',engines:{vscode:'^1.100.0'},activationEvents:['*'],main:'main.cjs',extensionKind:['workspace']}));
    writeEvidence(path.join(driver, 'main.cjs'), `const fs=require('node:fs'),vscode=require('vscode');
exports.activate=()=>{void (async()=>{
let error;try{await require(${JSON.stringify(options.extensionTestsPath)}).run();}catch(e){error=String(e.stack||e);}
fs.writeFileSync(${JSON.stringify(path.join(root,'gui-host-finished.json'))},JSON.stringify({error}));
await vscode.commands.executeCommand('workbench.action.quit');})();};`);
    const {spawn} = require('node:child_process');
    const env = {...process.env,...options.extensionTestsEnv};
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(options.vscodeExecutablePath,[...options.launchArgs,
        `--extensionDevelopmentPath=${options.extensionDevelopmentPath}`,`--extensionDevelopmentPath=${driver}`],
        {env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
    await new Promise((resolve,reject)=>{
        child.once('error',reject);
        child.once('close',(code,signal)=>{
            let done;try{done=JSON.parse(fs.readFileSync(path.join(root,'gui-host-finished.json')));}catch{}
            if(!done || done.error || code) reject(Object.assign(Error(done?.error||`GUI host exited ${code}/${signal}`),{runtimeMayBeActive:!!signal}));
            else resolve();
        });
    });
}

async function main() {
    const instanceSelector = process.argv.includes('--instance-selector');
    const incomplete = process.argv.includes('--incomplete');
    const acceptanceLayouts = process.argv.includes('--acceptance-layouts');
    const editorAcceptance = process.argv.includes('--editor-acceptance');
    const semanticHelp = process.argv.includes('--semantic-help');
    const standardRepeat = process.argv.includes('--standard-repeat');
    const unverified = process.argv.includes('--repeat-unverified');
    const repeated = process.argv.includes('--repeated') || unverified || standardRepeat;
    const language = process.argv.find(arg => arg.startsWith('--language='))?.split('=')[1] || 'auto';
    const locale = process.argv.find(arg => arg.startsWith('--locale='))?.split('=')[1] || 'en';
    if (!['en', 'zh-cn'].includes(locale)) throw Error('Unknown host locale');
    if (!['auto', 'en', 'zh-cn'].includes(language)) throw Error('Unknown language');
    const comments = semanticHelp ? 'correct' : process.argv.find(arg => arg.startsWith('--comments='))?.split('=')[1];
    if (repeated && (incomplete || comments)) throw Error('Choose one GUI scenario');
    if (comments && !['none', 'correct', 'wrong', 'missing'].includes(comments)) throw Error('Unknown comment scenario');
    const { createTempRun, finishTempRun } = require('./temp-runs.cjs');
    const root = createTempRun('dynasense-manager-gui-');
    let runtimeRetained = false;
    const retainRuntime = () => {
        if (!runtimeRetained) { finishTempRun(root, { retain: true }); runtimeRetained = true; }
    };
    try {
    const port = await new Promise(resolve => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
    });
    fs.mkdirSync(path.join(root, 'profile', 'User'), { recursive: true });
    if (locale === 'zh-cn' && process.env.LSDYNA_LANGUAGE_EXTENSIONS)
        require('./language-pack.cjs').copyChineseLanguagePack(root, process.env.LSDYNA_LANGUAGE_EXTENSIONS,
            process.env.LSDYNA_LANGUAGE_PACK_CACHE);
    writeEvidence(path.join(root, 'profile', 'User', 'settings.json'), JSON.stringify({
        'workbench.startupEditor': 'none',
        ...(instanceSelector ? { 'window.dialogStyle': 'custom' } : {}),
        ...(instanceSelector ? { 'files.hotExit': 'onExit' } : {}),
        'lsdyna.language': language,
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
    }));
    console.log(`Renderer evidence: ${root}`);
    fs.mkdirSync(path.join(root, 'workspace'));
    let hostError;
    const host = (instanceSelector ? options => runSelectorGuiHost(options, root) : runTests)({ vscodeExecutablePath: resolveVSCodeExecutable(),
        extensionDevelopmentPath: path.resolve(__dirname, "../.."),
        extensionTestsPath: path.resolve(__dirname, "../../test/host/keyword-manager/extension-host.cjs"),
        extensionTestsEnv: { KEYWORD_MANAGER_INSTANCE_SELECTOR: instanceSelector ? '1' : '', KEYWORD_MANAGER_SELECTOR_GUI: instanceSelector ? '1' : '', KEYWORD_MANAGER_HOST_EVIDENCE: root, KEYWORD_MANAGER_GUI: '1', KEYWORD_MANAGER_GUI_REPEAT: standardRepeat ? 'standard' : unverified ? 'unverified' : repeated ? '1' : '', KEYWORD_MANAGER_GUI_COMMENTS: comments || '', KEYWORD_MANAGER_GUI_SHARED: incomplete || comments || repeated ? '' : '1', KEYWORD_MANAGER_GUI_INCOMPLETE: incomplete ? '1' : '' },
        launchArgs: [root, '--new-window', `--locale=${locale}`, '--disable-extensions', '--disable-gpu', '--disable-workspace-trust',
            '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(root, 'profile')}`,
            `--extensions-dir=${path.join(root, 'extensions')}`, '--remote-debugging-address=127.0.0.1',
            `--remote-debugging-port=${port}`],
    }).catch(error => { hostError = error; if (error.signal || error.runtimeMayBeActive || error.evidenceSaveFailed) retainRuntime(); });
    let socket;
    const deadline = Date.now() + 120000;
    while (!socket && Date.now() < deadline) {
        if (hostError) throw hostError;
        try {
            const info = await fetchJson(`http://127.0.0.1:${port}/json/version`, Math.min(3000, deadline - Date.now()));
            socket = await openSocket(info.webSocketDebuggerUrl, Math.min(3000, deadline - Date.now()));
        } catch { socket = null; await delay(100); }
    }
    if (!socket) throw new Error('No DevTools endpoint');
    console.log('Manager GUI: DevTools connected');
    const contexts = new Map(), attached = new Set();
    const cdp = createCdp(socket);
    const call = cdp.call;
    let pageSession;
    socket.onmessage = event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.method === 'Runtime.executionContextCreated') {
            const context = message.params.context;
            contexts.set(`${message.sessionId}:${context.id}`, { contextId: context.id, sessionId: message.sessionId });
        }
        if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(`${message.sessionId}:${message.params.executionContextId}`);
        if (message.method === 'Runtime.executionContextsCleared') {
            for (const [key, value] of contexts) if (value.sessionId === message.sessionId) contexts.delete(key);
        }
    };
    const evaluate = async (context, expression) => {
        const response = await call('Runtime.evaluate', { contextId: context.contextId,
            expression, returnByValue: true, awaitPromise: true }, context.sessionId);
        if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
        return response.result.value;
    };

    let rendererError;
    try {
        const findManagerContext = async () => {
        let context;
        const until = Date.now() + 90000;
        while (!context && Date.now() < until) {
            if (hostError) throw hostError;
            if (instanceSelector && !fs.existsSync(path.join(root, 'selector-ready.json'))) { await delay(100); continue; }
            const { targetInfos } = await call('Target.getTargets');
            for (const target of targetInfos.filter(t => ['page', 'iframe'].includes(t.type))) {
                if (attached.has(target.targetId)) continue;
                attached.add(target.targetId);
                try {
                    const { sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                    await call('Runtime.enable', {}, sessionId);
                    if (target.type === 'page') pageSession = sessionId;
                } catch { attached.delete(target.targetId); }
            }
            for (const candidate of contexts.values()) {
                try {
                    const selector = instanceSelector ? '.instanceTrigger' : unverified ? '.unresolvedRecords' : `.field span[title=${standardRepeat ? 'PID' : repeated ? 'PSID1' : incomplete || comments ? 'RO' : 'ICURV'}]`;
                    if (await evaluate(candidate, `typeof document !== 'undefined' && !!document.querySelector(${JSON.stringify(selector)})`)) { context = candidate; break; }
                } catch {}
            }
            if (!context) await delay(100);
        }
        if (!context) throw new Error('Manager iframe not found');
        return context;
        };
        const context = await findManagerContext();
        console.log('Manager GUI: field renderer located');
        const hostState = JSON.parse(fs.readFileSync(path.join(root, instanceSelector ? 'selector-ready.json' : 'gui-ready.json')));
        if (hostState.hostLanguage !== locale) throw Error(`Host language ${hostState.hostLanguage} does not match ${locale}`);
        writeEvidence(path.join(root, 'initial-render.json'), JSON.stringify(await evaluate(context,
            `({ text: document.body.innerText, busy: document.querySelector('main')?.getAttribute('aria-busy') })`), null, 2));
        if (instanceSelector) {
            const result = await require('../../test/host/keyword-manager/instance-selector-gui.cjs')({
                root, context, evaluate, refreshContext: findManagerContext, call, pageSession, writeRequest, locale, language,
            });
            console.log(JSON.stringify(result));
            writeEvidence(path.join(root, 'gui-finish.json'), JSON.stringify({ selectorPassed: true }));
            return;
        }
        await evaluate(context, `(async () => { const end = Date.now() + 15000;
            while (document.querySelector('main')?.getAttribute('aria-busy') === 'true') {
                if (Date.now() > end) throw Error('Manager preparation did not finish');
                await new Promise(resolve => setTimeout(resolve, 25));
            } })()`);
        if (process.argv.includes('--source-privacy')) await evaluate(context, `(() => {
            const labels = [...document.querySelectorAll('[aria-label], [title]')]
                .map(element => (element.getAttribute('aria-label') || '') + ' ' + (element.getAttribute('title') || '')).join(' ');
            if (document.querySelector('#form-source, .catalogSource') || /LS[- ]?PrePost|LSPP|表单来源|Form source/i.test(document.body.innerText + ' ' + labels))
                throw Error('Database provenance is exposed in the rendered manager');
            return true;
        })()`);
        const result = unverified ? await evaluate(context, `(() => {
            const text = document.body.innerText;
            if (!/cannot determine how these records repeat|尚不能确定这些记录的重复方式/.test(text)) throw Error('Unsupported-rule diagnostic missing');
            if (/require[s]? \\d+ data records|要求 \\d+ 条数据记录/.test(text)) throw Error('Unknown count presented as exact');
            if (document.querySelector('.detailsActions button.primaryText:not(:disabled)')) throw Error('Unverified write enabled');
            const location = document.querySelector('.layoutDiagnosticLocation');
            if (!location) throw Error('Source location action missing');
            location.click();
            return { readonly: true, location: true, text };
        })()`) : repeated ? await evaluate(context, '(' + (async standardRepeat => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            const until = async check => {
                const deadline = performance.now() + 15000;
                while (!check()) { if (performance.now() > deadline) throw Error(document.body.innerText.slice(-3000)); await wait(25); }
            };
            const fields = () => [...document.querySelectorAll(standardRepeat ? '.field span[title=PID]' : '.field span[title=PSID1]')].map(label => label.closest('.field').querySelector('input'));
            const values = () => fields().map(field => field.value).join(',');
            if (values() !== (standardRepeat ? '1,2,3' : '2000106,2000105,2000104') || fields().some(field => field.readOnly)) throw Error('Repeated fields are missing or read-only');
            const set = async () => {
                const input = fields()[1]; input.focus();
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, standardRepeat ? '7' : '3000001');
                input.dispatchEvent(new Event('input', { bubbles: true })); await wait(50); input.blur();
                await until(() => document.querySelector('.detailsActions button.primaryText:not(:disabled)'));
            };
            await set();
            const cancel = document.querySelector('.detailsActions .toolbarTextAction:not(.primaryText)');
            if (!cancel) throw Error('Discard draft action missing');
            cancel.click();
            await until(() => !document.querySelector('.detailsActions button.primaryText') && values() === (standardRepeat ? '1,2,3' : '2000106,2000105,2000104'));
            await set();
            if (standardRepeat) {
                const preview = document.querySelector('.changePreview')?.innerText || '';
                if (!preview.includes('PID: 2 → 7') || !preview.includes('DOF: 2 → 7')) throw Error('Linked repeated-field preview missing: ' + preview);
            }
            document.querySelector('.detailsActions button.primaryText').click();
            await until(() => !document.querySelector('.fieldEditor.changed') && values() === (standardRepeat ? '1,7,3' : '2000106,3000001,2000104') && document.querySelector('main').getAttribute('aria-busy') !== 'true');
            await until(() => !/正在加载|Loading(?:\.\.\.|…)/.test(document.body.innerText));
            return { applied: true, discarded: true, repeatedValues: values(), text: document.body.innerText };
        }).toString() + `)(${standardRepeat})`) : comments ? await evaluate(context, '(' + (async missing => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            const until = async check => {
                const deadline = performance.now() + 15000;
                while (!check()) { if (performance.now() > deadline) throw Error(document.body.innerText.slice(-3000)); await wait(25); }
            };
            const field = name => document.querySelector('.field span[title=' + name + ']').closest('.field').querySelector('input');
            const apply = () => document.querySelector('.detailsActions button.primaryText');
            if (missing) {
                if (!field('RO').readOnly || apply()?.disabled === false || !document.querySelector('.unresolvedRecords')) throw Error('Missing-layout safety UI absent');
                if (!/require 11 data records; found 10|要求 11 条数据记录，实际 10 条/.test(document.querySelector('.message')?.innerText || '')) throw Error('Missing record counts');
                if (![...document.querySelectorAll('.requiredCard')].some(item => item.innerText.includes('A<0') && item.innerText.includes('CRC1'))) throw Error('Missing conditional-card guidance');
                document.querySelector('.layoutDiagnosticLocation').click();
                return { missing: true, readonly: true, sourceText: document.querySelector('.unresolvedRecords').innerText };
            }
            if (field('MID').value !== '' || field('FIT').value !== '1.0') throw Error('Wrong field identity');
            const set = async value => {
                const input = field('RO'); input.focus();
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true })); await wait(50); input.blur();
            };
            await set('2'); await until(() => !apply().disabled);
            const cancel = document.querySelector('.detailsActions .toolbarTextAction:not(.primaryText)');
            if (!cancel) throw Error('Cancel unavailable');
            cancel.click(); await until(() => !document.querySelector('.detailsActions button.primaryText') && field('RO').value === '' && document.querySelector('main').getAttribute('aria-busy') !== 'true');
            await set('7.85'); await until(() => apply() && !apply().disabled && field('RO').value === '7.85' && document.querySelector('main').getAttribute('aria-busy') !== 'true'); apply().click();
            await until(() => !document.querySelector('.fieldEditor.changed') && field('RO').value === '7.85' && document.querySelector('main').getAttribute('aria-busy') !== 'true');
            return { cancelled: true, applied: true, mid: field('MID').value, ro: field('RO').value };
        }).toString() + `)(${comments === 'missing'})`) : incomplete ? await evaluate(context, '(' + (async () => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            const until = async check => {
                const deadline = performance.now() + 15000;
                while (!check()) { if (performance.now() > deadline) throw new Error(document.body.innerText.slice(-3000)); await wait(25); }
            };
            const field = name => document.querySelector('.field span[title=' + name + ']').closest('.field').querySelector('input');
            if (field('RO').readOnly || !field('RO').getAttribute('aria-describedby')) throw new Error('Missing editable field diagnostic');
            if (field('TITLE').value !== 'TITLE') throw new Error('Title changed');
            const set = async value => {
                const input = field('RO'); input.focus();
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                await wait(50); input.blur();
            };
            await set('oops');
            await until(() => document.querySelector('.detailsActions button.primaryText:not(:disabled)'));
            document.querySelector('.detailsActions button.primaryText').click();
            await until(() => !document.querySelector('.fieldEditor.changed') && field('RO').value === 'oops' && document.querySelector('main').getAttribute('aria-busy') !== 'true');
            await set('12345678901');
            await until(() => document.querySelector('.detailsActions button.primaryText:disabled') && document.querySelector('.message.error') && document.querySelector('main').getAttribute('aria-busy') !== 'true');
            if (field('RO').readOnly) throw new Error('Invalid draft cannot be repaired');
            await set('7.85');
            await until(() => document.querySelector('.detailsActions button.primaryText:not(:disabled)'));
            document.querySelector('.detailsActions button.primaryText').click();
            await until(() => !document.querySelector('.fieldEditor.changed') && field('RO').value === '7.85' && document.querySelector('main').getAttribute('aria-busy') !== 'true');
            if (field('E').value !== 'E' || field('E').readOnly) throw new Error('Untouched placeholder lost');
            return { edited: 'RO', value: '7.85', ordinaryTextSaved: true, unsafeDraftRejected: true, titlePreserved: true };
        }).toString() + ')()') : await evaluate(context, '(' + (async (acceptanceLayouts) => {
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            const until = async check => {
                const deadline = performance.now() + 10000;
                while (!check()) { if (performance.now() > deadline) throw new Error('UI did not reach expected state: ' + document.body.innerText.slice(-3000)); await wait(25); }
            };
            const field = document.querySelector('.field span[title=ICURV]').closest('.field').querySelector('input');
            if (!field || field.readOnly) throw new Error('ICURV is not editable');
            field.focus();
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '12');
            field.dispatchEvent(new Event('input', { bubbles: true }));
            await wait(50); field.blur();
            await until(() => document.querySelector('.detailsActions button.primaryText:not(:disabled)'));
            await until(() => document.querySelector('.changePreview'));
            const preview = document.querySelector('.changePreview').innerText;
            if (!preview.includes('ICURV: 0 → 12') || !preview.includes('BESIMF: 0 → 12')) throw new Error('Linked preview missing: ' + preview);
            if (!acceptanceLayouts) {
                document.querySelector('.detailsActions button.primaryText').click();
                await until(() => !document.querySelector('.changePreview') && !document.querySelector('.fieldEditor.changed'));
            }
            return { preview, edited: 'ICURV', value: '12' };
        }).toString() + ')(' + JSON.stringify(acceptanceLayouts) + ')');
        if (semanticHelp) {
            await evaluate(context, `(() => {
                const tab = [...document.querySelectorAll('button')].find(el => /^(卡片条件|Card conditions)/.test(el.innerText.trim()));
                if (!tab) throw Error('Card conditions tab missing');
                tab.click();
            })()`);
            await delay(100);
            result.semanticHelp = await evaluate(context, `(() => {
                const panel = document.querySelector('.manualConditions');
                if (!panel || panel.hidden) throw Error('Card conditions panel not visible');
                panel.querySelectorAll('details').forEach(el => { el.open = true; });
                const items = [...panel.querySelectorAll('.conditionExplanation')].map(el => el.innerText);
                if (!items.length) throw Error('No condition explanations rendered');
                const isZh = ${JSON.stringify((language === 'auto' ? locale : language) === 'zh-cn')};
                if (isZh && (panel.querySelector('.conditionUntranslatedHint') || !panel.querySelector('.conditionOriginalEnglish')))
                    throw Error('Chinese condition translations or original-text controls missing');
                if (!isZh && panel.querySelector('.conditionOriginalEnglish')) throw Error('Chinese condition presentation leaked into English');
                return { items, text: panel.innerText, originals: panel.querySelectorAll('.conditionOriginalEnglish').length };
            })()`);
        }
        if (incomplete || acceptanceLayouts) {
            result.themes = [];
            result.layouts = [];
            for (const theme of ['Default Light Modern', 'Default Dark Modern', 'Default High Contrast', 'Default High Contrast Light']) {
                await writeRequest(root, 'theme-request.json', theme);
                const deadline = Date.now() + 15000;
                while (true) {
                    try { if (JSON.parse(fs.readFileSync(path.join(root, 'theme-applied.json'), 'utf8')) === theme) break; } catch {}
                    if (Date.now() > deadline) throw new Error('Theme update timed out');
                    await delay(50);
                }
                await delay(300);
                const appearance = await evaluate(context, `(() => {
                    const input = ${semanticHelp} ? document.querySelector('.manualConditions summary') :
                        document.querySelector('.field span[title=E]')?.closest('.field').querySelector('input') || document.querySelector('.field input') || document.querySelector('.unresolvedRecords');
                    const before = input.getBoundingClientRect().height;
                    input.focus();
                    return {theme: document.body.dataset.vscodeThemeName, height: before,
                        after: input.getBoundingClientRect().height, background: getComputedStyle(input).backgroundColor,
                        tooltip: !!document.querySelector('[role=tooltip]'),
                        inlineDiagnostics: document.querySelectorAll('.fieldDiagnostic').length};
                })()`);
                if (appearance.height !== appearance.after || appearance.inlineDiagnostics) throw new Error('Hints changed layout');
                result.themes.push(appearance);
                if (pageSession && !acceptanceLayouts) {
                    const shot = await call('Page.captureScreenshot', {format:'png'}, pageSession);
                    writeEvidence(path.join(root, theme.replaceAll(' ', '-') + '.png'), Buffer.from(shot.data, 'base64'));
                }
                if (acceptanceLayouts && pageSession) for (const zoom of [0, 1]) for (const width of [360, 480]) {
                    const request = { zoom, id: `${theme}/${zoom}/${width}` };
                    await writeRequest(root, 'appearance-request.json', request);
                    const deadline = Date.now() + 15000;
                    while (true) {
                        try { if (JSON.parse(fs.readFileSync(path.join(root, 'appearance-applied.json'))).id === request.id) break; } catch {}
                        if (Date.now() > deadline) throw Error('Appearance update timed out');
                        await delay(50);
                    }
                    let viewportWidth = width + 60;
                    for (let attempt = 0; attempt < 16; attempt++) {
                        await call('Emulation.setDeviceMetricsOverride', { width: Math.round(viewportWidth), height: 900,
                            deviceScaleFactor: 1, mobile: false }, pageSession);
                        await delay(150);
                        const actual = await evaluate(context, 'innerWidth');
                        if (actual === width) break;
                        viewportWidth += (width - actual) * Math.pow(1.2, zoom);
                    }
                    const layout = await evaluate(context, `({ width: innerWidth, fontSize: getComputedStyle(document.body).fontSize,
                        text: document.body.innerText, scrollWidth: document.documentElement.scrollWidth,
                        controls: [...document.querySelectorAll('button,input,select')].map(el => ({
                            text: el.innerText, label: el.getAttribute('aria-label'), title: el.title,
                            disabled: el.disabled, readonly: el.readOnly, width: el.getBoundingClientRect().width,
                            color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor })) })`);
                    result.layouts.push({ theme, zoom, requestedWidth: width, ...layout });
                    if (Math.abs(layout.width - width) > 1) throw Error(`Webview width ${layout.width} does not match ${width}`);
                    if (semanticHelp) {
                        await evaluate(context, `document.querySelector('.conditionExplanation').scrollIntoView({ block: 'center', behavior: 'instant' })`);
                        await delay(100);
                    }
                    if ((theme === 'Default Dark Modern' && zoom === 1 && width === 480) ||
                        (theme === 'Default High Contrast Light' && zoom === 0 && width === 360)) {
                        const shot = await call('Page.captureScreenshot', { format: 'png' }, pageSession);
                        writeEvidence(path.join(root, `layout-${theme.replaceAll(' ', '-')}-${zoom}-${width}.png`), Buffer.from(shot.data, 'base64'));
                    }
                }
            }
        }
        result.hostLocale = locale; result.hostLanguage = hostState.hostLanguage; result.pluginLanguage = language;
        result.rendered = await evaluate(context, `({ text: document.body.innerText,
            width: innerWidth, height: innerHeight, fontSize: getComputedStyle(document.body).fontSize,
            controls: [...document.querySelectorAll('button,input,select')].map(el => ({
                text: el.innerText, label: el.getAttribute('aria-label'), title: el.title, disabled: el.disabled,
                readonly: el.readOnly, width: el.getBoundingClientRect().width })) })`);
        if (result.edited === 'ICURV' && acceptanceLayouts) {
            result.afterApply = await evaluate(context, `(async () => {
                document.querySelector('.detailsActions button.primaryText').click();
                const deadline = Date.now() + 15000;
                while (document.querySelector('.changePreview') || document.querySelector('.fieldEditor.changed') ||
                    document.querySelector('main').getAttribute('aria-busy') === 'true') {
                    if (Date.now() > deadline) throw Error('Shared field apply did not complete');
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                return { text: document.body.innerText, previewCleared: true };
            })()`);
        }
        if (editorAcceptance && pageSession) {
            const semanticRows = semanticHelp ? JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../keywords/authoring/manual_semantics_zh.json"), 'utf8')) : [];
            const choiceSource = 'Damage type flag: EQ.-1: Anisotropic damage check (only for shell elements) EQ.0: Standard isotropic damage (default) EQ.1: Standard isotropic damage plus strain localization check (only for shell elements) EQ.10: Enhanced isotropic damage EQ.11: Enhanced isotropic damage plus s…';
            const optionSource = '*OPTION1* | Yes | Specifies contact type';
            const expectedText = source => {
                if ((language === 'auto' ? locale : language) !== 'zh-cn') return source;
                const row = semanticRows.find(item => item.english === source);
                if (!row?.localized) throw Error('Acceptance fixture translation missing: ' + source);
                return row.localized;
            };
            const visibleText = text => text.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
            let workbench;
            for (const candidate of contexts.values()) {
                try { if (await evaluate(candidate, `typeof document !== 'undefined' && !!document.querySelector('.monaco-workbench')`)) { workbench = candidate; break; } } catch {}
            }
            if (!workbench) throw Error('Workbench DOM context missing');
            await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);
            result.editor = [];
            result.sidebars = [];
            for (const theme of ['Default Light Modern', 'Default Dark Modern', 'Default High Contrast', 'Default High Contrast Light']) for (const zoom of [0, 1]) {
                await writeRequest(root, 'theme-request.json', theme);
                const appearance = { zoom, id: `editor/${theme}/${zoom}` };
                await writeRequest(root, 'appearance-request.json', appearance);
                const deadline = Date.now() + 15000;
                while (true) {
                    try { if (JSON.parse(fs.readFileSync(path.join(root, 'theme-applied.json'))) === theme &&
                        JSON.parse(fs.readFileSync(path.join(root, 'appearance-applied.json'))).id === appearance.id) break; } catch {}
                    if (Date.now() > deadline) throw Error('Editor appearance update timed out');
                    await delay(50);
                }
                const prefix = theme.replaceAll(' ', '-') + '-' + zoom;
            for (const action of [...(semanticHelp ? ['keyword-hover'] : []), 'hover', 'completion', 'choices', 'marks', 'include-created', 'include-deleted',
                'prepare-waiting', 'prepare-stale', 'prepare-failure', 'prepare-retry', 'sidebar']) {
                const request = { action, id: `${prefix}/${action}` };
                await writeRequest(root, 'editor-request.json', request);
                const deadline = Date.now() + 15000;
                while (true) {
                    let applied;
                    try { applied = JSON.parse(fs.readFileSync(path.join(root, 'editor-applied.json'))); } catch {}
                    if (applied?.error) throw Error(applied.error);
                    if (applied?.id === request.id) break;
                    if (Date.now() > deadline) throw Error('Editor action timed out: ' + action);
                    await delay(50);
                }
                await delay(1500);
                if (action === 'hover' || action === 'keyword-hover') {
                    const expected = action === 'hover' ? 'FLAG' : 'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE';
                    await evaluate(workbench, `(async () => { const deadline = Date.now() + 8000;
                        while (Date.now() < deadline) {
                            if ([...document.querySelectorAll('.monaco-hover')].some(el =>
                                el.getBoundingClientRect().height && el.innerText.includes(${JSON.stringify(expected)}))) return;
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    })()`);
                }
                const state = await evaluate(workbench, `({ text: document.body.innerText, statusbar: document.querySelector('.part.statusbar')?.innerText,
                    hover: [...document.querySelectorAll('.monaco-hover')].filter(el => el.getBoundingClientRect().height).map(el => el.innerText),
                    suggestions: [...document.querySelectorAll('.suggest-widget')].filter(el => el.getBoundingClientRect().height).map(el => el.innerText),
                    quickPick: [...document.querySelectorAll('.quick-input-widget')].filter(el => el.getBoundingClientRect().height).map(el => el.innerText),
                    editors: [...document.querySelectorAll('.monaco-editor')].map(el => ({ label: el.getAttribute('aria-label'),
                        lines: el.querySelector('.view-lines')?.outerHTML, glyphs: el.querySelector('.margin-view-overlays')?.outerHTML })) })`);
                result.editor.push({ theme, zoom, action, ...state });
                writeEvidence(path.join(root, 'renderer-progress.json'), JSON.stringify(result, null, 2));
                const shot = await call('Page.captureScreenshot', { format: 'png' }, pageSession);
                writeEvidence(path.join(root, 'editor-' + prefix + '-' + action + '.png'), Buffer.from(shot.data, 'base64'));
                if (action === 'hover' && !state.hover.some(text => text.includes('FLAG'))) throw Error('Field Hover was not displayed');
                if (action === 'completion' && !state.suggestions.some(text => text.includes('FLAG'))) throw Error('Field completion was not displayed');
                if (action === 'choices' && !state.quickPick.some(text => text.includes('FLAG'))) throw Error('Field choices were not displayed');
                if (semanticHelp && action === 'choices' && !visibleText(state.quickPick.join(' ')).includes(visibleText(expectedText(choiceSource))))
                    throw Error('Official choice explanation differs from the complete reviewed text');
                if (semanticHelp && action === 'choices') {
                    const detail = await evaluate(workbench, `(() => {
                        const el = document.querySelector('.quick-input-list .monaco-list-row.focused .quick-input-list-label-meta')
                            || document.querySelector('.quick-input-list-label-meta');
                        const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                    })()`);
                    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...detail }, pageSession);
                    const fullHelp = await evaluate(workbench, `(async () => { const deadline = Date.now() + 5000;
                        while (Date.now() < deadline) {
                            const text = [...document.querySelectorAll('.monaco-hover')].filter(el => el.getBoundingClientRect().height).map(el => el.innerText).join(' ');
                            if (text.includes('EQ.-1')) return text;
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        return '';
                    })()`);
                    if (!visibleText(fullHelp).includes(visibleText(expectedText(choiceSource))))
                        throw Error('Truncated QuickPick details cannot be read in full from their native hover');
                    (result.choiceDetailHovers ||= []).push({ theme, zoom, text: fullHelp });
                    const detailShot = await call('Page.captureScreenshot', { format: 'png' }, pageSession);
                    writeEvidence(path.join(root, 'choice-full-help-' + prefix + '.png'), Buffer.from(detailShot.data, 'base64'));
                }
                if (semanticHelp && action === 'keyword-hover') {
                    if (!state.hover.some(text => text.includes('CONTACT_AUTOMATIC_SURFACE_TO_SURFACE')))
                        throw Error('Exact contact keyword Hover was not displayed');
                    if (visibleText(state.hover.join(' ')).includes(visibleText(expectedText(optionSource))))
                        throw Error('Generic CONTACT advice leaked into an exact subtype');
                    result.keywordOptionExplanation = { status: 'unverified',
                        reason: 'Generic *CONTACT is not a schema keyword; exact subtypes do not inherit its manual rules.' };
                }
                if (['prepare-waiting', 'prepare-stale', 'prepare-failure'].includes(action) && state.quickPick.length)
                    throw Error('Unprepared or stale field choices were displayed: ' + action);
                if (action === 'prepare-retry' && !state.quickPick.some(text => text.includes('FLAG'))) throw Error('Field preparation did not recover');
            }
            for (const width of [240, 320]) {
                for (let attempt = 0; attempt < 4; attempt++) {
                    const geometry = await evaluate(workbench, `(() => { const r = document.querySelector('.part.sidebar').getBoundingClientRect();
                        const sash = [...document.querySelectorAll('.monaco-sash.vertical')].map(el => el.getBoundingClientRect())
                            .filter(s => s.height > 100).sort((a,b) => Math.abs(a.x + a.width/2 - r.right) - Math.abs(b.x + b.width/2 - r.right))[0];
                        return { width: r.width, x: sash.x + sash.width/2, y: sash.y + sash.height/2 }; })()`);
                    if (Math.abs(geometry.width - width) < 2) break;
                    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geometry.x, y: geometry.y }, pageSession);
                    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: geometry.x, y: geometry.y, button: 'left', clickCount: 1 }, pageSession);
                    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geometry.x + width - geometry.width, y: geometry.y, button: 'left', buttons: 1 }, pageSession);
                    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geometry.x + width - geometry.width, y: geometry.y, button: 'left', clickCount: 1 }, pageSession);
                    await delay(300);
                }
                const sidebar = await evaluate(workbench, `(() => { const el = document.querySelector('.part.sidebar');
                    return { width: el.getBoundingClientRect().width, text: el.innerText }; })()`);
                result.sidebars.push({ theme, zoom, requestedWidth: width, ...sidebar });
                if (Math.abs(sidebar.width - width) > 2) throw Error(`Sidebar width ${sidebar.width} does not match ${width}`);
                const shot = await call('Page.captureScreenshot', { format: 'png' }, pageSession);
                writeEvidence(path.join(root, 'sidebar-' + prefix + '-' + width + '.png'), Buffer.from(shot.data, 'base64'));
            }
        }
            }
        writeEvidence(path.join(root, 'renderer-result.json'), JSON.stringify(result, null, 2));
        if (repeated && pageSession) {
            const shot = await call('Page.captureScreenshot', {format:'png'}, pageSession);
            writeEvidence(path.join(root, 'repeated-' + language + '.png'), Buffer.from(shot.data, 'base64'));
        }
        writeEvidence(path.join(root, 'gui-finish.json'), JSON.stringify({ fields: repeated ? {} : comments ? comments === 'missing' ? {} : { RO: '7.85' } : incomplete ? { RO: '7.85' } : { ICURV: '12', BESIMF: '12' } }));
        await host;
        if (hostError) throw hostError;
        console.log(JSON.stringify({ passed: true, hostLocale: locale, pluginLanguage: language,
            layouts: result.layouts?.length, editorActions: result.editor?.length, evidence: root }));
    } catch (error) {
        rendererError = error;
        console.error('Manager GUI renderer failed:', error);
        throw error;
    } finally {
        cdp.close();
        try {
            if (!fs.existsSync(path.join(root, 'gui-finish.json')))
                writeEvidence(path.join(root, 'gui-finish.json'), JSON.stringify({ error: 'Renderer validation failed' }));
        } catch (evidenceError) {
            console.error(`GUI failure notification could not be saved: ${root}`, evidenceError);
            if (rendererError) rendererError.evidenceError = evidenceError;
            throw Object.assign(rendererError || evidenceError, { evidenceSaveFailed: true });
        }
        await host;
    }
    } catch (error) {
        if (error.evidenceSaveFailed) {
            retainRuntime();
            console.error(`Required renderer evidence could not be saved; runtime retained: ${root}`);
        }
        throw error;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
