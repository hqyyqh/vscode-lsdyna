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
const {
    classifyOpaqueCommentDirective,
    isColumnZeroKeywordBoundary,
} = require('./opaqueCommentRange');
const { scanKeywordSkeletonFromFile } = require('../scanner/keywordSkeletonScanner');

type BlockScannerOptions = {
    createBlockSummaryAccumulator?: (block: any, keywordLine: string | Buffer) => any;
    yieldInterval?: number;
    shouldCancel?: () => boolean;
    cancellationToken?: { isCancellationRequested?: boolean };
};

const DEFAULT_LINE_READER_YIELD_INTERVAL = 5000;

function createLineReaderCollector(options: BlockScannerOptions = {}) {
    const blocks: any[] = [];
    let currentBlock: any = null;
    let currentSummaryAccumulator = null;

    function finishCurrentSummary() {
        if (!currentBlock || !currentSummaryAccumulator) return;
        try {
            currentBlock.displayIdentity = currentSummaryAccumulator.finish?.({
                dataLineCount: currentBlock.dataLineCount || 0,
            });
        } catch (_error) {
            // Optional display metadata must not affect structural block indexing.
        }
        currentSummaryAccumulator = null;
    }

    function acceptLine(line, lineIndex) {
        if (currentBlock?.opaqueKind && lineIndex > currentBlock.startLine) {
            if (!isColumnZeroKeywordBoundary(line)) return;
            finishCurrentSummary();
            currentBlock.endLine = lineIndex - 1;
            currentBlock = null;
        }

        const classification = classifyKeywordLine(line);
        if (classification.isKeyword) {
            const keyword = classification.normalizedKeyword.slice(1);
            if (!keyword) return;
            if (currentBlock) {
                finishCurrentSummary();
                currentBlock.endLine = lineIndex - 1;
            }
            currentBlock = {
                keyword,
                startLine: lineIndex,
                endLine: lineIndex,
            };
            const opaqueDirective = classifyOpaqueCommentDirective(line);
            if (opaqueDirective) {
                currentBlock.opaqueKind = opaqueDirective.kind;
                currentBlock.opaqueStartCharacter = opaqueDirective.tokenEnd;
            }
            if (typeof options.createBlockSummaryAccumulator === 'function' && !opaqueDirective) {
                currentBlock.dataLineCount = 0;
                currentBlock.displaySourceEndLine = lineIndex;
            }
            blocks.push(currentBlock);
            if (typeof options.createBlockSummaryAccumulator === 'function' && !opaqueDirective) {
                try {
                    currentSummaryAccumulator = options.createBlockSummaryAccumulator(currentBlock, line);
                } catch (_error) {
                    currentSummaryAccumulator = null;
                }
            }
            return;
        }

        if (currentBlock && typeof options.createBlockSummaryAccumulator === 'function') {
            const trimmed = String(line || '').trimStart();
            if (trimmed && !trimmed.startsWith('$')) {
                currentBlock.dataLineCount = (currentBlock.dataLineCount || 0) + 1;
                try {
                    const captured = currentSummaryAccumulator?.acceptLine?.(line);
                    if (captured === true) currentBlock.displaySourceEndLine = lineIndex;
                } catch (_error) {
                    // Keep the block index valid even if display metadata cannot be parsed.
                }
            }
        }
    }

    function finish(lineCount) {
        if (currentBlock) {
            currentBlock.endLine = Math.max(currentBlock.startLine, lineCount - 1);
            finishCurrentSummary();
        }
        return blocks;
    }

    return { acceptLine, finish };
}

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
function collectBlocksFromLineReader(lineCount, getLine, options: BlockScannerOptions = {}) {
    const collector = createLineReaderCollector(options);
    for (let i = 0; i < lineCount; i++) {
        collector.acceptLine(getLine(i), i);
    }
    return collector.finish(lineCount);
}

/**
 * Scans a live TextDocument-style line reader without monopolizing the extension host.
 * The scan owns a temporary result and returns `null` when invalidated, so callers never expose
 * a half-built index or publish coordinates from an obsolete document version.
 */
async function collectBlocksFromLineReaderAsync(lineCount, getLine, options: BlockScannerOptions = {}) {
    const collector = createLineReaderCollector(options);
    const yieldInterval = Math.max(
        1,
        Number(options.yieldInterval) || DEFAULT_LINE_READER_YIELD_INTERVAL,
    );

    for (let chunkStart = 0; chunkStart < lineCount; chunkStart += yieldInterval) {
        if (options.shouldCancel?.()) return null;
        const chunkEnd = Math.min(lineCount, chunkStart + yieldInterval);
        // Document changes cannot interleave with this synchronous chunk.  Cancellation is checked
        // before the next chunk, before any potentially out-of-range TextDocument.lineAt call.
        let started = performance.now();
        for (let lineIndex = chunkStart; lineIndex < chunkEnd; lineIndex++) {
            collector.acceptLine(getLine(lineIndex), lineIndex);
            if ((lineIndex & 255) === 0 && performance.now() - started >= 8) {
                await new Promise(resolve => setImmediate(resolve));
                if (options.shouldCancel?.() || options.cancellationToken?.isCancellationRequested) return null;
                started = performance.now();
            }
        }
        if (chunkEnd < lineCount) await new Promise(resolve => setImmediate(resolve));
    }

    if (options.shouldCancel?.()) return null;
    return collector.finish(lineCount);
}

/**
 * Asynchronously parses an LS-DYNA file from disk using a stream buffer for memory efficiency.
 * Processes data chunk-by-chunk using binary operations to ensure no UI blockage for large files.
 * 
 * @param {string} filePath - Absolute path to the LS-DYNA input file on disk.
 * @returns {Promise<KeywordBlock[]>} A promise resolving to the list of keyword blocks in the file.
 */
async function collectBlocksFromFile(filePath, options: BlockScannerOptions = {}) {
    try {
        const blocks = await scanKeywordSkeletonFromFile(filePath, options);
        await new Promise(r => setImmediate(r));
        return blocks.map(block => {
            const result: any = {
                keyword: block.keyword.slice(1),
                startLine: block.startLine,
                endLine: block.endLine,
            };
            if (typeof options.createBlockSummaryAccumulator === 'function') {
                result.dataLineCount = block.dataLineCount || 0;
                if (block.displayIdentity) result.displayIdentity = block.displayIdentity;
                if (Number.isFinite(block.displaySourceEndLine)) {
                    result.displaySourceEndLine = block.displaySourceEndLine;
                }
                if (Number.isFinite(block.startOffset)) result.startOffset = block.startOffset;
                if (Number.isFinite(block.endOffset)) result.endOffset = block.endOffset;
            }
            if (block.opaqueKind) {
                result.opaqueKind = block.opaqueKind;
                result.opaqueStartCharacter = block.opaqueStartCharacter;
            }
            return result;
        });
    } catch (error) {
        if (error?.name === 'CancellationError') throw error;
        return [];
    }
}

module.exports = {
    collectBlocksFromLineReader,
    collectBlocksFromLineReaderAsync,
    collectBlocksFromFile,
};

export {};
