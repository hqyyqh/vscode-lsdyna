'use strict';
const assert=require('node:assert/strict'),Module=require('node:module'),path=require('node:path');
const root=path.resolve(__dirname,'../../..');
const catalogModule=require(path.join(root,"out/core/semantics/catalogInputFormCatalogV4"));
const schemaModule=require(path.join(root,'out/core/keywordSchema'));
const fieldSchema=require(path.join(root,"keywords/runtime/schema/field_data.json"));
function loadsMatching(pattern,run){
    const original=Module._load;let calls=0;
    Module._load=function(request,...args){if(pattern.test(request))calls++;return original.call(this,request,...args);};
    try{run();return calls;}finally{Module._load=original;}
}
function resolve(){
    const lines=['*DAMPING_GLOBAL',' '.repeat(80)];
    return schemaModule.resolveCardForDocumentLine({version:1,lineCount:2,lineAt:i=>({text:lines[i]})},1,fieldSchema,
        {keywordLine:0,dataLineOrdinal:1,observedDataLines:lines.slice(1)});
}
describe('profile-backed module reuse without changing reader cache semantics',function(){
    this.timeout(30000);
    it('reuses projected rules without loading native help again, and projects after catalog reset',function(){
        catalogModule.resetCatalogInputFormCatalogV4ForTesting();
        const catalog=catalogModule.getCatalogInputFormCatalogV4();let first;
        assert.ok(loadsMatching(/nativeDescriptorHelp$/,()=>{first=catalog.formForKeyword('DAMPING_GLOBAL');})>0);
        const count=loadsMatching(/nativeDescriptorHelp$/,()=>{for(let i=0;i<100;i++)assert.deepEqual(catalog.formForKeyword('DAMPING_GLOBAL'),first);});
        assert.equal(count,0,'hot projection must use existing projectedRules');
        catalogModule.resetCatalogInputFormCatalogV4ForTesting();
        const next=catalogModule.getCatalogInputFormCatalogV4();assert.notEqual(next,catalog);
        assert.ok(loadsMatching(/nativeDescriptorHelp$/,()=>assert.deepEqual(next.formForKeyword('DAMPING_GLOBAL'),first))>0);
    });
    it('keeps circular imports lazy while reusing modules across uncached document reads',function(){
        const initial=resolve();assert.equal(initial.status,'resolved');assert.ok(initial.cardInfo.card.every(f=>f.nativeStaticBinding));
        const calls=loadsMatching(/(?:managerFieldHelpResolution|keywordSchema)$/,()=>{
            for(let i=0;i<25;i++)assert.deepEqual(resolve(),initial);
        });
        assert.equal(calls,0,'uncached reader must not repeat module resolution');
        // Cache the module object rather than a function snapshot: existing test/application replacements remain visible.
        const manager=require(path.join(root,'out/core/hover/managerFieldHelpResolution')),previous=manager.managerHelpLookups;let seen=0;
        manager.managerHelpLookups=(...args)=>{seen++;return previous(...args);};
        try{assert.deepEqual(resolve(),initial);assert.equal(seen,1);}finally{manager.managerHelpLookups=previous;}
    });
    it('reuses verified ordinal decisions without copying the full form for each cursor position',function(){
        const {nativeFieldsNeedOnlyOrdinal}=require('../../../out/core/semantics/nativeFieldResolution');
        catalogModule.resetCatalogInputFormCatalogV4ForTesting();
        const catalog=catalogModule.getCatalogInputFormCatalogV4(),previous=catalog.formForKeyword;let calls=0;
        catalog.formForKeyword=function(...args){calls++;return previous.apply(this,args);};
        try{
            for(const [keyword,expected]of [['DAMPING_GLOBAL',true],['MAT_CONCRETE_EC2',false]]){
                const before=calls;
                for(let i=0;i<3;i++)assert.equal(nativeFieldsNeedOnlyOrdinal(keyword),expected,keyword);
                assert.equal(calls-before,1,keyword+': repeated cursor reads must not clone the form');
            }
        }finally{catalog.formForKeyword=previous;catalogModule.resetCatalogInputFormCatalogV4ForTesting();}
    });
    it('retries unavailable ordinal authority and rechecks a replacement catalog',function(){
        const {nativeFieldsNeedOnlyOrdinal}=require('../../../out/core/semantics/nativeFieldResolution');
        catalogModule.resetCatalogInputFormCatalogV4ForTesting();
        const catalog=catalogModule.getCatalogInputFormCatalogV4(),previous=catalog.formForKeyword;let mode='throws',calls=0;
        catalog.formForKeyword=function(...args){
            calls++;
            if(mode==='throws')throw new Error('unavailable');
            if(mode==='missing')return null;
            const form=previous.apply(this,args);
            if(mode==='source')form.source.datasetSha256='unverified';
            if(mode==='diagnostic')form.source.isUnauditedDiagnostic=true;
            return form;
        };
        try{
            for(mode of ['throws','missing','source','diagnostic'])assert.equal(nativeFieldsNeedOnlyOrdinal('DAMPING_GLOBAL'),false,mode);
            mode='approved';assert.equal(nativeFieldsNeedOnlyOrdinal('DAMPING_GLOBAL'),true);
            assert.equal(nativeFieldsNeedOnlyOrdinal('DAMPING_GLOBAL'),true);assert.equal(calls,5);
        }finally{catalog.formForKeyword=previous;catalogModule.resetCatalogInputFormCatalogV4ForTesting();}
        const next=catalogModule.getCatalogInputFormCatalogV4(),nextRead=next.formForKeyword;let checked=0;
        next.formForKeyword=function(...args){checked++;const form=nextRead.apply(this,args);form.source.datasetSha256='unverified';return form;};
        try{assert.equal(nativeFieldsNeedOnlyOrdinal('DAMPING_GLOBAL'),false);assert.equal(checked,1);}
        finally{next.formForKeyword=nextRead;catalogModule.resetCatalogInputFormCatalogV4ForTesting();}
    });
});
