import type { KeywordCard, KeywordSchema } from '../keywordSchema';
import { getCatalogInputFormCatalogV4 } from "./catalogInputFormCatalogV4";
import { NATIVE_FILE_SOURCE } from "./catalogNativeFileLayout";

const normalize = (value: unknown) => String(value || '').trim().toUpperCase();
const isPlaceholder = (value: unknown) => {
    const s = normalize(value);
    return !s || /^[-_]+$/.test(s) || s === 'UNUSED' || s === 'BLANK' || s === 'NOT USED';
};
let owner: ReturnType<typeof getCatalogInputFormCatalogV4>;
let cache = new WeakMap<KeywordSchema, Map<string, KeywordCard | null>>();

/** Definition authority only. This does not establish a native file/edit binding. */
export function nativeFieldDefinitions(keyword: string, schema: KeywordSchema, card: KeywordCard | null, ordinal?: number): KeywordCard | null {
    const catalog = getCatalogInputFormCatalogV4();
    if (owner !== catalog) { owner = catalog; cache = new WeakMap(); }
    let entries = cache.get(schema);
    if (!entries) cache.set(schema, entries = new Map());
    const key = JSON.stringify([keyword, card, ordinal]);
    if (entries.has(key)) return entries.get(key) ?? null;
    const form = catalog.formForKeyword(keyword);
    if (form?.source?.datasetSha256 !== NATIVE_FILE_SOURCE || form.source.isUnauditedDiagnostic ||
        form.reference.formRuleIds?.length !== 1) return card;
    const rule = form.rules[form.reference.formRuleIds[0]];
    if (!rule?.cards?.length) return card;

    // Case 1: card is null (record sequence truncation: source-bound repeat or fixed tail)
    if (!card) {
        if (ordinal && ordinal >= 1 && ordinal <= rule.cards.length) {
            const nativeCard = rule.cards[ordinal - 1];
            if (nativeCard && nativeCard.cardIndex === ordinal) {
                const result: KeywordCard = nativeCard.fields.map((field: any) => {
                    const width = field.serializationWidth || field.width;
                    const type = [0, -2].includes(field.type) ? 'string' : field.type === 1 ? 'integer' : 'real';
                    return {
                        n: field.name,
                        p: field.position,
                        w: width,
                        t: type,
                        d: field.defaultValue ?? undefined,
                        e: Array.isArray(field.choices) ? [...field.choices] : undefined,
                        ...(field.help ? { h: field.help } : {}),
                        definitionSource: {
                            datasetSha256: NATIVE_FILE_SOURCE,
                            fieldRecordId: field.fieldRecordId,
                            alignmentMayOmit: field.defaultValue !== undefined && field.defaultValue !== null,
                        },
                    };
                });
                entries.set(key, result);
                if (entries.size > 256) entries.delete(entries.keys().next().value);
                return result;
            }
        }
        return null;
    }

    // Case 2: card is present, match candidate from rule.cards
    let candidate: any = null;
    if (ordinal && ordinal >= 1 && ordinal <= rule.cards.length) {
        const byOrd = rule.cards[ordinal - 1];
        if (byOrd && byOrd.cardIndex === ordinal && byOrd.fields.length === card.length) {
            const geomMatch = byOrd.fields.every((f: any, i: number) =>
                f.position === card[i].p && ((f.serializationWidth || f.width) === card[i].w || f.width === card[i].w));
            const nameMatch = byOrd.fields.every((f: any, i: number) =>
                normalize(f.name) === normalize(card[i].n) || isPlaceholder(f.name));
            const hasNonPlaceholder = byOrd.fields.some((f: any, i: number) =>
                !isPlaceholder(f.name) && normalize(f.name) === normalize(card[i].n)) ||
                byOrd.fields.every((f: any) => isPlaceholder(f.name));
            if (geomMatch && nameMatch && hasNonPlaceholder) {
                candidate = byOrd;
            }
        }
    }
    if (!candidate) {
        const matches = rule.cards.filter((native: any) => native.fields.length === card.length &&
            native.fields.every((field: any, index: number) =>
                (normalize(field.name) === normalize(card[index].n) || isPlaceholder(field.name)) &&
                field.position === card[index].p &&
                ((field.serializationWidth || field.width) === card[index].w || field.width === card[index].w)
            ) &&
            (native.fields.some((field: any, index: number) => !isPlaceholder(field.name) && normalize(field.name) === normalize(card[index].n)) ||
             native.fields.every((field: any) => isPlaceholder(field.name)))
        );
        if (matches.length === 1) candidate = matches[0];
    }
    if (!candidate) return card;

    const result = card.map((field, index) => {
        const native = candidate.fields[index];
        if (![-2, 0, 1, 2].includes(native.type)) return field;
        const width = native.serializationWidth || native.width || field.w;
        const nativeIsPlaceholder = isPlaceholder(native.name);
        const name = nativeIsPlaceholder ? native.name : (normalize(native.name) === normalize(field.n) ? field.n : native.name);
        const help = nativeIsPlaceholder ? (native.help || 'Unused.') : (native.help ? native.help : field.h);
        return {
            ...field,
            n: name,
            p: field.p,
            w: width,
            t: [0, -2].includes(native.type) ? 'string' : native.type === 1 ? 'integer' : 'real',
            d: native.defaultValue ?? undefined,
            e: Array.isArray(native.choices) ? [...native.choices] : undefined,
            ...(help ? { h: help, hi: nativeIsPlaceholder ? undefined : field.hi } : {}),
            definitionSource: {
                datasetSha256: NATIVE_FILE_SOURCE,
                fieldRecordId: native.fieldRecordId,
                alignmentMayOmit: field.definitionSource?.alignmentMayOmit ?? (field.d !== undefined && field.d !== null),
            },
        };
    });
    entries.set(key, result);
    if (entries.size > 256) entries.delete(entries.keys().next().value);
    return result;
}
