import type {
    DecodedField,
    ExpectedRecord,
    ObservedRecord,
    RecordMatch,
} from './types';

const INTEGER_PATTERN = /^[+-]?\d+$/;
const REAL_PATTERN = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:(?:[EeDd][+-]?\d+)|(?:[+-]\d+))?$/;
const PARAMETER_PATTERN = /^&[A-Za-z_][A-Za-z0-9_]*(?:\s*[+\-*/].*)?$/;

function numericValue(raw: string): number | undefined {
    const normalized = raw.replace(/[dD]/g, 'E').replace(
        /^([+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+)))([+-]\d+)$/,
        '$1E$2',
    );
    const value = Number(normalized);
    return Number.isFinite(value) ? value : undefined;
}

function decodeValue(name: string, rawText: string, typeCodeValue: unknown): DecodedField {
    const raw = rawText.trim();
    const typeCode = String(typeCodeValue || '').trim().toUpperCase();
    if (!raw) return { name, raw, state: 'blank', typeCode };
    if (PARAMETER_PATTERN.test(raw)) return { name, raw, state: 'parameter', typeCode };
    if (typeCode === 'I' || typeCode === 'INTEGER') {
        if (!INTEGER_PATTERN.test(raw)) return { name, raw, state: 'invalid', typeCode };
        return { name, raw, value: Number(raw), state: 'known', typeCode };
    }
    if (typeCode === 'F' || typeCode === 'R' || typeCode === 'REAL' || typeCode === 'FLOAT') {
        if (!REAL_PATTERN.test(raw)) return { name, raw, state: 'invalid', typeCode };
        const value = numericValue(raw);
        return value === undefined
            ? { name, raw, state: 'invalid', typeCode }
            : { name, raw, value, state: 'known', typeCode };
    }
    if (typeCode === 'A') {
        const value = numericValue(raw);
        return { name, raw, value: value === undefined ? raw : value, state: 'known', typeCode };
    }
    return { name, raw, value: raw, state: 'known', typeCode };
}

function formatAllowed(expected: ExpectedRecord, observed: ObservedRecord): boolean {
    const choices = Array.isArray(expected.node.formatChoice) ? expected.node.formatChoice : [];
    if (choices.length === 0) return true;
    return observed.format === 'free'
        ? choices.includes('free-comma') || choices.includes('free')
        : choices.includes('standard-fixed') || choices.includes('standard') || choices.includes('fixed');
}

function markerMatches(marker: any, text: string): boolean {
    if (!marker) return true;
    const value = marker.value ?? marker.marker ?? marker;
    if (marker.kind === 'column-one') return text.startsWith(String(value || ''));
    if (marker.kind === 'prefix') return text.startsWith(String(value || ''));
    if (marker.kind === 'suffix') return text.endsWith(String(value || ''));
    if (marker.kind === 'exact-line') return text.trim() === String(value || '').trim();
    if (marker.column !== undefined) {
        const column = Math.max(0, Number(marker.column));
        return text.slice(column, column + String(value || '').length) === String(value || '');
    }
    return String(value || '') ? text.startsWith(String(value)) : true;
}

function officialSignatureFields(geometry: any, observed: ObservedRecord): Array<{
    name: string;
    raw: string;
    typeCode: unknown;
    nullSlot: boolean;
}> | null {
    const fields = Array.isArray(geometry.fields) ? geometry.fields : [];
    if (observed.format === 'free') {
        const tokens = observed.text.split(',');
        const maximumIndex = fields.reduce((value, field) => Math.max(value, Number(field.index) || 0), -1);
        if (tokens.slice(maximumIndex + 1).some(token => token.trim() !== '')) return null;
        return fields.map(field => ({
            name: String(field.name || ''),
            raw: tokens[Number(field.index) || 0] || '',
            typeCode: field.typeCode,
            nullSlot: !field.name && !field.typeCode,
        }));
    }
    const width = Number(geometry.fieldWidth);
    if (!Number.isInteger(width) || width < 1 || width > 80) return null;
    const maximumEnd = fields.reduce(
        (value, field) => Math.max(value, ((Number(field.index) || 0) + 1) * width),
        0,
    );
    if (observed.text.slice(maximumEnd).trim() !== '') return null;
    return fields.map(field => {
        const start = (Number(field.index) || 0) * width;
        return {
            name: String(field.name || ''),
            raw: observed.text.slice(start, start + width),
            typeCode: field.typeCode,
            nullSlot: !field.name && !field.typeCode,
        };
    });
}

function prefixTemplateFields(geometry: any, observed: ObservedRecord): Array<{
    name: string;
    raw: string;
    typeCode: unknown;
    nullSlot: boolean;
}> | null {
    const fields = Array.isArray(geometry.fields) ? geometry.fields : [];
    if (observed.format === 'free') {
        const tokens = observed.text.split(',');
        if (tokens.slice(fields.length).some(token => token.trim() !== '')) return null;
        return fields.map((field, index) => ({
            name: String(field.n || ''),
            raw: tokens[index] || '',
            typeCode: field.t,
            nullSlot: !field.n && !field.t,
        }));
    }
    const maximumEnd = fields.reduce(
        (value, field) => Math.max(value, Number(field.p) + Number(field.w)),
        0,
    );
    if (!Number.isFinite(maximumEnd) || maximumEnd < 0 || maximumEnd > 1024 ||
        observed.text.slice(maximumEnd).trim() !== '') return null;
    return fields.map(field => ({
        name: String(field.n || ''),
        raw: observed.text.slice(Number(field.p) || 0, (Number(field.p) || 0) + (Number(field.w) || 0)),
        typeCode: field.t,
        nullSlot: !field.n && !field.t,
    }));
}

export function matchObservedRecord(expected: ExpectedRecord, observed: ObservedRecord): RecordMatch {
    if (!formatAllowed(expected, observed)) {
        return { quality: 'unsupported', reason: 'record-format-not-authorized', decodedFields: [] };
    }
    if (!markerMatches(expected.marker, observed.text)) {
        return { quality: 'mismatch', reason: 'record-marker-mismatch', decodedFields: [] };
    }
    const geometry = expected.node.geometryRef;
    if (!geometry || geometry.kind === 'none' || geometry.kind === 'opaque') {
        return { quality: 'unknown', reason: geometry?.reason || 'record-geometry-unavailable', decodedFields: [] };
    }
    if (observed.text.trim() === '' && expected.node.blankAllowed !== true) {
        return { quality: 'mismatch', reason: 'blank-record-not-authorized', decodedFields: [] };
    }
    let fields: ReturnType<typeof officialSignatureFields>;
    if (geometry.kind === 'official-field-signature') {
        fields = officialSignatureFields(geometry, observed);
    } else if (geometry.kind === 'official-prefix-template') {
        fields = prefixTemplateFields(geometry, observed);
    } else if (geometry.kind === 'text-body' || geometry.kind === 'wildcard') {
        return { quality: 'unknown', reason: 'opaque-text-record', decodedFields: [] };
    } else {
        return { quality: 'unsupported', reason: `unsupported-geometry:${geometry.kind}`, decodedFields: [] };
    }
    if (!fields) return { quality: 'mismatch', reason: 'record-width-or-field-count-mismatch', decodedFields: [] };
    const decodedFields: DecodedField[] = [];
    for (const field of fields) {
        if (field.nullSlot) {
            if (field.raw.trim() !== '') {
                return { quality: 'mismatch', reason: 'reserved-field-is-nonblank', decodedFields };
            }
            continue;
        }
        const decoded = decodeValue(field.name, field.raw, field.typeCode);
        decodedFields.push(decoded);
        if (decoded.state === 'invalid') {
            return { quality: 'mismatch', reason: `field-type-mismatch:${field.name}`, decodedFields };
        }
    }
    const quality = decodedFields.some(field => field.state === 'parameter') ? 'unknown' : 'exact';
    return { quality, decodedFields };
}

export function blankRecordForExpected(expected: ExpectedRecord): string | null {
    const geometry = expected.node.geometryRef;
    if (!geometry) return null;
    if (geometry.kind === 'official-field-signature') {
        const fields = Array.isArray(geometry.fields) ? geometry.fields : [];
        const width = Number(geometry.fieldWidth);
        const columns = fields.reduce(
            (maximum, field) => Math.max(maximum, (Number(field.index) || 0) + 1),
            0,
        );
        return Number.isInteger(width) && width > 0 && width * columns <= 1024
            ? ' '.repeat(width * columns)
            : null;
    }
    if (geometry.kind === 'official-prefix-template') {
        const width = (geometry.fields || []).reduce(
            (maximum, field) => Math.max(maximum, Number(field.p) + Number(field.w)),
            0,
        );
        return Number.isFinite(width) && width > 0 && width <= 1024 ? ' '.repeat(width) : null;
    }
    return null;
}

export const recordMatcherInternals = {
    decodeValue,
    markerMatches,
    numericValue,
};
