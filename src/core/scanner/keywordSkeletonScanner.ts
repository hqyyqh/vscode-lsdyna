'use strict';

const fs = require('fs');
const { isElementKeyword, isNodeKeyword } = require('./scannerContracts');

type KeywordSkeletonScanOptions = {
    highWaterMark?: number;
    yieldInterval?: number;
};

const DEFAULT_SCAN_YIELD_INTERVAL = 50000;

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
        rawKeyword: lineBuffer.toString('utf8', tokenStart, index),
        keywordStartChar: tokenStart,
    };
}

function closePreviousBlock(blocks, nextStartOffset, nextStartLine) {
    const previous = blocks[blocks.length - 1];
    if (!previous) return;
    previous.endOffset = nextStartOffset;
    previous.endLine = Math.max(previous.startLine, nextStartLine - 1);
}

async function scanKeywordSkeletonFromFile(filePath, options: KeywordSkeletonScanOptions = {}) {
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

    function processLine(lineBuffer, startOffset, currentLine) {
        const parsed = extractKeywordFromLine(lineBuffer);
        if (!parsed) return;

        closePreviousBlock(blocks, startOffset, currentLine);
        blocks.push({
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
        });
    }

    try {
        for await (const chunk of stream) {
            const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
            const combinedStartOffset = absoluteOffset - remainder.length;
            let offset = 0;
            let nextNewLine = -1;

            while ((nextNewLine = combined.indexOf(0x0a, offset)) !== -1) {
                const lineBuffer = combined.subarray(offset, nextNewLine);
                const startOffset = combinedStartOffset + offset;
                processLine(lineBuffer, startOffset, lineIndex);
                offset = nextNewLine + 1;
                lineIndex++;
                linesProcessed++;
                lineStartOffset = combinedStartOffset + offset;
                if (yieldInterval > 0 && linesProcessed % yieldInterval === 0) {
                    await new Promise(r => setImmediate(r));
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

    if (blocks.length > 0) {
        const last = blocks[blocks.length - 1];
        last.endOffset = stat.size;
        last.endLine = remainder.length > 0 ? lineIndex : Math.max(last.startLine, lineIndex - 1);
    }

    return blocks;
}

module.exports = {
    extractKeywordFromLine,
    scanKeywordSkeletonFromFile,
};

export {};
