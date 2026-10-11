'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {trackTempDirectories}=require('../../support/tempDirectories');
const {buildFileIndex}=require('../../../src/core/scanner/fileIndexBuilder');
const {queryIndexedEntityId}=require('../../../src/core/references/indexedEntityQuery');
const {getCatalogInputFormCatalogV4}=require("../../../src/core/semantics/catalogInputFormCatalogV4");
const {nativeFileLayoutCards}=require("../../../src/core/semantics/catalogNativeFileLayout");
const {formattedReadFields}=require('../../../src/core/edit/keywordRecordSerializer');

describe('exact native suffix grammars and input formats',function(){
 this.timeout(60000);
 const tempDirectory=trackTempDirectories(),forms=getCatalogInputFormCatalogV4();
 const marker=format=>format==='long'?' +':format==='i10'?' %':'';
 const render=(fields,values,format)=>format==='comma'?values.join(','):formattedReadFields(fields,'',format).reduce((text,span,index)=>
  text.padEnd(span.position)+String(values[index]).padStart(span.width),'');
 const card=(keyword,index,format,overrides={})=>{
  const form=forms.formForKeyword(keyword,false),rule={...form.rules[form.reference.formRuleIds[0]],catalogSource:form.source};
  const fields=nativeFileLayoutCards(rule,keyword).find(card=>card.cardIndex===index).fields;
  return render(fields,fields.map(field=>overrides[field.name]??(field.type===0||field.type===3?'fixture':0)),format);
 };
 async function query(lines,kind,cap){
  const directory=tempDirectory(path.join(os.tmpdir(),'dynasense-native-prefix-')),file=path.join(directory,'model.k');
  fs.writeFileSync(file,lines.join('\n'));const index=await buildFileIndex(file,{maxReferenceBlockBytes:cap});
  return queryIndexedEntityId({snapshot:{rootFile:file,files:[file],fileIndexes:new Map([[file,index]]),
   graph:{includeOccurrences:[],includeOccurrencesComplete:true}},id:73,targetKind:kind});
 }
 it('uses the verified conditional physical rows for all affected EFV aliases in ordinary and disk queries',async()=>{
  for(const format of ['standard','comma','long','i10'])for(const cap of [undefined,1]){
   for(const [keyword,kind,field,records]of [
    ['EFV_BOUNDARY_MESH_FACE_TITLE','structured-mesh','ID',[[1,{ID:73,TYP:0}]]],
    ['EFV_DETONATION_TITLE','structured-mesh','PSID',[[1,{IDGEOM:0}],[2,{}],[7,{PSID:73}]]],
    ['EFV_FAILURE_010_TITLE','efv-failure-add-stochasticd','STCHID',[[1,{JHTYP:0}],[2,{TFAIL:0}],[4,{STCHID:73}]]],
    ['EFV_FAILURE_JOHNSON_HOLMQUIST_TITLE','efv-failure-add-stochasticd','STCHID',[[1,{JHTYP:0}],[2,{TFAIL:0}],[4,{STCHID:73}]]],
   ]){
    const lines=['*KEYWORD','*'+keyword+marker(format),'fixture prefix',...records.map(([index,values])=>card(keyword,index,format,values)),'*END'];
    const result=await query(lines,kind,cap);
    assert.deepEqual(result.locations.filter(item=>item.role==='reference').map(item=>[item.fieldName,item.line]),
     [[field,records.length+2]],JSON.stringify({keyword,format,cap,reasons:result.reasons}));
    assert.ok(!result.reasons.some(reason=>/preview-byte-limit|native-layout-unavailable|reference-scan-incomplete/.test(reason)));
   }
  }
 });
 it('uses the four-format SEATBELT SBRID reads and keeps the retractor namespace',async()=>{
  for(const format of ['standard','comma','long','i10'])for(const cap of [undefined,1]){
   const lines=['*KEYWORD','*ELEMENT_SEATBELT'+marker(format),card('ELEMENT_SEATBELT',1,format,{EID:1,SBRID:73}),
    card('ELEMENT_SEATBELT',1,format,{EID:2,SBRID:73}),'*END'];
   const result=await query(lines,'seatbelt-retractor',cap);
   assert.deepEqual(result.locations.filter(item=>item.role==='reference').map(item=>[item.fieldName,item.line]),
    [['SBRID',2],['SBRID',3]],JSON.stringify({format,cap,reasons:result.reasons}));
   assert.ok(!result.reasons.some(reason=>/native-layout-unavailable|preview-byte-limit/.test(reason)));
   const other=await query(lines,'seatbelt-slipring',cap);assert.deepEqual(other.locations.filter(item=>item.role==='reference'),[]);
  }
 });
});
