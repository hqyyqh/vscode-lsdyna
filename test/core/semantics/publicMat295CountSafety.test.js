'use strict';
require("../../support/register-out");
const assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib');
const {fakeDoc}=require("../../support/helpers");
const fixtures=JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve("../../fixtures/public-behavior/mixed-reader-safety.json.gz"))));
describe('signed descriptor count write-selection boundaries',function(){this.timeout(60000);
it('preserves signed int32 count arithmetic and keeps newly displayed counts outside write selection',()=>{
        const {selectConditionalLayout}=require("../../../out/core/semantics/nativeConditionalLayout");
        const binding={controls:{NF:{card:1,field:0,storage:'int32'}},steps:[1,
            {control:'NF',maxCount:256,nonPositive:'empty',countFormula:'native-int32-packed-pairs',repeat:[2]}]};
        for(const [nf,count] of [[-4,2],[-3,2],[-2,1],[-1,1],[0,0],[1,0],[2,0],[3,1],[4,1],[5,3],[8,6]]) {
            const selected=selectConditionalLayout(binding,Array(count+1).fill(''),false,()=>String(nf),x=>x,(_r,_f,x)=>x,false,true);
            assert.equal(selected.complete,true,String(nf));
            assert.deepEqual(selected.current.map(r=>r.cardIndex),[1,...Array(count).fill(2)]);
        }
        const {getCatalogInputFormCatalogV4}=require("../../../out/core/semantics/catalogInputFormCatalogV4");
        const {nativeFileReadContext}=require("../../../out/core/semantics/nativeFileReadContext");
        const form=getCatalogInputFormCatalogV4().formForKeyword('MAT_295');
        const raw=form.rules[form.reference.formRuleIds[0]],rule={...raw,catalogSource:form.source};
        const archive={plan:{tasks:fixtures.mat295}};
        for(const task of archive.plan.tasks.filter(t=>t.keyword==='MAT_295'&&t.format==='standard')) {
            const context=nativeFileReadContext(rule,task.lines[0],task.lines.slice(1),'standard');
            assert.equal(context.select(true).complete,true,task.id);
            if(task.nf>2) assert.equal(context.select(false),null,task.id);
        }
    });
});
