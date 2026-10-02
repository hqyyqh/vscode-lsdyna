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
const { classifyKeywordLine } = require('../parser/keywordLine');
const { classifyOpaqueCommentDirective } = require('../parser/opaqueCommentRange');

type KeywordBlock = {
    keyword: string;
    startLine: number;
    endLine: number;
    startOffset?: number;
    endOffset?: number;
    dataLineCount?: number;
    displayIdentity?: any;
    displaySourceEndLine?: number;
    opaqueKind?: 'comment' | 'comment-noecho';
    opaqueStartCharacter?: number;
};

/**
 * @typedef {Object} ChangeRange
 * @property {number} startLine - 0-indexed starting line number of the edit.
 * @property {number} endLine - 0-indexed ending line number of the edit (before modification).
 * @property {number} [startCharacter] - 0-indexed start column when available.
 * @property {number} [endCharacter] - 0-indexed end column when available.
 */

/**
 * Manages the keyword blocks index for a single LS-DYNA file, supporting incremental block updates.
 */
class BlockIndex {
    filePath: string;
    blocks: KeywordBlock[];
    lineCount: number;
    createBlockSummaryAccumulator?: (block: any, keywordLine: string | Buffer) => any;
    maxIncrementalRescanLines: number;
    lastUpdateAffectsPresentation: boolean;

    /**
     * Creates a BlockIndex instance.
     * 
     * @param {string} filePath - Absolute path to the file on disk.
     */
    constructor(filePath, options: {
        createBlockSummaryAccumulator?: (block: any, keywordLine: string | Buffer) => any;
        maxIncrementalRescanLines?: number;
    } = {}) {
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
        this.createBlockSummaryAccumulator = options.createBlockSummaryAccumulator;
        this.maxIncrementalRescanLines = Number.isFinite(options.maxIncrementalRescanLines)
            ? Math.max(1, Number(options.maxIncrementalRescanLines))
            : Number.POSITIVE_INFINITY;
        this.lastUpdateAffectsPresentation = true;
    }

    /**
     * Synchronously builds the keyword block index from an array-backed line reader.
     * 
     * @param {number} lineCount - Total lines.
     * @param {function(number): string} getLine - Line retrieval callback.
     */
    buildIndex(lineCount, getLine) {
        this.lineCount = lineCount;
        this.blocks = blockScanner.collectBlocksFromLineReader(lineCount, getLine, {
            createBlockSummaryAccumulator: this.createBlockSummaryAccumulator,
        });
    }

    /**
     * Builds an index for a live in-memory document in bounded event-loop chunks.
     * Returns false when the caller invalidates the captured document generation.
     */
    async buildIndexAsync(
        lineCount,
        getLine,
        options: { yieldInterval?: number; shouldCancel?: () => boolean } = {},
    ) {
        const blocks = await blockScanner.collectBlocksFromLineReaderAsync(lineCount, getLine, {
            createBlockSummaryAccumulator: this.createBlockSummaryAccumulator,
            yieldInterval: options.yieldInterval,
            shouldCancel: options.shouldCancel,
        });
        if (!blocks) return false;
        this.lineCount = lineCount;
        this.blocks = blocks;
        return true;
    }

    /**
     * Asynchronously builds the keyword block index directly from the file on disk.
     * 
     * @param {string} filePath - Absolute path to the file.
     * @returns {Promise<void>}
     */
    async buildIndexFromFile(filePath, options: {
        cancellationToken?: { isCancellationRequested?: boolean };
    } = {}) {
        const nextBlocks = await blockScanner.collectBlocksFromFile(filePath, {
            createBlockSummaryAccumulator: this.createBlockSummaryAccumulator,
            cancellationToken: options.cancellationToken,
        });
        this.blocks = nextBlocks;
        if (nextBlocks.length > 0) {
            this.lineCount = nextBlocks[nextBlocks.length - 1].endLine + 1;
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
        this.lastUpdateAffectsPresentation = true;
        const { startLine: editStartLine, endLine: editEndLine } = changeRange;
        const lineDelta = lineCountAfterChange - this.lineCount;

        if (this._tryFastSameLineDataUpdate(
            changeRange,
            newText,
            lineCountAfterChange,
            getLineAfterChange,
        )) {
            return true;
        }

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

        // A bare column-zero `*` terminates COMMENT but does not itself create a block.
        // Include the adjacent COMMENT block when that otherwise unindexed line changes.
        if (firstOverlapIdx === -1) {
            const previousOpaqueIdx = this.blocks.findIndex(block =>
                block.opaqueKind && block.endLine === editStartLine - 1
            );
            if (previousOpaqueIdx !== -1) {
                firstOverlapIdx = previousOpaqueIdx;
                lastOverlapIdx = previousOpaqueIdx;
            }
        }

        let commentSensitive = firstOverlapIdx !== -1 && (
            !!this.blocks[firstOverlapIdx]?.opaqueKind
            || !!this.blocks[firstOverlapIdx - 1]?.opaqueKind
        );

        let affectedStartLine = editStartLine;
        let affectedEndLine = editEndLine;

        if (firstOverlapIdx !== -1) {
            if (firstOverlapIdx > 0) {
                firstOverlapIdx -= 1;
            }
            affectedStartLine = Math.min(affectedStartLine, this.blocks[firstOverlapIdx].startLine);
            affectedEndLine = Math.max(affectedEndLine, this.blocks[lastOverlapIdx].endLine);
        }

        const baselineScanEndLine = affectedEndLine + lineDelta;
        const baselineScanLineCount = baselineScanEndLine - affectedStartLine + 1;
        if (!commentSensitive && baselineScanLineCount > this.maxIncrementalRescanLines) return false;

        if (!commentSensitive) {
            const insertedPhysicalLines = String(newText || '').split(/\r\n|\r|\n/).length;
            for (
                let lineIndex = editStartLine;
                lineIndex < Math.min(lineCountAfterChange, editStartLine + insertedPhysicalLines);
                lineIndex++
            ) {
                if (classifyOpaqueCommentDirective(getLineAfterChange(lineIndex))) {
                    commentSensitive = true;
                    break;
                }
            }
        }

        if (commentSensitive && firstOverlapIdx === -1) {
            firstOverlapIdx = this.blocks.findIndex(block => block.endLine >= affectedStartLine);
            if (firstOverlapIdx !== -1) {
                affectedStartLine = Math.min(affectedStartLine, this.blocks[firstOverlapIdx].startLine);
            }
        }
        if (commentSensitive && firstOverlapIdx !== -1) {
            lastOverlapIdx = this.blocks.length - 1;
        }

        const scanEndLine = commentSensitive
            ? lineCountAfterChange - 1
            : baselineScanEndLine;
        const scanLineCount = scanEndLine - affectedStartLine + 1;
        if (scanLineCount > this.maxIncrementalRescanLines) return false;
        this.lineCount = lineCountAfterChange;

        const subGetLine = (relIdx) => {
            const absIdx = affectedStartLine + relIdx;
            return getLineAfterChange(absIdx);
        };

        const newSubBlocks = blockScanner.collectBlocksFromLineReader(scanLineCount, subGetLine, {
            createBlockSummaryAccumulator: this.createBlockSummaryAccumulator,
        });

        const mappedSubBlocks = newSubBlocks.map(block => ({
            ...block,
            startLine: block.startLine + affectedStartLine,
            endLine: block.endLine + affectedStartLine,
            ...(Number.isFinite(block.displaySourceEndLine)
                ? { displaySourceEndLine: block.displaySourceEndLine + affectedStartLine }
                : {}),
        }));

        const removeCount = firstOverlapIdx !== -1 ? (lastOverlapIdx - firstOverlapIdx + 1) : 0;
        const spliceStart = firstOverlapIdx !== -1 ? firstOverlapIdx : this.blocks.findIndex(b => b.startLine > editStartLine);
        const actualSpliceStart = spliceStart === -1 ? this.blocks.length : spliceStart;

        this.blocks.splice(actualSpliceStart, removeCount, ...mappedSubBlocks);

        const shiftStartIdx = actualSpliceStart + mappedSubBlocks.length;
        for (let i = shiftStartIdx; i < this.blocks.length; i++) {
            this.blocks[i].startLine += lineDelta;
            this.blocks[i].endLine += lineDelta;
            if (Number.isFinite(this.blocks[i].displaySourceEndLine)) {
                this.blocks[i].displaySourceEndLine += lineDelta;
            }
        }

        return true;
    }

    /**
     * Most interactive LS-DYNA edits change one numeric field inside a NODE/ELEMENT/card row.
     * When the edit cannot alter line structure or the leading comment/keyword marker, block
     * coordinates and data-row counts remain valid.  Refresh only the bounded semantic header if
     * it was touched; this keeps a coordinate edit O(log keywords + at most 32 data rows).
     */
    _tryFastSameLineDataUpdate(changeRange, newText, lineCountAfterChange, getLineAfterChange) {
        const startLine = Number(changeRange?.startLine);
        const endLine = Number(changeRange?.endLine);
        const startCharacter = Number(changeRange?.startCharacter);
        if (
            lineCountAfterChange !== this.lineCount
            || startLine !== endLine
            || !Number.isInteger(startCharacter)
            || startCharacter <= 0
            || /\r|\n/.test(String(newText || ''))
        ) {
            return false;
        }

        const block = this.findBlockAtLine(startLine);
        if (!block || startLine === block.startLine) return false;
        if (block.opaqueKind) return true;
        const finalLine = getLineAfterChange(startLine);
        if (classifyKeywordLine(finalLine).isKeyword) return false;

        const displaySourceEndLine = Number.isFinite(block.displaySourceEndLine)
            ? block.displaySourceEndLine
            : block.startLine;
        if (block.displayIdentity && startLine <= displaySourceEndLine) {
            this.lastUpdateAffectsPresentation = this._refreshBlockDisplayIdentity(block, getLineAfterChange);
        } else {
            this.lastUpdateAffectsPresentation = false;
        }
        return true;
    }

    _refreshBlockDisplayIdentity(block, getLine) {
        if (typeof this.createBlockSummaryAccumulator !== 'function') return false;
        let accumulator;
        try {
            accumulator = this.createBlockSummaryAccumulator(block, getLine(block.startLine));
        } catch (_error) {
            return false;
        }
        if (!accumulator) return false;

        let capturedLines = 0;
        let capturedBytes = 0;
        let displaySourceEndLine = block.startLine;
        for (let lineIndex = block.startLine + 1; lineIndex <= block.endLine; lineIndex++) {
            const line = getLine(lineIndex);
            const trimmed = String(line || '').trimStart();
            if (!trimmed || trimmed.startsWith('$')) continue;
            try {
                if (accumulator.acceptLine?.(line) === true) {
                    capturedLines++;
                    capturedBytes += Buffer.byteLength(String(line || ''), 'utf8');
                    displaySourceEndLine = lineIndex;
                }
            } catch (_error) {
                break;
            }
            if (
                accumulator.isCaptureComplete?.() === true
                || capturedLines >= 32
                || capturedBytes >= 8 * 1024
            ) break;
        }
        try {
            const previousIdentity = JSON.stringify(block.displayIdentity || null);
            block.displayIdentity = accumulator.finish?.({
                dataLineCount: block.dataLineCount || 0,
            });
            block.displaySourceEndLine = displaySourceEndLine;
            return JSON.stringify(block.displayIdentity || null) !== previousIdentity;
        } catch (_error) {
            // Semantic labels are optional; preserve the structurally valid block on failure.
            return false;
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

    /**
     * Returns complete block occurrences without discarding end lines or display metadata.
     */
    getOccurrences() {
        return this.blocks.map(block => ({
            ...block,
            filePath: this.filePath,
            lineIndex: block.startLine,
        }));
    }

    /** Locate the block containing a line in O(log N). */
    findBlockAtLine(lineIndex) {
        const line = Math.max(0, Number(lineIndex) || 0);
        let low = 0;
        let high = this.blocks.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const block = this.blocks[middle];
            if (line < block.startLine) {
                high = middle - 1;
            } else if (line > block.endLine) {
                low = middle + 1;
            } else {
                return block;
            }
        }
        return null;
    }
}

module.exports = {
    BlockIndex,
};

export {};
