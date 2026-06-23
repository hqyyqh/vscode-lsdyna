'use strict';

/**
 * @fileoverview High-performance scanner to locate and slice *KEYWORD blocks in LS-DYNA input files.
 * @module core/parser/blockScanner
 * 
 * This file provides functions to scan LS-DYNA files (either line-by-line via memory reader or 
 * using high-performance stream buffer chunking for large files) to identify individual keyword 
 * blocks, tracking their start and end lines.
 * 
 * Role in System: Parses document structure into discrete blocks to support incremental updates
 * and structural navigation without parsing the entire file content into memory.
 */

const { classifyKeywordLine } = require('./keywordLine');
const { scanKeywordSkeletonFromFile } = require('../scanner/keywordSkeletonScanner');

/**
 * @typedef {Object} KeywordBlock
 * @property {string} keyword - The raw keyword string (e.g., "NODE", "ELEMENT_SHELL") excluding the leading '*'.
 * @property {number} startLine - The 0-indexed line number where this keyword block starts (the '*' line).
 * @property {number} endLine - The 0-indexed line number where this keyword block ends (inclusive).
 */

/**
 * Synchronously scans and identifies keyword blocks from an array-backed line provider.
 * Useful for in-memory documents in the active text editor.
 * 
 * @param {number} lineCount - Total number of lines in the document.
 * @param {function(number): string} getLine - A callback function that retrieves the line content at a given 0-indexed line number.
 * @returns {KeywordBlock[]} Array of scanned keyword blocks.
 */
function collectBlocksFromLineReader(lineCount, getLine) {
    const blocks = [];
    let currentBlock = null;

    for (let i = 0; i < lineCount; i++) {
        const classification = classifyKeywordLine(getLine(i));
        if (classification.isKeyword) {
            const keyword = classification.normalizedKeyword.slice(1);
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

/**
 * Asynchronously parses an LS-DYNA file from disk using a stream buffer for memory efficiency.
 * Processes data chunk-by-chunk using binary operations to ensure no UI blockage for large files.
 * 
 * @param {string} filePath - Absolute path to the LS-DYNA input file on disk.
 * @returns {Promise<KeywordBlock[]>} A promise resolving to the list of keyword blocks in the file.
 */
async function collectBlocksFromFile(filePath) {
    try {
        const blocks = await scanKeywordSkeletonFromFile(filePath);
        await new Promise(r => setImmediate(r));
        return blocks.map(block => ({
            keyword: block.keyword.slice(1),
            startLine: block.startLine,
            endLine: block.endLine,
        }));
    } catch (_error) {
        return [];
    }
}

module.exports = {
    collectBlocksFromLineReader,
    collectBlocksFromFile,
};

export {};
