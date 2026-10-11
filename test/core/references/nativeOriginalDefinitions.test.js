'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib');
const {trackTempDirectories}=require('../../support/tempDirectories');
const {buildFileIndex}=require('../../../src/core/scanner/fileIndexBuilder');
const {queryIndexedEntityId}=require('../../../src/core/references/indexedEntityQuery');
const source=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname,
 '../../../keywords/sources/semantic-inputs/lspp_original_input_definition_supplement.v6.json.gz'))));

describe('original definition selectors and target namespaces',function(){
 this.timeout(60000);
 const tempDirectory=trackTempDirectories();
 const records=source.records.slice(25);
 it('queries all 48 independently observed owners in four formats through ordinary and disk paths',async()=>{
  assert.equal(records.length,48);
  for(const format of ['standard','comma','long','i10'])for(const maxDefinitionBlockBytes of [undefined,1]){
   const lines=['*KEYWORD'],expected=new Map();
   for(const record of records){
    lines.push('*'+record.keyword+(format==='long'?' +':format==='i10'?' %':''));
    const contract=record.formatContracts.find(item=>item.format===format);
    const line=lines.length,kind=record.target.targetKind;
    if(!expected.has(kind))expected.set(kind,[]);
    expected.get(kind).push(['*'+record.keyword,line]);
    lines.push(format==='comma'?'73,0,0,0,0,0,0,0':String(73).padStart(contract.width)+''.padEnd(200));
   }
   lines.push('*END');const root=tempDirectory(path.join(os.tmpdir(),'dynasense-original-definitions-')),file=path.join(root,'main.k');
   fs.writeFileSync(file,lines.join('\n'));const index=await buildFileIndex(file,{maxDefinitionBlockBytes});
   const snapshot={rootFile:file,files:[file],fileIndexes:new Map([[file,index]]),graph:{includeOccurrences:[],includeOccurrencesComplete:true}};
   for(const [kind,locations]of expected){
    const result=await queryIndexedEntityId({snapshot,id:73,targetKind:kind});
    assert.deepEqual(result.locations.filter(item=>item.role==='definition').map(item=>[item.keyword,item.line]),locations,
     JSON.stringify({format,maxDefinitionBlockBytes,kind,reasons:result.reasons}));
   }
  }
 });
 it('finds the second and final seatbelt EID after the definition preview limit without mixing element namespaces',async()=>{
  for(const format of ['standard','comma','long','i10']){
   const record=records.find(item=>item.keyword==='ELEMENT_SEATBELT'),width=record.formatContracts.find(item=>item.format===format).width;
   const row=id=>format==='comma'?`${id},0,0,0,0,0,0,0`:String(id).padStart(width)+''.padEnd(72);
   const lines=['*KEYWORD','*ELEMENT_SEATBELT'+(format==='long'?' +':format==='i10'?' %':''),row(72),row(73),
    ...Array(128).fill(row(74)),row(75),'*ELEMENT_BEAM','75,0,0,0,0,0','*END'];
   const root=tempDirectory(path.join(os.tmpdir(),'dynasense-seatbelt-definition-')),file=path.join(root,'model.k');
   fs.writeFileSync(file,lines.join('\n'));const index=await buildFileIndex(file,{maxDefinitionBlockBytes:40});
   const snapshot={rootFile:file,files:[file],fileIndexes:new Map([[file,index]]),graph:{includeOccurrences:[],includeOccurrencesComplete:true}};
   for(const [id,line]of [[73,3],[75,132]]){
    const result=await queryIndexedEntityId({snapshot,id,targetKind:'element-seatbelt'});
    assert.deepEqual(result.locations.filter(item=>item.role==='definition').map(item=>[item.keyword,item.line]),[['*ELEMENT_SEATBELT',line]],
     JSON.stringify({format,id,reasons:result.reasons}));
   }
  }
 });
});
