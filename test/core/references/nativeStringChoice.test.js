'use strict';
const assert=require('node:assert/strict');
const {nativeStringChoice}=require('../../../src/core/semantics/nativeStringChoice');
describe('native ASCII string choice selection',()=>{
 it('matches observed native defaults, case folding and longest prefix without rewriting the token',()=>{
  const choices=['FIXED','NOFLOW','SYM','NONREFL','FLOWVEL','PRES','AMBIENT'];
  for(const [raw,selected] of [['','FIXED'],['UNKNOWN','FIXED'],['pres','PRES'],['Pres','PRES'],
   ['flowvel','FLOWVEL'],['ambient','AMBIENT'],['PRESx','PRES']])assert.equal(nativeStringChoice(raw,choices),selected,raw);
  assert.equal(nativeStringChoice('PRESSUREx',['P','PRES','PRESSURE']),'PRESSURE');
  assert.equal(nativeStringChoice('x',['P','PRES','PRESSURE']),'P');
  assert.equal(nativeStringChoice('PRES',['pres','PRES']),'pres');
  assert.equal(nativeStringChoice('压力',choices),null);
  assert.equal(nativeStringChoice('PRES',[]),null);
 });
});
