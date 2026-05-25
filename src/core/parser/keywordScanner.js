'use strict';

/**
 * @fileoverview High-performance scanner to locate keyword lines (*...) in LS-DYNA input decks.
 * @module core/parser/keywordScanner
 * 
 * This module scans LS-DYNA files to find lines defining a keyword (starting with '*'). 
 * It runs synchronously on array-backed lines or asynchronously using a stream reader.
 * 
 * Role in System: Generates high-level keyword lists used for navigation and sidebar views 
 * (like the Keyword Index tree).
 */

const fs = require('fs');

/**
 * The default batch yield interval for stream scanning to prevent blocking the event loop.
 * @type {number}
 */
const STREAM_SCAN_YIELD_INTERVAL = 50000;

/**
 * @typedef {Object} ScannedKeyword
 * @property {string} keyword - The keyword name (e.g. "NODE", "CONTROL_TERMINATION") excluding the leading '*'.
 * @property {string} filePath - Absolute path to the file containing this keyword.
 * @property {number} lineIndex - 0-indexed line number of the keyword definition.
 */

/**
 * Synchronously scans and collects keyword occurrences from an array-backed line reader.
 * 
 * @param {number} lineCount - Total number of lines.
 * @param {function(number): string} getLine - Line retrieval callback.
 * @param {string} filePath - Absolute path to the source file.
 * @returns {ScannedKeyword[]} Scanned keywords array.
 */
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

/**
 * Asynchronously scans a file from disk using binary sliding buffer match for fast keyword detection.
 * Avoids converting non-keyword lines to UTF-8 strings to minimize GC pressure.
 * 
 * @param {string} filePath - Absolute path to the file.
 * @returns {Promise<ScannedKeyword[]>} Scanned keywords array.
 */
async function collectKeywordsFromFile(filePath) {
    const stream = fs.createReadStream(filePath);
    const keywords = [];
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

                // Find first non-whitespace character in [lineStart, lineEnd]
                let firstNonSpaceIdx = lineStart;
                while (firstNonSpaceIdx < lineEnd) {
                    const byte = combined[firstNonSpaceIdx];
                    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0D) { // space, tab, CR
                        break;
                    }
                    firstNonSpaceIdx++;
                }

                // If first non-whitespace character is '*', it's a keyword
                if (firstNonSpaceIdx < lineEnd && combined[firstNonSpaceIdx] === 0x2A) {
                    const lineStr = combined.toString('utf8', lineStart, lineEnd);
                    const trimmed = lineStr.trim();
                    const keyword = trimmed.slice(1);
                    if (keyword) {
                        keywords.push({ keyword, filePath, lineIndex });
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
            let firstNonSpaceIdx = 0;
            while (firstNonSpaceIdx < remainder.length) {
                const byte = remainder[firstNonSpaceIdx];
                if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0D) {
                    break;
                }
                firstNonSpaceIdx++;
            }
            if (firstNonSpaceIdx < remainder.length && remainder[firstNonSpaceIdx] === 0x2A) {
                const lineStr = remainder.toString('utf8').trim();
                const keyword = lineStr.slice(1);
                if (keyword) {
                    keywords.push({ keyword, filePath, lineIndex });
                }
            }
        }
    } finally {
        stream.destroy();
    }

    await new Promise(r => setImmediate(r));
    return keywords;
}

module.exports = {
    collectKeywordsFromFile,
    collectKeywordsFromLineReader,
};
