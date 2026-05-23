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
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const blocks = [];
    let lineIndex = 0;
    let currentBlock = null;

    try {
        for await (const line of rl) {
            const trimmed = line.trim();
            if (line.startsWith('*')) {
                const keyword = trimmed.slice(1).trim();
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
            lineIndex++;
            if (lineIndex % STREAM_SCAN_YIELD_INTERVAL === 0) {
                await new Promise(r => setImmediate(r));
            }
        }
        if (currentBlock) {
            currentBlock.endLine = lineIndex - 1;
        }
    } finally {
        rl.close();
    }

    await new Promise(r => setImmediate(r));
    return blocks;
}

module.exports = {
    collectBlocksFromLineReader,
    collectBlocksFromFile,
};
