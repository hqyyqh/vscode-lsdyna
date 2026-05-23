'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const STREAM_SCAN_YIELD_INTERVAL = 50000;

function createIncludeDirectiveState(basePath) {
    return {
        basePath,
        keyword: '',
        cardCount: 0,
        includeEntries: [],
        searchPaths: [basePath],
        pendingInclude: null,
    };
}

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

function createIncludeSegment(line, lineIndex) {
    const trimmed = line.trim();
    return {
        lineIndex,
        startChar: line.indexOf(trimmed),
        endChar: line.trimEnd().length,
    };
}

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

function appendIncludeEntry(entry, line, lineIndex) {
    const trimmed = line.trim();
    const segment = createIncludeSegment(line, lineIndex);
    entry.parts.push(trimmed.endsWith(' +') ? trimmed.slice(0, -2) : trimmed);
    entry.segments.push(segment);
    entry.endLineIndex = segment.lineIndex;
    entry.endChar = segment.endChar;
    entry.awaitingContinuation = trimmed.endsWith(' +');
}

function includeEntryContainsLine(entry, lineIndex) {
    return (entry.segments || []).some(segment => segment.lineIndex === lineIndex);
}

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

function flushIncludeEntry(state) {
    if (!state.pendingInclude) return;
    const fileName = state.pendingInclude.parts.join('').trim();
    if (fileName) {
        const { lineIndex, startChar, endLineIndex, endChar, segments } = state.pendingInclude;
        state.includeEntries.push({ lineIndex, startChar, endLineIndex, endChar, fileName, segments });
    }
    state.pendingInclude = null;
}

function processIncludeDirectiveLine(state, line, lineIndex) {
    const trimmed = line.trim();

    if (line.startsWith('*')) {
        flushIncludeEntry(state);
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

    if (!trimmed || trimmed.startsWith('$')) return;

    if (state.keyword === '*INCLUDE_PATH') {
        state.searchPaths.push(trimmed);
        return;
    }
    if (state.keyword === '*INCLUDE_PATH_RELATIVE') {
        state.searchPaths.push(path.resolve(state.basePath, trimmed));
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

function finalizeIncludeDirectiveState(state) {
    flushIncludeEntry(state);
    return { includeEntries: state.includeEntries, searchPaths: state.searchPaths };
}

function collectIncludeDirectivesFromLineReader(lineCount, getLine, basePath) {
    const state = createIncludeDirectiveState(basePath);
    for (let i = 0; i < lineCount; i++) {
        processIncludeDirectiveLine(state, getLine(i), i);
    }
    return finalizeIncludeDirectiveState(state);
}

async function collectIncludeDirectivesFromFile(filePath) {
    const state = createIncludeDirectiveState(path.dirname(filePath));
    const stream = fs.createReadStream(filePath);
    let remainder = Buffer.alloc(0);
    let lineIndex = 0;

    try {
        for await (const chunk of stream) {
            const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
            let offset = 0;
            let nextNewLine = -1;

            while ((nextNewLine = combined.indexOf(0x0A, offset)) !== -1) {
                const lineStart = offset;
                const lineEnd = nextNewLine;

                // Decode line only if it starts with '*' or we are inside an include context
                const isKeywordLine = combined[lineStart] === 0x2A;
                const inIncludeContext = !!state.pendingInclude ||
                    (state.keyword && state.keyword.startsWith('*INCLUDE'));

                if (isKeywordLine || inIncludeContext) {
                    const lineStr = combined.toString('utf8', lineStart, lineEnd);
                    processIncludeDirectiveLine(state, lineStr, lineIndex);
                }

                offset = nextNewLine + 1;
                lineIndex++;

                if (lineIndex % STREAM_SCAN_YIELD_INTERVAL === 0) {
                    await new Promise(r => setImmediate(r));
                }
            }
            remainder = combined.subarray(offset);
        }

        if (remainder.length > 0) {
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

    return finalizeIncludeDirectiveState(state);
}

module.exports = {
    collectIncludeDirectivesFromFile,
    collectIncludeDirectivesFromLineReader,
    getIncludeEntryRanges,
    includeEntryContainsLine,
};
