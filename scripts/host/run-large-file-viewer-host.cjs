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
        'window.dialogStyle': 'custom',
        'workbench.view.alwaysShowHeaderActions': true,
        'lsdyna.language': process.env.LARGE_VIEWER_LANGUAGE || 'en',
        'workbench.colorTheme': process.env.LARGE_VIEWER_THEME || 'Default Dark Modern',
    }));
    console.log(`Renderer evidence: ${root}`);
    const crypto = require('node:crypto');
    const file = path.join(root, 'large-model.k');
    let expectedId = '7';
    let rows = Math.ceil(Number(process.env.LARGE_VIEWER_MIB || 200) * 1024 * 1024 / 81);
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
    const host = runTests({ reloadLifecycle: true, vscodeExecutablePath: resolveVSCodeExecutable(),
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

    const attachTargets = async () => {
            const { targetInfos } = await call('Target.getTargets');
            for (const target of targetInfos.filter(t => ['page','iframe'].includes(t.type))) {
                if (attached.has(target.targetId)) continue;
                attached.add(target.targetId);
                try { const { sessionId } = await call('Target.attachToTarget', {targetId:target.targetId,flatten:true});await call('Runtime.enable',{},sessionId); } catch { attached.delete(target.targetId); }
            }
    };

    try {
        let context;
        const until = Date.now() + 120000;
        while (!context && Date.now() < until) {
            if (hostError) throw hostError;
            await attachTargets();
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
                    const overflow=[...main.querySelectorAll('.status,.field-help,.open-native')]
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
            return { staleDetected:true, staleNavigationBlocked:true, reloaded:false };
        }).toString() + ')()');
        // Poll outside Runtime.evaluate so the 30-second CDP call timeout cannot truncate the scan budget.
        const reloadDeadline=Date.now()+120000;
        while (!reload.reloaded && Date.now()<reloadDeadline) {
            const state=await evaluate(context, `({ready:!document.querySelector('.goto button').disabled,warning:document.querySelector('.status.warning')?.textContent,trace:window.reloadTrace})`);
            if(state.warning)throw Error('Reload failed: '+JSON.stringify(state));
            if(state.ready) {reload.reloaded=true;reload.reloadTrace=state.trace;}
            else await delay(100);
        }
        if(!reload.reloaded)throw Error('Reload scan timed out');
        if(await hash()!==changed)throw Error('Reload changed source bytes');
        let nativeNavigation;
        {
            let commandId = 0;
            const command = async (name, args) => {
                const id = ++commandId;
                const requestFile = path.join(root, `editor-command-${id}.json`);
                fs.writeFileSync(requestFile + '.tmp', JSON.stringify({ id, command: name, args }));
                fs.renameSync(requestFile + '.tmp', requestFile);
                const deadline = Date.now() + 60000;
                while (Date.now() < deadline) {
                    const responseFile = path.join(root, `editor-command-result-${id}.json`);
                    if (fs.existsSync(responseFile)) {
                        const response = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
                        if (response.id === id) { if (response.error) throw Error(response.error); return; }
                    }
                    await delay(50);
                }
                throw Error('Editor command timeout: ' + name);
            };
            const target = await evaluate(context, `(() => {
                if(document.querySelector('.record-edit,textarea')) throw Error('Record editor is still exposed');
                const field = document.querySelector('.field');
                const row = field.closest('.line');
                const target = JSON.parse(field.getAttribute('data-vscode-context'));
                field.click();
                return { line:target.line, token:target.token, text:field.textContent, label:document.querySelector('.open-native').title };
            })()`);
            await delay(250);
            await evaluate(context, "document.querySelector('.open-native').click()");
            await command('test.nativeSelection', target);
            let selectionStatus;
            const selectionDeadline = Date.now() + 20000;
            while (Date.now() < selectionDeadline) {
                selectionStatus = await evaluate({ sessionId: pageSession }, `document.querySelector('.statusbar')?.innerText`);
                if (selectionStatus?.includes(String(target.line + 1))) break;
                await delay(100);
            }
            if (!selectionStatus?.includes(String(target.line + 1))) throw Error('Native renderer selection mismatch: '+selectionStatus);
            const nativeShot = await call('Page.captureScreenshot', {format:'png'}, pageSession);
            fs.writeFileSync(path.join(evidenceRoot,'native-editor.png'),Buffer.from(nativeShot.data,'base64'));

            await command('test.reopenViewer', target);
            context = null;
            const readyDeadline = Date.now() + 30000;
            while (!context && Date.now() < readyDeadline) {
                await attachTargets();
                for (const candidate of contexts.values()) {
                    try { if (await evaluate(candidate, "typeof document !== 'undefined' && !!document.querySelector('.goto button:not(:disabled)') && !!document.querySelector('.open-native:not(:disabled)')")) { context = candidate; break; } } catch {}
                }
                if (!context) await delay(100);
            }
            if (!context) throw Error('Viewer did not reopen');
            const dirtyTest = model.bytes < 50 * 1024 * 1024;
            if (dirtyTest) await command('test.dirtyText');
            const nativeMenu = process.env.LSDYNA_CI_FUNCTIONAL_ONLY !== '1';
            const contextTarget = await evaluate(context, `(() => {
                const field = document.querySelector('.field');
                const target = JSON.parse(field.getAttribute('data-vscode-context'));
                const bounds = field.getBoundingClientRect();
                ${nativeMenu ? "field.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:bounds.x+4, clientY:bounds.y+4 }));" : 'field.click();'}
                return { ...target, text:field.textContent };
            })()`);
            if (nativeMenu) {
                let menuContext;
                const menuDeadline = Date.now() + 10000;
                while (!menuContext && Date.now() < menuDeadline) {
                    await attachTargets();
                    for (const candidate of contexts.values()) {
                        try { if (await evaluate(candidate, `typeof document !== 'undefined' && [...document.querySelectorAll('.context-view .action-label')].some(e => /Open in Text Editor|在文本编辑器中打开/.test(e.textContent))`)) { menuContext = candidate; break; } } catch {}
                    }
                    if (!menuContext) await delay(100);
                }
                if (!menuContext) throw Error('Native context menu did not appear');
                await delay(300); // Wait for the native menu's opening animation before measuring its hit target.
                const menuShot = await call('Page.captureScreenshot', {format:'png'}, pageSession);
                fs.writeFileSync(path.join(evidenceRoot,'native-context-menu.png'),Buffer.from(menuShot.data,'base64'));
                const menuPoint = await evaluate(menuContext, `(() => { const r=[...document.querySelectorAll('.context-view .action-label')].find(e => /Open in Text Editor|在文本编辑器中打开/.test(e.textContent)).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
                await call('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...menuPoint}, pageSession);
                await call('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...menuPoint}, pageSession);
            } else {
                // Field selection changes the host revision asynchronously; wait for its rendered acknowledgement.
                await evaluate(context, `(async () => {
                    const selected = () => [...document.querySelectorAll('.field.selected')].some(field =>
                        JSON.parse(field.getAttribute('data-vscode-context')).token === ${JSON.stringify(contextTarget.token)});
                    const deadline = Date.now() + 15000;
                    while (!selected() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
                    if (!selected()) throw Error('Field selection was not acknowledged');
                    document.querySelector('.open-native').click();
                })()`);
            }
            await command('test.nativeSelection', { ...contextTarget, dirty: dirtyTest });
            await command('test.nativeEdit');
            nativeNavigation = { nativeEditUndo:true, toolbar:true, nativeContextMenu:nativeMenu ? true : 'unverified', dirtyNativeTextRetained:dirtyTest ? true : null, target, contextTarget };
            if (await hash() !== changed) throw Error('Native navigation changed source bytes');
            await command('test.recovery');
            let recoveryContext;
            const recoveryDeadline = Date.now() + 20000;
            while (!recoveryContext && Date.now() < recoveryDeadline) {
                await attachTargets();
                for (const candidate of contexts.values()) {
                    try { if (await evaluate(candidate, "typeof document !== 'undefined' && !!document.querySelector('.goto button:not(:disabled)') && !!document.querySelector('.viewport')?.textContent.includes('230000') && /Recovered unsaved changes|已恢复未保存的修改/.test(document.querySelector('.status').textContent)")) { recoveryContext=candidate;break; } } catch {}
                }
                if (!recoveryContext) await delay(100);
            }
            if (!recoveryContext) throw Error('Recovery content did not render');
            // VS Code rejects modal dialogs in extension test mode. The installed lifecycle driver
            // runs outside that mode and verifies the real confirmation; development runs verify the preview.
            if (process.env.LSDYNA_TEST_VSIX) {
                await evaluate(recoveryContext, "document.querySelector('.open-native').click()");
                let recoveryDialog;
                const dialogDeadline = Date.now() + 10000;
                while (!recoveryDialog && Date.now() < dialogDeadline) {
                    recoveryDialog = await evaluate({sessionId:pageSession}, `document.querySelector('.monaco-dialog-box')?.innerText`);
                    if (!recoveryDialog) await delay(100);
                }
                if (!/Save Recovered Copy|另存恢复副本/.test(recoveryDialog || '')) throw Error('Missing recovery confirmation: '+recoveryDialog);
                fs.writeFileSync(path.join(evidenceRoot, 'recovery-dialog.json'), JSON.stringify({text:recoveryDialog}));
                const recoveryShot=await call('Page.captureScreenshot',{format:'png'},pageSession);
                fs.writeFileSync(path.join(evidenceRoot,'recovery-dialog.png'),Buffer.from(recoveryShot.data,'base64'));
                await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},pageSession);
                await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},pageSession);
                await delay(100);
            }
            await command('test.recoveryRetained');
            await command('test.progressiveViewer');
            let progressiveContext;
            const progressiveDeadline = Date.now() + 20000;
            while (!progressiveContext && Date.now() < progressiveDeadline) {
                await attachTargets();
                for (const candidate of contexts.values()) {
                    try { if (await evaluate(candidate, "typeof document !== 'undefined' && !!document.querySelector('.index-progress') && !!document.querySelector('.field')")) { progressiveContext=candidate;break; } } catch {}
                }
                if (!progressiveContext) await delay(100);
            }
            if (!progressiveContext) throw Error('Confirmed early field help did not render');
            const progress = JSON.parse(fs.readFileSync(path.join(root, 'index-paused.json')));
            if (!(progress.scannedBytes > 0 && progress.scannedBytes < progress.size)) throw Error('Invalid actual byte progress');
            const early = await evaluate(progressiveContext, `(() => {
                document.querySelector('.field').click();
                return {status:document.querySelector('.index-progress').textContent, hint:document.querySelector('.index-progress').title,
                    queryable:!!document.querySelector('.field.queryable')};
            })()`);
            if (early.queryable) throw Error('Object queries available before completion');
            await delay(100);
            early.help = await evaluate(progressiveContext, "document.querySelector('.field-help')?.textContent");
            if (!early.help) throw Error('Early help did not open');
            early.layouts = [];
            for (const width of [360,480]) for (const font of [14,20]) {
                await evaluate(progressiveContext, `document.querySelector('main').style.width='${width}px';document.body.style.setProperty('--vscode-font-size','${font}px');document.body.style.setProperty('--vscode-editor-font-size','${font}px')`);
                await delay(75);
                const layout = await evaluate(progressiveContext, `(() => {const bounds=document.querySelector('main').getBoundingClientRect();const progress=document.querySelector('.index-progress');return {locale:document.querySelector('main').lang,width:${width},font:${font},status:progress.textContent,title:progress.title,overflow:progress.getBoundingClientRect().right>bounds.right+1};})()`);
                if(layout.overflow)throw Error('Index progress overflow: '+JSON.stringify(layout));
                early.layouts.push(layout);
                const shot=await call('Page.captureScreenshot',{format:'png'},pageSession);
                fs.writeFileSync(path.join(evidenceRoot,`indexing-${width}-${font}.png`),Buffer.from(shot.data,'base64'));
            }
            early.navigation = await evaluate(progressiveContext, '(' + (async () => {
                const viewport=document.querySelector('.viewport');
                const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
                document.querySelector('.field-heading button')?.click();
                const first=Number(document.querySelector('.line-number').textContent);
                for(let i=0;i<80;i++) {
                    viewport.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true,cancelable:true}));
                    await wait(25);
                }
                await wait(150);
                const paged=Number(document.querySelector('.line-number').textContent);
                viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:200,bubbles:true,cancelable:true}));
                await wait(100);
                const wheeled=Number(document.querySelector('.line-number').textContent);
                for(let i=0;i<3;i++) {viewport.dispatchEvent(new KeyboardEvent('keydown',{key:'PageUp',bubbles:true,cancelable:true}));await wait(50);}
                const back=Number(document.querySelector('.line-number').textContent);
                if(!(paged>first && wheeled>paged && back<wheeled) || !document.querySelector('.index-progress')) throw Error('Navigation blocked during indexing');
                return {first,paged,wheeled,back};
            }).toString() + ')()');
            if (early.navigation.paged <= progress.lines) throw Error('Paging did not cross the indexed frontier');
            fs.writeFileSync(path.join(root,'continue-index'),'continue');
            const completionDeadline=Date.now()+30000;
            while(await evaluate(progressiveContext,"!!document.querySelector('.index-progress')")) {
                if(Date.now()>completionDeadline)throw Error('Progressive index failed to finish');
                await delay(100);
            }
            early.finalLine=await evaluate(progressiveContext,"Number(document.querySelector('.line-number').textContent)");
            if(early.finalLine!==early.navigation.back)throw Error('Index completion moved the viewport');
            fs.writeFileSync(path.join(evidenceRoot,'progressive.json'),JSON.stringify({...progress,...early,controlledPause:true},null,2));
            nativeNavigation.recoveryPreview=true;
            nativeNavigation.recoveryCancel=process.env.LSDYNA_TEST_VSIX ? true : null;
            if (process.env.LARGE_VIEWER_MANUAL === '1') {
                await command('test.manualSidebar');
                let manualContext;
                const end = Date.now() + 15000;
                while (!manualContext && Date.now() < end) {
                    await attachTargets();
                    for (const candidate of contexts.values()) {
                        try { if (await evaluate(candidate, "typeof document !== 'undefined' && !!document.querySelector('#sidebar-search-mode')")) { manualContext = candidate; break; } } catch {}
                    }
                    if (!manualContext) await delay(100);
                }
                if (!manualContext) throw Error('Manual sidebar did not render');
                const manual = [];
                for (const width of [240, 320]) for (const font of [14, 20]) for (const mode of ['keyword', 'fulltext']) {
                    const state = await evaluate(manualContext, `(() => {
                        document.body.style.width='${width}px';document.body.style.fontSize='${font}px';
                        const button=document.querySelector('#sidebar-search-mode');
                        if(button.dataset.mode !== '${mode}') button.click();
                        return {width:${width},font:${font},mode:button.dataset.mode,title:button.title,aria:button.getAttribute('aria-label'),
                            icon:getComputedStyle(button.querySelector('span')).maskImage,
                            hint:document.querySelector('#search-mode-hint').textContent};
                    })()`);
                    if (state.mode !== mode || !state.title || state.title !== state.aria || state.icon === 'none') throw Error('Manual mode state mismatch: '+JSON.stringify(state));
                    manual.push(state);
                    await delay(100);
                    const shot = await call('Page.captureScreenshot', { format: 'png' }, pageSession);
                    fs.writeFileSync(path.join(evidenceRoot, `manual-${width}-${font}-${mode}.png`), Buffer.from(shot.data, 'base64'));
                }
                fs.writeFileSync(path.join(evidenceRoot, 'manual.json'), JSON.stringify(manual, null, 2));
            }
        }
        const evidence={...result,...reload,nativeNavigation,sourceUnchangedByNavigation:true,initialSha256:before,externalEditSha256:changed};
        fs.writeFileSync(path.join(root,'renderer-finished.json'),JSON.stringify(evidence,null,2));
        await host;if(hostError)throw hostError;
        fs.writeFileSync(path.join(evidenceRoot,'result.json'),JSON.stringify(evidence,null,2));
        finalized = true;
        finishTempRun(root);
        console.log(JSON.stringify(evidence));
    } catch (error) {
        const surfaces = [];
        for (const candidate of contexts.values()) {
            try { surfaces.push(await evaluate(candidate, "typeof document !== 'undefined' ? document.body?.innerText : ''")); } catch {}
        }
        fs.writeFileSync(path.join(evidenceRoot, 'failure.json'), JSON.stringify({ error: String(error), surfaces }, null, 2));
        fs.writeFileSync(path.join(root, 'renderer-finished.json'), JSON.stringify({ failed: true }));
        await host;
        if (!hostError && !finalized) { finalized = true; finishTempRun(root); }
        throw error;
    } finally { cdp.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
