import { keywordDataPath } from "../keywordDataPath";
import { descriptorIdentityAt } from './descriptorIdentity';
/** File reader contracts are distinct from GUI descriptor pools.
 * Keep the verified dataset and record identity bindings together;
 * replacement datasets require matching verification.
 */
import { readRecordField, type RecordField } from '../edit/keywordRecordSerializer';
import { nativeConditionalBinding, nativeConditionalSource } from './nativeConditionalLayout';
import { nativeCountedOccurrenceBinding, nativeCountedOccurrenceSource } from './nativeCountedOccurrenceLayout';
const sectionFixed = require(keywordDataPath("native-readers/lspp-section-fixed-readers.json"));
const genericReaders = require(keywordDataPath("native-readers/lspp-generic-file-readers.json"));
const optionalTailReaders = require(keywordDataPath("native-readers/lspp-optional-tail-readers.json"));
const eosSpecialReaders = require(keywordDataPath("native-readers/lspp-eos-special-readers.json"));
const ordinalReaders = require(keywordDataPath("native-readers/lspp-ordinal-file-readers.json"));
const ordinalConditional = require(keywordDataPath("native-readers/lspp-ordinal-conditional-readers.json"));
const batchFixed = require(keywordDataPath("native-readers/lspp-batch-fixed-readers.json"));
const suffixFixed = require(keywordDataPath("native-readers/lspp-suffix-fixed-readers.json"));
const spellingReaders = require(keywordDataPath("native-readers/lspp-spelling-file-readers.json"));
const contactIdMppFixed = require(keywordDataPath("native-readers/lspp-contact-id-mpp-fixed-readers.json"));
const contactMppTail = require(keywordDataPath("native-readers/lspp-contact-mpp-tail-readers.json"));
const spellingFileCards = new Map<string, any[]>(Object.values<any>(spellingReaders.bindings)
    .filter(binding => binding.fileCards).map(binding => [binding.baseKeyword, binding.fileCards]));
export function nativeSpellingBinding(keyword: string): any {
    const name = keyword.replace(/^\*/, '');
    return spellingReaders.bindings[name] || contactIdMppFixed.bindings[name] || contactMppTail.bindings[name];
}
export function nativeSpellingFieldHelp(address: string): string | undefined {
    return contactIdMppFixed.fieldHelpByAddress[address] ?? contactMppTail.fieldHelpByAddress[address];
}
export function nativeSpellingGap(keyword: string): any {
    return spellingReaders.gaps?.[keyword.replace(/^\*/, '')];
}
const elementReaders = require(keywordDataPath("native-readers/lspp-element-readers.json"));
const nodeReaders = require(keywordDataPath("native-readers/lspp-node-readers.json"));
const partCompositeReaders = require(keywordDataPath("native-readers/lspp-part-composite-readers.json"));
const partStandaloneReaders = require(keywordDataPath("native-readers/lspp-part-standalone-readers.json"));
const partModularReaders = require(keywordDataPath("native-readers/lspp-part-modular-readers.json"));
export function nativePartCompositeBinding(keyword: string): any {
    return partCompositeReaders.bindings[keyword.replace(/^\*/, '')];
}
export function nativePartStandaloneBinding(keyword: string): any {
    return partStandaloneReaders.bindings[keyword.replace(/^\*/, '')];
}
export function nativePartModularBinding(keyword: string): any {
    return partModularReaders.bindings[keyword.replace(/^\*/, '')];
}
export function nativeNodeBinding(keyword: string): any {
    return nodeReaders.bindings[keyword.replace(/^\*/, '')];
}
export function nativeElementBinding(keyword: string): any {
    return elementReaders.bindings[keyword.replace(/^\*/, '')];
}
export function nativeBatchFixedBinding(keyword: string): any {
    const name = nativeSpellingBinding(keyword)?.baseKeyword || keyword.replace(/^\*/, '');
    return batchFixed.bindings[name] || suffixFixed.bindings[name];
}
/** File dispatch can select a different pool from the GUI alias directory. */
export function nativeFileCatalogKeyword(keyword: string): string {
    return nativeSpellingBinding(keyword)?.baseKeyword || nativeBatchFixedBinding(keyword)?.catalogKeyword || nativeNodeBinding(keyword)?.aliasOf || keyword;
}
export function nativeFieldlessBinding(keyword: string): any {
    return batchFixed.sourceSha256 === NATIVE_FILE_SOURCE ? batchFixed.fieldlessBindings?.[keyword.replace(/^\*/, '')] : undefined;
}
export function nativeOrdinalConditionalBinding(keyword: string): any {
    return ordinalConditional.bindings[keyword.replace(/^\*/, '')];
}
export function nativeOrdinalBinding(keyword: string): any {
    return ordinalReaders.bindings[keyword.replace(/^\*/, '').replace(/_TITLE$/, '')];
}
/** The live registration count can trim a contiguous pool or include a zero-field record. */
export function nativeFileLayoutCards(rule: any, keyword: string): any[] {
    if (spellingFileCards.has(keyword)) return spellingFileCards.get(keyword);
    const spelling = nativeSpellingBinding(keyword);
    if (spelling) return nativeFileLayoutCards(rule, spelling.baseKeyword);
    if (nativeConditionalBinding(keyword) && ['conditional-sequence', 'generic-fixed'].includes(nativeFileLayoutKind(rule, keyword))) return rule.cards.map(card => ({
        ...card, fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })),
    }));
    const composite = nativePartCompositeBinding(keyword);
    if (composite && nativeFileLayoutKind(rule, keyword) === composite.kind) return rule.cards.slice(0, composite.cardCount)
        .map(card => ({ ...card, fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })) }));
    const standalone = nativePartStandaloneBinding(keyword);
    if (standalone && nativeFileLayoutKind(rule, keyword) === standalone.kind) return rule.cards.slice(0, standalone.cardCount)
        .map(card => ({ ...card, fields: card.fields.map((field, fieldIndex, fields) => ({
            ...field,
            nativeLongWidth: Math.max(20, field.width),
            ...(standalone.readWindows ? { nativeReadGeometry: {
                long: { position: fields.slice(0, fieldIndex).reduce((sum, previous) => sum + Math.max(20, previous.width), 0), width: Math.max(20, field.width) },
                i10: { position: fields.slice(0, fieldIndex).reduce((sum, previous) => sum + (Number(previous.type) === 1 ? Math.max(10, previous.width) : previous.width), 0), width: Number(field.type) === 1 ? Math.max(10, field.width) : field.width },
            } } : {}),
        })) }));
    const node = nativeNodeBinding(keyword);
    if (node && nativeFileLayoutKind(rule, keyword) === node.kind) return rule.cards.slice(0, node.cardCount)
        .map(card => ({ ...card, fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })) }));
    const modular = nativePartModularBinding(keyword);
    if (modular && nativeFileLayoutKind(rule, keyword) === modular.kind) return rule.cards.slice(0, modular.cardCount)
        .map(card => ({ ...card, fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })) }));
    if (['mesh-node', 'mesh-part', 'part-composite', 'shell-bext-patch', 'shell-nurbs-patch', 'shell-nurbs-patch-trimmed'].includes(nativeFileLayoutKind(rule, keyword))) return rule.cards.map(card => ({
        ...card, fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })),
    }));
    const element = nativeElementBinding(keyword);
    if (element && nativeFileLayoutKind(rule, keyword) === element.kind) return rule.cards.slice(0, element.cardCount)
        .map(card => ({ ...card, fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })) }));
    const batch = nativeBatchFixedBinding(keyword);
    if (batch && ['batch-fixed', 'generic-fixed'].includes(nativeFileLayoutKind(rule, keyword))) return Array.from({ length: batch.cardCount }, (_, index) =>
        batch.zeroFieldCards.includes(index + 1) ? { cardIndex: index + 1,
            cardRecordId: descriptorIdentityAt(batch.cardSetId, index),
            fields: [], nativeZeroFieldRecord: true } :
            { ...(rule.cards[index] || batch.additionalCards?.find(card => card.cardIndex === index + 1)),
              fields: (rule.cards[index] || batch.additionalCards?.find(card => card.cardIndex === index + 1)).fields.map((field, fieldIndex, fields) => ({ ...field,
                nativeLongWidth: Math.max(20, field.width),
                ...(batch.readWindows ? { nativeReadGeometry: {
                    long: { position: fields.slice(0, fieldIndex).reduce((sum, previous) => sum + Math.max(20, previous.width), 0), width: Math.max(20, field.width) },
                    i10: { position: field.position, width: field.width },
                } } : {}),
            })) });
    const conditional = nativeOrdinalConditionalBinding(keyword);
    if (conditional && nativeFileLayoutKind(rule, keyword) === conditional.kind) return rule.cards.slice(0, conditional.cardCount)
        .map(card => ({ ...card, fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })) }));
    const binding = nativeOrdinalBinding(keyword);
    if (!binding || nativeFileLayoutKind(rule, keyword) !== 'ordinal-fixed') return rule.cards;
    return Array.from({ length: binding.cardCount }, (_, index) => binding.zeroFieldCards.includes(index + 1)
        ? { cardIndex: index + 1, cardRecordId: descriptorIdentityAt(binding.cardSetId, index),
            fields: [], nativeZeroFieldRecord: true } : rule.cards[index]);
}
export function hasNativeEosSpecialReader(keyword: string): boolean {
    return Object.prototype.hasOwnProperty.call(eosSpecialReaders.bindings, keyword.replace(/^\*/, '').replace(/_TITLE$/, ''));
}

export function nativeAfterburnRecordCard(text: string): number | null {
    if (/^[\t\v\f\r ]*[+-]?0[xX]/.test(text)) return null; // CRT hexadecimal syntax remains unverified.
    const number = text.match(/^[\t\v\f\r ]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/)?.[1];
    return Math.fround(number ? Number(number) : 0) === 3 ? 3 : 2;
}
export function hasNativeOptionalTailReader(keyword: string): boolean {
    return Object.prototype.hasOwnProperty.call(optionalTailReaders.bindings, keyword.replace(/^\*/, '').replace(/_TITLE$/, ''));
}
export function hasNativeGenericReader(keyword: string): boolean {
    const name = keyword.replace(/^\*/, '').replace(/_TITLE$/, '');
    return Object.prototype.hasOwnProperty.call(genericReaders.bindings, name) ||
        Object.prototype.hasOwnProperty.call(genericReaders.fixedBindings, name);
}
export function nativeGenericBranch(kind: string): {
    cardCount: number; controllerCard: number; controllerField: number; controllerName: string;
    activeValue: number; blankValue: number; retainsExpandedCount: boolean;
} | undefined { return genericReaders.branches[kind]; }
export function nativeGenericControlValue(branch: { blankValue: number }, raw: string): number {
    const text = raw.trim();
    if (!text) return branch.blankValue;
    if (!/^[+-]?\d+$/.test(text)) return NaN;
    const value = Number(text);
    return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : NaN;
}
export const NATIVE_FILE_SOURCE = "68aa1f658eaeed8dc2b33eb9687eb349cf754d1f3fc51959a2364b9fdb071423";
export function hasNativeSectionFixedReader(keyword: string): boolean {
    return Object.prototype.hasOwnProperty.call(sectionFixed.bindings, keyword.replace(/_TITLE$/, ''));
}
export function nativeFileLayoutKind(rule: any, keyword: string): string | null {
    if (nativeSpellingGap(keyword)) return 'unsupported-source';
    const spelling = nativeSpellingBinding(keyword);
    if (spelling) return (contactIdMppFixed.bindings[keyword.replace(/^\*/, '')] ||
        contactMppTail.bindings[keyword.replace(/^\*/, '')]
        ? (contactIdMppFixed.bindings[keyword.replace(/^\*/, '')]
            ? contactIdMppFixed.sourceSha256 : contactMppTail.sourceSha256) === NATIVE_FILE_SOURCE &&
            rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
            rule?.cardSetId === spelling.cardSetId
        : spellingReaders.sourceSha256 === NATIVE_FILE_SOURCE) &&
        !nativeSpellingBinding(spelling.baseKeyword) ? nativeFileLayoutKind(rule, spelling.baseKeyword) : 'unsupported-source';
    const occurrence = nativeCountedOccurrenceBinding(keyword);
    if (occurrence) return nativeCountedOccurrenceSource() === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === occurrence.cardSetId &&
        rule.cards?.length === occurrence.cardCount ? occurrence.kind : 'unsupported-source';
    const sequence = nativeConditionalBinding(keyword);
    if (sequence) return nativeConditionalSource() === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === sequence.cardSetId &&
        rule.cards?.length === sequence.cardCount ? (sequence.kind === 'fixed-instances' ? 'generic-fixed' : 'conditional-sequence') : 'unsupported-source';
    
    const composite = nativePartCompositeBinding(keyword);
    if (composite) return partCompositeReaders.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === composite.cardSetId &&
        [composite.catalogCardCount, composite.cardCount].includes(rule.cards?.length) ? composite.kind : 'unsupported-source';
    const standalone = nativePartStandaloneBinding(keyword);
    if (standalone) return partStandaloneReaders.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === standalone.cardSetId &&
        [standalone.catalogCardCount, standalone.cardCount].includes(rule.cards?.length) ? standalone.kind : 'unsupported-source';
    const modular = nativePartModularBinding(keyword);
    if (modular) return partModularReaders.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === modular.cardSetId &&
        [modular.catalogCardCount, modular.cardCount].includes(rule.cards?.length) ? modular.kind : 'unsupported-source';
    const node = nativeNodeBinding(keyword);
    if (node) return nodeReaders.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === node.cardSetId &&
        [node.catalogCardCount, node.cardCount].includes(rule.cards?.length) ? node.kind : 'unsupported-source';
    const mesh = keyword.replace(/^\*/, '') === 'PART' ? ['mesh-part', "record:918a1b8665d14093fb26fd77:02d750a02d826d15169c333f", 2] : null;
    if (mesh) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === mesh[1] && rule.cards?.length === mesh[2] ? String(mesh[0]) : 'unsupported-source';
    const element = nativeElementBinding(keyword);
    if (element) return elementReaders.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === element.cardSetId &&
        [element.catalogCardCount, element.cardCount].includes(rule.cards?.length) ? element.kind : 'unsupported-source';
    const name = keyword.replace(/^\*/, '').replace(/_TITLE$/, '');
    const conditional = nativeOrdinalConditionalBinding(keyword);
    if (conditional) return ordinalConditional.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === conditional.cardSetId &&
        [conditional.catalogCardCount, conditional.cardCount].includes(rule.cards?.length) ? conditional.kind : 'unsupported-source';
    const ordinal = nativeOrdinalBinding(keyword);
    if (ordinal) {
        if (/_TITLE$/.test(keyword) && ordinal.titleSpelling === 'rejected') return 'unsupported-spelling';
        return ordinalReaders.sourceSha256 === NATIVE_FILE_SOURCE && rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
            rule.cardSetId === ordinal.cardSetId && [ordinal.catalogCardCount, ordinal.cardCount].includes(rule.cards?.length)
            ? 'ordinal-fixed' : 'unsupported-source';
    }
    const eos = eosSpecialReaders.bindings[name];
    if (eos) return eosSpecialReaders.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === eos.cardSetId &&
        rule.cards?.length === eos.cardCount ? eos.kind : 'unsupported-source';
    const genericFixed = genericReaders.fixedBindings[name];
    if (genericFixed) return genericReaders.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === genericFixed.cardSetId &&
        rule.cards?.length === genericFixed.cardCount ? 'generic-fixed' : 'unsupported-source';
    const optional = optionalTailReaders.bindings[name];
    if (optional) return optionalTailReaders.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === optional.cardSetId &&
        rule.cards?.length === optional.cardCount ? 'optional-tail' : 'unsupported-source';
    const generic = genericReaders.bindings[name];
    if (generic) return genericReaders.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === generic.cardSetId && rule.cards?.length === nativeGenericBranch(generic.kind)?.cardCount
        ? generic.kind : 'unsupported-source';
    const fixed = sectionFixed.bindings[name];
    if (fixed) return sectionFixed.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === fixed.cardSetId && rule.cards?.length === fixed.cardCount
        ? 'section-fixed' : 'unsupported-source';
    const batch = nativeBatchFixedBinding(keyword);
    if (batch) {
        if (batchFixed.sourceSha256 !== NATIVE_FILE_SOURCE || (suffixFixed.bindings[keyword] && suffixFixed.sourceSha256 !== NATIVE_FILE_SOURCE) || rule?.catalogSource?.datasetSha256 !== NATIVE_FILE_SOURCE ||
            rule.cardSetId !== batch.cardSetId || ![batch.catalogCardCount, batch.cardCount].includes(rule.cards?.length)) return 'unsupported-source';
        // Previously verified record grammars retain optional tails and instance boundaries.
        if (!rule.recordSelection && rule.occurrenceGrammar?.authority !== 'native-executable-read-save-reopen')
            return batch.prefixSemantics === 'title' ? 'generic-fixed' : 'batch-fixed';
    }
    const binding = name === 'SECTION_BEAM' ? ['beam', "record:ddd1735d5be2589e912a6edc:d3e1ed7489caab75dfd9d057"] :
        name === 'SECTION_SHELL' ? ['shell', "record:ddd1735d5be2589e912a6edc:b34ba5813d3281bd87850680"] :
        name === 'SECTION_TSHELL' ? ['tshell', "record:ddd1735d5be2589e912a6edc:5f59f00622a30e8d29a12782"] :
        name === 'SECTION_POINT_SOURCE' ? ['point-source', "record:ddd1735d5be2589e912a6edc:9f05a88c8c5b2ac66d5a06e5"] :
        name === 'SECTION_POINT_SOURCE_MIXTURE' ? ['point-source-mixture', "record:ddd1735d5be2589e912a6edc:3792dc8951f28cd538895ba9"] :
        name === 'SECTION_IGA_SHELL' ? ['iga-shell', "record:ddd1735d5be2589e912a6edc:735724bc36a59b1301702b2e"] :
        name === 'SECTION_SOLID' ? ['solid', "record:ddd1735d5be2589e912a6edc:5bbecd3f00d551ff8ad09d89"] :
        name === 'SECTION_SOLID_EFG' ? ['solid', "record:ddd1735d5be2589e912a6edc:a8cb156681bdd6d5c2684c6c"] :
        name === 'SECTION_SOLID_SPG' ? ['solid', "record:ddd1735d5be2589e912a6edc:1a2fd88fc2e530c40bf32b67"] :
        ['MAT_213', 'MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE'].includes(name) ? ['mat213', "record:898d9435a6db06292b3a4e7e:84bfee5bbd87a2a4edf976b6"] : null;
    if (binding) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === binding[1]
        ? binding[0] : 'unsupported-source';
    const patch = name === 'ELEMENT_SHELL_BEXT_PATCH' ? ['shell-bext-patch', "record:1786cdc8dc093e114e364515:f10ea372e147a50a024bf57d"] :
        name === 'ELEMENT_SHELL_NURBS_PATCH' ? ['shell-nurbs-patch', "record:1786cdc8dc093e114e364515:9ab1ea87ddf26f632235bc25"] :
        name === 'ELEMENT_SHELL_NURBS_PATCH_TRIMMED' ? ['shell-nurbs-patch-trimmed', "record:1786cdc8dc093e114e364515:9ab1ea87ddf26f632235bc25"] : null;
    if (patch) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === patch[1] && rule.cards?.length === 8 ? patch[0] : 'unsupported-source';
    return null;
}

export type NativeFileRecord = { cardIndex: number; key: string; instanceStart: number; branchIdentity?: string };
export function nativeFixedFileRecord(kind: string, ordinal: number, title: boolean, cardCount: number): NativeFileRecord | null {
    if ((kind === 'mesh-part' || kind === 'part-modular') && Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= cardCount)
        return { cardIndex: ordinal, instanceStart: 0, key: `instance:0:card:${ordinal}` };
    if ((kind === 'mesh-node' || kind === 'part-standalone-fixed') && Number.isSafeInteger(ordinal) && ordinal >= 1)
        return { cardIndex: 1, instanceStart: ordinal - 1, key: `instance:${ordinal - 1}:card:1` };
    if (kind === 'part-composite' && Number.isSafeInteger(ordinal) && ordinal >= 1) {
        const cardIndex = ordinal === 1 ? 1 : ordinal === 2 ? 2 : (cardCount === 4 && ordinal === 3) ? 3 : cardCount;
        const repeat = ordinal >= cardCount ? ordinal - cardCount : 0;
        return { cardIndex, instanceStart: 0, key: `instance:0:card:${cardIndex}${repeat ? `:repeat:${repeat}` : ''}` };
    }
    if (kind === 'part-stacked-elements' && Number.isSafeInteger(ordinal) && ordinal >= 1) {
        const cardIndex = ordinal === 1 ? 1 : ordinal === 2 ? 2 : 3;
        const repeat = ordinal >= 3 ? ordinal - 3 : 0;
        return { cardIndex, instanceStart: 0, key: `instance:0:card:${cardIndex}${repeat ? `:repeat:${repeat}` : ''}` };
    }
    if (!['section-fixed', 'generic-fixed', 'ordinal-fixed', 'batch-fixed', 'element-fixed'].includes(kind) || !Number.isSafeInteger(ordinal) || ordinal < 1 ||
        !Number.isInteger(cardCount) || cardCount < 1 || cardCount > 256) return null;
    const prefix = Number(title && kind !== 'ordinal-fixed' && kind !== 'batch-fixed');
    const size = cardCount + prefix, instanceStart = Math.floor((ordinal - 1) / size) * size;
    const cardIndex = (ordinal - 1) % size + 1 - prefix;
    return { cardIndex, instanceStart, key: `instance:${instanceStart}:card:${cardIndex}` };
}
type ReadField = (row: number, card: number, field: number) => string;
type DraftField = (record: NativeFileRecord, field: number, original: string) => string;


export function nativeCompositeLayerRecord(text: string): boolean {
    if (text.includes(',')) {
        const token = text.split(',')[3]?.trim() || '';
        return token === '' || token === '0';
    }
    // The native <=1 length test accepts any single character, not only zero.
    // This window stays at 30..40 even for LONG and I10 input.
    return text.slice(30, 40).trim().length <= 1;
}

export function nativeCompositePrefix(cardCount: number, highNodes: number[]): number[] | null {
    const indexes = Array.from({ length: cardCount - 1 }, (_, i) => i + 1);
    if (cardCount >= 4 && !highNodes.some(value => value > 0)) {
        if (highNodes.some(value => !Number.isInteger(value))) return null;
        indexes.splice(2, 1);
    }
    return indexes;
}

/** Read a file controller using the pinned LS-PrePost reader's window. */
export function readNativeFileField(kind: string, card: number, fields: RecordField[],
    text: string, field: number, input: 'standard' | 'long' | 'i10'): string {
    // MAT213 dispatches before descriptor decoding and always scans ten bytes.
    // Descriptor geometry still determines the displayed field and its range.
    if (kind === 'mat213' && [8,12,14,16,18].includes(card) && field === 0 && !text.includes(','))
        return text.slice(0, 10).trim();
    const format = text.includes(',') ? 'comma' : input;
    return readRecordField(text, fields, field, format);
}

/** A descriptor-width edit must not silently change the narrower dispatch read. */
export function nativeFileControlCompatible(kind: string, card: number, fields: RecordField[],
    text: string, input: 'standard' | 'long' | 'i10'): boolean {
    return kind !== 'mat213' || ![8,12,14,16,18].includes(card) || text.includes(',') ||
        Number(text.slice(0, 10).trim()) === Number(readRecordField(text, fields, 0, input));
}

/** File-backed finite grammars only; descriptor/GUI state pools are not grammars. */
export function selectVerifiedSourceRecords(rule: any, keyword: string, rows: string[],
    input: 'standard' | 'long' | 'i10'): NativeFileRecord[] | null {
    const name = keyword.replace(/^\*/, '');
    if (rule?.catalogSource?.datasetSha256 !== NATIVE_FILE_SOURCE) return null;
    const formats = rows.map(row => row.includes(',') ? 'comma' : input);
    const selection = rule.recordSelection;
    if (selection?.keyword === name && selection.datasetSha256 === NATIVE_FILE_SOURCE &&
        selection.kind === 'native-string-tail-replacement' &&
        selection.recordBehavior?.kind === 'native-two-record-instance' &&
        selection.recordBehavior.recordsPerInstance === 2 && selection.recordBehavior.keywordHeaderPerInstance === true &&
        selection.recordBehavior.sameHeadExtraRecords === 'unrecognized') {
        if (formats.some(format => !selection.recordBehavior.formats?.includes(format))) return null;
        const prefix = selection.prefixCardIndexes;
        if (prefix?.length !== 1 || rows.length === 0) return [];
        const records = [{ cardIndex: prefix[0], instanceStart: 0, key: `instance:0:card:${prefix[0]}` }];
        if (rows.length === 1) return records;
        const fields = selection.cards.find(card => card.cardIndex === selection.controllerCardIndex)?.fields;
        if (!fields) return null;
        const format = rows[1].includes(',') ? 'comma' : input;
        let value = readRecordField(rows[1], fields, selection.controllerFieldIndex, format);
        // The native branch reader keeps its ten-byte controller window in
        // LONG input; descriptor display geometry is twenty columns there.
        if (format !== 'comma' && selection.controllerReadWidth)
            value = rows[1].slice(0, selection.controllerReadWidth).trim();
        const selected = selection.cases.find(item =>
            selection.caseInsensitive ? String(item.value).toUpperCase() === value.toUpperCase() : item.value === value)?.cardIndex ??
            selection.defaultCardIndex;
        if (selected) records.push({ cardIndex: selected, instanceStart: 0, key: `instance:0:card:${selected}` });
        return records;
    }
    const grammar = rule.occurrenceGrammar;
    if (grammar?.authority !== 'native-executable-read-save-reopen' ||
        grammar.sourceSha256 !== NATIVE_FILE_SOURCE || !grammar.verifiedSpellings?.includes(name) ||
        grammar.kind !== 'native-fixed-records' || grammar.repeatResolution !== 'verified-fixed-record-instances' ||
        !Number.isInteger(grammar.recordsPerInstance) || grammar.recordsPerInstance < 1 ||
        grammar.recordsPerInstance !== rule.cards.length) return null;
    const evidenceFormat = { standard: 'standard-fixed', comma: 'comma-free', long: 'long-fixed', i10: 'i10-fixed' };
    if (formats.some(format => !grammar.verifiedInputFormats?.includes(evidenceFormat[format]))) return null;
    const count = grammar.recordsPerInstance;
    return rows.map((_row, index) => {
        const start = Math.floor(index / count) * count, card = index % count + 1;
        return { cardIndex: card, instanceStart: start, key: `instance:${start}:card:${card}` };
    });
}

/** Consume source records using the native reader's boundaries, then evaluate
 * edits against those same instances. An edit never reinterprets the following
 * source entity as a newly required record in the edited entity.
 */
export function selectNativeFileLayout(kind: string, rows: string[], title: boolean,
    read: ReadField, draft: DraftField = (_record, _field, value) => value, targetTitle = title,
    partial = false, fixedCount = 0, resolveControl = (value: string, _row: number) => value,
    draftRecord = (_record: NativeFileRecord, text: string) => text) {
    const current: NativeFileRecord[] = [], target: NativeFileRecord[] = [], counts: number[] = [];
    if (kind === 'mesh-node' || kind === 'mesh-part' || kind === 'part-composite' || kind === 'part-stacked-elements' || kind === 'part-standalone-fixed') {
        if (kind === 'mesh-part' && !partial && rows.length !== 2) return null;
        if ((kind === 'part-composite' || kind === 'part-stacked-elements') && !partial && rows.length < fixedCount) return null;
        const records = rows.slice(0, kind === 'mesh-part' ? 2 : rows.length).map((_row, index) =>
            nativeFixedFileRecord(kind, index + 1, false, fixedCount));
        return { current: records, target: records.slice(), counts: (kind === 'mesh-part' || kind === 'part-composite' || kind === 'part-stacked-elements') ? [records.length] : records.map(() => 1) };
    }
    if (kind === 'part-modes') {
        if (!partial && rows.length < 2) return null;
        const records: NativeFileRecord[] = [];
        if (rows.length >= 1) records.push({ cardIndex: 1, instanceStart: 0, key: 'instance:0:card:1' });
        if (rows.length >= 2) records.push({ cardIndex: 2, instanceStart: 0, key: 'instance:0:card:2' });
        if (rows.length > 2) {
            const kmflag = Math.trunc(Number(resolveControl(read(0, 1, 5), 0))) || 0;
            const nmfb = Math.trunc(Number(resolveControl(read(0, 1, 1), 0))) || 0;
            const modeCards = kmflag !== 0 ? Math.ceil(Math.max(0, nmfb) / 8) : 0;
            for (let i = 2; i < rows.length; i++) {
                const modeIndex = i - 2;
                if (modeIndex < modeCards) {
                    records.push({ cardIndex: 3, instanceStart: 0, key: `instance:0:card:3${modeCards > 1 ? `:repeat:${modeIndex}` : ''}` });
                } else {
                    const dampIndex = modeIndex - modeCards;
                    records.push({ cardIndex: 4, instanceStart: 0, key: `instance:0:card:4${dampIndex > 0 ? `:repeat:${dampIndex}` : ''}` });
                }
            }
        }
        return { current: records, target: records.slice(), counts: [records.length] };
    }
    let start = 0;
    
    // suffix but still consumes its next line as ordinary numeric fields.
    if (kind === 'ordinal-fixed' || kind === 'batch-fixed') title = targetTitle = false;
    const generic = nativeGenericBranch(kind);
    let sourceExpanded = false, targetExpanded = false;
    let sourceShellCount = fixedCount, targetShellCount = fixedCount;
    // Native descriptor readers use C numeric conversion: blank and a literal
    // without a numeric prefix become zero. An unresolved parameter must stay
    // uncertain instead of silently selecting the zero branch.
    const number = (value: string) => {
        const raw = value.trim();
        if (raw.includes('&')) return NaN;
        const parsed = Number.parseFloat(raw.replace(/[dD]/g, 'e'));
        return Number.isNaN(parsed) ? 0 : parsed;
    };
    const record = (cardIndex: number, offset: number, occurrence = 0): NativeFileRecord => ({
        cardIndex, instanceStart: offset,
        key: `instance:${offset}:card:${kind === 'mat213' && cardIndex >= 12 ?
            (cardIndex % 2 === 0 ? 8 : 9) : cardIndex}${occurrence ? `:repeat:${occurrence}` : ''}`,
    });
    if (kind === 'eos-afterburn') {
        const head = Number(title);
        if (!partial && (rows.length <= head || rows.length > head + 2)) return null;
        if (title && rows.length) current.push(record(0, 0));
        if (rows.length > head) current.push(record(1, 0));
        if (rows.length > head + 1) {
            const card = nativeAfterburnRecordCard(rows[head + 1]);
            if (card === null) return partial ? { current, target: current.slice(), counts: [] } : null;
            const source = record(card, 0);
            // Branch migration needs separate write evidence. Detect edits to
            // any byte of the record: atof may consume beyond a blank OPT cell.
            if (nativeAfterburnRecordCard(draftRecord(source, rows[head + 1])) !== card) return null;
            current.push(source);
        }
        if (targetTitle && rows.length) target.push(record(0, 0));
        target.push(...current.filter(item => item.cardIndex !== 0));
        return { current, target, counts: current.length ? [current.length] : [] };
    }
    if (kind === 'optional-tail') {
        // This reader stores one entity and returns. It consumes blank records;
        // only a keyword boundary can end the optional suffix early.
        const prefix = Number(title), count = Math.min(Math.max(0, rows.length - prefix), fixedCount);
        if (!fixedCount || (!partial && (count < 1 || rows.length > prefix + fixedCount))) return null;
        if (title && rows.length) current.push(record(0, 0));
        for (let card = 1; card <= count; card++) current.push(record(card, 0));
        if (targetTitle && rows.length) target.push(record(0, 0));
        target.push(...current.filter(item => item.cardIndex !== 0));
        return { current, target, counts: current.length ? [current.length] : [] };
    }
    while (start < rows.length) {
        const head = start + Number(title);
        if (head >= rows.length) {
            if (!partial) return null;
            if (title) current.push(record(0, start));
            return { current, target: current.slice(), counts };
        }
        const get = (row: number, card: number, field: number, edited: boolean) => {
            const value = read(row, card, field);
            return resolveControl(edited ? draft(record(card, start), field, value) : value, row);
        };
        const layout = (edited: boolean, source?: number[]) => {
            if (kind === 'element-composite') {
                if (edited && start > 0 && nativeCompositeLayerRecord(draftRecord(record(1, start), rows[head]))) return null;
                const indexes = nativeCompositePrefix(fixedCount, [6, 7, 8, 9].map(field => number(get(head, 1, field, edited))));
                if (!indexes) return null;
                if (edited && source && indexes.some((card, i) => source[i] !== card)) return null;
                const prefixCount = indexes.length;
                let occurrence = 0;
                for (let row = head + prefixCount; row < rows.length && nativeCompositeLayerRecord(rows[row]); row++) {
                    if (edited && !nativeCompositeLayerRecord(draftRecord(record(fixedCount, start, occurrence), rows[row]))) return null;
                    indexes.push(fixedCount); occurrence++;
                }
                return indexes;
            }
            if (kind === 'element-shell-offset') {
                
                
                let expanded = edited ? targetExpanded : sourceExpanded;
                if (!expanded) {
                    const nodes = [6, 7, 8, 9].map(field => number(get(head, 1, field, edited)));
                    const normalized = nodes[1] !== 0 && nodes[2] === 0;
                    const effective = normalized ? [...nodes, number(get(head, 1, 5, edited))] : nodes;
                    if (effective.some(value => value > 0)) expanded = true;
                    else if (effective.some(value => !Number.isInteger(value))) return null;
                }
                if (edited) targetExpanded = expanded; else sourceExpanded = expanded;
                const indexes = expanded ? [1, 2, 3, 4] : [1, 2, 4];
                return edited && source && source.length !== indexes.length ? null : indexes;
            }
            if (kind === 'element-shell') {
                
                // of this keyword block; subsequent eight-node heads do not reset it.
                
                // when N6!=0 and N7==0, effective N5 is the original N4.
                const previousCount = edited ? targetShellCount : sourceShellCount;
                const n6 = number(get(head, 1, 7, edited)), n7 = number(get(head, 1, 8, edited));
                const normalized = n6 !== 0 && n7 === 0;
                const uncertain = !Number.isInteger(n6) && n7 === 0 || !Number.isInteger(n7) && n6 !== 0;
                const n5 = previousCount < fixedCount ? 0 : uncertain ? NaN : number(get(head, 1, normalized ? 5 : 6, edited));
                if (!Number.isInteger(n5)) return null;
                if (n5 === 0) {
                    if (edited) targetShellCount = fixedCount - 1;
                    else sourceShellCount = fixedCount - 1;
                }
                const count = edited ? targetShellCount : sourceShellCount;
                if (edited && source && source.length !== count) return null;
                return Array.from({ length: count }, (_, i) => i + 1);
            }
            if (kind === 'ordinal-ambient' || kind === 'ordinal-d3spcm') {
                const value = number(get(head, 1, kind === 'ordinal-ambient' ? 2 : 0, edited));
                if (!Number.isInteger(value)) return null;
                const indexes = value === (kind === 'ordinal-ambient' ? 4 : 3) ? [1, 2] : [1];
                // Reading a branch does not authorize destructive branch migration.
                return edited && source && indexes.length !== source.length ? null : indexes;
            }
            if (generic) {
                const raw = get(head + generic.controllerCard - 1, generic.controllerCard, generic.controllerField, edited);
                const value = nativeGenericControlValue(generic, raw);
                let expanded = generic.retainsExpandedCount && (edited ? targetExpanded : sourceExpanded);
                if (!expanded && !Number.isInteger(value)) return null;
                expanded ||= value === generic.activeValue;
                // Reading a tail does not prove how an editor should initialize
                // a newly inserted tail. Keep that edit closed until verified.
                if (edited && expanded && !source?.includes(generic.cardCount)) return null;
                if (edited) targetExpanded = expanded; else sourceExpanded = expanded;
                return Array.from({ length: generic.cardCount - Number(!expanded) }, (_, i) => i + 1);
            }
            // Independently bound native readers consume registered cards and repeat the entity.
            // Only individually verified registration bindings reach this case.
            if (kind === 'section-fixed' || kind === 'generic-fixed' || kind === 'ordinal-fixed' || kind === 'batch-fixed' || kind === 'element-fixed') return Number.isInteger(fixedCount) && fixedCount > 0 && fixedCount <= 256
                ? Array.from({ length: fixedCount }, (_, index) => index + 1) : null;
            if (kind === 'solid') {
                
                // then reads NIP integration rows and ceil(LMC/8) P rows.
                const prefix = fixedCount - 3;
                if (![1, 3].includes(prefix)) return null;
                const elform = number(get(head, 1, 1, edited));
                if (!Number.isInteger(elform)) return null;
                const cards = Array.from({ length: prefix }, (_, i) => i + 1);
                if (elform < 101 || elform > 105) return cards;
                // A newly required controller has no source record. Never read
                // the following entity as its NIP/LMC; initialization evidence
                // is required before allowing that edit in the manager.
                if (edited && source && !source.includes(prefix + 1)) return null;
                const nip = number(get(head + prefix, prefix + 1, 0, edited));
                const lmc = number(get(head + prefix, prefix + 1, 4, edited));
                if (![nip, lmc].every(Number.isInteger)) return null;
                const integrations = Math.max(0, nip), parameters = Math.max(0, Math.ceil(lmc / 8));
                if (prefix + 1 + integrations + parameters > 256) return null;
                return [...cards, prefix + 1, ...Array(integrations).fill(prefix + 2), ...Array(parameters).fill(prefix + 3)];
            }
            if (['point-source', 'point-source-mixture', 'iga-shell', 'eos-user-defined'].includes(kind)) {
                
                // keyword. IGA's file tail is not governed by the GUI ICOMP state.
                const prefix = ['point-source', 'eos-user-defined'].includes(kind) ? [1] : [1, 2];
                return [...prefix, ...Array(Math.max(0, rows.length - head - prefix.length)).fill(prefix.length + 1)];
            }
            if (kind === 'tshell') {
                const nip = number(get(head, 1, 3, edited));
                const icomp = number(get(head, 1, 6, edited));
                // Native boundary probes for other ICOMP values remain open;
                // do not reuse the ICOMP=1 record mapping for those values.
                if (!Number.isInteger(nip) || ![0, 1].includes(icomp)) return null;
                const count = icomp === 1 ? Math.max(0, Math.trunc((nip - 1) / 8) + 1) : 0;
                if (count > 256) return null;
                return [1, ...Array(count).fill(2)];
            }
            if (kind === 'beam') {
                const elform = number(get(head, 1, 1, edited));
                if (!Number.isInteger(elform)) return null;
                
                const second = [2, 2, 3, 4, 5, 5, 6, 8, 8, 9, 2, 2, 10, 3, 13][elform] || 2;
                const wasShape = source?.[1] === 12;
                const shape = [2, 3, 12].includes(elform) && (edited ?
                    wasShape || String(get(head + 1, 12, 0, true)).startsWith('SECTION') :
                    String(rows[head + 1] || '').startsWith('SECTION'));
                const cards = [1, shape ? 12 : second];
                if (!shape && second === 10) cards.push(11);
                if (shape && elform === 2 && (edited ? source?.includes(15) :
                    String(rows[head + 2] || '').startsWith('OPTCARD'))) cards.push(15);
                // Native permits the final YS row to be absent at end of block.
                if (cards[2] === 11 && head + 2 === rows.length &&
                    (!edited || (source?.[1] === 10 && source.length === 2))) cards.pop();
                return cards;
            }
            if (kind === 'shell') {
                const elform = number(get(head, 1, 1, edited));
                const nip = number(get(head, 1, 3, edited));
                const icomp = number(get(head, 1, 6, edited));
                if (![elform, nip, icomp].every(Number.isInteger)) return null;
                const special = elform >= 100 && elform <= 105;
                const cards = special ? [1, 2, 3, 4] : [1, 2];
                const count = icomp === 1 ? Math.max(0, Math.trunc((nip - 1) / 8) + 1) : 0;
                if (count > 256) return null; // Same bounded edit window as the host block collector.
                cards.push(...Array(count).fill(5));
                // ELFORM 100..105 consumes the Pi tail through the next keyword.
                if (special) cards.push(...Array(edited ? source?.filter(i => i === 6).length || 0 :
                    Math.max(0, rows.length - head - cards.length)).fill(6));
                return cards;
            }
            if (kind === 'mat213') {
                const sourceType = number(read(head + 7, 8, 0));
                if (!Number.isInteger(sourceType) || sourceType < 0 || sourceType > 4) return null;
                const sourceCard = source?.[7] || (sourceType === 0 ? 8 : 10 + 2 * sourceType);
                const ftype = number(get(head + 7, sourceCard, 0, edited));
                if (!Number.isInteger(ftype) || ftype < 0 || ftype > 4) return null;
                const branch = ftype === 0 ? 8 : 10 + 2 * ftype;
                return [1, 2, 3, 4, 5, 6, 7, branch, branch + 1, 10, 11];
            }
            if (kind === 'shell-bext-patch') {
                const nel = number(get(head, 1, 2, edited));
                const wfl = number(get(head + 1, 2, 0, edited));
                if (!Number.isInteger(nel) || !Number.isInteger(wfl) || nel < 0) return null;
                const cards = [1, 2];
                let rowOffset = head + 2;
                for (let el = 0; el < nel; el++) {
                    if (rowOffset >= rows.length && partial) break;
                    const pr = number(get(rowOffset, 3, 1, edited));
                    const ps = number(get(rowOffset, 3, 2, edited));
                    const bdry = number(get(rowOffset, 3, 3, edited));
                    if (!Number.isInteger(pr) || !Number.isInteger(ps) || !Number.isInteger(bdry)) return null;
                    cards.push(3);
                    rowOffset++;
                    const n = (pr + 1) * (ps + 1), q = Math.ceil(n / 8);
                    if (bdry !== 0) {
                        for (let i = 0; i < q; i++) cards.push(4);
                        for (let i = 0; i < q; i++) cards.push(5);
                        rowOffset += 2 * q;
                    }
                    for (let i = 0; i < q; i++) cards.push(6);
                    rowOffset += q;
                    if (wfl !== 0) {
                        for (let i = 0; i < q; i++) cards.push(7);
                        rowOffset += q;
                    }
                    const oCards = n * q;
                    for (let i = 0; i < oCards; i++) cards.push(8);
                    rowOffset += oCards;
                }
                if (edited && source && source.length !== cards.length) return null;
                return cards;
            }
            if (kind === 'shell-nurbs-patch' || kind === 'shell-nurbs-patch-trimmed') {
                const npr = number(get(head, 1, 2, edited));
                const pr = number(get(head, 1, 3, edited));
                const nps = number(get(head, 1, 4, edited));
                const ps = number(get(head, 1, 5, edited));
                const wfl = number(get(head + 1, 2, 0, edited));
                if (![npr, pr, nps, ps, wfl].every(Number.isInteger) || npr < 0 || nps < 0) return null;
                const cards = [1, 2];
                if (npr > 0 && nps > 0) {
                    const rKnots = Math.ceil((npr + pr + 1) / 8);
                    const sKnots = Math.ceil((nps + ps + 1) / 8);
                    for (let i = 0; i < rKnots; i++) cards.push(3);
                    for (let i = 0; i < sKnots; i++) cards.push(4);
                    const cpCards = nps * Math.ceil(npr / 8);
                    for (let i = 0; i < cpCards; i++) cards.push(5);
                    if (wfl !== 0) {
                        for (let i = 0; i < cpCards; i++) cards.push(6);
                    }
                }
                if (kind === 'shell-nurbs-patch-trimmed') {
                    let currentRow = head + cards.length;
                    while (currentRow < rows.length) {
                        const rowText = rows[currentRow] || '';
                        const isTitle = !/^[\t\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)/.test(rowText.trim());
                        cards.push(isTitle ? 7 : 8);
                        currentRow++;
                    }
                }
                if (edited && source && source.length !== cards.length) return null;
                return cards;
            }
            return null;
        };
        const source = layout(false);
        if (!source || head + source.length > rows.length) {
            if (!partial) return null;
            // A missing/unknown suffix cannot erase a proven head. No guessed
            // record may advance the start of the following entity.
            if (title) current.push(record(0, start));
            const solidPrefix = kind === 'solid' ? Array.from({ length: Math.max(0, fixedCount - 3) }, (_, i) => i + 1) : [];
            const solidElform = kind === 'solid' ? number(get(head, 1, 1, false)) : NaN;
            if (Number.isInteger(solidElform) && solidElform >= 101 && solidElform <= 105) solidPrefix.push(fixedCount - 2);
            const prefix = source || (generic ? Array.from({ length: generic.controllerCard }, (_, i) => i + 1) :
                kind === 'solid' ? solidPrefix : kind === 'mat213' ? [1,2,3,4,5,6,7] :
                ['beam', 'shell', 'tshell', 'ordinal-ambient', 'ordinal-d3spcm', 'element-shell', 'element-shell-offset', 'element-composite'].includes(kind) ? [1] :
                ['shell-bext-patch', 'shell-nurbs-patch', 'shell-nurbs-patch-trimmed'].includes(kind) ? [1, 2] : []);
            const repeats = new Map<number, number>();
            for (const card of prefix.slice(0, rows.length - head)) {
                const occurrence = repeats.get(card) || 0;
                current.push(record(card, start, occurrence));
                repeats.set(card, occurrence + 1);
            }
            return { current, target: current.slice(), counts };
        }
        const edited = layout(true, source);
        if (!edited) return null;
        const append = (into: NativeFileRecord[], indexes: number[], withTitle: boolean) => {
            if (withTitle) into.push(record(0, start));
            const repeats = new Map<number, number>();
            for (const card of indexes) {
                const occurrence = repeats.get(card) || 0;
                into.push(record(card, start, occurrence));
                repeats.set(card, occurrence + 1);
            }
        };
        append(current, source, title); append(target, edited, targetTitle);
        const count = source.length + Number(title);
        counts.push(count); start += count;
        // MAT's reader returns after one entity, unlike the SECTION loop.
        if (kind === 'mat213' && start !== rows.length) return partial ? { current, target, counts } : null;
    }
    return { current, target, counts };
}
