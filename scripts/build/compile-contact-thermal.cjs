'use strict';
const assert = require('node:assert/strict');
const permutations = tokens => tokens.length ? tokens.flatMap((token, i) => permutations(tokens.filter((_, j) => j !== i)).map(rest => [token, ...rest])) : [[]];

/** Compile the new manual import without changing any frozen native checkpoint. */
function compileContactThermal(source, schema, inputForm, definitions) {
    assert.equal(source.kind, 'manual-contact-thermal-composition');
    if (source.schemaVersion === 2) return compileContactFamilies(source, schema, inputForm, definitions);
    assert.equal(source.schemaVersion, 1);
    assert.deepEqual(source.parameterCard.map(f=>[f.n,f.t,f.p,f.w]),
        Array.from({length:8},(_,i)=>[`UC${i+1}`,'real',i*10,10]));
    assert.deepEqual(source.parameterCount,{controller:'FORMULA',card:2,field:2,parametersPerCard:8,maximumCards:128});
    const payload = inputForm.payloads.find(p => p.value.keywords?.[source.baseKeyword]);
    const rule = payload.value.rules[source.catalogRuleId];
    assert.equal(rule.cardSetId, source.cardSetId);
    assert.equal(inputForm.manifest.value.dataset.sha256, source.source.nativeExecutableSha256);
    const selector = payload.value.rules[source.selectorRuleId].selectors.find(s => s.controlId === source.controlId);
    for (const [value, state] of Object.entries(source.values)) {
        const cards = selector.values.find(v => v.value === value).cards;
        assert.equal(cards.length, state.cardCount);
        cards.forEach((card, i) => assert.deepEqual(card.fields.map(f => [f.name.toUpperCase(), f.position, f.width, Math.abs(f.type) === 1 ? 'integer' : 'real']),
            source.cards[i].map(f => [f.n, f.p, f.w, f.t])));
    }
    const spellings = {};
    for (const [value, state] of Object.entries({ '': {suffix: '', cardCount: 0}, ...source.values })) {
        const canonical = source.baseKeyword + (state.suffix ? '_' + state.suffix : '');
        if (state.suffix) {
            const helpCard = card => card.map(({localized, ...field}) => field);
            schema[canonical] = {...structuredClone(schema[source.baseKeyword]), c: [...structuredClone(schema[source.baseKeyword].c), ...source.cards.slice(0, state.cardCount).map(helpCard)]};
            if (state.cardCount === 2) {
                schema[canonical].o.push({n:'UC',co:'post/0',to:0,c:[helpCard(source.parameterCard)]});
            }
        }
        for (const id of ['', 'ID', 'TITLE']) for (const mpp of source.mppAllowed===false?[false]:[false, true]) {
            const tokens = [state.suffix, id, mpp ? 'MPP' : ''].filter(Boolean);
            for (const order of permutations(tokens)) {
                const name = [source.baseKeyword, ...order].join('_');
                spellings[name] = {baseKeyword:source.baseKeyword, value, canonical, identity:id, mpp};
                if (state.suffix && name !== canonical) {
                    schema[name] = {x:canonical, active:[id === 'TITLE' ? 'ID' : id, mpp ? 'MPP' : ''].filter(Boolean)};
                }
            }
        }
    }
    const {notes,...relation}=source;
    return {...relation, spellings};
}

function compileContactFamilies(source, schema, inputForm, definitions) {
    assert.equal(source.definitionsFrom, 'keywords/sources/contact-thermal/import-v1.json');
    assert.deepEqual(source.source, definitions.source);
    // Validate the historical thermal definitions once, then bind each mechanical pool separately.
    compileContactThermal(definitions, structuredClone(schema), inputForm);
    const rules = Object.assign({}, ...inputForm.payloads.map(p=>p.value.rules));
    const references = Object.assign({}, ...inputForm.payloads.map(p=>p.value.keywords));
    const mechanicalSchema = structuredClone(schema), spellings = {};
    const names = {'SSID':'SURFA','MSID':'SURFB','SSTYP':'SURFATYP','MSTYP':'SURFBTYP','SBOXID':'SABOXID','MBOXID':'SBBOXID','SPR':'SAPR','MPR':'SBPR','SFS':'SFSA','SFM':'SFSB','SST':'SAST','MST':'SBST','SFST':'SFSAT','SFMT':'SFSBT'};
    for (const [baseKeyword, profile] of Object.entries(source.profiles)) {
        assert.ok(source.applicability[baseKeyword]?.thermal, baseKeyword);
        assert.ok(references[baseKeyword], baseKeyword);
        for (const form of profile.forms) {
            assert.ok(references[baseKeyword].formRuleIds.includes(form.ruleId));
            const rule = rules[form.ruleId];
            assert.equal(rule.cardSetId, form.cardSetId);
            assert.equal(form.cardIndexes.length, mechanicalSchema[baseKeyword].c.length);
            form.cardIndexes.forEach((index, i)=> {
                const fields=rule.cards.find(c=>c.cardIndex===index)?.fields;
                assert.ok(fields, baseKeyword+':'+index);
                for(const field of mechanicalSchema[baseKeyword].c[i].filter(f=>f.n!=='UNUSED')) {
                    const native=fields.find(f=>f.position===field.p&&f.width===field.w);
                    assert.equal(native?.name.toUpperCase(), names[field.n]||field.n, baseKeyword+':'+field.n);
                    assert.equal(Math.abs(native.type)===1?'integer':native.type===0?'string':'real', field.t, baseKeyword+':'+field.n);
                }
            });
        }
        const entry=mechanicalSchema[baseKeyword];
        entry.c=entry.c.map(c=>c.map(f=>({...f,n:names[f.n]||f.n})));
        schema[baseKeyword]=structuredClone(entry);
        const compiled=compileContactThermal({...definitions,baseKeyword,mppAllowed:source.applicability[baseKeyword].mpp,catalogRuleId:profile.forms[0].ruleId,
            cardSetId:profile.forms[0].cardSetId}, schema, inputForm);
        for(const [name,binding] of Object.entries(compiled.spellings)) spellings[name]=binding;
        for(const state of Object.values(definitions.values)) {
            const canonical=baseKeyword+'_'+state.suffix;
            schema[canonical].c=[...structuredClone(entry.c.slice(0,profile.thermalInsertIndex)),
                ...definitions.cards.slice(0,state.cardCount).map(c=>c.map(({localized,...f})=>f)),
                ...structuredClone(entry.c.slice(profile.thermalInsertIndex))];
            if (profile.spellingTail) {
                assert.ok(baseKeyword.endsWith(profile.spellingTail));
                const stem=baseKeyword.slice(0,-profile.spellingTail.length), tail=profile.spellingTail.slice(1);
                const manualName=stem+'_'+state.suffix+profile.spellingTail;
                schema[manualName]=schema[canonical];
                schema[canonical]={x:manualName};
                for(const binding of Object.values(spellings)) if(binding.baseKeyword===baseKeyword&&binding.canonical===canonical)binding.canonical=manualName;
                for(const id of ['', 'ID', 'TITLE']) for(const mpp of source.applicability[baseKeyword].mpp?[false,true]:[false]) {
                    for(const order of permutations([state.suffix,id,mpp?'MPP':'',tail].filter(Boolean))) {
                        const name=[stem,...order].join('_');
                        spellings[name]={baseKeyword,value:state.suffix==='THERMAL'?'Thermal':'T_Friction',canonical:manualName,identity:id,mpp};
                        if(name!==manualName)schema[name]={x:manualName,active:[id==='TITLE'?'ID':id,mpp?'MPP':''].filter(Boolean)};
                    }
                }
            }
        }
    }
    for(const [keyword, variant] of Object.entries(source.dedicatedVariants)) {
        assert.ok(references[keyword].formRuleIds.includes(variant.ruleId));
        assert.equal(rules[variant.ruleId].cardSetId,variant.cardSetId);
        assert.deepEqual(rules[variant.ruleId].cards.slice(3,5).map(c=>c.fields.map(f=>[f.name.toUpperCase(),f.position,f.width])),
            definitions.cards.map(c=>c.map(f=>[f.n,f.p,f.w])));
        assert.equal(spellings[keyword]?.baseKeyword,variant.baseKeyword);
    }
    const {notes,...relation}=source;
    return {...definitions,...relation,spellings};
}
module.exports = {compileContactThermal};
