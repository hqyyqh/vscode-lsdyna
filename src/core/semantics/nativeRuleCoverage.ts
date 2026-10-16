import { nativeConditionalBinding } from './nativeConditionalLayout';
import { nativeSpellingBinding } from "./catalogNativeFileLayout";

export function nativeRecordGrammar(keyword: string): any {
    const name = keyword.replace(/^\*/, '').toUpperCase();
    const spelling = nativeSpellingBinding(name);
    return spelling?.layout || nativeConditionalBinding(name) ||
        (spelling?.baseKeyword && nativeConditionalBinding(spelling.baseKeyword));
}

/** A descriptor or fixed-record reader does not prove a controller's branch semantics. */
export function nativeCoversCondition(keyword: string, predicate: any): boolean {
    const binding = nativeRecordGrammar(keyword);
    const controls = new Set(Object.keys(binding?.controls || {}).map(field => field.toUpperCase()));
    const fields: string[] = [];
    const visit = (value: any) => {
        if (!value || typeof value !== 'object') return;
        if (typeof value.field === 'string') fields.push(value.field.toUpperCase());
        for (const child of Object.values(value)) if (typeof child === 'object') visit(child);
    };
    visit(predicate);
    return fields.length > 0 && fields.every(field => controls.has(field));
}

/** Only an explicitly corresponding selector covers a manual option slot. */
export function nativeCoversOptionSlot(form: any, slot: string): boolean {
    const normalized = String(slot || '').replace(/^_/, '').toUpperCase();
    return !!normalized && (form?.reference.selectorRuleIds || []).some(id =>
        (form.rules[id]?.selectors || []).some(selector =>
            [selector.controlId, selector.keywordSuffix, ...(selector.values || []).map(value => value.keywordSuffix)]
                .some(value => typeof value === 'string' && value.replace(/^_/, '').toUpperCase() === normalized)));
}
