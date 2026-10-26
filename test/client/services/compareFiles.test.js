const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {vscodeMock:v}=require('../../support/helpers');
const {compareFiles}=require('../../../src/client/services/compareFiles');
describe('compareFiles',()=>{
 const makeTempDirectory=require('../../support/tempDirectories').trackTempDirectories();
 let workspaceSaved,folderPickSaved,dialogs,folderPicks;
 let root,a,b,calls,picks,warnings,saved;
 beforeEach(()=>{
  root=makeTempDirectory(path.join(os.tmpdir(),'compare-files-'));a=v.Uri.file(path.join(root,'a.k'));b=v.Uri.file(path.join(root,'b.k'));
  a.scheme=b.scheme='file';
  fs.writeFileSync(a.fsPath,'*NODE\n1,0,0,0');fs.writeFileSync(b.fsPath,'*NODE\n2,0,0,0');
  saved={TabInputText:v.TabInputText,groups:v.window.tabGroups,pick:v.window.showQuickPick,open:v.window.showOpenDialog,warn:v.window.showWarningMessage,execute:v.commands.executeCommand};
  workspaceSaved={...v.workspace};folderPickSaved=v.window.showWorkspaceFolderPick;dialogs=[];folderPicks=[];
  v.workspace.workspaceFolders=undefined;v.workspace.getWorkspaceFolder=()=>undefined;
  v.window.showWorkspaceFolderPick=async options=>{folderPicks.push(options);return v.workspace.workspaceFolders[0];};
  v.window.showOpenDialog=async options=>{dialogs.push(options);return undefined;};
  v.TabInputText=class{constructor(uri){this.uri=uri;}};const tabs=[a,b].map(uri=>({input:new v.TabInputText(uri),isDirty:uri===b}));
  v.window.tabGroups={activeTabGroup:{activeTab:tabs[0]},all:[{tabs}]};calls=[];picks=[];warnings=[];
  v.commands.executeCommand=async(...x)=>calls.push(x);v.window.showWarningMessage=async x=>warnings.push(x);
  v.window.showQuickPick=async(items,opts)=>{picks.push({items,opts});return items[0];};
 });
 afterEach(()=>{v.TabInputText=saved.TabInputText;v.window.tabGroups=saved.groups;v.window.showQuickPick=saved.pick;v.window.showOpenDialog=saved.open;v.window.showWarningMessage=saved.warn;v.commands.executeCommand=saved.execute;
  for(const key of ['workspaceFolders','getWorkspaceFolder']){if(Object.hasOwn(workspaceSaved,key))v.workspace[key]=workspaceSaved[key];else delete v.workspace[key];}
  if(folderPickSaved===undefined)delete v.window.showWorkspaceFolderPick;else v.window.showWorkspaceFolderPick=folderPickSaved;
 });
 it('keeps the captured right file when tabs change and shows dirty full-path candidates',async()=>{
  v.window.showQuickPick=async(items,opts)=>{picks.push({items,opts});v.window.tabGroups.activeTabGroup.activeTab=v.window.tabGroups.all[0].tabs[1];return items[0];};
  await compareFiles();assert.deepEqual(calls[0],['vscode.diff',b,a]);assert.equal(picks[0].items[0].description,b.fsPath);assert(picks[0].items[0].detail);assert.equal(picks[0].items.length,2);
 });
 it('cancels without opening a comparison',async()=>{v.window.showQuickPick=async()=>undefined;await compareFiles();assert.equal(calls.length,0);});
 it('browses disk and refuses the same file',async()=>{v.window.showQuickPick=async items=>items.at(-1);v.window.showOpenDialog=async()=>[a];await compareFiles();assert.equal(calls.length,0);assert.equal(warnings.length,1);});
 it('selects left then right without a current text tab',async()=>{v.window.tabGroups.activeTabGroup.activeTab={};await compareFiles();assert.deepEqual(calls[0],['vscode.diff',a,b]);assert.equal(picks.length,2);});
 it('reports a removed candidate without launching diff',async()=>{fs.unlinkSync(b.fsPath);await compareFiles();assert.equal(calls.length,0);assert.equal(warnings.length,1);});
 it('cancels a disk dialog without opening or saving',async()=>{v.window.showQuickPick=async items=>items.at(-1);v.window.showOpenDialog=async()=>undefined;await compareFiles();assert.equal(calls.length,0);assert.equal(warnings.length,0);});
 it('cancels the second selection without opening diff',async()=>{v.window.tabGroups.activeTabGroup.activeTab={};let n=0;v.window.showQuickPick=async items=>++n===1?items[0]:undefined;await compareFiles();assert.equal(calls.length,0);});
 it('uses an explicit context file instead of the active tab',async()=>{await compareFiles(b);assert.deepEqual(calls[0],['vscode.diff',a,b]);});
 function browse(){v.window.showQuickPick=async items=>items.at(-1);}
 function noCurrent(){v.window.tabGroups.activeTabGroup.activeTab={};}
 function folder(name){return {name,uri:v.Uri.file(path.join(root,name))};}
 it('starts in the current file directory without a workspace',async()=>{
  browse();await compareFiles();assert.equal(dialogs[0].defaultUri.fsPath,root);
 });
 it('uses the owning root returned by VS Code, including a nested non-first root',async()=>{
  const outer=folder('project'),nested=folder('project/nested');v.workspace.workspaceFolders=[outer,nested];
  v.workspace.getWorkspaceFolder=uri=>{assert.strictEqual(uri,a);return nested;};
  browse();await compareFiles();assert.strictEqual(dialogs[0].defaultUri,nested.uri);assert.equal(folderPicks.length,0);
 });
 it('uses the file directory for a file outside an open project',async()=>{
  v.workspace.workspaceFolders=[folder('unrelated')];browse();await compareFiles();assert.equal(dialogs[0].defaultUri.fsPath,root);
 });
 it('resolves the explicit context file even when the active tab changes during selection',async()=>{
  const project=folder('context-project');v.workspace.getWorkspaceFolder=uri=>{assert.strictEqual(uri,b);return project;};
  v.window.showQuickPick=async items=>{noCurrent();return items.at(-1);};await compareFiles(b);
  assert.strictEqual(dialogs[0].defaultUri,project.uri);
 });
 it('uses the sole workspace without a current file',async()=>{
  noCurrent();const project=folder('project');v.workspace.workspaceFolders=[project];browse();await compareFiles();
  assert.strictEqual(dialogs[0].defaultUri,project.uri);assert.equal(folderPicks.length,0);
 });
 it('leaves the default to VS Code without a current file or workspace',async()=>{
  noCurrent();browse();await compareFiles();assert.equal(dialogs[0].defaultUri,undefined);
 });
 it('asks for a workspace only when browsing without a current file',async()=>{
  noCurrent();const projects=[folder('one'),folder('two')];v.workspace.workspaceFolders=projects;browse();
  v.window.showWorkspaceFolderPick=async options=>{folderPicks.push(options);return projects[1];};
  await compareFiles();assert.strictEqual(dialogs[0].defaultUri,projects[1].uri);assert.equal(folderPicks.length,1);
  assert(folderPicks[0].placeHolder);
 });
 it('ends when workspace selection is cancelled',async()=>{
  noCurrent();v.workspace.workspaceFolders=[folder('one'),folder('two')];browse();v.window.showWorkspaceFolderPick=async()=>undefined;
  await compareFiles();assert.equal(dialogs.length,0);assert.equal(calls.length,0);assert.equal(warnings.length,0);
 });
 it('does not ask for a workspace when selecting open files',async()=>{
  noCurrent();v.workspace.workspaceFolders=[folder('one'),folder('two')];await compareFiles();
  assert.equal(folderPicks.length,0);assert.equal(dialogs.length,0);assert.deepEqual(calls[0],['vscode.diff',a,b]);
 });
 for(const firstFromDisk of [false,true])it(`starts the second browse beside the first file selected from ${firstFromDisk?'disk':'tabs'}`,async()=>{
  noCurrent();v.workspace.workspaceFolders=[folder('one'),folder('two')];let count=0;
  v.window.showQuickPick=async items=>++count===1&&!firstFromDisk?items[0]:items.at(-1);
  v.window.showOpenDialog=async options=>{dialogs.push(options);return [firstFromDisk&&dialogs.length===1?a:b];};
  await compareFiles();assert.equal(dialogs.at(-1).defaultUri.fsPath,root);
  assert.equal(folderPicks.length,firstFromDisk?1:0);assert.deepEqual(calls[0],['vscode.diff',a,b]);
 });
});
