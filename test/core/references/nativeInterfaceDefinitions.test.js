'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {trackTempDirectories}=require('../../support/tempDirectories');
const {buildFileIndex}=require('../../../src/core/scanner/fileIndexBuilder');
const {buildProjectReferenceIndex}=require('../../../src/core/references/projectReferenceIndex');
const {queryIndexedEntityId}=require('../../../src/core/references/indexedEntityQuery');
const {queryOnDemandDefinitionAtPosition}=require('../../../src/core/references/onDemandDefinitionScanner');

describe('original INTERFACE header/payload definitions',function(){
 this.timeout(60000);
 const tempDirectory=trackTempDirectories();
 it('checks every payload field identity without depending on numeric addresses',()=>{
  const {getCatalogInputFormCatalogV4}=require("../../../src/core/semantics/catalogInputFormCatalogV4");
  const {nativeFileLayoutKind}=require("../../../src/core/semantics/catalogNativeFileLayout");
  for(const base of ['NODE','SEGMENT','SPH'])for(const suffix of ['','_ID','_TITLE']){
   const keyword='INTERFACE_COMPONENT_'+base+suffix,form=getCatalogInputFormCatalogV4().formForKeyword(keyword);
   const rule={...form.rules[form.reference.formRuleIds[0]],catalogSource:form.source};
   assert.equal(nativeFileLayoutKind(rule,keyword),suffix?'batch-fixed':'generic-fixed');
   for(let index=0;index<3;index++){
    const changed=structuredClone(rule);changed.cards[1].fields[index].fieldRecordId='invalid-identity';
    assert.equal(nativeFileLayoutKind(changed,keyword),'unsupported-source');
   }
  }
 });
 const marker=format=>format==='long'?' +':format==='i10'?' %':'';
 const row=(values,format)=>format==='comma'?values.join(','):values.map(value=>String(value).padStart(format==='long'?20:10)).join('');
 const header=(id,format)=>format==='comma'?`${id},interface`:String(id).padStart(format==='long'?20:10)+'interface';
 async function fixture(lines,cap){
  const directory=tempDirectory(path.join(os.tmpdir(),'dynasense-interface-')),file=path.join(directory,'model.k');
  fs.writeFileSync(file,lines.join('\n'));const index=await buildFileIndex(file,{maxReferenceBlockBytes:cap,maxDefinitionBlockBytes:cap});
  return {file,index,lines,snapshot:{rootFile:file,files:[file],fileIndexes:new Map([[file,index]]),
   graph:{includeOccurrences:[],includeOccurrencesComplete:true}}};
 }
 it('queries repeated explicit headers in all six spellings and keeps payload IDs out of definitions',async()=>{
  for(const base of ['NODE','SEGMENT','SPH'])for(const suffix of ['_ID','_TITLE'])
  for(const format of ['standard','comma','long','i10'])for(const cap of [undefined,1]){
   const keyword='INTERFACE_COMPONENT_'+base+suffix;
   const lines=['*KEYWORD','*'+keyword+marker(format),header(72,format),row([73,0,0],format),
    '$ between instances',header(73,format),row([82,0,0],format),header(74,format),row([83,0,0],format),
    '*BOUNDARY_ACOUSTIC_INTERFACE'+marker(format),row([0,73],format),'*NODE','73,0,0,0','*END'];
   const value=await fixture(lines,cap),query=await queryIndexedEntityId({snapshot:value.snapshot,id:73,targetKind:'interface-id'});
   assert.deepEqual(query.locations.map(item=>[item.role,item.keyword,item.fieldName,item.line]),
    [['definition','*'+keyword,'ID',5],['reference','*BOUNDARY_ACOUSTIC_INTERFACE','IFID',10]],
    JSON.stringify({keyword,format,cap,reasons:query.reasons}));
   assert.ok(!query.reasons.some(reason=>/target-kind-unindexed|target-definition|preview-byte-limit/.test(reason)));
   const referenceIndex=buildProjectReferenceIndex(value.snapshot),origin=position=>queryOnDemandDefinitionAtPosition({
    referenceIndex,fileIndex:value.index,filePath:value.file,position,lineAt:index=>lines[index],projectScoped:false});
   const position=lines[5].indexOf('73');
   assert.equal(origin({line:5,character:position}).state,'ready',JSON.stringify({keyword,format}));
   assert.equal(origin({line:3,character:lines[3].indexOf('73')}).state,'none','Payload set IDs do not own INTERFACE objects');
  }
 });
 it('does not treat plain automatic-key payloads or an incomplete final pair as explicit definitions',async()=>{
  for(const base of ['NODE','SEGMENT','SPH']){
   const plain=await fixture(['*KEYWORD','*INTERFACE_COMPONENT_'+base,'73,0,0','74,0,0','*END'],1);
   const query=await queryIndexedEntityId({snapshot:plain.snapshot,id:73,targetKind:'interface-id'});
   assert.deepEqual(query.locations.filter(item=>item.role==='definition'),[]);
   const incomplete=await fixture(['*KEYWORD','*INTERFACE_COMPONENT_'+base+'_TITLE',
    '72,complete','83,0,0','73,incomplete','*END'],1);
   const partial=await queryIndexedEntityId({snapshot:incomplete.snapshot,id:73,targetKind:'interface-id'});
   assert.deepEqual(partial.locations.filter(item=>item.role==='definition'),[]);
   assert.ok(partial.reasons.some(reason=>reason.includes('record-template-incomplete')));
   const origin=queryOnDemandDefinitionAtPosition({referenceIndex:buildProjectReferenceIndex(incomplete.snapshot),
    fileIndex:incomplete.index,filePath:incomplete.file,position:{line:4,character:0},
    lineAt:index=>incomplete.lines[index],projectScoped:false});
   assert.equal(origin.state,'incomplete');
  }
 });
 it('streams payload references in base and explicit variants without inventing a separate TITLE record',async()=>{
  for(const base of ['NODE','SEGMENT','SPH'])for(const suffix of ['','_ID','_TITLE'])
  for(const format of ['standard','comma','long','i10'])for(const cap of [undefined,1]){
   const keyword='INTERFACE_COMPONENT_'+base+suffix,lines=['*KEYWORD','*'+keyword+marker(format)];
   if(suffix)lines.push(header(71,format));lines.push(row([73,0,0],format));
   if(suffix)lines.push(header(72,format));const finalLine=lines.length;lines.push(row([73,0,0],format),'*END');
   const value=await fixture(lines,cap),kind=base==='SEGMENT'?'segment-set':'node-set';
   const query=await queryIndexedEntityId({snapshot:value.snapshot,id:73,targetKind:kind});
   assert.deepEqual(query.locations.filter(item=>item.role==='reference').map(item=>[item.fieldName,item.line]),
    [[base==='SEGMENT'?'SSID':'NSID',2+Number(!!suffix)],[base==='SEGMENT'?'SSID':'NSID',finalLine]],
    JSON.stringify({keyword,format,cap,reasons:query.reasons}));
   assert.ok(!query.reasons.some(reason=>/preview-byte-limit|native-layout-unavailable/.test(reason)));
  }
 });
});
