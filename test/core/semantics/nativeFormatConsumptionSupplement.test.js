'use strict';
require("../../support/register-out");
const assert=require('node:assert/strict'),vscode=require('vscode');
const fs=require('node:fs'),zlib=require('node:zlib'),path=require('node:path');
const {fakeDoc}=require("../../support/helpers");
const api=require("../../../out/extension")._internals;
const assertReadonlyReader=require('../../support/keyword-manager/readonly-reader.cjs');
const {nativeFileReadContext}=require("../../../out/core/semantics/nativeFileReadContext");
const {getCatalogInputFormCatalogV4}=require("../../../out/core/semantics/catalogInputFormCatalogV4");
describe('Archived supplemental actual native field consumption',function(){
    this.timeout(120000);
    const fixture=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname,"../../fixtures/public-behavior/format-consumption-supplement.json.gz"))));
    const archive={plan:{tasks:fixture.tasks}},report={checks:fixture.checks},catalog=getCatalogInputFormCatalogV4();
    const document=task=>Object.assign(fakeDoc([...task.lines,'*END'].join('\n')),{languageId:'lsdyna',version:1,eol:1,
        uri:vscode.Uri.file('D:/supplement-native/'+task.id+'.k')});
    it('matches all 102 task identities, source characters and Hover ranges to actual copy observations',async()=>{
        assert.equal(archive.plan.tasks.length,102);assert.equal(report.checks.length,1380);
        const failures=[],provider=new api.LsdynaFieldHoverProvider();let checked=0;
        for(const task of archive.plan.tasks){
            const doc=document(task),slices=report.checks.filter(c=>c.task===task.id);assert.ok(slices.length);
            for(const slice of slices){
                const line=task.lines[slice.lineOffset],start=Math.min(line.length,slice.offset),end=Math.min(line.length,slice.offset+slice.width);
                const card=api.getCardInfoForDocumentLineWithSuggest(doc,slice.lineOffset).cardInfo?.card;
                const field=card?.[slice.fieldIndex];checked++;
                try{
                    assert.equal(field?.nativeIdentity?.fieldRecordId,slice.field);
                    assert.deepEqual(field.nativeRange,{start,end});
                    assert.equal(String(field.rawValue||'').trim(),line.slice(start,end).trim());
                    const hover=await provider.provideHover(doc,{line:slice.lineOffset,character:start});
                    assert.ok(hover);assert.equal(hover.range.start.character,start);assert.equal(hover.range.end.character,end);
                }catch(error){failures.push({task:task.id,field:slice.field,flags:slice.flags,error:error.message});}
            }
        }
        assert.equal(checked,1380);
        assert.deepEqual([...new Set(failures.map(f=>f.task))],[],JSON.stringify({tasks:[...new Set(failures.map(f=>f.task))],fields:failures.length,first:failures[0]}));
    });
    it('reads manager source values with native geometry while retaining input format and filesystem read-only protection',()=>{
        const failures=[];
        for(const task of archive.plan.tasks){
            const doc=document(task),form=catalog.formForKeyword(task.keyword),rule=form.rules[task.formRuleId];
            const context=nativeFileReadContext(rule,task.lines[0],task.lines.slice(1),'standard');
            assert.equal(context.input,task.format,'actual read selection must not overwrite requested write format');
            const slices=report.checks.filter(c=>c.task===task.id);
            for(const slice of slices){
                const expected=task.lines[slice.lineOffset].slice(slice.offset,slice.offset+slice.width).trim();
                try{assert.equal(context.read(task.lines[slice.lineOffset],1,slice.fieldIndex).trim(),expected);}
                catch(error){failures.push({task:task.id,field:slice.field,error:error.message});}
                assert.equal(api.getCardFieldsForLine(doc,slice.lineOffset),null,'display-only formatting authorized');
                assert.equal(api.fieldReferenceAtPosition(doc,{line:slice.lineOffset,character:slice.offset}),null);
            }
            const model=api.buildKeywordOptionViewModel({document:doc,selection:{active:new vscode.Position(0,0)}},0,{});
            assert.deepEqual(model.block.records.map(r=>r.text),task.lines.slice(1),'manager changed source records');
            assert.equal(api.buildKeywordOptionsViewState(model).canApply,false);
            for(const field of model.managerCards.flatMap(c=>c.fields||[])){
                const slice=slices.find(c=>c.lineOffset===field.line&&c.fieldIndex===Number(field.fieldId.match(/field:(\d+)$/)?.[1]));
                if(slice)try{assert.equal(field.value,task.lines[slice.lineOffset].slice(slice.offset,slice.offset+slice.width).trim());}
                catch(error){failures.push({task:task.id,manager:field.fieldId,error:error.message});}
            }
            assertReadonlyReader(doc);
        }
        assert.deepEqual([...new Set(failures.map(f=>f.task))],[],JSON.stringify({tasks:[...new Set(failures.map(f=>f.task))],first:failures[0]}));
    });
});
