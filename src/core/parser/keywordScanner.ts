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

const { classifyKeywordLine } = require('./keywordLine');
const { scanKeywordSkeletonFromFile } = require('../scanner/keywordSkeletonScanner');

type LargeFileScanOptions = {
    fullScanLargeFiles?: boolean;
};

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
        const classification = classifyKeywordLine(getLine(i));
        if (!classification.isKeyword) continue;
        const keyword = classification.normalizedKeyword.slice(1);
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
async function collectKeywordsFromFile(filePath, options: LargeFileScanOptions = {}) {
    try {
        const blocks = await scanKeywordSkeletonFromFile(filePath, options);
        await new Promise(r => setImmediate(r));
        return blocks.map(block => ({
            keyword: block.keyword.slice(1),
            filePath: block.filePath,
            lineIndex: block.startLine,
        }));
    } catch (_e) {
        return [];
    }
}

module.exports = {
    collectKeywordsFromFile,
    collectKeywordsFromLineReader,
};

export {};
