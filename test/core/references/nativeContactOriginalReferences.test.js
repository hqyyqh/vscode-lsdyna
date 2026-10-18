'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {trackTempDirectories}=require('../../support/tempDirectories');
const {getCatalogInputFormCatalogV4}=require("../../../src/core/semantics/catalogInputFormCatalogV4");
const {nativeFileReadContext}=require('../../../src/core/semantics/nativeFileReadContext');
const {buildFileIndex}=require('../../../src/core/scanner/fileIndexBuilder');
const {queryIndexedEntityId}=require('../../../src/core/references/indexedEntityQuery');
const {coverageGapMatches}=require('../../../src/core/references/registryReferenceNetwork');

describe('original CONTACT reference owners',function(){
 this.timeout(30000);
 const tempDirectory=trackTempDirectories();
 it('does not load CONTACT metadata for unrelated cards, while CONTACT still requires verified data',()=>{
  const vm=require('node:vm'),file=path.resolve('out/core/semantics/nativeContactOptionalReferences.js');
  const hostRequire=require('node:module').createRequire(file),module={exports:{}};
  const missing=Error('CONTACT metadata read'); let reads=0;
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,exports:module.exports,Buffer,
   require:name=>name==='../references/referenceRuleCatalog'
    ?{getReferenceRuleCatalog:()=>({metadata(){reads++;throw missing;}})}:hostRequire(name)});
  const bind=module.exports.nativeContactOptionalBinding,nodeRule=rule('NODE');
  for(const name of ['NODE','*NODE','MAT_ELASTIC','PART'])assert.equal(bind(nodeRule,name),null);
  assert.equal(reads,0);
  const contactRule=rule('CONTACT_AUTOMATIC_SURFACE_TO_SURFACE');
  assert.throws(()=>bind(contactRule,'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE'),error=>error===missing);
  assert.equal(reads,1);
  const input=require('../../../src/core/semantics/nativeContactOptionalReferences').nativeAuxiliaryReferenceSource();
  assert.ok(input.contactOptionalBindings.every(binding=>binding.keyword.startsWith('CONTACT_')));
  assert.ok(bind(contactRule,'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',input));
 });
 const fixed=['CONTACT_FORMING_NODES_TO_SURFACE','CONTACT_FORMING_NODES_TO_SURFACE_SMOOTH',
  'CONTACT_RIGID_BODY_ONE_WAY_TO_RIGID_BODY','CONTACT_RIGID_BODY_TWO_WAY_TO_RIGID_BODY','CONTACT_RIGID_NODES_TO_RIGID_BODY'];
 const aliases=['CONTACT_DRAWBEAD',...fixed.slice(2)].flatMap(base=>['_MPP_ID','_ID_MPP'].map(suffix=>base+suffix));
 const marker=format=>format==='long'?' +':format==='i10'?' %':'';
 const render=(values,format)=>format==='comma'?values.join(','):values.map(value=>String(value).padStart(format==='long'?20:10)).join('');
 function rule(keyword){
  const form=getCatalogInputFormCatalogV4().formForKeyword(keyword,false);
  assert.equal(form.reference.formRuleIds.length,1);
  return {...form.rules[form.reference.formRuleIds[0]],catalogSource:form.source};
 }
 async function indexed(lines,maxReferenceBlockBytes){
  const dir=tempDirectory(path.join(os.tmpdir(),'dynasense-contact-original-')),file=path.join(dir,'model.k');
  fs.writeFileSync(file,lines.join('\n'));
  const index=await buildFileIndex(file,{maxReferenceBlockBytes,maxDefinitionBlockBytes:maxReferenceBlockBytes});
  return {rootFile:file,files:[file],fileIndexes:new Map([[file,index]]),graph:{includeOccurrences:[],includeOccurrencesComplete:true}};
 }
 it('uses initialized CONTACT counts and repeats DRAWBEAD only NBEAD times in four formats',()=>{
  for(const format of ['standard','comma','long','i10']){
   for(const keyword of fixed){
    const count=keyword.includes('FORMING_')?3:4,rows=Array(count+1).fill(render(Array(8).fill(0),format));
    const context=nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows,'standard');
    assert.deepEqual(context.select()?.current.map(row=>row.cardIndex),[...Array.from({length:count},(_,index)=>index+1),0],keyword+'/'+format);
    assert.equal(context.readInput,format==='long'?'long':'standard');
    assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows.slice(0,count-1),'standard').select(),null);
   }
   for(const count of [0,2]){
    const rows=[...Array(3).fill(render(Array(8).fill(0),format)),render([73,73,0,0,0,0,0,count],format),
     ...Array(count).fill(render([73,73,0,0],format)),render([73,73,0,0],format)];
    const context=nativeFileReadContext(rule('CONTACT_DRAWBEAD'),'*CONTACT_DRAWBEAD'+marker(format),rows,'standard');
    assert.deepEqual(context.select()?.current.map(row=>row.cardIndex),[1,2,3,4,...Array(count).fill(5),0]);
    assert.equal(context.readInput,format==='long'?'long':'standard');
   }
  }
 });
 for(const format of ['standard','comma','long','i10'])for(const maxReferenceBlockBytes of [undefined,1]){
  it(`queries true CONTACT owners through ordinary and disk paths with same-ID target isolation (${format}, ${maxReferenceBlockBytes === 1 ? 'disk' : 'ordinary'})`,async()=>{
   const lines=['*KEYWORD','*NODE','73,0,0,0','*DEFINE_CURVE','73','0,0','1,1',
    '*DEFINE_FUNCTION','73','f(x)=x','*DEFINE_TABLE_2D','73','0,0',
    '*PART','part','73,0,0,0,0,0,0,0','*DEFINE_BOX','73,0,1,0,1,0,1'];
   const expected={curve:[],node:[],table:[],part:[],box:[]};
   for(const keyword of [...fixed,'CONTACT_DRAWBEAD','CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION',...aliases]){
    const base=keyword.replace(/_(MPP_ID|ID_MPP)$/,''),thermal=base==='CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION',count=base.includes('FORMING_')?3:thermal?5:4;
    lines.push('*'+keyword+marker(format));
    if(aliases.includes(keyword))lines.push(render([81,'alias proof'],format),render(Array(8).fill(0),format));
    for(const field of ['SURFA','SURFB'])expected.part.push(['*'+keyword,field,lines.length]);
    for(const field of ['SABOXID','SBBOXID'])expected.box.push(['*'+keyword,field,lines.length]);
    lines.push(render([73,73,3,3,73,73,0,0],format));
    expected.table.push(['*'+keyword,'FD',lines.length]);lines.push(render([2,73,0,0,0,0,0,0],format));
    expected.curve.push(['*'+keyword,'SFSA',lines.length]);lines.push(render([-73,0,0,0,0,0,0,0],format));
    if(count===4){
     const draw=base==='CONTACT_DRAWBEAD',fields=draw?['LCIDRF','LCIDNF']:['LCID','LCDC','UNLCID'];
     for(const field of fields)expected.curve.push(['*'+keyword,field,lines.length]);
     lines.push(render(draw?[73,73,0,0,0,0,0,2]:[73,0,0,0,73,0,73],format));
     if(draw)for(let row=0;row<2;row++){
      for(const field of ['POINT1','POINT2'])expected.node.push(['*'+keyword,field,lines.length]);
      lines.push(render([73,73,0,0],format));
     }
    }
    if(thermal){
     lines.push(render(Array(8).fill(0),format));
     for(const field of ['LCFST','LCFDT','a','b','c','d','LCH'])expected.curve.push(['*'+keyword,field,lines.length]);
     lines.push(render([73,73,0,73,73,73,73,73],format));
    }
    // The next alias row is a genuine optional card, not another point/rigid row.
    lines.push(render(aliases.includes(keyword)?Array(8).fill(0):Array(8).fill(73),format));
   }
   lines.push('*END');const snapshot=await indexed(lines,maxReferenceBlockBytes);
   for(const kind of ['curve','node','table','part','box','function']){
    const result=await queryIndexedEntityId({snapshot,id:73,targetKind:kind});
    const actual=result.locations.filter(row=>row.role==='reference'&&row.keyword.startsWith('*CONTACT_')).map(row=>[row.keyword,row.fieldName,row.line]);
    assert.deepEqual(actual,expected[kind]||[],JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons}));
    const gaps=(result.referenceIndex?.registryReferenceCoverageGaps||[]).filter(gap=>
     gap.keyword?.startsWith('*CONTACT_')&&coverageGapMatches({targetKinds:[kind]},gap)&&
      !result.referenceLookup?.resolvedGaps.has(gap));
    assert.equal(gaps.length,0,JSON.stringify({format,maxReferenceBlockBytes,kind,gaps:gaps.map(gap=>({keyword:gap.keyword,reason:gap.reason}))}));
   }
  });
 }
 it('keeps unknown NBEAD and unsafe fractional reference IDs partial',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1]){
   const snapshot=await indexed(['*KEYWORD','*NODE','73,0,0,0','*CONTACT_DRAWBEAD','0,0,0,0,0,0,0,0',
    '0,0,0,0,0,0,0,0','0,0,0,0,0,0,0,0','0,0,0,0,0,0,0,&COUNT','73,73,0,0','*END'],maxReferenceBlockBytes);
   const result=await queryIndexedEntityId({snapshot,id:73,targetKind:'node'});
   assert.ok(['partial','incomplete'].includes(result.state));assert.equal(result.locations.filter(row=>row.role==='reference'&&row.keyword==='*CONTACT_DRAWBEAD').length,0);
   const fractional=await indexed(['*KEYWORD','*DEFINE_CURVE','73','0,0','1,1',
    '*CONTACT_FORMING_NODES_TO_SURFACE','0,0,0,0,0,0,0,0','0,0,0,0,0,0,0,0','-73.5,0,0,0,0,0,0,0','*END'],maxReferenceBlockBytes);
   const unsafe=await queryIndexedEntityId({snapshot:fractional,id:73,targetKind:'curve'});
   assert.ok(['partial','incomplete'].includes(unsafe.state));
   assert.equal(unsafe.locations.filter(row=>row.role==='reference'&&row.keyword==='*CONTACT_FORMING_NODES_TO_SURFACE').length,0);
  }
 });
 it('queries FD only under the native FS gate and separates table, friction and coefficient values',async()=>{
  for(const format of ['standard','comma','long','i10'])for(const cap of [undefined,1]){
   const lines=['*KEYWORD','*DEFINE_TABLE_2D','73','0,0','*DEFINE_FRICTION'+marker(format),render([73,0,0,0,0,0],format),
    render([73,0,0,0,0,0,0,0],format),'*DEFINE_FRICTION_TITLE'+marker(format),'manual-confirmed friction',render([73,0,0,0,0,0],format),
    render([73,0,0,0,0,0,0,0],format),'*DEFINE_FRICTION_SCALING'+marker(format),render([73,0,0,0,0],format),
    '*NODE','73,0,0,0','*DEFINE_CURVE','73','0,0','1,1','*DEFINE_FUNCTION','73','f(t)=1'];
   const expected={table:[],friction:[]};
   for(const [fs,kind]of [[0,null],[1,null],[-1,null],[2,'table'],[-2,'friction'],
    [1.999999,'table'],[-1.999999,'friction'],[2.000002,null],[-2.000002,null],['&FS',null]]){
    lines.push('*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE'+marker(format),render(Array(8).fill(0),format));
    if(kind)expected[kind].push(['FD',lines.length]);
    lines.push(render([fs,73,0,0,0,0,0,0],format),render(Array(8).fill(0),format));
   }
   lines.push('*END');const snapshot=await indexed(lines,cap);
   for(const kind of ['table','friction','node','curve','function']){
    const result=await queryIndexedEntityId({snapshot,id:73,targetKind:kind});
    const refs=result.locations.filter(row=>row.role==='reference'&&row.keyword==='*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE');
    assert.deepEqual(refs.map(row=>[row.fieldName,row.line]),expected[kind]||[],JSON.stringify({format,cap,kind,reasons:result.reasons}));
    if(kind==='friction')assert.deepEqual(result.locations.filter(row=>row.role==='definition').map(row=>row.keyword),
     ['*DEFINE_FRICTION','*DEFINE_FRICTION_TITLE'],'The same-ID SCALING object belongs to another native namespace');
    if(expected[kind])assert.ok(['partial','incomplete'].includes(result.state),'Unresolved FS remains unknown');
   }
  }
 });
 it('queries MPP prefix and global optional references for every verified alias and FORCE owner',async()=>{
  const force=['CONTACT_FORCE_TRANSDUCER','CONTACT_FORCE_TRANSDUCER_CONSTRAINT','CONTACT_FORCE_TRANSDUCER_PENALTY'];
  for(const format of ['standard','comma','long','i10'])for(const maxReferenceBlockBytes of [undefined,1]){
   const lines=['*KEYWORD','*DEFINE_CURVE','73','0,0','1,1','*DEFINE_FUNCTION','73','f(x)=x',
    '*DEFINE_COORDINATE_SYSTEM','73,0,0,0,0,0,0,0','*DEFINE_REGION','73,0,0,0,0,0,0,0'];
   const expected={curve:[],'coordinate-system':[],region:[]};
   for(const keyword of [...aliases,...force]){
    lines.push('*'+keyword+marker(format));
    if(aliases.includes(keyword)){
     lines.push(render([81,'alias'],format));expected.curve.push(['*'+keyword,'LCBCKT',lines.length]);
     lines.push(render([0,0,73,0,0,0,0,0],format));
    }
    const draw=keyword.startsWith('CONTACT_DRAWBEAD');
    for(let row=0;row<(force.includes(keyword)?3:4);row++)lines.push(render(row===3&&draw?[0,0,0,0,0,0,0,2]:Array(8).fill(0),format));
    if(draw)lines.push(render([0,0,0,0],format),render([0,0,0,0],format));
    for(const field of ['LCIDAB','DEPTH','BSORT'])expected.curve.push(['*'+keyword,field,lines.length]);
    lines.push(render([0,0,73,0,0,-73,-73,0],format),render(Array(8).fill(0),format));
    for(const field of ['DPRFAC','DTSTIF'])expected.curve.push(['*'+keyword,field,lines.length]);
    expected['coordinate-system'].push(['*'+keyword,'CID_RCF',lines.length]);
    lines.push(render([0,0,-73,-73,0,0,0,73],format),render(Array(8).fill(0),format));
    expected.region.push(['*'+keyword,'REGION',lines.length]);
    lines.push(render([0,0,0,0,0,0,0,73],format),render(Array(8).fill(0),format),render([0,0],format));
   }
   lines.push('*END');const snapshot=await indexed(lines,maxReferenceBlockBytes);
   for(const kind of ['curve','coordinate-system','region','function']){
    const result=await queryIndexedEntityId({snapshot,id:73,targetKind:kind});
    const actual=result.locations.filter(item=>item.role==='reference'&&item.keyword.startsWith('*CONTACT_'))
     .map(item=>[item.keyword,item.fieldName,item.line]);
    assert.deepEqual(actual,expected[kind]||[],JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons}));
    const gaps=(result.referenceIndex?.registryReferenceCoverageGaps||[]).filter(gap=>gap.keyword?.startsWith('*CONTACT_')&&
     coverageGapMatches({targetKinds:[kind]},gap)&&!result.referenceLookup?.resolvedGaps.has(gap));
    assert.equal(gaps.length,0,JSON.stringify({format,maxReferenceBlockBytes,kind,gaps}));
   }
  }
 });
});
