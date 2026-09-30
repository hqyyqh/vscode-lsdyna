'use strict';
const assert = require('node:assert/strict');
const {fakeDoc} = require('./helpers');
const {buildKeywordOptionViewModel: model, getCardInfoForDocumentLineWithSuggest: resolve, optionSwitchReplacement} = require('../out/extension')._internals;
const editor = document => ({document,selection:{active:{line:0,character:0}}});
describe('tagged module drafts and verified EOF', function () {
    this.timeout(30000);
    it('shrinks repeated groups without reusing removed fibers as direction cards or shifting the next module', () => {
        for (const keyword of ['MAT_295','MAT_295_TITLE','MAT_ANISOTROPIC_HYPERELASTIC','MAT_ANISOTROPIC_HYPERELASTIC_TITLE'])
            for (const format of ['standard','comma','long','i10']) for (const order of [['ISO','ANISO'],['ANISO','ISO']])
                for (const tail of [[],[20],[20,21]]) {
                    // Fixed manual: two fiber pairs, second pair FTYPE=2. The
                    // optional direction cards retain their own source identity.
                    const modules = {ISO:[2,6],ANISO:[7,8,9,8,10]};
                    const cards = [1,...order.flatMap(tag => modules[tag]),...tail];
                    const values = {1:[1,1,0],2:['ISO',-3,0,0.49],6:[1,1],7:['ANISO',1,0,2],
                        8:[0,1,1],9:[1,0,1,1],10:[2,0,1,1,1],20:[10,20,30,1,0,0,0],21:[1,0,0,0,1,0,0,0]};
                    const serialize = row => format === 'comma' ? row.join(',') : row.map(v => String(v).padStart(format === 'long' ? 20 : 10)).join('');
                    const title = keyword.endsWith('_TITLE');
                    const header = '*' + keyword + (format === 'long' ? ' +' : format === 'i10' ? ' %' : '');
                    const doc = fakeDoc([header,...(title ? ['source title'] : []),...cards.map(c => serialize(values[c])),'*END'].join('\n'));
                    const before = doc.getText(), base = model(editor(doc),0,{});
                    assert.notEqual(base.plan.status,'blocked',keyword + '/' + format);
                    const count = base.managerCards.find(c => c.cardIndex === 7).fields.find(f => f.name === 'NF');
                    const changed = model(editor(doc),0,{fieldDrafts:{[count.fieldId]:'1'}});
                    const target = [1,...order.flatMap(tag => tag === 'ISO' ? [2,6] : [7,8,9]),...tail];
                    assert.equal(changed.plan.status,'ready',changed.plan.reason);
                    assert.deepEqual(changed.targetLayout.records.map(r => r.lsppCardIndex),[...(title ? [0] : []),...target]);
                    assert.equal(doc.getText(),before);
                    assert.equal(resolve(doc,cards.indexOf(10) + 1 + Number(title)).cardInfo.nativeCardIndex,10);
                    const reopened = fakeDoc(optionSwitchReplacement(doc,changed,changed).text + '*END');
                    const next = model(editor(reopened),0,{});
                    assert.equal(next.plan.status,'no-change',JSON.stringify({keyword,format,order,tail,reason:next.plan.reason,text:reopened.getText()}));
                    assert.deepEqual(next.managerCards.map(c => c.cardIndex),[...(title ? [0] : []),...target]);
                    if (tail.length) assert.equal(next.managerCards.find(c => c.cardIndex === 20).fields[0].value,'10');
                }
    });
    it('does not serialize changed or unresolved module names using the old module grammar', () => {
        const row = values => values.map(v => String(v).padStart(10)).join('');
        const doc = fakeDoc(['*MAT_295',row([1,1,0]),row(['ISO',-3,0,0.49]),row([1,1]),'*END'].join('\n'));
        const base = model(editor(doc),0,{}), tag = base.managerCards.find(c => c.cardIndex === 2).fields[0];
        for (const value of ['ANISO','UNKNOWN_MODULE','&unknown_tag']) {
            const changed = model(editor(doc),0,{fieldDrafts:{[tag.fieldId]:value}});
            assert.equal(changed.plan.status,'blocked',value);
            assert.equal(resolve(doc,3).cardInfo.nativeCardIndex,6);
        }
    });
    it('does not interpret a blank or numeric draft of an existing optional module as EOF', () => {
        const row = values => values.map(v => String(v).padStart(10)).join('');
        const doc = fakeDoc(['*MAT_295',row([1,1,0]),row(['ISO',-3,0,0.49]),row([1,1]),
            row(['ANISO',1,0,1]),row([0,1,1]),row([1,0,1,1]),'*END'].join('\n'));
        const base = model(editor(doc),0,{}), tag = base.managerCards.find(c => c.cardIndex === 7).fields[0];
        for (const value of ['', '0', '1', '&unknown_tag']) {
            const changed = model(editor(doc),0,{fieldDrafts:{[tag.fieldId]:value}});
            assert.equal(changed.plan.status,'blocked',JSON.stringify({value,reason:changed.plan.reason}));
            assert.equal(resolve(doc,6).cardInfo.nativeCardIndex,9);
        }
    });
});
