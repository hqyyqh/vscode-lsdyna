import { isDescriptorIdentity } from './descriptorIdentity';
import type { KeywordCard, KeywordEntry, KeywordLookup } from '../keywordSchema';
import {
    formattedReadFields, formattedReadRanges, readRecordField, type RecordFormat,
} from '../edit/keywordRecordSerializer';
import { getCatalogInputFormCatalogV4, type CatalogInputFormCatalogV4 } from "./catalogInputFormCatalogV4";

export type StaticDescriptorInputFormat = Extract<RecordFormat, 'comma' | 'long' | 'i10'>;

export type StaticDescriptorFieldIdentity = {
    stableIdentity: string;
    datasetSha256: string;
    formRuleId: string;
    cardIndex: number;
    fieldIndex: number;
    fieldRecordId: string;
};

export type StaticDescriptorProjectedField = {
    n: string;
    fieldRecordId: string;
    p: number;
    w: number;
    t: 'string' | 'integer' | 'real';
    h?: string;
    d?: unknown;
    e?: unknown[];
    rawValue: string;
    sourceRange: { start: number; end: number };
    definitionSource: { datasetSha256: string; fieldRecordId: string; alignmentMayOmit: boolean };
    staticDescriptorIdentity: StaticDescriptorFieldIdentity;
};

export type StaticDescriptorFormatRequest = {
    keyword: string;
    lookup: KeywordLookup;
    /** All cards rendered for this exact spelling/options, in physical order. */
    schemaCards: KeywordCard[];
    /** One-based physical data-record ordinal. */
    ordinal: number;
    currentText: string;
    inputFormat: StaticDescriptorInputFormat;
    /** Test seam only; production callers use the audited singleton. */
    catalog?: Pick<CatalogInputFormCatalogV4, 'formForKeyword'>;
};

export type StaticDescriptorFormatResolution = {
    status: 'resolved';
    reason: 'static-descriptor-format';
    keywordName: string;
    canonicalKeyword: string;
    inputFormat: StaticDescriptorInputFormat;
    formRuleId: string;
    cardIndex: number;
    cardRecordId: string;
    cardIdentity: string;
    datasetSha256: string;
    datasetVersion: string;
    card: StaticDescriptorProjectedField[];
} | {
    status: 'input-uncertain' | 'implementation-gap';
    reason: string;
};


const SHA256 = /^[0-9a-f]{64}$/;

function normalizedKeyword(value: unknown): string {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0].replace(/[+%\-]$/, '');
}

function normalizedFieldName(value: unknown): string {
    const name = String(value || '').trim().toUpperCase();
    return /^[-_]*$/.test(name) ? 'UNUSED' : name;
}

function descriptorType(value: unknown): StaticDescriptorProjectedField['t'] | null {
    const numeric = Number(value);
    if (numeric === 0 || numeric === -2) return 'string';
    if (numeric === 1) return 'integer';
    if (numeric === 2) return 'real';
    return null;
}

function hasValues(value: unknown): boolean {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value !== undefined && value !== null && value !== false && value !== '';
}

function titleComponent(value: string): boolean {
    return normalizedKeyword(value).split('_').includes('TITLE');
}

function entryHasRepeat(entry: KeywordEntry): boolean {
    return entry.r !== undefined && entry.r !== null;
}

function expectedSerializationFormats(rule: any): boolean {
    const expected = new Map([
        ['standard-fixed', 'native'],
        ['long-fixed', 'native-times-two'],
        ['i10-fixed', 'native'],
        ['comma-free', 'field-ordinal'],
    ]);
    const formats = rule?.serializationFormats;
    return Array.isArray(formats) && formats.length === expected.size && formats.every((item: any) =>
        item && expected.get(item.format) === item.fieldCoordinates
    ) && new Set(formats.map((item: any) => item.format)).size === expected.size;
}

function strictDescriptorCards(rule: any): boolean {
    if (!Array.isArray(rule?.cards) || rule.cards.length === 0 ||
        !isDescriptorIdentity(String(rule.cardSetId || ''), true) || !expectedSerializationFormats(rule)) return false;
    return rule.cards.every((card: any, cardOffset: number) => {
        if (!card || card.cardIndex !== cardOffset + 1 ||
            !isDescriptorIdentity(String(card.cardRecordId || ''), true) ||
            card.recordKind !== 'fields' || card.occurrence?.kind !== 'source-bound' ||
            !Array.isArray(card.fields) || card.fields.length < 1 || card.fields.length > 8 ||
            !Array.isArray(card.serializationSlots) || card.serializationSlots.length !== card.fields.length) return false;
        return card.fields.every((field: any, fieldIndex: number) => {
            const slot = card.serializationSlots[fieldIndex];
            return field && field.fieldIndex === fieldIndex && typeof field.fieldId === 'string' &&
                isDescriptorIdentity(String(field.fieldRecordId || ''), true) && typeof field.name === 'string' &&
                descriptorType(field.type) !== null && field.position === fieldIndex * 10 && field.width === 10 &&
                field.serializationPosition === field.position && field.serializationWidth === field.width &&
                typeof field.serializationSlotId === 'string' && Array.isArray(field.choices) &&
                Object.prototype.hasOwnProperty.call(field, 'defaultValue') && slot &&
                slot.slotId === field.serializationSlotId && slot.position === field.position &&
                slot.width === field.width && Array.isArray(slot.fieldIndexes) &&
                slot.fieldIndexes.length === 1 && slot.fieldIndexes[0] === fieldIndex;
        });
    });
}

function schemaAgrees(schemaCards: KeywordCard[], descriptorCards: any[]): boolean {
    return Array.isArray(schemaCards) && schemaCards.length === descriptorCards.length &&
        descriptorCards.every((card, cardIndex) => {
            const schemaCard = schemaCards[cardIndex];
            return Array.isArray(schemaCard) && schemaCard.length === card.fields.length &&
                card.fields.every((field: any, fieldIndex: number) => {
                    const schemaField = schemaCard[fieldIndex];
                    return schemaField && normalizedFieldName(schemaField.n) === normalizedFieldName(field.name) &&
                        String(schemaField.t || '').trim().toLowerCase() === descriptorType(field.type) &&
                        schemaField.p === field.position && schemaField.w === field.width;
                });
        });
}

function commaTokenCount(text: string): number {
    return text.split(',').length;
}

/**
 * Resolve a non-standard static record only when the audited input-form
 * descriptor and the complete rendered schema describe the same fixed cards.
 */
export function resolveStaticDescriptorFormat(
    request: StaticDescriptorFormatRequest,
): StaticDescriptorFormatResolution {
    const gap = (reason: string): StaticDescriptorFormatResolution => ({ status: 'implementation-gap', reason });
    const uncertain = (reason: string): StaticDescriptorFormatResolution => ({ status: 'input-uncertain', reason });
    const inputName = normalizedKeyword(request.keyword);
    if (!inputName || inputName !== normalizedKeyword(request.lookup?.inputName)) return gap('input-identity-mismatch');
    if (!['comma', 'long', 'i10'].includes(request.inputFormat)) return gap('unsupported-static-input-format');
    if (!request.lookup?.entry || entryHasRepeat(request.lookup.entry)) return gap('repeating-schema-records');
    if (request.lookup.entry.tc?.length) return gap('text-card-schema');
    if (titleComponent(inputName) || request.lookup.activeOptions?.some(titleComponent)) return gap('title-layout');
    if (!Number.isInteger(request.ordinal) || request.ordinal < 1) return uncertain('record-ordinal-unavailable');
    if (request.inputFormat !== 'comma' && request.currentText.includes(',')) return uncertain('conflicting-input-format');

    let form;
    try {
        form = (request.catalog || getCatalogInputFormCatalogV4()).formForKeyword(inputName);
    } catch (_error) {
        return gap('input-form-catalog-unavailable');
    }
    if (!form) return gap('input-form-descriptor-unavailable');
    if (form.source?.conservationSatisfied !== true || form.source?.isUnauditedDiagnostic ||
        !SHA256.test(String(form.source?.datasetSha256 || '')) || !String(form.source?.datasetVersion || '')) {
        return gap('input-form-source-unverified');
    }
    const catalogIdentity = normalizedKeyword(form.keyword);
    const canonical = normalizedKeyword(request.lookup.canonicalName);
    if (catalogIdentity !== inputName && catalogIdentity !== canonical) return gap('catalog-identity-mismatch');

    const formRuleIds = form.reference?.formRuleIds;
    if (!Array.isArray(formRuleIds) || formRuleIds.length !== 1) return gap('single-form-required');
    if (hasValues(form.reference?.fieldRuleIds)) return gap('field-rules-present');
    const formRuleId = formRuleIds[0];
    const rule = form.rules?.[formRuleId];
    if (!rule) return gap('form-rule-unavailable');
    if (hasValues(rule.occurrenceGrammar) || (rule.constructionOperations || []).some((operation: any) =>
        ['dynamic-record-controls', 'form-state-query', 'append', 'replace', 'resize', 'activate']
            .includes(String(operation?.primitiveId || '')))) return gap('native-occurrence-semantics');
    if ((rule.recordSelection !== undefined && rule.recordSelection !== null) ||
        hasValues(rule.dataActions) || hasValues(rule.states) ||
        hasValues(rule.domains) || hasValues(rule.initialSnapshot?.runtimeWidgetGroups) ||
        rule.cards?.some((card: any) => card?.when !== undefined ||
            card?.fields?.some((field: any) => field?.when !== undefined))) return gap('dynamic-form-semantics');
    if (!strictDescriptorCards(rule)) return gap('descriptor-contract-mismatch');
    if (rule.cards.some((card: any) => card.fields.some((field: any) =>
        normalizedFieldName(field.name) === 'TITLE'))) return gap('title-layout');
    if (!schemaAgrees(request.schemaCards, rule.cards)) return gap('schema-descriptor-mismatch');
    if (request.ordinal > rule.cards.length) return uncertain('record-layout-unavailable');

    const descriptorCard = rule.cards[request.ordinal - 1];
    if (request.inputFormat === 'comma' && commaTokenCount(request.currentText) > descriptorCard.fields.length) {
        return uncertain('extra-comma-fields');
    }
    const physical = formattedReadFields(descriptorCard.fields, request.currentText, request.inputFormat);
    if (physical.length !== descriptorCard.fields.length) return gap('format-projection-unavailable');
    const sourceRanges = formattedReadRanges(descriptorCard.fields, request.currentText, request.inputFormat);
    if (sourceRanges.length !== descriptorCard.fields.length) return gap('format-range-unavailable');

    const datasetSha256 = form.source.datasetSha256;
    const cardIdentity = [datasetSha256, formRuleId, descriptorCard.cardIndex,
        descriptorCard.cardRecordId].join(':');
    const card = descriptorCard.fields.map((field: any, fieldIndex: number) => {
        const span = physical[fieldIndex];
        const rawValue = readRecordField(request.currentText, descriptorCard.fields, fieldIndex, request.inputFormat);
        const type = descriptorType(field.type)!;
        return {
            n: /^\s*[-_]*\s*$/.test(field.name) ? 'UNUSED' : field.name,
            fieldRecordId: field.fieldRecordId,
            p: span.position,
            w: span.width,
            t: type,
            ...(typeof field.help === 'string' && field.help.trim() ? { h: field.help.trim() } : {}),
            ...(field.defaultValue !== null && field.defaultValue !== undefined ? { d: field.defaultValue } : {}),
            e: [...field.choices],
            rawValue,
            sourceRange: sourceRanges[fieldIndex],
            definitionSource: { datasetSha256, fieldRecordId: field.fieldRecordId,
                alignmentMayOmit: field.defaultValue !== null && field.defaultValue !== undefined },
            staticDescriptorIdentity: {
                stableIdentity: [cardIdentity, fieldIndex, field.fieldRecordId].join(':'),
                datasetSha256, formRuleId, cardIndex: descriptorCard.cardIndex,
                fieldIndex, fieldRecordId: field.fieldRecordId,
            },
        };
    });
    return {
        status: 'resolved', reason: 'static-descriptor-format', keywordName: inputName,
        canonicalKeyword: canonical, inputFormat: request.inputFormat, formRuleId,
        cardIndex: descriptorCard.cardIndex, cardRecordId: descriptorCard.cardRecordId,
        cardIdentity, datasetSha256, datasetVersion: form.source.datasetVersion, card,
    };
}
