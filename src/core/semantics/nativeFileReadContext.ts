import { keywordInputFormat, stripKeywordInputFormatMarker, type KeywordInputFormatMode } from '../parser/inputFormat';
import { nativeControlResolver, type NativeParameterContext } from './nativeParameterContext';
import { nativeConditionalBinding, selectConditionalLayout } from './nativeConditionalLayout';
import { nativeCountedOccurrenceBinding, selectCountedOccurrenceLayout } from './nativeCountedOccurrenceLayout';
import { nativeReadInputFormat, nativeReadInputFailure } from './nativeInputFormat';
import { nativeSpellingBinding, nativeSpellingFieldHelp, nativeFileLayoutKind, nativeFileLayoutCards, readNativeFileField, nativeFileControlCompatible,
    selectNativeFileLayout, selectVerifiedSourceRecords } from "./catalogNativeFileLayout";

/** Shared interpretation of actual records. Draft callbacks affect only target selection. */
export function nativeFileReadContext(rule: any, keywordText: string, rows: string[],
    globalFormat: KeywordInputFormatMode, recordLines?: number[], parameters?: NativeParameterContext): ReturnType<typeof baseNativeFileReadContext> {
    const keyword = stripKeywordInputFormatMarker(keywordText.trim().split(/[\s,]/)[0]).replace(/^\*/, '').toUpperCase();
    const spelling = nativeSpellingBinding(keyword);
    if (spelling) {
        if (spelling.layout) {
            const body = baseNativeFileReadContext(rule, '*' + spelling.baseKeyword, rows,
                keywordInputFormat(keywordText, globalFormat), recordLines, parameters);
            const cards = new Map<number, any>([...body.cards].map(([index, card]) => [index,
                spelling.strictNativeHelp ? { ...card, fields: card.fields.map(field => ({ ...field,
                    help: nativeSpellingFieldHelp(field.fieldRecordId) ?? '' })) } : card]));
            for (const card of spelling.extraCards || []) cards.set(card.cardIndex, card);
            if (spelling.prefixCard) cards.set(0, spelling.prefixCard);
            const title = !!spelling.prefixCard;
            return { ...body, cards, fields: [...cards.values()].filter(card => card.cardIndex !== 0), writeCompatible: () => false,
                select(partial = false, draft?, _targetTitle?) {
                    return selectConditionalLayout(spelling.layout, rows, title,
                        (row, card, field) => body.read(rows[row] || '', card, field), body.controls.resolve,
                        draft || ((_record, _field, raw) => raw), title, partial,
                        (card, field, value) => {
                            const choices = (cards.get(card)?.fields[field]?.choices || []).map(Number);
                            return choices.length && choices.every(Number.isFinite) && !choices.includes(value) ? choices[0] : value;
                        },
                        (card, field) => spelling.layoutBlankDefaults?.[`${card}/${field}`]);
                } };
        }
        if (spelling.prefixScope === 'instance') {
            const body = baseNativeFileReadContext(rule, '*' + spelling.baseKeyword, rows,
                keywordInputFormat(keywordText, globalFormat), recordLines, parameters);
            const cards = new Map<number, any>(body.cards);
            cards.set(0, spelling.prefixCard);
            return { ...body, cards, writeCompatible: () => false,
                select(partial = false, draft?, _targetTitle?, draftRecord?) {
                    return selectNativeFileLayout('generic-fixed', rows, true,
                        (row, card, field) => body.read(rows[row] || '', card, field), draft,
                        true, partial, body.fields.length, body.controls.resolve, draftRecord);
                } };
        }
        const prefix = spelling.prefixCard ? 1 : 0;
        const body = nativeFileReadContext(rule, '*' + spelling.baseKeyword, rows.slice(prefix),
            keywordInputFormat(keywordText, globalFormat), recordLines?.slice(prefix), parameters);
        const cards = new Map<number, any>(body.cards);
        if (prefix) cards.set(0, spelling.prefixCard);
        const shift = record => ({ ...record, instanceStart: record.instanceStart ? record.instanceStart + prefix : 0,
            key: record.key.replace(/^instance:\d+/, `instance:${record.instanceStart ? record.instanceStart + prefix : 0}`) });
        return { ...body, cards,
            writeCompatible: () => false,
            select(partial = false, draft?, _targetTitle?, draftRecord?) {
                const selected = body.select(partial, draft && ((record, field, raw) => draft(shift(record), field, raw)),
                    false, draftRecord && ((record, raw) => draftRecord(shift(record), raw)));
                const head = prefix && rows.length ? [{ cardIndex: 0, instanceStart: 0, key: 'instance:0:prefix:0' }] : [];
                if (!selected) return partial ? { current: head, target: head.slice(), counts: [] } : null;
                return { ...selected, current: [...head, ...(selected.current || []).map(shift)],
                    ...('minimumRecords' in selected && typeof selected.minimumRecords === 'number'
                        ? { minimumRecords: selected.minimumRecords + prefix } : {}),
                    target: [...head, ...('target' in selected ? selected.target : selected.current || []).map(shift)],
                    counts: 'counts' in selected ? selected.counts?.map((count, index) => count + (index ? 0 : prefix)) : undefined };
            } };
    }
    return baseNativeFileReadContext(rule, keywordText, rows, globalFormat, recordLines, parameters);
}

function baseNativeFileReadContext(rule: any, keywordText: string, rows: string[],
    globalFormat: KeywordInputFormatMode, recordLines?: number[], parameters?: NativeParameterContext) {
    const keyword = stripKeywordInputFormatMarker(keywordText.trim().split(/[\s,]/)[0]).replace(/^\*/, '').toUpperCase();
    const kind = nativeFileLayoutKind(rule, keyword);
    const fields = nativeFileLayoutCards(rule, keyword);
    const cards = new Map<number, any>(fields.map(card => [Number(card.cardIndex), card]));
    const input = keywordInputFormat(keywordText, globalFormat);
    const readInput = nativeReadInputFormat(rule, keywordText, globalFormat);
    const binding = nativeConditionalBinding(keyword);
    // Guard requested formats before native width normalization or partial selection.
    const format = binding?.supportedFormats && rows.some(row => !row.trimStart().startsWith('$') && row.includes(',')) ? 'comma' : input;
    const formatFailure = binding?.supportedFormats && !binding.supportedFormats.includes(format)
        ? `native-${format}-format-not-supported-by-binding` : undefined;
    const readInputFailure = formatFailure || nativeReadInputFailure(rule, keywordText, globalFormat);
    const controls = nativeControlResolver(parameters, recordLines, kind === 'conditional-sequence');
    const title = /_TITLE$/.test(keyword);
    const read = (text: string, card: number, field: number) =>
        formatFailure ? '' : readNativeFileField(kind, card, cards.get(card)?.fields || [], text, field, readInput);
    return { kind, cards, fields, input, readInput, readInputFailure, controls, read,
        writeCompatible(records: { cardIndex: number }[]) {
            if (readInputFailure) return false;
            return records.every((record, index) => nativeFileControlCompatible(kind, record.cardIndex,
                cards.get(record.cardIndex)?.fields || [], rows[index] || '', input));
        },
        select(partial = false, draft?: Parameters<typeof selectNativeFileLayout>[4],
            targetTitle = title, draftRecord?: Parameters<typeof selectNativeFileLayout>[9]) {
            if (readInputFailure) return null;
            if (kind === 'counted-occurrences') return selectCountedOccurrenceLayout(
                nativeCountedOccurrenceBinding(keyword), rows,
                (row, card, field) => read(rows[row] || '', card, field), controls.resolve);
            if (kind === 'conditional-sequence') return selectConditionalLayout(nativeConditionalBinding(keyword), rows, title,
                (row, card, field) => read(rows[row], card, field), controls.resolve,
                draft || ((_record, _field, raw) => raw), targetTitle, partial,
                (card, index, value) => {
                    const field = cards.get(card)?.fields[index];
                    const choices = (field?.choices || []).map(choice => field.type === 2 ? Math.fround(Number(choice)) : Number(choice));
                    // The native file decoder stores the first enum value for an
                    // out-of-list numeric token. Unknown parameters never reach here.
                    return choices.length && choices.every(Number.isFinite) && !choices.includes(value) ? choices[0] : value;
                }, (card, index) => cards.get(card)?.fields[index]?.defaultValue ?? undefined);
            return kind ? selectNativeFileLayout(kind, rows, title,
                (row, card, field) => read(rows[row] || '', card, field), draft,
                targetTitle, partial, fields.length, controls.resolve, draftRecord)
                : { current: selectVerifiedSourceRecords(rule, keyword, rows, readInput) };
        },
    };
}
