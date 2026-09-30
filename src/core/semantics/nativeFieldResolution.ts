import type { FieldContext } from '../parser/fieldContext';
import { nativeSpellingGap } from "./catalogNativeFileLayout";
import { isKeywordCommentLine } from '../parser/keywordLine';
import { keywordInputFormat, keywordInputFormatOverride } from '../parser/inputFormat';
import { formattedReadFields, readRecordField } from '../edit/keywordRecordSerializer';
import { getCatalogInputFormCatalogV4 } from "./catalogInputFormCatalogV4";
import { nativeSpellingBinding, nativeFileCatalogKeyword, nativeFileLayoutKind, readNativeFileField, hasNativeSectionFixedReader, hasNativeGenericReader, hasNativeOptionalTailReader, hasNativeEosSpecialReader, nativeGenericBranch, nativeGenericControlValue, NATIVE_FILE_SOURCE } from "./catalogNativeFileLayout";
import type { CardResolution, KeywordSchema } from '../keywordSchema';
import { nativeFileReadContext } from './nativeFileReadContext';
import { nativeConditionalBinding } from './nativeConditionalLayout';
import { nativeCountedOccurrenceBinding } from './nativeCountedOccurrenceLayout';
import { nativeFileLayoutCards, nativeOrdinalBinding, nativeOrdinalConditionalBinding, nativeFixedFileRecord, nativeBatchFixedBinding, nativeElementBinding, nativeNodeBinding, nativeFieldlessBinding, nativePartCompositeBinding, nativePartStandaloneBinding, nativePartModularBinding } from "./catalogNativeFileLayout";

/** Native descriptor identity and schema help identity are deliberately separate. */
export type NativeFieldIdentity = {
    source: string; cardIndex: number; fieldIndex: number; fieldRecordId: string;
    instanceStart?: number; sourceLine?: number; recordKey: string; branchIdentity?: string;
};

const knownReaders = /^(?:SECTION_(?:BEAM|SHELL|TSHELL|POINT_SOURCE(?:_MIXTURE)?|IGA_SHELL|SOLID(?:_EFG|_SPG)?)|MAT_213|MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE|ELEMENT_SHELL_(?:BEXT_PATCH|NURBS_PATCH(?:_TRIMMED)?))(?:_TITLE)?$/;
const finiteReaders = /^(?:ALE_STRUCTURED_MESH_VOLUME_FILLING|DATABASE_BINARY_(?:D3DAT|(?:BLSTFOR|CPMFOR|D3CRACK|D3DRLF|RUNRSF)(?:_ID)?))$/;
const noParameters = {};
/** Display evidence alone never authorizes modifying a newly bound spelling. */
export function nativeFieldDisplayOnly(keyword: string): boolean {
    return !!(nativeSpellingGap(keyword) || nativeSpellingBinding(keyword) || nativeConditionalBinding(keyword)?.displayOnly || nativeCountedOccurrenceBinding(keyword)?.displayOnly || nativeBatchFixedBinding(keyword)?.displayOnly ||
        nativeOrdinalConditionalBinding(keyword)?.displayOnly);
}
let cache = new WeakMap<KeywordSchema, WeakMap<object, WeakMap<object, Map<string, CardResolution>>>>();
let cachedCatalog: ReturnType<typeof getCatalogInputFormCatalogV4> | undefined;
// Keep circular schema/help dependencies lazy, while reusing Node's loaded module objects.
let managerHelpModule: typeof import('../hover/managerFieldHelpResolution') | undefined;
let schemaHelpModule: typeof import('../keywordSchema') | undefined;
export function hasNativeFileReader(keyword: string): boolean {
    if (nativeSpellingBinding(keyword) || nativeSpellingGap(keyword)) return true;
    if (nativeConditionalBinding(keyword)) return true;
    if (nativeCountedOccurrenceBinding(keyword)) return true;
    if (keyword === 'PART' || keyword === 'NODE' || nativeNodeBinding(keyword) || nativeFieldlessBinding(keyword) || nativePartCompositeBinding(keyword) || nativePartStandaloneBinding(keyword) || nativePartModularBinding(keyword)) return true;
    return knownReaders.test(keyword) || finiteReaders.test(keyword) || hasNativeSectionFixedReader(keyword) || hasNativeGenericReader(keyword) || hasNativeOptionalTailReader(keyword) || hasNativeEosSpecialReader(keyword) || Boolean(nativeOrdinalBinding(keyword) || nativeOrdinalConditionalBinding(keyword) || nativeBatchFixedBinding(keyword) || nativeElementBinding(keyword));
}

export function nativeFieldsNeedOnlyOrdinal(keyword: string): boolean {
    const spelling = nativeSpellingBinding(keyword);
    if (spelling && (spelling.layout || spelling.prefixCard && spelling.prefixScope !== 'instance')) return false;
    if (keyword === 'NODE' || nativeNodeBinding(keyword)) return false; // One record per instance can use the indexed homogeneous fast path.
    if (nativePartCompositeBinding(keyword) || nativePartModularBinding(keyword)) return true;
    const standalone = nativePartStandaloneBinding(keyword);
    if (standalone) return standalone.kind === 'part-stacked-elements' || standalone.kind === 'part-standalone-fixed';
    if (!hasNativeFileReader(keyword)) return false;
    try {
        const form = getCatalogInputFormCatalogV4().formForKeyword(nativeFileCatalogKeyword(keyword));
        const ruleIds = nativeBatchFixedBinding(keyword) ? [nativeBatchFixedBinding(keyword).ruleId] : form?.reference.formRuleIds;
        if (form?.source?.datasetSha256 !== NATIVE_FILE_SOURCE || form.source.isUnauditedDiagnostic || ruleIds?.length !== 1 || !form.rules[ruleIds[0]]) return false;
        const rule = { ...form.rules[ruleIds[0]], catalogSource: form.source };
        const kind = nativeFileLayoutKind(rule, keyword);
        return !!nativeFixedFileRecord(spelling?.prefixScope === 'instance' ? 'generic-fixed' : kind, 1,
            spelling ? !!spelling.prefixCard : /_TITLE$/.test(keyword), nativeFileLayoutCards(rule, keyword).length);
    } catch { return false; }
}

export function resolveNativeFieldCard(context: FieldContext, keyword: string,
    schema: KeywordSchema, activeOptions: string[] = []): CardResolution | null {
    if (!hasNativeFileReader(keyword)) return null;
    if (isKeywordCommentLine(context.currentText)) return { status: 'unsupported', reason: 'comment-line' };
    if (nativeFieldlessBinding(keyword)) return { status: 'unsupported', reason: 'native-reader-has-no-data-fields' };
    const catalog = getCatalogInputFormCatalogV4();
    if (catalog !== cachedCatalog) {
        cache = new WeakMap();
        cachedCatalog = catalog;
    }
    if (!context.cacheIdentity) return resolveUncached(context, keyword, schema, activeOptions);
    // The bounded reader replaces its snapshot identity on document version changes.
    // A growing prefix changes length; schema reloads have a separate weak owner.
    let byParameters = cache.get(schema);
    if (!byParameters) cache.set(schema, byParameters = new WeakMap());
    const parameterIdentity = context.parameterContext || noParameters;
    let byRecords = byParameters.get(parameterIdentity);
    if (!byRecords) byParameters.set(parameterIdentity, byRecords = new WeakMap());
    let entries = byRecords.get(context.cacheIdentity);
    if (!entries) byRecords.set(context.cacheIdentity, entries = new Map());
    const key = JSON.stringify([keyword, activeOptions, context.keywordText, context.globalInputFormat,
        context.dataLineOrdinal, context.observedDataLines.length, context.currentText]);
    const previous = entries.get(key);
    if (previous) return previous;
    const result = resolveUncached(context, keyword, schema, activeOptions);
    entries.set(key, result);
    if (entries.size > 64) entries.delete(entries.keys().next().value);
    return result;
}

function resolveUncached(context: FieldContext, keyword: string, schema: KeywordSchema, activeOptions: string[]): CardResolution {
    const fail = (reason: string, failureKind?: CardResolution['failureKind']): CardResolution =>
        ({ status: 'unresolved', reason, ...(failureKind ? { failureKind } : {}) });
    if (nativeSpellingGap(keyword)?.nativeRejected) return { status: 'unsupported', reason: nativeSpellingGap(keyword).reason };
    if (nativeSpellingGap(keyword)) return fail(nativeSpellingGap(keyword).reason, 'implementation-gap');
    if (/_TITLE$/.test(keyword) && nativeOrdinalBinding(keyword)?.titleSpelling === 'rejected') return fail('native-title-spelling-rejected');
    const directNode = (keyword === 'NODE' || nativeNodeBinding(keyword)) && context.homogeneousRepeat && Number.isInteger(context.currentLine);
    const ordinal = directNode ? 1 : context.dataLineOrdinal;
    if (!ordinal) return fail('native-record-context-unavailable');
    let form;
    try {
        const formKeyword = nativeFileCatalogKeyword(keyword);
        form = getCatalogInputFormCatalogV4().formForKeyword(formKeyword);
    }
    catch { return fail('native-file-catalog-unavailable', 'implementation-gap'); }
    const rules = (form?.reference?.formRuleIds || []).map(id => form.rules[id]);
    const candidates = rules.filter(rule => !(nativeSpellingBinding(keyword) || nativeConditionalBinding(keyword) || nativeCountedOccurrenceBinding(keyword) || knownReaders.test(keyword) || hasNativeSectionFixedReader(keyword) || hasNativeGenericReader(keyword) || nativeBatchFixedBinding(keyword) || nativeNodeBinding(keyword) || nativePartCompositeBinding(keyword) || nativePartStandaloneBinding(keyword) || nativePartModularBinding(keyword)) ||
        nativeFileLayoutKind({ ...rule, catalogSource: form.source }, keyword) !== 'unsupported-source');
    if (form?.source?.datasetSha256 !== NATIVE_FILE_SOURCE || form.source.isUnauditedDiagnostic || candidates.length !== 1) {
        return fail('native-file-source-unverified', 'implementation-gap');
    }
    const rawRule = candidates[0];
    const rule = { ...rawRule, catalogSource: form.source,
        cards: rawRule.recordSelection?.cards || rawRule.cards };
    const rows = context.observedDataLines;
    const countedOccurrence = nativeCountedOccurrenceBinding(keyword);
    if (countedOccurrence && (keywordInputFormat(context.keywordText, context.globalInputFormat) !== 'standard' ||
        rows.some(row => row.includes(',')))) return { status: 'unsupported', reason: 'non-standard-input-format' };
    const localFormat = keywordInputFormatOverride(context.keywordText);
    const selectedHeader = '*' + keyword + (localFormat ? ' ' + { standard: '-', long: '+', i10: '%' }[localFormat] : '');
    const reading = nativeFileReadContext(rule, selectedHeader, context.recordOrdinalOnly ? [context.currentText] : rows,
        context.globalInputFormat, context.recordLines, context.parameterContext);
    if (reading.readInputFailure) return fail(reading.readInputFailure, 'implementation-gap');
    const { kind, input, readInput, cards, controls: parameters } = reading;
    rule.cards = reading.fields;
    const binding = nativeSpellingBinding(keyword);
    const positioned = binding && (binding.layout || binding.prefixCard && binding.prefixScope !== 'instance') ? null :
        nativeFixedFileRecord(binding?.prefixScope === 'instance' ? 'generic-fixed' : kind, ordinal,
            binding ? !!binding.prefixCard : /_TITLE$/.test(keyword), rule.cards.length);
    if (!positioned && ordinal > rows.length) return fail('native-record-context-unavailable');
    if (context.recordOrdinalOnly && !positioned) return fail('native-record-context-unavailable');
    const selection = context.recordOrdinalOnly ? null : reading.select(true);
    const record = positioned || selection?.current?.[ordinal - 1];
    if (!record) return fail(parameters.reasons.size ? 'native-' + [...parameters.reasons].join(',') :
        selection && 'reasons' in selection && Array.isArray(selection.reasons) && selection.reasons.length ? 'native-' + selection.reasons.join(',') : 'native-control-or-record-layout-unresolved',
        selection && 'failureKind' in selection &&
            (selection.failureKind === 'input-uncertain' || selection.failureKind === 'implementation-gap') ? selection.failureKind : undefined);
    // Prefix spelling was independently checked in the native read/save fixtures.
    const nativeCard = cards.get(record.cardIndex) || (record.cardIndex === 0 ? { cardIndex: 0, fields: [
        // Shared native TITLE descriptor observed in the spelling trace archive.
        { name: 'TITLE', type: 0, position: 0, width: 80, fieldRecordId: "record:3c11134d2da44eeb1b070a21:85e7c1a0cbf91f41661b0e14",
            help: require('./nativeDescriptorHelp').nativeDescriptorHelp({ fieldRecordId: "record:3c11134d2da44eeb1b070a21:85e7c1a0cbf91f41661b0e14", name: 'TITLE', type: 0 }) },
    ] } : undefined);
    if (!nativeCard) return fail('native-field-descriptor-unavailable', 'implementation-gap');
    const textCard = record.cardIndex === 0 || ((kind === 'mesh-part' || kind === 'part-composite' || kind === 'part-stacked-elements' || kind === 'part-modular') && record.cardIndex === 1) || (kind === 'part-modes' && record.cardIndex === 2);
    const prefixFormat = record.cardIndex === 0 ? nativeSpellingBinding(keyword)?.prefixFormat : undefined;
    const format = prefixFormat && prefixFormat !== 'input' ? prefixFormat : prefixFormat === 'input'
        ? context.currentText.includes(',') ? 'comma' : readInput : textCard ? 'raw' : context.currentText.includes(',') ? 'comma' : readInput;
    const physical = formattedReadFields(nativeCard.fields, context.currentText, format);
    if (physical.length !== nativeCard.fields.length) return fail('native-field-format-unresolved');
    // Lazy import avoids making the schema loader depend on its help consumer during initialization.
    const { resolveManagerSchemaField, managerHelpLookups } = managerHelpModule ??= require('../hover/managerFieldHelpResolution');
    const { getEnglishFieldHelp } = schemaHelpModule ??= require('../keywordSchema');
    const lookups = managerHelpLookups(keyword, schema, rule);
    // Preserve existing approved operations only when the complete source card
    // independently agrees with this verified fixed reader. Help matching alone
    // never grants this association; repeated/shifted records remain excluded.
    const staticCard = schema[keyword]?.c?.[record.cardIndex - 1];
    const approvedStaticRecord = input === readInput && (kind === 'batch-fixed' && !nativeBatchFixedBinding(keyword)?.readWindows && format === 'standard' && ordinal === record.cardIndex ||
        kind === 'mesh-node' && format === 'standard' || kind === 'mesh-part' && record.cardIndex === 2 && ['standard', 'i10'].includes(format));
    const staticBinding = approvedStaticRecord &&
        staticCard?.length === nativeCard.fields.length && nativeCard.fields.every((field, index) => {
            const prior = staticCard[index];
            const type = [0, -2].includes(Number(field.type)) ? 'string' : Math.abs(Number(field.type)) === 1 ? 'integer' : 'real';
            return prior.n === field.name && prior.t === type && prior.p === field.position && prior.w === field.width;
        });
    const card = nativeCard.fields.map((field, index) => {
        let helpField;
        for (const candidate of lookups) {
            helpField = resolveManagerSchemaField(candidate, field, nativeCard);
            if (helpField) break;
        }
        const span = physical[index];
        // The branch reader's prefix window is separate from the field span:
        // a LONG descriptor still occupies its full physical twenty columns.
        const width = span.width;
        const type = [0, -2].includes(Number(field.type)) ? 'string' : Math.abs(Number(field.type)) === 1 ? 'integer' : 'real';
        const nativeHelp = String(field.help || '').trim();
        const sameHelp = !binding?.strictNativeHelp && !nativeHelp ||
            nativeHelp === String(getEnglishFieldHelp(helpField) || '').trim();
        const rawValue = readRecordField(context.currentText, nativeCard.fields, index, format);
        return {
            ...(sameHelp ? helpField || {} : {}), n: /^\s*[-_]*\s*$/.test(field.name) ? 'UNUSED' : field.name,
            p: span.position, w: width, t: type,
            // Help association cannot replace the native field's default or choices.
            d: field.defaultValue ?? undefined, e: Array.isArray(field.choices) ? [...field.choices] : undefined,
            ...(!helpField || !sameHelp ? { h: nativeHelp } : {}),
            nativeIdentity: { source: form.source.datasetSha256, cardIndex: record.cardIndex,
                fieldIndex: index, fieldRecordId: field.fieldRecordId, instanceStart: directNode ? undefined : record.instanceStart,
                branchIdentity: record.branchIdentity,
                ...(directNode ? { sourceLine: context.currentLine } : {}), recordKey: directNode ? `line:${context.currentLine}:card:1` : record.key },
            nativeStaticBinding: staticBinding || undefined,
            rawValue,
            nativeRange: { start: Math.min(span.position, context.currentText.length),
                end: Math.min(context.currentText.length, span.position + (format === 'comma' ? rawValue.length : width)) },
            // Geometry of a help match does not authorize a reference/edit binding.
            nativeHelpField: helpField || undefined,
        };
    });
    const solidDynamic = kind === 'solid' && selection?.current?.some(r => r.instanceStart === record.instanceStart && r.cardIndex === rule.cards.length - 2);
    const generic = nativeGenericBranch(kind);
    const controls = kind?.startsWith('element-shell') ? [[0, 1, 6, 'N5']] : kind === 'ordinal-ambient' ? [[0, 1, 2, 'AMBTYP']] : kind === 'ordinal-d3spcm' ? [[0, 1, 0, 'BINARY']] :
        generic ? [[generic.controllerCard - 1, generic.controllerCard, generic.controllerField, generic.controllerName]] :
        kind === 'solid' ? [[0, 1, 1, 'ELFORM'], ...(solidDynamic ?
        [[rule.cards.length - 3, rule.cards.length - 2, 0, 'NIP'], [rule.cards.length - 3, rule.cards.length - 2, 4, 'LMC']] : [])] :
        kind === 'tshell' ? [[0, 1, 3, 'NIP'], [0, 1, 6, 'ICOMP']] : kind === 'mat213' ? [[7, 8, 0, 'FTYPE']] : kind === 'shell'
        ? [[0, 1, 1, 'ELFORM'], [0, 1, 3, 'NIP'], [0, 1, 6, 'ICOMP']] : kind === 'beam' ? [[0, 1, 1, 'ELFORM']] : [];
    const spelling = nativeSpellingBinding(keyword);
    const head = record.instanceStart + Number(spelling ? !!spelling.prefixCard &&
        (spelling.prefixScope === 'instance' || record.instanceStart === 0) : /_TITLE$/.test(keyword));
    const conditions = controls.flatMap(([offset, ci, fi, name]) => {
        if (head + Number(offset) >= rows.length) return [];
        const value = parameters.resolve(readNativeFileField(kind, Number(ci), cards.get(Number(ci))?.fields || [],
            rows[head + Number(offset)], Number(fi), readInput), head + Number(offset));
        if (generic) {
            const control = nativeGenericControlValue(generic, value);
            const priorExpansion = generic.retainsExpandedCount && selection?.current?.some(r =>
                r.instanceStart < record.instanceStart && r.cardIndex === generic.cardCount);
            if (priorExpansion && control !== generic.activeValue) return [`${name}=${generic.activeValue} (earlier instance)`];
            return Number.isInteger(control) ? [control === generic.activeValue ? `${name}=${generic.activeValue}` : `${name}≠${generic.activeValue}`] : [];
        }
        return value && Number.isFinite(Number(value)) ? [`${name}=${value}`] : [];
    });
    if (kind === 'counted-occurrences' && record.branchIdentity) conditions.push(...record.branchIdentity.split(';'));
    else if (selection && 'conditions' in selection && Array.isArray(selection.conditions)) conditions.push(...selection.conditions);
    if (kind === 'eos-afterburn' && record.cardIndex > 1) {
        conditions.push(`raw record prefix (float32)${record.cardIndex === 3 ? '=' : '≠'}3`);
    }
    if (kind === 'element-composite' && record.cardIndex === rule.cards.length) {
        conditions.push(context.currentText.includes(',') ? 'native layer delimiter: fourth comma item blank or 0'
            : 'native layer delimiter: columns 31–40 contain at most one trimmed character');
    }
    if (kind?.startsWith('element-shell')) {
        const node = (index: number) => parameters.resolve(readNativeFileField(kind, 1,
            cards.get(1)?.fields || [], rows[head] || '', index, input), head);
        const n6 = Number(node(7)), n7 = Number(node(8));
        if (Number.isInteger(n6) && n6 !== 0 && n7 === 0) conditions.push('native six-node expansion: effective N5 = source N4');
        let previousStart = 0;
        const counts = selection && 'counts' in selection && Array.isArray(selection.counts) ? selection.counts : [];
        for (const count of counts) {
            if (previousStart >= record.instanceStart) break;
            if (kind === 'element-shell' && count < rule.cards.length) { conditions.push('reduced record count retained from earlier instance'); break; }
            if (kind === 'element-shell-offset' && count === rule.cards.length) { conditions.push('expanded record count retained from earlier instance'); break; }
            previousStart += count;
        }
    }
    return { status: 'resolved', reason: 'native-file-reader', cardInfo: {
        card, cardIndex: kind === 'mesh-node' || kind === 'mesh-part' ? record.cardIndex : ordinal, keywordName: keyword, activeOptions,
        observedDataLineOrdinal: context.dataLineOrdinal, resolutionSource: 'native-file-reader',
        nativeCardIndex: record.cardIndex, nativeInstanceStart: directNode ? undefined : record.instanceStart,
        nativeConditions: conditions, inputFormat: format,
        ...(textCard ? { isTextCard: true, isLeadingOptionCard: true } : {}),
    } };
}
