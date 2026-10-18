'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {trackTempDirectories}=require('../../support/tempDirectories');
const {getCatalogInputFormCatalogV4}=require("../../../src/core/semantics/catalogInputFormCatalogV4");
const {nativeFileReadContext}=require('../../../src/core/semantics/nativeFileReadContext');
const {nativeFileLayoutKind}=require("../../../src/core/semantics/catalogNativeFileLayout");
const {buildFileIndex}=require('../../../src/core/scanner/fileIndexBuilder');
const {queryIndexedEntityId}=require('../../../src/core/references/indexedEntityQuery');

describe('native conditional file references',function(){
 this.timeout(30000);
 const tempDirectory=trackTempDirectories();
 const render=(values,format)=>format==='comma'?values.join(','):values.map(value=>String(value).padStart(format==='long'?20:10)).join('');
 const marker=format=>format==='long'?' +':format==='i10'?' %':'';
 function rule(keyword,kind='controlled-reference-records'){
  const form=getCatalogInputFormCatalogV4().formForKeyword(keyword,false);
  const rules=form.reference.formRuleIds.map(id=>({...form.rules[id],catalogSource:form.source})).filter(r=>nativeFileLayoutKind(r,keyword)===kind);
  assert.equal(rules.length,1,keyword);return rules[0];
 }
 async function query(lines,kind,maxReferenceBlockBytes,id=73){
  const directory=tempDirectory(path.join(os.tmpdir(),'dynasense-conditional-file-')),file=path.join(directory,'model.k');
  fs.writeFileSync(file,lines.join('\n'));
  const index=await buildFileIndex(file,{maxReferenceBlockBytes});
  return queryIndexedEntityId({snapshot:{rootFile:file,files:[file],fileIndexes:new Map([[file,index]]),
   graph:{includeOccurrences:[],includeOccurrencesComplete:true}},id,targetKind:kind});
 }
 it('uses the same bounded instance boundaries as 100 actual native conditional reads',()=>{
  for(const format of ['standard','comma','long','i10']){
   const icfd=[],icfdExpected=[];
   for(const dens of [0,1,2,3])for(const hvac of [0,1,2]){
    icfd.push(render([1,2,dens,73,hvac],format),render(Array(8).fill(0),format));icfdExpected.push(1,2);
    if(dens===2){icfd.push(render(Array(8).fill(73),format));icfdExpected.push(3);}
    if(hvac===1){icfd.push(render(Array(8).fill(0),format));icfdExpected.push(4);}
   }
   const a= nativeFileReadContext(rule('ICFD_MODEL_SPECIES_TRANSPORT'),'*ICFD_MODEL_SPECIES_TRANSPORT'+marker(format),icfd,'standard').select();
   assert.deepEqual(a?.current.map(r=>r.cardIndex),icfdExpected,format);
   const group=[],groupExpected=[];
   for(let ptype=0;ptype<=9;ptype++){
    group.push(render([73,0,ptype,73,73,0,0,73],format),render(Array(8).fill(0),format));
    groupExpected.push(({3:2,4:3,5:4,6:5,7:6,9:7})[ptype]||1,8);
    if(ptype===9){group.push(render([73,0],format));groupExpected.push(9);}
   }
   const b=nativeFileReadContext(rule('ALE_REFERENCE_SYSTEM_GROUP'),'*ALE_REFERENCE_SYSTEM_GROUP'+marker(format),group,'standard').select();
   assert.deepEqual(b?.current.map(r=>r.cardIndex),groupExpected,format);
   const up=[],upExpected=[];
   for(const upid of [0,1,-1]){
    up.push(render([upid,1.5],format),render(Array(8).fill(0),format));upExpected.push(1,2);
    if(upid===0){up.push(render([73,0,0,0],format));upExpected.push(3);}
   }
   const c=nativeFileReadContext(rule('ALE_UP_SWITCH'),'*ALE_UP_SWITCH'+marker(format),up,'standard').select();
   assert.deepEqual(c?.current.map(r=>r.cardIndex),upExpected,format);
  }
 });
 it('matches 96 original porous and Windkessel reads including an in-place header reparse',()=>{
  const porous={3:[1,3],10:[1,3],4:[1,4,7,8],6:[1,4,7,8],7:[1,4,7,9],5:[1,5,7,9],11:[1,6]};
  for(const format of ['standard','comma','long','i10'])for(let type=0;type<=11;type++){
   for(const keyword of ['ICFD_MODEL_POROUS','ICFD_BOUNDARY_WINDKESSEL']){
    const expected=keyword==='ICFD_MODEL_POROUS'?(porous[type]||[1,2]):[type===1||type===2?3:type===9||type===10?4:1,2];
    const rows=[render([1,type,0,0,0,0,0,0],format),...Array(3).fill(render(Array(8).fill(0),format))];
    const context=nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows,'standard');
    assert.deepEqual(context.select()?.current.map(r=>r.cardIndex),[...expected,...Array(4-expected.length).fill(0)],JSON.stringify({format,type,keyword}));
    if(keyword==='ICFD_MODEL_POROUS'||[3,4,9,10].includes(type))
     assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows.slice(0,expected.length-1),'standard').select(),null);
    else assert.deepEqual(nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows.slice(0,1),'standard').select()?.current.map(r=>r.cardIndex),[expected[0]]);
   }
  }
  for(const keyword of ['ICFD_MODEL_POROUS','ICFD_BOUNDARY_WINDKESSEL'])
   assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword,['1,&TYPE,0,0,0','0,0,0,0,0'],'standard').select(),null);
 });
 it('trims shared AIRBAG and SCC pools while preserving mixed I10 integer/real widths',()=>{
  const {readRecordField}=require('../../../src/core/edit/keywordRecordSerializer');
  for(const format of ['standard','comma','long','i10'])for(const keyword of [
   'AIRBAG_REFERENCE_GEOMETRY_BIRTH_RDT','AIRBAG_REFERENCE_GEOMETRY_RDT_BIRTH',
   'AIRBAG_SHELL_REFERENCE_GEOMETRY','AIRBAG_SHELL_REFERENCE_GEOMETRY_RDT','MAT_236','MAT_SCC_ON_RCC']){
   const kind=keyword.startsWith('AIRBAG_REFERENCE_')?'reference-tail':'reference-fixed',native=rule(keyword,kind);
   const empty=nativeFileReadContext(native,'*'+keyword+marker(format),[],'standard');
   const body=[...empty.cards.values()].map(card=>card.fields.map((field,index)=>field.type===1?73+index:73.25+index));
   const sequence=kind==='reference-tail'?[1,2,2]:keyword.startsWith('MAT_')?[1,2,1,2]:[1,1];
   const rows=sequence.map(card=>{
    const values=body[card-1],fields=empty.cards.get(card).fields;
    if(format==='comma')return values.join(',');
    return values.map((value,index)=>String(value).padStart(format==='long'?20:
     format==='i10'&&fields[index].type===1?Math.max(10,fields[index].width):fields[index].width)).join('');
   });
   const context=nativeFileReadContext(native,'*'+keyword+marker(format),rows,'standard');
   assert.deepEqual(context.select()?.current.map(record=>record.cardIndex),sequence,JSON.stringify({keyword,format}));
   for(let row=0;row<rows.length;row++)for(let field=0;field<body[sequence[row]-1].length;field++)
    assert.equal(Number(readRecordField(rows[row],context.cards.get(sequence[row]).fields,field,format==='comma'?'comma':context.readInput)),
     body[sequence[row]-1][field],JSON.stringify({keyword,format,row,field}));
  }
 });
 it('decodes a deferred spotweld row only after OPT and ignores a second numeric material payload',()=>{
  for(const format of ['standard','comma','long','i10'])for(const keyword of [
   'MAT_100_DAMAGE','MAT_SPOTWELD_DAMAGE_FAILURE','MAT_SPOTWELD_DAMAGE-FAILURE','MAT_SPOTWELD_DAMAGE-FAILURE_UNIAXIAL'])
   for(const opt of [0,11,11.75,12])for(const damage of [0,-1]){
    const rows=[render([1,1,1,0.3,0,0,0,0],format),render([1,73,73],format),render([1,opt,0,0,0,0,0,damage],format)],
     expected=[1,opt===11?8:opt===11.75?7:opt===12?4:2,9];
    if(damage===-1){rows.push(render([0,0,0,0],format));expected.push(10);}
    if(opt===12){rows.push(render(Array(8).fill(0),format),render(Array(8).fill(0),format));expected.push(11,12);}
    rows.push(render([2,1,1,0.3,0,0,0,0],format),render([1,73,73],format),render([1,22,0,0,0,0,0,-1],format));
    const context=nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows,'standard');
    assert.deepEqual(context.select()?.current.map(record=>record.cardIndex),[...expected,0,0,0],JSON.stringify({keyword,format,opt,damage}));
    assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows.slice(0,2),'standard').select(),null);
   }
  const keyword='MAT_SPOTWELD_DAMAGE_FAILURE';
  for(const opt of ['&OPT','<OPT>','0xB'])assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword,
   ['1,1,1,0.3,0,0,0,0','1,73,73',`1,${opt},0,0,0,0,0,0`],'standard').select(),null);
  assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword+' +',
   [render([1,1,1,0.3,0,0,0,0],'long'),render(Array(8).fill(73),'long'),render([1,11,0,0,0,0,0,0],'long')],'standard').select(),null);
 });
 it('matches the enhanced blast single-instance reader and native I10 filtering',()=>{
  for(const format of ['standard','comma','long','i10'])for(const blast of [0,2,3,4]){
   const rows=[render([1,1,0,0,0,0,2,blast],format),render([1,1,1,1,73,0,0],format)],expected=[1,2];
   if(blast===3){rows.push(render([1,70,1,73],format));expected.push(3);}
   if(blast===4){rows.push(render([73,73,0,0,0,0],format));expected.push(4);}
   const native=rule('LOAD_BLAST_ENHANCED'),context=nativeFileReadContext(native,'*LOAD_BLAST_ENHANCED'+marker(format),
    [...rows,render(Array(8).fill(73),format)],'standard');
   assert.deepEqual(context.select()?.current.map(r=>r.cardIndex),[...expected,0],JSON.stringify({format,blast}));
   assert.equal(context.readInput,format==='long'?'long':'standard');
   assert.equal(nativeFileReadContext(native,'*LOAD_BLAST_ENHANCED'+marker(format),rows.slice(0,-1),'standard').select(),null);
  }
  assert.equal(nativeFileReadContext(rule('LOAD_BLAST_ENHANCED'),'*LOAD_BLAST_ENHANCED',
   ['1,1,0,0,0,0,2,&BLAST','1,1,1,1,73,0,0'],'standard').select(),null);
 });
 it('selects transform and cross-section templates on the original physical row',()=>{
  for(const format of ['standard','comma','long','i10']){
   for(const keyword of ['DEFINE_TRANSFORM','DEFINE_TRANSFORMATION']){
    const rows=[render([1],format),render(['ROTATE3NA',73,73,73,0],format),
     render(['MATRIX',0,0,0,0,0,0,0],format),render(Array(8).fill(73),format),render(Array(8).fill(73),format),
     render(['rotate3na',73,73,73,0],format),render(['ROTATE3NAx',73,73,73,0],format),render(['POS6N',73,73,73,73,73,73,0],format)];
    const context=nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows,'standard');
    assert.deepEqual(context.select()?.current.map(record=>record.cardIndex),[1,5,2,3,4,5,2,2],JSON.stringify({keyword,format}));
    assert.equal(context.readInput,format==='long'?'long':'standard');
    assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows.slice(0,3),'standard').select(),null);
    assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),[rows[0],render(['&OPTION',73,73,73],format)],'standard').select(),null);
   }
   for(const keyword of ['DATABASE_CROSS_SECTION_PLANE','DATABASE_CROSS_SECTION_PLANE_ID',
    'DATABASE_CROSS_SECTION_SET','DATABASE_CROSS_SECTION_SET_ID']){
    const plane=keyword.includes('_PLANE'),rows=[],expected=[];
    for(const radius of [-1,0,1]){
     if(keyword.endsWith('_ID')){rows.push(render([1,'synthetic'],format));expected.push(1);}
     rows.push(render([0,73,0,0,73,0,0,radius],format));expected.push(plane&&radius<0?4:2);
     if(plane){rows.push(render([0,0,0,0,0,0,0],format));expected.push(3);}
    }
    const context=nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows,'standard');
    assert.deepEqual(context.select()?.current.map(record=>record.cardIndex),expected,JSON.stringify({keyword,format}));
    assert.equal(context.readInput,format==='long'?'long':'standard');
    if(plane)assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows.slice(0,-1),'standard').select(),null);
   }
  }
  assert.equal(nativeFileReadContext(rule('DATABASE_CROSS_SECTION_PLANE'),'*DATABASE_CROSS_SECTION_PLANE',
   ['0,73,0,0,73,0,0,&RADIUS','0,0,0,0,0,0,0'],'standard').select(),null);
 });
 it('queries in-place transform and negative-radius nodes after repeated and matrix records',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*NODE','73,0,0,0','*MAT_ELASTIC','73,1,1,0.3'],expected=[];
   for(const keyword of ['DEFINE_TRANSFORM','DEFINE_TRANSFORMATION']){
    lines.push('*'+keyword+marker(format),render([1],format),render(['TRANSL',73,73,73],format),
     render(['MATRIX',0,0,0,0,0,0,0],format),render(Array(8).fill(73),format),render(Array(8).fill(73),format));
    for(const option of ['ROTATE3NA','rotate3na','ROTATE3NAx']){
     const line=lines.length;lines.push(render([option,73,73,73,0],format));
     if(option.toUpperCase()==='ROTATE3NA')expected.push(...['A1','A2','A3'].map(field=>['*'+keyword,field,line]));
    }
    for(const option of ['POS6N','TRANSL2ND','POS6P','POINT','POS6Nx']){
     const line=lines.length;lines.push(render([option,73,73,73,73,73,73,0],format));
     const count=option==='POS6N'?6:option==='TRANSL2ND'?2:0;
     for(let field=1;field<=count;field++)expected.push(['*'+keyword,`A${field}`,line]);
    }
   }
   for(const keyword of ['DATABASE_CROSS_SECTION_PLANE','DATABASE_CROSS_SECTION_PLANE_ID']){
    lines.push('*'+keyword+marker(format));
    for(const radius of [1,-1,0,-1]){
     if(keyword.endsWith('_ID'))lines.push(render([1,'synthetic'],format));
     const line=lines.length;lines.push(render([0,73,0,0,73,0,0,radius],format),render([0,0,0,0,0,0,0],format));
     if(radius<0)expected.push(...['NID1','NID2'].map(field=>['*'+keyword,field,line]));
    }
   }
   lines.push('*END');const result=await query(lines,'node',maxReferenceBlockBytes);
   assert.deepEqual(result.locations.filter(row=>row.role==='reference').map(row=>[row.keyword,row.fieldName,row.line]).sort(),expected.sort(),
    JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons,locations:result.locations}));
  }
 });
 it('selects inelastic LAW/MODEL payloads and every volume container in all native formats',()=>{
  for(const format of ['standard','comma','long','i10']){
   for(const orientation of [0,1])for(const law of [3,5,6])for(const model of [1,2,3,4,5,7]){
    const payload=law===3?({1:6,2:7})[model]:law===5?(model<=2?8:({3:9,4:10})[model]):
     model<=3?11:({4:9,5:10})[model];
    const rows=[render([1,1,0,0,0,orientation,1,0],format)],expected=[1];
    if(orientation>0){rows.push(render(Array(6).fill(0),format),render(Array(6).fill(0),format));expected.push(2,3);}
    rows.push(render([1,1],format),render([law,model],format));expected.push(4,5);
    if(payload){rows.push(render(Array(8).fill(73),format));expected.push(payload);}
    const context=nativeFileReadContext(rule('MAT_ADD_INELASTICITY'),'*MAT_ADD_INELASTICITY'+marker(format),rows,'standard');
    assert.deepEqual(context.select()?.current.map(record=>record.cardIndex),expected,JSON.stringify({format,orientation,law,model}));
    if(payload)assert.equal(nativeFileReadContext(rule('MAT_ADD_INELASTICITY'),'*MAT_ADD_INELASTICITY'+marker(format),rows.slice(0,-1),'standard').select(),null);
   }
   const rows=[render([1,2,0,0,0,1,1,0],format),render(Array(6).fill(0),format),render(Array(6).fill(0),format),
    render([2,1],format),render([3,2],format),render(Array(8).fill(73),format),render([3,1],format),render(Array(8).fill(73),format),
    render([1,1],format),render([3,2],format),render(Array(8).fill(73),format),render(Array(8).fill(73),format)];
   assert.deepEqual(nativeFileReadContext(rule('MAT_ADD_INELASTICITY'),'*MAT_ADD_INELASTICITY'+marker(format),rows,'standard')
    .select()?.current.map(record=>record.cardIndex),[1,2,3,4,5,7,5,6,4,5,7,0],format);
   const volume=[render([0,0,0,3],format)],expected=[1];
   for(const type of [0,1,2,3,4,5,6,7,0,7]){
    volume.push(render([type,0,0,0,0,0,0,0],format));expected.push(2);
    if(type){volume.push(render(Array(8).fill(73),format));expected.push(type+2);}
   }
   assert.deepEqual(nativeFileReadContext(rule('INITIAL_VOLUME_FRACTION_GEOMETRY'),'*INITIAL_VOLUME_FRACTION_GEOMETRY'+marker(format),volume,'standard')
    .select()?.current.map(record=>record.cardIndex),expected,format);
   assert.equal(nativeFileReadContext(rule('INITIAL_VOLUME_FRACTION_GEOMETRY'),'*INITIAL_VOLUME_FRACTION_GEOMETRY'+marker(format),volume.slice(0,-1),'standard').select(),null);
  }
  for(const [keyword,rows] of [['MAT_ADD_INELASTICITY',['1,&COUNT,0,0,0,0,1,0']],
   ['MAT_ADD_INELASTICITY',['1,1,0,0,0,&AOPT,1,0']],
   ['INITIAL_VOLUME_FRACTION_GEOMETRY',['0,0,0,3','&TYPE,0,0,0,0,0,0,0']]])
   assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword,rows,'standard').select(),null,keyword);
 });
 it('queries repeated inelastic curve payloads and volume function payloads in memory and on disk',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1',
    '*DEFINE_FUNCTION','73','f(x)=x','*MAT_ELASTIC','73,1,1,0.3','*MAT_ADD_INELASTICITY'+marker(format),
    render([1,2,0,0,0,1,1,0],format),render(Array(6).fill(0),format),render(Array(6).fill(0),format),render([2,1],format),render([3,2],format)],curves=[];
   curves.push(lines.length);lines.push(render(Array(8).fill(73),format),render([3,1],format),render(Array(8).fill(73),format),
    render([1,1],format),render([3,2],format));curves.push(lines.length);
   lines.push(render(Array(8).fill(73),format),render(Array(8).fill(73),format),
    '*INITIAL_VOLUME_FRACTION_GEOMETRY'+marker(format),render([0,0,0,3],format));
   const functions=[];
   for(const type of [0,6,7,0,3,7]){
    lines.push(render([type,0,0,0,0,0,0,0],format));
    if(type){if(type===7)functions.push(lines.length);lines.push(render(Array(8).fill(73),format));}
   }
   lines.push('*END');
   for(const [kind,keyword,field,expected] of [['curve','*MAT_ADD_INELASTICITY','P1',curves],
    ['function','*INITIAL_VOLUME_FRACTION_GEOMETRY','IDFUNC',functions]]){
    const result=await query(lines,kind,maxReferenceBlockBytes);
    assert.deepEqual(result.locations.filter(row=>row.role==='reference'&&row.keyword===keyword).map(row=>[row.fieldName,row.line]),
     expected.map(line=>[field,line]),JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons}));
   }
  }
 });
 it('retains every optional CONTACT prefix and scans its final partial prefix at EOF',async()=>{
  const keyword='CONTACT_AUTOMATIC_SURFACE_TO_SURFACE';
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1'],expected=[];
   const native=rule(keyword,'contact-optional-records');
   for(let optional=0;optional<=7;optional++){
    const rows=[render([0,0,0,0,0,0,0,0],format),render(Array(8).fill(0),format),render(Array(8).fill(0),format)];
    for(let index=0;index<optional;index++)rows.push(render(index===0?[2,0,0,0,0,0,-73,0]:
     index===2?[0,0,-73,-73,0,0,0,0]:Array(8).fill(0),format));
    assert.deepEqual(nativeFileReadContext(native,'*'+keyword+marker(format),rows,'standard').select()?.current.map(record=>record.cardIndex),
     Array.from({length:3+optional},(_,index)=>index+1),`${format}/${optional}`);
    lines.push('*'+keyword+marker(format));const start=lines.length;lines.push(...rows);
    if(optional>=1)expected.push(['BSORT',start+3]);
    if(optional>=3)expected.push(['DPRFAC',start+5],['DTSTIF',start+5]);
   }
   const result=await query([...lines,'*END'],'curve',maxReferenceBlockBytes);
   assert.deepEqual(result.locations.filter(row=>row.role==='reference'&&row.keyword==='*'+keyword).map(row=>[row.fieldName,row.line]),expected,
    JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons}));
   assert.equal(nativeFileReadContext(native,'*'+keyword+marker(format),[render(Array(8).fill(0),format)],'standard').select(),null);
  }
 });
 it('keeps the explicitly unused CPG slot out of chamber references while retaining neighboring node references',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*NODE','73,0,0,0','*DEFINE_CPM_CHAMBER','73,0,0,0,0,0,0,0'],expected=[];
   for(const keyword of ['AIRBAG_CPG','AIRBAG_CPG_ID']){
    lines.push('*'+keyword+marker(format));if(keyword.endsWith('_ID'))lines.push(render([1,'fixture'],format));
    lines.push(render([0,0,0,0,0,0,0,0],format),render([0,0,0,0,0,0,0,0],format));
    expected.push(['*'+keyword,'NID1',lines.length]);
    lines.push(render([0,0,0,73,0,0,73,0],format),render(Array(8).fill(0),format));
   }
   lines.push('*END');const nodes=await query(lines,'node',maxReferenceBlockBytes);
   assert.deepEqual(nodes.locations.filter(row=>row.role==='reference'&&row.keyword.startsWith('*AIRBAG_CPG')).map(row=>[row.keyword,row.fieldName,row.line]),expected,
    JSON.stringify({format,maxReferenceBlockBytes,reasons:nodes.reasons}));
   const chamber=await query(lines,'cpm-chamber-define',maxReferenceBlockBytes);
   assert.equal(chamber.locations.filter(row=>row.role==='reference'&&row.keyword.startsWith('*AIRBAG_CPG')).length,0,
    JSON.stringify({format,maxReferenceBlockBytes,reasons:chamber.reasons}));
  }
 });
 it('keeps CONTACT signed roles, coordinates and regions separate across optional records',async()=>{
  const keyword='CONTACT_AUTOMATIC_SURFACE_TO_SURFACE';
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1',
    '*DEFINE_FUNCTION','73','f(x)=x','*MAT_ELASTIC','73,1,1,0.3',
    '*DEFINE_COORDINATE_SYSTEM','73,0,0,0,1,0,0,0','0,1,0',
    '*DEFINE_REGION','73,0,0,0,0,0,0,0'],curves=[],coordinates=[],regions=[];
   for(const soft of [0,1,2]){
    lines.push('*'+keyword+marker(format));const start=lines.length;
    lines.push(...Array(3).fill(render(Array(8).fill(0),format)),
     render([soft,0,0,0,0,-73,-73,0],format),render(Array(8).fill(0),format),
     render([0,0,-73,-73,0,0,0,73],format),render(Array(8).fill(0),format),
     render([0,0,0,0,0,0,0,73],format));
    curves.push(['BSORT',start+3],['DEPTH',start+3],['DPRFAC',start+5],['DTSTIF',start+5]);
    coordinates.push(['CID_RCF',start+5]);regions.push(['REGION',start+7]);
   }
   lines.push('*END');
   for(const [kind,expected] of [['curve',curves],['coordinate-system',coordinates],['region',regions],['function',[]],['material',[]]]){
    const result=await query(lines,kind,maxReferenceBlockBytes);
    assert.deepEqual(result.locations.filter(row=>row.role==='reference'&&row.keyword==='*'+keyword).map(row=>[row.fieldName,row.line]).sort(),
     expected.sort(),JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons}));
   }
   for(const [soft,lcidab,depth,dprfac,dtstif,expected] of [['&SOFT',0,-73,0,0,['DEPTH']],
    [0,73,0,0,0,['LCIDAB']],[2,0,-73,0,0,['DEPTH']],[0,0,0,-73,-73,['DPRFAC','DTSTIF']],
    [0,0,0,'-7.3e1','-7.3e1',['DPRFAC','DTSTIF']],
    [0,0,'&DEPTH',0,0,[]],[0,0,'<DEPTH>',0,0,[]],[0,0,0,0,-73.5,[]]]){
    const unknown=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1',
     '*'+keyword+marker(format),...Array(3).fill(render(Array(8).fill(0),format)),
     render([soft,0,lcidab,0,0,depth,0,0],format),render(Array(8).fill(0),format),
     render([0,0,dprfac,dtstif,0,0,0,0],format),'*END'];
    const result=await query(unknown,'curve',maxReferenceBlockBytes);
    assert.deepEqual(result.locations.filter(row=>row.role==='reference'&&row.keyword==='*'+keyword).map(row=>row.fieldName).sort(),expected.sort());
    if(!expected.length)assert.equal(result.state,'partial',JSON.stringify({format,maxReferenceBlockBytes,soft,dtstif,reasons:result.reasons}));
   }
  }
 });
 it('selects every CPG count-controlled record and repeated instance in four formats',()=>{
  for(const keyword of ['AIRBAG_CPG','AIRBAG_CPG_ID'])for(const format of ['standard','comma','long','i10']){
   const rows=[],expected=[],shift=keyword.endsWith('_ID')?1:0,native=rule(keyword);
   const add=(card,values)=>{rows.push(render(values,format));expected.push(card+shift);};
   for(const count of [0,1,2]){
    if(shift){rows.push(render([count+1,'fixture'],format));expected.push(1);}
    add(1,[0,0,0,0,0,count,0,0]);add(2,[0,0,0,0,0,count,0,0]);add(3,[0,count,count,73,73,73,0,0]);
    for(let i=0;i<count;i++)add(4,Array(8).fill(0));
    for(let i=0;i<count;i++)add(5,[0,0,0,73,73,0,0,0]);add(6,Array(8).fill(0));
    for(let i=0;i<count;i++)add(7,[73,73,0,0,0,0,0,0]);
    for(let i=0;i<count;i++)add(8,[73,0,0,0,0,0,0,0]);
   }
   assert.deepEqual(nativeFileReadContext(native,'*'+keyword+marker(format),rows,'standard').select()?.current.map(row=>row.cardIndex),expected);
   assert.equal(nativeFileReadContext(native,'*'+keyword+marker(format),rows.slice(0,-1),'standard').select(),null);
   const parameter=rows.slice();parameter[shift]=render([0,0,0,0,0,'&COUNT',0,0],format);
   assert.equal(nativeFileReadContext(native,'*'+keyword+marker(format),parameter,'standard').select(),null);
  }
 });
 it('keeps native CONTACT curve selection at minus one separate from fractional solver constants',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','         1','         0         0','         1         1',
    '*DEFINE_FUNCTION','1','f(x)=x'],expected=[];
   for(const value of [-1,-.5,0,1]){
    lines.push('*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE'+marker(format),...Array(3).fill(render(Array(8).fill(0),format)),
     render([0,0,0,0,0,0,0,0],format),render(Array(8).fill(0),format));
    if(value===-1)expected.push(lines.length);
    lines.push(render([0,0,0,value,0,0,0,0],format));
   }
   lines.push('*END');const result=await query(lines,'curve',maxReferenceBlockBytes,1);
   assert.deepEqual(result.locations.filter(row=>row.role==='reference'&&row.fieldName==='DTSTIF').map(row=>row.line),expected);
   const functions=await query(lines,'function',maxReferenceBlockBytes,1);
   assert.equal(functions.locations.filter(row=>row.role==='reference'&&row.keyword.startsWith('*CONTACT')).length,0);
  }
 });
 it('queries repeated CPG node, vent and gas curve records through count-selected disk layouts',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*NODE','73,0,0,0','*DEFINE_CURVE','        73','         0         0','         1         1',
    '*DEFINE_FUNCTION','73','f(x)=x','*MAT_ELASTIC','73,1,1,0.3'],nodes=[],curves=[];
   for(const keyword of ['AIRBAG_CPG','AIRBAG_CPG_ID']){
    lines.push('*'+keyword+marker(format));
    for(const count of [0,1,2]){
     if(keyword.endsWith('_ID'))lines.push(render([count+1,'fixture'],format));
     lines.push(render([0,0,0,0,0,count,0,0],format),render([0,0,0,0,0,count,0,0],format));
     nodes.push(...['NID1','NID2','NID3'].map(field=>['*'+keyword,field,lines.length]));
     lines.push(render([0,count,count,73,73,73,0,0],format));
     for(let i=0;i<count;i++)lines.push(render(Array(8).fill(0),format));
     for(let i=0;i<count;i++){
      curves.push(...['LCT','LCP'].map(field=>['*'+keyword,field,lines.length]));
      lines.push(render([0,0,0,73,73,0,0,0],format));
     }
     lines.push(render(Array(8).fill(0),format));
     for(let i=0;i<count;i++){
      curves.push(...['LCMI','LCTI'].map(field=>['*'+keyword,field,lines.length]));
      lines.push(render([73,73,0,0,0,0,0,0],format));
     }
     for(let i=0;i<count;i++)lines.push(render(Array(8).fill(0),format));
    }
   }
   lines.push('*END');
   for(const [kind,expected] of [['node',nodes],['curve',curves],['function',[]],['material',[]]]){
    const result=await query(lines,kind,maxReferenceBlockBytes);
    assert.deepEqual(result.locations.filter(row=>row.role==='reference'&&row.keyword.startsWith('*AIRBAG_CPG'))
     .map(row=>[row.keyword,row.fieldName,row.line]).sort(),expected.sort(),JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons}));
   }
  }
 });
 for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
  it(`queries CPG part selectors and signed gas and nozzle targets on every repeated record (${format}, ${maxReferenceBlockBytes === 1 ? 'disk' : 'ordinary'})`,async()=>{
   const lines=['*KEYWORD','*PART','fixture','73,0,0,0','*SET_PART_LIST','73','73',
    '*NODE','73,0,0,0','*ELEMENT_SHELL_THICKNESS','73,0,73,73,73,73','1,1,1,1',
    '*SET_SHELL_LIST','73','73','*DEFINE_CPG_GAS_PROPERTIES','73,1,1,1',
    '*DEFINE_CPG_VENT','73,0,0,0','*DEFINE_CURVE','73','0,0','1,1','*DEFINE_FUNCTION','73','f(x)=x'];
   const expected=new Map(['part','part-set','node','element-shell','shell-set','cpg-gas','cpg-vent','curve','function']
    .map(kind=>[kind,[]]));
   for(const keyword of ['AIRBAG_CPG','AIRBAG_CPG_ID']){
    const add=(values,fields=[])=>{for(const [field,kind] of fields)expected.get(kind).push(['*'+keyword,field,lines.length]);
     lines.push(render(values,format));};
    lines.push('*'+keyword+marker(format));
    for(const selector of [0,1])for(const signed of [73,-73]){
     const selected=selector?'part-set':'part';
     if(keyword.endsWith('_ID'))add([1,'fixture']);
     add([73,selector,73,selector,0,2,0,73],[['SID1',selected],['SID2',selected],['SPSID','part-set']]);
     add([0,0,0,0,0,2,0,0]);
     add([0,2,2,73,73,73,0,0],[['NID1','node'],['NID2','node'],['NID3','node']]);
     for(let i=0;i<2;i++)add([73,selector,i?'&DISTANCE':73.5,0,0,0,0,0],[['SIDH',selected]]);
     for(let i=0;i<2;i++)add([73,selector,0,73,73,73,0,0],
      [['SID3',selected],['LCT','curve'],['LCP','curve'],['DVID','cpg-vent']]);
     add([0,0,signed,0,0,0,0,0],signed<0?[['XMAIR','cpg-gas']]:[]);
     for(let i=0;i<2;i++)add([73,73,signed,0,0,0,0,0],
      [['LCMI','curve'],['LCTI','curve'],...(signed<0?[['XMI','cpg-gas']]:[])]);
     for(let i=0;i<2;i++)add([signed,0,0,0,0,0,0,0],[['SSIDI',signed<0?'shell-set':'element-shell']]);
    }
   }
   lines.push('*END');
   for(const [kind,locations] of expected){
    const result=await query(lines,kind,maxReferenceBlockBytes);
    assert.deepEqual(result.locations.filter(row=>row.role==='reference'&&row.keyword.startsWith('*AIRBAG_CPG'))
     .map(row=>[row.keyword,row.fieldName,row.line]).sort(),locations.sort(),
     JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons}));
    assert.equal(result.referenceIndex.registryReferenceOccurrences.filter(row=>row.fieldName==='HLENV').length,0);
   }
  });
 }
 it('queries EM connection header targets and signed curve/function selection without namespace collisions',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1',
    '*DEFINE_FUNCTION','73','f(x)=x','*EM_ISOPOTENTIAL','73,1,0,0','*EM_RANDLES_MESHLESS','73,0',
    ...Array(4).fill('0,0,0,0,0,0,0,0')],curves=[],functions=[],randles=[],iso=[];
   for(let type=1;type<=7;type++)for(const value of [73,-73,0]){
    lines.push('*EM_ISOPOTENTIAL_CONNECT'+marker(format));const line=lines.length;
    lines.push(render([1,type,73,73,0,value,0,0],format));
    if(type===6)lines.push(render([0,0,0],format));
    iso.push(['ISOID1',line],['ISOID2',line]);
    if([2,3,4].includes(type)&&value===73)curves.push(['LCID_RDLID',line]);
    if([2,3,4].includes(type)&&value===-73)functions.push(['LCID_RDLID',line]);
    if(type===5&&value===73)randles.push(['LCID_RDLID',line]);
   }
   lines.push('*END');
   for(const [kind,expected] of [['curve',curves],['function',functions],['em-randles-meshless',randles],['em-isopot',iso]]){
    const result=await query(lines,kind,maxReferenceBlockBytes);
    assert.deepEqual(result.locations.filter(row=>row.role==='reference'&&row.keyword==='*EM_ISOPOTENTIAL_CONNECT')
     .map(row=>[row.fieldName,row.line]).sort(),expected.sort(),JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons}));
    if(kind==='em-randles-meshless'||kind==='em-isopot')assert.ok(result.locations.some(row=>row.role==='definition'),kind);
   }
  }
 });
 it('resolves native EM and CPG target discriminators in their actual occurrence parameter context',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1]){
   const em=['*KEYWORD','*PARAMETER','ITYPE,2','*DEFINE_FUNCTION','73','f(t)=1',
    '*EM_ISOPOTENTIAL_CONNECT','1,&TYPE,0,0,0,-73,0,0','*END'];
   const header=await query(em,'function',maxReferenceBlockBytes);
   assert.deepEqual(header.locations.filter(row=>row.role==='reference').map(row=>[row.fieldName,row.line]),[['LCID_RDLID',7]]);
   const directory=tempDirectory(path.join(os.tmpdir(),'dynasense-cpg-parameter-occurrences-')),
    main=path.join(directory,'main.k'),child=path.join(directory,'child.k');
   fs.writeFileSync(main,['*KEYWORD','*PARAMETER_DUPLICATION','4','*PARAMETER','ITYPE,0','*INCLUDE','child.k',
    '*PARAMETER','ITYPE,1','*INCLUDE_TRANSFORM','child.k','*END'].join('\n'));
   fs.writeFileSync(child,['*KEYWORD','*PART','fixture','73,0,0,0','*SET_PART_LIST','73','73','*AIRBAG_CPG',
    '73,&TYPE,0,0,0,0,0,0','0,0,0,0,0,0,0,0','0,0,0,0,0,0,0,0','0,0,0,0,0,0,0,0','*END'].join('\n'));
   const snapshot={rootFile:main,files:[main,child],fileIndexes:new Map(),graph:{includeOccurrencesComplete:true,
    includeOccurrences:[{occurrenceId:'child:first',fromFile:main,filePath:child,fileName:'child.k',keywordLine:5,lineIndex:6},
     {occurrenceId:'child:second',fromFile:main,filePath:child,fileName:'child.k',keywordLine:9,lineIndex:10,
      transform:{offsets:{idsoff:{kind:'numeric',value:100,raw:'100'}}}}]}};
   for(const file of snapshot.files)snapshot.fileIndexes.set(file,await buildFileIndex(file,{maxReferenceBlockBytes}));
   for(const [kind,id,expected]of [['part',73,[['SID1',8]]],['part-set',173,[['SID1',8]]],['part-set',73,[]]]){
    const result=await queryIndexedEntityId({snapshot,id,targetKind:kind});
    assert.deepEqual(result.locations.filter(row=>row.role==='reference'&&row.keyword==='*AIRBAG_CPG')
     .map(row=>[row.fieldName,row.line]),expected,JSON.stringify({kind,id,reasons:result.reasons}));
   }
   snapshot.fileIndexes=new Map([...snapshot.fileIndexes].map(([file,index])=>[file,JSON.parse(JSON.stringify(index))]));
   const reopened=await queryIndexedEntityId({snapshot,id:173,targetKind:'part-set'});
   assert.deepEqual(reopened.locations.filter(row=>row.role==='reference'&&row.keyword==='*AIRBAG_CPG')
    .map(row=>[row.fieldName,row.line]),[['SID1',8]]);
  }
 });
 it('uses committed EM control order for later connection payloads in ordinary and disk queries',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1',
    '*DEFINE_FUNCTION','73','f(x)=x','*EM_CONTROL'+marker(format),render([4,1,0,0,2,1,5000,5000],format)],expected=[];
   for(const type of [3,4,3]){
    lines.push('*EM_ISOPOTENTIAL_CONNECT'+marker(format),render([1,type,0,0,0,0,0,0],format));
    if(type===4||expected.length)expected.push(['LCID2',lines.length]);
    lines.push(render([0,0,0,0,0,73],format));
   }
   lines.push('*END');const result=await query(lines,'curve',maxReferenceBlockBytes);
   assert.deepEqual(result.locations.filter(row=>row.role==='reference'&&row.keyword==='*EM_ISOPOTENTIAL_CONNECT')
    .map(row=>[row.fieldName,row.line]),expected,JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons}));
   const functions=await query(lines,'function',maxReferenceBlockBytes);
   assert.equal(functions.locations.filter(row=>row.role==='reference'&&row.keyword==='*EM_ISOPOTENTIAL_CONNECT').length,0);
   lines[lines.findIndex(line=>line.startsWith('*EM_CONTROL'))+1]=render(['&EMSOL',1,0,0,2,1,5000,5000],format);
   const unknown=await query(lines,'curve',maxReferenceBlockBytes);
   assert.equal(unknown.locations.filter(row=>row.role==='reference'&&row.keyword==='*EM_ISOPOTENTIAL_CONNECT').length,0);
   assert.equal(unknown.state,'partial');
  }
 });
 it('preserves EM pending state through INCLUDE order and binds repeated occurrences separately',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const directory=tempDirectory(path.join(os.tmpdir(),'dynasense-em-include-')),main=path.join(directory,'main.k'),
    control=path.join(directory,'control.k'),child=path.join(directory,'connection.k');
   const inheritedMarker=format==='long'?'':marker(format),mainHeader=format==='long'?'*KEYWORD LONG=Y':'*KEYWORD';
   const connect=['*EM_ISOPOTENTIAL_CONNECT'+inheritedMarker,render([1,3,0,0,0,0,0,0],format),render([0,0,0,0,0,73],format)];
   fs.writeFileSync(control,['*KEYWORD','*EM_CONTROL'+inheritedMarker,render([4,1,0,0,2,1,5000,5000],format),'*END'].join('\n'));
   fs.writeFileSync(child,['*KEYWORD',...connect,'*END'].join('\n'));
   const lines=[mainHeader,'*DEFINE_CURVE',render([73],format),render([0,0],format),render([1,1],format),
    '*INCLUDE','control.k',...connect,'*INCLUDE','connection.k',...connect,'*END'];
   fs.writeFileSync(main,lines.join('\n'));
   const snapshot={rootFile:main,files:[main,control,child],fileIndexes:new Map(),graph:{includeOccurrencesComplete:true,
    includeOccurrences:[{occurrenceId:'control:1',fromFile:main,filePath:control,fileName:'control.k',keywordLine:5,lineIndex:6},
     {occurrenceId:'connection:1',fromFile:main,filePath:child,fileName:'connection.k',keywordLine:10,lineIndex:11}]}};
   for(const file of snapshot.files)snapshot.fileIndexes.set(file,await buildFileIndex(file,{maxReferenceBlockBytes}));
   const result=await queryIndexedEntityId({snapshot,id:73,targetKind:'curve'});
   assert.deepEqual(result.locations.filter(row=>row.role==='reference'&&row.fieldName==='LCID2').map(row=>[row.filePath,row.line]).sort(),
    [[child,3],[main,14]].sort(),JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons}));
   const repeated=[mainHeader,'*DEFINE_CURVE',render([73],format),render([0,0],format),render([1,1],format),
    '*INCLUDE','control.k','*INCLUDE','connection.k','*INCLUDE','connection.k','*END'];
   fs.writeFileSync(main,repeated.join('\n'));snapshot.fileIndexes.set(main,await buildFileIndex(main,{maxReferenceBlockBytes}));
   snapshot.graph.includeOccurrences=[snapshot.graph.includeOccurrences[0],
    {...snapshot.graph.includeOccurrences[1],keywordLine:7,lineIndex:8},
    {...snapshot.graph.includeOccurrences[1],occurrenceId:'connection:2',keywordLine:9,lineIndex:10}];
   const ambiguous=await queryIndexedEntityId({snapshot,id:73,targetKind:'curve'});
   assert.deepEqual(ambiguous.locations.filter(row=>row.role==='reference'&&row.fieldName==='LCID2')
    .map(row=>[row.filePath,row.line]),[[child,3]]);
   snapshot.graph.includeOccurrences[2].transform={offsets:{idfoff:{kind:'numeric',value:100,raw:'100'}}};
   const originalId=await queryIndexedEntityId({snapshot,id:73,targetKind:'curve'});
   assert.equal(originalId.locations.filter(row=>row.role==='reference'&&row.fieldName==='LCID2').length,0);
   const offsetId=await queryIndexedEntityId({snapshot,id:173,targetKind:'curve'});
   assert.deepEqual(offsetId.locations.filter(row=>row.role==='reference'&&row.fieldName==='LCID2')
    .map(row=>[row.filePath,row.line]),[[child,3]]);
  }
 });
 it('matches DDAM skipped initial records, normalized STD tails and the MCOMB -14 SID card',()=>{
  for(const keyword of ['FREQUENCY_DOMAIN_RESPONSE_SPECTRUM_DDAM',
   'FREQUENCY_DOMAIN_RESPONSE_SPECTRUM_DDAM_MISSING_MASS_CORRECTION'])for(const format of ['standard','comma','long','i10'])
   for(const comb of [-14,0,99])for(const prs of [0,2])for(const std of [0,1,-1]){
    const end=keyword.endsWith('_MISSING_MASS_CORRECTION')?7:6,expected=[1,...(comb===99?[2,3]:[]),...(prs===2?[4]:[]),
     ...Array.from({length:end-4},(_,index)=>index+5),...(std>=0?[end+1]:[end+2,end+3]),...(comb===-14?[end+4]:[])];
    const rows=expected.map(card=>render(card===1?[1,0,0,0,0,comb,0,prs]:card===end?[std,0,0,0,0,0,0,0]:
     keyword.endsWith('_MISSING_MASS_CORRECTION')&&card===5?[0,'fixture.dat']:Array(8).fill(0),format));
    const context=nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),[...rows,render(Array(8).fill(73),format)],'standard');
    assert.deepEqual(context.select()?.current.map(record=>record.cardIndex),[...expected,0],JSON.stringify({keyword,format,comb,prs,std}));
    assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows.slice(0,-1),'standard').select(),null);
   }
 });
 it('retains conditional ICFD references after variable payloads in all formats and disk fallback',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_FUNCTION','73','f(x)=x','*ICFD_MODEL_SPECIES_TRANSPORT'+marker(format)],expected=[];
   for(const dens of [0,1,2,3])for(const hvac of [0,1,2]){
    expected.push(lines.length);
    lines.push(render([1,2,dens,73,hvac],format),render(Array(8).fill(0),format));
    if(dens===2){expected.push(...Array(8).fill(lines.length));lines.push(render(Array(8).fill(73),format));}
    if(hvac===1)lines.push(render(Array(8).fill(73),format));
   }
   lines.push('*END');const result=await query(lines,'function',maxReferenceBlockBytes);
   const found=result.locations.filter(r=>r.role==='reference'&&r.keyword==='*ICFD_MODEL_SPECIES_TRANSPORT');
   assert.deepEqual(found.map(r=>r.line).sort((a,b)=>a-b),expected,JSON.stringify({format,reasons:result.reasons,found}));
   assert.ok(found.every(r=>r.fieldName==='DENSFID'||/^FID[1-8]$/.test(r.fieldName)));
  }
 });
 it('queries porous variant curves and an in-place Windkessel header in all formats and on disk',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1'],expected=[];
   const porous={3:[1,3],10:[1,3],4:[1,4,7,8],6:[1,4,7,8],7:[1,4,7,9],5:[1,5,7,9],11:[1,6]};
   for(let type=0;type<=11;type++){
    lines.push('*ICFD_MODEL_POROUS'+marker(format));const start=lines.length;
    lines.push(render([1,type,73,73,73,73,73,73],format));
    const cards=porous[type]||[1,2];
    for(const card of cards.slice(1)){
     const row=lines.length;lines.push(render(Array(8).fill(73),format));
     for(const field of card===2?['PSFLCID']:card===3?['PVLCID']:card===5?['PVLCIDX','PVLCIDY','PVLCIDZ']:[])
      expected.push(['*ICFD_MODEL_POROUS',field,row]);
    }
    lines.push(render(Array(8).fill(73),format)); // outside this reader's selected payload
    lines.push('*ICFD_BOUNDARY_WINDKESSEL'+marker(format));
    if(type===9||type===10)expected.push(['*ICFD_BOUNDARY_WINDKESSEL','QPLCID',lines.length]);
    lines.push(render([1,type,73,73,73,73],format));
    expected.push(['*ICFD_BOUNDARY_WINDKESSEL','P2LCID',lines.length]);
    lines.push(render(Array(8).fill(73),format),render(Array(8).fill(73),format));
   }
   lines.push('*END');const result=await query(lines,'curve',maxReferenceBlockBytes);
   assert.deepEqual(result.locations.filter(r=>r.role==='reference'&&['*ICFD_MODEL_POROUS','*ICFD_BOUNDARY_WINDKESSEL'].includes(r.keyword))
    .map(r=>[r.keyword,r.fieldName,r.line]),expected,JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons}));
  }
 });
 it('keeps unknown controllers and incomplete instances unresolved',()=>{
  for(const keyword of ['ICFD_MODEL_SPECIES_TRANSPORT','ALE_REFERENCE_SYSTEM_GROUP','ALE_UP_SWITCH']){
   const values=keyword==='ALE_UP_SWITCH'?['&UP',0]:keyword==='ALE_REFERENCE_SYSTEM_GROUP'?[73,0,'&TYPE',73]:[1,2,'&TYPE',73,1];
   assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword,[values.join(','),'0,0,0,0,0,0,0,0'],'standard').select(),null);
   assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword,[keyword==='ALE_UP_SWITCH'?'0,0':keyword==='ALE_REFERENCE_SYSTEM_GROUP'?'73,0,9,73':'1,2,2,73,1'],'standard').select(),null);
  }
 });
 it('matches native weld NPR pairs, stochastic selection windows and conditional fiber coordinate records',()=>{
  for(const format of ['standard','comma','long','i10']){
   for(const count of [0,1,2]){
    const rows=[render([0,0,0,0,count,0],format)],expected=[1];
    for(let pair=0;pair<count;pair++){rows.push(render(Array(8).fill(0),format),render(Array(4).fill(0),format));expected.push(2,3);}
    const selected=nativeFileReadContext(rule('CONSTRAINED_GENERALIZED_WELD_COMBINED'),'*CONSTRAINED_GENERALIZED_WELD_COMBINED'+marker(format),rows,'standard').select();
    assert.deepEqual(selected?.current.map(r=>r.cardIndex),expected,JSON.stringify({format,count}));
   }
   for(const type of [0,1,2,3,4,5]){
    const rows=[render([1,24,0,0,0,0,0,0],format),render([type,0,73,0,0],format)];
    const selected=nativeFileReadContext(rule('DEFINE_STOCHASTIC_VARIATION_PROPERTIES'),'*DEFINE_STOCHASTIC_VARIATION_PROPERTIES'+marker(format),rows,'standard').select();
    assert.deepEqual(selected?.current.map(r=>r.cardIndex),[1,format!=='long'&&type>=3?3:2],JSON.stringify({format,type}));
   }
   for(const [first,second] of [[1,2],[0,2],[1,0],[-1,2]]){
    const rows=[render([1,0,0,first,second,0,0,0],format),render([0,0,0],format)],expected=[1,2];
    if(first<=0||second<=0){rows.push(render(Array(6).fill(0),format));expected.push(3);}
    const selected=nativeFileReadContext(rule('DEFINE_FIBERS'),'*DEFINE_FIBERS'+marker(format),rows,'standard').select();
    assert.deepEqual(selected?.current.map(r=>r.cardIndex),expected,JSON.stringify({format,first,second}));
   }
  }
  for(const keyword of ['DEFINE_FIBERS','CONSTRAINED_GENERALIZED_WELD_COMBINED']){
   const rows=[keyword==='DEFINE_FIBERS'?'1,0,0,&NODE,2,0,0,0':'0,0,0,0,&COUNT,0','0,0,0'];
   assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword,rows,'standard').select(),null);
  }
 });
 it('queries deferred spotweld curves only for the selected OPT pool in memory and on disk',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1'],expected=[];
   for(const keyword of ['MAT_100_DAMAGE','MAT_SPOTWELD_DAMAGE_FAILURE','MAT_SPOTWELD_DAMAGE-FAILURE',
    'MAT_SPOTWELD_DAMAGE-FAILURE_UNIAXIAL'])for(const opt of [0,11,11.75,12])for(const damage of [0,-1]){
    lines.push('*'+keyword+marker(format));expected.push(['*'+keyword,'SIGY',lines.length]);
    lines.push(render([1,1,1,0.3,-73,0,0,0],format));
    if(opt===11)expected.push(['*'+keyword,'LCT',lines.length],['*'+keyword,'LCC',lines.length]);
    lines.push(render([1,73,73],format),render([1,opt,0,0,0,0,0,damage],format));
    if(damage===-1)lines.push(render(Array(4).fill(0),format));
    if(opt===12)lines.push(render(Array(8).fill(0),format),render(Array(8).fill(0),format));
    lines.push(render([2,1,1,0.3,-73,0,0,0],format),render([1,73,73],format),render([1,11,0,0,0,0,0,0],format));
   }
   lines.push('*END');const result=await query(lines,'curve',maxReferenceBlockBytes);
   assert.deepEqual(result.locations.filter(r=>r.role==='reference'&&/\*MAT_(100_DAMAGE|SPOTWELD_DAMAGE)/.test(r.keyword))
    .map(r=>[r.keyword,r.fieldName,r.line]),expected,JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons}));
  }
 });
 it('queries DDAM damping curves after all optional prefix and tail shifts in memory and on disk',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1'],expected=[];
   for(const keyword of ['FREQUENCY_DOMAIN_RESPONSE_SPECTRUM_DDAM','FREQUENCY_DOMAIN_RESPONSE_SPECTRUM_DDAM_MISSING_MASS_CORRECTION'])
    for(const comb of [-14,0,99])for(const prs of [0,2])for(const std of [0,1,-1]){
     const end=keyword.endsWith('_MISSING_MASS_CORRECTION')?7:6,damping=end-1;
     const sequence=[1,...(comb===99?[2,3]:[]),...(prs===2?[4]:[]),...Array.from({length:end-4},(_,index)=>index+5),
      ...(std>=0?[end+1]:[end+2,end+3]),...(comb===-14?[end+4]:[])];
     lines.push('*'+keyword+marker(format));
     for(const card of sequence){
      if(card===damping)expected.push(['*'+keyword,'LCDAMP',lines.length]);
      lines.push(render(card===1?[1,0,0,0,0,comb,0,prs]:card===end?[std,0,0,0,0,0,0,0]:
       card===damping?[1,73,0,0,0,0,0,0]:keyword.endsWith('_MISSING_MASS_CORRECTION')&&card===5?[0,'fixture.dat']:
        Array(8).fill(0),format));
     }
     lines.push(render(Array(8).fill(73),format));
    }
   lines.push('*END');const result=await query(lines,'curve',maxReferenceBlockBytes);
   assert.deepEqual(result.locations.filter(r=>r.role==='reference'&&r.keyword.startsWith('*FREQUENCY_DOMAIN_RESPONSE_SPECTRUM_DDAM'))
    .map(r=>[r.keyword,r.fieldName,r.line]),expected,JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons}));
  }
 });
 it('queries the hysteretic extra pool before IFEMA tails without losing signed curve references',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1'],expected=[];
   for(const keyword of ['MAT_HYSTERETIC_BEAM','MAT_209'])for(const ifema of [0,1,2,3])for(const sign of [1,-1]){
    lines.push('*'+keyword+marker(format),render([1,1,1,0.3,1,1,2,ifema],format));
    for(const field of ['LCPMS','LCPMT','LCAT','LCAC'])expected.push(['*'+keyword,field,lines.length]);
    lines.push(render([73,0,73,0,73,0,73,0],format),render(Array(8).fill(0),format));
    expected.push(['*'+keyword,'LCSHS',lines.length]);lines.push(render([0,0,0,0,73*sign,0,0,0],format));
    if(sign<0){for(const field of ['LCSHSN','LCSHTN'])expected.push(['*'+keyword,field,lines.length]);
     lines.push(render([73,0,73,0,0,0,0,0],format));}
    for(let count=0;count<ifema+3;count++)lines.push(render(Array(8).fill(0),format));
   }
   lines.push('*END');const result=await query(lines,'curve',maxReferenceBlockBytes);
   assert.deepEqual(result.locations.filter(r=>r.role==='reference'&&['*MAT_HYSTERETIC_BEAM','*MAT_209'].includes(r.keyword))
    .map(r=>[r.keyword,r.fieldName,r.line]),expected,JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons}));
  }
 });
 it('matches all 64 actual hysteretic material reads including the extra pool before the contiguous tail',()=>{
  for(const format of ['standard','comma','long','i10'])for(const keyword of ['MAT_HYSTERETIC_BEAM','MAT_209'])
   for(const ifema of [0,1,2,3])for(const sign of [1,-1]){
    const rows=[[1,1,1,0.3,1,1,2,ifema],Array(8).fill(0),Array(8).fill(0),[0,0,0,0,sign,0,0,0]],expected=[1,2,3,4];
    if(sign<0){rows.push(Array(8).fill(0));expected.push(11);}
    for(let count=0;count<ifema+3;count++){rows.push(Array(8).fill(0));expected.push(count+5);}
    const context=nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows.map(row=>render(row,format)),'standard');
    assert.deepEqual(context.select()?.current.map(r=>r.cardIndex),expected,JSON.stringify({keyword,format,ifema,sign}));
    assert.equal(context.writeCompatible(context.select().current),false);
    assert.equal(nativeFileReadContext(rule(keyword),'*'+keyword+marker(format),rows.slice(0,-1).map(row=>render(row,format)),'standard').select(),null);
   }
 });
 it('separates native file-controller target families with the same ID in normal and disk reads',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*PART','same ID part','        73','*SET_PART_LIST','        73','         1',
    '*SET_SEGMENT','        73','         1         2         3         4','*SET_NODE_LIST','        73','         1'];
   const expected={'part':[],'part-set':[],'segment-set':[]};
   for(const stype of [0,1]){
    lines.push('*INITIAL_GAS_MIXTURE'+marker(format));expected[stype?'part':'part-set'].push(['SID',lines.length]);
    lines.push(render([73,stype,0,0],format),render(Array(8).fill(0),format));
   }
   for(const vtype of [0,1,2]){
    lines.push('*DEFINE_ALEBAG_BAG'+marker(format));expected[['part-set','part','segment-set'][vtype]].push(['VSET',lines.length]);
    lines.push(render([1,0,0,0,0,0,73,vtype],format),render(Array(8).fill(0),format),render([0,0,0],format));
   }
   lines.push('*ALE_UP_SWITCH'+marker(format));
   for(const stype of [0,1,-1,2]){
    const start=lines.length;lines.push(render([0,0],format),render(Array(8).fill(73),format),render([73,stype,0,0],format));
    expected[stype===0?'segment-set':'part-set'].push(['SID',start+2]);
   }
   lines.push('*END');
   for(const kind of ['part','part-set','segment-set','node-set','integration-beam']){
    const result=await query(lines,kind,maxReferenceBlockBytes);
    const found=result.locations.filter(r=>r.role==='reference'&&['*INITIAL_GAS_MIXTURE','*DEFINE_ALEBAG_BAG','*ALE_UP_SWITCH'].includes(r.keyword));
    assert.deepEqual(found.map(r=>[r.fieldName,r.line]),expected[kind]||[],JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons,found}));
   }
  }
 });
 it('reads only the actual DEATH header node links and omits the unconsumed GUI rigid-ID pool',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*PART','same ID part','        73','*NODE',
    '      73'+[0,0,0].map(v=>String(v).padStart(16)).join(''),'*DEFINE_DEATH_TIMES_RIGID'+marker(format),
    render([1,73,73,73],format),render([0,0,0,0,0,0,1,1],format),render(Array(8).fill(73),format),'*END'];
   const node=await query(lines,'node',maxReferenceBlockBytes),part=await query(lines,'part',maxReferenceBlockBytes);
   assert.deepEqual(node.locations.filter(r=>r.role==='reference'&&r.keyword==='*DEFINE_DEATH_TIMES_RIGID').map(r=>[r.fieldName,r.line]),[['N1',7],['N2',7],['N3',7]]);
   assert.equal(part.locations.filter(r=>r.role==='reference'&&r.keyword==='*DEFINE_DEATH_TIMES_RIGID').length,0);
  }
 });
 it('selects each ALE GROUP header variant and its type9 exclusion row without cross-type matches',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*PART','same ID part','        73','*SET_PART_LIST','        73','         1',
    '*SET_NODE_LIST','        73','         1','*NODE','      73'+[0,0,0].map(v=>String(v).padStart(16)).join(''),
    '*ALE_REFERENCE_SYSTEM_GROUP'+marker(format)],expected={'node-set':[],'part-set':[],'node':[],'part':[],
     'ale-reference-system-curve':[],'ale-reference-system-node':[],'ale-reference-system-switch':[]};
   for(let type=0;type<=9;type++){
    const start=lines.length;
    lines.push(render([0,0,type,73,73,0,0,73],format),render(Array(8).fill(73),format));
    if(type===3)expected['ale-reference-system-curve'].push(['PRID',start]);
    if(type===4)expected['node-set'].push(['PRID',start]);
    if(type===5||type===7)expected['ale-reference-system-node'].push(['PRID',start]);
    if(type===6)expected['ale-reference-system-switch'].push(['PRID',start]);
    if(type===9){
     expected['part-set'].push(['PRID',start],['IPIDXCL',lines.length]);
     expected['ale-reference-system-node'].push(['BCTRAN',start]);expected['node'].push(['NID',start]);
     lines.push(render([73,0],format));
    }
   }
   lines.push('*END');
   for(const kind of Object.keys(expected)){
    const result=await query(lines,kind,maxReferenceBlockBytes);
    assert.deepEqual(result.locations.filter(r=>r.role==='reference'&&r.keyword==='*ALE_REFERENCE_SYSTEM_GROUP')
     .map(r=>[r.fieldName,r.line]),expected[kind],JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons}));
   }
  }
 });
 it('reads only the selected ALE MOTION first record in each block and preserves COVER target types on disk',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*PART','same ID part','        73','*SET_PART_LIST','        73','         1',
    '*SET_SEGMENT','        73','         1         2         3         4','*SET_NODE_LIST','        73','         1',
    '*NODE','      73'+[0,0,0].map(v=>String(v).padStart(16)).join('')];
   const expected={'part-set':[],'part':[],'segment-set':[],'node-set':[],'node':[]};
   for(const type of [0,1,2,3]){
    lines.push('*ALE_STRUCTURED_MESH_MOTION'+marker(format));
    const start=lines.length;
    lines.push(render([0,'COVER_LAG',73,type,73,0,0,0],format),render([0,'COVER_LAG',73,type,73,0,0,0],format));
    expected[['part-set','part','segment-set','node-set'][type]].push(['SID',start]);
    expected.node.push(['NODCEN',start]);
   }
   for(const option of ['FOLLOW_GC','','cover_lag']){
    lines.push('*ALE_STRUCTURED_MESH_MOTION'+marker(format),render([0,option,73,0,73,0,0,0],format),
     render([0,'COVER_LAG',73,0,73,0,0,0],format));
   }
   lines.push('*END');
   for(const kind of Object.keys(expected)){
    const result=await query(lines,kind,maxReferenceBlockBytes);
    const found=result.locations.filter(r=>r.role==='reference'&&r.keyword==='*ALE_STRUCTURED_MESH_MOTION');
    assert.deepEqual(found.map(r=>[r.fieldName,r.line]),expected[kind],JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons,found}));
   }
  }
 });
 it('repeats LOAD_NODE_SET while excluding the unconsumed CONTACT2D node-set pool in all input formats',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*SET_NODE_LIST','        73','         1','*LOAD_NODE_SET'+marker(format)],expected=[];
   for(const dof of [1,2,3]){expected.push(['NSID',lines.length]);lines.push(render([73,dof,0,1,0,0,0,0],format));}
   for(const keyword of ['CONTACT_2D_NODE_TO_SOLID','CONTACT_2D_NODE_TO_SOLID_TIED']){
    lines.push('*'+keyword+marker(format),render([0,0,0,0],format),render(Array(8).fill(0),format),render([73,73,0,0],format));
   }
   lines.push('*END');const result=await query(lines,'node-set',maxReferenceBlockBytes);
   assert.deepEqual(result.locations.filter(r=>r.role==='reference').map(r=>[r.fieldName,r.line]),expected,
    JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons}));
  }
 });
 it('selects SALE curve or material links using native case and prefix choices without treating flags as references',async()=>{
  const fields=['NEGX','POSX','NEGY','POSY','NEGZ','POSZ'];
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*MAT_ELASTIC','        73         1       100       0.3','*DEFINE_CURVE','        73',
    '         0         0','         1         1'],expected={curve:[],material:[]};
   for(const token of ['FIXED','NOFLOW','SYM','NONREFL','FLOWVEL','PRES','AMBIENT','','UNKNOWN','pres','PRESx','ambient']){
    lines.push('*BOUNDARY_SALE_MESH_FACE'+marker(format));const start=lines.length;
    lines.push(render([token,0,...Array(6).fill(73)],format));
    const kind=['FLOWVEL','PRES','pres','PRESx'].includes(token)?'curve':['AMBIENT','ambient'].includes(token)?'material':null;
    if(kind)expected[kind].push(...fields.map(field=>[field,start]));
   }
   lines.push('*END');
   for(const kind of ['curve','material']){
    const result=await query(lines,kind,maxReferenceBlockBytes);
    assert.deepEqual(result.locations.filter(r=>r.role==='reference'&&r.keyword==='*BOUNDARY_SALE_MESH_FACE')
     .map(r=>[r.fieldName,r.line]),expected[kind],JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons}));
   }
  }
 });
 it('retains SALE zero and negative value semantics and unresolved controller parameters',async()=>{
  for(const token of ['PRES','AMBIENT','&TYPE'])for(const value of [0,-73]){
   const lines=['*KEYWORD','*MAT_ELASTIC','        73         1       100       0.3','*DEFINE_CURVE','        73',
    '         0         0','         1         1','*BOUNDARY_SALE_MESH_FACE',render([token,0,...Array(6).fill(value)],'standard'),'*END'];
   const result=await query(lines,token==='AMBIENT'?'material':'curve',1);
   assert.equal(result.locations.filter(r=>r.role==='reference').length,0);
   assert.equal(result.state,value===0?'complete':'partial',JSON.stringify({token,value,state:result.state,reasons:result.reasons}));
   if(value===0)assert.deepEqual(result.reasons,[]);else assert.ok(result.reasons.length,JSON.stringify({token,value}));
  }
 });
 it('queries original CESE, solid intersection and immersed boundary records without a rendered schema alias',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1',
    '*SET_SOLID_LIST','        73','         1','*ICFD_PART','        73         1         1'],expected={curve:[], 'solid-set':[],'icfd-part':[]};
   for(const keyword of ['CESE_BOUNDARY_PRESCRIBED_VN_MSURF','CESE_BOUNDARY_PRESCRIBED_VN_MSURF_SET',
    'CESE_BOUNDARY_PRESCRIBED_VN_SEGMENT','CESE_BOUNDARY_PRESCRIBED_VN_SET']){
    lines.push('*'+keyword+marker(format),render(Array(8).fill(0),format));
    const row=lines.length;lines.push(render(Array(6).fill(73),format),render(Array(6).fill(0),format));
    for(const field of ['LC_U','LC_RHO','LC_P','LC_T'])expected.curve.push(['*'+keyword,field,row]);
   }
   lines.push('*SET_SOLID_INTERSECT'+marker(format),render([1],format));
   for(let row=0;row<3;row++){
    for(let field=1;field<=8;field++)expected['solid-set'].push(['*SET_SOLID_INTERSECT','DSID'+field,lines.length]);
    lines.push(render(Array(8).fill(73),format));
   }
   lines.push('*ICFD_IF_BOUNDARY_IMMERSED_DYNAMIC'+marker(format));
   expected['icfd-part'].push(['*ICFD_IF_BOUNDARY_IMMERSED_DYNAMIC','PID',lines.length]);lines.push(render([73,0,0,0],format));
   lines.push('*END');
   for(const kind of Object.keys(expected)){
    const result=await query(lines,kind,maxReferenceBlockBytes);
    const actual=result.locations.filter(r=>r.role==='reference'&&
     (/^\*CESE_BOUNDARY_PRESCRIBED_VN_/.test(r.keyword)||['*SET_SOLID_INTERSECT','*ICFD_IF_BOUNDARY_IMMERSED_DYNAMIC'].includes(r.keyword)));
    assert.deepEqual(actual.map(r=>[r.keyword,r.fieldName,r.line]),expected[kind],JSON.stringify({format,maxReferenceBlockBytes,kind,reasons:result.reasons}));
   }
  }
 });
 it('uses actual fiber overlap, TENT LCID position3 and stochastic ten-byte controller windows',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*DEFINE_CURVE','        73','         0         0','         1         1'],expected=[];
   lines.push('*DEFINE_FIBERS'+marker(format));expected.push(['*DEFINE_FIBERS','SHR',lines.length]);
   lines.push(render(format==='long'||format==='comma'?[1,0,0,1,2,0,-73,0]:[1,0,0,1,2,-73],format),render([0,0,0],format));
   lines.push('*EM_EP_TENTUSSCHER_STIMULUS2'+marker(format));expected.push(['*EM_EP_TENTUSSCHER_STIMULUS2','LCID',lines.length]);
   const tent=format==='long'||format==='comma'?render([1,1,0,73],format):'   '+String(73).padStart(10)+' '.repeat(27);
   lines.push(tent,tent); // The native reader returns after the first record.
   for(const type of [0,3,4]){
    lines.push('*DEFINE_STOCHASTIC_VARIATION_PROPERTIES'+marker(format),render([1,24,0,0,0,0,0,0],format));
    if(format!=='long'&&type>=3)expected.push(['*DEFINE_STOCHASTIC_VARIATION_PROPERTIES','LCID',lines.length]);
    lines.push(render([type,0,73,0,0],format));
   }
   lines.push('*END');const result=await query(lines,'curve',maxReferenceBlockBytes);
   assert.deepEqual(result.locations.filter(r=>r.role==='reference'&&['*DEFINE_FIBERS','*EM_EP_TENTUSSCHER_STIMULUS2',
    '*DEFINE_STOCHASTIC_VARIATION_PROPERTIES'].includes(r.keyword)).map(r=>[r.keyword,r.fieldName,r.line]),expected,
    JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons}));
  }
 });
 it('resolves CPM bag links to the original AIRBAG ID namespace and preserves actual gapped field geometry',async()=>{
  for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
   const lines=['*KEYWORD','*AIRBAG_FLUID_AND_GAS_ID'+marker(format),render([73,'bag'],format),
    render(Array(8).fill(0),format),render(Array(8).fill(0),format),render(Array(7).fill(0),format)],expected=[];
   for(const keyword of ['DEFINE_CPM_BAG_INTERACTION','DEFINE_CPM_BAG_INTERACTION_TITLE']){
    lines.push('*'+keyword+marker(format));
    for(let instance=0;instance<2;instance++){
     if(keyword.endsWith('_TITLE'))lines.push('bag interaction '+instance);
     const row=lines.length;for(const field of ['BAGID1','BAGID2','NSPEC'])expected.push(['*'+keyword,field,row]);
     lines.push(render(format==='long'||format==='comma'?[73,73,73]:[73,73,'',73],format));
    }
   }
   lines.push('*END');const result=await query(lines,'airbag-id',maxReferenceBlockBytes);
   assert.deepEqual(result.locations.filter(r=>r.role==='definition').map(r=>[r.keyword,r.fieldName,r.line]),
    [['*AIRBAG_FLUID_AND_GAS_ID','ID',2]],JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons}));
   assert.deepEqual(result.locations.filter(r=>r.role==='reference'&&r.keyword.startsWith('*DEFINE_CPM_BAG_INTERACTION'))
    .map(r=>[r.keyword,r.fieldName,r.line]),expected,JSON.stringify({format,maxReferenceBlockBytes,reasons:result.reasons}));
  }
 });
 for(const maxReferenceBlockBytes of [undefined,1])for(const format of ['standard','comma','long','i10']){
  it(`queries exact original TSHELL and MODE definitions without mixing another same-ID namespace (${format}, ${maxReferenceBlockBytes === 1 ? 'disk' : 'ordinary'})`,async()=>{
   const lines=['*KEYWORD','*NODE','      73'+[0,0,0].map(v=>String(v).padStart(16)).join(''),
    '*MAT_ELASTIC','        73         1       100       0.3'],expected={'tshell-set':[],'mode-set':[]};
   for(const [kind,bases]of [['tshell-set',['SET_TSHELL','SET_TSHELL_LIST','SET_TSHELL_GENERATE','SET_TSHELL_GENERAL']],
    ['mode-set',['SET_MODE','SET_MODE_COLLECT','SET_MODE_LIST','SET_MODE_LIST_COLLECT','SET_MODE_LIST_GENERATE','SET_MODE_LIST_GENERATE_COLLECT']]])
    for(const base of bases)for(const title of [false,true]){
     const keyword=base+(title?'_TITLE':'');lines.push('*'+keyword+marker(format));if(title)lines.push('set title');
     expected[kind].push(['*'+keyword,'SID',lines.length]);lines.push(render([73,0,0,0,0,0,0,0],format),render([1,0,0,0,0,0,0,0],format));
    }
   lines.push('*END');for(const kind of Object.keys(expected)){
    const result=await query(lines,kind,maxReferenceBlockBytes);
    assert.deepEqual(result.locations.filter(r=>r.role==='definition').map(r=>[r.keyword,r.fieldName,r.line]),expected[kind],
     JSON.stringify({kind,format,maxReferenceBlockBytes,reasons:result.reasons}));
   }
  });
 }
 it('streams the last weld pair after the byte and occurrence limits without inventing a GUI WID definition',async function(){
  this.timeout(60000);
  const count=140000,lines=['*KEYWORD','*NODE','      73'+[0,0,0].map(v=>String(v).padStart(16)).join(''),
   '*CONSTRAINED_GENERALIZED_WELD_COMBINED',render([0,0,0,0,count,0],'standard')];
  const failure=render(Array(8).fill(0),'standard'),ordinary=render([1,0,0,0],'standard');
  for(let pair=0;pair<count;pair++)lines.push(failure,pair===count-1?render([1,73,0,0],'standard'):ordinary);
  const last=lines.length-1;lines.push(render([73,73,73,73],'standard'),'*END');
  const result=await query(lines,'node');
  assert.deepEqual(result.locations.filter(r=>r.role==='reference'&&r.keyword==='*CONSTRAINED_GENERALIZED_WELD_COMBINED')
   .map(r=>[r.fieldName,r.line]),[['NODEB',last]],JSON.stringify(result.reasons));
  assert.equal(result.locations.filter(r=>r.role==='definition'&&r.keyword==='*CONSTRAINED_GENERALIZED_WELD_COMBINED').length,0);
 });
});
