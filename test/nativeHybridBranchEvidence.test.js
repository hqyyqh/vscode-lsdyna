'use strict';
const assert=require('node:assert/strict');
const fixture=require('./fixtures/public-behavior/hybrid-pending-branches.json');
const readers=require('../keywords/lspp-optional-form-header-readers.json');
describe('HYBRID incomplete branch read boundaries',()=>{
 it('keeps four incomplete branch identities out of production bindings',()=>{
  assert.equal(fixture.keywords.length,4);
  for(const keyword of fixture.keywords)assert.equal(readers.bindings[keyword],undefined,keyword);
 });
});
