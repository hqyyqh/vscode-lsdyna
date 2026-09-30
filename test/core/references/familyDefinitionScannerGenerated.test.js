const assert=require('assert'),path=require('path');
const handoff=require('../../../keywords/family_definition_scanner_handoff.json');
const {mergeOnDemandDefinitions,queryOnDemandDefinitionAtPosition,scanOnDemandDefinitions,selectOnDemandDefinitionDescriptors}=require('../../../out/core/references/onDemandDefinitionScanner');
const {buildReferenceNavigation}=require('../../../out/core/references/referenceNavigation');

function renderedValue(value,mode){
 if(mode==='comma-delimited')return`${value},0`;
 const width=mode==='long-fixed'?20:10;
 return String(value).padStart(width,' ');
}
function keywordLine(descriptor,mode){
 if(mode==='long-fixed')return`*${descriptor.keyword}+`;
 if(mode==='i10-fixed')return`*${descriptor.keyword}%`;
 return`*${descriptor.keyword}`;
}
async function scan(descriptor,mode,effectiveId,dataLines){
 const filePath=path.resolve('generated-family-scanner.k'),rawKeyword=keywordLine(descriptor,mode);
 return scanOnDemandDefinitions({
  fileIndexes:new Map([[filePath,{keywordBlocks:[{filePath,keyword:`*${descriptor.keyword}`,rawKeyword,startLine:0,endLine:dataLines.length}]}]]),
  effectiveId,targetDefinitions:[descriptor.keyword],projectScoped:false,
  definitionKeywords:{onDemand:{[descriptor.keyword]:descriptor}},
  scanBlockLines:async(_block,visitLine)=>{for(let i=0;i<dataLines.length;i++)await visitLine(dataLines[i],i+1,{keywordLineText:rawKeyword});return{complete:true,lineCount:dataLines.length,keywordLineText:rawKeyword}},
 });
}
function linesAtApprovedOrdinal(descriptor,valueLine,{laterLine=null,prefix=[]}={}){
 const lines=[...prefix];
 for(let n=0;n<descriptor.dataRecordOrdinal;n++)lines.push(n===0&&descriptor.titleCardCount===1?'official title':'0');
 lines.push(valueLine);
 if(laterLine!==null)lines.push(laterLine);
 return lines;
}
function origin(descriptor,mode,value,dataLines,cursorDataIndex){
 const filePath=path.resolve('generated-family-origin.k'),keyword=keywordLine(descriptor,mode),lines=[keyword,...dataLines],line=cursorDataIndex+1,character=lines[line].indexOf(String(value));
 return queryOnDemandDefinitionAtPosition({
  filePath,position:{line,character},projectScoped:false,lineAt:index=>lines[index],
  fileIndex:{keywordBlocks:[{filePath,keyword:`*${descriptor.keyword}`,rawKeyword:keyword,startLine:0,endLine:lines.length-1}]},
  definitionKeywords:{onDemand:{[descriptor.keyword]:descriptor}},
 });
}

describe('generated family definition scanner contract',function(){
 this.timeout(120000);
 it('selects exact official family namespaces without MAT/MAT_THERMAL bleed',()=>{
  const onDemand=Object.fromEntries(handoff.descriptors.map(d=>[d.keyword,d]));
  const expected={MAT:1488,MAT_THERMAL:25,EOS:106,SECTION:40,SET_NODE:14};
  for(const [family,count] of Object.entries(expected)){
   const selected=selectOnDemandDefinitionDescriptors([], [family], {onDemand});
   assert.equal(selected.length,count,family);
   assert.ok(selected.every(d=>d.targetToken===`*${family}`),family);
  }
 });
 it('passes all 6,692 numeric and 6,636 label format fixtures',async()=>{
  let numeric=0,label=0;
  for(const descriptor of handoff.descriptors){
   for(const format of descriptor.formatContracts){
    const n=1200345,nLookup=await scan(descriptor,format.mode,n,linesAtApprovedOrdinal(descriptor,renderedValue(n,format.mode),{prefix:['$ comment','  $# fields']}));
    assert.equal(nLookup.definitions.length,1,`${descriptor.keyword}/${format.mode}/numeric`);assert.equal(nLookup.definitions[0].id,n);assert.equal(buildReferenceNavigation(mergeOnDemandDefinitions({state:'uncertain',definitions:[],reasons:['target-definition-on-demand']},nLookup)).state,'resolved');numeric++;
    if(descriptor.valueDomain.kind.includes('label')){const value='HS Steel',lLookup=await scan(descriptor,format.mode,value,linesAtApprovedOrdinal(descriptor,renderedValue(value,format.mode),{prefix:['$ comment','  $ indented']}));assert.equal(lLookup.definitions.length,1,`${descriptor.keyword}/${format.mode}/label`);assert.equal(lLookup.definitions[0].id,value);assert.equal(buildReferenceNavigation(mergeOnDemandDefinitions({state:'uncertain',definitions:[],reasons:['target-definition-on-demand']},lLookup)).state,'resolved');label++}
   }
  }
  assert.equal(numeric,6692);assert.equal(label,6636);assert.equal(numeric+label,13328);
 });
 it('rejects all 56 labels in integer-only SET_NODE formats',async()=>{let rejected=0;for(const descriptor of handoff.descriptors.filter(d=>d.valueDomain.kind==='positive-integer'))for(const format of descriptor.formatContracts){const x=await scan(descriptor,format.mode,'HS Steel',linesAtApprovedOrdinal(descriptor,renderedValue('HS Steel',format.mode)));assert.equal(x.definitions.length,0,`${descriptor.keyword}/${format.mode}`);rejected++}assert.equal(rejected,56)});
 it('never matches the same identity on a later card and treats blank as a physical record',async()=>{let later=0,blank=0;for(const descriptor of handoff.descriptors){const mode='standard-fixed',target=7654321,other=1234567,laterLookup=await scan(descriptor,mode,target,linesAtApprovedOrdinal(descriptor,renderedValue(other,mode),{laterLine:renderedValue(target,mode)}));assert.equal(laterLookup.definitions.length,0,`${descriptor.keyword}/later-card`);later++;const shifted=await scan(descriptor,mode,target,['',...linesAtApprovedOrdinal(descriptor,renderedValue(target,mode))]);assert.equal(shifted.definitions.length,0,`${descriptor.keyword}/blank-shift`);blank++}assert.equal(later,1673);assert.equal(blank,1673)});
 it('builds all numeric and label definition-origin queries from the exact approved token',()=>{
  let numeric=0,label=0;
  for(const descriptor of handoff.descriptors)for(const format of descriptor.formatContracts){
   const value=1200345,numericLines=linesAtApprovedOrdinal(descriptor,renderedValue(value,format.mode),{prefix:['$ comment','  $# fields']}),numericIndex=numericLines.findIndex(line=>line.includes(String(value))),numericOrigin=origin(descriptor,format.mode,value,numericLines,numericIndex);
   assert.equal(numericOrigin.state,'ready',`${descriptor.keyword}/${format.mode}/numeric`);assert.equal(numericOrigin.query.id,value);assert.deepEqual(numericOrigin.query.targetKinds,[descriptor.targetKind]);assert.deepEqual(numericOrigin.query.targetDefinitions,[descriptor.targetToken.slice(1)]);numeric++;
   if(descriptor.valueDomain.kind.includes('label')){const text='HS Steel',labelLines=linesAtApprovedOrdinal(descriptor,renderedValue(text,format.mode),{prefix:['$ comment','  $ indented']}),labelIndex=labelLines.findIndex(line=>line.includes(text)),labelOrigin=origin(descriptor,format.mode,text,labelLines,labelIndex);assert.equal(labelOrigin.state,'ready',`${descriptor.keyword}/${format.mode}/label`);assert.equal(labelOrigin.query.id,text);label++}
  }
  assert.equal(numeric,6692);assert.equal(label,6636);
 });
 it('rejects every integer-only label and every later/blank-shift definition origin',()=>{
  let labels=0,later=0,blank=0;
  for(const descriptor of handoff.descriptors){
   if(descriptor.valueDomain.kind==='positive-integer')for(const format of descriptor.formatContracts){const text='HS Steel',lines=linesAtApprovedOrdinal(descriptor,renderedValue(text,format.mode)),index=lines.findIndex(line=>line.includes(text));assert.equal(origin(descriptor,format.mode,text,lines,index).state,'none',`${descriptor.keyword}/${format.mode}/integer-label`);labels++}
   const mode='standard-fixed',target=7654321,other=1234567,laterLines=linesAtApprovedOrdinal(descriptor,renderedValue(other,mode),{laterLine:renderedValue(target,mode)}),laterIndex=laterLines.findIndex(line=>line.includes(String(target)));assert.equal(origin(descriptor,mode,target,laterLines,laterIndex).state,'none',`${descriptor.keyword}/later`);later++;
   const blankLines=['',...linesAtApprovedOrdinal(descriptor,renderedValue(target,mode))],blankIndex=blankLines.findIndex(line=>line.includes(String(target)));assert.equal(origin(descriptor,mode,target,blankLines,blankIndex).state,'none',`${descriptor.keyword}/blank`);blank++;
  }
  assert.equal(labels,56);assert.equal(later,1673);assert.equal(blank,1673);
 });
});
