'use strict';
const assert = require('node:assert/strict');
const {fakeDoc,vscodeMock:vscode} = require('../../support/helpers');
const api = require('../../../out/extension')._internals;
const ks = require('../../../out/core/keywordSchema');
const {getCatalogInputFormCatalogV4} = require("../../../out/core/semantics/catalogInputFormCatalogV4");
const base = 'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE';
const deck = '*'+base+'\n11,22\n0,0,0,0,0,0,0,1e20\n1,1,0,0,1,1,1,1\n*END';
function editor(text) {
    const document = Object.assign(fakeDoc(text), {uri:vscode.Uri.file('D:/temp/contact-thermal.k'),languageId:'lsdyna',version:1,eol:1,isClosed:false});
    return {document,selection:{active:new vscode.Position(0,0)}};
}
function reopen(model, e) {
    const replacement = api.optionSwitchReplacement(e.document,model,model);
    assert.ok(api.keywordManagerReplacementMatchesTarget(e.document,model,model,replacement));
    const next = editor(replacement.text+'*END');
    const opened = api.buildKeywordOptionViewModel(next,0,{});
    assert.equal(opened.readonly,false,model.targetKeyword+': '+opened.inputFormSourceError);
    assert.equal(opened.plan.status,'no-change',opened.plan.reason);
    return {e:next,m:opened};
}
function choose(m, value) {
    return {[m.controls.find(c=>c.choices.some(v=>v.value==='Thermal')).controlId]:value};
}
describe('CONTACT thermal composition across consumers', function () {
    this.timeout(60000);
    it('keeps verified composition cards separate from the original optional file-record pool', () => {
        const catalog=getCatalogInputFormCatalogV4();
        const {nativeFileLayoutCards,nativeFileLayoutKind}=require("../../../out/core/semantics/catalogNativeFileLayout");
        const raw=catalog.formForKeyword(base,false),composed=catalog.formForKeyword(base);
        const id=composed.reference.formRuleIds[0];
        const rawRule={...raw.rules[id],catalogSource:raw.source};
        const composedRule={...composed.rules[id],catalogSource:composed.source};
        assert.equal(composedRule.contactComposition,true);
        assert.deepEqual(composedRule.cards.map(card=>card.cardIndex),[1,2,3]);
        assert.strictEqual(nativeFileLayoutCards(composedRule,base),composedRule.cards);
        assert.equal(nativeFileLayoutKind(composedRule,base),null);
        assert.equal(nativeFileLayoutKind(rawRule,base),'contact-optional-records');
        assert.deepEqual(nativeFileLayoutCards(rawRule,base).map(card=>card.cardIndex),
            Array.from({length:10},(_,index)=>index+1));
    });
    it('saves, reopens, hovers and edits both complete thermal spellings', async () => {
        for (const value of ['Thermal','T_Friction']) {
            const e=editor(deck), current=api.buildKeywordOptionViewModel(e,0,{});
            const staged=api.buildKeywordOptionViewModel(e,0,{draftControlState:choose(current,value)});
            assert.equal(staged.plan.status,'ready',staged.plan.reason);
            const {e:next,m}=reopen(staged,e);
            assert.ok(ks.lookupKeywordSchema(m.currentKeyword));
            assert.ok(getCatalogInputFormCatalogV4().formForKeyword(m.currentKeyword));
            const field=m.managerCards.flatMap(c=>c.fields).find(f=>f.name==='K');
            assert.equal(field.editable,true);
            const help=api.keywordManagerHelpState({...m,selectedFieldId:field.fieldId});
            assert.equal(help.status,'ready',help.reason);
            assert.ok(help.english && help.localized);
            const hover=await new api.LsdynaFieldHoverProvider().provideHover(next.document,{line:field.line,character:field.position+1});
            assert.ok(hover);
            const edited=api.buildKeywordOptionViewModel(next,0,api.keywordManagerEditField(m,field.fieldId,'1.25'));
            assert.equal(api.buildKeywordOptionsViewState(edited).canApply,true,edited.plan.reason);
            assert.equal(reopen(edited,next).m.managerCards.flatMap(c=>c.fields).find(f=>f.name==='K').value,'1.25');
        }
    });
    it('consumes FORMULA parameters before mechanical cards and resizes them on edits', () => {
        for (const formula of [0,1,-1,-8,-9]) {
            const rows=['*'+base+'_THERMAL_FRICTION','11,22','0,0','1,1','1,0,2','0,0,'+formula,
                ...Array.from({length:formula<0?Math.ceil(-formula/8):0},()=> '0.25,0.5'), '0,0.1','*END'];
            const e=editor(rows.join('\n')),m=api.buildKeywordOptionViewModel(e,0,{});
            assert.equal(m.readonly,false,m.inputFormSourceError);
            assert.equal(m.plan.status,'no-change',m.plan.reason);
            assert.equal(m.controls.find(c=>c.choices.some(v=>v.value==='ABCDEFG')).value,'A');
            const parameters=m.managerCards.filter(c=>c.fields[0]?.name==='UC1');
            assert.equal(parameters.length,formula<0?Math.ceil(-formula/8):0);
            const overview=ks.getRenderedCardsForLookup(ks.lookupKeywordSchema(m.currentKeyword),rows.slice(1,-1));
            assert.deepEqual(overview.map(c=>c[0].n),m.managerCards.map(c=>c.fields[0].name));
            for(const card of parameters) {
                const info=ks.getCardInfoForDocumentLine(e.document,card.line);
                assert.equal(info.card[0].n,'UC1');
                assert.equal(api.keywordManagerHelpState({...m,selectedFieldId:card.fields[0].fieldId}).status,'ready');
            }
            const field=m.managerCards.flatMap(c=>c.fields).find(f=>f.name==='FORMULA');
            const staged=api.buildKeywordOptionViewModel(e,0,api.keywordManagerEditField(m,field.fieldId,'-9'));
            assert.equal(staged.managerCards.filter(c=>c.fields[0]?.name==='UC1').length,2);
            const {m:opened}=reopen(staged,e);
            assert.equal(opened.managerCards.filter(c=>c.fields[0]?.name==='UC1').length,2);
        }
    });
    it('uses complete record drafts for FORMULA and reviews removed nonblank parameters before applying', async () => {
        const e=editor('*'+base+'_THERMAL_FRICTION\n11,22\n0,0\n1,1\n1\n0,0,-9\n0.25\n0.5\n0,0.1\n*END');
        const m=api.buildKeywordOptionViewModel(e,0,{});
        const formula=m.managerCards.flatMap(c=>c.fields).find(f=>f.name==='FORMULA');
        const record=m.targetLayout.records.find(r=>r.fields.some(f=>f.fieldMigrationId===formula.fieldId));
        const staged=api.buildKeywordOptionViewModel(e,0,{recordDrafts:{[record.recordMigrationId]:'0,0,1'}});
        assert.equal(staged.plan.status,'ready',staged.plan.reason);
        assert.equal(staged.managerCards.filter(c=>c.fields[0]?.name==='UC1').length,0);
        assert.equal(api.buildKeywordOptionsViewState(staged).preview.reviewLevel,'destructive');
        assert.ok(staged.plan.discardedFields.some(f=>f.name==='UC1'&&Number(f.value)===0.25));
        const originalWarning=vscode.window.showWarningMessage,originalApply=vscode.workspace.applyEdit;
        let warnings=0,writes=0;
        vscode.window.showWarningMessage=async()=>{warnings++;return undefined;};
        vscode.workspace.applyEdit=async()=>{writes++;return true;};
        try {
            assert.equal(await api.applyKeywordOptionViewModel({getModel:()=>staged,markStale(){}},e),null);
            assert.equal(warnings,1);
            assert.equal(writes,0);
            assert.equal(e.document.getText(),m.sourceDocument.getText());
        } finally {vscode.window.showWarningMessage=originalWarning;vscode.workspace.applyEdit=originalApply;}
        assert.equal(reopen(staged,e).m.managerCards.filter(c=>c.fields[0]?.name==='UC1').length,0);
    });
    it('does not authorize thermal writes when catalog source identity changes', () => {
        const catalog=getCatalogInputFormCatalogV4(),original=catalog.resolveFormForKeyword;
        catalog.resolveFormForKeyword=function(...args) {
            const form=original.apply(this,args);
            return form&&{...form,source:{...form.source,datasetSha256:'0'.repeat(64)}};
        };
        try {
            const e=editor('*'+base+'_THERMAL\n11,22\n0,0\n1,1\n1\n*END');
            const m=api.buildKeywordOptionViewModel(e,0,{});
            assert.equal(m.readonly,true);
            assert.equal(api.buildKeywordOptionsViewState(m).canApply,false);
        } finally {catalog.resolveFormForKeyword=original;}
    });
    it('keeps verified native spellings separate from manual parameter rows and unknown controls', async () => {
        const keyword='CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION_ID_MPP';
        const native=require('../../../keywords/runtime/native-readers/lspp-contact-mpp-tail-readers.json').bindings[keyword];
        const catalog=getCatalogInputFormCatalogV4();
        const raw=catalog.formForKeyword(native.baseKeyword,false);
        const composed=catalog.formForKeyword(keyword);
        assert.ok(raw.reference.formRuleIds.some(id=>raw.rules[id].cardSetId===native.cardSetId));
        assert.ok(raw.reference.formRuleIds.every(id=>!raw.rules[id].contactComposition));
        assert.ok(composed.reference.formRuleIds.some(id=>composed.rules[id].contactComposition));
        assert.equal(require("../../../out/core/semantics/catalogNativeFileLayout").nativeSpellingBinding(
            'CONTACT_SURFACE_TO_SURFACE_ID_THERMAL_FRICTION_MPP'),undefined);
        const provider=new api.LsdynaFieldHoverProvider();
        for(const formula of ['0','-1','-9','&missing']) {
            const count=formula==='-1'?1:formula==='-9'?2:formula==='&missing'?1:0;
            const e=editor(['*'+keyword,'7,keep title','0','11,22','0,0','1,1','1','0,0,'+formula,
                ...Array.from({length:count},()=> '0.25,0.5'),'0,0.1','*END'].join('\n'));
            const m=api.buildKeywordOptionViewModel(e,0,{});
            if(formula==='&missing') {
                assert.equal(api.buildKeywordOptionsViewState(m).canApply,false);
                assert.equal(ks.getCardInfoForDocumentLine(e.document,8),null);
                continue;
            }
            assert.equal(m.readonly,false,m.inputFormSourceError);
            assert.equal(m.plan.status,'no-change',m.plan.reason);
            const info=ks.getCardInfoForDocumentLine(e.document,1);
            assert.equal(info.resolutionSource,'native-file-reader');
            assert.equal(info.card[0].nativeIdentity.fieldRecordId,native.prefixCard.fields[0].fieldRecordId);
            for(const card of m.managerCards.filter(c=>c.fields[0]?.name==='UC1')) {
                const parameterInfo=ks.getCardInfoForDocumentLine(e.document,card.line);
                assert.equal(parameterInfo.card[0].n,'UC1');
                assert.equal(parameterInfo.card[0].nativeIdentity,undefined);
                assert.ok(await provider.provideHover(e.document,{line:card.line,character:card.fields[0].position}));
            }
            assert.equal(m.managerCards.filter(c=>c.fields[0]?.name==='UC1').length,count);
        }
    });
    it('preserves ID, MPP2, optional cards and comments while changing the thermal state', () => {
        const text=['*'+base+'_ID_MPP_THERMAL_FRICTION','7         retain title','0','&         0','11,22','0,0','1,1','1,0,2','0,0,-1','$ parameters','0.25','0,0.1','*END'].join('\n');
        let e=editor(text),m=api.buildKeywordOptionViewModel(e,0,{});
        assert.equal(m.plan.status,'no-change',m.plan.reason);
        assert.equal(m.controls.find(c=>c.choices.some(v=>v.value==='MPP2')).value,'MPP2');
        for(const value of ['Thermal','T_Friction','']) {
            const staged=api.buildKeywordOptionViewModel(e,0,{draftControlState:choose(m,value)});
            assert.equal(staged.plan.status,'ready',staged.plan.reason);
            const next=reopen(staged,e);e=next.e;m=next.m;
            assert.equal(m.controls.find(c=>c.choices.some(v=>v.value==='MPP2')).value,'MPP2');
            assert.equal(m.controls.find(c=>c.choices.some(v=>v.value==='ABCDEFG')).value,'A');
            assert.ok(e.document.getText().includes('retain title'));
            assert.ok(e.document.getText().includes('$ parameters'));
            assert.ok(m.managerCards.find(c=>c.fields[0]?.name==='SOFT'));
        }
    });
    it('blocks unknown FORMULA controls and rejects unverified suffixes', () => {
        const e=editor('*'+base+'_THERMAL_FRICTION\n11,22\n0,0\n1,1\n1\n0,0,&unknown\n0.25\n*END');
        const m=api.buildKeywordOptionViewModel(e,0,{});
        assert.equal(api.buildKeywordOptionsViewState(m).canApply,false);
        assert.equal(m.plan.status,'blocked');
        const overview=ks.getRenderedCardsForLookup(ks.lookupKeywordSchema(base+'_THERMAL_FRICTION'),
            ['11,22','0,0','1,1','1','0,0,&unknown','0.25']);
        assert.equal(overview.length,5);
        assert.equal(overview.some(c=>c[0].n==='UC1'||c[0].n==='SOFT'),false);
        assert.equal(ks.getCardInfoForDocumentLine(e.document,6),null);
        for(const keyword of [base+'_THERMAL_THERMAL',base+'_THERMAL_FRICTION_FRICTION','CONTACT_NODES_TO_SURFACE_THERMAL']) {
            assert.equal(ks.lookupKeywordSchema(keyword),null);
            assert.equal(getCatalogInputFormCatalogV4().formForKeyword(keyword),null);
        }
    });
    it('reopens supported formats with ID, MPP and optional-card combinations', () => {
        const serializer=require('../../../out/core/edit/keywordRecordSerializer');
        for(const mode of ['standard','long','i10','comma']) for(const id of ['', 'ID'])
        for(const mpp of ['', 'MPP1','MPP2']) for(const optional of ['', 'A','ABCDEFG']) {
            const fixed=mode==='comma'?'standard':mode;
            const rows=ks.loadKeywordSchema()[base].c.map(card=>serializer.blankRecord(card.map(f=>({name:f.n,type:f.t,position:f.p,width:f.w})),mode));
            const e=editor('*'+base+(fixed==='long'?' +':fixed==='i10'?' %':'')+'\n'+rows.join('\n')+'\n*END');
            const current=api.buildKeywordOptionViewModel(e,0,{});
            const selections=Object.fromEntries(current.controls.map(c=>[c.controlId,c.choices.some(v=>v.value==='ID')?id:
                c.choices.some(v=>v.value==='MPP2')?mpp:c.choices.some(v=>v.value==='ABCDEFG')?optional:'T_Friction']));
            const staged=api.buildKeywordOptionViewModel(e,0,{draftControlState:selections});
            assert.equal(staged.plan.status,'ready',`${mode}/${id}/${mpp}/${optional}: ${staged.plan.reason}`);
            const {e:next,m}=reopen(staged,e);
            const k=m.managerCards.flatMap(c=>c.fields).find(f=>f.name==='K');
            const info=ks.getCardInfoForDocumentLine(next.document,k.line);
            assert.equal(info.card[0].n,'K');
            assert.equal(k.editable,true);
        }
    });
    it('switches and reopens both thermal values for every imported CONTACT family',()=> {
        const source=require('../../../keywords/runtime/engineering/contactThermal.json');
        for(const [family,profile] of Object.entries(source.profiles)) {
            let cards=ks.loadKeywordSchema()[family].c;
            if(profile.mechanicalCondition==='tiebreak')cards=cards.filter(c=>!['G1C_0','G2C_0','RFILTF','DMP_1'].includes(c[0].n));
            if(profile.mechanicalCondition==='weld')cards=cards.filter(c=>c[0].n!=='TPRM1');
            let e=editor('*'+family+'\n'+cards.map(()=>''.padEnd(80)).join('\n')+'\n*END');
            let m=api.buildKeywordOptionViewModel(e,0,{});
            assert.equal(m.plan.status,'no-change',family+': '+m.plan.reason);
            for(const value of ['Thermal','T_Friction','','T_Friction']) {
                const staged=api.buildKeywordOptionViewModel(e,0,{draftControlState:choose(m,value)});
                assert.equal(staged.plan.status,'ready',family+'/'+value+': '+staged.plan.reason);
                const next=reopen(staged,e);e=next.e;m=next.m;
                assert.equal(m.managerCards.filter(c=>c.fields[0]?.name==='K').length,value?1:0,family);
                assert.equal(m.managerCards.filter(c=>c.fields[0]?.name==='LCFST').length,value==='T_Friction'?1:0,family);
                const rendered=ks.getRenderedCardsForLookup(ks.lookupKeywordSchema(m.currentKeyword),m.block.records.map(r=>r.text));
                assert.deepEqual(rendered.slice(0,m.managerCards.length).map(c=>c[0].n),m.managerCards.map(c=>c.fields[0].name),family);
                if(value) {
                    const k=m.managerCards.flatMap(c=>c.fields).find(f=>f.name==='K');
                    assert.equal(k.editable,true,family);
                    assert.equal(ks.getCardInfoForDocumentLine(e.document,k.line).card[0].n,'K',family);
                    assert.equal(api.keywordManagerHelpState({...m,selectedFieldId:k.fieldId}).status,'ready',family);
                }
            }
        }
    });
    const thermalSource=require('../../../keywords/runtime/engineering/contactThermal.json');
    for(const [keyword,capability] of Object.entries(thermalSource.applicability)) {
        it(`retains native controls instead of filtering them with manual applicability (${keyword})`,()=> {
            const form=getCatalogInputFormCatalogV4().formForKeyword(keyword);
            if(!form)return;
            const selectors=(form.reference.selectorRuleIds||[]).flatMap(id=>form.rules[id].selectors);
            const raw=getCatalogInputFormCatalogV4().formForKeyword(keyword,false);
            const native=(raw?.reference.selectorRuleIds||[]).flatMap(id=>raw.rules[id].selectors);
            for(const selector of native) assert.ok(selectors.some(s=>s.controlId===selector.controlId),keyword);
            if(!capability.thermal)assert.equal(thermalSource.spellings[keyword+'_THERMAL_FRICTION'],undefined,keyword);
        });
    }
    it('rejects unsupported thermal drafts while preserving native selectors',()=> {
        for(const family of ['CONTACT_NODES_TO_SURFACE','CONTACT_AIRBAG_SINGLE_SURFACE','CONTACT_AUTOMATIC_GENERAL','CONTACT_SPOTWELD']) {
            const e=editor('*'+family+'\n11,22\n0,0\n1,1\n*END');
            const m=api.buildKeywordOptionViewModel(e,0,{});
            const raw=getCatalogInputFormCatalogV4().formForKeyword(family,false);
            assert.equal(m.controls.some(c=>c.choices.some(v=>v.value==='Thermal')),
                (raw.reference.selectorRuleIds||[]).some(id=>raw.rules[id].selectors.some(s=>s.controlId===thermalSource.controlId)),family);
            const staged=api.buildKeywordOptionViewModel(e,0,{draftControlState:{[thermalSource.controlId]:'Thermal'}});
            assert.equal(api.buildKeywordOptionsViewState(staged).canApply,false,family);
        }
    });
    it('keeps native selectors visible while supplementing missing write conditions',()=> {
        for(const family of ['CONTACT_TIED_NODES_TO_SURFACE','CONTACT_TIED_SHELL_EDGE_TO_SURFACE']) for(const raw of ['0','4','8','1.5','&missing']) {
            const e=editor('*'+family+'\n11,22,'+raw+'\n0,0\n1,1\n*END');
            const m=api.buildKeywordOptionViewModel(e,0,{});
            assert.equal(m.controls.some(c=>c.choices.some(v=>v.value==='Thermal')),true,family+'/'+raw);
            const surf=m.managerCards.flatMap(c=>c.fields).find(f=>f.name==='SURFATYP');
            const staged=api.buildKeywordOptionViewModel(e,0,api.keywordManagerEditField(m,surf.fieldId,'0'));
            assert.equal(staged.controls.some(c=>c.choices.some(v=>v.value==='Thermal')),true,family);
            const chosen=api.buildKeywordOptionViewModel(e,0,{...api.keywordManagerEditField(m,surf.fieldId,'0'),draftControlState:choose(staged,'T_Friction')});
            assert.equal(chosen.plan.status,'ready',family+'/'+raw+': '+chosen.plan.reason);
            const {m:opened,e:next}=reopen(chosen,e);
            const field=opened.managerCards.flatMap(c=>c.fields).find(f=>f.name==='SURFATYP');
            const invalid=api.buildKeywordOptionViewModel(next,0,api.keywordManagerEditField(opened,field.fieldId,'4'));
            assert.equal(api.buildKeywordOptionsViewState(invalid).canApply,false,family);
            const disabled=api.buildKeywordOptionViewModel(next,0,{...api.keywordManagerEditField(opened,field.fieldId,'4'),draftControlState:choose(opened,'')});
            assert.equal(disabled.plan.status,'ready',disabled.plan.reason);
        }
    });
    it('keeps conditional Card 4 and UC rows before friction and optional cards',()=> {
        for(const family of ['CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_TIEBREAK','CONTACT_AUTOMATIC_ONE_WAY_SURFACE_TO_SURFACE_TIEBREAK_DAMPING'])
        for(const [option,param,expected] of [[1,0,[]],[9,0,family.endsWith('DAMPING')?['DMP_1']:[]],[13,0,['G1C_0','G2C_0']],[14,-0.5,['G1C_0','G2C_0','RFILTF']]]) {
            const extras=expected.map(()=>''.padEnd(80));
            const e=editor('*'+family+'_THERMAL_FRICTION\n11,22\n0,0\n1,1\n'+option+',0,0,'+param+'\n'+extras.join('\n')+(extras.length?'\n':'')+'1\n0,0,-9\n0.25\n0.5\n0,0.1\n*END');
            const m=api.buildKeywordOptionViewModel(e,0,{});
            assert.equal(m.plan.status,'no-change',family+'/'+option+': '+m.plan.reason);
            const names=m.managerCards.map(c=>c.fields[0].name);
            assert.deepEqual(names.slice(4,4+extras.length),expected);
            assert.deepEqual(names.slice(4+extras.length),['K','LCFST','UC1','UC1','SOFT']);
            const rendered=ks.getRenderedCardsForLookup(ks.lookupKeywordSchema(m.currentKeyword),m.block.records.map(r=>r.text));
            assert.deepEqual(rendered.slice(0,names.length).map(c=>c[0].n),names);
            const field=m.managerCards.flatMap(c=>c.fields).find(f=>f.name==='OPTION');
            const staged=api.buildKeywordOptionViewModel(e,0,api.keywordManagerEditField(m,field.fieldId,'13'));
            assert.equal(staged.plan.status,option===13?'no-change':'ready',staged.plan.reason);
            reopen(staged,e);
        }
        for(const family of ['CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_TIED_WELD','CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_MORTAR_TIED_WELD'])
        for(const [temp,count,expected] of [[100,0,0],...(family.includes('MORTAR')?[[-1,1,1],[-1,9,2]]:[])]) {
            const e=editor('*'+family+'_THERMAL_FRICTION\n11,22\n0,0\n1,1\n'+temp+',0,0,'+count+'\n'+Array.from({length:expected},()=> '0.25').join('\n')+(expected?'\n':'')+'1\n0,0,-1\n0.5\n0,0.1\n*END');
            const m=api.buildKeywordOptionViewModel(e,0,{});
            assert.equal(m.plan.status,'no-change',family+'/'+count+': '+m.plan.reason);
            assert.equal(m.managerCards.filter(c=>c.fields[0]?.name==='TPRM1').length,expected);
            const k=m.managerCards.flatMap(c=>c.fields).find(f=>f.name==='K');
            assert.equal(ks.getCardInfoForDocumentLine(e.document,k.line).card[0].n,'K');
        }
    });
    it('retains each family identity with ID, MPP2, optional tails and FORMULA parameters',()=> {
        const source=require('../../../keywords/runtime/engineering/contactThermal.json');
        assert.equal(require('../../../out/core/semantics/contactThermal').equivalentContactThermalSpelling(
            'CONTACT_SURFACE_TO_SURFACE_THERMAL','CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_THERMAL'),false);
        for(const [family,profile] of Object.entries(source.profiles)) {
            let cards=ks.loadKeywordSchema()[family].c;
            if(profile.mechanicalCondition==='tiebreak')cards=cards.filter(c=>!['G1C_0','G2C_0','RFILTF','DMP_1'].includes(c[0].n));
            if(profile.mechanicalCondition==='weld')cards=cards.filter(c=>c[0].n!=='TPRM1');
            const e=editor('*'+family+'\n'+cards.map(()=>''.padEnd(80)).join('\n')+'\n*END');
            const m=api.buildKeywordOptionViewModel(e,0,{});
            // Keep each family's previously supported combination. Native-only
            // controls are now visible too; this replay must not select new combinations.
            const selections=Object.fromEntries(m.controls.map(c=>[c.controlId,c.choices.some(v=>v.value==='ID')?'ID':c.choices.some(v=>v.value==='MPP2')?(source.applicability[family].mpp?'MPP2':''):c.choices.some(v=>v.value==='ABCDEFG')?'A':'T_Friction']));
            const staged=api.buildKeywordOptionViewModel(e,0,{draftControlState:selections});
            assert.equal(staged.plan.status,'ready',family+': '+staged.plan.reason);
            const {e:next,m:opened}=reopen(staged,e);
            const formula=opened.managerCards.flatMap(c=>c.fields).find(f=>f.name==='FORMULA');
            const parameters=api.buildKeywordOptionViewModel(next,0,api.keywordManagerEditField(opened,formula.fieldId,'-9'));
            const final=reopen(parameters,next);
            const names=final.m.managerCards.map(c=>c.fields[0].name);
            assert.deepEqual(names.slice(0,source.applicability[family].mpp?3:1),source.applicability[family].mpp?['CID','IGNORE','&']:['CID']);
            assert.deepEqual(names.slice(names.indexOf('LCFST')+1,names.indexOf('LCFST')+3),['UC1','UC1']);
            assert.equal(names.at(-1),'SOFT');
        }
    });
    it('opens manual-order thermal spellings before OFFSET and ORTHO_FRICTION',()=> {
        const source=require('../../../keywords/runtime/engineering/contactThermal.json');
        for(const [family,profile] of Object.entries(source.profiles).filter(([,p])=>p.spellingTail)) {
            for(const value of ['Thermal','T_Friction']) {
                const suffix=value==='Thermal'?'THERMAL':'THERMAL_FRICTION';
                const name=family.slice(0,-profile.spellingTail.length)+'_'+suffix+profile.spellingTail;
                const cards=ks.getRenderedCardsForLookup(ks.lookupKeywordSchema(name),[]).filter(c=>!/^[A-G]$/.test(c[0]?.n));
                const e=editor('*'+name+'\n'+cards.slice(0,ks.lookupKeywordSchema(name).entry.c.length).map(()=>''.padEnd(80)).join('\n')+'\n*END');
                const m=api.buildKeywordOptionViewModel(e,0,{});
                assert.equal(m.plan.status,'no-change',name+': '+m.plan.reason);
                const staged=api.buildKeywordOptionViewModel(e,0,{draftControlState:choose(m,'')});
                assert.equal(staged.plan.status,'ready',name+': '+staged.plan.reason);
                assert.equal(reopen(staged,e).m.currentKeyword,'*'+family);
            }
        }
    });
});
