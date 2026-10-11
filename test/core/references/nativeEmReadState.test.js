'use strict';
const assert=require('node:assert/strict');
const {nativeEmReadEvent,createNativeEmReadState}=require('../../../src/core/semantics/nativeEmReadState');
const control=value=>({kind:'control',rawValue:value,defaultValue:'-1',lineIndex:1,
 choices:['-1','1','2','3','4','5','7','8','9','11','12','13','14','15','16']});
const connect=value=>({kind:'connect',rawValue:String(value),defaultValue:'1',choices:['1','2','3','4','5','6','7'],lineIndex:2});
describe('native EM original read state',()=>{
 it('matches both original and edge-case native pending-order observations',()=>{
  for(const events of [[],[control('4')],[control('4'),{kind:'other-control'}],
   [{kind:'other-control'},control('4')],[control('4'),control('4')]]){
   const state=createNativeEmReadState();events.forEach(event=>state.apply(event));
   assert.deepEqual(state.apply(connect(3)),{state:'ready',cardIndexes:[1]});
   assert.deepEqual(state.apply(connect(4)),{state:'ready',cardIndexes:events.some(event=>event.kind==='control')?[1,3]:[1]});
  }
  const insert=createNativeEmReadState();insert.apply({kind:'other-control'});
  assert.deepEqual(insert.apply(connect(3)).cardIndexes,[1]);insert.apply(control('4'));
  assert.deepEqual(insert.apply(connect(4)).cardIndexes,[1]);assert.deepEqual(insert.apply(connect(3)).cardIndexes,[1,3]);
  const first=createNativeEmReadState();first.apply(control('4'));first.apply(connect(3));first.apply(control('3'));
  assert.deepEqual(first.apply(connect(4)).cardIndexes,[1,3]);
 });
 it('defers unresolved EMSOL and read order while retaining independent connection layouts',()=>{
  const state=createNativeEmReadState();state.apply(control('&EMSOL'));
  assert.deepEqual(state.apply(connect(3)).cardIndexes,[1]);assert.equal(state.apply(connect(4)).state,'unknown');
  assert.deepEqual(state.apply(connect(6)).cardIndexes,[1,2]);assert.deepEqual(state.apply(connect(1)).cardIndexes,[1]);
  const resolved=createNativeEmReadState();resolved.apply(control('&EMSOL'),raw=>raw==='&EMSOL'?'7':raw);
  resolved.apply(connect(3));assert.deepEqual(resolved.apply(connect(4)).cardIndexes,[1,3]);
  resolved.invalidate('missing-include');assert.equal(resolved.apply(connect(3)).reason,'missing-include');
  assert.equal(resolved.apply(connect('&TYPE')).state,'unknown');
 });
 it('reads exact native controls in comma, LONG and filtered I10 formats before root traversal',()=>{
  for(const format of ['standard','comma','long','i10']){
   const values=[1,4,0,0,0,73,0,0],body=format==='comma'?values.join(','):
    values.map(value=>String(value).padStart(format==='long'?20:10)).join('');
   const rawKeyword='*EM_ISOPOTENTIAL_CONNECT'+(format==='long'?' +':format==='i10'?' %':'');
   const event=nativeEmReadEvent({keyword:'*EM_ISOPOTENTIAL_CONNECT',rawKeyword,startLine:7},rawKeyword+'\n$ comment\n'+body,'standard');
   assert.equal(event.kind,'connect');assert.equal(event.rawValue,'4');assert.equal(event.lineIndex,9);
   assert.deepEqual(createNativeEmReadState().apply(event).cardIndexes,[1]);
  }
  const mixed=nativeEmReadEvent({keyword:'*EM_CONTROL',rawKeyword:'*EM_CONTROL %',startLine:0},'*EM_CONTROL %\n4,0','long');
  assert.equal(mixed.kind,'invalidate');assert.equal(mixed.reason,'native-mixed-global-long-local-i10-flags-unimplemented');
 });
});
