'use strict';

const blockScanner = require('../parser/blockScanner');

class BlockIndex {
    constructor(filePath) {
        this.filePath = filePath;
        this.blocks = []; // Array of { keyword, startLine, endLine }
        this.lineCount = 0;
    }

    buildIndex(lineCount, getLine) {
        this.lineCount = lineCount;
        this.blocks = blockScanner.collectBlocksFromLineReader(lineCount, getLine);
    }

    async buildIndexFromFile(filePath) {
        this.blocks = await blockScanner.collectBlocksFromFile(filePath);
        if (this.blocks.length > 0) {
            this.lineCount = this.blocks[this.blocks.length - 1].endLine + 1;
        } else {
            this.lineCount = 0;
        }
    }

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
