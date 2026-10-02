import { classifyKeywordLine, isKeywordCommentLine } from './keywordLine';
import { classifyOpaqueCommentDirective } from './opaqueCommentRange';
import { globalInputFormatFromKeywordLine, type KeywordInputFormatMode } from './inputFormat';
import type { NativeParameterContext } from '../semantics/nativeParameterContext';

export const FIELD_CONTEXT_LIMITS = Object.freeze({ lines: 256, retainedLines: 4096, bytes: 256 * 1024, singleLineBytes: 64 * 1024 });
const CACHE_ENTRIES = 64;
const CACHE_BYTES = 2 * 1024 * 1024;
export type FieldContextOptions = {
    parameterContext?: NativeParameterContext;
    recordLines?: number[];
    keywordLine?: number | null;
    readLine?: (line: number) => string;
    dataLineOrdinal?: number;
    observedDataLines?: string[];
    globalInputFormat?: KeywordInputFormatMode;
    maximumPhysicalLines?: number;
    maximumInputBytes?: number;
    /** Current-version block boundary; never supplied from an unvalidated disk snapshot. */
    keywordBlockEnd?: number;
    includeCommentHeaders?: boolean;
    cancellationToken?: { readonly isCancellationRequested: boolean };
    homogeneousRepeat?: (keywordText: string) => boolean;
    /** Only for verified layouts whose identity depends on the data ordinal alone. */
    recordOrdinalOnly?: (keywordText: string) => boolean;
    /** Verified conditional readers retain their actual prefix within the byte/record budget. */
    segmentedRecords?: (keywordText: string) => boolean;
};
export type FieldContext = {
    currentLine?: number;
    parameterContext?: NativeParameterContext;
    recordLines?: number[];
    keywordLine: number;
    keywordText: string;
    currentText: string;
    dataLineOrdinal?: number;
    homogeneousRepeat?: boolean;
    recordOrdinalOnly?: boolean;
    observedDataLines: string[];
    globalInputFormat: KeywordInputFormatMode;
    /** Opaque current-version snapshot; absent for caller-supplied mutable contexts. */
    cacheIdentity?: object;
};
type Failure = { status: 'unresolved' | 'unsupported' | 'truncated'; reason: string };
type Result = Failure | { status: 'resolved'; context: FieldContext; commentHeaders?: string[] };
type Snapshot = {
    lines: Map<number, string>;
    bytes: number;
    keywordLine?: number;
    nextLine?: number;
    ordinal: number;
    ordinals: Map<number, number>;
    records: string[];
    recordLines: number[];
    failure?: Failure;
    failureTarget?: number;
    globalMode?: KeywordInputFormatMode;
    cursor?: { nextLine: number; ordinal: number };
    work?: { target: number; nextLine: number; ordinal: number };
    checkpoints?: Map<number, number>;
    checkpointStride?: number;
    segmentedRecords?: boolean;
};
type Cache = { version: number; schema: object; entries: Map<string, Snapshot> };
let caches = new WeakMap<object, Cache>();
export function clearFieldContextCache(document?: object): void {
    if (document) caches.delete(document); else caches = new WeakMap();
}

/** One bounded prefix per block, shared across cursor positions in a document version. */
export function readFieldContext(document: any, target: number, schema: object, options: FieldContextOptions = {}): Result {
    if (!document || !Number.isInteger(target) || target < 0 || target >= document.lineCount) {
        return { status: 'unsupported', reason: 'invalid-line' };
    }
    const maxLines = Math.min(FIELD_CONTEXT_LIMITS.lines, Math.max(0, options.maximumPhysicalLines ?? FIELD_CONTEXT_LIMITS.lines));
    const maxBytes = Math.min(FIELD_CONTEXT_LIMITS.bytes, Math.max(0, options.maximumInputBytes ?? FIELD_CONTEXT_LIMITS.bytes));
    const suppliedOrdinal = Number.isSafeInteger(options.dataLineOrdinal) && options.dataLineOrdinal! > 0;
    let mode = options.globalInputFormat || 'standard';
    const cacheEligible = Number.isInteger(document.version) && !options.readLine && !suppliedOrdinal;
    let cache: Cache | undefined;
    if (cacheEligible) {
        cache = caches.get(document);
        if (!cache || cache.version !== document.version || cache.schema !== schema) {
            cache = { version: document.version, schema, entries: new Map() };
            caches.set(document, cache);
        }
    }
    const key = `${options.keywordLine ?? ('at-' + target)}:${options.globalInputFormat || 'auto'}:${maxLines}:${maxBytes}:${options.keywordBlockEnd ?? ''}:${!!options.recordOrdinalOnly}:${!!options.segmentedRecords}`;
    let snapshot = cache?.entries.get(key);
    if (!snapshot) snapshot = { lines: new Map(), bytes: 0, ordinal: 0, ordinals: new Map(), records: [], recordLines: [] };
    const state = snapshot;
    let ordinalOnly = false, reads = 0, inputBytes = 0;
    const failure = (status: Failure['status'], reason: string): Failure => ({ status, reason });
    const read = (line: number): string => {
        if (options.cancellationToken?.isCancellationRequested) throw failure('truncated', 'field-context-cancelled');
        const found = state.lines.get(line);
        if (found !== undefined) return found;
        const resumable = ordinalOnly || state.segmentedRecords;
        if (resumable ? reads >= maxLines : state.lines.size >= maxLines) throw failure('truncated', resumable
            ? 'field-context-checkpoint-pending' : 'field-context-line-limit');
        if (state.segmentedRecords && state.lines.size >= FIELD_CONTEXT_LIMITS.retainedLines) {
            throw failure('truncated', 'field-context-record-limit');
        }
        const text = String(options.readLine ? options.readLine(line) : document.lineAt(line).text);
        reads++;
        const bytes = Buffer.byteLength(text, 'utf8');
        if (ordinalOnly && inputBytes + bytes > maxBytes && bytes <= Math.min(maxBytes, FIELD_CONTEXT_LIMITS.singleLineBytes)) {
            throw failure('truncated', 'field-context-checkpoint-pending');
        }
        inputBytes += bytes;
        if (ordinalOnly) {
            for (const [oldLine, oldText] of state.lines) {
                if (state.lines.size < maxLines && state.bytes + bytes <= maxBytes) break;
                if (oldLine === state.keywordLine || oldLine === target) continue;
                state.lines.delete(oldLine);
                state.ordinals.delete(oldLine);
                state.bytes -= Buffer.byteLength(oldText, 'utf8');
            }
        }
        if (bytes > FIELD_CONTEXT_LIMITS.singleLineBytes || state.bytes + bytes > maxBytes) {
            throw failure('truncated', 'field-context-byte-limit');
        }
        state.lines.set(line, text);
        state.bytes += bytes;
        return text;
    };
    try {
        if (options.cancellationToken?.isCancellationRequested) return failure('truncated', 'field-context-cancelled');
        // Resume through the same bounded cache before reading a new cursor row.
        ordinalOnly = !!state.checkpoints;
        if (state.failure && state.failureTarget === target) return state.failure;
        if (options.globalInputFormat === undefined && !suppliedOrdinal) {
            if (state.globalMode) mode = state.globalMode;
            else {
                let found = false;
                for (let line = 0; line < Math.min(document.lineCount, 200); line++) {
                    const text = read(line);
                    if (!classifyKeywordLine(text).isKeyword) continue;
                    mode = globalInputFormatFromKeywordLine(text);
                    state.globalMode = mode;
                    found = true;
                    break;
                }
                if (!found) throw failure('truncated', 'deck-format-context-unavailable');
            }
        }
        const currentText = read(target);
        if (classifyKeywordLine(currentText).isKeyword) return failure('unsupported', 'keyword-line');
        let keywordLine = state.keywordLine ?? options.keywordLine;
        if (!Number.isInteger(keywordLine)) {
            for (let line = target - 1; line >= 0; line--) {
                if (classifyKeywordLine(read(line)).isKeyword) { keywordLine = line; break; }
            }
        }
        if (!Number.isInteger(keywordLine) || keywordLine! < 0 || keywordLine! >= target) {
            return failure('unresolved', 'keyword-boundary-unavailable');
        }
        const keywordText = read(keywordLine!);
        if (!classifyKeywordLine(keywordText).isKeyword || classifyOpaqueCommentDirective(keywordText)) {
            return failure('unsupported', 'inactive-keyword-block');
        }
        state.keywordLine = keywordLine!;
        ordinalOnly = cacheEligible && !!options.recordOrdinalOnly?.(keywordText);
        state.segmentedRecords = cacheEligible && !ordinalOnly && !!options.segmentedRecords?.(keywordText);
        // The header and cursor row stay pinned; one slot is needed to advance.
        if ((ordinalOnly || state.segmentedRecords) && maxLines < 3) return failure('truncated', 'field-context-line-limit');
        if (ordinalOnly) {
            state.checkpoints ||= new Map([[keywordLine! + 1, 0]]);
            state.checkpointStride ||= FIELD_CONTEXT_LIMITS.lines;
            if (!state.ordinals.has(target)) {
                let cursor = { nextLine: keywordLine! + 1, ordinal: 0 };
                for (const [line, ordinal] of state.checkpoints) {
                    if (line <= target && line > cursor.nextLine) cursor = { nextLine: line, ordinal };
                }
                if (state.cursor && state.cursor.nextLine <= target && state.cursor.nextLine > cursor.nextLine) cursor = { ...state.cursor };
                if (state.work?.target === target && state.work.nextLine <= target && state.work.nextLine > cursor.nextLine) cursor = { ...state.work };
                state.work = { target, ...cursor };
                let processed = 0;
                for (let line = cursor.nextLine; line <= target; line++) {
                    if (processed++ >= maxLines) throw failure('truncated', 'field-context-checkpoint-pending');
                    const text = read(line);
                    if (classifyKeywordLine(text).isKeyword) return failure('unresolved', 'keyword-block-changed');
                    const comment = isKeywordCommentLine(text);
                    if (!comment) cursor.ordinal++;
                    state.ordinals.set(line, cursor.ordinal + Number(comment));
                    cursor.nextLine = line + 1;
                    state.work = { target, ...cursor };
                    if (!state.cursor || cursor.nextLine > state.cursor.nextLine) state.cursor = { ...cursor };
                    if ((cursor.nextLine - keywordLine! - 1) % state.checkpointStride === 0) {
                        state.checkpoints.set(cursor.nextLine, cursor.ordinal);
                        if (state.checkpoints.size > 512) {
                            state.checkpointStride *= 2;
                            for (const checkpoint of state.checkpoints.keys()) {
                                if ((checkpoint - keywordLine! - 1) % state.checkpointStride) state.checkpoints.delete(checkpoint);
                            }
                        }
                    }
                }
            }
        }
        if (!ordinalOnly && !suppliedOrdinal && options.keywordBlockEnd !== undefined && target <= options.keywordBlockEnd &&
            options.homogeneousRepeat?.(keywordText)) {
            // Cache the prefix, not every visited row of a million-record block.
            state.lines.delete(target);
            state.bytes -= Buffer.byteLength(currentText, 'utf8');
            return { status: 'resolved', context: {
                keywordLine: keywordLine!, keywordText, currentText, currentLine: target, homogeneousRepeat: true,
                observedDataLines: [], globalInputFormat: mode,
            } };
        }
        if (!ordinalOnly && !suppliedOrdinal) {
            for (let line = state.nextLine ?? keywordLine! + 1; line <= target; line++) {
                const text = read(line);
                if (classifyKeywordLine(text).isKeyword) return failure('unresolved', 'keyword-block-changed');
                if (!isKeywordCommentLine(text)) {
                    state.ordinal++;
                    state.records.push(text);
                    state.recordLines.push(line);
                    state.ordinals.set(line, state.ordinal);
                } else {
                    // Text-body callers need the next data ordinal, without treating the comment as data.
                    state.ordinals.set(line, state.ordinal + 1);
                }
                state.nextLine = line + 1;
            }
        }
        const ordinal = suppliedOrdinal ? options.dataLineOrdinal! : state.ordinals.get(target);
        if (!ordinal) return failure('unresolved', 'record-position-unavailable');
        const commentHeaders: string[] = [];
        if (options.includeCommentHeaders) {
            for (let line = target - 1; line > keywordLine! && commentHeaders.length < 8; line--) {
                // Annotation never expands a completed semantic read beyond its budget.
                if (!state.lines.has(line) && state.lines.size >= maxLines) break;
                let text: string;
                try { text = read(line); } catch { break; }
                if (!isKeywordCommentLine(text)) break;
                commentHeaders.unshift(text);
            }
        }
        return { status: 'resolved', commentHeaders, context: {
            keywordLine: keywordLine!, keywordText, currentText,
            dataLineOrdinal: ordinal, observedDataLines: ordinalOnly ? [] : options.observedDataLines || state.records,
            ...(ordinalOnly ? { recordOrdinalOnly: true } : {}),
            recordLines: options.recordLines || (options.observedDataLines ? undefined : state.recordLines),
            parameterContext: options.parameterContext?.documentVersion === document.version ? options.parameterContext : undefined,
            globalInputFormat: mode,
            cacheIdentity: cacheEligible ? state : undefined,
        } };
    } catch (error) {
        if (!error || !['truncated', 'unresolved', 'unsupported'].includes((error as Failure).status)) throw error;
        if (!['field-context-cancelled', 'field-context-checkpoint-pending'].includes((error as Failure).reason)) {
            state.failure = error as Failure;
            state.failureTarget = target;
        }
        return error as Failure;
    } finally {
        if (cache) {
            cache.entries.delete(key);
            cache.entries.set(key, state);
            let bytes = 0;
            const size = (value: Snapshot) => value.bytes * 2 + value.lines.size * 128 + (value.checkpoints?.size || 0) * 64;
            for (const value of cache.entries.values()) bytes += size(value);
            while (cache.entries.size > CACHE_ENTRIES || bytes > CACHE_BYTES) {
                const oldestKey = cache.entries.keys().next().value!;
                const oldest = cache.entries.get(oldestKey)!;
                bytes -= size(oldest);
                cache.entries.delete(oldestKey);
            }
        }
    }
}
