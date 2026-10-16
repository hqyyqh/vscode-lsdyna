import { keywordDataPath } from '../keywordDataPath';
import { nativeControlResolver, type NativeParameterContext } from './nativeParameterContext';
import { readRecordField, detectRecordFormat } from '../edit/keywordRecordSerializer';
import type { KeywordInputFormatMode } from '../parser/inputFormat';

export function contactThermalSource(): any {
    return require(keywordDataPath('engineering/contactThermal.json'));
}
export function contactThermalBinding(keyword: string): any {
    return contactThermalSource().spellings[String(keyword).replace(/^\*/, '').toUpperCase()];
}
export function contactThermalCatalogKeyword(keyword: string): string | undefined {
    return contactThermalBinding(keyword)?.baseKeyword;
}
export function equivalentContactThermalSpelling(left: string, right: string): boolean {
    const a = contactThermalBinding(left), b = contactThermalBinding(right);
    return !!a && !!b && a.baseKeyword === b.baseKeyword && a.value === b.value && a.identity === b.identity && a.mpp === b.mpp;
}
export function contactThermalRecordDefinition(keyword: string, record: any): any[] | undefined {
    if (!contactThermalBinding(keyword)) return undefined;
    const source = contactThermalSource();
    return [...source.cards, source.parameterCard].find(card => card.length === record.fields.length &&
        card.every((f, i) => f.n === String(record.fields[i].name).toUpperCase() && f.p === record.fields[i].position && f.w === record.fields[i].width));
}
/** Preserve native descriptor provenance; the separate manual import supplies composition. */
export function withContactThermalForm(form: any, keyword: string): any {
    const source = contactThermalSource(), binding = contactThermalBinding(keyword);
    const capability = source.applicability?.[binding?.baseKeyword] ||
        source.applicability?.[String(keyword).replace(/^\*/, '').toUpperCase()];
    if (!capability) return form;
    const profile = source.profiles?.[binding?.baseKeyword];
    if (profile && form.source.datasetSha256 !== source.source.nativeExecutableSha256) return null;
    if (profile?.forms.some(f=>form.rules[f.ruleId]?.cardSetId !== f.cardSetId)) return form;
    const rules = {...form.rules};
    for (const id of form.reference.selectorRuleIds || []) {
        const rule = rules[id];
        rules[id] = {...rule, selectors: (rule.selectors || []).flatMap(selector => {
            if (selector.controlId === source.controlId) return [{...selector,
                values:selector.values.map(value=>({...value,keywordSuffix:value.keywordSuffix ?? '_'+source.values[value.value].suffix}))}];
            return [selector];
        })};
    }
    for (const native of profile?.forms || []) rules[native.ruleId] = {...rules[native.ruleId], contactComposition:true,
        cards:native.cardIndexes.map(index=>rules[native.ruleId].cards.find(c=>c.cardIndex===index))};
    return {...form, keyword:String(keyword).replace(/^\*/, '').toUpperCase(),
        reference:{...form.reference, ...(binding ? {aliasOf:binding.baseKeyword} : {}),
            selectorRuleIds:(form.reference.selectorRuleIds || []).filter(id=>rules[id].selectors.length)}, rules};
}

/** Manual card conditions are evaluated on the same drafts/parameter context as FORMULA. */
export function selectContactMechanicalRecords(keyword: string, records: any[], control: (name: string, fallback: number)=>number | null): any[] | null {
    const profile=contactThermalSource().profiles?.[contactThermalBinding(keyword)?.baseKeyword];
    if (!profile?.mechanicalCondition) return records;
    if (profile.mechanicalCondition==='tiebreak') {
        const option=control('OPTION',1), param=[13,14].includes(option)?control('PARAM',0):0;
        if (option===null || !profile.allowedOptions.includes(option) || param===null) return null;
        return records.filter(r=> {
            const first=r.fields[0]?.name;
            if (['G1C_0','G2C_0'].includes(first)) return [13,14].includes(option);
            if (first==='RFILTF') return [13,14].includes(option)&&param<0;
            if (first==='DMP_1') return [9,11].includes(option);
            return true;
        });
    }
    const temp=control('TEMP',0), count=temp!==null&&temp<0?control('NTPRM',0):0;
    if (temp===null || temp<0&&!profile.userWeldAllowed || count===null || !Number.isInteger(count) || count<0 ||
        count>contactThermalSource().parameterCount.maximumCards*8) return null;
    return records.flatMap(r=>r.fields[0]?.name==='TPRM1' ? Array.from({length:temp<0?Math.ceil(count/8):0},(_,i)=>({...r,
        recordMigrationId:r.recordMigrationId+':parameters:'+(i+1),fields:r.fields.map(f=>({...f,fieldMigrationId:f.fieldMigrationId+':parameters:'+(i+1)}))})) : [r]);
}

export function contactThermalAllowed(keyword: string, control: (name: string, fallback: number)=>number | null): boolean {
    const profile=contactThermalSource().profiles?.[contactThermalBinding(keyword)?.baseKeyword];
    if (!profile) return false;
    if (!profile.thermalCondition) return true;
    const value=control(profile.thermalCondition.field,0);
    return profile.thermalCondition.allowedValues.includes(value);
}

/** Unknown controls must not turn parameter records into mechanical optional cards. */
export function contactThermalParameterCount(raw: string, parameters?: NativeParameterContext, line?: number): number | null {
    const source = contactThermalSource();
    const value = nativeControlResolver(parameters, [line]).resolve(raw || '0', 0).trim();
    if (!/^[+-]?\d+$/.test(value)) return null;
    const n = Number(value), count = n < 0 ? Math.ceil(-n / source.parameterCount.parametersPerCard) : 0;
    return Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647 && count <= source.parameterCount.maximumCards ? count : null;
}

export function expandContactThermalRecords(keyword: string, records: any[], sourceRecords: any[], format: KeywordInputFormatMode,
    createRecord: (card: any[], identity: string) => any, fieldDrafts: any = {}, currentRecords = records,
    parameters?: NativeParameterContext, recordLines?: number[], recordDrafts: Record<string, string> = {}): any[] | null {
    if (!contactThermalBinding(keyword)) return records;
    const control=(name: string, fallback: number): number | null => {
        const record=records.find(r=>r.fields.some(f=>String(f.name).toUpperCase()===name));
        if (!record) return null;
        const index=record.fields.findIndex(f=>String(f.name).toUpperCase()===name);
        const sourceIndex=currentRecords.findIndex(r=>r.recordMigrationId===record.recordMigrationId);
        const text=recordDrafts[record.recordMigrationId] ?? sourceRecords[sourceIndex]?.text ?? '';
        const raw=fieldDrafts[record.fields[index].fieldMigrationId] ?? (sourceIndex<0?'':readRecordField(text,record.fields,index,detectRecordFormat(text,format,record.fields)));
        const resolved=nativeControlResolver(parameters,[recordLines?.[sourceIndex]],true).resolve(raw||String(fallback),0).trim();
        const value=Number(resolved.replace(/[dD]/g,'e'));
        return resolved&&Number.isFinite(value)?value:null;
    };
    if (records.some(r=>r.fields[0]?.name==='K') && !contactThermalAllowed(keyword,control)) return null;
    const initialRecords=records;
    records=selectContactMechanicalRecords(keyword,records,control);
    if (!records) return null;
    if (currentRecords===initialRecords) currentRecords=records;
    const controller = records.findIndex(r => r.fields.some(f => String(f.name).toUpperCase() === 'FORMULA'));
    if (controller < 0) return records;
    const record = records[controller], field = record.fields.findIndex(f => String(f.name).toUpperCase() === 'FORMULA');
    const sourceIndex = currentRecords.findIndex(r => r.recordMigrationId === record.recordMigrationId);
    const text = recordDrafts[record.recordMigrationId] ?? sourceRecords[sourceIndex]?.text ?? '';
    const raw = fieldDrafts[record.fields[field].fieldMigrationId] ?? (sourceIndex < 0 ? '' : readRecordField(text, record.fields, field,
        detectRecordFormat(text, format, record.fields)));
    const count = contactThermalParameterCount(raw, parameters, recordLines?.[sourceIndex]);
    if (count === null) return null;
    const extra = Array.from({length:count}, (_, i) => createRecord(contactThermalSource().parameterCard,
        `${record.recordMigrationId}:parameters:${i+1}`));
    return [...records.slice(0, controller+1), ...extra, ...records.slice(controller+1)];
}
