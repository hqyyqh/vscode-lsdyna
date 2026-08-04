import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { classifyKeywordLine } from './parser/keywordLine';
import {
    classifyParameterKeyword,
    type ParameterDefinitionOptions,
} from './parser/parameterSyntax';

export type KeywordField = {
    n: string;
    p?: number;
    w?: number;
    h?: string;
    t?: string;
    d?: unknown;
    e?: unknown[];
    active?: string;
    ref?: {
        targetKinds?: string[];
        label?: string;
        allowSignedSwitch?: boolean;
    };
};

export type KeywordCard = KeywordField[];

export type TextCardMetadata = {
    name: string;
    f: Array<Pick<KeywordField, 'n' | 'p' | 'w' | 't'>>;
};

export type KeywordOption = {
    n: string;
    co: string;
    to?: number;
    c: KeywordCard[];
    active?: string;
};

export type KeywordEntry = {
    c: KeywordCard[];
    r?: number;
    o?: KeywordOption[];
    a?: string[];
    v?: Record<string, { active?: string[] }>;
    x?: string;
    active?: string[];
    tc?: TextCardMetadata[];
};

export type KeywordSchema = Record<string, KeywordEntry>;

export type KeywordLookup = {
    inputName: string;
    canonicalName: string;
    entry: KeywordEntry;
    activeOptions: string[];
};

type FieldHelpDelta = {
    formatVersion: number;
    baseSha256: string;
    sourceLocalizedSha256: string;
    helpSlotCount: number;
    localizedCount: number;
    values: Array<string | null>;
};

type FieldHelpLocalizationState = {
    state: 'unloaded' | 'loaded' | 'unavailable';
    reason?: string;
    helpSlotCount: number;
    localizedCount: number;
};

const FIELD_HELP_DELTA_FORMAT_VERSION = 1;
const FIELD_HELP_DELTA_FILE = 'field_help_zh.delta.json.gz';

let schemaCache: KeywordSchema | undefined;
let schemaSha256 = '';
let localizedHelpCache = new WeakMap<object, string>();
let localizationState: FieldHelpLocalizationState = {
    state: 'unloaded',
    helpSlotCount: 0,
    localizedCount: 0,
};

function normalizeKeywordName(name: string): string {
    return String(name || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

/**
 * True when a *KEYWORD line requests LS-DYNA "long" format, where fixed-column
 * field widths double (I8→I16, I10→I20). The schema hard-codes short-format
 * widths, so callers use this to bail out of column-based cell editing / alignment
 * rather than rewrite the line against the wrong widths.
 *
 * Long format is signalled two ways:
 * - a `+` immediately after the keyword token, e.g. `*NODE+` / `*ELEMENT_SHELL+`;
 * - a `LONG=Y` / `LONG=S` option on `*KEYWORD`, e.g. `*KEYWORD LONG=Y`.
 *
 * @param {string} keywordLineText Raw text of the `*KEYWORD` line.
 * @returns {boolean}
 */
export function isLongFormatKeyword(keywordLineText: string): boolean {
    const raw = String(keywordLineText || '').trim();
    if (!raw.startsWith('*')) return false;
    // Keyword token = up to first whitespace/comma. A trailing '+' on the token
    // itself is the per-keyword long-format marker.
    const token = raw.split(/[\s,]/)[0];
    if (token.endsWith('+')) return true;
    // *KEYWORD LONG=Y / LONG=S (whitespace- or comma-separated option).
    return /\bLONG\s*=\s*[YS]\b/i.test(raw);
}

function schemaDir(): string {
    return path.join(__dirname, '..', '..', 'keywords');
}

function runtimeDataDir(): string {
    return path.join(__dirname, '..', 'runtime');
}

function sha256(value: string | Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function loadEnglishSchema(): KeywordSchema {
    if (!schemaCache) {
        const text = fs.readFileSync(path.join(schemaDir(), 'field_data.json'), 'utf8');
        schemaCache = JSON.parse(text);
        schemaSha256 = sha256(Buffer.from(text, 'utf8'));
    }
    return schemaCache;
}

function visitHelpSlots(node: unknown, visit: (owner: object, englishHelp: string, index: number) => void): number {
    let index = 0;

    function walk(value: unknown): void {
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        if (!value || typeof value !== 'object') {
            return;
        }
        for (const key of Object.keys(value)) {
            const child = (value as Record<string, unknown>)[key];
            if (key === 'h' && typeof child === 'string') {
                visit(value, child, index);
                index++;
            } else {
                walk(child);
            }
        }
    }

    walk(node);
    return index;
}

export function decodeFieldHelpDelta(encoded: Buffer): FieldHelpDelta {
    return JSON.parse(zlib.gunzipSync(encoded).toString('utf8'));
}

export function buildLocalizedHelpCache(
    schema: KeywordSchema,
    baseSha256: string,
    delta: FieldHelpDelta,
): { cache: WeakMap<object, string>; helpSlotCount: number; localizedCount: number } {
    if (!delta || delta.formatVersion !== FIELD_HELP_DELTA_FORMAT_VERSION) {
        throw new Error(`unsupported field-help delta format ${delta?.formatVersion}`);
    }
    if (delta.baseSha256 !== baseSha256) {
        throw new Error('field-help delta base hash does not match field_data.json');
    }
    if (!Array.isArray(delta.values)) {
        throw new Error('field-help delta values must be an array');
    }
    if (!Number.isSafeInteger(delta.helpSlotCount) || delta.helpSlotCount !== delta.values.length) {
        throw new Error('field-help delta slot count does not match its values');
    }
    if (delta.values.some(value => value !== null && (typeof value !== 'string' || value.length === 0))) {
        throw new Error('field-help delta contains an invalid localized value');
    }
    const declaredLocalizedCount = delta.values.reduce(
        (count, value) => count + (value === null ? 0 : 1),
        0,
    );
    if (!Number.isSafeInteger(delta.localizedCount) || delta.localizedCount !== declaredLocalizedCount) {
        throw new Error('field-help delta localized count does not match its values');
    }

    const nextCache = new WeakMap<object, string>();
    const visited = visitHelpSlots(schema, (owner, _englishHelp, index) => {
        const localized = delta.values[index];
        if (typeof localized === 'string') {
            nextCache.set(owner, localized);
        }
    });
    if (visited !== delta.helpSlotCount) {
        throw new Error(`field-help delta has ${delta.helpSlotCount} slots but schema has ${visited}`);
    }
    return {
        cache: nextCache,
        helpSlotCount: visited,
        localizedCount: declaredLocalizedCount,
    };
}

function ensureLocalizedFieldHelp(): void {
    if (localizationState.state !== 'unloaded') {
        return;
    }
    const schema = loadEnglishSchema();
    try {
        const encoded = fs.readFileSync(path.join(runtimeDataDir(), FIELD_HELP_DELTA_FILE));
        const applied = buildLocalizedHelpCache(schema, schemaSha256, decodeFieldHelpDelta(encoded));
        localizedHelpCache = applied.cache;
        localizationState = {
            state: 'loaded',
            helpSlotCount: applied.helpSlotCount,
            localizedCount: applied.localizedCount,
        };
    } catch (error) {
        localizedHelpCache = new WeakMap<object, string>();
        localizationState = {
            state: 'unavailable',
            reason: error instanceof Error ? error.message : String(error),
            helpSlotCount: 0,
            localizedCount: 0,
        };
        console.warn(`[DynaSense] Chinese field-help delta unavailable: ${localizationState.reason}`);
    }
}

export function resetKeywordSchemaCache(): void {
    schemaCache = undefined;
    schemaSha256 = '';
    localizedHelpCache = new WeakMap<object, string>();
    localizationState = {
        state: 'unloaded',
        helpSlotCount: 0,
        localizedCount: 0,
    };
}

export function loadKeywordSchema(getLanguage: () => string = () => 'en'): KeywordSchema {
    const language = (getLanguage() || 'en').toLowerCase();
    const schema = loadEnglishSchema();
    if (language === 'zh-cn') {
        ensureLocalizedFieldHelp();
    }
    return schema;
}

export function getLocalizedFieldHelp(field: object | null | undefined): string | null {
    if (!field || typeof field !== 'object') {
        return null;
    }
    ensureLocalizedFieldHelp();
    return localizedHelpCache.get(field) || null;
}

export function getFieldHelpLocalizationState(): FieldHelpLocalizationState {
    return { ...localizationState };
}

function optionName(option: KeywordOption): string {
    return normalizeKeywordName(option.n);
}

function titleOptions(entry: KeywordEntry): KeywordOption[] {
    return (entry.o || []).filter(option => (option.to || 0) > 0);
}

function splitOptionName(name: string): string[] {
    return normalizeKeywordName(name).split('_').filter(Boolean);
}

function inferActiveOptionsFromSuffix(entry: KeywordEntry, suffix: string): string[] | null {
    const suffixTokens = splitOptionName(suffix);
    if (suffixTokens.length === 0) {
        return [];
    }

    const options = titleOptions(entry).slice().sort((a, b) => splitOptionName(b.n).length - splitOptionName(a.n).length);
    const active: string[] = [];
    let cursor = 0;

    while (cursor < suffixTokens.length) {
        const match = options.find(option => {
            const candidate = splitOptionName(option.n);
            return candidate.length > 0 && candidate.every((token, index) => suffixTokens[cursor + index] === token);
        });
        if (!match) {
            return null;
        }
        active.push(optionName(match));
        cursor += splitOptionName(match.n).length;
    }

    return active;
}

function findAliasCanonical(name: string, schema: KeywordSchema): string | null {
    for (const [keyword, entry] of Object.entries(schema)) {
        if ((entry.a || []).map(normalizeKeywordName).includes(name)) {
            return keyword;
        }
        if (entry.x && normalizeKeywordName(keyword) === name) {
            return normalizeKeywordName(entry.x);
        }
    }
    return null;
}

function makeLookup(inputName: string, matchedName: string, schema: KeywordSchema, activeOptions: string[] = []): KeywordLookup {
    const matchedEntry = schema[matchedName];
    const canonicalName = matchedEntry.x && schema[normalizeKeywordName(matchedEntry.x)]
        ? normalizeKeywordName(matchedEntry.x)
        : matchedName;
    const canonicalEntry = schema[canonicalName] || matchedEntry;
    const active = matchedEntry.active || activeOptions;

    return {
        inputName,
        canonicalName,
        entry: canonicalEntry,
        activeOptions: active.map(normalizeKeywordName),
    };
}

const PARAMETER_OPTION_ENTRIES: KeywordOption[] = [
    { n: 'LOCAL', co: 'title/1', to: 1, c: [] },
    { n: 'MUTABLE', co: 'title/2', to: 2, c: [] },
    { n: 'NOECHO', co: 'title/3', to: 3, c: [] },
];

const PARAMETER_MANUAL_HELP: Record<string, Record<string, string>> = {
    PARAMETER: {
        PRMR: 'The first character selects R (real), I (integer), or C (character). The remaining parameter name is 1-9 letters, digits, or underscores; its first character cannot be a digit. TIME (case-insensitive) and names reserved in Appendix U are not allowed.',
        VAL: 'Defines a real number, integer, or character string consistent with the type selected in PRMR.',
    },
    PARAMETER_EXPRESSION: {
        PRMR: 'The first character selects R (real), I (integer), or C (character). The remaining parameter name is 1-9 letters, digits, or underscores; its first character cannot be a digit. TIME (case-insensitive) and names reserved in Appendix U are not allowed.',
        EXPRESSION: 'General algebraic expression stored in PRMR. Previously defined parameters may be referenced with or without a leading &. Continue an expression by leaving the first 10 columns of the next line blank (20 columns in long format). Character expressions are stored as strings.',
    },
    PARAMETER_TYPE: {
        PRMR: 'Defines an integer parameter. The first character must be I; the remaining parameter name is 1-9 letters, digits, or underscores and cannot start with a digit.',
        VAL: 'Integer value assigned to the parameter.',
        PRTYP: 'LS-PrePost usage metadata describing the ID represented by VAL. LS-DYNA ignores PRTYP; it is used when LS-PrePost combines keyword decks and applies ID offsets.',
    },
};

function parameterFieldHelp(canonicalName: string, fieldName: string): string | null {
    const family = PARAMETER_MANUAL_HELP[canonicalName];
    if (!family) return null;
    const normalizedField = normalizeFieldLabel(fieldName).replace(/[1-4]$/, '');
    return family[normalizedField] || null;
}

function manualAuthoritativeParameterEntry(
    canonicalName: string,
    source: KeywordEntry,
    supportsOptions: boolean,
): KeywordEntry {
    return {
        ...source,
        c: (source.c || []).map(card => card.map(field => ({
            ...field,
            h: parameterFieldHelp(canonicalName, field.n) || field.h,
        }))),
        ...(supportsOptions ? { o: PARAMETER_OPTION_ENTRIES } : {}),
    };
}

function lookupParameterFamily(inputName: string, schema: KeywordSchema): KeywordLookup | null {
    const classification = classifyParameterKeyword(`*${inputName}`);
    if (!classification || classification.kind === 'scope-control') return null;
    let canonicalName: string;
    if (classification.kind === 'duplication') {
        canonicalName = 'PARAMETER_DUPLICATION';
    } else if (classification.kind === 'parameter-type') {
        canonicalName = 'PARAMETER_TYPE';
    } else {
        canonicalName = classification.expression ? 'PARAMETER_EXPRESSION' : 'PARAMETER';
    }
    const source = schema[canonicalName];
    if (!source) return null;
    const activeOptions = classification.kind === 'definition'
        ? ['LOCAL', 'MUTABLE', 'NOECHO'].filter(option =>
            classification.options[option.toLowerCase() as keyof ParameterDefinitionOptions]
        )
        : [];
    return {
        inputName,
        canonicalName,
        entry: manualAuthoritativeParameterEntry(
            canonicalName,
            source,
            classification.kind === 'definition',
        ),
        activeOptions,
    };
}

export function lookupKeywordSchema(name: string, schema: KeywordSchema = loadKeywordSchema()): KeywordLookup | null {
    const inputName = normalizeKeywordName(name);
    if (!inputName) {
        return null;
    }

    const parameterLookup = lookupParameterFamily(inputName, schema);
    if (parameterLookup) return parameterLookup;

    if (schema[inputName]) {
        return makeLookup(inputName, inputName, schema);
    }

    const aliasCanonical = findAliasCanonical(inputName, schema);
    if (aliasCanonical && schema[aliasCanonical]) {
        return makeLookup(inputName, aliasCanonical, schema);
    }

    const tokens = inputName.split('_');
    for (let length = tokens.length - 1; length >= 1; length--) {
        const candidate = tokens.slice(0, length).join('_');
        if (!schema[candidate]) {
            continue;
        }

        const suffix = tokens.slice(length).join('_');
        // Only accept a prefix match when the entire leftover suffix maps to known
        // title/options (e.g. _ID, _MPP, _TITLE). Partial matches such as
        // CONTACT_..._ID + leftover OFFSET must not count as recognized — otherwise
        // hover shows a known-keyword card while validation correctly flags unknown.
        const activeOptions = inferActiveOptionsFromSuffix(schema[candidate], suffix);
        if (activeOptions === null) {
            continue;
        }
        return makeLookup(inputName, candidate, schema, activeOptions);
    }

    return null;
}

function parseCardOrder(cardOrder: string): { position: string; index: number } {
    const [position, rawIndex] = String(cardOrder || '').split('/');
    const index = Number.parseInt(rawIndex, 10);
    return {
        position,
        index: Number.isFinite(index) ? index : 0,
    };
}

function renderSelectedOptions(baseCards: KeywordCard[], options: KeywordOption[]): KeywordCard[] {
    const pre: Array<{ index: number; option: KeywordOption }> = [];
    const main: Array<{ index: number; option: KeywordOption }> = [];
    const post: Array<{ index: number; option: KeywordOption }> = [];

    for (const option of options) {
        const order = parseCardOrder(option.co);
        const item = { index: order.index, option };
        if (order.position === 'pre') {
            pre.push(item);
        } else if (order.position === 'main') {
            main.push(item);
        } else {
            post.push(item);
        }
    }

    const rendered: KeywordCard[] = [];
    pre.sort((a, b) => a.index - b.index).forEach(item => rendered.push(...item.option.c));
    rendered.push(...baseCards);

    let inserted = 0;
    main.sort((a, b) => a.index - b.index).forEach(item => {
        const insertAt = Math.max(0, Math.min(rendered.length, item.index + 1 + inserted));
        rendered.splice(insertAt, 0, ...item.option.c);
        inserted += item.option.c.length;
    });

    post.sort((a, b) => a.index - b.index).forEach(item => rendered.push(...item.option.c));
    return rendered;
}

function postOptions(entry: KeywordEntry, selectedNames: Set<string>): KeywordOption[] {
    return (entry.o || [])
        .filter(option => !selectedNames.has(optionName(option)))
        .filter(option => parseCardOrder(option.co).position === 'post')
        .sort((a, b) => parseCardOrder(a.co).index - parseCardOrder(b.co).index);
}

function normalizeFieldLabel(value: string): string {
    return normalizeKeywordName(value).replace(/^_/, '');
}

function cardHeaderScore(card: KeywordCard, labels: string[]): number {
    if (labels.length === 0 || card.length === 0) {
        return 0;
    }

    const fieldNames = new Set(card.map(field => normalizeFieldLabel(field.n)));
    let score = 0;
    for (const label of labels) {
        if (fieldNames.has(label)) {
            score++;
        }
    }

    if (score === 0) {
        return 0;
    }

    const firstField = normalizeFieldLabel(card[0].n);
    if (labels[0] === firstField) {
        score += 1;
    }
    return score;
}

function renderHeaderCandidateCards(entry: KeywordEntry, activeOptions: string[]): KeywordCard[] {
    const selectedNames = new Set(activeOptions.map(normalizeKeywordName));
    for (const option of postOptions(entry, selectedNames)) {
        selectedNames.add(optionName(option));
    }

    const selectedOptions = (entry.o || []).filter(option => selectedNames.has(optionName(option)));
    return renderSelectedOptions(entry.c || [], selectedOptions);
}

function findCardByCommentHeader(entry: KeywordEntry, activeOptions: string[], labels: string[]): KeywordCard | null {
    const info = findCardInfoByCommentHeader(entry, activeOptions, labels);
    return info ? info.card : null;
}

function findCardInfoByCommentHeader(entry: KeywordEntry, activeOptions: string[], labels: string[]): { card: KeywordCard; cardIndex: number } | null {
    const candidates = renderHeaderCandidateCards(entry, activeOptions);
    let bestCard: KeywordCard | null = null;
    let bestScore = 0;
    let bestIndex = -1;

    for (let index = 0; index < candidates.length; index++) {
        const card = candidates[index];
        const score = cardHeaderScore(card, labels);
        if (score > bestScore) {
            bestScore = score;
            bestCard = card;
            bestIndex = index;
        }
    }

    const minimumScore = Math.max(2, Math.ceil(labels.length * 0.6));
    return bestScore >= minimumScore && bestCard ? { card: bestCard, cardIndex: bestIndex + 1 } : null;
}

function expandRepeatingCards(cards: KeywordCard[], observedDataLineCount?: number): KeywordCard[] {
    if (!observedDataLineCount || cards.length === 0 || cards.length >= observedDataLineCount) {
        return cards;
    }

    const expanded = cards.slice();
    const last = cards[cards.length - 1];
    while (expanded.length < observedDataLineCount) {
        expanded.push(last);
    }
    return expanded;
}

export function getRenderedCards(
    entry: KeywordEntry,
    activeOptions: string[] = [],
    observedDataLineCount?: number,
): KeywordCard[] {
    const selectedNames = new Set(activeOptions.map(normalizeKeywordName));
    const selectedOptions = (entry.o || []).filter(option => selectedNames.has(optionName(option)));
    let rendered = renderSelectedOptions(entry.c || [], selectedOptions);

    if (observedDataLineCount) {
        for (const option of postOptions(entry, selectedNames)) {
            if (rendered.length >= observedDataLineCount) {
                break;
            }
            selectedNames.add(optionName(option));
            selectedOptions.push(option);
            rendered = renderSelectedOptions(entry.c || [], selectedOptions);
        }
    }

    // entry.r: last card is an explicit table/series row.
    // Single rendered card (typical *ELEMENT_MASS / *NODE style): also treat extra
    // data lines as repeats — many pydyna schemas omit r for one-card keywords.
    if (entry.r || rendered.length === 1) {
        rendered = expandRepeatingCards(rendered, observedDataLineCount);
    }

    return rendered;
}

function keywordLineName(lineText: string): string {
    const trimmed = lineText.trim();
    return normalizeKeywordName(trimmed.startsWith('*') ? trimmed.slice(1) : trimmed);
}

function parseCommentHeaderLabels(lineText: string): string[] {
    const trimmed = lineText.trimStart();
    if (!trimmed.startsWith('$#')) {
        return [];
    }

    return trimmed
        .slice(2)
        .trim()
        .split(/\s+/)
        .map(normalizeFieldLabel)
        .filter(Boolean);
}

function previousCommentHeaderLabels(document: any, keywordLine: number, lineNum: number): string[] {
    for (let index = lineNum - 1; index > keywordLine; index--) {
        const text = document.lineAt(index).text;
        const trimmed = text.trimStart();
        if (trimmed.startsWith('$#')) {
            return parseCommentHeaderLabels(text);
        }
        if (trimmed.startsWith('$')) {
            continue;
        }
        return [];
    }
    return [];
}

function countDataLinesThrough(document: any, keywordLine: number, lineNum: number): number {
    let count = 0;
    for (let index = keywordLine + 1; index <= lineNum; index++) {
        const text = document.lineAt(index).text.trimStart();
        if (text.startsWith('$')) {
            continue;
        }
        count++;
    }
    return count;
}

function cardMatchesTextSignature(card: KeywordCard, signature: TextCardMetadata['f']): boolean {
    return card.length === signature.length && card.every((field, index) => {
        const expected = signature[index];
        return field.n === expected.n
            && field.p === expected.p
            && field.w === expected.w
            && field.t === expected.t;
    });
}

function findTextCard(entry: KeywordEntry, rendered: KeywordCard[]): { card: KeywordCard; cardIndex: number } | null {
    for (const metadata of entry.tc || []) {
        const index = rendered.findIndex(card => cardMatchesTextSignature(card, metadata.f));
        if (index >= 0) {
            return { card: rendered[index], cardIndex: index + 1 };
        }
    }
    return null;
}

function nonCommentDataLinesBefore(document: any, keywordLine: number, lineNum: number): number {
    let count = 0;
    for (let index = keywordLine + 1; index < lineNum; index++) {
        if (!document.lineAt(index).text.trimStart().startsWith('$')) {
            count++;
        }
    }
    return count;
}

export type GetCardInfoOptions = {
    /**
     * Resolve cards for this keyword name instead of the enclosing keyword line text.
     * Used when the typed keyword is unknown but a high-confidence similar keyword was chosen.
     */
    keywordOverride?: string | null;
};

export function getCardInfoForDocumentLine(
    document: any,
    lineNum: number,
    schema: KeywordSchema = loadKeywordSchema(),
    options: GetCardInfoOptions = {},
): { card: KeywordCard; cardIndex: number; keywordName: string; activeOptions: string[]; isTextCard?: boolean } | null {
    if (!document || lineNum < 0 || lineNum >= document.lineCount) {
        return null;
    }

    const currentText = document.lineAt(lineNum).text;
    if (classifyKeywordLine(currentText).isKeyword) {
        return null;
    }

    let keywordLine: number | null = null;
    for (let index = lineNum - 1; index >= 0; index--) {
        const text = document.lineAt(index).text;
        if (classifyKeywordLine(text).isKeyword) {
            keywordLine = index;
            break;
        }
    }
    if (keywordLine === null) {
        return null;
    }

    const typedName = keywordLineName(document.lineAt(keywordLine).text);
    const resolveName = options.keywordOverride
        ? normalizeKeywordName(options.keywordOverride)
        : typedName;
    const lookup = lookupKeywordSchema(resolveName, schema);
    if (!lookup) {
        return null;
    }

    const renderedForTextCard = getRenderedCards(lookup.entry, lookup.activeOptions);
    const textCard = findTextCard(lookup.entry, renderedForTextCard);
    if (textCard && nonCommentDataLinesBefore(document, keywordLine, lineNum) >= textCard.cardIndex - 1) {
        return {
            ...textCard,
            keywordName: lookup.inputName || resolveName,
            activeOptions: lookup.activeOptions,
            isTextCard: true,
        };
    }

    if (currentText.trimStart().startsWith('$')) {
        return null;
    }

    const headerLabels = previousCommentHeaderLabels(document, keywordLine, lineNum);
    const headerInfo = findCardInfoByCommentHeader(lookup.entry, lookup.activeOptions, headerLabels);
    if (headerInfo) {
        return {
            ...headerInfo,
            // Prefer the resolved (override/canonical) name for help/ref metadata.
            keywordName: lookup.inputName || resolveName,
            activeOptions: lookup.activeOptions,
        };
    }

    const observedDataLineCount = countDataLinesThrough(document, keywordLine, lineNum);
    if (observedDataLineCount <= 0) {
        return null;
    }

    const rendered = getRenderedCards(lookup.entry, lookup.activeOptions, observedDataLineCount);
    const card = rendered[observedDataLineCount - 1] || null;
    return card ? {
        card,
        cardIndex: observedDataLineCount,
        keywordName: lookup.inputName || resolveName,
        activeOptions: lookup.activeOptions,
    } : null;
}

export function getCardForDocumentLine(
    document: any,
    lineNum: number,
    schema: KeywordSchema = loadKeywordSchema(),
    options: GetCardInfoOptions = {},
): KeywordCard | null {
    const info = getCardInfoForDocumentLine(document, lineNum, schema, options);
    return info ? info.card : null;
}
