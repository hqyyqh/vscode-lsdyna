'use strict';
const { fetchJson, openSocket, createCdp } = require('../../test/support/devtools.cjs');
// Readonly window navigation, field query, search and reload in a real VS Code host.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { runTests } = require('./vsix-host.cjs');
const { resolveVSCodeExecutable } = require('./run-editor-safety-extension-host.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const { createTempRun, finishTempRun, createEvidenceDirectory } = require('./temp-runs.cjs');
    const evidenceRoot = createEvidenceDirectory('large-viewer-navigation');
    console.log(`Durable evidence: ${evidenceRoot}`);
    const root = createTempRun('dynasense-large-viewer-');
    const port = await new Promise(resolve => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
    });
    fs.mkdirSync(path.join(root, 'profile', 'User'), { recursive: true });
    if (process.env.LARGE_VIEWER_HOST_LANGUAGE === 'zh-cn' && process.env.LSDYNA_LANGUAGE_EXTENSIONS)
        require('./language-pack.cjs').copyChineseLanguagePack(root, process.env.LSDYNA_LANGUAGE_EXTENSIONS,
            process.env.LSDYNA_LANGUAGE_PACK_CACHE);
    fs.writeFileSync(path.join(root, 'profile', 'User', 'settings.json'), JSON.stringify({
        'workbench.startupEditor': 'none',
        'lsdyna.language': process.env.LARGE_VIEWER_LANGUAGE || 'en',
        'workbench.colorTheme': process.env.LARGE_VIEWER_THEME || 'Default Dark Modern',
    }));
    console.log(`Renderer evidence: ${root}`);
    const crypto = require('node:crypto');
    const file = path.join(root, 'large-model.k');
    let expectedId = '7';
    let rows = Math.ceil(200 * 1024 * 1024 / 81);
    if (!process.env.LARGE_VIEWER_MODEL) {
        const fd = fs.openSync(file, 'w');
        fs.writeSync(fd, '*KEYWORD\n*NODE\n');
        for (let start = 1; start <= rows; start += 4096) {
            let chunk = '';
            for (let id = start; id <= Math.min(rows, start + 4095); id++) chunk += String(id).padStart(8) + '0'.padStart(16).repeat(3) + ' '.repeat(24) + '\n';
            fs.writeSync(fd, chunk);
        }
        const material = ['7', '7.8e-9', '210000', '0.3'].map(v => v.padStart(10)).join('').padEnd(80);
        fs.writeSync(fd, '*MAT_ELASTIC\n' + material + '\n$ B07_TARGET_MARKER\n*END\n'); fs.closeSync(fd);
    }
    if (process.env.LARGE_VIEWER_MODEL) {
        fs.copyFileSync(process.env.LARGE_VIEWER_MODEL, file);
        const prefix = Buffer.alloc(1024 * 1024);
        const input = fs.openSync(file, 'r');
        let bytes;
        try { bytes = fs.readSync(input, prefix, 0, prefix.length, 0); } finally { fs.closeSync(input); }
        const lines = prefix.subarray(0, bytes).toString('utf8').split(/\r?\n/);
        let target = lines.findIndex(line => line.trim() === '*MAT_ELASTIC') + 1;
        if (!target) throw Error('Fixture requires MAT_ELASTIC in its first MiB');
        while (lines[target]?.trimStart().startsWith('$')) target++;
        expectedId = lines[target].slice(0, 10).trim();
        rows = target - 3;
        fs.appendFileSync(file, '\n$ B07_TARGET_MARKER\n');
    }

    const hash = () => new Promise((resolve,reject) => { const h=crypto.createHash('sha256');fs.createReadStream(file).on('data',b=>h.update(b)).on('end',()=>resolve(h.digest('hex'))).on('error',reject); });
    const before = await hash();
    const model = { rows, bytes: fs.statSync(file).size, sha256: before, source: process.env.LARGE_VIEWER_MODEL || 'synthetic NODE + MAT_ELASTIC' };
    fs.writeFileSync(path.join(root, 'model.json'), JSON.stringify(model));
    fs.writeFileSync(path.join(evidenceRoot, 'model.json'), JSON.stringify(model));
    let hostError;
    let finalized = false;
    const host = runTests({ vscodeExecutablePath: resolveVSCodeExecutable(),
        extensionDevelopmentPath: path.resolve(__dirname, "../.."),
        extensionTestsPath: path.resolve(__dirname, "../../test/host/editor-safety/large-file-viewer-host.cjs"),
        extensionTestsEnv: { LARGE_VIEWER_EVIDENCE: root },
        launchArgs: [root, `--locale=${process.env.LARGE_VIEWER_HOST_LANGUAGE || 'en'}`, '--new-window', '--disable-extensions', '--disable-gpu', '--disable-workspace-trust',
            '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(root, 'profile')}`,
            `--extensions-dir=${path.join(root, 'extensions')}`, '--remote-debugging-address=127.0.0.1',
            `--remote-debugging-port=${port}`],
    }).catch(error => { hostError = error; if (error.signal || error.runtimeMayBeActive || error.evidenceSaveFailed) finishTempRun(root, { retain: true }); });
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

    try {
        let context;
        const until = Date.now() + 120000;
        while (!context && Date.now() < until) {
            if (hostError) throw hostError;
            const { targetInfos } = await call('Target.getTargets');
            for (const target of targetInfos.filter(t => ['page','iframe'].includes(t.type))) {
                if (attached.has(target.targetId)) continue;
                attached.add(target.targetId);
                try { const { sessionId } = await call('Target.attachToTarget', {targetId:target.targetId,flatten:true});await call('Runtime.enable',{},sessionId); } catch { attached.delete(target.targetId); }
            }
            for (const candidate of contexts.values()) {
                try { if(await evaluate(candidate, "typeof document !== 'undefined' && !!document.querySelector('.goto button:not(:disabled)') && !!document.querySelector('.viewport')")){ context=candidate;break; } } catch {}
            }
            if(!context) await delay(100);
        }
        if(!context) throw Error('Readonly viewer did not become ready');
        const hostIdentity = JSON.parse(fs.readFileSync(path.join(root, 'host.json')));
        fs.writeFileSync(path.join(evidenceRoot, 'host.json'), JSON.stringify(hostIdentity));
        if (hostIdentity.language !== (process.env.LARGE_VIEWER_HOST_LANGUAGE || 'en'))
            throw Error('Host locale did not activate: ' + hostIdentity.language);
        const result = await evaluate(context, '(' + (async ({ rows, expectedId }) => {
            const wait=ms=>new Promise(r=>setTimeout(r,ms));
            const until=async check=>{const deadline=performance.now()+15000;while(!check()){if(performance.now()>deadline)throw Error('Viewer state timeout: '+document.querySelector('.status').innerText);await wait(25);}};
            const set=(selector,value)=>{const input=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
            if(document.querySelector('.viewport input,.viewport [contenteditable=true]'))throw Error('Data viewport exposes text editing');
            const target = document.querySelector('.navigation-field');
            if (!target || target.textContent.trim() !== expectedId) throw Error('Missing exact navigation target');
            const field=document.querySelector('.viewport .field.queryable');
            if(!field)throw Error('No queryable field in the small material block after the deep NODE location');
            field.click();await until(()=>document.querySelector('.field-help strong'));
            const fieldName=document.querySelector('.field-help strong').textContent;
            const value=document.querySelector('.field-help code')?.textContent || document.querySelector('.field-object strong')?.textContent;
            document.querySelector('.field-heading button').click();
            document.querySelector('.search-mode').click();await wait(50);
            set('.search-float input','B07_TARGET_MARKER');await wait(50);document.querySelector('.search-float').requestSubmit();
            await until(()=>document.querySelector('.search-count')?.textContent.includes('1 / 1'));
            await until(()=>document.querySelector('.viewport').innerText.includes('B07_TARGET_MARKER'));
            set('.goto input','1000');await wait(50);document.querySelector('.goto').requestSubmit();
            await until(()=>document.querySelector('.line-number')?.textContent === '1000');
            const frames = [];
            for(let i=0;i<24;i++) {
                const start=performance.now();
                document.querySelector('.viewport').dispatchEvent(new WheelEvent('wheel',{deltaY:20,bubbles:true,cancelable:true}));
                await new Promise(resolve=>requestAnimationFrame(resolve));
                frames.push(performance.now()-start);
            }
            const finalLine=Number(document.querySelector('.line-number').textContent);
            if(finalLine <= 1000) throw Error('Buffered wheel did not move immediately');
            set('.goto input',String(rows));await wait(50);document.querySelector('.goto').requestSubmit();
            await until(()=>document.querySelector('.navigation-line .line-number')?.textContent === String(rows));
            return { frames, finalLine, exactTarget:true, deepLine: rows, fieldName, value, queryInvoked: true, literalSearch: true, readonlyViewport: true };
        }).toString() + ')(' + JSON.stringify({ rows, expectedId }) + ')');
        const { targetInfos: pages } = await call('Target.getTargets');
        const page = pages.find(target => target.type === 'page');
        if (!page) throw Error('Missing screenshot surface');
        const { sessionId: pageSession } = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
        const screenshot = await call('Page.captureScreenshot', { format: 'png' }, pageSession);
        fs.writeFileSync(path.join(evidenceRoot, 'viewer.png'), Buffer.from(screenshot.data, 'base64'));
        const layouts = [];
        for (const width of [360, 480]) for (const font of [14, 20]) {
            const layout = await evaluate(context, `(() => {
                const main=document.querySelector('main');main.style.width='${width}px';
                document.body.style.setProperty('--vscode-editor-font-size','${font}px');
                document.body.style.setProperty('--vscode-font-size','${font}px');
                document.body.style.setProperty('--vscode-editor-line-height','${Math.round(font*1.5)}px');
                return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
                    const bounds=main.getBoundingClientRect();
                    const overflow=[...main.querySelectorAll('.status,.field-help')]
                        .filter(node=>node.getBoundingClientRect().right > bounds.right + 1).map(node=>node.textContent);
                    resolve({width:${width},font:${font},locale:main.lang,theme:document.body.className,overflow,help:document.querySelector('.field-help')?.innerText || document.querySelector('.viewport').title,
                        keywordColor:getComputedStyle(document.querySelector('.keyword-line .line-text')).color,
                        numberColor:getComputedStyle(document.querySelector('.syntax-number')).color,
                        commentColor:getComputedStyle(document.querySelector('.comment-line .line-text')).color});
                })));
            })()`);
            if (layout.overflow.length) throw Error('Narrow viewer overflow: '+JSON.stringify(layout));
            layouts.push(layout);
            const shot=await call('Page.captureScreenshot',{format:'png'},pageSession);
            fs.writeFileSync(path.join(evidenceRoot, `viewer-${width}-${font}.png`),Buffer.from(shot.data,'base64'));
        }
        fs.writeFileSync(path.join(evidenceRoot,'layouts.json'),JSON.stringify(layouts,null,2));
        if(await hash()!==before)throw Error('Viewer changed source bytes');
        await evaluate(context, `(() => {
            window.reloadTrace = [];
            window.addEventListener('message', event => {
                const message = event.data;
                if (message?.method === 'largeFile/stateChanged') {
                    const { revision, stale, indexing, indexingMessage, fileSize } = message.params;
                    window.reloadTrace.push({ at: performance.now(), revision, stale, indexing, indexingMessage, fileSize });
                }
            });
        })()`);
        fs.appendFileSync(file, '$ controlled external edit\n');
        const changed = await hash();
        const reload = await evaluate(context, '(' + (async () => {
            const wait=ms=>new Promise(r=>setTimeout(r,ms));
            const until=async (check,budget=20000)=>{const deadline=performance.now()+budget;while(!check()){if(performance.now()>deadline)throw Error('Stale/reload timeout: '+JSON.stringify({status:document.querySelector('.status')?.innerText,warning:!!document.querySelector('.status.warning'),navigationDisabled:document.querySelector('.goto button')?.disabled,trace:window.reloadTrace}));await wait(25);}};
            await until(()=>document.querySelector('.status.warning button'));
            if(!document.querySelector('.goto button').disabled)throw Error('Stale viewer permits navigation');
            document.querySelector('.status.warning button').click();
            await until(()=>!document.querySelector('.status.warning'));
            // Reload scans the same 200 MiB fixture as initial opening: use its execution budget.
            await until(()=>{
                if(document.querySelector('.status.warning'))throw Error('Reload became stale or failed: '+JSON.stringify(window.reloadTrace));
                return !document.querySelector('.goto button').disabled;
            },120000);
            return { staleDetected:true, staleNavigationBlocked:true, reloaded:true, reloadTrace:window.reloadTrace };
        }).toString() + ')()');
        if(await hash()!==changed)throw Error('Reload changed source bytes');
        const evidence={...result,...reload,sourceUnchanged:true,initialSha256:before,externalEditSha256:changed};
        fs.writeFileSync(path.join(root,'renderer-finished.json'),JSON.stringify(evidence,null,2));
        await host;if(hostError)throw hostError;
        fs.writeFileSync(path.join(evidenceRoot,'result.json'),JSON.stringify(evidence,null,2));
        finalized = true;
        finishTempRun(root);
        console.log(JSON.stringify(evidence));
    } catch (error) {
        fs.writeFileSync(path.join(evidenceRoot, 'failure.json'), JSON.stringify({ error: String(error) }));
        fs.writeFileSync(path.join(root, 'renderer-finished.json'), JSON.stringify({ failed: true }));
        await host;
        if (!hostError && !finalized) { finalized = true; finishTempRun(root); }
        throw error;
    } finally { cdp.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
