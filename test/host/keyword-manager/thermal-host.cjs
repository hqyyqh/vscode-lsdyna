'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vscode=require('vscode');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const crypto=require('node:crypto');
const base=process.env.CONTACT_THERMAL_BASE||'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE';
const orthotropic=base.endsWith('ORTHO_FRICTION');
const deck='*'+base+'\n11,22\n0,0\n1,1\n'+(orthotropic?'0\n0\n0\n0\n':'')+'*END';
exports.run=async()=>{
    const root=process.env.CONTACT_THERMAL_EVIDENCE;
    const extension=vscode.extensions.getExtension('hqyyqh.dynasense');
    await extension.activate();
    const identity={hostVersion:vscode.version,hostLanguage:vscode.env.language,platform:process.platform,
        extensionId:extension.id,extensionVersion:extension.packageJSON.version,extensionPath:fs.realpathSync(extension.extensionPath),
        hashes:Object.fromEntries(['out/extension.js','out/core/keywordSchema.js','keywords/runtime/engineering/contactThermal.json','keywords/provenance/current-data.json']
            .map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(path.join(extension.extensionPath,file))).digest('hex')]))};
    const entry=Object.keys(require.cache).find(p=>p.toLowerCase()===path.join(extension.extensionPath,'out/extension.js').toLowerCase());
    const api=require.cache[entry].exports._internals;
    const providerEntry=Object.keys(require.cache).find(p=>p.toLowerCase()===path.join(extension.extensionPath,'out/client/KeywordOptionsWebviewProvider.js').toLowerCase());
    const Provider=require.cache[providerEntry].exports.KeywordOptionsWebviewProvider;
    const mutate=Provider.prototype.mutate;
    Provider.prototype.mutate=async function(...args) {
        const result=await mutate.apply(this,args);
        fs.appendFileSync(path.join(root,'gui-mutations.jsonl'),JSON.stringify({accepted:result.accepted,reason:result.reason,
            keyword:result.state?.currentKeyword,status:result.state?.status,applying:args[2]||false})+'\n');
        return result;
    };
    const results=[];
    for(const value of ['Thermal','T_Friction']) {
        const file=path.join(root,'workspace',value+'.k');fs.writeFileSync(file,deck);
        let document=await vscode.workspace.openTextDocument(file),editor=await vscode.window.showTextDocument(document);
        let model=api.buildKeywordOptionViewModel(editor,0,{});
        const control=model.controls.find(c=>c.choices.some(v=>v.value==='Thermal'));
        model=api.buildKeywordOptionViewModel(editor,0,{draftControlState:{[control.controlId]:value}});
        assert.equal(api.buildKeywordOptionsViewState(model).canApply,true,model.plan.reason);
        assert.ok(await api.applyKeywordOptionViewModel({getModel:()=>model,markStale(){}},editor));
        await document.save();const after=document.getText();
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        document=await vscode.workspace.openTextDocument(file);editor=await vscode.window.showTextDocument(document);
        model=api.buildKeywordOptionViewModel(editor,0,{});
        assert.equal(model.readonly,false,model.inputFormSourceError);
        assert.equal(model.plan.status,'no-change',model.plan.reason);
        const k=model.managerCards.flatMap(c=>c.fields).find(f=>f.name==='K');
        const help=api.keywordManagerHelpState({...model,selectedFieldId:k.fieldId});
        assert.ok(help.english&&help.localized);
        const hover=await vscode.commands.executeCommand('vscode.executeHoverProvider',document.uri,new vscode.Position(k.line,k.position+1));
        assert.ok(hover.length);
        model=api.buildKeywordOptionViewModel(editor,0,api.keywordManagerEditField(model,k.fieldId,'1.25'));
        assert.ok(await api.applyKeywordOptionViewModel({getModel:()=>model,markStale(){}},editor));
        await document.save();await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        document=await vscode.workspace.openTextDocument(file);editor=await vscode.window.showTextDocument(document);
        model=api.buildKeywordOptionViewModel(editor,0,{});
        assert.equal(model.managerCards.flatMap(c=>c.fields).find(f=>f.name==='K').value,'1.25');
        if(value==='T_Friction') {
            const formula=model.managerCards.flatMap(c=>c.fields).find(f=>f.name==='FORMULA');
            model=api.buildKeywordOptionViewModel(editor,0,api.keywordManagerEditField(model,formula.fieldId,'-9'));
            assert.ok(await api.applyKeywordOptionViewModel({getModel:()=>model,markStale(){}},editor));
            await document.save();
            model=api.buildKeywordOptionViewModel(editor,0,{});
            assert.equal(model.managerCards.filter(c=>c.fields[0]?.name==='UC1').length,2);
            const overview=await vscode.commands.executeCommand('vscode.executeHoverProvider',document.uri,new vscode.Position(0,4));
            const text=overview.flatMap(h=>h.contents.map(c=>typeof c==='string'?c:c.value)).join('\n');
            assert.equal((text.match(/`UC1`/g)||[]).length,2,text);
        }
        fs.writeFileSync(path.join(root,value+'-saved.k'),document.getText());
        results.push({value,apply:true,reopen:true,fieldEdit:true,hover:true,bilingualHelp:true,keyword:model.currentKeyword,createdText:after});
    }
    const file=path.join(root,'workspace','thermal-ui.k');fs.writeFileSync(file,deck);
    let document=await vscode.workspace.openTextDocument(file),editor=await vscode.window.showTextDocument(document);
    editor.selection=new vscode.Selection(0,0,0,0);
    await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');
    await vscode.commands.executeCommand('notifications.clearAll');
    fs.writeFileSync(path.join(root,'gui-ready.json'),JSON.stringify({hostLanguage:vscode.env.language,identity,results}));
    const deadline=Date.now()+180000;
    let appearanceId,caseId;
    while(!fs.existsSync(path.join(root,'gui-done.json'))) {
        if(Date.now()>deadline)throw Error('Thermal UI runner timed out');
        let request;try{request=JSON.parse(fs.readFileSync(path.join(root,'appearance-request.json')));}catch{}
        if(request&&request.id!==appearanceId) {
            await vscode.workspace.getConfiguration('workbench').update('colorTheme',request.theme,vscode.ConfigurationTarget.Global);
            await vscode.workspace.getConfiguration('window').update('zoomLevel',request.zoom,vscode.ConfigurationTarget.Global);
            appearanceId=request.id;
            fs.writeFileSync(path.join(root,'appearance-applied.json'),JSON.stringify(request));
        }
        let scenario;try{scenario=JSON.parse(fs.readFileSync(path.join(root,'case-request.json')));}catch{}
        if(scenario&&scenario.id!==caseId) {
            if(scenario.restore) {
                editor=await vscode.window.showTextDocument(document);
            } else {
                const caseFile=path.join(root,'workspace','case-'+scenario.id+'.k');
                fs.writeFileSync(caseFile,scenario.deck);
                editor=await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(caseFile));
            }
            editor.selection=new vscode.Selection(0,0,0,0);
            await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');
            caseId=scenario.id;
            fs.writeFileSync(path.join(root,'case-applied.json'),JSON.stringify({id:caseId}));
        }
        await delay(100);
    }
    await document.save();
    fs.writeFileSync(path.join(root,'gui-saved.k'),document.getText());
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    document=await vscode.workspace.openTextDocument(file);editor=await vscode.window.showTextDocument(document);
    const model=api.buildKeywordOptionViewModel(editor,0,{});
    assert.equal(model.readonly,false);
    assert.equal(model.managerCards.flatMap(c=>c.fields).find(f=>f.name==='K').value,'1.25');
    assert.equal(model.managerCards.flatMap(c=>c.fields).find(f=>f.name==='FORMULA').value,'-9');
    assert.equal(model.managerCards.filter(c=>c.fields[0]?.name==='UC1').length,2);
    fs.writeFileSync(path.join(root,'host-results.json'),JSON.stringify({identity,results,guiApplySaveReopen:true,parameterCards:2},null,2));
};
