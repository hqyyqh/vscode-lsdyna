'use strict';

const fs = require('fs');
const readline = require('readline');

const STREAM_SCAN_YIELD_INTERVAL = 50000;

function collectBlocksFromLineReader(lineCount, getLine) {
    const blocks = [];
    let currentBlock = null;

    for (let i = 0; i < lineCount; i++) {
        const line = getLine(i);
        const trimmed = line.trim();
        if (line.startsWith('*')) {
            const keyword = trimmed.slice(1).trim();
            if (keyword) {
                if (currentBlock) {
                    currentBlock.endLine = i - 1;
                }
                currentBlock = {
                    keyword,
                    startLine: i,
                    endLine: i,
                };
                blocks.push(currentBlock);
            }
        }
    }
    if (currentBlock) {
        currentBlock.endLine = lineCount - 1;
    }
    return blocks;
}

async function collectBlocksFromFile(filePath) {
    const stream = fs.createReadStream(filePath);
    const blocks = [];
    let remainder = Buffer.alloc(0);
    let lineIndex = 0;
    let currentBlock = null;

    try {
        for await (const chunk of stream) {
            const combined = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
            let offset = 0;
            let nextNewLine = -1;

            while ((nextNewLine = combined.indexOf(0x0A, offset)) !== -1) {
                const lineStart = offset;
                const lineEnd = nextNewLine;

                if (combined[lineStart] === 0x2A) {
                    const lineStr = combined.toString('utf8', lineStart, lineEnd);
                    const keyword = lineStr.trim().slice(1).trim();
                    if (keyword) {
                        if (currentBlock) {
                            currentBlock.endLine = lineIndex - 1;
                        }
                        currentBlock = {
                            keyword,
                            startLine: lineIndex,
                            endLine: lineIndex,
                        };
                        blocks.push(currentBlock);
                    }
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
            if (remainder[0] === 0x2A) {
                const lineStr = remainder.toString('utf8');
                const keyword = lineStr.trim().slice(1).trim();
                if (keyword) {
                    if (currentBlock) {
                        currentBlock.endLine = lineIndex - 1;
                    }
                    currentBlock = {
                        keyword,
                        startLine: lineIndex,
                        endLine: lineIndex,
                    };
                    blocks.push(currentBlock);
                }
            }
        }
        if (currentBlock) {
            currentBlock.endLine = remainder.length > 0 ? lineIndex : lineIndex - 1;
        }
    } finally {
        stream.destroy();
    }

    await new Promise(r => setImmediate(r));
    return blocks;
}

module.exports = {
    collectBlocksFromLineReader,
    collectBlocksFromFile,
};
