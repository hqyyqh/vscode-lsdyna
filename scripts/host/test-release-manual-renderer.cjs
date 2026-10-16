'use strict';
const { fetchJson, openSocket, createCdp } = require('../../test/support/devtools.cjs');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
    assert.ok(process.env.LSDYNA_TEST_VSIX, 'An installed VSIX is required');
    const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
        const value = server.address().port; server.close(() => resolve(value)); }); });
    let root, exited = false, exitCode, log = '', socket;
    const child = spawn(process.execPath, [path.join(__dirname, 'run-release-host.cjs'), 'smoke'], {
        env: { ...process.env, LSDYNA_RELEASE_CDP_PORT: String(port), LSDYNA_RELEASE_MANUAL_FIXTURE: '1' }, windowsHide: true });
    const completed = new Promise(resolve => child.once('close', code => { exited = true; exitCode = code; resolve(code); }));
    child.stdout.on('data', data => { log += data.toString(); process.stdout.write(data);
        root ||= /Release host evidence: (.+)\r?\n/.exec(log)?.[1].trim(); });
    child.stderr.on('data', data => { log += data.toString(); process.stderr.write(data); });
    const deadline = Date.now() + 120000;
    while (!socket && Date.now() < deadline && !exited) {
        try {
            const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, Math.min(3000, deadline - Date.now()));
            socket = await openSocket(version.webSocketDebuggerUrl, Math.min(3000, deadline - Date.now()));
        } catch { socket = undefined; await delay(100); }
    }
    assert.ok(socket, `Renderer endpoint missing; host exit ${exitCode}`);
    const contexts = new Map(), attached = new Set();
    const cdp = createCdp(socket, 10000), call = cdp.call;
    socket.onmessage = event => {
        let m;
        try { m = JSON.parse(String(event.data)); } catch { return; }
        if (m.method === 'Runtime.executionContextCreated') contexts.set(`${m.sessionId}:${m.params.context.id}`, { sessionId: m.sessionId, contextId: m.params.context.id });
        if (m.method === 'Runtime.executionContextDestroyed') contexts.delete(`${m.sessionId}:${m.params.executionContextId}`);
    };
    const evaluate = async (context, expression) => {
        const result = await call('Runtime.evaluate', { expression, contextId: context.contextId, awaitPromise: true, returnByValue: true }, context.sessionId);
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    try {
        let context;
        while (!context && Date.now() < deadline && !exited) {
            const { targetInfos } = await call('Target.getTargets');
            for (const target of targetInfos.filter(t => ['page', 'iframe'].includes(t.type))) if (!attached.has(target.targetId)) {
                attached.add(target.targetId);
                try { const { sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true }); await call('Runtime.enable', {}, sessionId); }
                catch { attached.delete(target.targetId); }
            }
            for (const candidate of contexts.values()) {
                try { if (await evaluate(candidate, `typeof document!=='undefined' && !!document.querySelector('.katex') && document.body.textContent.includes('release-formula')`)) { context = candidate; break; } }
                catch { /* Other or disposed webviews are not the reader under test. */ }
            }
            if (!context) await delay(100);
        }
        assert.ok(context, 'Manual content or equations did not render');
        const expectedLanguage = (process.env.LSDYNA_RELEASE_PLUGIN_LANGUAGE && process.env.LSDYNA_RELEASE_PLUGIN_LANGUAGE !== 'auto'
            ? process.env.LSDYNA_RELEASE_PLUGIN_LANGUAGE : process.env.LSDYNA_RELEASE_LOCALE || 'en').startsWith('zh') ? 'zh' : 'en';
        for (const [setting, locale] of [[expectedLanguage === 'en' ? 'zh-cn' : 'en', expectedLanguage === 'en' ? 'zh' : 'en'],
            [process.env.LSDYNA_RELEASE_PLUGIN_LANGUAGE || 'auto', expectedLanguage]]) {
            const file = path.join(root, 'manual-language-request.json');
            fs.writeFileSync(file + '.tmp', JSON.stringify(setting)); fs.renameSync(file + '.tmp', file);
            await evaluate(context, `(async()=>{
                const before=document.querySelector('.reader-content').textContent,end=Date.now()+10000;
                while(document.documentElement.lang!==${JSON.stringify(locale)}) {
                    if(Date.now()>end)throw Error('UI language did not refresh');await new Promise(r=>setTimeout(r,50));
                }
                if(document.querySelector('.reader-language select').value!==${JSON.stringify(expectedLanguage)} || document.querySelector('.reader-content').textContent!==before)
                    throw Error('UI locale update changed the open document');
            })()`);
        }
        const languageEvidence = await evaluate(context, `(async()=>{
            const select=document.querySelector('.reader-language select');
            if(!select || select.value!==${JSON.stringify(expectedLanguage)}) throw Error('Wrong default reading language: '+select?.value);
            const initial=select.value, other=initial==='en'?'zh':'en';
            const hasText=language=>document.querySelector('.reader-content').textContent.includes(language==='zh'?'离线图片与公式。':'Offline image and equation.');
            if(!hasText(initial)) throw Error('Wrong initial document text');
            const image=document.querySelector('.reader-content img');
            if(!image?.src.includes('/documents/'+initial+'/')) throw Error('Wrong document language path');
            const change=async language=>{
                Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,language);
                select.dispatchEvent(new Event('change',{bubbles:true}));
                const end=Date.now()+10000;
                while(select.disabled || select.value!==language || !hasText(language) || !document.querySelector('.reader-content img')?.src.includes('/documents/'+language+'/')) {
                    if(Date.now()>end)throw Error('Reading language did not change');await new Promise(r=>setTimeout(r,50));
                }
            };
            await change(other);await change(initial);
            return {initial,toggle:true,documentPaths:true,liveLocalePreservesDocument:true};
        })()`);
        await evaluate(context, '(async () => { await document.fonts.ready; return true; })()');
        const { targetInfos: pages } = await call('Target.getTargets');
        const page = pages.find(target => target.type === 'page' && /workbench/.test(target.url));
        assert.ok(page, 'Workbench screenshot target missing');
        const { sessionId: pageSession } = await call('Target.attachToTarget', { targetId: page.targetId, flatten: true });
        const screenshot = await call('Page.captureScreenshot', { format: 'png' }, pageSession);
        fs.writeFileSync(path.join(root, `manual-${process.env.LSDYNA_RELEASE_LOCALE || 'en'}.png`), Buffer.from(screenshot.data, 'base64'));
        const evidence = await evaluate(context, `(async()=>{
            await document.fonts.ready;
            const faces = [...document.fonts].filter(f=>f.family.includes('KaTeX'));
            if(!faces.length) throw Error('No KaTeX font faces');
            await Promise.all(faces.map(f=>f.load().catch(()=>{throw Error('Font failed: '+f.family+' '+f.style+' '+f.weight)})));
            const images=[...document.querySelectorAll('img')];
            await Promise.all(images.map(i=>i.complete?Promise.resolve():new Promise((resolve,reject)=>{i.onload=resolve;i.onerror=reject})));
            if(!images.length||images.some(i=>!i.naturalWidth)) throw Error('Manual image failed');
            if(document.querySelector('.katex-error')) throw Error('Equation failed');
            const next=[...document.querySelectorAll('button')].find(b=>/^(Next section|下一节)$/.test(b.title||b.getAttribute('aria-label')||''));
            if(!next) throw Error('Next-section control missing'); next.click();
            const until=performance.now()+10000;
            while(!document.body.textContent.includes('release-next')){if(performance.now()>until)throw Error('Section navigation failed');await new Promise(r=>setTimeout(r,20))}
            return {status:'passed',fontFaces:faces.length,images:images.length,equations:true,navigation:true};
        })()`);
        evidence.language = languageEvidence;
        assert.ok(root); fs.writeFileSync(path.join(root, 'manual-renderer.json'), JSON.stringify(evidence));
        assert.equal(await completed, 0, 'Installed manual host failed');
        assert.ok(!/Could not register service worker|document is in an invalid state/i.test(log));
        console.log(JSON.stringify(evidence));
    } finally {
        cdp.close();
        if (!exited) child.kill(); // Only the child created by this test, never user windows.
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
