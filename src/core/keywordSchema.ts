import * as fs from 'fs';
import * as path from 'path';
import { classifyKeywordLine } from './parser/keywordLine';

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
};

export type KeywordSchema = Record<string, KeywordEntry>;

export type KeywordLookup = {
    inputName: string;
    canonicalName: string;
    entry: KeywordEntry;
    activeOptions: string[];
};

let schemaCache = new Map<string, KeywordSchema>();

function normalizeKeywordName(name: string): string {
    return String(name || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function schemaDir(): string {
    return path.join(__dirname, '..', '..', 'keywords');
}

function readSchemaFile(fileName: string): KeywordSchema {
    const filePath = path.join(schemaDir(), fileName);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function mergeLocalizedSchema(base: KeywordSchema, localized: KeywordSchema): KeywordSchema {
    const merged: KeywordSchema = { ...base };
    for (const [key, localizedEntry] of Object.entries(localized)) {
        const baseEntry = base[key] || { c: [] };
        merged[key] = { ...baseEntry, ...localizedEntry };
    }
    return merged;
}

export function resetKeywordSchemaCache(): void {
    schemaCache = new Map<string, KeywordSchema>();
}

export function loadKeywordSchema(getLanguage: () => string = () => 'en'): KeywordSchema {
    const language = (getLanguage() || 'en').toLowerCase();
    if (schemaCache.has(language)) {
        return schemaCache.get(language) as KeywordSchema;
    }

    const english = readSchemaFile('field_data.json');
    let schema = english;
    if (language === 'zh-cn') {
        try {
            schema = mergeLocalizedSchema(english, readSchemaFile('field_data_zh.json'));
        } catch {
            schema = english;
        }
    }

    schemaCache.set(language, schema);
    return schema;
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

export function lookupKeywordSchema(name: string, schema: KeywordSchema = loadKeywordSchema()): KeywordLookup | null {
    const inputName = normalizeKeywordName(name);
    if (!inputName) {
        return null;
    }

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
        const activeOptions = inferActiveOptionsFromSuffix(schema[candidate], suffix);
        return makeLookup(inputName, candidate, schema, activeOptions || []);
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

    if (entry.r) {
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

export function getCardInfoForDocumentLine(
    document: any,
    lineNum: number,
    schema: KeywordSchema = loadKeywordSchema(),
): { card: KeywordCard; cardIndex: number; keywordName: string; activeOptions: string[] } | null {
    if (!document || lineNum < 0 || lineNum >= document.lineCount) {
        return null;
    }

    const currentText = document.lineAt(lineNum).text;
    if (classifyKeywordLine(currentText).isKeyword || currentText.trimStart().startsWith('$')) {
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

    const lookup = lookupKeywordSchema(keywordLineName(document.lineAt(keywordLine).text), schema);
    if (!lookup) {
        return null;
    }

    const headerLabels = previousCommentHeaderLabels(document, keywordLine, lineNum);
    const headerInfo = findCardInfoByCommentHeader(lookup.entry, lookup.activeOptions, headerLabels);
    if (headerInfo) {
        return {
            ...headerInfo,
            keywordName: lookup.inputName,
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
        keywordName: lookup.inputName,
        activeOptions: lookup.activeOptions,
    } : null;
}

export function getCardForDocumentLine(
    document: any,
    lineNum: number,
    schema: KeywordSchema = loadKeywordSchema(),
): KeywordCard | null {
    const info = getCardInfoForDocumentLine(document, lineNum, schema);
    return info ? info.card : null;
}
