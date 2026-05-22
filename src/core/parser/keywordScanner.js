'use strict';

const fs = require('fs');
const readline = require('readline');

const STREAM_SCAN_YIELD_INTERVAL = 50000;

function collectKeywordsFromLineReader(lineCount, getLine, filePath) {
    const keywords = [];
    for (let i = 0; i < lineCount; i++) {
        const trimmed = getLine(i).trim();
        if (!trimmed.startsWith('*')) continue;
        const keyword = trimmed.slice(1);
        if (!keyword) continue;
        keywords.push({ keyword, filePath, lineIndex: i });
    }
    return keywords;
}

async function collectKeywordsFromFile(filePath) {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const keywords = [];
    let lineIndex = 0;

    try {
        for await (const line of rl) {
            const trimmed = line.trim();
            if (trimmed.startsWith('*')) {
                const keyword = trimmed.slice(1);
                if (keyword) keywords.push({ keyword, filePath, lineIndex });
            }
            lineIndex++;
            if (lineIndex % STREAM_SCAN_YIELD_INTERVAL === 0) await new Promise(r => setImmediate(r));
        }
    } finally {
        rl.close();
    }

    await new Promise(r => setImmediate(r));
    return keywords;
}

module.exports = {
    collectKeywordsFromFile,
    collectKeywordsFromLineReader,
};
