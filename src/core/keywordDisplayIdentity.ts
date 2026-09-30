'use strict';

/**
 * @fileoverview Bounded, schema-aware display identity extraction for LS-DYNA keyword blocks.
 *
 * A keyword block does not always represent a named entity.  This module therefore returns a
 * structured identity instead of guessing that the first `...ID` field is the block's own ID.
 * Every block is classified as a human-readable name, an authoritative entity ID, a reviewed
 * engineering signature, a collection summary, or an explicit keyword-only fallback.
 */

const {
    getRenderedCardsForLookup,
    getVerifiedPrefixLayout,
    loadKeywordSchema,
    lookupKeywordSchema,
} = require('./keywordSchema');
const referenceIndex = require('../../keywords/field_reference_index.json');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { formattedFields } = require('./edit/keywordRecordSerializer');

const {
    globalInputFormatFromKeywordLine,
    keywordInputFormat,
} = require('./parser/inputFormat');

const KEYWORD_LAYOUT_RUNTIME_FORMAT_VERSION = 1;
const KEYWORD_LAYOUT_RUNTIME_FILE = 'field_schema.runtime.json.gz';
let keywordLayoutSchemaCache = null;

function loadKeywordLayoutSchema() {
    if (keywordLayoutSchemaCache) return keywordLayoutSchemaCache;
    try {
        const encoded = fs.readFileSync(path.join(
            __dirname,
            '..',
            'runtime',
            KEYWORD_LAYOUT_RUNTIME_FILE,
        ));
        const runtime = JSON.parse(zlib.gunzipSync(encoded).toString('utf8'));
        if (!runtime || runtime.formatVersion !== KEYWORD_LAYOUT_RUNTIME_FORMAT_VERSION
            || !runtime.schema || typeof runtime.schema !== 'object'
            || !Number.isSafeInteger(runtime.keywordCount)
            || runtime.keywordCount !== Object.keys(runtime.schema).length) {
            throw new Error('invalid keyword layout runtime contract');
        }
        keywordLayoutSchemaCache = runtime.schema;
    } catch (error) {
        console.warn(`[DynaSense] Compact keyword layout runtime unavailable: ${error?.message || error}`);
        keywordLayoutSchemaCache = loadKeywordSchema();
    }
    return keywordLayoutSchemaCache;
}

const MAX_CAPTURED_DATA_LINES = 32;
const MAX_CAPTURED_BYTES = 8 * 1024;
const MAX_DISPLAY_TEXT = 240;

type DisplayFieldValue = {
    name: string;
    value: string;
    cardIndex: number;
    fieldIndex: number;
};

type KeywordDisplayIdentity = {
    kind: 'named' | 'identified' | 'signature' | 'collection' | 'keyword';
    keyword: string;
    canonicalKeyword: string;
    title?: string;
    path?: string;
    identity?: { field: string; value: string };
    missingIdentity?: { field: string; status: 'empty' | 'unresolved' };
    signature?: Array<{ field: string; value: string }>;
    collection?: { kind: 'data-lines' | 'definitions'; count: number };
    dataLineCount: number;
    confidence: 'verified' | 'schema' | 'fallback';
};

type IdentityAccumulator = {
    acceptLine: (line: string | Buffer) => boolean;
    finish: (metadata?: { dataLineCount?: number }) => KeywordDisplayIdentity;
    isCaptureComplete: () => boolean;
};

const TITLE_FIELD_PRIORITY = [
    'TITLE',
    'HEADING',
    'NAME',
    'LABEL',
    'DESCRIPTION',
    'DESC',
];

const FAMILY_ID_FIELDS: Array<{ test: RegExp; fields: string[] }> = [
    { test: /^PART(?:_|$)/, fields: ['PID'] },
    { test: /^MAT(?:_|$)/, fields: ['MID'] },
    { test: /^SECTION(?:_|$)/, fields: ['SECID', 'SID'] },
    { test: /^EOS(?:_|$)/, fields: ['EOSID'] },
    { test: /^HOURGLASS(?:_|$)/, fields: ['HGID'] },
    { test: /^SET(?:_|$)/, fields: ['SID', 'SETID'] },
    { test: /^DEFINE_CURVE(?:_|$)/, fields: ['LCID'] },
    { test: /^DEFINE_TABLE(?:_|$)/, fields: ['TBID'] },
    { test: /^DEFINE_COORDINATE(?:_|$)/, fields: ['CID'] },
    { test: /^DEFINE_BOX(?:_|$)/, fields: ['BOXID', 'BOX ID'] },
    { test: /^DEFINE_TRANSFORMATION(?:_|$)/, fields: ['TRANID', 'TRID'] },
    { test: /^DEFINE_FUNCTION(?:_|$)/, fields: ['FID', 'ID'] },
    { test: /^SENSOR_DEFINE(?:_|$)/, fields: ['SID'] },
    { test: /^RIGIDWALL.*(?:_ID|_ID_TITLE)$/, fields: ['RWID', 'ID'] },
    { test: /^CONTACT_.*(?:_ID|_ID_TITLE)$/, fields: ['CID', 'ID'] },
];

function normalizeKeyword(value: string): string {
    return String(value || '')
        .trim()
        .replace(/^\*/, '')
        .toUpperCase()
        .split(/[\s,$]/)[0]
        .replace(/[+%\-]$/, '');
}

function normalizeFieldName(value: string): string {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function compactText(value: unknown, maxLength = MAX_DISPLAY_TEXT): string {
    const normalized = String(value == null ? '' : value)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function isCommentOrBlank(line: string): boolean {
    const trimmed = String(line || '').trimStart();
    return trimmed === '' || trimmed.startsWith('$');
}

function fixedFieldValue(
    line: string,
    field: any,
    fieldIndex: number,
    card: any[],
    coordinates: { position: number; width: number } | undefined,
): string {
    if (card.length === 1 && /^(TITLE|HEADING|NAME|LABEL|DESCRIPTION|DESC)$/.test(normalizeFieldName(field.n))) {
        return compactText(line);
    }

    if (line.includes(',')) {
        const values = line.split(',');
        return compactText(values[fieldIndex] || '');
    }

    if (!coordinates) return '';
    const start = coordinates.position;
    const width = coordinates.width;
    if (Number.isFinite(start) && Number.isFinite(width) && width > 0) {
        const value = compactText(line.slice(start, start + width));
        return value;
    }

    // Missing geometry is not permission to shift a later non-empty token into an ID slot.
    return '';
}

function collectFieldValues(
    keyword: string,
    dataLines: string[],
    schema: any,
    options: { longFormat?: boolean; percentFormat?: boolean; lookup?: any } = {},
): { lookup: any; values: DisplayFieldValue[] } {
    const lookup = Object.prototype.hasOwnProperty.call(options, 'lookup')
        ? options.lookup
        : lookupKeywordSchema(keyword, schema);
    if (!lookup || dataLines.length === 0) {
        return { lookup, values: [] };
    }

    const cards = getRenderedCardsForLookup(lookup, dataLines, dataLines.length);
    const values: DisplayFieldValue[] = [];
    for (let cardIndex = 0; cardIndex < dataLines.length; cardIndex++) {
        const card = cards[cardIndex];
        if (!Array.isArray(card)) continue;
        const coordinates = formattedFields(card.map(field => ({
            name: field.n, type: field.t, position: field.p, width: field.w,
        })), dataLines[cardIndex], options.percentFormat ? 'i10' : options.longFormat ? 'long' : 'standard');
        for (let fieldIndex = 0; fieldIndex < card.length; fieldIndex++) {
            const field = card[fieldIndex];
            const value = fixedFieldValue(
                dataLines[cardIndex],
                field,
                fieldIndex,
                card,
                coordinates[fieldIndex],
            );
            if (!value) continue;
            values.push({
                name: normalizeFieldName(field.n),
                value,
                cardIndex: cardIndex + 1,
                fieldIndex,
            });
        }
    }
    return { lookup, values };
}

function isTitleFieldName(value: string): boolean {
    return TITLE_FIELD_PRIORITY.includes(normalizeFieldName(value));
}

function requestsExplicitTitle(keyword: string, lookup: any): boolean {
    if ((lookup?.activeOptions || []).some(option => /^(TITLE|HEADING)$/.test(normalizeFieldName(option)))) {
        return true;
    }
    return /(?:^|_)(?:TITLE|HEADING)(?:_|$)/.test(keyword);
}

/**
 * Some generated alias entries (notably several SET_*_TITLE forms) declare TITLE as active and
 * redirect through another alias whose canonical card list no longer contains the title card.
 * LS-DYNA still consumes that first physical data record as the title.  Detect that precise schema
 * mismatch and offset the remaining cards instead of treating the title text as SID/PID/MID.
 */
function splitSyntheticTitleCard(keyword: string, dataLines: string[], lookup: any) {
    if (!lookup || !requestsExplicitTitle(keyword, lookup) || dataLines.length === 0) {
        return { title: '', schemaDataLines: dataLines };
    }
    const layout = getVerifiedPrefixLayout(lookup, dataLines);
    if (layout.status === 'unsupported-option' || layout.status === 'unverified') {
        return { title: '', schemaDataLines: [] };
    }
    const firstRenderedCard = getRenderedCardsForLookup(lookup, dataLines, 1)[0];
    if (Array.isArray(firstRenderedCard) && firstRenderedCard.some(field => isTitleFieldName(field.n))) {
        return { title: '', schemaDataLines: dataLines };
    }
    return {
        title: compactText(dataLines[0]),
        schemaDataLines: dataLines.slice(1),
    };
}

function firstValue(values: DisplayFieldValue[], names: string[]): DisplayFieldValue | null {
    const normalizedNames = names.map(normalizeFieldName);
    for (const name of normalizedNames) {
        const match = values.find(item => item.name === name && item.value !== '');
        if (match) return match;
    }
    return null;
}

function strongIdentityCandidate(
    keyword: string,
    lookup: any,
    values: DisplayFieldValue[],
    dataLines: string[],
): DisplayFieldValue | null {
    const generic = referenceIndex.definitionKeywords?.generic?.[keyword];
    if (generic) {
        const exact = values.find(item =>
            item.cardIndex === Number(generic.cardIndex)
            && item.fieldIndex === Number(generic.fieldIndex)
        );
        if (exact) return exact;
        const byName = firstValue(values, [generic.fieldName]);
        if (byName) return byName;
    }

    for (const rule of FAMILY_ID_FIELDS) {
        if (!rule.test.test(keyword)) continue;
        const match = firstValue(values, rule.fields);
        if (match) return match;
    }

    if (/(?:^|_)ID(?:_|$)/.test(keyword)) {
        const explicitId = firstValue(values, ['ID']);
        if (explicitId) return explicitId;
    }

    if (!lookup) return null;
    const cards = getRenderedCardsForLookup(
        lookup,
        dataLines,
        Math.max(1, values.length),
    );
    for (const item of values) {
        const field = cards[item.cardIndex - 1]?.[item.fieldIndex];
        if (field?.di === 'reference') continue;
        if (field?.di === 'self') return item;
        const help = String(field?.h || '').toLowerCase();
        if (!/(?:id|identifier|identification)$/.test(item.name.toLowerCase()) && item.name !== 'ID') {
            continue;
        }
        if (/defined in|reference(?:s| to)?|see \*|load curve|table id|part id,? see/i.test(help)) {
            continue;
        }
        if (/unique|identification|identifier|identifies this|identification number/i.test(help)) {
            return item;
        }
    }
    return null;
}

function engineeringSignature(keyword: string, values: DisplayFieldValue[]): DisplayFieldValue[] {
    if (keyword.startsWith('CONTACT_')) {
        const slave = firstValue(values, ['SSID', 'SLAVE', 'SLAVE ID']);
        const master = firstValue(values, ['MSID', 'MASTER', 'MASTER ID']);
        return [slave, master].filter(Boolean) as DisplayFieldValue[];
    }
    if (keyword === 'CONTROL_TERMINATION') {
        const endTime = firstValue(values, ['ENDTIM']);
        return endTime ? [endTime] : [];
    }
    if (/^DATABASE_(?:BINARY_)?D3PLOT/.test(keyword)) {
        const interval = firstValue(values, ['DT']);
        return interval ? [interval] : [];
    }
    return [];
}

function summarizeKeywordIdentity(
    rawKeyword: string,
    dataLines: string[],
    options: {
        schema?: any;
        lookup?: any;
        dataLineCount?: number;
        longFormat?: boolean;
        percentFormat?: boolean;
    } = {},
): KeywordDisplayIdentity {
    const keyword = normalizeKeyword(rawKeyword);
    const dataLineCount = Number.isFinite(options.dataLineCount)
        ? Math.max(0, Number(options.dataLineCount))
        : dataLines.length;
    const schema = options.schema || loadKeywordLayoutSchema();
    const lookup = Object.prototype.hasOwnProperty.call(options, 'lookup')
        ? options.lookup
        : lookupKeywordSchema(keyword, schema);
    const syntheticTitle = splitSyntheticTitleCard(keyword, dataLines, lookup);
    const { values } = collectFieldValues(keyword, syntheticTitle.schemaDataLines, schema, {
        ...options,
        lookup,
    });
    const canonicalKeyword = lookup?.canonicalName || keyword;
    const base: KeywordDisplayIdentity = {
        kind: 'keyword',
        keyword,
        canonicalKeyword,
        dataLineCount,
        confidence: lookup ? 'schema' : 'fallback',
    };

    if (keyword === 'TITLE') {
        const title = compactText(dataLines[0] || '');
        return title ? { ...base, kind: 'named', title, confidence: 'verified' } : base;
    }

    if (keyword.startsWith('INCLUDE')) {
        const includePath = compactText(dataLines[0] || '');
        return includePath
            ? { ...base, kind: 'named', path: includePath, title: includePath, confidence: 'verified' }
            : base;
    }

    const titleValue = firstValue(values, TITLE_FIELD_PRIORITY);
    const identityValue = strongIdentityCandidate(
        keyword,
        lookup,
        values,
        syntheticTitle.schemaDataLines,
    );
    const title = syntheticTitle.title || titleValue?.value || '';
    if (title) {
        return {
            ...base,
            kind: 'named',
            title,
            ...(identityValue ? { identity: { field: identityValue.name, value: identityValue.value } } : {}),
            confidence: 'verified',
        };
    }

    if (identityValue) {
        return {
            ...base,
            kind: 'identified',
            identity: { field: identityValue.name, value: identityValue.value },
            confidence: 'verified',
        };
    }

    if (/^MAT(?:_|$)/.test(keyword)) {
        const firstCard = lookup && getRenderedCardsForLookup(lookup, syntheticTitle.schemaDataLines, 1)[0];
        const knownMid = Array.isArray(firstCard) && firstCard.some(field => normalizeFieldName(field.n) === 'MID');
        return { ...base, missingIdentity: { field: 'MID', status: knownMid && syntheticTitle.schemaDataLines.length ? 'empty' : 'unresolved' } };
    }

    const signature = engineeringSignature(keyword, values);
    if (signature.length > 0) {
        return {
            ...base,
            kind: 'signature',
            signature: signature.map(item => ({ field: item.name, value: item.value })),
            confidence: 'verified',
        };
    }

    if (keyword === 'NODE' || keyword.startsWith('NODE_') || keyword === 'ELEMENT' || keyword.startsWith('ELEMENT_')) {
        return {
            ...base,
            kind: 'collection',
            collection: { kind: 'data-lines', count: dataLineCount },
            confidence: 'verified',
        };
    }

    if (keyword.startsWith('PARAMETER')) {
        return {
            ...base,
            kind: 'collection',
            collection: { kind: 'definitions', count: dataLineCount },
            confidence: 'verified',
        };
    }

    return base;
}

function createKeywordIdentityAccumulator(
    rawKeyword: string,
    options: {
        schema?: any;
        lookup?: any;
        longFormat?: boolean;
        percentFormat?: boolean;
        maxDataLines?: number;
        maxBytes?: number;
    } = {},
): IdentityAccumulator {
    const dataLines: string[] = [];
    let capturedBytes = 0;
    const maxDataLines = Math.max(1, Number(options.maxDataLines) || MAX_CAPTURED_DATA_LINES);
    const maxBytes = Math.max(256, Number(options.maxBytes) || MAX_CAPTURED_BYTES);

    return {
        acceptLine(line) {
            if (dataLines.length >= maxDataLines || capturedBytes >= maxBytes) return false;
            const text = Buffer.isBuffer(line) ? line.toString('utf8') : String(line || '');
            if (isCommentOrBlank(text)) return false;
            const remaining = maxBytes - capturedBytes;
            const clipped = Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8');
            if (!clipped) return false;
            dataLines.push(clipped);
            capturedBytes += Buffer.byteLength(clipped, 'utf8');
            return true;
        },
        isCaptureComplete() {
            return dataLines.length >= maxDataLines || capturedBytes >= maxBytes;
        },
        finish(metadata = {}) {
            return summarizeKeywordIdentity(rawKeyword, dataLines, {
                ...options,
                dataLineCount: Number.isFinite(metadata.dataLineCount)
                    ? Number(metadata.dataLineCount)
                    : dataLines.length,
            });
        },
    };
}

function createKeywordIdentityAccumulatorFactory(options: { schema?: any } = {}) {
    const schema = options.schema || loadKeywordLayoutSchema();
    let globalInputFormat = 'standard';
    const lookupCache = new Map();

    return function createAccumulator(block: any, keywordLineText = ''): IdentityAccumulator {
        const rawToken = String(block?.rawKeyword || block?.keyword || keywordLineText || '');
        const keyword = normalizeKeyword(rawToken);
        const line = Buffer.isBuffer(keywordLineText)
            ? keywordLineText.toString('utf8')
            : String(keywordLineText || rawToken);

        if (keyword === 'KEYWORD') {
            globalInputFormat = globalInputFormatFromKeywordLine(line, globalInputFormat);
        }

        if (!lookupCache.has(keyword)) {
            lookupCache.set(keyword, lookupKeywordSchema(keyword, schema));
        }

        const inputFormat = keywordInputFormat(line, globalInputFormat);
        return createKeywordIdentityAccumulator(keyword, {
            schema,
            lookup: lookupCache.get(keyword),
            longFormat: inputFormat === 'long',
            percentFormat: inputFormat === 'i10',
        });
    };
}

module.exports = {
    MAX_CAPTURED_BYTES,
    MAX_CAPTURED_DATA_LINES,
    compactText,
    createKeywordIdentityAccumulator,
    createKeywordIdentityAccumulatorFactory,
    loadKeywordLayoutSchema,
    normalizeKeyword,
    summarizeKeywordIdentity,
};

export {};
