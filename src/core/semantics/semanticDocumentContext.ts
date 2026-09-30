import {
    resolveCardFromContext,
    KeywordSchema,
    lookupKeywordSchema,
} from '../keywordSchema';
import {
    keywordInputFormat,
    type KeywordInputFormatMode,
} from '../parser/inputFormat';
import { classifyKeywordLine, isKeywordCommentLine } from '../parser/keywordLine';
import { PredicateContext } from './predicateEvaluator';
import { hasNativeFileReader } from './nativeFieldResolution';
import { nativeControlResolver, type NativeParameterContext } from './nativeParameterContext';

const DEFAULT_PHYSICAL_LINE_BUDGET = 256;

function normalizeKeywordName(value: unknown): string {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

export type SemanticDocumentContextResult = {
    catalogKeyword: string;
    context: PredicateContext;
    scannedPhysicalLines: number;
    truncated: boolean;
    unsupportedFormat: boolean;
    unresolvedFields: string[];
};

function normalizeRequestedFields(values: Iterable<string>): Set<string> {
    return new Set([...values].map(value => String(value || '').trim().toUpperCase()).filter(Boolean));
}

function allSchemaCards(entry: any): any[][] {
    return [
        ...(Array.isArray(entry?.c) ? entry.c : []),
        ...(Array.isArray(entry?.o)
            ? entry.o.flatMap((option: any) => Array.isArray(option?.c) ? option.c : [])
            : []),
    ];
}

function uniquelyAddressableFields(entry: any, requested: Set<string>): Set<string> {
    const counts = new Map<string, number>();
    for (const card of allSchemaCards(entry)) {
        for (const field of Array.isArray(card) ? card : []) {
            const name = String(field?.n || '').trim().toUpperCase();
            if (requested.has(name)) counts.set(name, (counts.get(name) || 0) + 1);
        }
    }
    return new Set([...requested].filter(name => counts.get(name) === 1));
}

function emptyResult(catalogKeyword = ''): SemanticDocumentContextResult {
    return {
        catalogKeyword,
        context: {},
        scannedPhysicalLines: 0,
        truncated: false,
        unsupportedFormat: false,
        unresolvedFields: [],
    };
}

/**
 * Reads only the beginning of one keyword block and only fields needed by published
 * predicates. A field is exposed when its name occurs exactly once in the complete
 * schema entry; ambiguous layouts therefore remain indeterminate instead of being
 * guessed from line order. Long/free-format values are likewise left unresolved.
 */
export function buildSemanticDocumentContext(
    document: any,
    keywordLine: number,
    schema: KeywordSchema,
    requestedFields: Iterable<string>,
    options: {
        maximumPhysicalLines?: number;
        globalInputFormat?: KeywordInputFormatMode;
        parameterContext?: NativeParameterContext;
    } = {},
): SemanticDocumentContextResult {
    if (!document || !Number.isInteger(keywordLine) || keywordLine < 0 || keywordLine >= document.lineCount) {
        return emptyResult();
    }
    const keywordText = String(document.lineAt(keywordLine).text || '');
    const classification = classifyKeywordLine(keywordText);
    if (!classification.isKeyword) return emptyResult();

    const typedKeyword = normalizeKeywordName(classification.normalizedKeyword);
    const inputFormat = keywordInputFormat(keywordText, options.globalInputFormat || 'standard');
    const native = hasNativeFileReader(typedKeyword);
    const unsupportedFormat = inputFormat !== 'standard' && !native;
    const lookup = lookupKeywordSchema(typedKeyword, schema);
    if (!lookup) return emptyResult();
    const catalogKeyword = `*${normalizeKeywordName(lookup.canonicalName)}`;
    const requested = normalizeRequestedFields(requestedFields);
    const context: PredicateContext = {
        keywordOptions: lookup.activeOptions.slice(),
    };
    const result: SemanticDocumentContextResult = {
        catalogKeyword,
        context,
        scannedPhysicalLines: 0,
        truncated: false,
        unsupportedFormat,
        unresolvedFields: [...requested].sort(),
    };
    if (requested.size === 0 || result.unsupportedFormat) return result;

    const addressable = native ? requested : uniquelyAddressableFields(lookup.entry, requested);
    if (addressable.size === 0) return result;
    const values = new Map<string, unknown>();
    const duplicates = new Set<string>();
    const maximumPhysicalLines = Number.isFinite(options.maximumPhysicalLines)
        ? Math.min(DEFAULT_PHYSICAL_LINE_BUDGET, Math.max(0, Math.floor(Number(options.maximumPhysicalLines))))
        : DEFAULT_PHYSICAL_LINE_BUDGET;
    let dataLineOrdinal = 0;
    const observedDataLines: string[] = [];
    const recordLines: number[] = [];
    const parameterContext = options.parameterContext?.documentVersion === document.version ? options.parameterContext : undefined;
    const parameters = nativeControlResolver(parameterContext, recordLines);
    let reachedNextKeyword = false;
    let inputBytes = Buffer.byteLength(keywordText, 'utf8');
    let byteLimitReached = false;

    for (
        let lineIndex = keywordLine + 1;
        lineIndex < document.lineCount && result.scannedPhysicalLines < maximumPhysicalLines;
        lineIndex++
    ) {
        const text = String(document.lineAt(lineIndex).text || '');
        const bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > 64 * 1024 || inputBytes + bytes > 256 * 1024) { byteLimitReached = true; break; }
        inputBytes += bytes;
        if (classifyKeywordLine(text).isKeyword) {
            reachedNextKeyword = true;
            break;
        }
        result.scannedPhysicalLines++;
        if (isKeywordCommentLine(text)) {
            continue;
        }

        dataLineOrdinal++;
        observedDataLines.push(text);
        recordLines.push(lineIndex);
        // Comma-delimited/free-format positions cannot be interpreted with fixed-width
        // schema offsets. Preserve the raw input and leave its predicates unknown.
        if (native || !text.includes(',')) {
            const info = resolveCardFromContext({
                keywordLine, keywordText, currentText: text, dataLineOrdinal,
                observedDataLines, globalInputFormat: options.globalInputFormat || 'standard',
                recordLines, parameterContext,
            }, schema).cardInfo;
            for (const field of info?.card || []) {
                const name = String(field?.n || '').trim().toUpperCase();
                if (!addressable.has(name)) continue;
                if (values.has(name)) { if (native) duplicates.add(name); continue; }
                if (!Number.isInteger(field?.p) || !Number.isInteger(field?.w) || field.w < 1) continue;
                const raw = field.rawValue ?? text.slice(field.p, field.p + field.w);
                values.set(name, native ? parameters.resolve(raw, recordLines.length - 1) : raw);
            }
        }

        if (!native && [...addressable].every(name => values.has(name))) break;
    }

    const exhaustedBudget = result.scannedPhysicalLines >= maximumPhysicalLines;
    result.truncated = byteLimitReached || (exhaustedBudget && !reachedNextKeyword &&
        (native || ![...addressable].every(name => values.has(name))));
    // Native fields are scoped to instances. A block-wide predicate cannot pick
    // one of several occurrences, even if their current values happen to agree.
    for (const name of duplicates) values.delete(name);
    if (native && result.truncated) values.clear();
    if (values.size > 0) context.fields = values;
    result.unresolvedFields = [...requested].filter(name => !values.has(name)).sort();
    return result;
}
