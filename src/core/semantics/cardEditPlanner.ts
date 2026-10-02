import * as crypto from 'crypto';

import {
    getRenderedCardsForLookup,
    getVerifiedPrefixLayout,
    type KeywordCard,
    type KeywordEntry,
    type KeywordField,
    type KeywordSchema,
    lookupKeywordSchema,
} from '../keywordSchema';
import {
    keywordInputFormat,
    type KeywordInputFormatMode,
} from '../parser/inputFormat';
import { classifyKeywordLine, isKeywordCommentLine } from '../parser/keywordLine';
import {
    getManualSemanticCatalog,
    normalizeSemanticKeyword,
} from './manualSemanticCatalog';
import {
    evaluatePredicate,
    type TriState,
} from './predicateEvaluator';

const MAXIMUM_PHYSICAL_LINES = 256;
const TITLE_OPTION = 'TITLE';

type SemanticCatalog = {
    rulesForKeyword(keyword: string): any[];
};

type BlockBoundaryIndex = {
    lineCount?: number;
    findBlockAtLine(line: number): {
        startLine: number;
        endLine: number;
    } | null;
};

export type CardEditPlanStatus =
    | 'ready'
    | 'already-complete'
    | 'predicate-false'
    | 'predicate-indeterminate'
    | 'unsupported-format'
    | 'schema-mismatch'
    | 'missing-required-prefix'
    | 'unexpected-card-count'
    | 'truncated'
    | 'stale'
    | 'unavailable';

export type CardEditPlanCard = {
    physicalCardIndex: number;
    card: string;
    ruleId: string;
    relation: 'required-predecessor' | 'conditional';
    fieldNames: string[];
    headerText: string;
    blankText: string;
};

export type CardEditInsertion = {
    line: number;
    character: number;
    text: string;
};

export type CardEditPlan = {
    status: CardEditPlanStatus;
    reason: string;
    keyword: string;
    catalogKeyword: string;
    layoutId: string;
    ruleId: string;
    documentVersion: number | null;
    existingPhysicalCards: number | null;
    minimumExistingPhysicalCard: number | null;
    targetPhysicalCard: number | null;
    predicateState: TriState | null;
    scannedPhysicalLines: number;
    lineReads: number;
    cardsToAppend: CardEditPlanCard[];
    advisories: Array<{
        field: string;
        message: string;
        evidenceId: string;
        manualId: string;
        page: number;
    }>;
    insertion: CardEditInsertion | null;
};

export type CardEditPlannerOptions = {
    catalog?: SemanticCatalog;
    globalInputFormat?: KeywordInputFormatMode;
    maximumPhysicalLines?: number;
    blockIndex?: BlockBoundaryIndex | null;
    expectedDocumentVersion?: number;
    expectedLayoutId?: string;
    expectedRuleId?: string;
    eol?: '\n' | '\r\n';
};

type Boundary =
    | { kind: 'before-line'; line: number }
    | { kind: 'after-line'; line: number; character: number };

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: any): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`
        ).join(',')}}`;
    }
    return JSON.stringify(value);
}

function normalizedSchemaGeometry(schema: KeywordSchema, keyword: string): Array<Array<{
    name: string;
    position: number;
    width: number;
    type: string;
}>> | null {
    const key = String(keyword || '').replace(/^\*/, '').trim().toUpperCase();
    const entry = schema[key];
    if (!entry || !Array.isArray(entry.c) || entry.c.length === 0) return null;
    const geometry = [];
    for (const rawCard of entry.c) {
        if (!Array.isArray(rawCard)) return null;
        const card = [];
        for (const rawField of rawCard) {
            const name = typeof rawField?.n === 'string' ? rawField.n : '';
            const position = rawField?.p;
            const width = rawField?.w;
            const type = String(rawField?.t || '').trim().toLowerCase();
            if (!name || !Number.isInteger(position) || position < 0 ||
                !Number.isInteger(width) || width < 1 ||
                !['integer', 'real', 'string'].includes(type)) {
                return null;
            }
            card.push({ name, position, width, type });
        }
        geometry.push(card);
    }
    return geometry;
}

/** Recomputes the same reviewed core-card geometry signature as the standalone publisher. */
export function cardEditSchemaSignature(schema: KeywordSchema, keyword: string): string | null {
    const geometry = normalizedSchemaGeometry(schema, keyword);
    if (!geometry) return null;
    return crypto.createHash('sha256').update(canonicalJson(geometry), 'utf8').digest('hex');
}

function headerFieldName(field: KeywordField): string {
    const name = String(field?.n || '').trim();
    return /^(?:UNUSED|BLANK)$/i.test(name) ? '' : name.toLowerCase();
}

/** Produces the conventional `$#` header without changing the fixed card geometry. */
export function fixedWidthCardHeader(card: KeywordCard): string | null {
    if (!Array.isArray(card) || card.length === 0) return null;
    let line = '$#';
    let written = 2;
    for (const field of card) {
        if (!Number.isInteger(field?.p) || !Number.isInteger(field?.w) || field.w < 1) return null;
        const fieldEnd = field.p + field.w;
        const available = fieldEnd - written;
        if (available <= 0) return null;
        const name = headerFieldName(field).slice(0, available);
        line += name.padStart(available, ' ');
        written = fieldEnd;
    }
    return line;
}

function emptyPlan(
    status: CardEditPlanStatus,
    reason: string,
    documentVersion: number | null,
    values: Partial<CardEditPlan> = {},
): CardEditPlan {
    return {
        status,
        reason,
        keyword: '',
        catalogKeyword: '',
        layoutId: '',
        ruleId: '',
        documentVersion,
        existingPhysicalCards: null,
        minimumExistingPhysicalCard: null,
        targetPhysicalCard: null,
        predicateState: null,
        scannedPhysicalLines: 0,
        lineReads: 0,
        cardsToAppend: [],
        advisories: [],
        insertion: null,
        ...values,
    };
}

function safeDocumentVersion(document: any): number | null {
    return Number.isInteger(document?.version) ? Number(document.version) : null;
}

function normalizedStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item)) return null;
    if (new Set(value).size !== value.length) return null;
    return value.slice();
}

function reviewedLayoutRule(rules: any[]): any | null {
    const attached = (rules || []).filter(rule => isPlainObject(rule?.cardEditLayout));
    return attached.length === 1 ? attached[0] : null;
}

function validatedLayoutBasics(rule: any): any | null {
    const layout = rule?.cardEditLayout;
    const prefix = normalizedStringArray(layout?.requiredPrefixRuleIds);
    const activation = normalizedStringArray(layout?.activationRuleIds);
    const options = normalizedStringArray(layout?.allowedKeywordOptions);
    if (!isPlainObject(layout) || typeof layout.layoutId !== 'string' || !layout.layoutId ||
        typeof rule?.ruleId !== 'string' || !rule.ruleId ||
        layout.policyId !== 'official-pdf-card-edit-layout-v1' ||
        layout.mode !== 'append-contiguous-blank-suffix' ||
        layout.inputFormat !== 'standard-fixed' || layout.fieldWidth !== 10 ||
        !Number.isInteger(layout.minimumExistingPhysicalCard) ||
        !Number.isInteger(layout.targetPhysicalCard) ||
        layout.minimumExistingPhysicalCard < 1 ||
        layout.targetPhysicalCard <= layout.minimumExistingPhysicalCard ||
        prefix?.length !== layout.minimumExistingPhysicalCard || !activation || !options ||
        !activation.includes(rule.ruleId) || !isPlainObject(layout.when) ||
        typeof layout.when.field !== 'string' || !layout.when.field.trim() ||
        !Array.isArray(layout.cards) ||
        layout.cards.length !== layout.targetPhysicalCard - layout.minimumExistingPhysicalCard ||
        typeof layout.schemaSignature !== 'string' || !layout.schemaSignature) {
        return null;
    }
    return layout;
}

function titlePrefixCount(entry: KeywordEntry, activeOptions: string[], allowedOptions: string[]): number | null {
    if (activeOptions.some(option => !allowedOptions.includes(option))) return null;
    if (!activeOptions.includes(TITLE_OPTION)) return 0;
    const matches = (entry.o || []).filter(option => option.n === TITLE_OPTION);
    if (matches.length !== 1) return null;
    const title = matches[0];
    const titleField = Array.isArray(title.c?.[0]) && title.c[0].length === 1
        ? title.c[0][0]
        : null;
    if (title.co !== 'pre/1' || title.to !== 1 || !Array.isArray(title.c) || title.c.length !== 1 ||
        titleField?.n !== 'TITLE' || titleField?.p !== 0 || titleField?.w !== 80 ||
        titleField?.t !== 'string') {
        return null;
    }
    return 1;
}

function predicateFieldLocation(cards: KeywordCard[], fieldName: string): {
    dataLineOrdinal: number;
    field: KeywordField;
} | null {
    const normalized = fieldName.trim().toUpperCase();
    const matches = [];
    for (let cardOffset = 0; cardOffset < cards.length; cardOffset++) {
        for (const field of cards[cardOffset] || []) {
            if (String(field?.n || '').trim().toUpperCase() === normalized) {
                matches.push({ dataLineOrdinal: cardOffset + 1, field });
            }
        }
    }
    return matches.length === 1 ? matches[0] : null;
}

function cleanAdvisories(layout: any): CardEditPlan['advisories'] | null {
    if (!Array.isArray(layout.advisories) || layout.advisories.length === 0) return null;
    const advisories = [];
    for (const item of layout.advisories) {
        if (!isPlainObject(item) || typeof item.field !== 'string' || !item.field ||
            typeof item.message !== 'string' || !item.message || item.message.length > 280 ||
            typeof item.evidenceId !== 'string' || !item.evidenceId ||
            typeof item.manualId !== 'string' || !item.manualId ||
            !Number.isInteger(item.page) || item.page < 1) {
            return null;
        }
        advisories.push({
            field: item.field,
            message: item.message,
            evidenceId: item.evidenceId,
            manualId: item.manualId,
            page: item.page,
        });
    }
    return advisories;
}

function safeIndexedEnd(
    blockIndex: BlockBoundaryIndex | null | undefined,
    document: any,
    keywordLine: number,
): number | null {
    if (!blockIndex || typeof blockIndex.findBlockAtLine !== 'function') return null;
    if (Number.isInteger(blockIndex.lineCount) && blockIndex.lineCount !== document.lineCount) return null;
    try {
        const block = blockIndex.findBlockAtLine(keywordLine);
        if (!block || block.startLine !== keywordLine || !Number.isInteger(block.endLine) ||
            block.endLine < keywordLine || block.endLine >= document.lineCount) {
            return null;
        }
        return block.endLine;
    } catch (_error) {
        return null;
    }
}

function eolForDocument(document: any, requested?: '\n' | '\r\n'): '\n' | '\r\n' {
    if (requested === '\n' || requested === '\r\n') return requested;
    // vscode.EndOfLine.CRLF is 2; keeping the numeric check avoids a VS Code dependency.
    return document?.eol === 2 ? '\r\n' : '\n';
}

function buildCardsToAppend(
    layout: any,
    entry: KeywordEntry,
    existingPhysicalCards: number,
): CardEditPlanCard[] | null {
    const descriptorByIndex = new Map<number, any>();
    for (const descriptor of layout.cards) {
        if (!isPlainObject(descriptor) || !Number.isInteger(descriptor.physicalCardIndex) ||
            descriptor.card !== `Card ${descriptor.physicalCardIndex}` ||
            typeof descriptor.ruleId !== 'string' || !descriptor.ruleId ||
            descriptor.blankAllowed !== true || descriptorByIndex.has(descriptor.physicalCardIndex)) {
            return null;
        }
        descriptorByIndex.set(descriptor.physicalCardIndex, descriptor);
    }
    const activationIds = new Set(layout.activationRuleIds);
    const cards = [];
    for (let physicalCardIndex = existingPhysicalCards + 1;
        physicalCardIndex <= layout.targetPhysicalCard;
        physicalCardIndex++) {
        const descriptor = descriptorByIndex.get(physicalCardIndex);
        const schemaCard = entry.c?.[physicalCardIndex - 1];
        const headerText = fixedWidthCardHeader(schemaCard);
        if (!descriptor || !Array.isArray(schemaCard) || schemaCard.length !== 8 || !headerText ||
            headerText.length !== layout.fieldWidth * schemaCard.length) {
            return null;
        }
        cards.push({
            physicalCardIndex,
            card: descriptor.card,
            ruleId: descriptor.ruleId,
            relation: activationIds.has(descriptor.ruleId) ? 'conditional' : 'required-predecessor',
            fieldNames: schemaCard.map(field => String(field.n || '')),
            headerText,
            blankText: ' '.repeat(layout.fieldWidth * schemaCard.length),
        });
    }
    return cards;
}

function insertionForBoundary(
    boundary: Boundary,
    cards: CardEditPlanCard[],
    eol: '\n' | '\r\n',
): CardEditInsertion {
    const body = cards.flatMap(card => [card.headerText, card.blankText]).join(eol);
    if (boundary.kind === 'before-line') {
        return { line: boundary.line, character: 0, text: `${body}${eol}` };
    }
    return {
        line: boundary.line,
        character: boundary.character,
        text: `${eol}${body}`,
    };
}

/**
 * Plans one explicit, append-only conditional-card edit.
 *
 * This function does no I/O outside the supplied document, creates no cache, and
 * never scans backward, Include files, or the workspace. A caller must re-run it
 * immediately before applying the returned edit.
 */
export function planVerifiedConditionalCards(
    document: any,
    keywordLine: number,
    schema: KeywordSchema,
    options: CardEditPlannerOptions = {},
): CardEditPlan {
    const documentVersion = safeDocumentVersion(document);
    const hasCommandExpectation = options.expectedDocumentVersion !== undefined ||
        options.expectedLayoutId !== undefined || options.expectedRuleId !== undefined;
    const fail = (
        status: CardEditPlanStatus,
        reason: string,
        values: Partial<CardEditPlan> = {},
    ) => emptyPlan(status, reason, documentVersion, values);

    if (!document || !Number.isInteger(keywordLine) || keywordLine < 0 ||
        keywordLine >= document.lineCount || !schema) {
        return fail(hasCommandExpectation ? 'stale' : 'unavailable', 'invalid-document-or-line');
    }
    if (options.expectedDocumentVersion !== undefined &&
        documentVersion !== options.expectedDocumentVersion) {
        return fail('stale', 'document-version-changed');
    }

    const lineCache = new Map<number, string>();
    let lineReads = 0;
    const readLine = (line: number): string => {
        if (lineCache.has(line)) return lineCache.get(line)!;
        const text = String(document.lineAt(line).text || '');
        lineCache.set(line, text);
        lineReads++;
        return text;
    };
    const resultValues = (values: Partial<CardEditPlan> = {}): Partial<CardEditPlan> => ({
        lineReads,
        ...values,
    });

    let keywordText: string;
    try {
        keywordText = readLine(keywordLine);
    } catch (_error) {
        return fail('stale', 'keyword-line-unavailable', resultValues());
    }
    const classification = classifyKeywordLine(keywordText);
    if (!classification.isKeyword) {
        return fail(hasCommandExpectation ? 'stale' : 'unavailable', 'keyword-line-changed', resultValues());
    }
    const keyword = String(classification.rawKeyword || classification.normalizedKeyword || '').toUpperCase();
    const lookup = lookupKeywordSchema(keyword, schema);
    if (!lookup) {
        return fail(hasCommandExpectation ? 'stale' : 'unavailable', 'keyword-schema-unavailable', resultValues({ keyword }));
    }
    const catalogKeyword = normalizeSemanticKeyword(`*${lookup.canonicalName}`);
    let rules: any[];
    try {
        rules = (options.catalog || getManualSemanticCatalog()).rulesForKeyword(catalogKeyword);
    } catch (_error) {
        return fail('unavailable', 'semantic-runtime-unavailable', resultValues({ keyword, catalogKeyword }));
    }
    const layoutRule = reviewedLayoutRule(rules);
    if (!layoutRule) {
        return fail(hasCommandExpectation ? 'stale' : 'unavailable', 'no-unique-reviewed-layout', resultValues({ keyword, catalogKeyword }));
    }
    const layout = validatedLayoutBasics(layoutRule);
    if (!layout) {
        return fail('schema-mismatch', 'layout-contract-invalid', resultValues({
            keyword,
            catalogKeyword,
            ruleId: String(layoutRule?.ruleId || ''),
        }));
    }
    const base = {
        keyword,
        catalogKeyword,
        layoutId: layout.layoutId,
        ruleId: layoutRule.ruleId,
        minimumExistingPhysicalCard: layout.minimumExistingPhysicalCard,
        targetPhysicalCard: layout.targetPhysicalCard,
    };
    if ((options.expectedLayoutId !== undefined && options.expectedLayoutId !== layout.layoutId) ||
        (options.expectedRuleId !== undefined && options.expectedRuleId !== layoutRule.ruleId)) {
        return fail('stale', 'layout-or-rule-changed', resultValues(base));
    }

    const effectiveFormat = keywordInputFormat(keywordText, options.globalInputFormat || 'standard');
    if (effectiveFormat !== 'standard') {
        return fail('unsupported-format', `input-format-${effectiveFormat}`, resultValues(base));
    }
    const allowedOptions = normalizedStringArray(layout.allowedKeywordOptions)!;
    const legacyPrefixCount = titlePrefixCount(lookup.entry, lookup.activeOptions, allowedOptions);
    const prefixLayout = getVerifiedPrefixLayout(lookup);
    const prefixCount = prefixLayout.status === 'verified' ? prefixLayout.cards.length : 0;
    const renderedCards = getRenderedCardsForLookup(lookup);
    const geometrySignature = cardEditSchemaSignature(schema, catalogKeyword);
    if (legacyPrefixCount === null ||
        (prefixLayout.status !== 'none' && prefixLayout.status !== 'verified') ||
        (legacyPrefixCount !== prefixCount) ||
        !geometrySignature || geometrySignature !== layout.schemaSignature ||
        lookup.entry.c.length !== layout.targetPhysicalCard ||
        renderedCards.length !== lookup.entry.c.length + prefixCount) {
        return fail('schema-mismatch', 'keyword-layout-or-signature-changed', resultValues(base));
    }
    const predicateField = predicateFieldLocation(renderedCards, layout.when.field);
    const advisories = cleanAdvisories(layout);
    if (!predicateField || !Number.isInteger(predicateField.field.p) ||
        !Number.isInteger(predicateField.field.w) || predicateField.field.w < 1 || !advisories) {
        return fail('schema-mismatch', 'predicate-field-or-advisory-invalid', resultValues(base));
    }

    const maximumPhysicalLines = Math.min(
        MAXIMUM_PHYSICAL_LINES,
        Number.isFinite(options.maximumPhysicalLines)
            ? Math.max(0, Math.floor(Number(options.maximumPhysicalLines)))
            : MAXIMUM_PHYSICAL_LINES,
    );
    let indexedEnd = safeIndexedEnd(options.blockIndex, document, keywordLine);
    let scannedPhysicalLines = 0;
    let dataLineOrdinal = 0;
    let existingPhysicalCards = 0;
    let predicateState: TriState | null = null;
    let boundary: Boundary | null = null;
    let lineIndex = keywordLine + 1;

    const withScan = (values: Partial<CardEditPlan> = {}): Partial<CardEditPlan> => resultValues({
        ...base,
        advisories,
        existingPhysicalCards,
        predicateState,
        scannedPhysicalLines,
        ...values,
    });

    while (!boundary) {
        if (lineIndex >= document.lineCount) {
            const lastLine = Math.max(keywordLine, document.lineCount - 1);
            boundary = { kind: 'after-line', line: lastLine, character: readLine(lastLine).length };
            break;
        }

        if (indexedEnd !== null && lineIndex > indexedEnd) {
            const text = readLine(lineIndex);
            if (classifyKeywordLine(text).isKeyword) {
                boundary = { kind: 'before-line', line: lineIndex };
                break;
            }
            // A same-line-count structural edit can make an old boundary stale.
            // Discard the hint and continue under the ordinary 256-line cap.
            indexedEnd = null;
        }

        if (scannedPhysicalLines >= maximumPhysicalLines) {
            return fail('truncated', 'physical-line-budget-exhausted', withScan());
        }

        const text = readLine(lineIndex);
        // VS Code represents a final newline as exactly one virtual empty line.
        // It is not an additional LS-DYNA data card; a preceding empty line remains data.
        if (lineIndex === document.lineCount - 1 && text === '') {
            boundary = { kind: 'before-line', line: lineIndex };
            break;
        }
        if (classifyKeywordLine(text).isKeyword) {
            boundary = { kind: 'before-line', line: lineIndex };
            break;
        }

        scannedPhysicalLines++;
        lineIndex++;
        if (isKeywordCommentLine(text)) continue;
        if (text.includes(',')) {
            return fail('unsupported-format', 'comma-delimited-data-card', withScan());
        }

        dataLineOrdinal++;
        existingPhysicalCards = Math.max(0, dataLineOrdinal - prefixCount);
        if (dataLineOrdinal === predicateField.dataLineOrdinal) {
            const rawValue = text.slice(
                predicateField.field.p!,
                predicateField.field.p! + predicateField.field.w!,
            );
            predicateState = evaluatePredicate(layout.when, {
                fields: new Map([[layout.when.field, rawValue]]),
            });
        }

        if (existingPhysicalCards >= layout.targetPhysicalCard) {
            return fail('already-complete', 'target-card-already-present', withScan({
                existingPhysicalCards: layout.targetPhysicalCard,
            }));
        }
        if (predicateState === 'false') {
            return fail('predicate-false', 'activation-predicate-false', withScan());
        }
        if (predicateState === 'indeterminate') {
            return fail('predicate-indeterminate', 'activation-predicate-indeterminate', withScan());
        }
    }

    if (existingPhysicalCards < layout.minimumExistingPhysicalCard) {
        return fail('missing-required-prefix', 'required-prefix-cards-missing', withScan());
    }
    if (existingPhysicalCards > layout.targetPhysicalCard) {
        return fail('unexpected-card-count', 'physical-card-count-exceeds-layout', withScan());
    }
    if (predicateState === null) {
        return fail('predicate-indeterminate', 'activation-field-not-observed', withScan({
            predicateState: 'indeterminate',
        }));
    }
    if (predicateState === 'false') {
        return fail('predicate-false', 'activation-predicate-false', withScan());
    }
    if (predicateState !== 'true') {
        return fail('predicate-indeterminate', 'activation-predicate-indeterminate', withScan());
    }
    if (!boundary) {
        return fail('truncated', 'block-boundary-unavailable', withScan());
    }

    const cardsToAppend = buildCardsToAppend(layout, lookup.entry, existingPhysicalCards);
    if (!cardsToAppend || cardsToAppend.length === 0) {
        return fail(cardsToAppend ? 'already-complete' : 'schema-mismatch',
            cardsToAppend ? 'target-card-already-present' : 'insertable-card-layout-invalid',
            withScan());
    }
    const insertion = insertionForBoundary(
        boundary,
        cardsToAppend,
        eolForDocument(document, options.eol),
    );
    if (documentVersion !== null && document.version !== documentVersion) {
        return fail('stale', 'document-version-changed-during-planning', withScan());
    }
    return fail('ready', 'verified-append-only-suffix', withScan({
        cardsToAppend,
        insertion,
    }));
}
