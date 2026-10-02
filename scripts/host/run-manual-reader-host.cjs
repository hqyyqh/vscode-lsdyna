'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
 if(!process.env.LSDYNA_RELEASE_MANUAL_PACK)throw Error('Set LSDYNA_RELEASE_MANUAL_PACK to the real manual pack');
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 let root,hostError,stdout='';
 const child=spawn(process.execPath,[path.join(__dirname,'run-release-host.cjs'),'smoke'],{env:{...process.env,LSDYNA_RELEASE_CDP_PORT:String(port)},windowsHide:true});
 child.stdout.on('data',bytes=>{process.stdout.write(bytes);stdout+=bytes;root=stdout.match(/Release host evidence: ([^\r\n]+)/)?.[1];});
 child.stderr.on('data',bytes=>process.stderr.write(bytes));
 const host=new Promise(resolve=>{child.on('error',error=>{hostError=error;resolve();});child.on('close',code=>{if(code)hostError=Error('Release host exited '+code);resolve();});});
 let socket;const deadline=Date.now()+120000;
 while(!socket&&Date.now()<deadline){
  if(hostError)throw hostError;
  try{const info=await(await fetch('http://127.0.0.1:'+port+'/json/version')).json();socket=new WebSocket(info.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});}
  catch{socket=null;await delay(100);}
 }
 if(!socket)throw Error('No DevTools endpoint');
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
                } catch { attached.delete(target.targetId); }
            }
            for (const candidate of contexts.values()) {
                try {
                    if (await evaluate(candidate, "typeof document !== 'undefined' && !!document.querySelector('.reader-content:not(.reader-loading)') && !document.querySelector('.reader-error') && document.querySelector('.reader-content').innerText.length > 200")) { context = candidate; break; }
                } catch {}
            }
            if (!context) await delay(100);
        }

  if(!context)throw Error('Manual content did not render');
  const result=await evaluate(context,`({status:'passed',title:document.title,textLength:document.querySelector('.reader-content').innerText.length,headings:[...document.querySelectorAll('.reader-content h1,.reader-content h2')].map(e=>e.innerText).slice(0,12),linkCount:document.querySelectorAll('.reader-content a').length,errors:[...document.querySelectorAll('.reader-error')].map(e=>e.innerText)})`);
  if(result.errors.length||result.textLength<=200)throw Error(JSON.stringify(result));
  result.interactions = await evaluate(context, `(async () => {
    const checks = [];
    const waitFor = async predicate => {
      const end = Date.now() + 10000;
      while (!predicate()) { if (Date.now() > end) throw Error('Reader interaction did not complete'); await new Promise(r => setTimeout(r, 50)); }
    };
    const settings = document.querySelector('.reader-settings');
    if (!settings) throw Error('Missing reading settings');
    settings.querySelector('summary').click();
    if (!settings.open) throw Error('Reading settings did not open');
    const controls = settings.querySelectorAll('button');
    const before = document.documentElement.style.getPropertyValue('--reader-font-scale');
    controls[2].click();
    await waitFor(() => document.documentElement.style.getPropertyValue('--reader-font-scale') !== before);
    controls[1].click();
    await waitFor(() => document.documentElement.style.getPropertyValue('--reader-font-scale') === '1');
    settings.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
    if (settings.open) throw Error('Escape did not close settings');
    checks.push('font-scale-and-settings');
    document.querySelector('.reader-toolbar__button--search').click();
    await waitFor(() => document.querySelector('.reader-search-popover input'));
    const input = document.querySelector('.reader-search-popover input');
    if (document.activeElement !== input) throw Error('Search did not receive focus');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'MAT_BARLAT_YLD2000');
    input.dispatchEvent(new Event('input',{bubbles:true}));
    await waitFor(() => [...document.querySelectorAll('.reader-search-results button')].some(b => b.textContent.includes('BARLAT')));
    const hit = [...document.querySelectorAll('.reader-search-results button')].find(b => b.textContent.includes('BARLAT'));
    if (!hit.querySelector('.reader-search-location')?.textContent) throw Error('Missing result volume');
    hit.click();
    await waitFor(() => !document.querySelector('.reader-search-popover') && document.querySelector('.markdown-body')?.textContent.includes('*MAT_BARLAT_YLD2000'));
    checks.push('search-volume-and-navigate');
    const language = document.querySelector('.reader-toolbar__button--lang');
    if (language) {
      const previous = document.querySelector('.markdown-body').textContent;
      language.click();
      await waitFor(() => document.querySelector('.markdown-body').textContent !== previous && !document.querySelector('.reader-pending'));
      checks.push('language-toggle');
    }
    if (document.querySelector('.reader-error,.katex-error')) throw Error('Reader reported a rendering error');
    return checks;
  })()`);
  fs.writeFileSync(path.join(root,'manual-renderer.json'),JSON.stringify(result,null,2));
  await host;if(hostError)throw hostError;console.log(JSON.stringify(result));
 } finally {socket.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
