'use strict';
const assert=require('node:assert/strict');
const {fakeDoc}=require("../../support/helpers");
const {getCardInfoForDocumentLineWithSuggest:resolve,LsdynaFieldHoverProvider,
    buildKeywordOptionViewModel:model}=require("../../../out/extension")._internals;
const header=format => '*CONTROL_IMPLICIT_RESIDUAL_VECTOR'+(format==='long'?' +':format==='i10'?' %':'');
const row=(values,format) => format==='comma'?values.join(','):values.map(v=>String(v).padStart(format==='long'?20:10)).join('');
describe("residual vector predicates from pinned keyword catalog reader record:e9aca6525b7fc64cb345bbb5:7f24c148e9d4d89c9dd695ba",()=>{
    it('uses IRESVEC and IFORMAT to select the filename across sign combinations',async()=>{
        const provider=new LsdynaFieldHoverProvider();
        for(const format of ['standard','comma','long','i10'])for(const iresvec of [-1,0,1])for(const neig of [-1,0,1])for(const iformat of [-1,0,1]){
            const filename=iresvec!==0||iformat!==0;
            const doc=fakeDoc([header(format),row([iresvec,neig,iformat],format),...(filename?['eigenvectors.eig']:[]),'*END'].join('\n'));
            const view=model({document:doc,selection:{active:{line:0,character:0}}},0,{});
            assert.equal(view.plan.status,'no-change',JSON.stringify({format,iresvec,neig,iformat,reason:view.plan.reason}));
            assert.deepEqual(view.targetLayout.records.map(r=>r.lsppCardIndex),filename?[1,2]:[1]);
            assert.deepEqual(resolve(doc,1).cardInfo.card.map(f=>f.n),['IRESVEC','NEIG','IFORMAT']);
            if(filename){
                const info=resolve(doc,2).cardInfo;
                assert.equal(info.nativeCardIndex,2);
                assert.ok(info.card[0].nativeIdentity.branchIdentity.includes(`IRESVEC≠0: ${iresvec!==0?'yes':'no'}`));
                const hover=await provider.provideHover(doc,{line:2,character:0},{isCancellationRequested:false});
                assert.ok(hover.contents[0].value.includes('eigenvector'));
                assert.equal(hover.range.start.character,0);
                assert.equal(hover.range.end.character,'eigenvectors.eig'.length);
            }
        }
    });
    it('keeps required missing filenames and contradictory controls uncertain without losing the header',()=>{
        for(const format of ['standard','comma','long','i10'])for(const values of [[1,0,0],[1,0,1],[0,1,1],[0,'&unknown',0]]){
            const doc=fakeDoc([header(format),row(values,format),'*END'].join('\n'));
            const view=model({document:doc,selection:{active:{line:0,character:0}}},0,{});
            assert.equal(view.plan.status,'blocked',JSON.stringify({format,values}));
            assert.deepEqual(resolve(doc,1).cardInfo.card.map(f=>f.n),['IRESVEC','NEIG','IFORMAT']);
        }
    });
});
