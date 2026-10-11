'use strict';
import { globalInputFormatFromKeywordLine, type KeywordInputFormatMode } from '../../core/parser/inputFormat';
import { isKeywordCommentLine } from '../../core/parser/keywordLine';

/**
 * Bounded, operation-wide planner for the explicit LS-DYNA formatting command.
 * This module deliberately has no VS Code dependency so budget and atomicity
 * behavior can be verified without an extension host.
 */

export const LSDYNA_FORMATTING_LIMITS = Object.freeze({
    maxTotalLines: 5_000,
    maxEdits: 2_000,
    yieldIntervalLines: 250,
    maxTotalLineReads: 50_000,
    maxTotalClassifications: 20_000,
    maxTotalCardResolutions: 10_000,
    maxTotalInputChars: 8 * 1024 * 1024,
    maxSingleLineChars: 64 * 1024,
    maxReplacementChars: 8 * 1024 * 1024,
});

type PositionLike = { line: number; character: number };
type SelectionLike = { start: PositionLike; end: PositionLike; isEmpty?: boolean };
type LineRange = { start: number; end: number };
type KeywordBlock = { keyword?: string; startLine: number; endLine: number };

export type FormattingEdit = {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
    newText: string;
};

export type FormattingMetrics = {
    lineReads: number;
    classifications: number;
    cardResolutions: number;
    inputChars: number;
    replacementChars: number;
    overlapComparisons: number;
    processedLines: number;
};

export type FormattingPlanResult = {
    status: 'ok';
    edits: FormattingEdit[];
    targets: LineRange[];
    metrics: FormattingMetrics;
} | {
    status: 'rejected';
    reason: string;
    metrics: FormattingMetrics;
};

export type FormattingPlannerDependencies = {
    classifyKeywordLine: (text: string) => { isKeyword: boolean; normalizedKeyword?: string };
    resolveCard: (args: {
        document: any;
        lineNum: number;
        keywordLine: number;
        keywordText: string;
        dataLineOrdinal: number;
        observedDataLines: string[];
        globalInputFormat: KeywordInputFormatMode;
        readLine: (line: number) => string;
    }) => any;
    alignLine: (text: string, card: any[], isFieldHeaderLine: boolean) => {
        status: 'aligned' | 'unchanged' | 'unsafe';
        text: string;
        reason?: string | null;
    };
    splitIncludePathEntry: (fullPath: string) => {
        status: 'formatted' | 'unchanged' | 'tooLong';
        lines?: string[];
    };
    shouldSkipKeyword?: (keywordText: string, globalLongFormat: boolean) => boolean;
    isLongFormatKeyword?: (keywordText: string) => boolean;
    isStillValid?: () => boolean;
    resolveOpaqueState?: (position: PositionLike) => 'active' | 'opaque' | 'unknown';
    yieldControl?: () => Promise<void>;
};

export type FormattingPlannerRequest = {
    document: any;
    selections?: SelectionLike[];
    lineArgument?: number;
    fileIndex?: { documentVersion?: number; keywordBlocks?: KeywordBlock[] } | null;
    limits?: Partial<typeof LSDYNA_FORMATTING_LIMITS>;
};

class FormattingRejected extends Error {
    constructor(public readonly reason: string) {
        super(reason);
    }
}

function isPositionBefore(left: PositionLike, right: PositionLike): boolean {
    return left.line < right.line || (left.line === right.line && left.character < right.character);
}

function isPositionEqual(left: PositionLike, right: PositionLike): boolean {
    return left.line === right.line && left.character === right.character;
}

function normalizeExpectedKeyword(value: unknown): string {
    const text = String(value || '').trim().toUpperCase();
    return text && !text.startsWith('*') ? `*${text}` : text;
}

function selectionIsEmpty(selection: SelectionLike): boolean {
    return selection.isEmpty === true || isPositionEqual(selection.start, selection.end);
}

function selectedLineRange(selection: SelectionLike): LineRange {
    const endExclusive = !selectionIsEmpty(selection) &&
        selection.end.character === 0 &&
        selection.end.line > selection.start.line;
    return {
        start: selection.start.line,
        end: selection.end.line - (endExclusive ? 1 : 0),
    };
}

function mergeRanges(ranges: LineRange[]): LineRange[] {
    const sorted = ranges
        .filter(range => range.start <= range.end)
        .sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: LineRange[] = [];
    for (const range of sorted) {
        const previous = merged[merged.length - 1];
        if (previous && range.start <= previous.end + 1) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            merged.push({ ...range });
        }
    }
    return merged;
}

function defaultYield(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
}

export async function planLsdynaFormatting(
    request: FormattingPlannerRequest,
    deps: FormattingPlannerDependencies,
): Promise<FormattingPlanResult> {
    const document = request.document;
    const limits = { ...LSDYNA_FORMATTING_LIMITS, ...(request.limits || {}) };
    const metrics: FormattingMetrics = {
        lineReads: 0,
        classifications: 0,
        cardResolutions: 0,
        inputChars: 0,
        replacementChars: 0,
        overlapComparisons: 0,
        processedLines: 0,
    };
    const lineCache = new Map<number, string>();
    const classificationCache = new Map<number, { isKeyword: boolean; normalizedKeyword?: string }>();
    const validatedHeaders = new Set<number>();
    let blocks: KeywordBlock[] | null = null;

    const reject = (reason: string): never => { throw new FormattingRejected(reason); };
    const checkValid = () => {
        if (deps.isStillValid && !deps.isStillValid()) reject('cancelled');
    };
    const readLine = (line: number): string => {
        if (!Number.isInteger(line) || line < 0 || line >= document.lineCount) reject('invalid-line');
        const cached = lineCache.get(line);
        if (cached !== undefined) return cached;
        if (++metrics.lineReads > limits.maxTotalLineReads) reject('line-read-limit');
        const text = String(document.lineAt(line).text || '');
        if (text.length > limits.maxSingleLineChars) reject('single-line-limit');
        metrics.inputChars += text.length;
        if (metrics.inputChars > limits.maxTotalInputChars) reject('input-size-limit');
        lineCache.set(line, text);
        return text;
    };
    const classifyLine = (line: number) => {
        const cached = classificationCache.get(line);
        if (cached) return cached;
        if (++metrics.classifications > limits.maxTotalClassifications) reject('classification-limit');
        const result = deps.classifyKeywordLine(readLine(line));
        classificationCache.set(line, result);
        return result;
    };
    const tick = async () => {
        metrics.processedLines++;
        if (metrics.processedLines % limits.yieldIntervalLines === 0) {
            await (deps.yieldControl || defaultYield)();
            checkValid();
        }
    };

    try {
        if (!document || !Number.isInteger(document.lineCount) || document.lineCount <= 0) {
            reject('invalid-document');
        }
        checkValid();

        const rawIndex = request.fileIndex;
        if (rawIndex) {
            const hasLiveVersion = Number.isInteger(rawIndex.documentVersion);
            if (
                (hasLiveVersion && rawIndex.documentVersion !== document.version) ||
                (!hasLiveVersion && document.isDirty === true)
            ) reject('stale-index');
            if (!Array.isArray(rawIndex.keywordBlocks) || rawIndex.keywordBlocks.length === 0) {
                reject('partial-index');
            }
            let previousEnd = -1;
            blocks = rawIndex.keywordBlocks.map(block => ({ ...block }));
            for (const block of blocks) {
                if (
                    !Number.isInteger(block.startLine) ||
                    !Number.isInteger(block.endLine) ||
                    block.startLine < 0 ||
                    block.endLine < block.startLine ||
                    block.endLine >= document.lineCount ||
                    block.startLine <= previousEnd
                ) reject('partial-index');
                previousEnd = block.endLine;
                await tick();
            }
            for (let index = 0; index + 1 < blocks.length; index++) {
                if (blocks[index].endLine + 1 !== blocks[index + 1].startLine) {
                    reject('partial-index');
                }
                await tick();
            }
            if (blocks.length > 0 && blocks[blocks.length - 1].endLine !== document.lineCount - 1) {
                reject('partial-index');
            }
        }

        const validateIndexedHeader = (block: KeywordBlock) => {
            if (validatedHeaders.has(block.startLine)) return;
            const actual = classifyLine(block.startLine);
            const expected = deps.classifyKeywordLine(normalizeExpectedKeyword(block.keyword));
            if (!actual.isKeyword || (
                expected.isKeyword &&
                actual.normalizedKeyword !== expected.normalizedKeyword
            )) reject('stale-index');
            validatedHeaders.add(block.startLine);
        };

        const indexedBlockAt = (line: number): KeywordBlock | null => {
            if (!blocks || blocks.length === 0) return null;
            let low = 0;
            let high = blocks.length - 1;
            let candidate: KeywordBlock | null = null;
            let candidateIndex = -1;
            while (low <= high) {
                const middle = (low + high) >> 1;
                const block = blocks[middle];
                if (line < block.startLine) {
                    high = middle - 1;
                } else if (line > block.endLine) {
                    low = middle + 1;
                } else {
                    candidate = block;
                    candidateIndex = middle;
                    break;
                }
            }
            if (!candidate) return null;
            validateIndexedHeader(candidate);
            if (candidateIndex >= 0 && candidateIndex + 1 < blocks.length) {
                validateIndexedHeader(blocks[candidateIndex + 1]);
            }
            return candidate;
        };

        const findKeywordBackward = async (line: number): Promise<number | null> => {
            const indexed = indexedBlockAt(line);
            if (indexed) return indexed.startLine;
            const minimum = Math.max(0, line - limits.maxTotalLines + 1);
            for (let current = line; current >= minimum; current--) {
                if (classifyLine(current).isKeyword) return current;
                await tick();
            }
            if (minimum > 0) reject('keyword-lookback-limit');
            return null;
        };

        const resolveWholeBlock = async (line: number): Promise<LineRange> => {
            if (!Number.isInteger(line) || line < 0 || line >= document.lineCount) reject('invalid-target');
            const indexed = indexedBlockAt(line);
            if (indexed) {
                if (indexed.endLine - indexed.startLine + 1 > limits.maxTotalLines) {
                    reject('target-line-limit');
                }
                return { start: indexed.startLine, end: indexed.endLine };
            }
            const start = await findKeywordBackward(line);
            if (start === null) reject('keyword-not-found');
            let end = start;
            for (let current = start + 1; current < document.lineCount; current++) {
                if (current - start + 1 > limits.maxTotalLines) reject('target-line-limit');
                if (classifyLine(current).isKeyword) break;
                end = current;
                await tick();
            }
            return { start, end };
        };

        const requestedRanges: LineRange[] = [];
        if (Number.isInteger(request.lineArgument)) {
            requestedRanges.push(await resolveWholeBlock(Number(request.lineArgument)));
        } else {
            const selections = Array.isArray(request.selections) ? request.selections : [];
            if (selections.length === 0) reject('invalid-target');
            for (const selection of selections) {
                if (!selection || !selection.start || !selection.end) reject('invalid-target');
                if (selectionIsEmpty(selection)) {
                    requestedRanges.push(await resolveWholeBlock(selection.start.line));
                } else {
                    const range = selectedLineRange(selection);
                    if (range.start < 0 || range.end >= document.lineCount) reject('invalid-target');
                    requestedRanges.push(range);
                }
            }
        }

        const targets = mergeRanges(requestedRanges);
        const targetLineCount = targets.reduce((sum, range) => sum + range.end - range.start + 1, 0);
        if (targetLineCount > limits.maxTotalLines) reject('target-line-limit');
        if (deps.resolveOpaqueState) {
            for (const range of targets) {
                for (let line = range.start; line <= range.end; line++) {
                    const state = deps.resolveOpaqueState({
                        line,
                        character: readLine(line).length,
                    });
                    if (state === 'opaque') reject('opaque-line');
                    if (state !== 'active') reject('opaque-state-unknown');
                    await tick();
                }
            }
        }

        let globalLongFormat = false;
        let globalInputFormat: KeywordInputFormatMode = 'standard';
        const firstKeywordScanEnd = Math.min(document.lineCount, 200);
        for (let line = 0; line < firstKeywordScanEnd; line++) {
            const classification = classifyLine(line);
            if (classification.isKeyword) {
                globalInputFormat = globalInputFormatFromKeywordLine(readLine(line));
                globalLongFormat = classification.normalizedKeyword === '*KEYWORD' &&
                    !!deps.isLongFormatKeyword?.(readLine(line));
                break;
            }
            await tick();
        }

        const edits: FormattingEdit[] = [];
        const addEdit = (edit: FormattingEdit) => {
            const previous = edits[edits.length - 1];
            if (previous) {
                metrics.overlapComparisons++;
                const previousEnd = { line: previous.endLine, character: previous.endCharacter };
                const currentStart = { line: edit.startLine, character: edit.startCharacter };
                if (isPositionBefore(currentStart, previousEnd)) reject('overlapping-edits');
            }
            if (edits.length + 1 > limits.maxEdits) reject('edit-limit');
            metrics.replacementChars += edit.newText.length;
            if (metrics.replacementChars > limits.maxReplacementChars) reject('replacement-size-limit');
            edits.push(edit);
        };

        const isFieldHeader = (text: string) => text.startsWith('$#');
        const isIncludeFileKeyword = (keyword: string) =>
            keyword.startsWith('*INCLUDE') && !keyword.startsWith('*INCLUDE_PATH');
        const isSingleEightyColumnCard = (card: any[]) =>
            Array.isArray(card) && card.length === 1 && Number(card[0]?.w) === 80;
        const isTextCard = (info: any, keyword: string) => {
            if (!info) return false;
            if (info.isTextCard) return true;
            if (!Array.isArray(info.card) || info.card.length !== 1) return false;
            const field = info.card[0];
            const type = String(field?.t || '').toLowerCase();
            return Number(field?.w) >= 40 &&
                (type === 'string' || type === 'character' || type === 'char') &&
                !keyword.startsWith('*INCLUDE');
        };

        const pathEntry = (line: number, keywordLine: number) => {
            let start = line;
            while (start > keywordLine + 1) {
                const previousText = readLine(start - 1).trim();
                if (classifyLine(start - 1).isKeyword || previousText.startsWith('$')) break;
                if (!previousText.endsWith(' +')) break;
                start--;
            }
            let end = line;
            while (end < document.lineCount - 1) {
                const currentText = readLine(end).trim();
                if (!currentText.endsWith(' +')) break;
                const nextText = readLine(end + 1).trim();
                if (classifyLine(end + 1).isKeyword || nextText.startsWith('$')) break;
                end++;
            }
            const parts: string[] = [];
            for (let current = start; current <= end; current++) {
                const trimmed = readLine(current).trim();
                parts.push(trimmed.endsWith(' +') ? trimmed.slice(0, -2) : trimmed);
            }
            const result = deps.splitIncludePathEntry(parts.join(''));
            if (result.status === 'tooLong') reject('include-path-too-long');
            if (!Array.isArray(result.lines)) return null;
            const newText = result.lines.join('\n');
            const oldText = Array.from({ length: end - start + 1 }, (_, offset) => readLine(start + offset)).join('\n');
            if (newText === oldText) return null;
            return { start, end, newText };
        };

        const resolveCard = (args: {
            line: number;
            keywordLine: number;
            keywordText: string;
            ordinal: number;
            observedDataLines: string[];
        }) => {
            if (++metrics.cardResolutions > limits.maxTotalCardResolutions) reject('card-resolution-limit');
            return deps.resolveCard({
                document,
                lineNum: args.line,
                keywordLine: args.keywordLine,
                keywordText: args.keywordText,
                dataLineOrdinal: args.ordinal,
                observedDataLines: args.observedDataLines,
                globalInputFormat,
                readLine,
            });
        };

        let resume: { keywordLine: number; keywordText: string; keyword: string;
            ordinal: number; records: string[]; nextLine: number;
            headers: Array<{ line: number; text: string }> } | null = null;
        for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
            const target = targets[targetIndex];
            const nextTargetStart = targets[targetIndex + 1]?.start ?? document.lineCount;
            const indexed = indexedBlockAt(target.start);
            const contextStart = indexed ? indexed.startLine
                : resume && resume.nextLine <= target.start
                    ? resume.keywordLine : await findKeywordBackward(target.start);
            let keywordLine = contextStart === null ? -1 : contextStart;
            let keywordText = keywordLine >= 0 ? readLine(keywordLine) : '';
            let keyword = keywordLine >= 0
                ? String(classifyLine(keywordLine).normalizedKeyword || '')
                : '';
            let dataLineOrdinal = 0;
            let observedDataLines: string[] = [];
            let selectedHeaders: Array<{ line: number; text: string }> = [];
            let line = contextStart === null ? target.start : contextStart;
            if (resume && resume.keywordLine === contextStart && resume.nextLine <= target.start) {
                keywordLine = resume.keywordLine;
                keywordText = resume.keywordText;
                keyword = resume.keyword;
                dataLineOrdinal = resume.ordinal;
                observedDataLines = resume.records;
                selectedHeaders = resume.headers;
                line = resume.nextLine;
            }

            // Carry selected headers into the next range instead of looking ahead
            // through that range and then traversing the same records again.
            while (line < nextTargetStart && (line <= target.end || selectedHeaders.length > 0)) {
                const text = readLine(line);
                const classification = classifyLine(line);
                const selected = line >= target.start && line <= target.end;

                if (classification.isKeyword) {
                    keywordLine = line;
                    keywordText = text;
                    keyword = String(classification.normalizedKeyword || '');
                    dataLineOrdinal = 0;
                    observedDataLines = [];
                    selectedHeaders = [];
                    line++;
                    await tick();
                    continue;
                }

                if (isKeywordCommentLine(text)) {
                    if (isFieldHeader(text)) {
                        if (selected) selectedHeaders.push({ line, text });
                    }
                    line++;
                    await tick();
                    continue;
                }

                if (keywordLine < 0) {
                    line++;
                    await tick();
                    continue;
                }

                dataLineOrdinal++;
                if (observedDataLines.length < 32) observedDataLines.push(text);
                const skipKeyword = keyword.startsWith('*PARAMETER') ||
                    !!deps.shouldSkipKeyword?.(keywordText, globalLongFormat);

                if (!skipKeyword && selected && (
                    keyword === '*INCLUDE_PATH' || keyword === '*INCLUDE_PATH_RELATIVE'
                )) {
                    const entry = pathEntry(line, keywordLine);
                    if (entry && entry.start >= target.start && entry.end <= target.end) {
                        addEdit({
                            startLine: entry.start,
                            startCharacter: 0,
                            endLine: entry.end,
                            endCharacter: readLine(entry.end).length,
                            newText: entry.newText,
                        });
                        line = entry.end + 1;
                        selectedHeaders = [];
                        await tick();
                        continue;
                    }
                }

                let info: any = null;
                if (!skipKeyword && (selected || selectedHeaders.length > 0)) {
                    info = resolveCard({
                        line,
                        keywordLine,
                        keywordText,
                        ordinal: dataLineOrdinal,
                        observedDataLines,
                    });
                }

                if (info && !isTextCard(info, keyword)) {
                    for (const header of selectedHeaders) {
                        const alignment = deps.alignLine(header.text, info.card, true);
                        if (alignment.status === 'unsafe') continue;
                        if (alignment.text !== header.text) {
                            addEdit({
                                startLine: header.line,
                                startCharacter: 0,
                                endLine: header.line,
                                endCharacter: header.text.length,
                                newText: alignment.text,
                            });
                        }
                    }

                    if (selected) {
                        if (isIncludeFileKeyword(keyword) && isSingleEightyColumnCard(info.card)) {
                            const entry = pathEntry(line, keywordLine);
                            if (entry && entry.start >= target.start && entry.end <= target.end) {
                                addEdit({
                                    startLine: entry.start,
                                    startCharacter: 0,
                                    endLine: entry.end,
                                    endCharacter: readLine(entry.end).length,
                                    newText: entry.newText,
                                });
                                line = entry.end;
                            }
                        } else {
                            const alignment = deps.alignLine(text, info.card, false);
                            if (alignment.status === 'unsafe') reject('unsafe-line');
                            if (alignment.text !== text) {
                                addEdit({
                                    startLine: line,
                                    startCharacter: 0,
                                    endLine: line,
                                    endCharacter: text.length,
                                    newText: alignment.text,
                                });
                            }
                        }
                    }
                }

                selectedHeaders = [];
                line++;
                await tick();
            }
            resume = { keywordLine, keywordText, keyword, ordinal: dataLineOrdinal,
                records: observedDataLines, nextLine: line, headers: selectedHeaders };
        }

        checkValid();
        return { status: 'ok', edits, targets, metrics };
    } catch (error) {
        if (error instanceof FormattingRejected) {
            return { status: 'rejected', reason: error.reason, metrics };
        }
        return { status: 'rejected', reason: 'internal-error', metrics };
    }
}

export function mapPositionThroughFormattingEdits(
    position: PositionLike,
    edits: FormattingEdit[],
): PositionLike {
    let lineDelta = 0;
    for (const edit of edits) {
        const start = { line: edit.startLine, character: edit.startCharacter };
        const end = { line: edit.endLine, character: edit.endCharacter };
        if (isPositionBefore(position, start)) break;
        const replacementLines = edit.newText.split('\n');
        const replacementEnd = {
            line: edit.startLine + replacementLines.length - 1,
            character: replacementLines.length === 1
                ? edit.startCharacter + replacementLines[0].length
                : replacementLines[replacementLines.length - 1].length,
        };
        if (isPositionBefore(position, end) || isPositionEqual(position, end)) {
            if (isPositionEqual(position, start)) {
                return { line: start.line + lineDelta, character: start.character };
            }
            return { line: replacementEnd.line + lineDelta, character: replacementEnd.character };
        }
        lineDelta += replacementLines.length - 1 - (edit.endLine - edit.startLine);
    }
    return { line: position.line + lineDelta, character: position.character };
}
