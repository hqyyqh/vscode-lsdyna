'use strict';
const { fetchJson, openSocket, createCdp } = require('../../test/support/devtools.cjs');
// Real VS Code Webview timings, through its production transport and extension host.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { runTests } = require("../host/vsix-host.cjs");
const { resolveVSCodeExecutable } = require("../host/run-editor-safety-extension-host.cjs");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const startup = process.argv.includes('--startup');
    const startupBlocks = Number(process.env.KEYWORD_STARTUP_BLOCKS || 10000);
    const { createTempRun, finishTempRun, writeEvidence } = require('../host/temp-runs.cjs');
    const root = createTempRun('dynasense-refresh-webview-');
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
    writeEvidence(path.join(root, 'profile', 'User', 'settings.json'), JSON.stringify({
        'workbench.startupEditor': 'none',
    }));
    console.log(`Renderer evidence: ${root}`);
    let hostError;
    const host = runTests({ vscodeExecutablePath: resolveVSCodeExecutable(),
        extensionDevelopmentPath: path.resolve(__dirname, "../.."),
        extensionTestsPath: path.resolve(__dirname, "../../test/host/keyword-manager/refresh-host.cjs"),
        extensionTestsEnv: { KEYWORD_REFRESH_EVIDENCE: root, KEYWORD_STARTUP_BENCHMARK: startup ? '1' : '',
            KEYWORD_STARTUP_BLOCKS: String(startupBlocks) },
        launchArgs: [root, '--new-window', '--disable-extensions', '--disable-gpu', '--disable-workspace-trust',
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
    const contexts = new Map(), attached = new Set();
    const cdp = createCdp(socket);
    const call = cdp.call;
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
    const results = [];
    try {
        if (startup) writeEvidence(path.join(root, 'renderer-attached'), '1');
        for (const blocks of startup ? [startupBlocks] : [1000, 10000]) {
            let context;
            const until = Date.now() + 90000;
            while (!context && Date.now() < until) {
                if (hostError) throw hostError;
                const { targetInfos } = await call('Target.getTargets');
                for (const target of targetInfos.filter(t => ['page', 'iframe'].includes(t.type))) {
                    if (attached.has(target.targetId)) continue;
                    attached.add(target.targetId);
                    try {
                        const { sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
                        await call('Runtime.enable', {}, sessionId);
                        if (!startup && target.type === 'page') await call('Page.bringToFront', {}, sessionId);
                    } catch { attached.delete(target.targetId); }
                }
                for (const candidate of contexts.values()) {
                    try {
                        if (await evaluate(candidate, `typeof document !== 'undefined' && document.querySelector('.fieldEditor input')?.value === '${blocks}' && document.querySelector('main')?.getAttribute('aria-busy') === 'false'`)) { context = candidate; break; }
                    } catch { /* A disposed iframe is not the current manager. */ }
                }
                if (!context) await delay(100);
            }
            if (!context) throw new Error(`Manager iframe not found for ${blocks}`);
            if (startup) {
                if (!await evaluate(context, `document.querySelector('main')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('.fieldEditor input, .fieldEditor select').length >= 5`))
                    throw Error('Fields found but manager is not usable');
                writeEvidence(path.join(root, 'startup-visible'), '1');
            }
            // Warm interaction samples start after both packages finish directory preparation.
            const directoryDeadline = Date.now() + 90000;
            while (!await evaluate(context, `!!document.querySelector('.instanceTrigger') && !document.querySelector('.instanceTrigger').disabled && /\\/\\d+$/.test(document.querySelector('.instanceTrigger').textContent.trim())`)) {
                if (Date.now() > directoryDeadline) throw Error('Directory did not complete');
                await delay(10);
            }
            const label = await evaluate(context, `document.querySelector('.instanceTrigger').textContent`);
            if (!label.trim().endsWith('/' + blocks)) throw Error(`Unexpected complete directory: ${label}`);
            if (startup) {
                writeEvidence(path.join(root, 'startup-directory'), '1');
                await delay(30);
                writeEvidence(path.join(root, `${blocks}.done`), '1');
                continue;
            }
            const samples = [];
            for (let cycle = 0; cycle < 2; cycle++) {
                const batch = await evaluate(context, `(async () => {
                const samples = [];
                const fields = () => [...document.querySelectorAll('.fieldEditor input, .fieldEditor select')];
                const before = fields().map(input => ({ id: input.closest('.field').dataset.fieldId,
                    name: input.closest('.field').querySelector('span[title]').textContent,
                    value: input.value, readonly: input.readOnly, disabled: input.disabled }));
                if (before.length < 5) throw new Error('Expected five native fields');
                const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
                const main = document.querySelector('main');
                const refresh = [...document.querySelectorAll('.headerActions button')].find(button => /^(Reload this instance|重新读取当前实例)$/.test(button.title));
                if (!refresh || refresh.disabled || main.getAttribute('aria-busy') !== 'false')
                    throw new Error('Current-instance Refresh is not ready');
                const directory = document.querySelector('.instanceTrigger').textContent;
                await new Promise((resolve, reject) => {
                    let sawBusy = false;
                    let response;
                    const controls = fields();
                    const locked = new Set(controls.filter(input => input.readOnly || input.disabled));
                    const onResponse = event => {
                        const result = event.data?.result;
                        if (result?.state && typeof result.accepted === 'boolean') response = result;
                        if (response && !response.accepted) { cleanup(); reject(new Error('Current-instance Refresh was rejected')); }
                    };
                    const timer = setTimeout(() => { cleanup(); reject(new Error('Current-instance Refresh timed out')); }, 5000);
                    const observer = new MutationObserver(records => {
                        sawBusy ||= main.getAttribute('aria-busy') === 'true' || records.some(record =>
                            record.target === main && record.attributeName === 'aria-busy' && record.oldValue === 'true');
                        for (const input of controls) {
                            if (input.readOnly || input.disabled || records.some(record => record.target === input &&
                                ['readonly', 'disabled'].includes(record.attributeName) && record.oldValue !== null)) locked.add(input);
                        }
                        const help = document.querySelector('.fieldHelp');
                        const instance = document.querySelector('.instanceTrigger');
                        if (!sawBusy || !response?.accepted || main.getAttribute('aria-busy') !== 'false' || refresh.disabled || !help ||
                            /Loading|正在加载/.test(help.textContent) || !instance || instance.disabled ||
                            !/\\/\\d+$/.test(instance.textContent.trim())) return;
                        cleanup();
                        const after = fields().map(input => ({ id: input.closest('.field').dataset.fieldId,
                            name: input.closest('.field').querySelector('span[title]').textContent,
                            value: input.value, readonly: input.readOnly, disabled: input.disabled }));
                        if (!Number.isFinite(response.state.revision) || response.state.hasDrafts ||
                            ['stale', 'error', 'applying'].includes(response.state.status) ||
                            locked.size !== controls.length || JSON.stringify(after) !== JSON.stringify(before) ||
                            instance.textContent !== directory) {
                            reject(new Error('Refresh lost fields, changed editability or failed to protect busy fields')); return;
                        }
                        requestAnimationFrame(() => resolve());
                    });
                    const cleanup = () => { clearTimeout(timer); observer.disconnect(); window.removeEventListener('message', onResponse); };
                    window.addEventListener('message', onResponse);
                    observer.observe(main, { attributes: true, attributeOldValue: true, childList: true, subtree: true, characterData: true });
                    refresh.click();
                });
                const inputs = fields();
                // Measure idle-host field help after the current-instance Refresh response.
                await wait(100);
                for (let index = 1; index < 5; index++) {
                    const input = inputs[index];
                    const name = input.closest('.field').querySelector('span[title]').textContent;
                    const start = performance.now();
                    await new Promise((resolve, reject) => {
                        const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Help timed out')); }, 5000);
                        const check = () => {
                            const panel = document.querySelector('.fieldHelp');
                            if (panel.querySelector('.fieldHelpName')?.textContent.split('（')[0] === name &&
                                !/Loading|正在加载/.test(panel.textContent) && panel.querySelector('.fieldHelpText:not(.loading)')?.textContent.trim()) {
                                clearTimeout(timer); observer.disconnect();
                                requestAnimationFrame(() => resolve());
                            }
                        };
                        const observer = new MutationObserver(check);
                        observer.observe(document.querySelector('main'), { childList: true, subtree: true, characterData: true });
                        input.focus(); check();
                    });
                    samples.push(performance.now() - start);
                }
                return samples;
                })()`);
                samples.push(...batch);
            }
            samples.sort((a, b) => a - b);
            const measurement = { samples: samples.length, maxMs: samples.at(-1) };
            results.push({ blocks, measuredAction: 'field-focus-to-help', preparationAction: 'refresh-current-instance', ...measurement });
            writeEvidence(path.join(root, `${blocks}.done`), 'done');
        }
        await host;
        if (hostError) throw hostError;
        if (startup) {
            const samples = JSON.parse(fs.readFileSync(path.join(root, 'startup-results.json')));
            console.log(JSON.stringify({ startup: samples, evidence: root }));
            return;
        }
        writeEvidence(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
        console.log(JSON.stringify(results, null, 2));
        if (results.some(result => result.samples !== 8 || result.maxMs > 100)) {
            throw new Error('Keyword Manager field-help spot check exceeds the 100 ms release budget');
        }
    } finally { cdp.close(); }
    } catch (error) {
        if (error.evidenceSaveFailed) {
            retainRuntime();
            console.error(`Required renderer evidence could not be saved; runtime retained: ${root}`);
        }
        throw error;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
