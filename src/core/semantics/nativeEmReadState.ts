import { getCatalogInputFormCatalogV4 } from "./catalogInputFormCatalogV4";
import { keywordInputFormat, keywordInputFormatOverride, stripKeywordInputFormatMarker, type KeywordInputFormatMode } from '../parser/inputFormat';

const source = "1e631456cbcdea5193fc695a2d1bc2a4c8075e88a7a0dc00451d76b24e9504bb";
const bindings = {
    EM_CONTROL: ["record:0dc9b948cccc96167cba03df:629c19808a3b492beed63d57", "record:0dc9b948cccc96167cba03df:1e631ae2acf8049aecfd1c29", 0, 1, 'control'],
    EM_CONTROL_CONTACT: ["record:0dc9b948cccc96167cba03df:40f5d4b263cbbb520ba38131", "record:0dc9b948cccc96167cba03df:b8224fcf2a857f0f04f4c4f5", 0, 1, 'other-control'],
    EM_ISOPOTENTIAL_CONNECT: ["record:0dc9b948cccc96167cba03df:22f8e4fa471a70245cb8e644", "record:0dc9b948cccc96167cba03df:488d8482ffa18599d1e93af6", 1, 3, 'connect'],
} as const;
export const nativeEmEventKeywords = new Set(Object.keys(bindings));

/** Exact original headers. Raw controls remain unresolved until root traversal. */
export function nativeEmReadEvent(block: any, text: string, globalFormat: KeywordInputFormatMode) {
    const keyword = stripKeywordInputFormatMarker(String(block.keyword).replace(/^\*/, '').toUpperCase());
    const binding = bindings[keyword];
    if (!binding) return null;
    const form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
    const ids = form?.reference.formRuleIds;
    const rules = (Array.isArray(ids) ? ids : []).map(id => form.rules[id]).filter(rule =>
        rule.cardSetId === binding[0] && rule.cards?.length === binding[3] && rule.keywords?.includes(keyword));
    const field = rules.length === 1 && rules[0].cards[0]?.fields[binding[2]];
    const base = { kind: binding[4], keyword, startLine: block.startLine, lineIndex: block.startLine + 1 };
    if (globalFormat === 'long' && keywordInputFormatOverride(block.rawKeyword || block.keyword) === 'i10')
        return { ...base, kind: 'invalidate', reason: 'native-mixed-global-long-local-i10-flags-unimplemented' };
    if (form?.source.datasetSha256 !== source || !field || field.fieldRecordId !== binding[1] ||
        field.type !== 1 || field.position !== binding[2] * 10 || field.width !== 10)
        return { ...base, kind: 'invalidate', reason: 'native-em-header-source-unavailable' };
    const lines = String(text || '').split(/\r?\n/);
    const row = lines.findIndex(line => line.trim() && !/^[$*]/.test(line.trim()));
    if (row < 0) return { ...base, kind: 'invalidate', reason: 'native-em-header-unavailable' };
    // Dispatcher 25/26 filters I10; original LONG uses twenty-column fields.
    const width = keywordInputFormat(block.rawKeyword || block.keyword, globalFormat) === 'long' ? 20 : 10;
    const rawValue = (lines[row].includes(',') ? lines[row].split(',')[binding[2]] || '' :
        lines[row].slice(binding[2] * width, (binding[2] + 1) * width)).trim();
    return { ...base, lineIndex: block.startLine + row, rawValue,
        defaultValue: field.defaultValue, choices: field.choices };
}


export function createNativeEmReadState() {
    let committedCount = 0, pendingCount = 0;
    let committedFirst: number | null | undefined, pendingFirst: number | null | undefined;
    let failure: string | undefined;
    const integer = (event: any, resolve: (raw: string, line: number) => string) => {
        const raw = resolve(String(event.rawValue || ''), event.lineIndex).trim();
        const value = raw ? /^[+-]?\d+$/.test(raw) ? Number(raw) : null : Number(event.defaultValue);
        if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) return null;
        const choices = (event.choices || []).map(Number);
        return choices.length && !choices.includes(value) ? choices[0] : value;
    };
    return {
        invalidate(reason: string) { failure ||= reason; },
        apply(event: any, resolve = (raw: string, _line: number) => raw) {
            if (event.kind === 'invalidate') { failure ||= event.reason; return null; }
            if (event.kind === 'control' || event.kind === 'other-control') {
                pendingCount++;
                if (event.kind === 'control' && pendingFirst === undefined && committedFirst === undefined)
                    pendingFirst = integer(event, resolve);
                return null;
            }
            if (event.kind !== 'connect') return null;
            const type = integer(event, resolve);
            if (type === null) return { state: 'unknown', reason: 'native-em-controller-unresolved' };
            if (type === 6) return { state: 'ready', cardIndexes: [1, 2] };
            if (type !== 3 && type !== 4) return { state: 'ready', cardIndexes: [1] };
            const priorCount = committedCount, priorFirst = committedFirst;
            committedCount += pendingCount; pendingCount = 0;
            if (committedFirst === undefined) committedFirst = pendingFirst;
            pendingFirst = undefined;
            if (failure || priorCount > 0 && priorFirst === null) return {
                state: 'unknown', reason: failure || 'native-em-control-value-unresolved',
            };
            return { state: 'ready', cardIndexes: priorCount > 0 && [4,7,9].includes(priorFirst)
                ? [1,3] : [1] };
        },
    };
}
