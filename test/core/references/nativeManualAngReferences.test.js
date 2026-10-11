'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {trackTempDirectories}=require('../../support/tempDirectories');
const {buildFileIndex}=require('../../../src/core/scanner/fileIndexBuilder');
const {queryIndexedEntityId}=require('../../../src/core/references/indexedEntityQuery');

describe('user-adjudicated V4.14 EM_CONTROL_SOLUTION ANG references',function(){
 this.timeout(30000);
 const tempDirectory=trackTempDirectories();
 const marker=format=>format==='long'?' +':format==='i10'?' %':'';
 const row=(values,format)=>format==='comma'?values.join(','):values.map(value=>String(value).padStart(format==='long'?20:10)).join('');
 async function model(values,format,cap,offset=false){
  const directory=tempDirectory(path.join(os.tmpdir(),'dynasense-ang-help-'));
  const file=path.join(directory,'ang.k'),main=path.join(directory,'main.k');
  const lines=['*KEYWORD','*NODE','73,0,0,0','*DEFINE_CURVE','73','0,0','1,1','*DEFINE_FUNCTION','73','f(t)=1'];
  const referenceLines=[];
  for(const value of values){
   lines.push('*EM_CONTROL_SOLUTION'+marker(format),row([5000,5000,0,1,0,0,0,0],format));
   referenceLines.push(lines.length);lines.push(row([0,0,0,0,0,0,value,0],format));
  }
  lines.push('*END');fs.writeFileSync(file,lines.join('\n'));
  const options={maxReferenceBlockBytes:cap,maxDefinitionBlockBytes:cap};
  const snapshot={rootFile:file,files:[file],fileIndexes:new Map([[file,await buildFileIndex(file,options)]]),
   graph:{includeOccurrencesComplete:true,includeOccurrences:[]}};
  if(offset){
   fs.writeFileSync(main,'*KEYWORD\n*INCLUDE_TRANSFORM\nang.k\n*END\n');
   snapshot.rootFile=main;snapshot.files.unshift(main);snapshot.fileIndexes.set(main,await buildFileIndex(main,options));
   snapshot.graph.includeOccurrences.push({occurrenceId:'ang:1',fromFile:main,filePath:file,fileName:'ang.k',keywordLine:1,lineIndex:2,
    transform:{offsets:{idfoff:{kind:'numeric',value:600,raw:'600'},idnoff:{kind:'numeric',value:100,raw:'100'}}}});
  }
  return {snapshot,referenceLines};
 }
 it('uses negative ANG as an absolute curve ID and keeps nonnegative tolerances out of references',async()=>{
  for(const format of ['standard','comma','long','i10'])for(const cap of [undefined,1]){
   const {snapshot,referenceLines}=await model([-73,73,0,1.5],format,cap);
   for(const kind of ['curve','node','function']){
    const result=await queryIndexedEntityId({snapshot,id:73,targetKind:kind});
    assert.equal(result.state,'complete',JSON.stringify({format,cap,kind,reasons:result.reasons}));
    assert.deepEqual(result.locations.filter(item=>item.role==='reference').map(item=>[item.keyword,item.fieldName,item.line]),
     kind==='curve'?[['*EM_CONTROL_SOLUTION','ANG',referenceLines[0]]]:[],JSON.stringify({format,cap,kind}));
   }
  }
 });
 it('applies the curve offset after abs and retains unresolved or fractional negative IDs',async()=>{
  for(const cap of [undefined,1]){
   const shifted=await model([-73], 'comma',cap,true);
   const result=await queryIndexedEntityId({snapshot:shifted.snapshot,id:673,targetKind:'curve'});
   assert.equal(result.state,'complete',JSON.stringify(result.reasons));
   assert.deepEqual(result.locations.map(item=>[item.role,item.keyword,item.fieldName]),
    [['definition','*DEFINE_CURVE','ID'],['reference','*EM_CONTROL_SOLUTION','ANG']]);
   const unknown=await model([-73.5,'&MISSING'],'comma',cap);
   const partial=await queryIndexedEntityId({snapshot:unknown.snapshot,id:73,targetKind:'curve'});
   assert.ok(['partial','incomplete'].includes(partial.state),JSON.stringify(partial.reasons));
   assert.equal(partial.locations.filter(item=>item.role==='reference').length,0);
  }
 });
 it('recovers truncated curve and table headers without treating their data rows as definitions',async()=>{
  const directory=tempDirectory(path.join(os.tmpdir(),'dynasense-truncated-header-'));
  const file=path.join(directory,'headers.k');
  fs.writeFileSync(file,['*KEYWORD','*DEFINE_CURVE_TITLE','Curve title','73','999,1',
   '*DEFINE_TABLE_TITLE','Table title','74','999,73','*END'].join('\n'));
  const snapshot={rootFile:file,files:[file],fileIndexes:new Map([[file,await buildFileIndex(file,{maxDefinitionBlockBytes:1})]]),
   graph:{includeOccurrencesComplete:true,includeOccurrences:[]}};
  for(const [kind,id,line] of [['curve',73,3],['table',74,7]]){
   const result=await queryIndexedEntityId({snapshot,id,targetKind:kind});
   assert.deepEqual(result.locations.filter(item=>item.role==='definition').map(item=>item.line),[line]);
   const data=await queryIndexedEntityId({snapshot,id:999,targetKind:kind});
   assert.equal(data.locations.filter(item=>item.role==='definition').length,0);
  }
 });
});
