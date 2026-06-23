'use strict';

const fs = require('fs');
const { collectIncludeDirectivesFromKeywordBlocks } = require('../parser/includeScanner');
const { readBlockText } = require('./blockReader');
const { SCANNER_VERSION } = require('./scannerContracts');
const { scanKeywordSkeletonFromFile } = require('./keywordSkeletonScanner');

type FileIndexBuildOptions = {
    highWaterMark?: number;
};

async function buildFileIndex(filePath, options: FileIndexBuildOptions = {}) {
    const startedAt = Date.now();
    const stat = await fs.promises.stat(filePath);
    const keywordBlocks = await scanKeywordSkeletonFromFile(filePath, options);
    const includeResult = await collectIncludeDirectivesFromKeywordBlocks(
        filePath,
        keywordBlocks,
        block => readBlockText(block)
    );

    return {
        filePath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        scannerVersion: SCANNER_VERSION,
        keywordBlocks,
        includeEntries: includeResult.includeEntries,
        searchPaths: includeResult.searchPaths,
        pathEntries: includeResult.pathEntries || [],
        scanStats: {
            mode: 'stream-skeleton',
            durationMs: Date.now() - startedAt,
            decodedLineCount: includeResult.includeEntries.length + (includeResult.pathEntries || []).length,
            keywordCount: keywordBlocks.length,
        },
    };
}

module.exports = {
    buildFileIndex,
};

export {};
