import type { FieldContext } from '../parser/fieldContext';
import { keywordInputFormat } from '../parser/inputFormat';
import { detectRecordFormat, formattedFields, readRecordField } from '../edit/keywordRecordSerializer';
import { contactThermalBinding, contactThermalParameterCount, selectContactMechanicalRecords, contactThermalAllowed } from './contactThermal';
import { nativeControlResolver } from './nativeParameterContext';
import { getCatalogInputFormCatalogV4 } from "./catalogInputFormCatalogV4";
import type { CardResolution, KeywordLookup } from '../keywordSchema';

/** The imported manual composition owns both manager and Hover parameter rows. */
export function renderContactThermalCards(lookup: KeywordLookup | null, observedDataLines: string[],
    options: Partial<Pick<FieldContext, 'keywordText' | 'globalInputFormat' | 'parameterContext' | 'recordLines'>> = {}) {
    const binding = lookup && contactThermalBinding(lookup.inputName);
    if (!binding) return null;
    const fail = (reason: string) => ({cards:[], prefixCardCount:0, reason, requiresManualLayout:true});
    const form = getCatalogInputFormCatalogV4().formForKeyword(lookup.inputName);
    if (!form || form.source.isUnauditedDiagnostic || !form.source.conservationSatisfied) return fail('contact-thermal-source-unverified');
    const {getVerifiedPrefixLayout} = require('../keywordSchema');
    const prefix = getVerifiedPrefixLayout(lookup, observedDataLines);
    if (!['none','verified'].includes(prefix.status)) return fail('contact-thermal-prefix-unverified');
    let cards = [...prefix.cards, ...lookup.entry.c];
    const control=(name: string, fallback: number): number | null=> {
        const index=cards.findIndex(c=>c.some(f=>f.n===name));
        if(index<0) return null;
        const fields=cards[index].map(f=>({name:f.n,type:f.t,position:f.p,width:f.w}));
        const text=observedDataLines[index]||'';
        const format=detectRecordFormat(text,keywordInputFormat(options.keywordText||lookup.inputName,options.globalInputFormat),fields);
        const raw=readRecordField(text,fields,cards[index].findIndex(f=>f.n===name),format);
        const resolved=nativeControlResolver(options.parameterContext,[options.recordLines?.[index]],true).resolve(raw||String(fallback),0);
        return resolved.trim()&&Number.isFinite(Number(resolved.replace(/[dD]/g,'e')))?Number(resolved.replace(/[dD]/g,'e')):null;
    };
    if(binding.value && !contactThermalAllowed(lookup.inputName,control)) return fail('contact-thermal-condition-unresolved');
    const mechanical=selectContactMechanicalRecords(lookup.inputName,cards.map((card,i)=>({fields:card.map(f=>({name:f.n})),card,recordMigrationId:String(i)})),control);
    if(!mechanical) return {cards:cards.slice(0,prefix.cards.length+4),prefixCardCount:prefix.cards.length,reason:'contact-mechanical-condition-unresolved',requiresManualLayout:true};
    let requiresManualLayout = mechanical.some(r=>['G1C_0','G2C_0','RFILTF','DMP_1','TPRM1'].includes(r.fields[0]?.name));
    cards=mechanical.map(r=>r.card);
    if (binding.value === 'T_Friction') {
        const controller = cards.findIndex(c=>c.some(f=>f.n==='FORMULA'));
        const fields = cards[controller].map(f=>({name:f.n,type:f.t,position:f.p,width:f.w}));
        const format = detectRecordFormat(observedDataLines[controller] || '', keywordInputFormat(options.keywordText || lookup.inputName, options.globalInputFormat), fields);
        const raw = readRecordField(observedDataLines[controller] || '', fields, 2, format);
        const count = contactThermalParameterCount(raw, options.parameterContext, options.recordLines?.[controller]);
        if (count === null) return {cards:cards.slice(0,controller+1), prefixCardCount:prefix.cards.length, reason:'contact-thermal-parameter-count-unresolved',requiresManualLayout:true};
        requiresManualLayout ||= count > 0;
        const parameters = lookup.entry.o.find(o=>o.n==='UC').c[0];
        cards.splice(controller+1,0,...Array.from({length:count},()=>parameters));
    }
    cards.push(...(lookup.entry.o || []).filter(o=>/^[A-G]$/.test(o.n)).flatMap(o=>o.c));
    return {cards, prefixCardCount:prefix.cards.length, reason:undefined, requiresManualLayout};
}

export function resolveContactThermalFieldCard(context: FieldContext, lookup: KeywordLookup | null): CardResolution | null {
    const rendered = renderContactThermalCards(lookup, context.observedDataLines, context);
    if (!rendered) return null;
    const fail = (reason: string): CardResolution => ({status:'unresolved',reason});
    const ordinal = context.dataLineOrdinal;
    if (!ordinal) return fail('record-context-unavailable');
    const {cards, prefixCardCount} = rendered;
    const card = cards[ordinal-1];
    if (!card) return fail(rendered.reason || 'record-layout-unavailable');
    const fields = card.map(f=>({name:f.n,type:f.t,position:f.p,width:f.w}));
    const format = detectRecordFormat(context.currentText, keywordInputFormat(context.keywordText,context.globalInputFormat), fields);
    const physical = formattedFields(fields, context.currentText, format);
    if (physical.length !== card.length) return fail('contact-thermal-format-unverified');
    return {status:'resolved', reason:rendered.requiresManualLayout ? 'contact-thermal-manual-extension' : 'contact-thermal-composition', cardInfo:{
        card:card.map((field,i)=>({...field,p:physical[i].position,w:physical[i].width})),cardIndex:ordinal,
        keywordName:lookup.inputName,activeOptions:lookup.activeOptions, observedDataLineOrdinal:ordinal,
        leadingOptionCardCount:prefixCardCount,isLeadingOptionCard:ordinal<=prefixCardCount,
        resolutionSource:'physical-order',inputFormat:format,
    }};
}
