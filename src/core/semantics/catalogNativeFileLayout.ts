import { keywordDataPath } from "../keywordDataPath";
import { descriptorIdentityAt } from './descriptorIdentity';
/** File reader contracts are distinct from GUI descriptor pools.
 * Keep the verified dataset and record identity bindings together;
 * replacement datasets require matching verification.
 */
import { readRecordField, type RecordField } from '../edit/keywordRecordSerializer';
import { nativeConditionalBinding, nativeConditionalSource } from './nativeConditionalLayout';
import { nativeCountedOccurrenceBinding, nativeCountedOccurrenceSource } from './nativeCountedOccurrenceLayout';
import { contactThermalCatalogKeyword } from './contactThermal';
import { nativeContactOptionalBinding, nativeContactOptionalCards, nativeAuxiliaryReferenceSource } from './nativeContactOptionalReferences';
const { parseNumericInput } = require('../references/referenceInputValue');
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
const originalContactPrefixes = new Set(['CONTACT_DRAWBEAD', 'CONTACT_RIGID_BODY_ONE_WAY_TO_RIGID_BODY',
    'CONTACT_RIGID_BODY_TWO_WAY_TO_RIGID_BODY', 'CONTACT_RIGID_NODES_TO_RIGID_BODY']);
const interfaceComponents = Object.fromEntries(([
    ['INTERFACE_COMPONENT_NODE', "record:d69bdde291095487ba49c3be:b5c79314283453c6f605d790", ["record:d69bdde291095487ba49c3be:016e8bcf258f5da27cec9c14", "record:d69bdde291095487ba49c3be:9bb06355583e0c6d4c05cb59", "record:d69bdde291095487ba49c3be:6d72e3dc1f8318e37e2613e1"], 'NSID'],
    ['INTERFACE_COMPONENT_SEGMENT', "record:d69bdde291095487ba49c3be:c9a7e8a72c6a071af03f1ff6", ["record:d69bdde291095487ba49c3be:9c4a47a30b909c9ecc920eae", "record:d69bdde291095487ba49c3be:3e57318acc008f2d5e9d8138", "record:d69bdde291095487ba49c3be:5c51b48e97ee5caa859cc4a0"], 'SSID'],
    ['INTERFACE_COMPONENT_SPH', "record:d69bdde291095487ba49c3be:b5c79314283453c6f605d790", ["record:d69bdde291095487ba49c3be:016e8bcf258f5da27cec9c14", "record:d69bdde291095487ba49c3be:9bb06355583e0c6d4c05cb59", "record:d69bdde291095487ba49c3be:6d72e3dc1f8318e37e2613e1"], 'NSID'],
] as const).flatMap(([baseKeyword, cardSetId, payloadAddresses, payloadName]) => ['', '_ID', '_TITLE'].map(suffix =>
    [baseKeyword + suffix, { baseKeyword, cardSetId, payloadAddresses, payloadName,
        interfaceComponent: true, header: !!suffix, referenceKeyword: baseKeyword,
        kind: suffix ? 'batch-fixed' : 'generic-fixed' }])));

export function nativeInterfaceComponentBinding(keyword: string): any {
    return interfaceComponents[keyword.replace(/^\*/, '')];
}
// Exact saved spelling in the frozen contact-mpp-tail specialSaved thermal deck.
// This does not extend native authority to other manual suffix permutations.
function nativeSpellingName(keyword: string): string {
    let name = keyword.replace(/^\*/, '');
    if (name.endsWith('_ID_MPP') && originalContactPrefixes.has(name.slice(0, -7)))
        name = name.slice(0, -7) + '_MPP_ID';
    return name === 'CONTACT_SURFACE_TO_SURFACE_MPP_THERMAL_FRICTION_ID'
        ? 'CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION_MPP_ID' : name;
}
export function nativeSpellingBinding(keyword: string): any {
    const name = nativeSpellingName(keyword);
    const component = nativeInterfaceComponentBinding(name);
    if (component) return component;
    const binding = spellingReaders.bindings[name] || contactIdMppFixed.bindings[name] || contactMppTail.bindings[name];
    return binding && originalContactPrefixes.has(binding.baseKeyword) && contactMppTail.bindings[name]
        ? { ...binding, originalContactPrefix: true, referenceKeyword: name } : binding;
}
export function nativeSpellingFieldHelp(address: string): string | undefined {
    return contactIdMppFixed.fieldHelpByAddress[address] ?? contactMppTail.fieldHelpByAddress[address];
}
export function nativeSpellingGap(keyword: string): any {
    return spellingReaders.gaps?.[keyword.replace(/^\*/, '')];
}

/** Prefix identity comes from the exact file binding, including the older suffix catalog. */
export function nativeFilePrefixBinding(keyword: string): any {
    const spelling = nativeSpellingBinding(keyword);
    if (spelling) return spelling;
    const name = keyword.replace(/^\*/, '');
    if (suffixFixed.sourceSha256 !== NATIVE_FILE_SOURCE || suffixFixed.bindings[name]?.prefixSemantics !== 'title') return undefined;
    const form = require("./catalogInputFormCatalogV4").getCatalogInputFormCatalogV4().formForKeyword(name, false);
    if (form?.source?.datasetSha256 !== NATIVE_FILE_SOURCE) return undefined;
    const prefixes = (form.reference.selectorRuleIds || []).flatMap(id => (form.rules[id]?.selectors || [])
        .flatMap(selector => selector.values.filter(value => value.keywordSuffix === '_TITLE').flatMap(value => value.cards)));
    return prefixes.length === 1 ? { prefixCard: { ...prefixes[0], cardIndex: 0 }, prefixFormat: 'raw' } : undefined;
}

/** Exact verified file spellings only; unresolved/rejected gaps confer no recognition. */
export function isVerifiedNativeSpelling(keyword: string): boolean {
    const name = nativeSpellingName(keyword);
    return !!nativeInterfaceComponentBinding(name)?.header || [spellingReaders, contactIdMppFixed, contactMppTail, suffixFixed].some(source =>
        source.sourceSha256 === NATIVE_FILE_SOURCE &&
        Object.prototype.hasOwnProperty.call(source.bindings, name) && !source.gaps?.[name]);
}
const elementReaders = require(keywordDataPath("native-readers/lspp-element-readers.json"));
const nodeReaders = require(keywordDataPath("native-readers/lspp-node-readers.json"));
const partCompositeReaders = require(keywordDataPath("native-readers/lspp-part-composite-readers.json"));
const partStandaloneReaders = require(keywordDataPath("native-readers/lspp-part-standalone-readers.json"));
const partModularReaders = require(keywordDataPath("native-readers/lspp-part-modular-readers.json"));
/** Recognition covers source-locked reader names; it does not extend suffix write authority. */
export function isVerifiedNativeKeyword(keyword: string): boolean {
    const name = nativeSpellingName(keyword);
    return isVerifiedNativeSpelling(name) || [sectionFixed, genericReaders, optionalTailReaders, eosSpecialReaders,
        ordinalReaders, ordinalConditional, batchFixed, elementReaders, nodeReaders, partCompositeReaders,
        partStandaloneReaders, partModularReaders].some(source => source.sourceSha256 === NATIVE_FILE_SOURCE &&
        [source.bindings, source.fixedBindings].some(bindings => Object.prototype.hasOwnProperty.call(bindings || {}, name)) &&
        !source.gaps?.[name]) || nativeConditionalSource() === NATIVE_FILE_SOURCE && !!nativeConditionalBinding(name) ||
        nativeCountedOccurrenceSource() === NATIVE_FILE_SOURCE && !!nativeCountedOccurrenceBinding(name);
}
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
    const binding = nativeSpellingBinding(keyword)?.baseKeyword || nativeBatchFixedBinding(keyword)?.catalogKeyword || nativeNodeBinding(keyword)?.aliasOf;
    if (binding) return binding;
    if (nativeReferenceFileBinding(keyword)) return keyword;
    if (require("./catalogInputFormCatalogV4").getCatalogInputFormCatalogV4().hasKeyword(keyword)) return keyword;
    return contactThermalCatalogKeyword(keyword) || keyword;
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
    const original = nativeSpellingBinding(keyword);
    if (original?.interfaceComponent) return nativeFileLayoutKind(rule, keyword) === 'unsupported-source' ? [] :
        (original.header ? rule.cards : rule.cards.slice(1)).map((card, index) => ({ ...card, cardIndex: index + 1,
            fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })) }));
    if (original?.originalContactPrefix) {
        const body = nativeFileLayoutCards(rule, original.baseKeyword);
        const optional = nativeAuxiliaryReferenceSource()?.contactOptionalBindings
            .find(binding => binding.keyword === 'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE');
        if (!optional) return [];
        return [original.prefixCard, original.extraCards.find(card => card.cardIndex === -1), ...body,
            ...nativeContactOptionalCards({ cards: [] }, optional).map((card, index) => ({ ...card, cardIndex: body.length + index + 1 }))];
    }
    if (rule.contactComposition) return rule.cards;
    const spelling = nativeSpellingBinding(keyword);
    if (spelling) {
        const cards = new Map(nativeFileLayoutCards(rule, spelling.baseKeyword).map(card => [card.cardIndex, card]));
        for (const card of spelling.extraCards || []) cards.set(card.cardIndex, card);
        return [...cards.values()].map(card => ({ ...card, fields: card.fields.map(field => ({ ...field,
            nativeLongWidth: field.nativeLongWidth ?? Math.max(20, field.width) })) }));
    }
    const contact = nativeContactOptionalBinding(rule, keyword, rule.nativeAuxiliaryReferenceFields);
    if (contact) return nativeContactOptionalCards(rule, contact);
    if (nativeFileLayoutKind(rule, keyword) === 'ale-trim-records') return rule.cards.map(card => ({ ...card,
        fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })) }));
    if (['controlled-reference-records', 'ale-motion-single', 'em-connection-records'].includes(nativeFileLayoutKind(rule, keyword))) return (
        keyword.replace(/^\*/, '') === 'CONSTRAINED_GENERALIZED_WELD_COMBINED' ? rule.cards.slice(1) :
            keyword.replace(/^\*/, '') === 'AIRBAG_CPG' ? rule.cards.slice(0, 8) :
            /^DATABASE_CROSS_SECTION_SET(?:_ID)?$/.test(keyword.replace(/^\*/, '')) ? rule.cards.slice(0, 2) :
            ddamReaders[keyword.replace(/^\*/, '')] ? rule.cards.slice(0, ddamReaders[keyword.replace(/^\*/, '')][2] + 4) : rule.cards)
        .map((card, index) => ({ ...card, cardIndex: index + 1,
        fields: card.fields.map((field, fieldIndex) => ({ ...field, nativeLongWidth: Math.max(20, field.width),
            ...(keyword.replace(/^\*/, '') === 'DEFINE_FIBERS' ? {
                nativeReadGeometry: { long: { position: fieldIndex * 20, width: 20 },
                    i10: { position: field.position, width: field.width } } } : {}) })) }));
    if (nativeFileLayoutKind(rule, keyword) === 'verified-source-records')
        return rule.recordSelection?.cards || rule.cards;
    const repeated = nativeReferenceTailBinding(keyword);
    if (repeated && nativeFileLayoutKind(rule, keyword) === 'reference-tail')
        return rule.cards.slice(0, repeated.fieldCounts.length).map((card, index) => ({ ...card,
            fields: card.fields.slice(0, repeated.fieldCounts[index])
                .map((field, fieldIndex) => ({ ...field, nativeLongWidth: Math.max(20, field.width),
                    nativeReadGeometry: { long: { position: fieldIndex * 20, width: 20 },
                        i10: keyword.replace(/^\*/, '').startsWith('AIRBAG_REFERENCE_GEOMETRY_')
                            ? { position: card.fields.slice(0, fieldIndex).reduce((sum, previous) => sum +
                                (Number(previous.type) === 1 ? Math.max(10, previous.width) : previous.width), 0),
                                width: Number(field.type) === 1 ? Math.max(10, field.width) : field.width }
                            : { position: field.position, width: field.width } } })) }));
    const solid = solidFixedReaders[keyword.replace(/^\*/, '')];
    if (solid && nativeFileLayoutKind(rule, keyword) === 'element-solid-records')
        return solid[2].map(([address, count], index) => {
            const card = rule.cards.find(card => card.cardRecordId === address);
            return { ...card, cardIndex: index + 1, fields: card.fields.slice(0, count)
                .map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })) };
        });
    const references = referenceFileReaders[keyword.replace(/^\*/, '')];
    if (references && nativeFileLayoutKind(rule, keyword) !== 'unsupported-source')
        return rule.cards.slice(references[4] || 0, (references[4] || 0) + references[2]).map((card, cardIndex) => ({ ...card, cardIndex: cardIndex + 1,
            fields: card.fields.map((field, index) => ({ ...field,
                ...(Number(field.type) !== 3 ? { nativeLongWidth: Math.max(20, field.width) } : {}),
                ...(['DEFINE_CONTROL_VOLUME_FLOW_AREA', 'PART_MOVE_N2N'].includes(keyword.replace(/^\*/, ''))
                    ? { nativeReadGeometry: { long: { position: index * 20, width: 20 },
                    i10: keyword.replace(/^\*/, '') === 'PART_MOVE_N2N'
                        ? { position: index * 10, width: 10 }
                        : { position: field.position, width: field.width } } } : {}),
                ...(keyword.replace(/^\*/, '') === 'PART_MOVE_N2N' ? { serializationWidth: field.width } : {}),
                ...(['DEFINE_CPM_BAG_INTERACTION', 'EM_EP_TENTUSSCHER_STIMULUS2'].includes(keyword.replace(/^\*/, '').replace(/_TITLE$/, ''))
                    ? { nativeReadGeometry: { standard: { position: field.position, width: field.width },
                        i10: { position: field.position, width: field.width }, long: { position: index * 20, width: 20 } } } : {}) })) }));
    if (nativeFileLayoutKind(rule, keyword) === 'user-material-records') return rule.cards.map(card => ({ ...card,
        fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })) }));
    const nurbs = nurbsContactReaders[keyword.replace(/^\*/, '')];
    if (nurbs && nativeFileLayoutKind(rule, keyword) === 'reference-fixed') {
        const card = rule.cards.find(card => card.cardRecordId === nurbs[2]);
        return [{ ...card, cardIndex: 1, fields: card.fields.slice(0, 5)
            .map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })) }];
    }
    if (databaseMaxReaders[keyword.replace(/^\*/, '')] && nativeFileLayoutKind(rule, keyword) === 'generic-fixed')
        return rule.cards.slice(0, 1).map(card => ({ ...card,
            fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })) }));
    if (nativeFileLayoutKind(rule, keyword) === 'set-list-tail') return rule.cards.slice(0, 2).map(card => ({
        ...card, fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })),
    }));
    if (nativeFileLayoutKind(rule, keyword)?.startsWith('set-general-')) return rule.cards.map(card => ({
        ...card, fields: card.fields.map(field => ({ ...field, nativeLongWidth: Math.max(20, field.width) })),
    }));
    if (spellingFileCards.has(keyword)) return spellingFileCards.get(keyword);
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
export const NATIVE_FILE_SOURCE = "a88ab2e74e93a959971f487c72fa62bec157a3c762c37718e5571738a3ce50b5";

// ten source bytes, before the ordinary fixed/comma/LONG field decoder.
// The live file directory subkinds differ from the GUI directory subkinds.
// Verified against 1840 read records, including COLLECT, TITLE and all four formats:
// .artifacts/reports/entity-reference-closure-20261007/set-general-native.
const generalSetReaders = {
    SET_BEAM_GENERAL: ["record:6c17c0d6f0b0f85398b38555:8fc16237051f0fa6c9703f55", 6, 'element'],
    SET_DISCRETE_GENERAL: ["record:6c17c0d6f0b0f85398b38555:2dcaa1158147ce696be7d7ef", 6, 'element'],
    SET_NODE_GENERAL: ["record:6c17c0d6f0b0f85398b38555:586a6d55475ff6d105a9dcae", 10, 'node'],
    SET_PART_GENERAL: ["record:6c17c0d6f0b0f85398b38555:a12e83b1cca9640fe34abd3a", 4, 'part'],
    SET_SEGMENT_GENERAL: ["record:6c17c0d6f0b0f85398b38555:1fe4a3fb90a1128638b5b93e", 10, 'segment'],
    SET_SHELL_GENERAL: ["record:6c17c0d6f0b0f85398b38555:533dd79a671fd8c728fcbd87", 8, 'surface'],
    SET_SOLID_GENERAL: ["record:6c17c0d6f0b0f85398b38555:6ebdef15378c39092741d1af", 8, 'surface'],
    SET_TSHELL_GENERAL: ["record:6c17c0d6f0b0f85398b38555:89f0ab7790e3a2f433b989ad", 6, 'element'],
};
const generalSetCards: Record<string, Record<string, number>> = {
    element: { elem: 3, delem: 3, box: 4, dbox: 4, part: 5, dpart: 5, set: 6, dset: 6 },
    part: { part: 3, dpart: 3, set: 4, dset: 4 },
    node: { part: 5, dpart: 5, node: 6, dnode: 6, box: 7, dbox: 7,
        vol: 8, dvol: 8, set_shell: 9, set_solid: 10 },
    surface: { salecpt: 3, salefac: 4, elem: 5, delem: 5, box: 6, dbox: 6,
        part: 7, dpart: 7, set: 8, dset: 8 },
    segment: { salecpt: 3, salefac: 4, part: 5, dpart: 5, part_io: 5, psldfi: 5,
        box: 6, dbox: 6, vol: 7, dvol: 7, set_shell: 8, set_solid: 9, set_tshell: 10 },
};
// Exact trimmed file pools verified by 336 read/save/reopen cases. The GUI
// capture includes the following registrations; the file reader uses two cards.
const listSetReaders = {
    SET_IGA_EDGE_UVW: ["record:6c17c0d6f0b0f85398b38555:bcf979cf1621700cdbaef6a2", 32],
    SET_IGA_EDGE_UVW_LIST: ["record:6c17c0d6f0b0f85398b38555:24a57d34662f4d0a83895760", 30],
    SET_IGA_EDGE_UVW_LIST_GENERATE: ["record:6c17c0d6f0b0f85398b38555:ed2b07723c53f0b87ac2d98d", 28],
    SET_IGA_EDGE_UVW_LIST_GENERATE_INCREMENT: ["record:6c17c0d6f0b0f85398b38555:9c21b4d22097b488de0830d5", 26],
    SET_IGA_EDGE_XYZ: ["record:6c17c0d6f0b0f85398b38555:69e7dc8f10eecef742705e73", 24],
    SET_IGA_EDGE_XYZ_LIST: ["record:6c17c0d6f0b0f85398b38555:07dd41f5be5315d03348925f", 22],
    SET_IGA_EDGE_XYZ_LIST_GENERATE: ["record:6c17c0d6f0b0f85398b38555:96606e5880f26717e2a6461f", 20],
    SET_IGA_EDGE_XYZ_LIST_GENERATE_INCREMENT: ["record:6c17c0d6f0b0f85398b38555:68118069a01168d74a615c29", 18],
    SET_IGA_EDGE_UVW_COLLECT: ["record:6c17c0d6f0b0f85398b38555:817ba087f63d45b96626a8ff", 16],
    SET_IGA_EDGE_UVW_LIST_COLLECT: ["record:6c17c0d6f0b0f85398b38555:9531a825ffb1fcd2ea3c3998", 14],
    SET_IGA_EDGE_UVW_LIST_GENERATE_COLLECT: ["record:6c17c0d6f0b0f85398b38555:a5fe51fd7d0d0fe4fb461f95", 12],
    SET_IGA_EDGE_UVW_LIST_GENERATE_INCREMENT_COLLECT: ["record:6c17c0d6f0b0f85398b38555:dcce3babea802a604410cd06", 10],
    SET_IGA_EDGE_XYZ_COLLECT: ["record:6c17c0d6f0b0f85398b38555:7184479a5fab09f908760a9b", 8],
    SET_IGA_EDGE_XYZ_LIST_COLLECT: ["record:6c17c0d6f0b0f85398b38555:c3ce7b70c89014864c9ecf5f", 6],
    SET_IGA_EDGE_XYZ_LIST_GENERATE_COLLECT: ["record:6c17c0d6f0b0f85398b38555:b9867adad36d978ea9420e9e", 4],
    SET_IGA_EDGE_XYZ_LIST_GENERATE_INCREMENT_COLLECT: ["record:6c17c0d6f0b0f85398b38555:7d74998ed9555b1a464501ad", 2],
    SET_IGA_FACE_UVW: ["record:6c17c0d6f0b0f85398b38555:225fe61427e92e14380d1c24", 32],
    SET_IGA_FACE_UVW_LIST: ["record:6c17c0d6f0b0f85398b38555:47247d0e1b3b90feedb2fc0c", 30],
    SET_IGA_FACE_UVW_LIST_GENERATE: ["record:6c17c0d6f0b0f85398b38555:40e3421ca1cb7e53e5199d4a", 28],
    SET_IGA_FACE_UVW_LIST_GENERATE_INCREMENT: ["record:6c17c0d6f0b0f85398b38555:2724acca93b3c292b97a2060", 26],
    SET_IGA_FACE_XYZ: ["record:6c17c0d6f0b0f85398b38555:05b470173f66ad23860245f4", 24],
    SET_IGA_FACE_XYZ_LIST: ["record:6c17c0d6f0b0f85398b38555:7028c14135c9dd9aa54c52b3", 22],
    SET_IGA_FACE_XYZ_LIST_GENERATE: ["record:6c17c0d6f0b0f85398b38555:bec63ec01129b4b1f6a6492f", 20],
    SET_IGA_FACE_XYZ_LIST_GENERATE_INCREMENT: ["record:6c17c0d6f0b0f85398b38555:9bcd222a95c9baab6fb3d6d5", 18],
    SET_IGA_FACE_UVW_COLLECT: ["record:6c17c0d6f0b0f85398b38555:b0636e307e91f5a991d4c573", 16],
    SET_IGA_FACE_UVW_LIST_COLLECT: ["record:6c17c0d6f0b0f85398b38555:d0ae7a5c92db253016597532", 14],
    SET_IGA_FACE_UVW_LIST_GENERATE_COLLECT: ["record:6c17c0d6f0b0f85398b38555:5d0c5ef714ec54d8fbdae40a", 12],
    SET_IGA_FACE_UVW_LIST_GENERATE_INCREMENT_COLLECT: ["record:6c17c0d6f0b0f85398b38555:22d7754c2c30dc063738c7b6", 10],
    SET_IGA_FACE_XYZ_COLLECT: ["record:6c17c0d6f0b0f85398b38555:1d297d4deab8347fdf0a873b", 8],
    SET_IGA_FACE_XYZ_LIST_COLLECT: ["record:6c17c0d6f0b0f85398b38555:18b9e4c633881467fdd68a9f", 6],
    SET_IGA_FACE_XYZ_LIST_GENERATE_COLLECT: ["record:6c17c0d6f0b0f85398b38555:8559e94baec138877546f2fe", 4],
    SET_IGA_FACE_XYZ_LIST_GENERATE_INCREMENT_COLLECT: ["record:6c17c0d6f0b0f85398b38555:79a8ac034405cd6cdfe0c680", 2],
    SET_IGA_POINT_UVW: ["record:6c17c0d6f0b0f85398b38555:31c7c3efe02b135e0b9fc2bd", 16],
    SET_IGA_POINT_UVW_LIST: ["record:6c17c0d6f0b0f85398b38555:da26a0135230fed06dcf97cb", 14],
    SET_IGA_POINT_UVW_LIST_GENERATE: ["record:6c17c0d6f0b0f85398b38555:26e8f9c8158d86b6f2665eb4", 12],
    SET_IGA_POINT_UVW_LIST_GENERATE_INCREMENT: ["record:6c17c0d6f0b0f85398b38555:37ecb3fd6963eb3283672d3a", 10],
    SET_IGA_POINT_UVW_COLLECT: ["record:6c17c0d6f0b0f85398b38555:4ff0f43fb394b9f73bb000bf", 8],
    SET_IGA_POINT_UVW_LIST_COLLECT: ["record:6c17c0d6f0b0f85398b38555:a7c9f53c134c399f95d22005", 6],
    SET_IGA_POINT_UVW_LIST_GENERATE_COLLECT: ["record:6c17c0d6f0b0f85398b38555:25fc4778c94dd72ff6037bd7", 4],
    SET_IGA_POINT_UVW_LIST_GENERATE_INCREMENT_COLLECT: ["record:6c17c0d6f0b0f85398b38555:d646319c0e9a129b91005dfe", 2],
    SET_NODE_LIST_GENERATE_INCREMENT: ["record:6c17c0d6f0b0f85398b38555:7e0c6fd710014f48bcf6bdcb", 4],
    SET_NODE_LIST_GENERATE_INCREMENT_COLLECT: ["record:6c17c0d6f0b0f85398b38555:7e0c6fd710014f48bcf6bdcb", 4],
};
export function nativeSetListTailBinding(keyword: string): any {
    const binding = listSetReaders[keyword.replace(/^\*/, '').replace(/_TITLE$/, '')];
    return binding ? { cardSetId: binding[0], catalogCardCount: binding[1], cardCount: 2, kind: 'set-list-tail' } : undefined;
}
const databaseMaxReaders = {
    DATABASE_MAX_BEAM: ["record:3c11134d2da44eeb1b070a21:b605f09c8ab05f1ff2be1fbd", 3], DATABASE_MAX_BEAM_ID: ["record:3c11134d2da44eeb1b070a21:2015c6837eafcdaac6c38583", 2],
    DATABASE_MAX_SHELL: ["record:3c11134d2da44eeb1b070a21:3c58c786396015e217077db3", 3], DATABASE_MAX_SHELL_ID: ["record:3c11134d2da44eeb1b070a21:48f5b80fe33cfc0ac16e3a06", 2],
    DATABASE_MAX_SOLID: ["record:3c11134d2da44eeb1b070a21:69b416cd6221cfa7fbd251ef", 3], DATABASE_MAX_SOLID_ID: ["record:3c11134d2da44eeb1b070a21:c20216f185ec7ebd76153092", 2],
    DATABASE_MAX_TSHELL: ["record:3c11134d2da44eeb1b070a21:422d3606a7fe4cd51970bdde", 3], DATABASE_MAX_TSHELL_ID: ["record:3c11134d2da44eeb1b070a21:0ab4fa98a836b06791c01b60", 2],
};
const referenceFileReaders: Record<string, [string, number, number, string, number?]> = {
    
    // adjacent descriptor pools. These are single payloads, not entity loops.
    CONTACT_FORMING_NODES_TO_SURFACE: ["record:3c11134d2da44eeb1b070a21:0fc972719e1a362093a4be5d", 3, 3, 'reference-single'],
    CONTACT_FORMING_NODES_TO_SURFACE_SMOOTH: ["record:3c11134d2da44eeb1b070a21:0fc972719e1a362093a4be5d", 3, 3, 'reference-single'],
    CONTACT_RIGID_BODY_ONE_WAY_TO_RIGID_BODY: ["record:3c11134d2da44eeb1b070a21:7584142c6778f116767cb393", 15, 4, 'reference-single'],
    CONTACT_RIGID_BODY_TWO_WAY_TO_RIGID_BODY: ["record:3c11134d2da44eeb1b070a21:bb5954cc2f07d37fdab593b3", 11, 4, 'reference-single'],
    CONTACT_RIGID_NODES_TO_RIGID_BODY: ["record:3c11134d2da44eeb1b070a21:888efa26fc37041551eeb44d", 7, 4, 'reference-single'],
    CONTACT_SURFACE_TO_SURFACE_THERMAL_FRICTION: ["record:3c11134d2da44eeb1b070a21:0a048e5dc0bb0ffa07a5378b", 5, 5, 'reference-single'],
    // Actual dispatch read loops reuse the first pool for every record; the
    // remaining captured registrations are other GUI templates, not file cards.
    // Evidence: entity-reference-closure-20261007/isolated-source-* (four formats).
    DATABASE_FREQUENCY_ASCII_ELOUT_SSD_SUBCASE: ["record:40a8cc6df9c65f8a9f28a264:f1e39e9e2f701ce0f18f8866", 14, 1, 'reference-fixed'],
    DATABASE_FREQUENCY_ASCII_NODFOR_SSD_SUBCASE: ["record:40a8cc6df9c65f8a9f28a264:26310bbeccf3e27f071e8d63", 16, 1, 'reference-fixed'],
    DATABASE_FREQUENCY_ASCII_NODOUT_SSD_SUBCASE: ["record:40a8cc6df9c65f8a9f28a264:26310bbeccf3e27f071e8d63", 16, 1, 'reference-fixed'],
    USER_LOADING_SET: ["record:19cb4c055da4d2118799c066:c7c481563b441d251a6db55a", 1, 1, 'reference-fixed'],
    // Only the first header contains links. The variable payload contains
    // user constants/history values; it cannot repeat that header's references.
    USER_GET_HISTORY: ["record:19cb4c055da4d2118799c066:23b41471bd9332dfc9ace2d8", 2, 2, 'reference-single'],
    USER_NONLOCAL_SEARCH: ["record:19cb4c055da4d2118799c066:d380c06f55861d2b072da72d", 5, 2, 'reference-single'],
    // Live file registration has only two cards (RVA 0x82f47b0), although
    // the GUI pool also captures a rigid-ID card not read by this spelling.
    DEFINE_DEATH_TIMES_RIGID: ["record:ba104e05cf213ed9450678e6:5adc2de403dd6f0da6815fcc", 3, 2, 'reference-single'],
    // CONTACT2D reads two cards once; LOAD_NODE_SET repeats only its first.
    // Four-format actual calls and exact consumer loops: contact2d-load-native.
    CONTACT_2D_NODE_TO_SOLID: ["record:3c11134d2da44eeb1b070a21:e08c1d821fc2f53983ff20ba", 15, 2, 'reference-single'],
    CONTACT_2D_NODE_TO_SOLID_TIED: ["record:3c11134d2da44eeb1b070a21:ec89b11ffdc8c6d4d8bda548", 13, 2, 'reference-single'],
    LOAD_NODE_SET: ["record:d3b94f61ca9fd31bafc77be2:15ac251b8cdd74ebf985621a", 3, 1, 'reference-fixed'],
    // Exact original-file pools, including skipped GUI headers and sparse read windows.
    // next-owner-families-native-corrected: 48 numeric specimens, 504 checks.
    AIRBAG_FLUID_AND_GAS: ["record:40a8cc6df9c65f8a9f28a264:2a5c4d96e1cf1d9a46301da1", 3, 2, 'reference-fixed', 1],
    AIRBAG_FLUID_AND_GAS_ID: ["record:40a8cc6df9c65f8a9f28a264:b049f87d45babd4b08d5a440", 4, 4, 'reference-fixed'],
    EM_EP_TENTUSSCHER_STIMULUS2: ["record:0dc9b948cccc96167cba03df:b217fde9eb2662db54e35aec", 1, 1, 'reference-single'],
    DEFINE_CPM_BAG_INTERACTION: ["record:ba104e05cf213ed9450678e6:c4256cea031294a5940da856", 1, 1, 'reference-fixed'],
    DEFINE_CPM_BAG_INTERACTION_TITLE: ["record:ba104e05cf213ed9450678e6:c4256cea031294a5940da856", 1, 1, 'reference-fixed'],
    // Actual CESE mandatory3 reads, independent of the GUI/schema alias; ICFD mandatory1.
    CESE_BOUNDARY_PRESCRIBED_VN_MSURF: ["record:0dc9b948cccc96167cba03df:30eacde53a811cae642e55f4", 3, 3, 'reference-single'],
    CESE_BOUNDARY_PRESCRIBED_VN_MSURF_SET: ["record:0dc9b948cccc96167cba03df:b76fd706a9badb9bbf67bdf1", 3, 3, 'reference-single'],
    CESE_BOUNDARY_PRESCRIBED_VN_SEGMENT: ["record:0dc9b948cccc96167cba03df:7e956cb3d1ec57ee725a8aa7", 3, 3, 'reference-single'],
    CESE_BOUNDARY_PRESCRIBED_VN_SET: ["record:0dc9b948cccc96167cba03df:cbf0e33063a05421ad83bc6e", 3, 3, 'reference-single'],
    ICFD_IF_BOUNDARY_IMMERSED_DYNAMIC: ["record:139e927c39643113eb53026e:fc398d393b44b54144c29a31", 1, 1, 'reference-single'],
    // Actual registration counts trim shared pools; two complete instances and
    // four formats verified in shared-pool-boundaries-native-corrected.
    AIRBAG_SHELL_REFERENCE_GEOMETRY: ["record:be72f73ab914ef36120044a5:a872de0e53336fb5e120e80d", 6, 1, 'reference-fixed'],
    AIRBAG_SHELL_REFERENCE_GEOMETRY_RDT: ["record:be72f73ab914ef36120044a5:c7d782cc28f130f5f8f0e70b", 3, 1, 'reference-fixed'],
    MAT_SCC_ON_RCC: ["record:6a5b1cfb809915f7ecb2078b:37f88503ac6a0c9240089274", 6, 2, 'reference-fixed'],
    MAT_236: ["record:6a5b1cfb809915f7ecb2078b:37f88503ac6a0c9240089274", 6, 2, 'reference-fixed'],
    CONSTRAINED_INTERPOLATION: ["record:c327cd5c63b30cf2cfc02ae7:c69fb0b8e8d7a3f875098e49", 2, 2, 'interpolation-tail'],
    CONSTRAINED_INTERPOLATION_LOCAL: ["record:c327cd5c63b30cf2cfc02ae7:8eca8c3680a8cf025a3102bd", 3, 3, 'interpolation-local-tail'],
    DEFINE_CONTROL_VOLUME_FLOW_AREA: ["record:c327cd5c63b30cf2cfc02ae7:18784950ba52815587107c01", 1, 1, 'reference-fixed'],
    PART_MOVE_N2N: ["record:3c11134d2da44eeb1b070a21:d10cc5c8abe8cc39e041baab", 1, 1, 'reference-fixed'],
    EFV_COUPLING: ["record:0c4f22d5ce285124ad8877ea:200a8f221fde1c3bdd5baaae", 2, 2, 'reference-single'],
    EFV_COUPLING_EROSION: ["record:0c4f22d5ce285124ad8877ea:200a8f221fde1c3bdd5baaae", 2, 2, 'reference-single'],
    EFV_COUPLING_RIGID: ["record:0c4f22d5ce285124ad8877ea:200a8f221fde1c3bdd5baaae", 2, 2, 'reference-single'],
    IGA_VOLUME_XYZ: ["record:b5726ceb0e7380a0d894b59c:a1d795606b850b1cd3656693", 4, 2, 'reference-fixed'],
    IGA_VOLUME_XYZ_BASIS_TRANSFORM: ["record:b5726ceb0e7380a0d894b59c:c98a7959d7041fcf30db958a", 2, 2, 'reference-fixed'],
    LOAD_SEISMIC_SSI_DECONV: ["record:d3b94f61ca9fd31bafc77be2:258e054cc0acd227a4a94070", 5, 2, 'seismic-records'],
    LOAD_SEISMIC_SSI_DECONV_ID: ["record:d3b94f61ca9fd31bafc77be2:25487567c7ad2379a54a7d3f", 3, 3, 'seismic-prefix-records'],
    LOAD_SEISMIC_SSI_NODE: ["record:d3b94f61ca9fd31bafc77be2:3364553efe25328c28339c8f", 5, 2, 'seismic-records'],
    LOAD_SEISMIC_SSI_NODE_ID: ["record:d3b94f61ca9fd31bafc77be2:f1c405954e4f13ce8c84b795", 3, 3, 'seismic-prefix-records'],
    LOAD_SEISMIC_SSI_POINT: ["record:d3b94f61ca9fd31bafc77be2:e6ddf8ad53ccff1b645a1652", 5, 2, 'seismic-records'],
    LOAD_SEISMIC_SSI_POINT_ID: ["record:d3b94f61ca9fd31bafc77be2:7922791e4bdb9d0887c728d2", 3, 3, 'seismic-prefix-records'],
    LOAD_SEISMIC_SSI_SET: ["record:d3b94f61ca9fd31bafc77be2:2349a2d8c119c941218ae772", 5, 2, 'seismic-records'],
    LOAD_SEISMIC_SSI_SET_ID: ["record:d3b94f61ca9fd31bafc77be2:425143c61195c722b84a8c21", 3, 3, 'seismic-prefix-records'],
};
// The file reader repeats raw card 2; card 1 and later CONTACT descriptor pools
// belong to GUI templates, including fields for other contact spellings.
const nurbsContactReaders: Record<string, [string, number, string]> = {
    CONTACT_NURBS_TIED_EDGE_TO_EDGE: ["record:3c11134d2da44eeb1b070a21:4bf89da05224bb50ebc7c7a7", 5, "record:3c11134d2da44eeb1b070a21:e5dff238655bca998ead76fa"],
    CONTACT_NURBS_TIED_EDGE_TO_SURFACE: ["record:3c11134d2da44eeb1b070a21:fd306eed71cb77d4c9581459", 7, "record:3c11134d2da44eeb1b070a21:ec1374570ce845d51904fb70"],
    CONTACT_NURBS_TIED_NODES_TO_SURFACE: ["record:3c11134d2da44eeb1b070a21:a38cac6db3f940eb497393fc", 9, "record:3c11134d2da44eeb1b070a21:60ed47fef02087e6ff2f1939"],
};

// Actual numeric reads and repeat loops; shared GUI pools also contain other spellings.
const referenceTailReaders: Record<string, [string, number, number, number[]]> = {
    SET_SOLID_INTERSECT: ["record:6c17c0d6f0b0f85398b38555:02947e2a54130eed7a73e8a7", 2, 1, [1, 8]],
    AIRBAG_REFERENCE_GEOMETRY_BIRTH_RDT: ["record:be72f73ab914ef36120044a5:c41aa037129efd831fce1ef6", 9, 1, [1, 4]],
    AIRBAG_REFERENCE_GEOMETRY_RDT_BIRTH: ["record:be72f73ab914ef36120044a5:c41aa037129efd831fce1ef6", 9, 1, [1, 4]],
    CONSTRAINED_SOIL_PILE: ["record:c327cd5c63b30cf2cfc02ae7:ff81a1aca45baecce4e003d1", 13, 1, [8, 8, 8, 8, 8, 6]],
    CONSTRAINED_SOIL_PILE_SET: ["record:c327cd5c63b30cf2cfc02ae7:67b543c08f6d17f14cd996c5", 13, 1, [8, 8, 8, 8, 8, 6]],
    CONSTRAINED_SOIL_PILE_CONSTANTS: ["record:c327cd5c63b30cf2cfc02ae7:cd30415f65805f389c4c0e99", 7, 2, [8, 8, 8, 8, 8, 8, 6]],
    CONSTRAINED_SOIL_PILE_CONSTANTS_SET: ["record:c327cd5c63b30cf2cfc02ae7:7940fcb2d26105dd34b92542", 7, 2, [8, 8, 8, 8, 8, 8, 6]],
    CONSTRAINED_SOIL_PILE_CURVES: ["record:c327cd5c63b30cf2cfc02ae7:326223b7e74ba292b9d98f6a", 19, 2, [8, 8, 2, 4, 4, 8]],
    CONSTRAINED_SOIL_PILE_CURVES_SET: ["record:c327cd5c63b30cf2cfc02ae7:562427151ca6df7930e714cf", 6, 2, [8, 8, 2, 4, 4, 8]],
};
export function nativeReferenceTailBinding(keyword: string): any {
    const value = referenceTailReaders[keyword.replace(/^\*/, '')];
    return value && { cardSetId: value[0], catalogCardCount: value[1],
        headerCount: value[2], fieldCounts: value[3],
        hlcTail: keyword.replace(/^\*/, '').startsWith('CONSTRAINED_SOIL_PILE') &&
            !keyword.includes('_CURVES') };
}
/** The SOIL reader omits its last body card when the already read HLC is zero.
 * One state per block lets ordinary and disk-stream readers share this boundary. */
export function nativeSoilPileRecordReader(keyword: string, cards: Map<number, any>,
    input: 'standard' | 'i10' | 'long', resolve = (raw: string, _line: number) => raw) {
    const binding = nativeReferenceTailBinding(keyword);
    if (!binding?.hlcTail) return null;
    const header = binding.headerCount, last = binding.fieldCounts.length;
    let ordinal = 0, next = 1, instanceStart = 0, failed = false;
    return {
        next(text: string, line = ordinal): (NativeFileRecord & { tail: boolean; instanceComplete: boolean }) | null {
            if (failed) return null;
            const cardIndex = next;
            const tail = cardIndex > header;
            if (cardIndex === header + 1) instanceStart = ordinal;
            let instanceComplete = cardIndex === last;
            if (cardIndex === last - 1) {
                const fields = cards.get(cardIndex)?.fields;
                if (!fields || fields[7]?.name !== 'HLC') { failed = true; return null; }
                const raw = resolve(readRecordField(text, fields, 7, text.includes(',') ? 'comma' : input), line).trim();
                const value = raw ? Number(raw) : 0;
                if (raw && !/^[+-]?\d+$/.test(raw) || !Number.isInteger(value) ||
                    value < -2147483648 || value > 2147483647) { failed = true; return null; }
                instanceComplete = value === 0;
            }
            next = instanceComplete ? header + 1 : next + 1;
            ordinal++;
            return { cardIndex, instanceStart: tail ? instanceStart : 0, tail, instanceComplete,
                key: `instance:${tail ? instanceStart : 0}:record:${ordinal - 1}` };
        },
        complete: () => !failed && ordinal >= header && next === header + 1,
    };
}
export function nativeReferenceFileBinding(keyword: string): any {
    const component = nativeInterfaceComponentBinding(keyword);
    if (component) return { cardSetId: component.cardSetId, kind: component.kind, slot: 37 };
    const name = nativeSpellingBinding(keyword)?.originalContactPrefix
        ? nativeSpellingBinding(keyword).baseKeyword : keyword.replace(/^\*/, '');
    const value = referenceFileReaders[name];
    const spot = spotWeldReaders[name];
    if (name === 'CONTACT_DRAWBEAD' || name.startsWith('CONTACT_') && value)
        return { cardSetId: name === 'CONTACT_DRAWBEAD' ? "record:3c11134d2da44eeb1b070a21:8bd8b687fb2e4b5245cc7e6e" : value[0],
            kind: name === 'CONTACT_DRAWBEAD' ? 'controlled-reference-records' : value[3], slot: 13 };
    if (name === 'CONTACT_AUTOMATIC_SURFACE_TO_SURFACE') return {
        cardSetId: "record:3c11134d2da44eeb1b070a21:d11d728b0f62be09ab31f4b8", kind: 'contact-optional-records', slot: 13 };
    if (/^DEFINE_TRANSFORM(?:ATION)?$/.test(name)) return {
        cardSetId: "record:ba104e05cf213ed9450678e6:8e58f407893e5ca5b51d848b", kind: 'controlled-reference-records', slot: 18 };
    if (/^DATABASE_CROSS_SECTION_(?:PLANE|SET)(?:_ID)?$/.test(name)) return {
        cardSetId: name.includes('_PLANE') ? "record:40a8cc6df9c65f8a9f28a264:52b72319f97dbb282dca8d89" : "record:40a8cc6df9c65f8a9f28a264:632041012319dd8c16f8c71a",
        kind: 'controlled-reference-records', slot: 17 };
    if (name === 'LOAD_BLAST_ENHANCED') return {
        cardSetId: "record:d3b94f61ca9fd31bafc77be2:4f25866aa4db336a50917601", kind: 'controlled-reference-records', slot: 40 };
    if (name === 'INITIAL_VOLUME_FRACTION_GEOMETRY') return {
        cardSetId: "record:d3b94f61ca9fd31bafc77be2:2e0d6b235c6d601730a9f851", kind: 'controlled-reference-records', slot: 35 };
    if (name === 'MAT_ADD_INELASTICITY') return {
        cardSetId: "record:046033df36da543cb96fa4bf:5d8b5200fede7d3080b6393a", kind: 'controlled-reference-records', slot: 42 };
    if (/^AIRBAG_CPG(?:_ID)?$/.test(name)) return {
        cardSetId: name.endsWith('_ID') ? "record:40a8cc6df9c65f8a9f28a264:7a99e6e136f91b1d8f44cf70" : "record:40a8cc6df9c65f8a9f28a264:a6d52096599abe1eb9887f68",
        kind: 'controlled-reference-records', slot: 1 };
    if (name === 'EM_ISOPOTENTIAL_CONNECT') return {
        cardSetId: "record:0dc9b948cccc96167cba03df:22f8e4fa471a70245cb8e644", kind: 'em-connection-records', slot: 25 };
    return value ? { cardSetId: value[0], kind: value[3] } : spot
        ? { cardSetId: spot, kind: 'controlled-reference-records', slot: 42 } : undefined;
}


export function nativeAleTrimRecordReader() {
    const choices = ['PARTSET', 'SEGSET', 'PLANE', 'CYLINDER', 'BOXCOR', 'BOXCPT', 'SPHERE'];
    let ordinal = 0, previous = 1, failed = false;
    return {
        next(text: string): NativeFileRecord | null {
            const start = ordinal++;
            const raw = (text.includes(',') ? text.split(',')[1] || '' : text.slice(10, 20)).trim().toUpperCase();
            const selected = raw ? choices.indexOf(raw) + 1 : previous;
            if (selected === 0) { failed = true; return null; }
            previous = selected;
            return { cardIndex: selected, instanceStart: start, key: `instance:${start}:record:${start}` };
        },
        complete: () => !failed && ordinal > 0,
    };
}

export function nativeAleMotionRecordReader() {
    let ordinal = 0;
    return {
        next(text: string): NativeFileRecord & { instanceComplete: boolean } {
            const start = ordinal++;
            return { cardIndex: start ? 0 : !text.includes('FOLLOW_GC') && text.includes('COVER_LAG') ? 2 : 1,
                instanceStart: 0, instanceComplete: true, key: `instance:0:record:${start}` };
        },
        complete: () => ordinal > 0,
    };
}
const spotWeldReaders: Record<string, string> = {
    MAT_100_DAMAGE: "record:1067e13c3018d031daf7fd64:0e644abf8ddb2f87cf6e4c4a",
    MAT_SPOTWELD_DAMAGE_FAILURE: "record:1067e13c3018d031daf7fd64:0e644abf8ddb2f87cf6e4c4a",
    'MAT_SPOTWELD_DAMAGE-FAILURE': "record:1067e13c3018d031daf7fd64:0e644abf8ddb2f87cf6e4c4a",
    'MAT_SPOTWELD_DAMAGE-FAILURE_UNIAXIAL': "record:1067e13c3018d031daf7fd64:0e644abf8ddb2f87cf6e4c4a",
};
const ddamReaders: Record<string, [string, number, number]> = {
    FREQUENCY_DOMAIN_RESPONSE_SPECTRUM_DDAM: ["record:b5726ceb0e7380a0d894b59c:c430016f4e8ad367fd243dcd", 17, 6],
    FREQUENCY_DOMAIN_RESPONSE_SPECTRUM_DDAM_MISSING_MASS_CORRECTION: ["record:b5726ceb0e7380a0d894b59c:f7e9e59588a908d530a23e31", 11, 7],
};
const controlledReferenceReaders: Record<string, [string, number]> = {
    CONTACT_DRAWBEAD: ["record:3c11134d2da44eeb1b070a21:8bd8b687fb2e4b5245cc7e6e", 5],
    ...Object.fromEntries(Object.entries(spotWeldReaders).map(([keyword, array]) => [keyword, [array, 12] as [string, number]])),
    ...Object.fromEntries(Object.entries(ddamReaders).map(([keyword, [array,count]]) => [keyword, [array,count] as [string, number]])),
    ICFD_MODEL_SPECIES_TRANSPORT: ["record:139e927c39643113eb53026e:9141331a869943a309d369be", 4],
    ALE_REFERENCE_SYSTEM_GROUP: ["record:d69bdde291095487ba49c3be:329bedc406d3c9cd6bb2f552", 9],
    ALE_UP_SWITCH: ["record:d69bdde291095487ba49c3be:94a7c0f24483b0495f542658", 3],
    DEFINE_STOCHASTIC_VARIATION_PROPERTIES: ["record:1cd1189cbb8b718bfe96753f:c077c4c4d0bedf666ce752de", 3],
    CONSTRAINED_GENERALIZED_WELD_COMBINED: ["record:be72f73ab914ef36120044a5:931d01343aad543d19116033", 4],
    DEFINE_FIBERS: ["record:c327cd5c63b30cf2cfc02ae7:531eba0c1d5780251191c529", 3],
    MAT_HYSTERETIC_BEAM: ["record:c08cb8b30ceddad7e9bb8231:0ac55767e357583063e20f62", 11],
    MAT_209: ["record:c08cb8b30ceddad7e9bb8231:0ac55767e357583063e20f62", 11],
    ICFD_MODEL_POROUS: ["record:139e927c39643113eb53026e:53e402de41538f09813bbb85", 9],
    ICFD_BOUNDARY_WINDKESSEL: ["record:139e927c39643113eb53026e:ac1289809ebd79140cfe2583", 4],
    LOAD_BLAST_ENHANCED: ["record:d3b94f61ca9fd31bafc77be2:4f25866aa4db336a50917601", 4],
    DEFINE_TRANSFORM: ["record:ba104e05cf213ed9450678e6:8e58f407893e5ca5b51d848b", 5],
    DEFINE_TRANSFORMATION: ["record:ba104e05cf213ed9450678e6:8e58f407893e5ca5b51d848b", 5],
    DATABASE_CROSS_SECTION_PLANE: ["record:40a8cc6df9c65f8a9f28a264:52b72319f97dbb282dca8d89", 4],
    DATABASE_CROSS_SECTION_PLANE_ID: ["record:40a8cc6df9c65f8a9f28a264:52b72319f97dbb282dca8d89", 4],
    DATABASE_CROSS_SECTION_SET: ["record:40a8cc6df9c65f8a9f28a264:632041012319dd8c16f8c71a", 7],
    DATABASE_CROSS_SECTION_SET_ID: ["record:40a8cc6df9c65f8a9f28a264:632041012319dd8c16f8c71a", 7],
    INITIAL_VOLUME_FRACTION_GEOMETRY: ["record:d3b94f61ca9fd31bafc77be2:2e0d6b235c6d601730a9f851", 9],
    MAT_ADD_INELASTICITY: ["record:046033df36da543cb96fa4bf:5d8b5200fede7d3080b6393a", 12],
    AIRBAG_CPG: ["record:40a8cc6df9c65f8a9f28a264:a6d52096599abe1eb9887f68", 17],
    AIRBAG_CPG_ID: ["record:40a8cc6df9c65f8a9f28a264:7a99e6e136f91b1d8f44cf70", 9],
};
/** Bounded per-instance state from the actual file consumers. ICFD and ALE
 * GROUP: 100 four-format native specimens; UP_SWITCH: 8 native specimens.
 * GUI header variants share physical geometry but carry different links.
 */
export function nativeControlledReferenceRecordReader(keyword: string, cards: Map<number, any>,
    input: 'standard' | 'long' | 'i10', resolve = (raw: string, _line: number) => raw) {
    const original = nativeSpellingBinding(keyword);
    if (original?.originalContactPrefix) {
        // 40 original four-format reads: ID, MPP, exact body, then seven optional rows.
        // DRAWBEAD reuses its point descriptor NBEAD times before the optional table.
        const draw = original.baseKeyword === 'CONTACT_DRAWBEAD';
        const body = draw ? nativeControlledReferenceRecordReader(original.baseKeyword, cards, input, resolve) : null;
        let ordinal = 0, bodyCount = 0, optionalCount = 0;
        return { next(text: string, line = ordinal) {
            let record;
            if (ordinal < 2) record = { cardIndex: ordinal ? -1 : 0, instanceStart: 0 };
            else if (body ? !body.complete() : bodyCount < 4) {
                record = body ? body.next(text, line) : { cardIndex: ++bodyCount, instanceStart: 0 };
                if (!record) return null;
            // -2 has no descriptor here; 0 and -1 are the real CID/TITLE and MPP cards.
            } else record = { cardIndex: ++optionalCount <= 7 ? (draw ? 5 : 4) + optionalCount : -2, instanceStart: 0 };
            return { ...record, instanceComplete: true, key: `instance:0:record:${ordinal++}` };
        }, complete: () => ordinal >= 6 && (body ? body.complete() : bodyCount === 4) };
    }
    const name = keyword.replace(/^\*/, '');
    if (!controlledReferenceReaders[name]) return null;
    const transform = /^DEFINE_TRANSFORM(?:ATION)?$/.test(name);
    const crossSection = /^DATABASE_CROSS_SECTION_(?:PLANE|SET)(?:_ID)?$/.test(name);
    const cpg = /^AIRBAG_CPG(?:_ID)?$/.test(name), cpgHead = name.endsWith('_ID') ? 2 : 1;
    const head = crossSection && !name.endsWith('_ID') ? 2 : 1;
    let ordinal = 0, next = head, instanceStart = 0, failed = false;
    let firstControl = 0, secondControl = 0;
    let remainingLinks = 0, remainingLaws = 0;
    let cpgStage = 0, cpgRemaining = 0;
    let cpgCounts = [0, 0, 1, 0, 0];
    let deferred: NativeFileRecord & { instanceComplete: boolean };
    const control = (text: string, fieldIndex: number, line: number, cardIndex = 1) => {
        const fields = cards.get(cardIndex)?.fields;
        if (!fields?.[fieldIndex]) return null;
        const raw = resolve(readRecordField(text, fields, fieldIndex, text.includes(',') ? 'comma' : input), line).trim();
        const value = raw ? Number(raw) : Number(fields[fieldIndex].defaultValue ?? 0);
        if (raw && !/^[+-]?\d+$/.test(raw) || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) return null;
        const choices = (fields[fieldIndex].choices || []).map(Number);
        return choices.length && choices.every(Number.isFinite) && !choices.includes(value) ? choices[0] : value;
    };
    const realControl = (text: string, fieldIndex: number, line: number, cardIndex = 1) => {
        const fields = cards.get(cardIndex)?.fields;
        if (!fields?.[fieldIndex]) return null;
        const raw = resolve(readRecordField(text, fields, fieldIndex, text.includes(',') ? 'comma' : input), line).trim();
        const parsed = parseNumericInput(String(raw || fields[fieldIndex].defaultValue || 0).replace(/[dD]/g, 'e'), { integerOnly: false });
        return parsed?.kind === 'numeric' && Number.isFinite(Math.fround(parsed.value)) ? Math.fround(parsed.value) : null;
    };
    const nextInelasticLaw = () => --remainingLaws > 0 ? 5 : --remainingLinks > 0 ? 4 : 0;
    const nextCpgStage = () => {
        while (cpgStage < cpgCounts.length && cpgCounts[cpgStage] <= 0) cpgStage++;
        cpgRemaining = cpgCounts[cpgStage] || 0;
        return cpgStage < cpgCounts.length ? cpgHead + 3 + cpgStage : 1;
    };
    return {
        deferredReferences: Boolean(spotWeldReaders[name]),
        next(text: string, line = ordinal): (NativeFileRecord & { instanceComplete: boolean; tail?: boolean }) | null {
            if (failed) return null;
            if (next === 0) return { cardIndex: 0, instanceStart, instanceComplete: true,
                key: `instance:${instanceStart}:record:${ordinal++}` };
            let cardIndex = next;
            if (name === 'CONTACT_DRAWBEAD') {
                // Four mandatory rows, followed by NBEAD uses of descriptor 5.
                if (next < 4) next++;
                else if (next === 4) {
                    const count = control(text, 7, line, 4);
                    if (count === null) { failed = true; return null; }
                    remainingLinks = Math.max(0, count);
                    next = remainingLinks > 0 ? 5 : 0;
                } else if (--remainingLinks <= 0) next = 0;
                ordinal++;
                return { cardIndex, instanceStart: 0, instanceComplete: true,
                    key: `instance:0:record:${ordinal - 1}` };
            }
            if (cpg) {
                
                // NPDATA heat rows, NVENT vents, one air row, NGAS and NORIF.
                if (next === 1) { instanceStart = ordinal; cpgCounts = [0, 0, 1, 0, 0]; }
                if (next < cpgHead + 3) {
                    const controls = next === cpgHead ? [[0, 5]] : next === cpgHead + 1 ? [[1, 5]]
                        : next === cpgHead + 2 ? [[3, 1], [4, 2]] : [];
                    for (const [slot, field] of controls) {
                        const count = control(text, field, line, cardIndex);
                        if (count === null) { failed = true; return null; }
                        cpgCounts[slot] = count;
                    }
                    if (next === cpgHead + 2) { cpgStage = 0; next = nextCpgStage(); }
                    else next++;
                } else if (--cpgRemaining <= 0) { cpgStage++; next = nextCpgStage(); }
                ordinal++;
                return { cardIndex, instanceStart, instanceComplete: true,
                    key: `instance:${instanceStart}:record:${ordinal - 1}` };
            }
            if (name === 'INITIAL_VOLUME_FRACTION_GEOMETRY') {
                
                // CONTTYP 1..7 reads exactly one matching payload template.
                if (next === 1) next = 2;
                else if (next === 2) {
                    const type = control(text, 0, line, 2);
                    if (type === null) { failed = true; return null; }
                    next = type >= 1 && type <= 7 ? type + 2 : 2;
                } else next = 2;
                ordinal++;
                return { cardIndex, instanceStart: 0, instanceComplete: next === 2 && ordinal > 1,
                    key: `instance:0:record:${ordinal - 1}` };
            }
            if (name === 'MAT_ADD_INELASTICITY') {
                
                // link contains NIELAWS LAW/MODEL-selected payloads.
                if (next === 1) {
                    const links = control(text, 1, line), orientation = realControl(text, 5, line);
                    if (links === null || orientation === null) { failed = true; return null; }
                    remainingLinks = links; next = orientation > 0 ? 2 : links > 0 ? 4 : 0;
                } else if (next === 2) next = 3;
                else if (next === 3) next = remainingLinks > 0 ? 4 : 0;
                else if (next === 4) {
                    const laws = control(text, 0, line, 4);
                    if (laws === null) { failed = true; return null; }
                    remainingLaws = laws; next = laws > 0 ? 5 : --remainingLinks > 0 ? 4 : 0;
                } else if (next === 5) {
                    const law = control(text, 0, line, 5), model = control(text, 1, line, 5);
                    if (law === null || model === null) { failed = true; return null; }
                    next = law === 3 ? ({1: 6, 2: 7} as Record<number, number>)[model] || 0
                        : law === 5 ? model <= 2 ? 8 : model === 3 ? 9 : model === 4 ? 10 : 0
                        : model <= 3 ? 11 : model === 4 ? 9 : model === 5 ? 10 : 0;
                    if (!next) next = nextInelasticLaw();
                } else next = nextInelasticLaw();
                ordinal++;
                return { cardIndex, instanceStart: 0, instanceComplete: next === 0 || next === 4 || next === 5,
                    key: `instance:0:record:${ordinal - 1}` };
            }
            if (transform) {
                
                
                // place only for the exact uppercased ROTATE3NA token.
                if (next === 1) next = 2;
                else if (next === 2) {
                    const fields = cards.get(2)?.fields;
                    const option = fields && resolve(readRecordField(text, fields, 0,
                        text.includes(',') ? 'comma' : input), line).trim().toUpperCase();
                    if (option === undefined || /[&<>\x00-\x1f\x7f-\uffff]/.test(option)) { failed = true; return null; }
                    cardIndex = option === 'ROTATE3NA' ? 5 : 2;
                    next = option.includes('MATRIX') ? 3 : 2;
                } else next = next === 3 ? 4 : 2;
                ordinal++;
                return { cardIndex, instanceStart: 0, instanceComplete: next === 2 && ordinal > 1,
                    key: `instance:0:record:${ordinal - 1}` };
            }
            if (crossSection) {
                
                // Negative RADIUS reparses the plane row using the NID1/2
                // template without consuming another physical record.
                if (next === head) instanceStart = ordinal;
                if (next === 1) next = 2;
                else if (next === 2 && name.includes('_PLANE')) {
                    const radius = realControl(text, 7, line, 2);
                    if (radius === null) { failed = true; return null; }
                    cardIndex = radius < 0 ? 4 : 2; next = 3;
                } else next = head;
                ordinal++;
                return { cardIndex, instanceStart, instanceComplete: next === head,
                    key: `instance:${instanceStart}:record:${ordinal - 1}` };
            }
            if (name === 'LOAD_BLAST_ENHANCED') {
                
                // two mandatory records; unsupported values normalize to 2.
                if (next === 1) {
                    const blast = control(text, 7, line);
                    if (blast === null) { failed = true; return null; }
                    firstControl = blast; next = 2;
                } else next = next === 2 && [3,4].includes(firstControl) ? firstControl : 0;
                ordinal++;
                return { cardIndex, instanceStart: 0, instanceComplete: next === 0,
                    key: `instance:0:record:${ordinal - 1}` };
            }
            if (ddamReaders[name]) {
                
                // positive/negative tail and the MCOMB=-14 SID record.
                const end = ddamReaders[name][2];
                if (next === 1) {
                    const comb = control(text, 5, line), prs = control(text, 7, line);
                    if (comb === null || prs === null) { failed = true; return null; }
                    firstControl = comb; secondControl = prs;
                    next = comb === 99 ? 2 : prs === 2 ? 4 : 5;
                } else if (next === 2) next = 3;
                else if (next === 3) next = secondControl === 2 ? 4 : 5;
                else if (next === end) {
                    const std = control(text, 0, line, end);
                    if (std === null || ![1,-1].includes(std)) { failed = true; return null; }
                    next = end + (std > 0 ? 1 : 2);
                } else if (next < end) next++;
                else next = next === end + 2 ? end + 3 : next === end + 4 ? 0 : firstControl === -14 ? end + 4 : 0;
                ordinal++;
                return { cardIndex, instanceStart: 0, instanceComplete: next === 0,
                    key: `instance:0:record:${ordinal - 1}` };
            }
            if (spotWeldReaders[name]) {
                
                // then reparses row2 through its selected raw pool. The shared
                // record object lets bounded ordinary/disk batches see that selection.
                if (next === 1) { instanceStart = ordinal; next = 2; }
                else if (next === 2) {
                    if (text.trimEnd().length >= 128) { failed = true; return null; }
                    next = 9;
                    deferred = { cardIndex: 2, instanceStart, instanceComplete: false,
                        key: `instance:${instanceStart}:record:${ordinal++}` };
                    return deferred;
                } else if (next === 9) {
                    const fields = cards.get(9)?.fields;
                    const value = (index: number) => fields && resolve(readRecordField(text, fields, index,
                        text.includes(',') ? 'comma' : input), line).trim();
                    const rawOpt = value(1), rawDamage = value(7);
                    const choices = (fields?.[1]?.choices || []).map(Number);
                    const parsedOpt = rawOpt === undefined ? null : require('../references/referenceInputValue').parseNumericInput(
                        (rawOpt || fields?.[1]?.defaultValue || choices[0] || 0).toString().replace(/[dD]/g, 'e'), { integerOnly: false });
                    const opt = parsedOpt?.kind === 'numeric' ? Math.fround(parsedOpt.value) : NaN;
                    const damage = Number(rawDamage || 0);
                    if (!Number.isFinite(opt) || !choices.length || choices.some(choice => !Number.isFinite(choice)) ||
                        rawDamage === undefined || rawDamage && !/^[+-]?\d+$/.test(rawDamage) ||
                        !Number.isInteger(damage) || damage < -2147483648 || damage > 2147483647) { failed = true; return null; }
                    firstControl = Math.trunc(choices.includes(opt) ? opt : choices[0]);
                    deferred.cardIndex = (({'-9': 6, 1: 2, 2: 3, 3: 4, 4: 4, 5: 5, 6: 6, 7: 6, 9: 6,
                        10: 6, 11: 7, 12: 3, 22: 3} as Record<number, number>)[firstControl] || 1) + 1;
                    next = damage === -1 ? 10 : [12,22].includes(firstControl) ? 11 : 0;
                } else next = next === 10 ? [12,22].includes(firstControl) ? 11 : 0 : next === 11 ? 12 : 0;
                ordinal++;
                return { cardIndex, instanceStart, instanceComplete: next === 0,
                    key: `instance:${instanceStart}:record:${ordinal - 1}` };
            }
            if (name === 'ICFD_MODEL_POROUS' || name === 'ICFD_BOUNDARY_WINDKESSEL') {
                
                // reparses the Windkessel header in place before reading card2.
                if (next === 1) {
                    const type = control(text, 1, line);
                    if (type === null) { failed = true; return null; }
                    firstControl = type;
                    if (name === 'ICFD_MODEL_POROUS')
                        next = ({3: 3, 10: 3, 4: 4, 6: 4, 7: 4, 5: 5, 11: 6} as Record<number, number>)[type] || 2;
                    else { cardIndex = type === 1 || type === 2 ? 3 : type === 9 || type === 10 ? 4 : 1; next = 2; }
                } else if (name === 'ICFD_MODEL_POROUS')
                    next = next === 4 || next === 5 ? 7 : next === 7 ? firstControl === 4 || firstControl === 6 ? 8 : 9 : 0;
                else next = 0;
                ordinal++;
                return { cardIndex, instanceStart: 0, instanceComplete: next === 0,
                    key: `instance:0:record:${ordinal - 1}` };
            }
            if (name === 'MAT_HYSTERETIC_BEAM' || name === 'MAT_209') {
                
                // pool11 before the IFEMA+3 contiguous records from pool5.
                if (next === 1) {
                    const ifema = control(text, 7, line);
                    if (ifema === null || ifema < 0 || ifema > 3) { failed = true; return null; }
                    firstControl = ifema; next = 2;
                } else if (next === 4) {
                    const fields = cards.get(4)?.fields;
                    const raw = fields && resolve(readRecordField(text, fields, 4, text.includes(',') ? 'comma' : input), line).trim();
                    if (raw === undefined || raw && !/^[+-]?\d+$/.test(raw)) { failed = true; return null; }
                    const value = Number(raw || 0);
                    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) { failed = true; return null; }
                    secondControl = Number(value < 0); next = secondControl ? 11 : 5;
                } else if (next === 11 && secondControl) { secondControl = 0; next = 5; }
                else if (next > 0) next = next === firstControl + 7 ? 0 : next + 1;
                ordinal++;
                return { cardIndex, instanceStart: 0, instanceComplete: next === 0,
                    key: `instance:0:record:${ordinal - 1}` };
            }
            if (['DEFINE_FIBERS', 'CONSTRAINED_GENERALIZED_WELD_COMBINED', 'DEFINE_STOCHASTIC_VARIATION_PROPERTIES'].includes(name)) {
                if (name === 'CONSTRAINED_GENERALIZED_WELD_COMBINED' && next === 2) instanceStart = ordinal;
                if (next === 1) {
                    instanceStart = ordinal;
                    if (name !== 'DEFINE_STOCHASTIC_VARIATION_PROPERTIES') {
                        const first = control(text, name === 'DEFINE_FIBERS' ? 3 : 4, line);
                        const second = name === 'DEFINE_FIBERS' ? control(text, 4, line) : 0;
                        if (first === null || second === null) { failed = true; return null; }
                        firstControl = first; secondControl = second;
                    }
                    next = name === 'CONSTRAINED_GENERALIZED_WELD_COMBINED' && firstControl <= 0 ? 0 : 2;
                } else if (next === 2 && name === 'DEFINE_STOCHASTIC_VARIATION_PROPERTIES') {
                    
                    const raw = resolve(text.includes(',') ? text.split(',')[0] : text.slice(0, 10), line).trim();
                    if (raw && !/^[+-]?\d+$/.test(raw)) { failed = true; return null; }
                    const value = Number(raw || 0);
                    if (value < -2147483648 || value > 2147483647) { failed = true; return null; }
                    cardIndex = value >= 3 ? 3 : 2; next = 1;
                } else if (name === 'DEFINE_FIBERS') next = next === 2 && (firstControl <= 0 || secondControl <= 0) ? 3 : 0;
                else if (name === 'CONSTRAINED_GENERALIZED_WELD_COMBINED') next = next === 2 ? 3 : --firstControl > 0 ? 2 : 0;
                ordinal++;
                return { cardIndex, instanceStart, instanceComplete: next === 0 || next === 1 ||
                    name === 'CONSTRAINED_GENERALIZED_WELD_COMBINED' && cardIndex === 3,
                    ...(name === 'CONSTRAINED_GENERALIZED_WELD_COMBINED' ? { tail: cardIndex > 1 } : {}),
                    key: `instance:${instanceStart}:record:${ordinal - 1}` };
            }
            if (next === 1) {
                instanceStart = ordinal;
                const first = control(text, name === 'ALE_UP_SWITCH' ? 0 : 2, line);
                const second = name === 'ICFD_MODEL_SPECIES_TRANSPORT' ? control(text, 4, line) : 0;
                if (first === null || second === null) { failed = true; return null; }
                firstControl = first; secondControl = second;
                if (name === 'ALE_REFERENCE_SYSTEM_GROUP')
                    cardIndex = ({3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 9: 7} as Record<number, number>)[first] || 1;
                next = name === 'ALE_REFERENCE_SYSTEM_GROUP' ? 8 : 2;
            } else if (name === 'ICFD_MODEL_SPECIES_TRANSPORT') {
                next = next === 2 && firstControl === 2 ? 3 : next < 4 && secondControl === 1 ? 4 : 1;
            } else if (name === 'ALE_REFERENCE_SYSTEM_GROUP') next = next === 8 && firstControl === 9 ? 9 : 1;
            else next = next === 2 && firstControl === 0 ? 3 : 1;
            ordinal++;
            return { cardIndex, instanceStart, instanceComplete: next === 1,
                key: `instance:${instanceStart}:card:${cardIndex}` };
        },
        complete: () => !failed && ordinal > 0 && (cpg ? next === 1 : crossSection ? next === head : transform || name === 'INITIAL_VOLUME_FRACTION_GEOMETRY'
            ? next === 2 && ordinal > 1 : name === 'MAT_ADD_INELASTICITY' ? next === 0 : next === 1 || next === 0 ||
            name === 'ICFD_BOUNDARY_WINDKESSEL' && next === 2 && ![3, 4, 9, 10].includes(firstControl)),
    };
}
// Original registered SOLID readers: two instances per spelling, four input formats.
// Counts trim shared pools and the high-order two-field EID/PID header.
const solidFixedReaders: Record<string, [string, number, Array<[string, number]>]> = {
    ELEMENT_SOLID_ORTHO: ["record:833ab7287ce50c4404e8d545:d0b327ce1073a599676923b5",3,[["record:833ab7287ce50c4404e8d545:d0b327ce1073a599676923b5",10],["record:833ab7287ce50c4404e8d545:68b8c535facdf2ac2de51cb7",3],["record:833ab7287ce50c4404e8d545:d616dc243e8bc8941e595831",3]]],
    ELEMENT_SOLID_TET4TOTET10_FORMAT2: ["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",9,[["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",2],["record:833ab7287ce50c4404e8d545:44dc8a64eb3ac7dc1f2a59ec",10]]],
    ELEMENT_SOLID_TET4TOTET10: ["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",3,[["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",10]]],
    ELEMENT_SOLID: ["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",3,[["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",10]]],
    ELEMENT_SOLID_H20: ["record:833ab7287ce50c4404e8d545:8c934195221cf37becca351a",3,[["record:833ab7287ce50c4404e8d545:8c934195221cf37becca351a",2],["record:833ab7287ce50c4404e8d545:a93539608dc7c63c6e6635a0",10],["record:833ab7287ce50c4404e8d545:9bd8f6377a396b214d6a99d2",10]]],
    ELEMENT_SOLID_T15: ["record:833ab7287ce50c4404e8d545:9ef3e5e3bf0c87eb9c8fdb76",3,[["record:833ab7287ce50c4404e8d545:9ef3e5e3bf0c87eb9c8fdb76",2],["record:833ab7287ce50c4404e8d545:6118fc866f73ee5e171e5502",10],["record:833ab7287ce50c4404e8d545:5b4f7f8b9a726f034a0602f0",5]]],
    ELEMENT_SOLID_T20: ["record:833ab7287ce50c4404e8d545:b0d143522bae340b50de7efa",3,[["record:833ab7287ce50c4404e8d545:b0d143522bae340b50de7efa",2],["record:833ab7287ce50c4404e8d545:dc545af4cd01dae4c1a7aa56",10],["record:833ab7287ce50c4404e8d545:1e7a1eaade766aa835adfaea",10]]],
    ELEMENT_SOLID_P21: ["record:833ab7287ce50c4404e8d545:b38edad88c6156a59e885279",7,[["record:833ab7287ce50c4404e8d545:b38edad88c6156a59e885279",2],["record:833ab7287ce50c4404e8d545:d79d38b7efd39f2bc1580009",10],["record:833ab7287ce50c4404e8d545:7a02290e5db88fe394171d8d",10],["record:833ab7287ce50c4404e8d545:18dc75905b250985e76d1157",1]]],
    ELEMENT_SOLID_P40: ["record:833ab7287ce50c4404e8d545:2428fca62f2586b5f20b896b",5,[["record:833ab7287ce50c4404e8d545:2428fca62f2586b5f20b896b",2],["record:833ab7287ce50c4404e8d545:3f865c1b4cf15ca5ef396cd3",10],["record:833ab7287ce50c4404e8d545:56b1008e57d7f527fe511862",10],["record:833ab7287ce50c4404e8d545:845c1f157b515ca74251be01",10],["record:833ab7287ce50c4404e8d545:b813b98fd0f536f954706ee3",10]]],
    ELEMENT_SOLID_H64: ["record:833ab7287ce50c4404e8d545:6671f3417607ffac1abd8690",13,[["record:833ab7287ce50c4404e8d545:6671f3417607ffac1abd8690",2],["record:833ab7287ce50c4404e8d545:60c4663ef34211db44e7b259",10],["record:833ab7287ce50c4404e8d545:591138e1fb9c724e3c06c80c",10],["record:833ab7287ce50c4404e8d545:20c72fb761826a4e1bb26c9f",10],["record:833ab7287ce50c4404e8d545:7b2c597b74efcbeba13980d7",10],["record:833ab7287ce50c4404e8d545:51b80a89d44d12d8bde6eac9",10],["record:833ab7287ce50c4404e8d545:64c6481022d8745d5e14e6b3",10],["record:833ab7287ce50c4404e8d545:d2a35473c633d73ae9211cf7",4]]],
    ELEMENT_SOLID_H27_DOF: ["record:833ab7287ce50c4404e8d545:625cf65fd634a0304e05f1f0",5,[["record:833ab7287ce50c4404e8d545:625cf65fd634a0304e05f1f0",2],["record:833ab7287ce50c4404e8d545:175cbc35c8098c562f806dbd",10],["record:833ab7287ce50c4404e8d545:870b9b66b42a8b4b5f285f9e",10],["record:833ab7287ce50c4404e8d545:787cc873c91a3b7c6aff079b",7],["record:833ab7287ce50c4404e8d545:5ccee4829ad2b3ed17906adb",10]]],
    ELEMENT_SOLID_H27: ["record:833ab7287ce50c4404e8d545:9bb46cf1c8df7380d8909782",13,[["record:833ab7287ce50c4404e8d545:9bb46cf1c8df7380d8909782",2],["record:833ab7287ce50c4404e8d545:eed444d14b08c8b418b1a6db",10],["record:833ab7287ce50c4404e8d545:3a031e6138575f21325c46c8",10],["record:833ab7287ce50c4404e8d545:85e6bf57e3306012e87fd3d7",7]]],
    ELEMENT_SOLID_H20_DOF: ["record:833ab7287ce50c4404e8d545:61ea82ebdcb99e5ca5edfe59",9,[["record:833ab7287ce50c4404e8d545:61ea82ebdcb99e5ca5edfe59",2],["record:833ab7287ce50c4404e8d545:76a22246cf9276bbe61fdc34",10],["record:833ab7287ce50c4404e8d545:eac32912aba8ce4ae37ff6ee",10],["record:833ab7287ce50c4404e8d545:9a113dc6a5de3ff3b626ccc0",10]]],
    ELEMENT_SOLID_H8TOH64_FORMAT2: ["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",9,[["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",2],["record:833ab7287ce50c4404e8d545:44dc8a64eb3ac7dc1f2a59ec",10]]],
    ELEMENT_SOLID_P6TOP21_FORMAT2: ["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",9,[["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",2],["record:833ab7287ce50c4404e8d545:44dc8a64eb3ac7dc1f2a59ec",10]]],
    ELEMENT_SOLID_T4TOT15_FORMAT2: ["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",9,[["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",2],["record:833ab7287ce50c4404e8d545:44dc8a64eb3ac7dc1f2a59ec",10]]],
    ELEMENT_SOLID_T4TOT10_FORMAT2: ["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",9,[["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",2]]],
    ELEMENT_SOLID_H8TOH64: ["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",3,[["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",10]]],
    ELEMENT_SOLID_P6TOP21: ["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",3,[["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",10]]],
    ELEMENT_SOLID_T4TOT15: ["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",3,[["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",10]]],
    ELEMENT_SOLID_T4TOT10: ["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",3,[["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",10]]],
    ELEMENT_SOLID_H8TOH27_ORTHO_DOF: ["record:833ab7287ce50c4404e8d545:6d68219f9b557a4622d20f7b",4,[["record:833ab7287ce50c4404e8d545:6d68219f9b557a4622d20f7b",10],["record:833ab7287ce50c4404e8d545:6d4c39f2657c5271f6fe33ee",3],["record:833ab7287ce50c4404e8d545:ec2566ab5472e2f7cfaeffde",3],["record:833ab7287ce50c4404e8d545:0b9e0e33be7eb3ae2624744f",10]]],
    ELEMENT_SOLID_H8TOH27_ORTHO_FORMAT2: ["record:833ab7287ce50c4404e8d545:4b7fd447a08721a5c71f573d",7,[["record:833ab7287ce50c4404e8d545:4b7fd447a08721a5c71f573d",2],["record:833ab7287ce50c4404e8d545:47499fb771d64d14fd9f6d91",10],["record:833ab7287ce50c4404e8d545:86f9de9b763ce345cff61dd6",3],["record:833ab7287ce50c4404e8d545:63d91b119f819a1e7d702b73",3]]],
    ELEMENT_SOLID_H8TOH27_ORTHO: ["record:833ab7287ce50c4404e8d545:d0b327ce1073a599676923b5",3,[["record:833ab7287ce50c4404e8d545:d0b327ce1073a599676923b5",10],["record:833ab7287ce50c4404e8d545:68b8c535facdf2ac2de51cb7",3],["record:833ab7287ce50c4404e8d545:d616dc243e8bc8941e595831",3]]],
    ELEMENT_SOLID_H8TOH27_DOF: ["record:833ab7287ce50c4404e8d545:4eb5f5d8c823207edb202c9d",2,[["record:833ab7287ce50c4404e8d545:4eb5f5d8c823207edb202c9d",10]]],
    ELEMENT_SOLID_H8TOH27_FORMAT2: ["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",9,[["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",2],["record:833ab7287ce50c4404e8d545:44dc8a64eb3ac7dc1f2a59ec",10]]],
    ELEMENT_SOLID_H8TOH27: ["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",3,[["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",10]]],
    ELEMENT_SOLID_H8TOH20_ORTHO_DOF: ["record:833ab7287ce50c4404e8d545:6d68219f9b557a4622d20f7b",4,[["record:833ab7287ce50c4404e8d545:6d68219f9b557a4622d20f7b",10],["record:833ab7287ce50c4404e8d545:6d4c39f2657c5271f6fe33ee",3],["record:833ab7287ce50c4404e8d545:ec2566ab5472e2f7cfaeffde",3],["record:833ab7287ce50c4404e8d545:0b9e0e33be7eb3ae2624744f",10]]],
    ELEMENT_SOLID_H8TOH20_ORTHO_FORMAT2: ["record:833ab7287ce50c4404e8d545:4b7fd447a08721a5c71f573d",7,[["record:833ab7287ce50c4404e8d545:4b7fd447a08721a5c71f573d",2],["record:833ab7287ce50c4404e8d545:47499fb771d64d14fd9f6d91",10],["record:833ab7287ce50c4404e8d545:86f9de9b763ce345cff61dd6",3],["record:833ab7287ce50c4404e8d545:63d91b119f819a1e7d702b73",3]]],
    ELEMENT_SOLID_H8TOH20_ORTHO: ["record:833ab7287ce50c4404e8d545:d0b327ce1073a599676923b5",3,[["record:833ab7287ce50c4404e8d545:d0b327ce1073a599676923b5",10],["record:833ab7287ce50c4404e8d545:68b8c535facdf2ac2de51cb7",3],["record:833ab7287ce50c4404e8d545:d616dc243e8bc8941e595831",3]]],
    ELEMENT_SOLID_H8TOH20_DOF: ["record:833ab7287ce50c4404e8d545:4eb5f5d8c823207edb202c9d",2,[["record:833ab7287ce50c4404e8d545:4eb5f5d8c823207edb202c9d",10],["record:833ab7287ce50c4404e8d545:1c0ef30dad0a7164f8ca96b1",10]]],
    ELEMENT_SOLID_H8TOH20_FORMAT2: ["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",9,[["record:833ab7287ce50c4404e8d545:71488b85e55d8a9eede7510c",2],["record:833ab7287ce50c4404e8d545:44dc8a64eb3ac7dc1f2a59ec",10]]],
    ELEMENT_SOLID_H8TOH20: ["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",3,[["record:833ab7287ce50c4404e8d545:d7935601389709e6e9eecc03",10]]],
    ELEMENT_SOLID_ORTHO_DOF: ["record:833ab7287ce50c4404e8d545:6d68219f9b557a4622d20f7b",4,[["record:833ab7287ce50c4404e8d545:6d68219f9b557a4622d20f7b",10],["record:833ab7287ce50c4404e8d545:6d4c39f2657c5271f6fe33ee",3],["record:833ab7287ce50c4404e8d545:ec2566ab5472e2f7cfaeffde",3],["record:833ab7287ce50c4404e8d545:0b9e0e33be7eb3ae2624744f",10]]],
    ELEMENT_SOLID_TET4TOTET10_DOF_FORMAT2: ["record:833ab7287ce50c4404e8d545:17fa55c3c236fd7c4dbcaa24",3,[["record:833ab7287ce50c4404e8d545:17fa55c3c236fd7c4dbcaa24",2],["record:833ab7287ce50c4404e8d545:2a73b2de90656e0874ac1362",10],["record:833ab7287ce50c4404e8d545:8b9c1fa69c03e33cc9eaa2ec",10]]],
    ELEMENT_SOLID_TET4TOTET10_ORTHO_DOF: ["record:833ab7287ce50c4404e8d545:6d68219f9b557a4622d20f7b",4,[["record:833ab7287ce50c4404e8d545:6d68219f9b557a4622d20f7b",10],["record:833ab7287ce50c4404e8d545:6d4c39f2657c5271f6fe33ee",3],["record:833ab7287ce50c4404e8d545:ec2566ab5472e2f7cfaeffde",3],["record:833ab7287ce50c4404e8d545:0b9e0e33be7eb3ae2624744f",10]]],
    ELEMENT_SOLID_TET4TOTET10_ORTHO: ["record:833ab7287ce50c4404e8d545:d0b327ce1073a599676923b5",3,[["record:833ab7287ce50c4404e8d545:d0b327ce1073a599676923b5",10],["record:833ab7287ce50c4404e8d545:68b8c535facdf2ac2de51cb7",3],["record:833ab7287ce50c4404e8d545:d616dc243e8bc8941e595831",3]]],
    ELEMENT_SOLID_PERI: ["record:833ab7287ce50c4404e8d545:2d6eaa7d2ee7dd0485b0ac76",1,[["record:833ab7287ce50c4404e8d545:2d6eaa7d2ee7dd0485b0ac76",6]]],
    ELEMENT_SOLID_DOF: ["record:833ab7287ce50c4404e8d545:4eb5f5d8c823207edb202c9d",2,[["record:833ab7287ce50c4404e8d545:4eb5f5d8c823207edb202c9d",10],["record:833ab7287ce50c4404e8d545:1c0ef30dad0a7164f8ca96b1",10]]],
};
export function nativeSetGeneralBinding(keyword: string): any {
    const binding = generalSetReaders[keyword.replace(/^\*/, '').replace(/_TITLE$/, '').replace(/_COLLECT$/, '')];
    return binding ? { cardSetId: binding[0], cardCount: binding[1], kind: `set-general-${binding[2]}` } : undefined;
}
export function nativeSetGeneralRecordCard(kind: string, text: string): number | null {
    const cards = generalSetCards[kind.replace(/^set-general-/, '')];
    if (!cards) return null;
    const token = text.slice(0, 10).split('\0')[0].trim().toLowerCase();
    if (token.includes('&') || /[^\x20-\x7e]/.test(token)) return null;
    if (kind === 'set-general-node') {
        if (token.includes('salecpt')) return 3;
        if (token.includes('salefac')) return 4;
    }
    return cards[token] || 2;
}
export function hasNativeSectionFixedReader(keyword: string): boolean {
    return Object.prototype.hasOwnProperty.call(sectionFixed.bindings, keyword.replace(/_TITLE$/, ''));
}
export function nativeFileLayoutKind(rule: any, keyword: string): string | null {
    const component = nativeInterfaceComponentBinding(keyword);
    if (component) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === component.cardSetId && rule.cards?.length === 2 &&
        rule.cards[0]?.fields?.length === 2 && rule.cards[1]?.fields?.length === 3 &&
        rule.cards[0].cardRecordId === component.cardSetId &&
        rule.cards[1].cardRecordId === descriptorIdentityAt(component.cardSetId, 1) &&
        rule.cards[0].fields[0].fieldRecordId === "record:d69bdde291095487ba49c3be:a5899cfe0fab08a9dec01356" && rule.cards[0].fields[0].name === 'ID' &&
        rule.cards[0].fields[0].type === 1 && rule.cards[0].fields[0].position === 0 && rule.cards[0].fields[0].width === 10 &&
        rule.cards[0].fields[1].fieldRecordId === "record:d69bdde291095487ba49c3be:7a15c8d079e7137cbfe4efa0" && rule.cards[0].fields[1].name === 'Title' &&
        rule.cards[0].fields[1].position === 10 && rule.cards[0].fields[1].width === 70 &&
        rule.cards[1].fields.every((field, index) => field.fieldRecordId === component.payloadAddresses[index] &&
            field.name === [component.payloadName, 'CID', 'NID'][index] && field.type === 1 && field.position === index * 10 && field.width === 10)
        ? component.kind : 'unsupported-source';
    const original = nativeSpellingBinding(keyword);
    if (original?.originalContactPrefix) return contactMppTail.sourceSha256 === NATIVE_FILE_SOURCE &&
        rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE && rule.cardSetId === original.cardSetId &&
        ['controlled-reference-records', 'reference-single'].includes(nativeFileLayoutKind(rule, original.baseKeyword))
        ? 'controlled-reference-records' : 'unsupported-source';
    if (rule?.contactComposition) return null;
    const spelling = nativeSpellingBinding(keyword);
    const spellingName = nativeSpellingName(keyword);
    if (spelling) return (contactIdMppFixed.bindings[spellingName] ||
        contactMppTail.bindings[spellingName]
        ? (contactIdMppFixed.bindings[spellingName]
            ? contactIdMppFixed.sourceSha256 : contactMppTail.sourceSha256) === NATIVE_FILE_SOURCE &&
            rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
            rule?.cardSetId === spelling.cardSetId
        : spellingReaders.sourceSha256 === NATIVE_FILE_SOURCE) &&
        !nativeSpellingBinding(spelling.baseKeyword)
        ? spelling.layout ? 'conditional-sequence' : nativeFileLayoutKind(rule, spelling.baseKeyword) : 'unsupported-source';
    if (nativeContactOptionalBinding(rule, keyword, rule?.nativeAuxiliaryReferenceFields)) return 'contact-optional-records';
    if (keyword.replace(/^\*/, '') === 'EM_ISOPOTENTIAL_CONNECT') return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === "record:0dc9b948cccc96167cba03df:22f8e4fa471a70245cb8e644" && rule.cards?.length === 3
            ? 'em-connection-records' : 'unsupported-source';
    if (nativeSpellingGap(keyword)) return 'unsupported-source';
    if (keyword.replace(/^\*/, '') === 'ALE_STRUCTURED_MESH_MOTION')
        return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
            rule.cardSetId === "record:d69bdde291095487ba49c3be:adae043b59bf113dab1fba7e" && rule.cards?.length === 2
            ? 'ale-motion-single' : 'unsupported-source';
    if (keyword.replace(/^\*/, '') === 'ALE_STRUCTURED_MESH_TRIM')
        return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
            rule.cardSetId === "record:d69bdde291095487ba49c3be:92ef2e04f13fd72162c98400" && rule.cards?.length === 7
            ? 'ale-trim-records' : 'unsupported-source';
    const controlled = controlledReferenceReaders[keyword.replace(/^\*/, '')];
    if (controlled) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === controlled[0] && rule.cards?.length === controlled[1]
        ? 'controlled-reference-records' : 'unsupported-source';
    const nurbs = nurbsContactReaders[keyword.replace(/^\*/, '')];
    if (nurbs) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === nurbs[0] && rule.cards?.length === nurbs[1] &&
        rule.cards.some(card => card.cardRecordId === nurbs[2] && card.fields.length === 5)
        ? 'reference-fixed' : 'unsupported-source';
    if (['MAT_USER_DEFINED_MATERIAL_MODELS', 'MAT_041_050'].includes(keyword.replace(/^\*/, '')))
        return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
            rule.cardSetId === "record:1067e13c3018d031daf7fd64:fa428bffdd524609a4ba9ebb" && rule.cards?.length === 11
            ? 'user-material-records' : 'unsupported-source';
    const repeated = nativeReferenceTailBinding(keyword);
    if (repeated) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === repeated.cardSetId && rule.cards?.length === repeated.catalogCardCount
        ? 'reference-tail' : 'unsupported-source';
    const solid = solidFixedReaders[keyword.replace(/^\*/, '')];
    if (solid) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === solid[0] && rule.cards?.length === solid[1]
        ? 'element-solid-records' : 'unsupported-source';
    const reference = referenceFileReaders[keyword.replace(/^\*/, '')];
    if (reference) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === reference[0] && rule.cards?.length === reference[1]
        ? reference[3] : 'unsupported-source';
    const databaseMax = databaseMaxReaders[keyword.replace(/^\*/, '')];
    if (databaseMax) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === databaseMax[0] && rule.cards?.length === databaseMax[1]
        ? 'generic-fixed' : 'unsupported-source';
    const listTail = nativeSetListTailBinding(keyword);
    if (listTail) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === listTail.cardSetId && rule.cards?.length === listTail.catalogCardCount
        ? listTail.kind : 'unsupported-source';
    const general = nativeSetGeneralBinding(keyword);
    if (general) return rule?.catalogSource?.datasetSha256 === NATIVE_FILE_SOURCE &&
        rule.cardSetId === general.cardSetId && rule.cards?.length === general.cardCount
        ? general.kind : 'unsupported-source';
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
    if (selectVerifiedSourceRecords(rule, keyword, [], 'standard') !== null) return 'verified-source-records';
    return null;
}

export type NativeFileRecord = { cardIndex: number; key: string; instanceStart: number; branchIdentity?: string };

export function nativeOrdinalReferenceRecordReader(kind: string, cards: Map<number, any>, input: 'standard' | 'long' | 'i10',
    title: boolean, resolve = (raw: string, _line: number) => raw) {
    let ordinal = 0, start = 0, next = title ? 0 : 1, failed = false;
    return { next(text: string, line = ordinal) {
        if (failed) return null;
        const cardIndex = next;
        if (next === 0 || next === 1 && !title) start = ordinal;
        if (next === 0) next = 1;
        else if (next === 1) {
            const raw = resolve(readNativeFileField(kind, 1, cards.get(1)?.fields || [], text,
                kind === 'ordinal-ambient' ? 2 : 0, input), line).trim();
            const value = raw.includes('&') ? NaN : Number.parseFloat(raw.replace(/[dD]/g, 'e')) || 0;
            if (!Number.isInteger(value)) { failed = true; return null; }
            next = value === (kind === 'ordinal-ambient' ? 4 : 3) ? 2 : title ? 0 : 1;
        } else next = title ? 0 : 1;
        return { cardIndex, instanceStart: start, instanceComplete: true, key: `instance:${start}:record:${ordinal++}` };
    }, complete: () => !failed && ordinal > 0 && next === (title ? 0 : 1) };
}
/** SECTION_SHELL's native loop: a header, mandatory body, counted Bi rows,
 * and for ELFORM 100..105 a Pi tail to the next keyword. Retain no payload. */
export function nativeShellReferenceRecordReader(cards: Map<number, any>, input: 'standard' | 'long' | 'i10',
    title: boolean, resolve = (raw: string, _line: number) => raw) {
    let ordinal = 0, start = 0, next = title ? 0 : 1, remaining = 0, special = false, failed = false;
    const control = (text: string, field: number, line: number) => {
        const raw = resolve(readNativeFileField('shell', 1, cards.get(1)?.fields || [], text, field, input), line).trim();
        if (raw.includes('&')) return NaN;
        const number = Number.parseFloat(raw.replace(/[dD]/g, 'e'));
        return Number.isNaN(number) ? 0 : number;
    };
    const afterBody = () => remaining > 0 ? 5 : special ? 6 : title ? 0 : 1;
    return { next(text: string, line = ordinal) {
        if (failed) return null;
        const cardIndex = next;
        if (next === 0 || next === 1 && !title) start = ordinal;
        if (next === 0) next = 1;
        else if (next === 1) {
            const elform = control(text, 1, line), nip = control(text, 3, line), icomp = control(text, 6, line);
            if (![elform, nip, icomp].every(Number.isInteger)) { failed = true; return null; }
            special = elform >= 100 && elform <= 105;
            remaining = icomp === 1 ? Math.max(0, Math.trunc((nip - 1) / 8) + 1) : 0;
            if (!Number.isSafeInteger(remaining)) { failed = true; return null; }
            next = 2;
        } else if (next === 2) next = special ? 3 : afterBody();
        else if (next === 3) next = 4;
        else if (next === 4 || next === 5 && --remaining === 0) next = afterBody();
        return { cardIndex, instanceStart: start, instanceComplete: true, key: `instance:${start}:record:${ordinal++}` };
    }, complete: () => !failed && ordinal > 0 && (special ? next === 6 : next === (title ? 0 : 1)) };
}
export function nativeFixedFileRecord(kind: string, ordinal: number, title: boolean, cardCount: number,
    headerCount = 0): NativeFileRecord | null {
    if (kind === 'reference-tail' && Number.isSafeInteger(ordinal) && ordinal >= 1 &&
        Number.isInteger(headerCount) && headerCount > 0 && cardCount > headerCount) {
        const tailCount = cardCount - headerCount;
        const cardIndex = ordinal <= headerCount ? ordinal : headerCount + 1 + (ordinal - headerCount - 1) % tailCount;
        const instanceStart = ordinal <= headerCount ? 0 : headerCount + Math.floor((ordinal - headerCount - 1) / tailCount) * tailCount;
        return { cardIndex, instanceStart, key: `instance:${instanceStart}:card:${cardIndex}` };
    }
    if (kind === 'reference-single' && Number.isSafeInteger(ordinal) && ordinal >= 1)
        return { cardIndex: ordinal <= cardCount ? ordinal : 0, instanceStart: 0, key: `record:${ordinal}` };
    if (kind === 'seismic-prefix-records' && Number.isSafeInteger(ordinal) && ordinal >= 1) {
        if (ordinal === 1) return { cardIndex: 1, instanceStart: 0, key: 'prefix:1' };
        const instanceStart = 1 + Math.floor((ordinal - 2) / 2) * 2;
        const cardIndex = 2 + (ordinal - 2) % 2;
        return { cardIndex, instanceStart, key: `instance:${instanceStart}:card:${cardIndex}` };
    }
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
    if (!['section-fixed', 'generic-fixed', 'ordinal-fixed', 'batch-fixed', 'element-fixed', 'element-solid-records', 'reference-fixed', 'seismic-records'].includes(kind) || !Number.isSafeInteger(ordinal) || ordinal < 1 ||
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
    // Initial read proof does not certify source-changing edits or save/reopen.
    if (['element-solid-records', 'reference-fixed', 'reference-single', 'reference-tail', 'user-material-records', 'controlled-reference-records', 'contact-optional-records', 'ale-motion-single', 'seismic-records', 'seismic-prefix-records', 'interpolation-tail', 'interpolation-local-tail'].includes(kind)) return false;
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
export function selectNativeUserMaterialRecords(rows: string[], read: ReadField,
    resolve = (raw: string, _row: number) => raw, ford?: boolean) {
    if (rows.length < 2) return null;
    const integer = (row: number, field: number) => {
        const raw = resolve(read(row, row + 1, field), row).trim();
        const value = raw ? Number(raw) : 0;
        return (!raw || /^[+-]?\d+$/.test(raw)) && Number.isInteger(value) &&
            value >= -2147483648 && value <= 2147483647 ? value : NaN;
    };
    const mt = integer(0, 2), ortho = integer(0, 5);
    const records = (indexes: number[], unknownCardIndexes: number[] = [], uncertainty?: string) => ({
        current: rows.map((_text, index): NativeFileRecord => ({ cardIndex: indexes[index] || 0,
            instanceStart: 0, key: `instance:0:record:${index}` })), unknownCardIndexes, uncertainty });
    if (!Number.isFinite(ortho)) return records([1, 2], [3, 4, 7, 8, 9, 10, 11],
        'native-user-material-controller-unresolved');
    const indexes = [1, 2, ...([1, 3].includes(ortho) ? [3, 4] : [])];
    if (rows.length < indexes.length) return records(indexes, indexes.slice(rows.length),
        'native-user-material-records-incomplete');
    const unknown = !Number.isFinite(mt) || mt === 48 && ford === undefined;
    if (!unknown) {
        if (mt === 48 && ford) indexes.push(7, 8, 9, 10, 11);
        else {
            const lmc = integer(0, 3), lmca = integer(1, 5);
            // Constants carry no reference fields. Their unresolved or truncated
            // count cannot invalidate the already selected axes reference.
            if (!Number.isFinite(lmc) || !Number.isFinite(lmca)) return records(indexes);
            const counts = [Math.max(0, Math.ceil(lmc / 8)), Math.max(0, Math.ceil(lmca / 8))];
            if (indexes.length + counts[0] + counts[1] > rows.length) return records(indexes);
            indexes.push(...Array(counts[0]).fill(5), ...Array(counts[1]).fill(6));
        }
        if (indexes.length > rows.length) return records(indexes, indexes.slice(rows.length),
            'native-user-material-records-incomplete');
    }
    return records(indexes, unknown ? [7, 8, 9, 10, 11] : [],
        unknown ? 'native-lspp-ford-feature-context-unavailable' : undefined);
}
export function selectNativeFileLayout(kind: string, rows: string[], title: boolean,
    read: ReadField, draft: DraftField = (_record, _field, value) => value, targetTitle = title,
    partial = false, fixedCount = 0, resolveControl = (value: string, _row: number) => value,
    draftRecord = (_record: NativeFileRecord, text: string) => text, headerCount = 0) {
    const current: NativeFileRecord[] = [], target: NativeFileRecord[] = [], counts: number[] = [];
    if (kind === 'reference-tail') {
        const tailCount = fixedCount - headerCount;
        if (tailCount < 1 || headerCount < 1 || !partial &&
            (rows.length < headerCount || (rows.length - headerCount) % tailCount !== 0)) return null;
        const records = rows.map((_row, index) => nativeFixedFileRecord(kind, index + 1, false, fixedCount, headerCount));
        return { current: records, target: records.slice(), counts: [headerCount, ...Array(Math.floor(Math.max(0, rows.length - headerCount) / tailCount)).fill(tailCount)] };
    }
    if (kind === 'reference-single') {
        if (!partial && rows.length < fixedCount) return null;
        const records = rows.map((_row, index) => nativeFixedFileRecord(kind, index + 1, false, fixedCount));
        return { current: records, target: records.slice(), counts: [Math.min(fixedCount, rows.length)] };
    }
    if (kind === 'seismic-prefix-records') {
        if (!partial && (rows.length < 1 || (rows.length - 1) % 2 !== 0)) return null;
        const records = rows.map((_row, index) => nativeFixedFileRecord(kind, index + 1, false, fixedCount));
        return { current: records, target: records.slice(), counts: [1, ...Array(Math.floor((rows.length - 1) / 2)).fill(2)] };
    }
    if (kind === 'interpolation-tail' || kind === 'interpolation-local-tail') {
        const tailCount = kind === 'interpolation-local-tail' ? 2 : 1;
        if (!partial && (rows.length < 1 || (rows.length - 1) % tailCount !== 0)) return null;
        const records: NativeFileRecord[] = rows.map((_row, index) => ({ cardIndex: index === 0 ? 1 : 2 + (index - 1) % tailCount,
            instanceStart: 0, key: `instance:0:record:${index}` }));
        return { current: records, target: records.slice(), counts: [records.length] };
    }
    if (kind.startsWith('set-general-') || kind === 'set-list-tail') {
        const prefix = Number(title);
        if (!partial && rows.length <= prefix) return null;
        for (let index = 0; index < rows.length; index++) {
            const cardIndex = index < prefix ? 0 : index === prefix ? 1 : kind === 'set-list-tail' ? 2 : nativeSetGeneralRecordCard(kind, rows[index]);
            if (cardIndex === null) return null;
            const record = { cardIndex, instanceStart: 0, key: `instance:0:card:${cardIndex}:repeat:${index}` };
            if (cardIndex >= 2 && kind !== 'set-list-tail' && (nativeSetGeneralRecordCard(kind, draftRecord(record, rows[index])) !== cardIndex ||
                draft(record, 0, read(index, cardIndex, 0)) !== read(index, cardIndex, 0))) return null;
            current.push(record);
        }
        return { current, target: current.slice(), counts: [current.length] };
    }
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
            if (['section-fixed', 'generic-fixed', 'ordinal-fixed', 'batch-fixed', 'element-fixed', 'element-solid-records', 'reference-fixed', 'seismic-records'].includes(kind)) return Number.isInteger(fixedCount) && fixedCount > 0 && fixedCount <= 256
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
