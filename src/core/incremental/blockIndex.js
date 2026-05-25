'use strict';

/**
 * @fileoverview Class managing the in-memory index of *KEYWORD blocks for an active document.
 * @module core/incremental/blockIndex
 * 
 * This module maintains an array of keyword block coordinate structures (startLine/endLine).
 * It supports synchronous bootstrapping, asynchronous disk-based loading, and high-performance
 * incremental updates. When document edits occur, it identifies overlapping blocks, re-parses only 
 * the affected range, and shifts remaining block offsets in O(N) time.
 * 
 * Role in System: Backs the Language Server's active document cache to maintain responsive
 * and correct keyword positions without running a full document parse on every keystroke.
 */

const blockScanner = require('../parser/blockScanner');

/**
 * @typedef {Object} ChangeRange
 * @property {number} startLine - 0-indexed starting line number of the edit.
 * @property {number} endLine - 0-indexed ending line number of the edit (before modification).
 */

/**
 * Manages the keyword blocks index for a single LS-DYNA file, supporting incremental block updates.
 */
class BlockIndex {
    /**
     * Creates a BlockIndex instance.
     * 
     * @param {string} filePath - Absolute path to the file on disk.
     */
    constructor(filePath) {
        /**
         * Absolute path to the file.
         * @type {string}
         */
        this.filePath = filePath;

        /**
         * List of scanned keyword blocks in the file.
         * @type {import('../parser/blockScanner').KeywordBlock[]}
         */
        this.blocks = [];

        /**
         * Total line count of the file.
         * @type {number}
         */
        this.lineCount = 0;
    }

    /**
     * Synchronously builds the keyword block index from an array-backed line reader.
     * 
     * @param {number} lineCount - Total lines.
     * @param {function(number): string} getLine - Line retrieval callback.
     */
    buildIndex(lineCount, getLine) {
        this.lineCount = lineCount;
        this.blocks = blockScanner.collectBlocksFromLineReader(lineCount, getLine);
    }

    /**
     * Asynchronously builds the keyword block index directly from the file on disk.
     * 
     * @param {string} filePath - Absolute path to the file.
     * @returns {Promise<void>}
     */
    async buildIndexFromFile(filePath) {
        this.blocks = await blockScanner.collectBlocksFromFile(filePath);
        if (this.blocks.length > 0) {
            this.lineCount = this.blocks[this.blocks.length - 1].endLine + 1;
        } else {
            this.lineCount = 0;
        }
    }

    /**
     * Incrementally updates the block index after a document change.
     * Re-scans only the modified lines and shift-translates subsequent block boundaries.
     * 
     * @param {ChangeRange} changeRange - The 0-indexed line range that was replaced/modified.
     * @param {string} newText - The new raw text content of the change (unused but reserved for protocol).
     * @param {number} lineCountAfterChange - Total lines in the document after the edit.
     * @param {function(number): string} getLineAfterChange - Line retrieval callback for the new document state.
     */
    updateIndex(changeRange, newText, lineCountAfterChange, getLineAfterChange) {
        const { startLine: editStartLine, endLine: editEndLine } = changeRange;
        const lineDelta = lineCountAfterChange - this.lineCount;
        this.lineCount = lineCountAfterChange;

        // Find overlapping blocks
        let firstOverlapIdx = -1;
        let lastOverlapIdx = -1;
        for (let i = 0; i < this.blocks.length; i++) {
            const block = this.blocks[i];
            const overlaps = Math.max(block.startLine, editStartLine) <= Math.min(block.endLine, editEndLine);
            if (overlaps) {
                if (firstOverlapIdx === -1) firstOverlapIdx = i;
                lastOverlapIdx = i;
            }
        }

        let affectedStartLine = editStartLine;
        let affectedEndLine = editEndLine;

        if (firstOverlapIdx !== -1) {
            if (firstOverlapIdx > 0) {
                firstOverlapIdx -= 1;
            }
            affectedStartLine = Math.min(affectedStartLine, this.blocks[firstOverlapIdx].startLine);
            affectedEndLine = Math.max(affectedEndLine, this.blocks[lastOverlapIdx].endLine);
        }

        const scanEndLine = affectedEndLine + lineDelta;
        const scanLineCount = scanEndLine - affectedStartLine + 1;

        const subGetLine = (relIdx) => {
            const absIdx = affectedStartLine + relIdx;
            return getLineAfterChange(absIdx);
        };

        const newSubBlocks = blockScanner.collectBlocksFromLineReader(scanLineCount, subGetLine);

        const mappedSubBlocks = newSubBlocks.map(block => ({
            keyword: block.keyword,
            startLine: block.startLine + affectedStartLine,
            endLine: block.endLine + affectedStartLine,
        }));

        const removeCount = firstOverlapIdx !== -1 ? (lastOverlapIdx - firstOverlapIdx + 1) : 0;
        const spliceStart = firstOverlapIdx !== -1 ? firstOverlapIdx : this.blocks.findIndex(b => b.startLine > editStartLine);
        const actualSpliceStart = spliceStart === -1 ? this.blocks.length : spliceStart;

        this.blocks.splice(actualSpliceStart, removeCount, ...mappedSubBlocks);

        const shiftStartIdx = actualSpliceStart + mappedSubBlocks.length;
        for (let i = shiftStartIdx; i < this.blocks.length; i++) {
            this.blocks[i].startLine += lineDelta;
            this.blocks[i].endLine += lineDelta;
        }
    }

    /**
     * Converts the internal block index into a list of scanned keyword position references.
     * 
     * @returns {import('../parser/keywordScanner').ScannedKeyword[]} Scanned keyword coordinates.
     */
    getKeywords() {
        return this.blocks.map(block => ({
            keyword: block.keyword,
            filePath: this.filePath,
            lineIndex: block.startLine,
        }));
    }
}

module.exports = {
    BlockIndex,
};
