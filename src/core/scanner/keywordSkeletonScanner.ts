'use strict';

const fs = require('fs');
const {
    isElementKeyword,
    isNodeKeyword,
    throwIfCancellationRequested,
} = require('./scannerContracts');
const {
    classifyOpaqueCommentDirective,
    isColumnZeroKeywordBoundary,
} = require('../parser/opaqueCommentRange');

type KeywordSkeletonScanOptions = {
    highWaterMark?: number;
    yieldInterval?: number;
    createBlockSummaryAccumulator?: (block: any, keywordLine: Buffer) => {
        acceptLine?: (line: Buffer) => boolean;
        finish?: (metadata?: { dataLineCount?: number }) => any;
        isCaptureComplete?: () => boolean;
    } | null;
    cancellationToken?: { isCancellationRequested?: boolean };
    onLineStart?: (line: number, byteOffset: number) => void;
};

const DEFAULT_SCAN_YIELD_INTERVAL = 1000;

function isHorizontalWhitespace(byte) {
    return byte === 0x20 || byte === 0x09;
}

function isKeywordTokenTerminator(byte) {
    return byte === 0x20 ||
        byte === 0x09 ||
        byte === 0x2c ||
        byte === 0x24 ||
        byte === 0x0d ||
        byte === 0x0a;
}

function normalizeAsciiKeyword(buffer, start, end) {
    const bytes = [];
    for (let index = start; index < end; index++) {
        const byte = buffer[index];
        bytes.push(byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte);
    }
    return Buffer.from(bytes).toString('ascii');
}

function extractKeywordFromLine(lineBuffer) {
    let index = 0;
    while (index < lineBuffer.length && isHorizontalWhitespace(lineBuffer[index])) index++;
    if (index >= lineBuffer.length) return null;
    if (lineBuffer[index] === 0x24) return null;
    if (lineBuffer[index] !== 0x2a) return null;

    const tokenStart = index;
    index++;
    while (index < lineBuffer.length && !isKeywordTokenTerminator(lineBuffer[index])) index++;
    if (index <= tokenStart + 1) return null;

    return {
        keyword: normalizeAsciiKeyword(lineBuffer, tokenStart, index),
        rawKeyword: lineBuffer.toString('utf8', tokenStart).split('$')[0].trimEnd(),
        keywordStartChar: tokenStart,
    };
}

function closePreviousBlock(blocks, nextStartOffset, nextStartLine) {
    const previous = blocks[blocks.length - 1];
    if (!previous) return;
    previous.endOffset = nextStartOffset;
    previous.endLine = Math.max(previous.startLine, nextStartLine - 1);
}

function isDataLine(lineBuffer) {
    let index = 0;
    while (
        index < lineBuffer.length
        && (lineBuffer[index] === 0x20 || lineBuffer[index] === 0x09 || lineBuffer[index] === 0x0d)
    ) {
        index++;
    }
    return index < lineBuffer.length && lineBuffer[index] !== 0x24;
}

async function scanKeywordSkeletonFromFile(filePath, options: KeywordSkeletonScanOptions = {}) {
    throwIfCancellationRequested(options.cancellationToken);
    const stat = await fs.promises.stat(filePath);
    const stream = fs.createReadStream(filePath, {
        highWaterMark: options.highWaterMark || 1024 * 1024,
    });
    const blocks = [];
    let remainder = Buffer.alloc(0);
    let absoluteOffset = 0;
    let lineStartOffset = 0;
    let lineIndex = 0;
    let linesProcessed = 0;
    const yieldInterval = options.yieldInterval || DEFAULT_SCAN_YIELD_INTERVAL;
    let currentSummaryAccumulator = null;
    let currentBlockOpen = false;
    let opaqueActive = false;

    function finishCurrentSummary() {
        if (!currentBlockOpen) return;
        const block = blocks[blocks.length - 1];
        if (!block || !currentSummaryAccumulator) return;
        try {
            if (typeof currentSummaryAccumulator.finish === 'function') {
                block.displayIdentity = currentSummaryAccumulator.finish({
                    dataLineCount: block.dataLineCount || 0,
                });
            }
        } catch (_error) {
            // Display metadata is best-effort and must never make structural indexing fail.
        }
        currentSummaryAccumulator = null;
    }

    function processLine(lineBuffer, startOffset, currentLine) {
        options.onLineStart?.(currentLine, startOffset);
        if (opaqueActive) {
            if (!isColumnZeroKeywordBoundary(lineBuffer)) return;
            finishCurrentSummary();
            closePreviousBlock(blocks, startOffset, currentLine);
            currentBlockOpen = false;
            opaqueActive = false;
        }

        const parsed = extractKeywordFromLine(lineBuffer);
        if (!parsed) {
            const block = currentBlockOpen ? blocks[blocks.length - 1] : null;
            if (block && isDataLine(lineBuffer)) {
                block.dataLineCount = (block.dataLineCount || 0) + 1;
                try {
                    const captured = currentSummaryAccumulator?.acceptLine?.(lineBuffer);
                    if (captured === true) block.displaySourceEndLine = currentLine;
                } catch (_error) {
                    // Keep counting and scanning even when optional display parsing fails.
                }
            }
            return;
        }

        if (currentBlockOpen) {
            finishCurrentSummary();
            closePreviousBlock(blocks, startOffset, currentLine);
        }
        const opaqueDirective = classifyOpaqueCommentDirective(lineBuffer);
        const block = {
            filePath,
            keyword: parsed.keyword,
            rawKeyword: parsed.rawKeyword,
            startOffset,
            endOffset: stat.size,
            startLine: currentLine,
            endLine: currentLine,
            keywordStartChar: parsed.keywordStartChar,
            keywordLineEndOffset: startOffset + lineBuffer.length,
            flags: {
                isNodeBlock: isNodeKeyword(parsed.keyword),
                isElementBlock: isElementKeyword(parsed.keyword),
            },
            dataLineCount: 0,
            ...(opaqueDirective
                ? {
                    opaqueKind: opaqueDirective.kind,
                    opaqueStartCharacter: opaqueDirective.tokenEnd,
                }
                : {}),
            ...(typeof options.createBlockSummaryAccumulator === 'function'
                && !opaqueDirective
                ? { displaySourceEndLine: currentLine }
                : {}),
        };
        blocks.push(block);
        currentBlockOpen = true;
        opaqueActive = !!opaqueDirective;
        if (typeof options.createBlockSummaryAccumulator === 'function' && !opaqueDirective) {
            try {
                currentSummaryAccumulator = options.createBlockSummaryAccumulator(block, lineBuffer);
            } catch (_error) {
                currentSummaryAccumulator = null;
            }
        }
    }

    try {
        for await (const chunk of stream) {
            throwIfCancellationRequested(options.cancellationToken);
            const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
            const combinedStartOffset = absoluteOffset - remainder.length;
            let offset = 0;
            let nextNewLine = -1;

            while ((nextNewLine = combined.indexOf(0x0a, offset)) !== -1) {
                const startOffset = combinedStartOffset + offset;
                const block = blocks[blocks.length - 1];
                let dataStart = offset;
                while (dataStart < nextNewLine && isHorizontalWhitespace(combined[dataStart])) dataStart++;
                // Once the display prefix is captured, mesh rows only need line/byte positions and a count.
                if (currentBlockOpen && !opaqueActive && (block.flags.isNodeBlock || block.flags.isElementBlock) &&
                    (!currentSummaryAccumulator || currentSummaryAccumulator.isCaptureComplete?.()) &&
                    dataStart < nextNewLine && combined[dataStart] >= 0x30 && combined[dataStart] <= 0x39) {
                    options.onLineStart?.(lineIndex, startOffset);
                    block.dataLineCount++;
                } else {
                    processLine(combined.subarray(offset, nextNewLine), startOffset, lineIndex);
                }
                offset = nextNewLine + 1;
                lineIndex++;
                linesProcessed++;
                lineStartOffset = combinedStartOffset + offset;
                if (yieldInterval > 0 && linesProcessed % yieldInterval === 0) {
                    await new Promise(r => setImmediate(r));
                    throwIfCancellationRequested(options.cancellationToken);
                }
            }

            remainder = combined.subarray(offset);
            absoluteOffset += chunk.length;
        }

        if (remainder.length > 0) {
            processLine(remainder, lineStartOffset, lineIndex);
        }
    } finally {
        stream.destroy();
    }

    if (currentBlockOpen && blocks.length > 0) {
        const last = blocks[blocks.length - 1];
        last.endOffset = stat.size;
        last.endLine = remainder.length > 0 ? lineIndex : Math.max(last.startLine, lineIndex - 1);
    }
    finishCurrentSummary();
    throwIfCancellationRequested(options.cancellationToken);

    return blocks;
}

module.exports = {
    extractKeywordFromLine,
    scanKeywordSkeletonFromFile,
};

export {};
