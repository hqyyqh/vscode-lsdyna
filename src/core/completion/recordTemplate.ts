import { hasSharedByteContract, safeRecordGeometry, writeRecordField, type RecordField } from '../edit/keywordRecordSerializer';
import { generateCommentLine } from './fieldComment';

export type TemplateField = RecordField & { defaultValue?: unknown };
export const escapeSnippetValue = (value: string) => value.replace(/[\\$}]/g, '\\$&');

/** Explicit defaults only: a missing value is a tab stop, never an invented zero. */
export function recordTemplate(fields: TemplateField[], firstTab = 1) {
    if (!fields.length) return { text: '', snippet: '', header: '', nextTab: firstTab };
    if (!safeRecordGeometry(fields)) return null;
    let text = ' '.repeat(Math.max(...fields.map(field => field.position + field.width)));
    for (let index = 0; index < fields.length; index++) {
        const value = fields[index].defaultValue == null ? '' : String(fields[index].defaultValue);
        if (/[\r\n\x00]/.test(value) || value.length > fields[index].width) return null;
        text = writeRecordField(text, fields, index, value, 'standard');
    }
    let snippet = '', end = 0;
    for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (field.position < end) return null;
        snippet += text.slice(end, field.position) + '${' + (firstTab + index) + ':' +
            escapeSnippetValue(text.slice(field.position, field.position + field.width)) + '}';
        end = field.position + field.width;
    }
    return { text, snippet, nextTab: firstTab + fields.length,
        header: generateCommentLine(fields.map(field => ({ n: field.name, p: field.position, w: field.width }))),
    };
}

/** One tab stop per physical byte group; never emit overlapping placeholders. */
export function nativeWindowRecordTemplate(card: any, datasetSha256: string, firstTab = 1) {
    const fields = [...card.fields].sort((a, b) => a.position - b.position);
    if (safeRecordGeometry(fields)) return recordTemplate(fields, firstTab);
    if (!hasSharedByteContract(card, datasetSha256)) return null;
    const groups: any[][] = [];
    for (const field of fields) {
        const previous = groups[groups.length - 1];
        if (previous && field.position < Math.max(...previous.map(item => item.position + item.width))) previous.push(field);
        else groups.push([field]);
    }
    const slots = [];
    for (const group of groups) {
        if (group.length === 1) { slots.push(group[0]); continue; }
        const position = group[0].position, end = Math.max(...group.map(field => field.position + field.width));
        const defaults = [...new Set(group.filter(field => field.defaultValue != null).map(field => String(field.defaultValue)))];
        if (defaults.length > 1) return null;
        const value = defaults[0] || '';
        const commonStart = Math.max(...group.map(field => field.position));
        const commonEnd = Math.min(...group.map(field => field.position + field.width));
        if (value.length > commonEnd - commonStart) return null;
        const defaultValue = ' '.repeat(commonEnd - position - value.length) + value + ' '.repeat(end - commonEnd);
        slots.push({ name: group.map(field => field.name).join('/'), type: 'string', position, width: end - position, defaultValue });
    }
    const template = recordTemplate(slots, firstTab);
    if (!template) return null;
    return { ...template, header: generateCommentLine(card.fields.map(field => ({ n: field.name, p: field.position, w: field.width }))) };
}
