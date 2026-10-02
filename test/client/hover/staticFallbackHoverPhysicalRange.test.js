'use strict';
require("../../support/register-out");
const assert=require('node:assert/strict');
const {fakeDoc}=require("../../support/helpers");
const {LsdynaFieldHoverProvider,getCardInfoForDocumentLineWithSuggest:resolve}=require("../../../out/extension")._internals;
describe('static fallback hover physical line boundary',function(){
    this.timeout(10000);
    for(const [label,text,end] of [['short','1',1],['empty','',0],['full width','         1',10]]){
        it('limits '+label+' source hover to existing text without changing descriptor width',async function(){
            const doc=fakeDoc('*HOURGLASS\n'+text+'\n*END');
            const field=resolve(doc,1).cardInfo.card[0];
            assert.equal(field.n,'HGID');assert.equal(field.w,10);assert.equal(field.nativeRange,undefined);
            const hover=await new LsdynaFieldHoverProvider().provideHover(doc,{line:1,character:0});
            assert.ok(hover);assert.ok(hover.contents.some(c=>String(c.value||c).includes('**HGID**')));
            assert.deepEqual({start:hover.range.start.character,end:hover.range.end.character},{start:0,end});
            assert.equal(doc.lineAt(1).text,text);
        });
    }
    it('applies the same boundary to another static fallback descriptor',async function(){
        const doc=fakeDoc('*INCLUDE\nx.k\n*END'),field=resolve(doc,1).cardInfo.card[0];
        assert.equal(field.nativeRange,undefined);assert.equal(field.w,80);
        const hover=await new LsdynaFieldHoverProvider().provideHover(doc,{line:1,character:0});
        assert.ok(hover);assert.deepEqual({start:hover.range.start.character,end:hover.range.end.character},{start:0,end:3});
    });
});
