import { keywordInputFormat, keywordInputFormatOverride, stripKeywordInputFormatMarker, type KeywordInputFormatMode } from '../parser/inputFormat';
import { nativeControlResolver, type NativeParameterContext } from './nativeParameterContext';
import { nativeConditionalBinding, selectConditionalLayout } from './nativeConditionalLayout';
import { nativeCountedOccurrenceBinding, selectCountedOccurrenceLayout } from './nativeCountedOccurrenceLayout';
import { nativeReadInputFormat, nativeReadInputFailure } from './nativeInputFormat';
import { nativeFordFeatureEnabled } from './nativeFeatureContext';
import { nativeContactOptionalBinding, nativeContactOptionalRecordReader } from './nativeContactOptionalReferences';
import { keywordDataPath } from '../keywordDataPath';
import { getCatalogInputFormCatalogV4 } from "./catalogInputFormCatalogV4";
import { nativeFileCatalogKeyword, nativeTitleBodyKeyword, NATIVE_FILE_SOURCE, isVerifiedNativeSpelling } from "./catalogNativeFileLayout";
import { safeRecordGeometry, formattedReadFields, readRecordField, hasSharedByteContract } from '../edit/keywordRecordSerializer';
const writeLayouts = require(keywordDataPath('engineering/fileWriteLayouts.json')).layouts;
import { nativeSpellingBinding, nativeFilePrefixBinding, nativeSpellingFieldHelp, nativeFileLayoutKind, nativeFileLayoutCards, readNativeFileField, nativeFileControlCompatible,
    selectNativeFileLayout, selectVerifiedSourceRecords, nativeReferenceTailBinding,
    nativeSoilPileRecordReader, nativeAleTrimRecordReader, nativeAleMotionRecordReader, nativeControlledReferenceRecordReader, selectNativeUserMaterialRecords } from "./catalogNativeFileLayout";

/** Resolve a source-bound file layout without loading schema help or manual composition. */
export function nativeKeywordReadContext(keywordText: string, rows: string[], globalFormat: KeywordInputFormatMode,
    recordLines?: number[], parameters?: NativeParameterContext) {
    const keyword = stripKeywordInputFormatMarker(keywordText.trim().split(/[\s,]/)[0]).replace(/^\*/, '').toUpperCase();
    const form = getCatalogInputFormCatalogV4().formForKeyword(nativeFileCatalogKeyword(keyword), false);
    if (form?.source?.datasetSha256 !== NATIVE_FILE_SOURCE || form.source.isUnauditedDiagnostic) return null;
    const rules = (Array.isArray(form.reference.formRuleIds) ? form.reference.formRuleIds : [])
        .map(id => ({ ...form.rules[id], catalogSource: form.source }))
        .filter(rule => nativeFileLayoutKind(rule, keyword) !== 'unsupported-source');
    return rules.length === 1 ? nativeFileReadContext(rules[0], keywordText, rows, globalFormat, recordLines, parameters) : null;
}

/** Check a manual append against native records without creating another instance. */
export function nativeAppendLayoutMatches(keywordText: string, rows: string[], appended: string[],
    format: KeywordInputFormatMode, recordLines?: number[], parameters?: NativeParameterContext): boolean {
    try {
        const reading = nativeKeywordReadContext(keywordText, [...rows, ...appended], format, recordLines, parameters);
        const selected = reading?.select(false);
        return !!selected?.current && !reading.controls.reasons.size &&
            !('uncertainty' in selected && selected.uncertainty) &&
            !('reasons' in selected && Array.isArray(selected.reasons) && selected.reasons.length) &&
            selected.current.length === rows.length + appended.length &&
            selected.current.slice(rows.length).every(record => record &&
                reading.cards.has(record.cardIndex) && record.instanceStart < rows.length);
    } catch { return false; }
}

/** Shared interpretation of actual records. Draft callbacks affect only target selection. */
export function nativeFileReadContext(rule: any, keywordText: string, rows: string[],
    globalFormat: KeywordInputFormatMode, recordLines?: number[], parameters?: NativeParameterContext,
    nativeReadLayout?: { state: string; cardIndexes?: number[]; reason?: string }): ReturnType<typeof baseNativeFileReadContext> {
    let reading = nativeFileReading(rule, keywordText, rows, globalFormat, recordLines, parameters, nativeReadLayout);
    const keyword = stripKeywordInputFormatMarker(keywordText.trim().split(/[\s,]/)[0]).replace(/^\*/, '').toUpperCase();
    const title = keyword.endsWith('_TITLE');
    const select = reading.select;
    reading = { ...reading, select(partial = false, draft?, targetTitle = title, draftRecord?) {
        const selected = select(partial, draft, targetTitle, draftRecord);
        if (!selected || !('target' in selected) || targetTitle === title ||
            selected.target.some(record => record.cardIndex === 0) === targetTitle) return selected;
        const prefix = nativeFilePrefixBinding(title ? keyword : keyword + '_TITLE');
        if (prefix?.prefixFormat !== 'raw' || prefix.prefixCard?.fields?.length !== 1 ||
            prefix.prefixCard.fields[0].name !== 'TITLE') return selected;
        const body = selected.target.filter(record => record.cardIndex !== 0);
        const starts = new Set<number>();
        const target = targetTitle ? body.flatMap(record => {
            const start = prefix.prefixScope === 'instance' ? record.instanceStart : 0;
            if (starts.has(start)) return [record];
            starts.add(start);
            return [{ cardIndex: 0, instanceStart: start, key: `instance:${start}:prefix:0` }, record];
        }) : body;
        return { ...selected, target };
    } };
    if (!isVerifiedNativeSpelling(keyword)) return nativeSpellingBinding(keyword)
        ? { ...reading, writeCompatible: () => false } : reading;
    return { ...reading, writeCompatible(records) {
        const selected = reading.select(false);
        if (rule.catalogSource?.datasetSha256 !== NATIVE_FILE_SOURCE ||
            nativeFileLayoutKind(rule, keyword) === 'unsupported-source' || reading.readInputFailure ||
            !selected?.current?.length || selected.current.length !== rows.length || records.length !== rows.length ||
            reading.controls.reasons.size || ('uncertainty' in selected && selected.uncertainty) ||
            ('reasons' in selected && Array.isArray(selected.reasons) && selected.reasons.length) || records.some((record, index) =>
                record.cardIndex !== selected.current[index].cardIndex)) return false;
        const spelling = nativeFilePrefixBinding(keyword);
        return records.every((record, index) => {
            const card = reading.cards.get(record.cardIndex), fields = card?.fields || [];
            if (card?.nativeZeroFieldRecord) return !rows[index].trim();
            const prefix = record.cardIndex === 0 && spelling?.prefixCard;
            const format = prefix && spelling.prefixFormat !== 'input' ? spelling.prefixFormat :
                rows[index].includes(',') ? 'comma' : reading.readInput;
            if (format === 'raw') return safeRecordGeometry(fields) && fields.length === 1 && fields[0].position === 0 && Number(fields[0].type) === 0;
            const geometry = format === 'comma' ? fields : formattedReadFields(fields, rows[index], format);
            const shared = (format === 'standard' || format === 'i10' && fields.every(field =>
                field.nativeReadGeometry?.i10.position === field.position && field.nativeReadGeometry.i10.width === field.width)) &&
                hasSharedByteContract(card, rule.catalogSource.datasetSha256);
            return safeRecordGeometry(geometry, format === 'comma' || shared) && fields.every((_field, fieldIndex) =>
                prefix || reading.read(rows[index], record.cardIndex, fieldIndex) === readRecordField(rows[index], fields, fieldIndex, format));
        });
    } };
}

function nativeFileReading(rule: any, keywordText: string, rows: string[],
    globalFormat: KeywordInputFormatMode, recordLines?: number[], parameters?: NativeParameterContext,
    nativeReadLayout?: { state: string; cardIndexes?: number[]; reason?: string }): ReturnType<typeof baseNativeFileReadContext> {
    const keyword = stripKeywordInputFormatMarker(keywordText.trim().split(/[\s,]/)[0]).replace(/^\*/, '').toUpperCase();
    const titleBody = nativeTitleBodyKeyword(rule, keyword);
    const spelling = nativeSpellingBinding(keyword) || (titleBody
        ? { ...nativeFilePrefixBinding(keyword), baseKeyword: titleBody } : undefined);
    if (spelling && !spelling.originalContactPrefix && !spelling.interfaceComponent) {
        const override = keywordInputFormatOverride(keywordText);
        const baseKeywordText = '*' + spelling.baseKeyword + (override ? { standard: ' -', long: ' +', i10: ' %' }[override] : '');
        if (spelling.layout) {
            const body = baseNativeFileReadContext(rule, baseKeywordText, rows,
                globalFormat, recordLines, parameters);
            const cards = new Map<number, any>([...body.cards].map(([index, card]) => [index,
                spelling.strictNativeHelp ? { ...card, fields: card.fields.map(field => ({ ...field,
                    help: nativeSpellingFieldHelp(field.fieldRecordId) ?? '' })) } : card]));
            for (const card of spelling.extraCards || []) cards.set(card.cardIndex, card);
            if (spelling.prefixCard) cards.set(0, spelling.prefixCard);
            const title = !!spelling.prefixCard;
            return { ...body, kind: 'conditional-sequence', cards, fields: [...cards.values()].filter(card => card.cardIndex !== 0),
                read: (text, card, field) => readNativeFileField(body.kind, card, cards.get(card)?.fields || [], text, field, body.readInput),
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
            const body = baseNativeFileReadContext(rule, baseKeywordText, rows,
                globalFormat, recordLines, parameters);
            const cards = new Map<number, any>(body.cards);
            cards.set(0, spelling.prefixCard);
            return { ...body, cards,
                select(partial = false, draft?, _targetTitle?, draftRecord?) {
                    return selectNativeFileLayout('generic-fixed', rows, true,
                        (row, card, field) => body.read(rows[row] || '', card, field), draft,
                        true, partial, body.fields.length, body.controls.resolve, draftRecord);
                } };
        }
        const prefix = spelling.prefixCard ? 1 : 0;
        const body = nativeFileReadContext(rule, baseKeywordText, rows.slice(prefix),
            globalFormat, recordLines?.slice(prefix), parameters);
        const cards = new Map<number, any>(body.cards);
        if (prefix) cards.set(0, spelling.prefixCard);
        const shift = record => ({ ...record, instanceStart: record.instanceStart ? record.instanceStart + prefix : 0,
            key: record.key.replace(/^instance:\d+/, `instance:${record.instanceStart ? record.instanceStart + prefix : 0}`) });
        return { ...body, cards,
            writeCompatible(records) {
                return records.length === rows.length && (!prefix || records[0]?.cardIndex === 0) &&
                    body.writeCompatible(records.slice(prefix));
            },
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
    return baseNativeFileReadContext(rule, keywordText, rows, globalFormat, recordLines, parameters, nativeReadLayout);
}

function baseNativeFileReadContext(rule: any, keywordText: string, rows: string[],
    globalFormat: KeywordInputFormatMode, recordLines?: number[], parameters?: NativeParameterContext,
    nativeReadLayout?: { state: string; cardIndexes?: number[]; reason?: string }) {
    const keyword = stripKeywordInputFormatMarker(keywordText.trim().split(/[\s,]/)[0]).replace(/^\*/, '').toUpperCase();
    const kind = nativeFileLayoutKind(rule, keyword);
    const fields = nativeFileLayoutCards(rule, keyword);
    const cards = new Map<number, any>(fields.map(card => [Number(card.cardIndex), card]));
    const prefix = nativeFilePrefixBinding(keyword)?.prefixCard;
    if (prefix) cards.set(0, prefix);
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
            // The pinned SPR3 comma reader consumes the next keyword/title when
            // its optional fourth body record is absent. Preserve that boundary.
            if (binding?.cardSetId === "record:046033df36da543cb96fa4bf:95eb78253fedc7fb3fedec7e" && rows.some((row, index) => records[index]?.cardIndex > 0 && row.includes(',')) &&
                records.filter(record => record.cardIndex > 0).map(record => record.cardIndex).join(',') === '1,2,3') return false;
            // A full source-locked card match permits the existing fixed-field writer;
            // read-only catalogs elsewhere do not acquire write authority by association.
            const layout = writeLayouts.find(item => item.keywords.includes(keyword) &&
                item.sourceSha256 === rule.catalogSource?.datasetSha256 && item.cardSetId === rule.cardSetId &&
                item.cards.length === rule.cards.length && item.formats.includes(input));
            if (layout && !rows.some(row => row.includes(',')) && layout.cards.every((expected, index) => {
                const fields = cards.get(index + 1)?.fields;
                return fields?.length === expected.names.length && fields.every((field, i) =>
                    field.name === expected.names[i] && field.type === expected.types[i] &&
                    field.position === i * layout.fieldWidth && field.width === layout.fieldWidth);
            }) && records.every((record, index) => cards.has(record.cardIndex) && cards.get(record.cardIndex).fields.length > 0 && cards.get(record.cardIndex).fields.every((field, fieldIndex) =>
                read(rows[index] || '', record.cardIndex, fieldIndex) === readNativeFileField(null, record.cardIndex,
                    cards.get(record.cardIndex).fields, rows[index] || '', fieldIndex, input)))) return true;
            return records.every((record, index) => nativeFileControlCompatible(kind, record.cardIndex,
                cards.get(record.cardIndex)?.fields || [], rows[index] || '', input));
        },
        select(partial = false, draft?: Parameters<typeof selectNativeFileLayout>[4],
            targetTitle = title, draftRecord?: Parameters<typeof selectNativeFileLayout>[9]) {
            if (readInputFailure) return null;
            if (kind === 'em-connection-records') {
                // File indexes have no root occurrence or inherited INCLUDE format.
                // Query-time selection supplies even an explicitly unknown layout.
                if (nativeReadLayout === undefined) return null;
                const indexes = nativeReadLayout?.state === 'ready' ? nativeReadLayout.cardIndexes : [1];
                if (!indexes?.length || !partial && rows.length < indexes.length) return null;
                const current = rows.map((_text, index) => ({ cardIndex: indexes[index] || 0,
                    instanceStart: 0, key: `instance:0:record:${index}` }));
                return { current, target: current.slice(), ...(nativeReadLayout?.state !== 'ready' ? {
                    uncertainty: nativeReadLayout?.reason || 'native-em-read-order-unresolved', unknownCardIndexes: [3],
                } : {}) };
            }
            if (kind === 'verified-source-records')
                return { current: selectVerifiedSourceRecords(rule, keyword, rows, readInput) };
            if (kind === 'user-material-records') return selectNativeUserMaterialRecords(rows,
                (row, card, field) => read(rows[row] || '', card, field), controls.resolve, nativeFordFeatureEnabled);
            if (kind === 'ale-trim-records') {
                const reader = nativeAleTrimRecordReader();
                const current = rows.map(text => reader.next(text));
                if (current.some(record => !record)) return null;
                if (draftRecord) {
                    const targetReader = nativeAleTrimRecordReader();
                    // Reading another pool does not authorize migrating its shared tail fields.
                    if (rows.some((text, index) => targetReader.next(draftRecord(current[index], text))?.cardIndex !== current[index].cardIndex)) return null;
                }
                return { current, target: current.slice() };
            }
            if (kind === 'ale-motion-single') {
                const reader = nativeAleMotionRecordReader();
                const current = rows.map(text => reader.next(text));
                return reader.complete() ? { current, target: current.slice() } : null;
            }
            if (kind === 'controlled-reference-records') {
                const reader = nativeControlledReferenceRecordReader(keyword, cards, readInput, controls.resolve);
                const current = rows.map((text, index) => reader.next(text, index));
                return current.some(record => !record) || !partial && !reader.complete()
                    ? null : { current, target: current.slice() };
            }
            if (kind === 'contact-optional-records') {
                const reader = nativeContactOptionalRecordReader(nativeContactOptionalBinding(rule, keyword, rule.nativeAuxiliaryReferenceFields));
                const current = rows.map((text, index) => reader.next(text, index));
                return !partial && !reader.complete() ? null : { current, target: current.slice() };
            }
            const soil = kind === 'reference-tail' && nativeSoilPileRecordReader(keyword, cards, readInput,
                (raw, line) => controls.resolve(raw, line));
            if (soil) {
                const current = rows.map((text, index) => soil.next(text, index));
                return current.some(record => !record) || !partial && !soil.complete()
                    ? null : { current, target: current.slice() };
            }
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
                targetTitle, partial, fields.length, controls.resolve, draftRecord,
                nativeReferenceTailBinding(keyword)?.headerCount)
                : { current: selectVerifiedSourceRecords(rule, keyword, rows, readInput) };
        },
    };
}
