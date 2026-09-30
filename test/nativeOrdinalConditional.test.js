'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), zlib = require('node:zlib'), crypto = require('node:crypto');
const { fakeDoc } = require('./helpers');
const schema = require('../out/core/keywordSchema');
const { LsdynaFieldHoverProvider, buildKeywordOptionViewModel } = require('../out/extension')._internals;
const { nativeFileReadContext } = require('../out/core/semantics/nativeFileReadContext');
const { getCatalogInputFormCatalogV4 } = require("../out/core/semantics/catalogInputFormCatalogV4");
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/conditional-reader-cases.json.gz')));
const cases = fixture.cases, proof = { observations: fixture.reads.map(read => ({ ...read, kind: 'fields' })) }, input = fixture.input.split(/\r?\n/);

describe('native ordinal conditional records', () => {

    it('maps every actual native field through parsing and the real hover provider in all four formats', async function () {
        this.timeout(20000);
        const provider=new LsdynaFieldHoverProvider();
        for (const item of cases) {
            const end=item.records.at(-1).line+1;
            const doc={...fakeDoc(input.slice(item.keywordLine,end).join('\n')),version:1};
            for (const record of item.records) {
                const native=proof.observations.find(o=>o.kind==='fields' && o.sourceLine===record.line);
                assert.ok(native);
                const line=record.line-item.keywordLine;
                const result=schema.resolveCardForDocumentLine(doc,line,undefined,{keywordLine:0,globalInputFormat:'standard'});
                assert.equal(result.status,'resolved',`${item.keyword}:${item.format}:${line}:${result.reason}`);
                assert.equal(result.cardInfo.nativeCardIndex,record.cardIndex);
                assert.deepEqual(result.cardInfo.card.map(f=>f.nativeIdentity.fieldRecordId),native.fields.map(f=>f.descriptorAddress));
                for (const field of result.cardInfo.card) {
                    const hover=await provider.provideHover(doc,{line,character:field.nativeRange.start});
                    assert.ok(hover?.contents[0].value.includes(`**${field.n}**`),`${item.keyword}:${field.n}`);
                    assert.equal(hover.range.end.character,field.nativeRange.end);
                }
            }
        }
    });

    it('preserves unknown-control heads, source instances and existing branch-edit restrictions', () => {
        const keyword='BOUNDARY_AMBIENT';
        const form=getCatalogInputFormCatalogV4().formForKeyword(keyword);
        const rule={...form.rules[form.reference.formRuleIds[0]],catalogSource:form.source};
        const reading=nativeFileReadContext(rule,'*'+keyword,['1,2,0,0','3,4,4,0','5,6'],'standard');
        assert.deepEqual(reading.select().current.map(r=>[r.cardIndex,r.instanceStart]),[[1,0],[1,1],[2,1]]);
        assert.equal(reading.select(false,(record,field,value)=>record.instanceStart===0 && field===2?'4':value),null);
        assert.deepEqual(nativeFileReadContext(rule,'*'+keyword,['1,2,&UNKNOWN,0','3,4'],'standard').select(true).current.map(r=>r.cardIndex),[1]);
        const doc={...fakeDoc('*BOUNDARY_AMBIENT\n1,2,0,0\n$# wrong\n3,4,4,0\n5,6'),version:1};
        const model=buildKeywordOptionViewModel({document:doc,selection:{active:{line:1,character:0}}},1,{});
        assert.ok(model);
        assert.deepEqual(model.managerCards.map(card=>card.fields.map(field=>field.name)),
            [['SETID','MMG','AMBTYP','SIDR']]);
        const second=buildKeywordOptionViewModel({document:doc,selection:{active:{line:3,character:0}}},3,{});
        assert.deepEqual(second.managerCards.map(card=>card.fields.map(field=>field.name)),
            [['SETID','MMG','AMBTYP','SIDR'],['LCID1','LCID2']]);
    });
});
