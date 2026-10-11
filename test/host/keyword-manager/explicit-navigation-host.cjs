'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vscode=require('vscode');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
exports.checkExplicitNavigation=async(root,api,results)=>{
 const prototypes=[...new Set(Object.values(require.cache).filter(m=>/[/\\](?:lspp|catalog)InputFormCatalogV4\.js$/i.test(m.filename)).map(m=>m.exports.CatalogInputFormCatalogV4?.prototype).filter(Boolean))];
 // Manager callers prepare source headers; background field choices prepare bare schema names.
 let preparations=0;const originals=prototypes.map(p=>p.prepareKeyword);
 prototypes.forEach((p,i)=>{p.prepareKeyword=function(...a){if(typeof a[0]==='string' && a[0].startsWith('*')) preparations++;return originals[i].apply(this,a)}});
 try{
 const file=path.join(root,'workspace','explicit.k');
 const original='*KEYWORD\n*DATABASE_BINARY_BLSTFOR\n10,1,1,1,1\n*DATABASE_BINARY_BLSTFOR\n20,1,1,1,1\n*END\n';fs.writeFileSync(file,original);
 const doc=await vscode.workspace.openTextDocument(file);let editor=await vscode.window.showTextDocument(doc);editor.selection=new vscode.Selection(1,0,1,0);
 const model=await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');assert.ok(model);await delay(250);
 editor=await vscode.window.showTextDocument(doc);const before=preparations;assert.ok(before>0,'explicit open must prepare a manager source header');
 editor.selection=new vscode.Selection(3,0,3,4);await delay(150);assert.equal(preparations,before,'moving the cursor must not prepare a model');assert.equal(model.keywordLine,1);
 const other=await vscode.workspace.openTextDocument({language:'lsdyna',content:'*MAT_ELASTIC\n'});await vscode.window.showTextDocument(other);await delay(100);assert.equal(preparations,before,'switching editor must not follow');
 editor=await vscode.window.showTextDocument(doc);editor.selection=new vscode.Selection(1,0,1,0);
 for(const text of ['*M','*MA','*MAT_','*MAT_E']) {await editor.edit(b=>b.replace(doc.lineAt(1).range,text));await delay(30)}
 assert.equal(preparations,before,'incomplete keyword typing must not rebuild models or directories');assert.equal(model.stale,true);assert.equal(api.buildKeywordOptionsViewState(model).status,'stale');
 assert.equal(await vscode.commands.executeCommand('extension.keywordOptions.apply'),false,'stale writes must be rejected');
 // Reopen explicitly at another valid instance, then verify tracked movement and manual reload.
 editor.selection=new vscode.Selection(3,0,3,0);const next=await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');assert.equal(next.keywordLine,3);assert.ok(preparations>before,'explicitly opening another instance must prepare its model');await delay(200);
 editor=await vscode.window.showTextDocument(doc);
 await editor.edit(b=>b.insert(new vscode.Position(0,0),'$ inserted\n'));
 assert.equal(next.stale,true);assert.equal(next.liveKeywordLine,4);
 const refreshed=await vscode.commands.executeCommand('extension.keywordOptions.refresh');assert.ok(refreshed);assert.equal(refreshed.keywordLine,4);assert.equal(refreshed.stale,false);assert.equal(refreshed.managerCards[0].fields[0].value,'20');
 results.push({mode:'explicit-navigation',passed:true,checks:['cursor-no-follow','editor-no-follow','incomplete-keyword-no-rebuild','stale-write-blocked','explicit-open','shifted-line-refresh']});
 }finally{prototypes.forEach((p,i)=>p.prepareKeyword=originals[i]);}
};
