'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');
const { connectWorkbenchDevTools, waitForRendererEditorFocus, dispatchRendererKey,
    getRendererEditorPositionPoint, dispatchRendererMouseClick } = require('./editor-safety/extension-host');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, why) {
    for (let n = 0; n < 100; n++) { const value = await read(); if (value) return value; await delay(100); }
    throw Error('Timed out: '+why);
}
exports.run = async () => {
    const dir = process.env.LSDYNA_VIM_RESULT, scenario = process.env.LSDYNA_VIM_CASE, split = scenario==='split-host';
    const vimEnabled = scenario.endsWith('first') || split;
    const root = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath,scenario), c = await connectWorkbenchDevTools();
    const vim = vscode.extensions.getExtension('vscodevim.vim'), dyna = vscode.extensions.getExtension('hqyyqh.dynasense');
    const record = (action,data) => fs.appendFileSync(path.join(dir,'steps.jsonl'),JSON.stringify({action,...data})+'\n');
    let editor;
    const evaluate = async expression => (await c.call('Runtime.evaluate',{expression,returnByValue:true})).result.value;
    const snap = async name => fs.writeFileSync(path.join(dir,name+'.png'),Buffer.from((await c.call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    async function open(name) {
        editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path.join(root,name)), {preview:false});
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(c); await delay(350);
    }
    async function click(row,col) {
        await dispatchRendererMouseClick(c,await getRendererEditorPositionPoint(c,row+1,col));
        await delay(160); assert.equal(editor.selection.active.line,row); assert.equal(editor.selection.active.character,col);
    }
    const text = () => editor.document.getText();
    async function key(k) {
        if (k === '@' || k === 'R') {
            const n=k==='@'?50:82, params = {key:k,code:k==='@'?'Digit2':'KeyR',windowsVirtualKeyCode:n,nativeVirtualKeyCode:n,modifiers:8};
            await c.call('Input.dispatchKeyEvent',{type:'keyDown',...params,text:k,unmodifiedText:k});
            await c.call('Input.dispatchKeyEvent',{type:'keyUp',...params});
        } else {
            const special = { Esc:['Escape','Escape',27],Tab:['Tab','Tab',9],BS:['Backspace','Backspace',8],
                redo:['r','KeyR',82,2],'.':['.','Period',190] };
            const args = special[k] || [k, /\d/.test(k)?'Digit'+k:'Key'+k.toUpperCase(),k.toUpperCase().charCodeAt(0)];
            await dispatchRendererKey(c,...args);
        }
        await delay(130);
        const s = editor.selection; record(k,{file:path.basename(editor.document.fileName), text:text(), from:s.start, to:s.end});
    }
    const press = async (...keys) => { for(const k of keys) await key(k); };
    const expect = (name,expected) => { assert.equal(text(),expected,name); record(name,{pass:true}); };
    const inserted = (original,row,digits) => {
        const lines = original.split('\r\n'); lines[row]=lines[row].slice(0,23)+digits+lines[row].slice(23); return lines.join('\r\n');
    };
    const fixed = (original,value) => {
        const lines = original.split('\r\n'); lines[2]=lines[2].slice(0,8)+value.padStart(16)+lines[2].slice(24); return lines.join('\r\n');
    };
    try {
        assert.equal(!!vim,vimEnabled && !split, 'Vim in this extension host');
        if (vim) assert.equal(vim.packageJSON.version,'1.32.4');
        const option = vscode.workspace.getConfiguration('vim').inspect('useSystemClipboard');
        record('registry',{vim:vim?.packageJSON.version??null, vimClipboard:option,vscode:vscode.version});
        assert.equal(typeof option?.defaultValue==='boolean',vimEnabled,'Vim setting contribution in this window');
        if (scenario==='vim-first') { await vim.activate(); await open('plain.txt'); }
        await open('first.k'); await dyna.activate(); if (vim) await vim.activate();
        if (split) await until(()=>evaluate("document.querySelector('.part.statusbar')?.innerText.includes('-- NORMAL --')"),'Vim activated in the other host');
        if (vimEnabled) {
            await open('plain.txt'); const plain=text();
            await key('Esc'); await click(0,2); await key('h');
            expect('plain Normal h',plain); assert.equal(editor.selection.active.character,1);
        }
        await open('repeat.k'); const source=text();
        if (vimEnabled) {
            await key('Esc'); await click(2,23); await key('h');
            expect('deck Normal h',source); assert.equal(editor.selection.active.character,22);
            await click(2,23); await press('i','1','9','Esc');
            const edited=inserted(source,2,'19'); expect('unmodified Vim Insert semantics',edited);
            await key('u'); expect('one Vim undo',source); await key('redo'); expect('one Vim redo',edited);
            await click(3,23); await key('.'); expect('dot on different field',inserted(edited,3,'19'));
            await snap('vim-repeat');
            await open('macro.k'); const macroOriginal=text(); await key('Esc'); await click(2,23);
            await press('q','a','i','1','9','Esc','q'); const macroSource=inserted(macroOriginal,2,'19');
            expect('macro source',macroSource); await click(3,23); await press('@','a');
            expect('macro replay on different field',inserted(macroSource,3,'19'));
            await open('modes.k'); const initial=text(), row=editor.document.lineAt(2).text;
            const replacing=(count,value)=>initial.replace(row,row.slice(0,23)+value+row.slice(23+count));
            await key('Esc');
            for (const [keys,expected] of [[['x'],replacing(1,'')],[['v','l','d'],replacing(2,'')],
                [['R','9','Esc'],replacing(1,'9')],[['c','w','9','Esc'],replacing(1,'9')]]) {
                await click(2,23); await press(...keys); expect('Vim '+keys.join(' '),expected);
                await key('u'); expect('undo '+keys.join(' '),initial);
            }
            await open('tab.k'); const original=text(); await key('Esc'); await click(2,23); await press('i','Tab');
            assert.ok(editor.selection.isEmpty && text() !== original,'Insert Tab belongs to Vim, not a DynaSense field selection');
            const afterTab=text(); await press('1','BS','Esc'); expect('Insert Backspace removes just the typed digit',afterTab);
        } else {
            await click(2,23); await press('1','9'); expect('direct protected input',fixed(source,'192'));
            await open('tab.k'); const original=text(); await click(2,23); await key('Tab');
            assert.deepEqual([editor.selection.start.line,editor.selection.start.character,editor.selection.end.character],[2,9,24]);
            await press('1','9'); expect('Tab overwrites without shifting columns',fixed(original,'19')); await snap('field-overwrite');
        }
        await open('providers.k');
        const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',
            editor.document.uri, new vscode.Position(1,3));
        assert.ok(completions.items.some(item => String(item.label?.label || item.label).includes('NODE')), 'LS-DYNA keyword completions');
        await until(()=>vscode.languages.getDiagnostics(editor.document.uri).some(d=>d.code==='unknown-keyword'), 'unknown keyword diagnostic');
        const color=await until(()=>evaluate(`(() => {
            const token=[...document.querySelectorAll('.view-line span[class*="mtk"]')].find(s=>s.textContent.includes('*KEYWORD'));
            return token && {keyword:getComputedStyle(token).color, ordinary:getComputedStyle(token.closest('.view-lines')).color};
        })()`),'highlighted keyword');
        assert.notEqual(color.keyword,color.ordinary,'keyword has a distinct syntax color');
        record('language services',{pass:true,color}); await snap('language-services');
        if (scenario==='absent' || scenario==='dyna-first') {
            const lang = process.env.LSDYNA_VIM_LOCALE;
            assert.equal(vscode.env.language,lang);
            const copy = require(path.join(dyna.extensionPath,'package.nls'+(lang==='en'?'':'.zh-cn')+'.json'));
            for (const plugin of ['auto','zh-cn','en']) {
                await vscode.workspace.getConfiguration('lsdyna').update('language',plugin,vscode.ConfigurationTarget.Workspace);
                await open('providers.k');
                const menu=vscode.commands.executeCommand('extension.lsdynaStatusDashboard');
                const chinese=(plugin==='auto' ? lang : plugin)==='zh-cn';
                const readMenu=()=>evaluate("document.querySelector('.quick-input-widget')?.innerText || ''");
                try {
                    const menuText=await until(async ()=>{const content=await readMenu();
                        return content.includes(chinese?'字段说明':'Field Help') && content;},'DynaSense quick actions');
                    assert.equal(menuText.includes(chinese?'字段跳转':'Tab field navigation'), !vimEnabled);
                    record('visible quick actions',{lang,plugin,menuText});
                    if (plugin==='auto') await snap('quick-actions');
                } finally { await vscode.commands.executeCommand('workbench.action.closeQuickOpen'); await menu; }
                for (const setting of ['enableCellEditProtect','enableTabNavigation','autoFormat','clearAutoIndentOnEnter']) {
                    await vscode.commands.executeCommand('workbench.action.openSettings','@id:lsdyna.'+setting);
                    const description=copy['config.'+setting+'.description'];
                    await until(()=>evaluate('document.body.innerText.includes('+JSON.stringify(description)+')'),'Settings: '+description);
                    record('visible Settings text',{lang,plugin,setting,description});
                    if (plugin==='auto') await snap('settings-'+setting);
                }
            }
            await vscode.commands.executeCommand('workbench.action.closeSidebar');
            await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
            await vscode.commands.executeCommand('workbench.action.openSettings','@id:lsdyna.enableCellEditProtect');
            for (const [theme,tag] of [['Default Dark Modern','dark'],['Default Light Modern','light'],['Default High Contrast','contrast']]) {
                await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme,vscode.ConfigurationTarget.Global);
                for (const width of [360,480]) for (const zoom of [0,1]) {
                    await vscode.workspace.getConfiguration('window').update('zoomLevel',zoom,vscode.ConfigurationTarget.Global);
                    await c.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
                    const desc=copy['config.enableCellEditProtect.description'];
                    await until(()=>evaluate('document.body.innerText.includes('+JSON.stringify(desc)+')'),'field protection text at '+width);
                    const tree=await c.call('Accessibility.getFullAXTree');
                    assert.ok(tree.nodes.some(n=>[n.name?.value,n.description?.value].some(v=>typeof v==='string' && v.includes(desc))),
                        'Full field-protection description in native accessibility tree');
                    record('accessible field protection',{lang,theme,width,zoom});
                    await snap('field-protection-'+tag+'-'+width+'-'+zoom);
                }
            }
            await c.call('Emulation.clearDeviceMetricsOverride');
            await vscode.workspace.getConfiguration('window').update('zoomLevel',0,vscode.ConfigurationTarget.Global);
        }
    } catch (error) {
        record('failure',{error:String(error.stack || error),visible:await evaluate('document.body.innerText.slice(-12000)')});
        await snap('failure');
        throw error;
    } finally { c.close(); }
};
