'use strict';
const assert=require('node:assert/strict');
const {fakeDoc}=require("../../support/helpers");
const {getCardInfoForDocumentLineWithSuggest:resolve,LsdynaFieldHoverProvider,buildKeywordOptionViewModel:model,keywordManagerEditField:edit}=require("../../../out/extension")._internals;
const a=require("../../fixtures/public-behavior/element-readers.json");
const connectedSave=require("../../fixtures/public-behavior/element-composite-save.json");

describe('native ELEMENT instance readers',()=>{
 it('matches the independently retained records through actual hover and source manager in four formats',async function(){
  this.timeout(60000);const provider=new LsdynaFieldHoverProvider();
  for(const task of a.plan.tasks){
   const doc={...fakeDoc(task.lines.join('\n'),'/element/'+task.id+'.k'),version:1};
   let instanceStart=0;
   for(const [ordinal,record] of task.expectedRecords.entries()){
    if(JSON.stringify(record.fields.map(f=>f.address))===JSON.stringify(task.expectedRecords[0].fields.map(f=>f.address)))instanceStart=ordinal;
    const info=resolve(doc,record.lineOffset).cardInfo;
    assert.ok(info,task.keyword);assert.equal(info.nativeInstanceStart,instanceStart,task.keyword);assert.deepEqual(info.card.map(f=>f.nativeIdentity?.fieldRecordId),record.fields.map(f=>f.address),task.keyword);
    assert.deepEqual(info.card.map(f=>f.n),record.fields.map(f=>/^[-_]*$/.test(f.name)?'UNUSED':f.name));
    assert.deepEqual(info.card.map(f=>f.t),record.fields.map(f=>f.type===0?'string':f.type===1?'integer':'real'));
    assert.deepEqual(info.card.map(f=>f.rawValue),record.fields.map(f=>f.value),task.keyword+' '+task.format);
    for(const field of info.card){
     const hover=await provider.provideHover(doc,{line:record.lineOffset,character:field.p});
     assert.ok(hover?.contents[0].value.includes('**'+field.n+'**'),task.keyword+' '+field.n);
     assert.equal(hover.range.start.character,field.p);
    }
   }
   const view=model({document:doc,selection:{active:{line:1,character:0}}},1,{});
   assert.ok(view?.managerCards?.length,task.keyword+' manager');
   for(const card of view.managerCards){const record=task.expectedRecords.find(r=>r.lineOffset===card.line);assert.ok(record);assert.deepEqual(card.fields.map(f=>f.value),record.fields.map(f=>f.value));}
  }
 });
 it('ignores inserted misleading comments and preserves instance identity',function(){
  this.timeout(60000);
  for(const task of a.plan.tasks){
   const lines=task.lines.flatMap((line,i)=>i?['$# WRONG EID PID',line]:[line]);
   const doc={...fakeDoc(lines.join('\n'),'/element-comments/'+task.id+'.k'),version:1};
   for(const record of task.expectedRecords){
    const before=resolve(fakeDoc(task.lines.join('\n')),record.lineOffset).cardInfo;
    const after=resolve(doc,record.lineOffset*2).cardInfo;
    assert.deepEqual(after.card.map(f=>[f.nativeIdentity.fieldRecordId,f.rawValue]),before.card.map(f=>[f.nativeIdentity.fieldRecordId,f.rawValue]));
    assert.equal(after.nativeInstanceStart,before.nativeInstanceStart);
   }
  }
 });
 it('invalidates the sticky SHELL branch on edits and Undo, and keeps unknown heads',async()=>{
  const head='1,1,1,2,3,4,5,6,7,8', short='2,1,1,2,3,4,0,0,0,0';
  let lines=['*ELEMENT_SHELL_THICKNESS',head,'1,2,3,4,5','6,7,8,9',short,'1,2,3,4,5',head,'1,2,3,4,5'];
  const doc={...fakeDoc(''),version:1,lineAt:i=>({text:lines[i]}),getText:()=>lines.join('\n')};
  Object.defineProperty(doc,'lineCount',{get:()=>lines.length});
  assert.equal(resolve(doc,6).cardInfo.nativeInstanceStart,5);
  lines[1]='1,1,1,2,3,4,&missing,0,0,0';doc.version++;
  assert.ok(resolve(doc,1).cardInfo);assert.equal(resolve(doc,2).cardInfo,null);
  lines[1]=head;doc.version++;
  assert.equal(resolve(doc,6).cardInfo.nativeInstanceStart,5);
  assert.equal(await new LsdynaFieldHoverProvider().provideHover(doc,{line:1,character:0},{isCancellationRequested:true}),null);
 });
 it('keeps same-layout edits in the selected source instance and blocks card-count changes',()=>{
  for(const keyword of ['ELEMENT_BEAM_OFFSET','ELEMENT_SHELL_THICKNESS']){
   const task=a.plan.tasks.find(t=>t.keyword===keyword&&t.format==='standard');
   const doc={...fakeDoc(task.lines.join('\n')+'\n*NODE\n999,0,0,0'),version:1};
   const editor={document:doc,selection:{active:{line:1,character:0}}};
   const before=model(editor,1,{}),field=before.managerCards[0].fields[0];
   if(keyword==='ELEMENT_SHELL_THICKNESS'){
    const changed=edit(before,before.managerCards[0].fields[6].fieldId,'0');assert.ok(changed);
    assert.equal(model(editor,1,changed).plan.status,'blocked');
   }
   if(!field.editable){assert.equal(edit(before,field.fieldId,'42'),null);continue;}
   const staged=edit(before,field.fieldId,'42');assert.ok(staged);
   const after=model(editor,1,staged);assert.equal(after.plan.status,'ready',after.plan.reason);
   const saved=after.plan.replacementRecords.map(r=>r.text);
   assert.equal(saved[0].slice(0,8).trim(),'42');assert.deepEqual(saved.slice(1),task.lines.slice(2));
   assert.ok(doc.getText().endsWith('*NODE\n999,0,0,0'));
  }
 });

 it('checks every template layout through actual document parsing',function(){
  this.timeout(20000); // Exhaustive generated-template replay on CI hosts.
  const {nativeKeywordTemplate}=require("../../../out/core/completion/nativeKeywordTemplate");
  for(const keyword of Object.keys(require("../../../keywords/runtime/native-readers/lspp-element-readers.json").bindings)){
   const template=nativeKeywordTemplate(keyword);assert.equal(template.status,'native-layout');
   const binding=require("../../../keywords/runtime/native-readers/lspp-element-readers.json").bindings[keyword];
   if(binding.kind==='element-composite')assert.equal(template.cardIndexes.filter(i=>i===binding.cardCount).length,1,keyword+' new layer slot');
   const text=template.body.slice(0,-1).map(line=>line.replace(/\$\{\d+:((?:\\.|[^\\}])*)\}/g,(_,v)=>v.replace(/\\([\\$}])/g,'$1'))).join('\n');
   const doc=fakeDoc(text);let index=0;
   for(let line=1;line<doc.lineCount;line++)if(!doc.lineAt(line).text.startsWith('$')){
    const info=resolve(doc,line).cardInfo;assert.ok(info,keyword);assert.equal(info.nativeCardIndex,template.cardIndexes[index++]);
   }
   assert.equal(index,template.cardIndexes.length);
  }
 });

 it('uses the literal composite separator and blocks edits that change record identity',()=>{
  const {nativeCompositeLayerRecord:layer}=require("../../../out/core/semantics/catalogNativeFileLayout");
  assert.equal(layer(' '.repeat(30)+'1'),true);assert.equal(layer(' '.repeat(30)+'10'),false);
  assert.equal(layer('1,2,3,0'),true);assert.equal(layer('1,2,3,1'),false);
  for(const format of ['comma','long']){
   const task=a.plan.tasks.find(t=>t.keyword==='ELEMENT_SHELL_COMPOSITE'&&t.format===format);
   const line=task.expectedRecords.find(r=>r.fields[0].name==='MID1').lineOffset;
   const doc={...fakeDoc(task.lines.join('\n')),version:1};
   const editor={document:doc,selection:{active:{line,character:0}}};
   const before=model(editor,line,{});
   const card=before.managerCards.find(c=>c.line===line);assert.ok(card);
   const field=card.fields.find(f=>f.name===(format==='comma'?'UNUSED':'THICK1'));
   if(format==='comma'){assert.equal(field.editable,false);assert.equal(edit(before,field.fieldId,'1'),null);continue;}
   const draft=edit(before,field.fieldId,'10');assert.ok(draft);
   assert.equal(model(editor,line,draft).plan.status,'blocked');
   if(format==='long'){
    const headLine=task.expectedRecords.filter(r=>r.fields[0].name==='EID')[1].lineOffset;
    const head=model(editor,headLine,{}),pid=head.managerCards.find(c=>c.line===headLine).fields.find(f=>f.name==='PID');
    const changed=edit(head,pid.fieldId,'1');assert.ok(changed);
    assert.equal(model(editor,headLine,changed).plan.status,'blocked');
   }
  }
 });

 it('reopens the independent connected native save with one generated layer per composite',()=>{
  const doc=fakeDoc(connectedSave.savedDeck);
  const expected=new Map(connectedSave.tasks.map(t=>[t.keyword,t.expectedRecords]));
  let keyword='',index=0;const ids=[];
  for(let line=0;line<doc.lineCount;line++){
   const text=doc.lineAt(line).text;
   if(text.startsWith('*')){
    if(expected.has(keyword))assert.equal(index,expected.get(keyword).length,keyword);
    keyword=text.slice(1).trim();index=0;continue;
   }
   if(!expected.has(keyword)||text.startsWith('$'))continue;
   const info=resolve(doc,line).cardInfo;assert.ok(info,keyword);
   assert.deepEqual(info.card.map(f=>f.nativeIdentity.fieldRecordId),expected.get(keyword)[index++].fields.map(f=>f.address));
   if(info.card[0].n==='EID')ids.push(Number(info.card[0].rawValue));
  }
  assert.deepEqual(ids,[10001,10002,10003,10004,10005,10006,10007,10008]);
 });

});


