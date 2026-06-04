'use strict';

/**
 * @fileoverview High-performance scanner to extract and resolve include directives (*INCLUDE) and search paths (*INCLUDE_PATH) in LS-DYNA input decks.
 * @module core/parser/includeScanner
 * 
 * This module parses LS-DYNA input files to identify included files, supporting continued line 
 * syntax (trailing ' +'), multiple file cards, path resolution variables (*INCLUDE_PATH and 
 * *INCLUDE_PATH_RELATIVE), and comments ($). It runs both in-memory and asynchronously via file streams.
 * 
 * Role in System: Provides structural dependency mapping so the extension can resolve cross-file
 * references (parameters, definitions) and build the project-wide Include Tree.
 */

const fs = require('fs');
const path = require('path');

type LargeFileScanOptions = {
    fullScanLargeFiles?: boolean;
};

/**
 * The default batch yield interval for stream scanning to prevent blocking the event loop.
 * @type {number}
 */
const STREAM_SCAN_YIELD_INTERVAL = 50000;

/**
 * @typedef {Object} IncludeSegment
 * @property {number} lineIndex - 0-indexed line number of this filename segment.
 * @property {number} startChar - 0-indexed column index of the first character of the filename.
 * @property {number} endChar - 0-indexed column index of the last character of the filename.
 */

/**
 * @typedef {Object} IncludeEntry
 * @property {number} lineIndex - 0-indexed line number where the include definition begins.
 * @property {number} startChar - 0-indexed starting character index.
 * @property {number} endLineIndex - 0-indexed line number where the include definition ends.
 * @property {number} endChar - 0-indexed ending character index.
 * @property {string} fileName - Resolved filename string combined from all segments.
 * @property {IncludeSegment[]} segments - Segment coordinates of each line making up the filename (handling trailing ' +' continuation).
 */

/**
 * @typedef {Object} PendingInclude
 * @property {number} lineIndex - Starting line number.
 * @property {number} startChar - Starting column.
 * @property {number} endLineIndex - Current ending line number.
 * @property {number} endChar - Current ending column.
 * @property {string[]} parts - Buffer containing parts of the filename.
 * @property {IncludeSegment[]} segments - Segments coordinates.
 * @property {boolean} awaitingContinuation - True if the line ends with ' +', indicating more segments follow.
 */

/**
 * @typedef {Object} PendingPath
 * @property {string[]} parts - Buffer containing parts of the path.
 * @property {boolean} isRelative - True if this is an *INCLUDE_PATH_RELATIVE entry.
 */

/**
 * @typedef {Object} IncludeDirectiveState
 * @property {string} basePath - Base directory path for resolving relative include paths.
 * @property {string} keyword - The active keyword context (e.g. '*INCLUDE', '*INCLUDE_PATH').
 * @property {number} cardCount - Number of data cards processed under the current keyword.
 * @property {IncludeEntry[]} includeEntries - Scanned include file references.
 * @property {string[]} searchPaths - Search directories resolved for this file.
 * @property {PendingInclude|null} pendingInclude - Active include entry being built.
 * @property {PendingPath|null} pendingPath - Active path entry being built (for *INCLUDE_PATH continuation).
 */

/**
 * @typedef {Object} IncludeResult
 * @property {IncludeEntry[]} includeEntries - List of include entries found in the file.
 * @property {string[]} searchPaths - Resolved absolute and relative search paths.
 */

/**
 * Creates an initial state object for parsing include directives.
 * 
 * @param {string} basePath - The base directory path.
 * @returns {IncludeDirectiveState} Initial state.
 */
function createIncludeDirectiveState(basePath) {
    return {
        basePath,
        keyword: '',
        cardCount: 0,
        includeEntries: [],
        searchPaths: [basePath],
        pendingInclude: null,
        pendingPath: null,
    };
}

/**
 * Returns parsing rules for a given include-related keyword.
 * 
 * @param {string} keyword - The keyword to check.
 * @returns {{repeatable: boolean, filenameCard: number}|null} Parser rules, or null if not an include keyword.
 */
function getIncludeDirectiveRule(keyword) {
    if (keyword === '*INCLUDE') {
        return { repeatable: true, filenameCard: 1 };
    }
    if (keyword.startsWith('*INCLUDE_MULTISCALE_SPOTWELD')) {
        return { repeatable: false, filenameCard: 2 };
    }
    if (keyword.startsWith('*INCLUDE') && !keyword.startsWith('*INCLUDE_PATH')) {
        return { repeatable: false, filenameCard: 1 };
    }
    return null;
}

/**
 * Creates an include segment representing filename coordinates on a specific line.
 * 
 * @param {string} line - Raw line text.
 * @param {number} lineIndex - Line index.
 * @returns {IncludeSegment} The created segment.
 */
function createIncludeSegment(line, lineIndex) {
    const trimmed = line.trim();
    return {
        lineIndex,
        startChar: line.indexOf(trimmed),
        endChar: line.trimEnd().length,
    };
}

/**
 * Initializes a new pending include entry.
 * 
 * @param {string} line - The first line of the include file path.
 * @param {number} lineIndex - 0-indexed line number.
 * @returns {PendingInclude} A new pending include object.
 */
function startIncludeEntry(line, lineIndex) {
    const trimmed = line.trim();
    const segment = createIncludeSegment(line, lineIndex);
    return {
        lineIndex: segment.lineIndex,
        startChar: segment.startChar,
        endLineIndex: segment.lineIndex,
        endChar: segment.endChar,
        parts: [trimmed.endsWith(' +') ? trimmed.slice(0, -2) : trimmed],
        segments: [segment],
        awaitingContinuation: trimmed.endsWith(' +'),
    };
}

/**
 * Appends a continuation line to an existing pending include entry.
 * 
 * @param {PendingInclude} entry - Active pending include.
 * @param {string} line - The continuation line text.
 * @param {number} lineIndex - 0-indexed line number.
 */
function appendIncludeEntry(entry, line, lineIndex) {
    const trimmed = line.trim();
    const segment = createIncludeSegment(line, lineIndex);
    entry.parts.push(trimmed.endsWith(' +') ? trimmed.slice(0, -2) : trimmed);
    entry.segments.push(segment);
    entry.endLineIndex = segment.lineIndex;
    entry.endChar = segment.endChar;
    entry.awaitingContinuation = trimmed.endsWith(' +');
}

/**
 * Determines whether a given line is part of the specified include entry.
 * 
 * @param {IncludeEntry} entry - The include entry.
 * @param {number} lineIndex - 0-indexed line number to check.
 * @returns {boolean} True if the line index is part of the include entry.
 */
function includeEntryContainsLine(entry, lineIndex) {
    return (entry.segments || []).some(segment => segment.lineIndex === lineIndex);
}

/**
 * Simplifies segments of an include entry into contiguous line ranges.
 * 
 * @param {IncludeEntry|PendingInclude} entry - The include entry.
 * @returns {Array<{lineIndex: number, startChar: number, endLineIndex: number, endChar: number}>} Contiguous line ranges.
 */
function getIncludeEntryRanges(entry) {
    if (!entry.segments || entry.segments.length === 0) {
        return [{
            lineIndex: entry.lineIndex,
            startChar: entry.startChar,
            endLineIndex: entry.endLineIndex,
            endChar: entry.endChar,
        }];
    }

    const [firstSegment, ...remainingSegments] = entry.segments;
    const ranges = [{
        lineIndex: firstSegment.lineIndex,
        startChar: firstSegment.startChar,
        endLineIndex: firstSegment.lineIndex,
        endChar: firstSegment.endChar,
    }];

    for (const segment of remainingSegments) {
        const currentRange = ranges[ranges.length - 1];
        if (segment.lineIndex === currentRange.endLineIndex + 1) {
            currentRange.endLineIndex = segment.lineIndex;
            currentRange.endChar = segment.endChar;
            continue;
        }

        ranges.push({
            lineIndex: segment.lineIndex,
            startChar: segment.startChar,
            endLineIndex: segment.lineIndex,
            endChar: segment.endChar,
        });
    }

    return ranges;
}

/**
 * Flushes the current pending include entry into the completed include entries list.
 * 
 * @param {IncludeDirectiveState} state - Active parser state.
 */
function flushIncludeEntry(state) {
    if (!state.pendingInclude) return;
    const fileName = state.pendingInclude.parts.join('').trim();
    if (fileName) {
        const { lineIndex, startChar, endLineIndex, endChar, segments } = state.pendingInclude;
        state.includeEntries.push({ lineIndex, startChar, endLineIndex, endChar, fileName, segments });
    }
    state.pendingInclude = null;
}

/**
 * Flushes the current pending path entry into the search paths list.
 * 
 * @param {IncludeDirectiveState} state - Active parser state.
 */
function flushPathEntry(state) {
    if (!state.pendingPath) return;
    const pathStr = state.pendingPath.parts.join('').trim();
    if (pathStr) {
        if (state.pendingPath.isRelative) {
            state.searchPaths.push(path.resolve(state.basePath, pathStr));
        } else {
            state.searchPaths.push(pathStr);
        }
    }
    state.pendingPath = null;
}

/**
 * Processes a single line within the include directive parser state machine.
 * 
 * @param {IncludeDirectiveState} state - Active parser state.
 * @param {string} line - Raw text line.
 * @param {number} lineIndex - 0-indexed line number.
 */
function processIncludeDirectiveLine(state, line, lineIndex) {
    const trimmed = line.trim();

    if (line.startsWith('*')) {
        flushIncludeEntry(state);
        flushPathEntry(state);
        state.keyword = trimmed;
        state.cardCount = 0;
        return;
    }

    if (state.pendingInclude) {
        if (!trimmed || trimmed.startsWith('$')) return;
        appendIncludeEntry(state.pendingInclude, line, lineIndex);
        if (!state.pendingInclude.awaitingContinuation) {
            flushIncludeEntry(state);
        }
        return;
    }

    if (state.pendingPath) {
        if (!trimmed || trimmed.startsWith('$')) return;
        if (trimmed.endsWith(' +')) {
            state.pendingPath.parts.push(trimmed.slice(0, -2));
        } else {
            state.pendingPath.parts.push(trimmed);
            flushPathEntry(state);
        }
        return;
    }

    if (!trimmed || trimmed.startsWith('$')) return;

    if (state.keyword === '*INCLUDE_PATH') {
        if (trimmed.endsWith(' +')) {
            state.pendingPath = { parts: [trimmed.slice(0, -2)], isRelative: false };
        } else {
            state.searchPaths.push(trimmed);
        }
        return;
    }
    if (state.keyword === '*INCLUDE_PATH_RELATIVE') {
        if (trimmed.endsWith(' +')) {
            state.pendingPath = { parts: [trimmed.slice(0, -2)], isRelative: true };
        } else {
            state.searchPaths.push(path.resolve(state.basePath, trimmed));
        }
        return;
    }

    const includeRule = getIncludeDirectiveRule(state.keyword);
    if (!includeRule) return;

    state.cardCount++;
    if (includeRule.repeatable || state.cardCount === includeRule.filenameCard) {
        state.pendingInclude = startIncludeEntry(line, lineIndex);
        if (!state.pendingInclude.awaitingContinuation) {
            flushIncludeEntry(state);
        }
    }
}

/**
 * Finalizes parsing and returns the resolved results.
 * 
 * @param {IncludeDirectiveState} state - Active parser state.
 * @returns {IncludeResult} The finalized results.
 */
function finalizeIncludeDirectiveState(state) {
    flushIncludeEntry(state);
    flushPathEntry(state);
    return { includeEntries: state.includeEntries, searchPaths: state.searchPaths };
}

/**
 * Synchronously parses include statements and paths using a line-by-line reader.
 * 
 * @param {number} lineCount - Total number of lines.
 * @param {function(number): string} getLine - Line retrieval callback.
 * @param {string} basePath - Folder path of the host file.
 * @returns {IncludeResult} The include entries and search paths.
 */
function collectIncludeDirectivesFromLineReader(lineCount, getLine, basePath) {
    const state = createIncludeDirectiveState(basePath);
    for (let i = 0; i < lineCount; i++) {
        processIncludeDirectiveLine(state, getLine(i), i);
    }
    return finalizeIncludeDirectiveState(state);
}

/**
 * Size threshold below which files are read entirely into memory for faster parsing.
 * Files larger than this are processed via streaming to limit memory usage.
 * @type {number}
 */
const SMALL_FILE_THRESHOLD = 1024 * 1024; // 1 MB

/**
 * Parses include statements from a buffer (used for small files read in one shot).
 * 
 * @param {Buffer} buffer - File content as a Buffer.
 * @param {string} basePath - Base directory path.
 * @returns {IncludeResult} Include entries and search paths.
 */
function collectIncludeDirectivesFromBuffer(buffer, basePath) {
    // Quick scan: if the buffer doesn't contain '*INCLUDE' at all, skip parsing entirely
    const INCLUDE_MARKER = Buffer.from('*INCLUDE');
    if (buffer.indexOf(INCLUDE_MARKER) === -1) {
        return { includeEntries: [], searchPaths: [basePath] };
    }

    const state = createIncludeDirectiveState(basePath);
    let offset = 0;
    let lineIndex = 0;

    while (offset < buffer.length) {
        const nextNewLine = buffer.indexOf(0x0A, offset);
        const lineEnd = nextNewLine === -1 ? buffer.length : nextNewLine;

        const isKeywordLine = buffer[offset] === 0x2A;
        const inIncludeContext = !!state.pendingInclude ||
            (state.keyword && state.keyword.startsWith('*INCLUDE'));

        if (isKeywordLine || inIncludeContext) {
            const lineStr = buffer.toString('utf8', offset, lineEnd);
            processIncludeDirectiveLine(state, lineStr, lineIndex);
        }

        offset = lineEnd + 1;
        lineIndex++;
    }

    return finalizeIncludeDirectiveState(state);
}

/**
 * Asynchronously parses include statements and paths from a file.
 * Optimized with:
 * - Small file fast path: files under 1MB are read into memory at once
 * - Early termination: files not containing '*INCLUDE' are skipped entirely
 * - Selective line decoding: only keyword lines and include context lines are decoded
 * 
 * @param {string} filePath - Absolute path to the file on disk.
 * @returns {Promise<IncludeResult>} Include entries and search paths.
 */
async function collectIncludeDirectivesFromFile(filePath, options: LargeFileScanOptions = {}) {
    const fullScan = options.fullScanLargeFiles === true;
    const basePath = path.dirname(filePath);

    let fileStat;
    try {
        fileStat = await fs.promises.stat(filePath);
    } catch (_error) {
        return { includeEntries: [], searchPaths: [basePath] };
    }

    if (fileStat.size <= SMALL_FILE_THRESHOLD) {
        const buffer = await fs.promises.readFile(filePath);
        return collectIncludeDirectivesFromBuffer(buffer, basePath);
    }

    const LARGE_FILE_THRESHOLD = 500 * 1024;
    const doChunkedScan = !fullScan && fileStat.size > LARGE_FILE_THRESHOLD;

    if (!doChunkedScan) {
        const hasInclude = await streamContainsIncludeKeyword(filePath);
        if (!hasInclude) {
            return { includeEntries: [], searchPaths: [basePath] };
        }
    }

    const state = createIncludeDirectiveState(basePath);

    async function scanStream(stream, startLineIndex, maxLines = -1) {
        let remainder = Buffer.alloc(0);
        let lineIndex = startLineIndex;
        let linesProcessed = 0;

        try {
            for await (const chunk of stream) {
                const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
                let offset = 0;
                let nextNewLine = -1;

                while ((nextNewLine = combined.indexOf(0x0A, offset)) !== -1) {
                    const lineStart = offset;
                    const lineEnd = nextNewLine;

                    const isKeywordLine = combined[lineStart] === 0x2A;
                    const inIncludeContext = !!state.pendingInclude ||
                        (state.keyword && state.keyword.startsWith('*INCLUDE'));

                    if (isKeywordLine || inIncludeContext) {
                        const lineStr = combined.toString('utf8', lineStart, lineEnd);
                        processIncludeDirectiveLine(state, lineStr, lineIndex);
                    }

                    offset = nextNewLine + 1;
                    lineIndex++;
                    linesProcessed++;

                    if (linesProcessed % STREAM_SCAN_YIELD_INTERVAL === 0) {
                        await new Promise(r => setImmediate(r));
                    }

                    if (maxLines > 0 && linesProcessed >= maxLines) {
                        return;
                    }
                }
                remainder = combined.subarray(offset);
            }

            if (remainder.length > 0 && (maxLines <= 0 || linesProcessed < maxLines)) {
                const isKeywordLine = remainder[0] === 0x2A;
                const inIncludeContext = !!state.pendingInclude ||
                    (state.keyword && state.keyword.startsWith('*INCLUDE'));

                if (isKeywordLine || inIncludeContext) {
                    const lineStr = remainder.toString('utf8');
                    processIncludeDirectiveLine(state, lineStr, lineIndex);
                }
            }
        } finally {
            stream.destroy();
        }
    }

    if (!doChunkedScan) {
        const stream = fs.createReadStream(filePath);
        await scanStream(stream, 0, -1);
    } else {
        const streamStart = fs.createReadStream(filePath, { start: 0, end: 1024 * 1024 });
        await scanStream(streamStart, 0, 1000);

        state.pendingInclude = null;
        state.keyword = null;

        const tailBytes = 200 * 1024;
        const startOffset = Math.max(0, fileStat.size - tailBytes);
        const streamEnd = fs.createReadStream(filePath, { start: startOffset });
        
        await scanStream(streamEnd, 9999999, -1);
    }

    return finalizeIncludeDirectiveState(state);
}

/**
 * Fast stream-based check for whether a file contains the '*INCLUDE' pattern.
 * Scans the raw bytes without full parsing - only checks lines starting with '*' (0x2A).
 * For large files (100-500MB), this is much faster than a full parse when no includes exist.
 * 
 * @param {string} filePath - Absolute path to the file.
 * @returns {Promise<boolean>} True if the file likely contains an *INCLUDE directive.
 */
async function streamContainsIncludeKeyword(filePath) {
    const INCLUDE_BYTES = Buffer.from('*INCLUDE');
    const stream = fs.createReadStream(filePath);
    let remainder = Buffer.alloc(0);

    try {
        for await (const chunk of stream) {
            const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
            
            // Search for *INCLUDE pattern in raw bytes
            if (combined.indexOf(INCLUDE_BYTES) !== -1) {
                return true;
            }

            // Keep the last few bytes as remainder to handle pattern spanning chunks
            const keepBytes = INCLUDE_BYTES.length - 1;
            remainder = combined.length > keepBytes 
                ? combined.subarray(combined.length - keepBytes)
                : combined;
        }

        // Check remainder
        if (remainder.length > 0 && remainder.indexOf(INCLUDE_BYTES) !== -1) {
            return true;
        }
    } finally {
        stream.destroy();
    }

    return false;
}

module.exports = {
    collectIncludeDirectivesFromBuffer,
    collectIncludeDirectivesFromFile,
    collectIncludeDirectivesFromLineReader,
    getIncludeEntryRanges,
    includeEntryContainsLine,
};

export {};
