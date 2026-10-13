'use strict';
const fs = require('fs');
const { collectIncludeDirectivesFromKeywordBlocks } = require('../parser/includeScanner');
const { scanCurveTableDefinitionsFromFileIndex } = require('../references/curveTableDefinitionScanner');
const { scanParameterEventsFromFileIndex } = require('../references/parameterDefinitionScanner');
const { scanRegistryReferenceOccurrencesFromFileIndex } = require('../references/registryReferenceScanner');
const { readBlockText, readBlockHeaderText, createBlockReadWindow } = require('./blockReader');
const { SCANNER_VERSION, throwIfCancellationRequested, isMeshKeyword } = require('./scannerContracts');
const { scanKeywordSkeletonFromFile } = require('./keywordSkeletonScanner');
const { createKeywordIdentityAccumulatorFactory } = require('../keywordDisplayIdentity');
const { globalInputFormatFromKeywordLine } = require('../parser/inputFormat');
type FileIndexBuildOptions = {
    liveSource?: { signature: any; keywordBlocks: any[]; readBlockText: (block: any, options?: any) => Promise<string> };
    readBlockText?: (block: any, options?: any) => Promise<string>;
    onProgress?: (progress: any) => void;
    onStructureBlock?: (block: any, complete: boolean) => void;
    onIncludePending?: (filePath: string, entries: any[]) => void;
    flushStructure?: () => Promise<void>;
    highWaterMark?: number;
    maxStructureBytes?: number;
    cancellationToken?: {
        isCancellationRequested?: boolean;
    };
    maxDefinitionBlockBytes?: number;
    maxReferenceBlockBytes?: number;
    referenceTargetKinds?: string[];
    definitionsOnly?: boolean;
    definitionCache?: any;
    excludeMeshEntities?: boolean;
    deferDisplayIdentity?: boolean;
    referenceScanCache?: any;
    largeFileThresholdBytes?: number;
};
const DEFAULT_MAX_DEFINITION_BLOCK_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REFERENCE_BLOCK_BYTES = 16 * 1024 * 1024;
const LARGE_FILE_THRESHOLD_BYTES = 50 * 1024 * 1024;
const LARGE_FILE_LINE_MAP_STRIDE = 4096;
function markTruncatedDefinitionPreviews(referenceDefinitions, truncatedStartLines) {
    for (const definition of [
        ...(referenceDefinitions?.curves || []),
        ...(referenceDefinitions?.tables || []),
        ...(referenceDefinitions?.genericDefinitions || []),
    ]) {
        if (!truncatedStartLines.has(definition.startLine))
            continue;
        definition.dataCompleteness = {
            state: 'partial',
            reasons: [...new Set([
                    ...(definition.dataCompleteness?.reasons || []),
                    'preview-byte-limit',
                ])],
        };
    }
}
function fileStructureOptionsKey(options: FileIndexBuildOptions = {}) {
    return JSON.stringify([options.largeFileThresholdBytes ?? LARGE_FILE_THRESHOLD_BYTES, options.deferDisplayIdentity === true]);
}
async function buildFileStructure(filePath, options: FileIndexBuildOptions = {}) {
    throwIfCancellationRequested(options.cancellationToken);
    const startedAt = Date.now();
    const stat = options.liveSource?.signature || await fs.promises.stat(filePath);
    const largeFileThresholdBytes = options.largeFileThresholdBytes ?? LARGE_FILE_THRESHOLD_BYTES;
    const collectLargeFileLineMap = !options.liveSource && stat.size >= largeFileThresholdBytes;
    const lineOffsets: number[] = [];
    const metadataBudget = options.maxStructureBytes ?? 64 * 1024 * 1024;
    let metadataBytes = 0;
    let scannedLineCount = 0;
    let pendingIncludeBlocks = [];
    const structuralReadOptions = {
        maxBytes: DEFAULT_MAX_DEFINITION_BLOCK_BYTES,
        onTruncated: () => { throw new RangeError('Structural block exceeds reader budget'); },
        cancellationToken: options.cancellationToken,
    };
    const keywordBlocks = options.liveSource?.keywordBlocks || await scanKeywordSkeletonFromFile(filePath, {
        ...options,
        onBlock: (block, complete) => {
            options.onStructureBlock?.(block, complete);
            if (complete && options.onIncludePending && block.keyword.startsWith('*INCLUDE')) pendingIncludeBlocks.push(block);
        },
        onYield: async () => {
            if (pendingIncludeBlocks.length) {
                const blocks = pendingIncludeBlocks; pendingIncludeBlocks = [];
                const partial = await collectIncludeDirectivesFromKeywordBlocks(filePath, blocks,
                    block => readBlockText(block, 'utf8', structuralReadOptions), options);
                options.onIncludePending(filePath, partial.includeEntries);
            }
            await options.flushStructure?.();
        },
        createBlockSummaryAccumulator: options.deferDisplayIdentity ? undefined : createKeywordIdentityAccumulatorFactory(),
        ...(collectLargeFileLineMap ? {
            onLineStart: (line, byteOffset) => {
                scannedLineCount = line + 1;
                if (line % LARGE_FILE_LINE_MAP_STRIDE === 0) {
                    if ((lineOffsets.length + 1) * 16 > metadataBudget)
                        throw new RangeError('Line map exceeds structure budget');
                    lineOffsets.push(byteOffset);
                }
            },
        } : {}),
    });
    const handle = options.liveSource ? undefined : await fs.promises.open(filePath, 'r');
    const read = async (block, readOptions: any = {}) => {
        // ponytail: conservatively reserve 16x source bytes for structural metadata;
        // use record-level accounting if real projects hit this ceiling with small parsed results.
        const remaining = Math.floor((metadataBudget - metadataBytes) / 16);
        if (remaining <= 0) throw new RangeError('Structural metadata exceeds scan budget');
        const bounded = { ...structuralReadOptions, ...readOptions,
            maxBytes: Math.min(readOptions.maxBytes ?? structuralReadOptions.maxBytes, remaining) };
        const text = options.liveSource ? await options.liveSource.readBlockText(block, bounded)
            : await readBlockText(block, 'utf8', { handle, ...bounded });
        metadataBytes += Buffer.byteLength(text, 'utf8') * 16;
        if (metadataBytes > metadataBudget) throw new RangeError('Structural metadata exceeds scan budget');
        return text;
    };
    try {
        const includeResult = await collectIncludeDirectivesFromKeywordBlocks(filePath, keywordBlocks, block => read(block), { cancellationToken: options.cancellationToken });
        const parameterEvents = await scanParameterEventsFromFileIndex({ filePath, keywordBlocks }, block => read(block), { cancellationToken: options.cancellationToken });
        const { nativeEmEventKeywords, nativeEmReadEvent } = require('../semantics/nativeEmReadState');
        const nativeReadEvents = [];
        let nativeGlobalFormat = 'standard';
        for (const block of keywordBlocks) {
            const keyword = String(block.keyword).replace(/^\*/, '').toUpperCase();
            if (keyword === 'KEYWORD') {
                nativeGlobalFormat = globalInputFormatFromKeywordLine(block.rawKeyword || block.keyword, nativeGlobalFormat);
                nativeReadEvents.push({ kind: 'input-format', startLine: block.startLine,
                    rawKeyword: block.rawKeyword || block.keyword });
                continue;
            }
            if (!nativeEmEventKeywords.has(keyword)) continue;
            const text = await read(block, { maxBytes: 4096 });
            const event = nativeEmReadEvent(block, text, nativeGlobalFormat);
            if (event) nativeReadEvents.push({ ...event, variants: Object.fromEntries(['standard','long','i10']
                .map(format => [format, nativeEmReadEvent(block, text, format)])) });
        }
        return {
            filePath,
            ...(options.liveSource ? { documentVersion: stat.documentVersion, documentRevision: stat.sourceRevision } : {}),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            scannerVersion: SCANNER_VERSION,
            structureOptionsKey: fileStructureOptionsKey(options),
            keywordBlocks,
            ...(collectLargeFileLineMap ? {
                largeFileLineMap: {
                    stride: LARGE_FILE_LINE_MAP_STRIDE,
                    offsets: lineOffsets,
                    lineCount: scannedLineCount,
                },
            } : {}),
            parameterEvents,
            structuralMetadataBytes: metadataBytes + lineOffsets.length * 16,
            nativeReadEvents,
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
    finally {
        await handle?.close();
    }
}
async function completeFileIndex(structure, options: FileIndexBuildOptions = {}) {
    const { filePath } = structure;
    const keywordBlocks = options.excludeMeshEntities ? structure.keywordBlocks.filter(block =>
        !isMeshKeyword(block.keyword)) : structure.keywordBlocks;
    const startedAt = Date.now();
    const handle = options.readBlockText ? undefined : await fs.promises.open(filePath, 'r');
    const readWindow = handle ? createBlockReadWindow(handle) : undefined;
    let lastProgress = 0;
    const read = async (block, encoding, readOptions) => {
        if (Date.now() - lastProgress >= 50) {
            await new Promise(resolve => setImmediate(resolve));
            throwIfCancellationRequested(options.cancellationToken);
            options.onProgress?.({ phase: 'references', filePath });
            lastProgress = Date.now();
        }
        if (options.readBlockText) return options.readBlockText(block, readOptions);
        return readOptions.headerDataRecords
            ? readBlockHeaderText(block, readOptions.headerDataRecords, { ...readOptions, handle: readWindow })
            : readBlockText(block, encoding, { ...readOptions, handle: readWindow });
    };
    try {
        const truncatedDefinitionStartLines = new Set();
        const referenceDefinitions = await scanCurveTableDefinitionsFromFileIndex({ filePath, keywordBlocks }, (block, headerDataRecords) => read(block, 'utf8', {
            headerDataRecords,
            cancellationToken: options.cancellationToken,
            maxBytes: options.maxDefinitionBlockBytes ?? DEFAULT_MAX_DEFINITION_BLOCK_BYTES,
            onTruncated: () => truncatedDefinitionStartLines.add(block.startLine),
        }), undefined, { cancellationToken: options.cancellationToken, targetKinds: options.referenceTargetKinds,
            definitionCache: options.definitionCache });
        throwIfCancellationRequested(options.cancellationToken);
        markTruncatedDefinitionPreviews(referenceDefinitions, truncatedDefinitionStartLines);
        if (options.definitionsOnly) return { ...structure, referenceDefinitions };
        const truncatedReferenceStartLines = new Set();
        const registryReferences = await scanRegistryReferenceOccurrencesFromFileIndex({ filePath, keywordBlocks, referenceDefinitions }, block => read(block, 'utf8', {
            cancellationToken: options.cancellationToken,
            maxBytes: options.maxReferenceBlockBytes ?? DEFAULT_MAX_REFERENCE_BLOCK_BYTES,
            onTruncated: () => truncatedReferenceStartLines.add(block.startLine),
        }), {
            cancellationToken: options.cancellationToken,
            truncatedStartLines: truncatedReferenceStartLines,
            targetKinds: options.referenceTargetKinds,
            excludeMeshEntities: options.excludeMeshEntities,
            sharedCache: options.referenceScanCache,
        });
        if (truncatedReferenceStartLines.size > 0) {
            registryReferences.complete = false;
            registryReferences.reasons = [...new Set([
                    ...(registryReferences.reasons || []),
                    'registry-reference-preview-byte-limit',
                ])].sort();
        }
        throwIfCancellationRequested(options.cancellationToken);
        return { filePath: structure.filePath, size: structure.size, mtimeMs: structure.mtimeMs,
            scannerVersion: structure.scannerVersion, structureOptionsKey: structure.structureOptionsKey, excludeMeshEntities: options.excludeMeshEntities === true, keywordBlocks: structure.keywordBlocks,
            ...(structure.largeFileLineMap ? { largeFileLineMap: structure.largeFileLineMap } : {}),
            referenceDefinitions, registryReferences, parameterEvents: structure.parameterEvents,
            nativeReadEvents: structure.nativeReadEvents,
            includeEntries: structure.includeEntries, searchPaths: structure.searchPaths,
            pathEntries: structure.pathEntries,
            scanStats: { ...structure.scanStats,
                durationMs: structure.scanStats.durationMs + Date.now() - startedAt } };
    }
    finally {
        await handle?.close();
    }
}
async function buildFileIndex(filePath, options: FileIndexBuildOptions = {}) {
    for (let attempt = 0; ; attempt++) {
        try {
            const structure = await buildFileStructure(filePath, options);
            const index = await completeFileIndex(structure, options);
            const after = await fs.promises.stat(filePath);
            throwIfCancellationRequested(options.cancellationToken);
            if (after.size === structure.size && after.mtimeMs === structure.mtimeMs) return index;
            const error = new Error('File changed during scan: ' + filePath);
            error.name = 'ScanChangedError';
            throw error;
        } catch (error) {
            if (error?.name !== 'ScanChangedError' || attempt >= 1) throw error;
        }
    }
}

module.exports = {
    fileStructureOptionsKey,
    buildFileStructure,
    completeFileIndex,
    buildFileIndex,
    DEFAULT_MAX_DEFINITION_BLOCK_BYTES,
    DEFAULT_MAX_REFERENCE_BLOCK_BYTES,
    LARGE_FILE_LINE_MAP_STRIDE,
    LARGE_FILE_THRESHOLD_BYTES,
    markTruncatedDefinitionPreviews,
};
export {};
