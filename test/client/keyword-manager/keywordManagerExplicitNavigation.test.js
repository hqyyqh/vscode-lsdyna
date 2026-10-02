const assert=require('node:assert/strict');
const {fakeDoc}=require("../../support/helpers");
const {trackKeywordManagerSourceChange:track,keywordManagerRefreshLine:line}=require("../../../out/extension")._internals;
const change=(a,b,c,d,text)=>({range:{start:{line:a,character:b},end:{line:c,character:d}},text});
describe('explicit Keyword Manager source anchor',()=>{
 it('tracks line insertions without rebinding the original model',()=>{const m={keywordLine:2,currentKeyword:'*MAT_ELASTIC'};track(m,{contentChanges:[change(0,0,0,0,'$a\n$b\n')]});assert.equal(m.keywordLine,2);assert.equal(m.liveKeywordLine,4);assert.equal(line(m,fakeDoc('$a\n$b\n*KEYWORD\n$ comment\n*MAT_ELASTIC')),4)});
 it('preserves a header when complete lines are inserted immediately before it',()=>{const m={keywordLine:0,currentKeyword:'*MAT_ELASTIC'};track(m,{contentChanges:[change(0,0,0,0,'$a\n')]});assert.equal(line(m,fakeDoc('$a\n*MAT_ELASTIC')),1)});
 it('rejects changed and deleted headers even if another identical keyword occupies the line',()=>{for(const c of [change(2,4,2,5,'X'),change(2,0,4,0,'')]){const m={keywordLine:2,currentKeyword:'*MAT_ELASTIC'};track(m,{contentChanges:[c]});assert.equal(line(m,fakeDoc('*KEYWORD\n$ c\n*MAT_ELASTIC')),null)}});
 it('combines simultaneous edits using their original coordinates',()=>{const m={keywordLine:5,currentKeyword:'*MAT_ELASTIC'};track(m,{contentChanges:[change(4,0,4,0,'$x\n'),change(0,0,2,0,'')]});assert.equal(m.liveKeywordLine,4);assert.equal(m.sourceAnchorInvalid,undefined)});
 it('does not invalidate identity for changed data below the header',()=>{const m={keywordLine:0,currentKeyword:'*MAT_ELASTIC'};track(m,{contentChanges:[change(1,0,1,1,'2')]});assert.equal(line(m,fakeDoc('*MAT_ELASTIC\n2')),0)});
});

it('keeps the selected repeated record after lines are inserted above it',()=>{
 const m={keywordLine:0,managerSelectionLine:2,currentKeyword:'*NODE'};
 track(m,{contentChanges:[change(1,0,1,0,'$ comment\n')]});
 assert.equal(line(m,fakeDoc('*NODE\n$ comment\n1,0,0,0\n2,0,0,0')),3);
});
it('rejects a selected record that now belongs to a newly inserted keyword block',()=>{
 const m={keywordLine:0,managerSelectionLine:2,currentKeyword:'*NODE'};
 track(m,{contentChanges:[change(1,0,1,0,'*NODE\n')]});
 assert.equal(line(m,fakeDoc('*NODE\n*NODE\n1,0,0,0\n2,0,0,0')),null);
});
