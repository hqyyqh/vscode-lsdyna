'use strict';
// Readonly window navigation, field query, search and reload in a real VS Code host.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { runTests } = require('./vsix-host.cjs');
const { resolveVSCodeExecutable } = require('./run-editor-safety-extension-host.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-large-viewer-'));
    const port = await new Promise(resolve => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
    });
    fs.mkdirSync(path.join(root, 'profile', 'User'), { recursive: true });
    fs.writeFileSync(path.join(root, 'profile', 'User', 'settings.json'), JSON.stringify({
        'workbench.startupEditor': 'none',
    }));
    console.log(`Renderer evidence: ${root}`);
    const crypto = require('node:crypto');
    const file = path.join(root, 'large-model.k');
    const rows = Math.ceil(200 * 1024 * 1024 / 81);
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, '*KEYWORD\n*NODE\n');
    for (let start = 1; start <= rows; start += 4096) {
        let chunk = '';
        for (let id = start; id <= Math.min(rows, start + 4095); id++) chunk += String(id).padStart(8) + '0'.padStart(16).repeat(3) + ' '.repeat(24) + '\n';
        fs.writeSync(fd, chunk);
    }
    const material = ['7', '7.8e-9', '210000', '0.3'].map(v => v.padStart(10)).join('').padEnd(80);
    fs.writeSync(fd, '*MAT_ELASTIC\n' + material + '\n$ B07_TARGET_MARKER\n*END\n'); fs.closeSync(fd);
    const hash = () => new Promise((resolve,reject) => { const h=crypto.createHash('sha256');fs.createReadStream(file).on('data',b=>h.update(b)).on('end',()=>resolve(h.digest('hex'))).on('error',reject); });
    const before = await hash();
    fs.writeFileSync(path.join(root, 'model.json'), JSON.stringify({ rows, bytes: fs.statSync(file).size, sha256: before }));
    let hostError;
    const host = runTests({ vscodeExecutablePath: resolveVSCodeExecutable(),
        extensionDevelopmentPath: path.resolve(__dirname, '..'),
        extensionTestsPath: path.resolve(__dirname, '../test/editor-safety/large-file-viewer-host.cjs'),
        extensionTestsEnv: { LARGE_VIEWER_EVIDENCE: root },
        launchArgs: [root, '--new-window', '--disable-extensions', '--disable-gpu', '--disable-workspace-trust',
            '--skip-welcome', '--skip-release-notes', `--user-data-dir=${path.join(root, 'profile')}`,
            `--extensions-dir=${path.join(root, 'extensions')}`, '--remote-debugging-address=127.0.0.1',
            `--remote-debugging-port=${port}`],
    }).catch(error => { hostError = error; });
    let socket;
    const deadline = Date.now() + 120000;
    while (!socket && Date.now() < deadline) {
        if (hostError) throw hostError;
        try {
            const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
            socket = new WebSocket(info.webSocketDebuggerUrl);
            await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        } catch { socket = null; await delay(100); }
    }
    if (!socket) throw new Error('No DevTools endpoint');
    const pending = new Map(), contexts = new Map(), attached = new Set();
    let id = 0;
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const requestId = ++id;
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
        pending.set(requestId, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: requestId, method, params, sessionId }));
    });
    socket.onmessage = event => {
        const message = JSON.parse(String(event.data));
        if (message.method === 'Runtime.executionContextCreated') {
            const context = message.params.context;
            contexts.set(`${message.sessionId}:${context.id}`, { contextId: context.id, sessionId: message.sessionId });
        }
        if (message.method === 'Runtime.executionContextDestroyed') contexts.delete(`${message.sessionId}:${message.params.executionContextId}`);
        if (message.method === 'Runtime.executionContextsCleared') {
            for (const [key, value] of contexts) if (value.sessionId === message.sessionId) contexts.delete(key);
        }
        const entry = pending.get(message.id);
        if (entry) {
            clearTimeout(entry.timer); pending.delete(message.id);
            if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
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
        const result = await evaluate(context, '(' + (async rows => {
            const wait=ms=>new Promise(r=>setTimeout(r,ms));
            const until=async check=>{const deadline=performance.now()+15000;while(!check()){if(performance.now()>deadline)throw Error('Viewer state timeout: '+document.querySelector('.status').innerText);await wait(25);}};
            const set=(selector,value)=>{const input=document.querySelector(selector);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};
            if(document.querySelector('.viewport input,.viewport [contenteditable=true]'))throw Error('Data viewport exposes text editing');
            set('.goto input',String(rows));await wait(50);document.querySelector('.goto').requestSubmit();
            await until(()=>[...document.querySelectorAll('.line-number')].some(n=>n.textContent===String(rows)));
            const field=document.querySelector('.viewport .field.queryable');
            if(!field)throw Error('No queryable field in the small material block after the deep NODE location');
            field.click();await until(()=>document.querySelector('.field-help strong'));
            const fieldName=document.querySelector('.field-help strong').textContent;
            const value=document.querySelector('.field-help code').textContent;
            document.querySelector('.field-heading button').click();
            set('.search input','B07_TARGET_MARKER');await wait(50);document.querySelector('.search').requestSubmit();
            await until(()=>document.querySelector('.status').innerText.includes('1 / 1'));
            await until(()=>document.querySelector('.viewport').innerText.includes('B07_TARGET_MARKER'));
            return { deepLine: rows, fieldName, value, queryInvoked: true, literalSearch: true, readonlyViewport: true };
        }).toString() + ')(' + rows + ')');
        if(await hash()!==before)throw Error('Viewer changed source bytes');
        fs.appendFileSync(file, '$ controlled external edit\n');
        const changed = await hash();
        const reload = await evaluate(context, '(' + (async () => {
            const wait=ms=>new Promise(r=>setTimeout(r,ms));
            const until=async check=>{const deadline=performance.now()+20000;while(!check()){if(performance.now()>deadline)throw Error('Stale/reload timeout');await wait(25);}};
            await until(()=>document.querySelector('.status.warning button'));
            if(!document.querySelector('.goto button').disabled)throw Error('Stale viewer permits navigation');
            document.querySelector('.status.warning button').click();
            await until(()=>!document.querySelector('.status.warning')&&!document.querySelector('.goto button').disabled);
            return { staleDetected:true, staleNavigationBlocked:true, reloaded:true };
        }).toString() + ')()');
        if(await hash()!==changed)throw Error('Reload changed source bytes');
        const evidence={...result,...reload,sourceUnchanged:true,initialSha256:before,externalEditSha256:changed};
        fs.writeFileSync(path.join(root,'renderer-finished.json'),JSON.stringify(evidence,null,2));
        await host;if(hostError)throw hostError;
        console.log(JSON.stringify(evidence));
    } finally { socket.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
