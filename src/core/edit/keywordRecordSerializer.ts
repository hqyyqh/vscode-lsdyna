'use strict';

export type RecordField = { name?: string; type?: string | number; position: number; width: number; nativeReadWidth?: number; nativeLongWidth?: number;
    nativeRecordFormat?: 'standard' | 'raw' | 'input';
    nativeInputFormat?: 'standard' | 'long' | 'i10';
    nativeWriteGeometry?: { long: { position: number; width: number }; i10: { position: number; width: number } };
    nativeReadGeometry?: { long: { position: number; width: number }; i10: { position: number; width: number } } };
export type RecordFormat = 'standard' | 'long' | 'i10' | 'comma' | 'free' | 'raw';

export type RecordReadRange = { start: number; end: number };
type Span = RecordReadRange;

export const SHARED_BYTE_EDITING = 'native-shared-bytes-v1';

/** Accept only the EXE-backed standard-layout contract, never a bare overlap flag. */
export function hasSharedByteContract(card: any, datasetSha256: string): boolean {
    const proof = card?.sharedByteEditing;
    const fields = card?.fields || [];
    const overlaps = fields.filter((_field, index) => overlappingFieldIndexes(fields, index).length > 0);
    return proof?.mode === SHARED_BYTE_EDITING && proof.format === 'standard-fixed' &&
        proof.branchSha256 === '91fe1a812a0cdcacf4302cad298bd1470bbec2f7e2c3069baa41594797de4865' &&
        /^[a-f0-9]{64}$/.test(datasetSha256 || '') && proof.datasetSha256 === datasetSha256 &&
        safeRecordGeometry(fields, true) && overlaps.length > 0 &&
        (JSON.stringify(proof.fields) === JSON.stringify(overlaps.map(field => ({
            fieldIndex: field.fieldIndex, fieldRecordId: field.fieldRecordId,
            position: field.position, width: field.width,
        }))) || (Array.isArray(proof.fields) && proof.fields.length === overlaps.length &&
            overlaps.every((field, idx) => {
                const p = proof.fields[idx];
                return p && p.fieldIndex === field.fieldIndex && p.fieldRecordId === field.fieldRecordId &&
                    p.position === field.position && p.width === field.width;
            }))) && fields.every(field =>
            field.serializationPosition === field.position && field.serializationWidth === field.width &&
            (card.serializationSlots || []).filter(slot => slot.slotId === field.serializationSlotId &&
                slot.position === field.position && slot.width === field.width &&
                slot.fieldIndexes?.length === 1 && slot.fieldIndexes[0] === field.fieldIndex).length === 1);
}

export function overlappingFieldIndexes(fields: RecordField[], index: number): number[] {
    const field = fields[index];
    if (!field) return [];
    return fields.flatMap((other, otherIndex) => otherIndex !== index &&
        Math.max(field.position, other.position) < Math.min(
            field.position + field.width, other.position + other.width,
        ) ? [otherIndex] : []);
}

export function safeRecordGeometry(fields: RecordField[], sharedBytes = false): boolean {
    return fields.length > 0 && fields.every((field, index) =>
        Number.isInteger(field.position) && field.position >= 0 &&
        Number.isInteger(field.width) && field.width > 0 &&
        field.position + field.width <= 65536 &&
        (sharedBytes || overlappingFieldIndexes(fields, index).length === 0));
}

/** An authorized byte edit. All field views must be re-read from the returned text. */
export function editSharedRecord(text: string, fields: RecordField[], fieldIndex: number,
    value: string, format: RecordFormat): string | null {
    // The EXE evidence currently covers native standard positions. Never reuse
    // them for LONG/I10; those formats have a separate geometry contract.
    if (format !== 'standard' || !safeRecordGeometry(fields, true) ||
        !fields[fieldIndex] || /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ||
        value.length > fields[fieldIndex].width) return null;
    const next = writeRecordField(text, fields, fieldIndex, value, format);
    if (/[^\x20-\x7e]/.test(next) || /^\s*[$*]/.test(next) ||
        detectRecordFormat(next, 'standard', fields) !== 'standard') return null;
    return readRecordField(next, fields, fieldIndex, format) === value.trim() ? next : null;
}

function tokenSpans(text: string, separator: 'comma' | 'space'): Span[] {
    if (separator === 'comma') {
        const spans: Span[] = [];
        let start = 0;
        for (let index = 0; index <= text.length; index++) {
            if (index === start) {
                const expression = /^\s*<[^>]*>\s*(?=,|$)/.exec(text.slice(start));
                if (expression) index += expression[0].length;
            }
            if (index !== text.length && text[index] !== ',') continue;
            const raw = text.slice(start, index);
            const leading = raw.match(/^\s*/)?.[0].length || 0;
            const trailing = raw.match(/\s*$/)?.[0].length || 0;
            spans.push({ start: start + leading, end: Math.max(start + leading, index - trailing) });
            start = index + 1;
        }
        return spans;
    }
    return [...text.matchAll(/\S+/g)].map(match => ({
        start: match.index || 0,
        end: (match.index || 0) + match[0].length,
    }));
}

/** Commas inside a complete angle-bracket expression belong to one field. */
export function commaRecordSpans(text: string): RecordReadRange[] {
    return tokenSpans(text, 'comma');
}

export function detectRecordFormat(
    text: string, requested: 'standard' | 'long' | 'i10', fields: RecordField[],
): RecordFormat {
    const nativeFormat = fields[0]?.nativeRecordFormat;
    if (nativeFormat && fields.every(field => field.nativeRecordFormat === nativeFormat))
        return nativeFormat === 'input' ? text.includes(',') ? 'comma' : fields[0].nativeInputFormat || requested : nativeFormat;
    if (fields.length === 1 && String(fields[0].type) === 'raw-text') return 'raw';
    if (fields.length === 1 && isStringField(fields[0])) return requested;
    if (text.includes(',')) return 'comma';
    if (fields.some(field => field.nativeReadGeometry)) return requested;
    if (requested === 'long') return 'long';
    if (requested === 'i10') return 'i10';
    const width = fields.reduce((maximum, field) =>
        Math.max(maximum, Number(field.position) + Number(field.width)), 0);
    const trimmed = text.trim();
    const tokens = tokenSpans(trimmed, 'space');
    // A sparse fixed record can contain only two values and still have an
    // eighty-column extent. Treating it as free input appends a new value at
    // the end of the line instead of writing its native column.
    const physicalTokens = tokenSpans(text, 'space');
    if (physicalTokens.length && physicalTokens.every(span => fields.some(field =>
        span.start >= field.position && span.end <= field.position + field.width &&
        (span.end === field.position + field.width ||
            (isStringField(field) && span.start === field.position))))) return 'standard';
    if (tokens.length > 1 && tokens.length <= fields.length && text.trimEnd().length < width / 2 &&
        tokens.every((span, index) => {
            const value = trimmed.slice(span.start, span.end);
            return isStringField(fields[index]) || value.startsWith('&') ||
                Number.isFinite(Number(value.replace(/[dD]/g, 'e')));
        })) return 'free';
    return 'standard';
}

export function formattedFields(
    fields: RecordField[], text: string, format: RecordFormat,
): RecordField[] {
    if (format === 'raw') return fields.map(field => ({
        ...field, position: 0, width: Math.max(1, text.length),
    }));
    if (format === 'long' || format === 'i10') {
        if (fields.length && fields.every(field => field.nativeWriteGeometry?.[format])) {
            const projected = fields.map(field => ({ ...field, ...field.nativeWriteGeometry[format] }));
            return safeRecordGeometry(projected) ? projected : [];
        }
        // Expand physical fields, not byte offsets. In particular E20 stays
        // E20 in LONG, and NODE's I8/E16 mixture becomes I10/E16 in I10.
        // Gaps/overlaps do not tell us how many native slots were omitted.
        // They require an explicit format contract before they can be edited.
        if (!safeRecordGeometry(fields) || fields.some((field, index) =>
            field.position !== (index ? fields[index - 1].position + fields[index - 1].width : 0) ||
            (format === 'long' && field.width > 20 && !isStringField(field)))) return [];
        let position = 0;
        return fields.map(field => {
            const integer = Number(field.type) === 1 || /^(?:int(?:eger)?|i\d*)$/i.test(String(field.type));
            const width = format === 'i10' ? (integer ? Math.max(10, field.width) : field.width)
                : Number.isSafeInteger(field.nativeLongWidth) && field.nativeLongWidth >= field.width
                    ? field.nativeLongWidth : isStringField(field) && field.width >= 20 ? (field.width === 20 ? 40 : 160) : 20;
            const formatted = { ...field, position, width };
            position += width;
            return formatted;
        });
    }
    if (format === 'comma' || format === 'free') {
        const spans = tokenSpans(text, format === 'comma' ? 'comma' : 'space');
        return fields.map((field, index) => ({
            ...field,
            position: spans[index]?.start ?? text.length,
            width: Math.max(1, (spans[index]?.end ?? text.length) - (spans[index]?.start ?? text.length)),
        }));
    }
    return fields.map(field => ({ ...field }));
}

/** File-reader windows do not authorize writes through formattedFields. */
export function formattedReadFields(fields: RecordField[], text: string, format: RecordFormat): RecordField[] {
    if ((format === 'long' || format === 'i10') && fields.length && fields.every(field => field.nativeReadGeometry)) {
        const projected = fields.map(field => ({ ...field, ...field.nativeReadGeometry[format] }));
        return safeRecordGeometry(projected, true) ? projected : [];
    }
    return formattedFields(fields, text, format);
}

/** Actual source windows for read-only field views; never authorizes an edit. */
export function formattedReadRanges(
    fields: RecordField[], text: string, format: RecordFormat,
): RecordReadRange[] {
    if (format === 'raw') return fields.length === 1 && fields[0].position === 0 &&
        isStringField(fields[0]) && safeRecordGeometry(fields) ? [{ start: 0, end: text.length }] : [];
    if (format === 'comma') {
        const spans = tokenSpans(text, 'comma');
        if (spans.length > fields.length) return [];
        return fields.map((_field, index) => spans[index] || { start: text.length, end: text.length });
    }
    if (format !== 'standard' && format !== 'long' && format !== 'i10') return [];
    const projected = formattedReadFields(fields, text, format);
    if (projected.length !== fields.length || projected.some(field =>
        !Number.isInteger(field.position) || field.position < 0 ||
        !Number.isInteger(field.width) || field.width <= 0)) return [];
    return projected.map(field => ({
        start: Math.min(field.position, text.length),
        end: Math.min(field.position + field.width, text.length),
    }));
}

export function readRecordField(
    text: string, fields: RecordField[], fieldIndex: number, format: RecordFormat,
): string {
    if (fieldIndex < 0 || fieldIndex >= fields.length) return '';
    if (format === 'raw') return text;
    if (format === 'comma' || format === 'free') {
        const spans = tokenSpans(text, format === 'comma' ? 'comma' : 'space');
        const span = spans[fieldIndex];
        return span ? text.slice(span.start, span.end).trim() : '';
    }
    const field = formattedReadFields(fields, text, format)[fieldIndex];
    if (!field) return '';
    return text.slice(field.position, field.position + field.width).trim();
}

function isStringField(field: RecordField): boolean {
    const type = String(field.type ?? '').toLowerCase();
    return [0, -2].includes(Number(field.type)) || /string|char|^a/.test(type) || !!field.name?.startsWith('PRMR');
}

export function writeRecordField(
    text: string, fields: RecordField[], fieldIndex: number, value: string, format: RecordFormat,
): string {
    if (fieldIndex < 0 || fieldIndex >= fields.length) return text;
    const next = String(value ?? '');
    if (/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(next)) return text;
    if (format === 'raw') return next;
    // Introducing a comma into a numeric fixed-width cell can make the native
    // reader reinterpret the entire record as comma-separated input.
    if (next.includes(',') && !isStringField(fields[fieldIndex])) return text;
    if (format === 'comma') {
        // A comma is another field, not data in an unquoted keyword token.
        if (next.includes(',')) return text;
        const spans = tokenSpans(text, 'comma');
        if (fieldIndex >= spans.length) {
            return `${text}${','.repeat(fieldIndex - spans.length + 1)}${next}`;
        }
        const span = spans[fieldIndex];
        return text.slice(0, span.start) + next + text.slice(span.end);
    }
    if (format === 'free') {
        const spans = tokenSpans(text, 'space');
        // Spaces cannot represent skipped/empty interior fields. Removing one
        // would silently shift every following value to a different field.
        if (next.includes(',') || /\s/.test(next.trim()) || fieldIndex > spans.length ||
            (!next.trim() && fieldIndex < spans.length - 1)) return text;
        if (fieldIndex >= spans.length) {
            return `${text}${text && !/\s$/.test(text) ? ' ' : ''}${next}`;
        }
        const span = spans[fieldIndex];
        return text.slice(0, span.start) + next + text.slice(span.end);
    }
    const field = formattedFields(fields, text, format)[fieldIndex];
    if (!field) return text;
    if (next.length > field.width) return text;
    // Some native branch readers inspect a fixed prefix even in LONG input.
    const readWidth = fields[fieldIndex].nativeReadWidth;
    if (readWidth !== undefined && (!Number.isInteger(readWidth) || readWidth <= 0 ||
        readWidth > field.width || next.length > readWidth)) return text;
    const rendered = readWidth !== undefined ? next.padStart(readWidth).padEnd(field.width) :
        isStringField(field) ? next.padEnd(field.width) : next.padStart(field.width);
    const padded = text.padEnd(field.position + field.width, ' ');
    return padded.slice(0, field.position) + rendered + padded.slice(field.position + field.width);
}

export function blankRecord(fields: RecordField[], format: RecordFormat): string {
    if (format === 'raw') return '';
    if (format === 'comma') return ','.repeat(Math.max(0, fields.length - 1));
    if (format === 'free') return '';
    const formatted = formattedFields(fields, '', format);
    const width = formatted.reduce((maximum, field) =>
        Math.max(maximum, field.position + field.width), 0);
    return ' '.repeat(width);
}
