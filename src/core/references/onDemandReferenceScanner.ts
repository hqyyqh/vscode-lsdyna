'use strict';

const fs = require('node:fs');
const { isMeshKeyword } = require('../scanner/scannerContracts');
const path = require('node:path');
const { scanBlockLinesFromDisk } = require('./onDemandDefinitionScanner');
const { keywordInputFormat, globalInputFormatFromKeywordLine } = require('../parser/inputFormat');
const { parameterContextsForDocument, analyzeIntegerParameterValueAtLocation } = require('./projectReferenceIndex');
const { DEFAULT_MAX_MATCHES, namespaceMatches, coverageGapMatches, occurrenceBinding,
    collectRegistryReferenceMatches } =
    require('./registryReferenceNetwork');
const { nativeRepeatedReferenceLayout, semanticOccurrence, LSPP_REFERENCE_CATALOG,
    getCatalogFieldReferenceInfo, formatTokenRange, relationNamespaces, nativeRepeatedReferenceField,
    nativeRepeatedReferenceRecord, nativeRepeatedReferenceReader,
    scanNativeLayoutRelations, lsppReferenceRecordsForKeyword, lsppBlockedRecordsForKeyword,
    nativeReferenceCoversField, semanticReferenceRecordsForKeyword, scanRegistryReferenceOccurrencesFromFileIndex } =
    require('./registryReferenceScanner');
const { nativeOccurrenceOffset } = require('./nativeIncludeOffsets');
const MAX_ORDINARY_BLOCK_BYTES = 256 * 1024;

const RECOVERABLE_REASONS = new Set([
    'registry-reference-scan-deferred',
    'registry-reference-preview-byte-limit', 'registry-reference-capacity-exceeded',
    'registry-value-domain-capacity-exceeded',
    'registry-reference-native-layout-unavailable',
    'native-user-material-controller-unresolved', 'native-user-material-records-incomplete',
    'native-em-read-order-unresolved', 'native-em-occurrence-layout-ambiguous',
    'registry-reference-sibling-discriminator-indeterminate',
]);

function pathKey(file) {
    const resolved = path.resolve(file);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function retainMatches(scratch, referenceIndex, query, result, seen, maxMatches, collectAllIds = false, acceptOccurrence = null, retainOccurrences = true) {
    if (!retainOccurrences) seen = new Set();
    let failed = scratch.referenceCoverage.gaps.some(item => coverageGapMatches(query, item));
    for (const occurrence of scratch.referenceOccurrences) {
        if (!namespaceMatches(query, occurrence)) continue;
        if (!collectAllIds) {
            const binding = occurrenceBinding(referenceIndex, occurrence, { bindingOnly: true, query });
            if (binding.unresolvedOccurrenceReasons?.length) failed = true;
            if (binding.excluded) continue;
            if (!binding.ready) { failed = true; continue; }
            if (binding.analysis.id !== query.id || !namespaceMatches(query, binding.analysis)) continue;
        }
        const key = [pathKey(occurrence.filePath), occurrence.lineIndex,
            occurrence.startCharacter, occurrence.endCharacter,
            collectAllIds ? occurrence.occurrenceId : ''].join(':');
        if (seen.has(key)) continue;
        if (result.occurrences.length >= maxMatches) { failed = true; continue; }
        if (acceptOccurrence && !acceptOccurrence(occurrence)) { failed = true; continue; }
        seen.add(key);
        if (retainOccurrences) result.occurrences.push(occurrence);
    }
    return failed;
}

async function scanReferencePrefix(block, limit, scanBlockLines, result, cancellationToken) {
    const prefix = [];
    let pending = 0, pendingLine = 0;
    const read = await scanBlockLines(block, (line, lineIndex) => {
        result.scannedLines++;
        const trimmed = line.trim();
        if (trimmed.startsWith('$') || trimmed.startsWith('*') || prefix.length >= limit) return;
        if (!trimmed) { if (prefix.length) { if (!pending) pendingLine = lineIndex; pending++; } return; }
        for (let index = 0; index < pending && prefix.length < limit; index++)
            prefix.push({ text: '', lineIndex: pendingLine + index });
        pending = 0;
        if (prefix.length < limit) prefix.push({ text: line, lineIndex });
    }, cancellationToken);
    result.scannedBlocks++;
    return { prefix, read };
}

/** Query existing readers; retain all unrelated coverage gaps. */
async function scanOnDemandReferences({ referenceIndex, fileIndexes, query,
    scanBlockLines = scanBlockLinesFromDisk, cancellationToken = null,
    maxMatches = DEFAULT_MAX_MATCHES, collectAllIds = false, acceptOccurrence = null, retainOccurrences = true } = {} as any) {
    if (!retainOccurrences && (!collectAllIds || typeof acceptOccurrence !== 'function'))
        throw new Error('Streaming references require an all-ID consumer');
    const result: any = { occurrences: [], resolvedGaps: new Set(), gaps: [], cancelled: false,
        scannedBlocks: 0, scannedLines: 0 };
    const options = { referenceCatalog: LSPP_REFERENCE_CATALOG,
        maxReferenceOccurrences: Infinity, maxValueDomainOccurrences: Infinity,
        infoCache: new Map(), formatCache: new Map() };
    const entries = fileIndexes instanceof Map ? [...fileIndexes] : Object.entries(fileIndexes || {});
    const seen = new Set();
    for (const [filePath, fileIndex] of entries as [string, any][]) {
        const gaps = (referenceIndex.registryReferenceCoverageGaps || []).filter(gap =>
            pathKey(gap.filePath) === pathKey(filePath) && coverageGapMatches(query, gap) &&
            RECOVERABLE_REASONS.has(gap.reason));
        if (!gaps.length) continue;
        // Unsaved documents must use the caller's current document reader.
        if (Number.isInteger(fileIndex.documentVersion) && scanBlockLines === scanBlockLinesFromDisk) continue;
        const fileUnchanged = async () => {
            if (Number.isInteger(fileIndex.documentVersion)) return true;
            if (!Number.isFinite(fileIndex.size) || !Number.isFinite(fileIndex.mtimeMs)) return false;
            try {
                const stat = await fs.promises.stat(filePath);
                return stat.size === fileIndex.size && stat.mtimeMs === fileIndex.mtimeMs;
            } catch (_error) { return false; }
        };
        if (!await fileUnchanged()) continue;
        const contexts = parameterContextsForDocument(referenceIndex, filePath);
        if (contexts.length > 1) {
            let resolved = new Set(gaps);
            for (const context of contexts) {
                const scoped = { ...referenceIndex, parameterContextsByFile: new Map([[filePath, [context]]]) };
                const recovered = await scanOnDemandReferences({ referenceIndex: scoped,
                    fileIndexes: new Map([[filePath, fileIndex]]), query, scanBlockLines, cancellationToken,
                    maxMatches, collectAllIds, retainOccurrences,
                    acceptOccurrence: acceptOccurrence ? occurrence => acceptOccurrence({ ...occurrence, occurrenceId: context.occurrenceId }) : null });
                if (recovered.cancelled) return { ...result, cancelled: true };
                result.scannedBlocks += recovered.scannedBlocks; result.scannedLines += recovered.scannedLines;
                result.gaps.push(...recovered.gaps);
                resolved = new Set([...resolved].filter(gap => recovered.resolvedGaps.has(gap)));
                for (const occurrence of recovered.occurrences) {
                    const key = [pathKey(filePath), occurrence.lineIndex, occurrence.startCharacter, occurrence.endCharacter,
                        collectAllIds ? context.occurrenceId : ''].join(':');
                    if (seen.has(key)) continue;
                    if (result.occurrences.length >= maxMatches) { resolved.clear(); continue; }
                    seen.add(key); result.occurrences.push({ ...occurrence, occurrenceId: context.occurrenceId });
                }
            }
            for (const gap of resolved) result.resolvedGaps.add(gap);
            continue;
        }
        const modes = new Set(contexts.map(context => context.inputFormatMode || 'standard'));
        if (contexts.length === 0) continue;
        const occurrenceFormats = new Map(contexts.map(context => [context.occurrenceId, context.inputFormatMode || 'standard']));
        let globalFormat = [...modes][0];
        const offsets = contexts.map(context => nativeOccurrenceOffset(context, query.targetKinds || [],
            query.targetDefinitions || []));
        const sourceIds = !collectAllIds && typeof query.id === 'number' && offsets.every(offset => Number.isSafeInteger(offset))
            ? new Set(offsets.map(offset => query.id - offset)) : null;
        for (const sourceBlock of fileIndex.keywordBlocks || []) {
            if (fileIndex.excludeMeshEntities && isMeshKeyword(sourceBlock.keyword)) continue;
            if (cancellationToken?.isCancellationRequested) return { ...result, cancelled: true };
            const keyword = String(sourceBlock.keyword || '').replace(/^\*/, '').toUpperCase()
                .replace(/[+%\-]$/, '');
            if (keyword === 'KEYWORD') {
                globalFormat = globalInputFormatFromKeywordLine(sourceBlock.rawKeyword || sourceBlock.keyword, globalFormat);
                for (const [id, mode] of occurrenceFormats) occurrenceFormats.set(id,
                    globalInputFormatFromKeywordLine(sourceBlock.rawKeyword || sourceBlock.keyword, mode));
                continue;
            }
            const blockGaps = gaps.filter(gap => gap.startLine >= sourceBlock.startLine &&
                gap.startLine <= sourceBlock.endLine);
            if (!blockGaps.length) continue;
            const block = { ...sourceBlock, filePath };
            const formatMode = keywordInputFormat(sourceBlock.rawKeyword || sourceBlock.keyword, globalFormat);
            const gap = reason => ({ reason, filePath, keyword: sourceBlock.keyword,
                startLine: sourceBlock.startLine, scope: 'namespaces',
                targetKinds: query.targetKinds, targetDefinitions: query.targetDefinitions });
            const relations = lsppReferenceRecordsForKeyword(keyword);
            const { lookupKeywordSchema, loadKeywordSchema, getRenderedCardsForLookup } = require('../keywordSchema');
            const lookup = lookupKeywordSchema(keyword, loadKeywordSchema(() => 'en'));
            const { getRegistryApprovedFieldReferenceInfo } = require('./fieldReferenceClassifier');
            // Source records can flatten later cards. Use the same rendered
            // field coordinates and approvals as the ordinary manual scanner.
            const hasSupplement = lookup ? getRenderedCardsForLookup(lookup).some((card, index) =>
                card.some(field => {
                    const request = { keyword, cardIndex: index + 1, field };
                    const info = !nativeReferenceCoversField(request) && getRegistryApprovedFieldReferenceInfo(request);
                    return info && namespaceMatches(query, info);
                })) : semanticReferenceRecordsForKeyword(keyword).some(record => namespaceMatches(query, relationNamespaces(record)));
            let blocked = lsppBlockedRecordsForKeyword(keyword);
            if (!blocked.length && lookup?.canonicalName) blocked = lsppBlockedRecordsForKeyword(lookup.canonicalName);
            const needsFullScan = hasSupplement ||
                blocked.some(record => {
                    const namespaces = relationNamespaces({ ...record, targetKinds: record.targetKind ? [record.targetKind] : [] });
                    return !namespaces.targetKinds.length && !namespaces.targetDefinitions.length || namespaceMatches(query, namespaces);
                }) || !require('../semantics/semanticRuntimeV2').getSemanticRuntimeCatalogV2().status().ready;
            if (blockGaps.every(item => item.reason === 'registry-reference-scan-deferred') &&
                !needsFullScan && !relations.some(record => namespaceMatches(query, relationNamespaces(record)))) {
                for (const item of blockGaps) result.resolvedGaps.add(item);
                continue;
            }
            if (!needsFullScan && keyword === 'EM_ISOPOTENTIAL_CONNECT' && relations.length &&
                relations.every(record => record.nativeLayout?.kind === 'em-connection-records')) {
                const { prefix, read } = await scanReferencePrefix(block, 3, scanBlockLines, result, cancellationToken);
                if (read?.cancelled || cancellationToken?.isCancellationRequested) return { ...result, cancelled: true };
                if (!await fileUnchanged()) { result.gaps.push(gap('on-demand-file-changed')); continue; }
                let failed = false;
                for (const context of contexts) {
                    const nativeReadLayout = require('./projectReferenceIndex')
                        .nativeEmReadLayoutAtLocation(referenceIndex, filePath, sourceBlock.startLine, context.occurrenceId);
                    const scratch = { complete: true, reasons: [], referenceOccurrences: [],
                        valueDomainOccurrences: [], referenceCoverage: { complete: true, gaps: [] } };
                    const scoped = { ...referenceIndex, parameterContextsByFile: new Map([[filePath, [context]]]) };
                    const parameters = require('../semantics/nativeParameterContext').createNativeParameterContext(scoped, filePath, 0);
                    scanNativeLayoutRelations({ block, keyword, entries: prefix,
                        relations: relations.filter(record => namespaceMatches(query, relationNamespaces(record))),
                        result: scratch, options,
                        formatMode: keywordInputFormat(sourceBlock.rawKeyword || sourceBlock.keyword, occurrenceFormats.get(context.occurrenceId)),
                        parameters, nativeReadLayout });
                    for (const occurrence of scratch.referenceOccurrences) occurrence.occurrenceId = context.occurrenceId;
                    if (retainMatches(scratch, referenceIndex, query, result, seen, maxMatches, collectAllIds, acceptOccurrence, retainOccurrences)) failed = true;
                }
                if (read?.complete !== true || failed) result.gaps.push(gap(read?.reason || 'on-demand-reference-scan-incomplete'));
                else for (const item of blockGaps) result.resolvedGaps.add(item);
                continue;
            }
            if (modes.size !== 1) continue;
            const spelling = require("../semantics/catalogNativeFileLayout").nativeSpellingBinding(keyword);
            const finiteBound = spelling?.layout && require('../semantics/nativeConditionalLayout')
                .nativeConditionalRecordBound(spelling.layout);
            // Single material constants have no links after nine records. Exact
            // saved suffix grammars likewise have a finite maximum branch length.
            const prefixBound = finiteBound ? finiteBound + Number(!!spelling.prefixCard) :
                relations.length && relations.every(record => record.nativeLayout?.kind === 'user-material-records') ? 9 : null;
            if (prefixBound && !needsFullScan) {
                const { prefix, read } = await scanReferencePrefix(block, prefixBound, scanBlockLines, result, cancellationToken);
                if (read?.cancelled || cancellationToken?.isCancellationRequested) return { ...result, cancelled: true };
                if (!await fileUnchanged()) { result.gaps.push(gap('on-demand-file-changed')); continue; }
                const scratch = { complete: true, reasons: [], referenceOccurrences: [],
                    valueDomainOccurrences: [], referenceCoverage: { complete: true, gaps: [] } };
                const parameters = require('../semantics/nativeParameterContext').createNativeParameterContext(referenceIndex, filePath, 0);
                scanNativeLayoutRelations({ block, keyword, entries: prefix,
                    relations: relations.filter(record => namespaceMatches(query, relationNamespaces(record))),
                    result: scratch, options, formatMode, parameters });
                const failed = retainMatches(scratch, referenceIndex, query, result, seen, maxMatches, collectAllIds, acceptOccurrence, retainOccurrences);
                if (read?.complete !== true || failed) result.gaps.push(gap(read?.reason || 'on-demand-reference-scan-incomplete'));
                else for (const item of blockGaps) result.resolvedGaps.add(item);
                continue;
            }
            const layout = needsFullScan ? null : nativeRepeatedReferenceLayout(keyword);
            if (!layout) {
                // ponytail: 256 KiB ordinary block replay; add verified streaming readers for larger blocks.
                if (block.endOffset - block.startOffset > MAX_ORDINARY_BLOCK_BYTES) continue;
                const lines = [sourceBlock.rawKeyword || sourceBlock.keyword];
                let retainedBytes = lines[0].length * 2 + 32, overflow = false;
                const read = await scanBlockLines(block, (line, lineIndex) => {
                    result.scannedLines++;
                    retainedBytes += line.length * 2 + 32;
                    if (retainedBytes > MAX_ORDINARY_BLOCK_BYTES || lineIndex !== block.startLine + lines.length) overflow = true;
                    if (!overflow) lines.push(line);
                }, cancellationToken);
                result.scannedBlocks++;
                if (read?.cancelled || cancellationToken?.isCancellationRequested) return { ...result, cancelled: true };
                if (!await fileUnchanged()) { result.gaps.push(gap('on-demand-file-changed')); continue; }
                if (read?.complete !== true || overflow) {
                    result.gaps.push(gap(read?.reason || 'on-demand-reference-scan-incomplete')); continue;
                }
                const scratch = await scanRegistryReferenceOccurrencesFromFileIndex(
                    { ...fileIndex, keywordBlocks: [block] }, async () => lines.join('\n'),
                    { cancellationToken, initialInputFormatMode: globalFormat,
                        nativeParameters: require('../semantics/nativeParameterContext').createNativeParameterContext(referenceIndex, filePath, 0),
                        nativeReadLayout: require('./projectReferenceIndex').nativeEmReadLayoutAtLocation(
                            referenceIndex, filePath, sourceBlock.startLine, contexts[0].occurrenceId) });
                if (scratch.cancelled || cancellationToken?.isCancellationRequested) return { ...result, cancelled: true };
                if (!await fileUnchanged()) { result.gaps.push(gap('on-demand-file-changed')); continue; }
                const failed = retainMatches(scratch, referenceIndex, query, result, seen, maxMatches, collectAllIds, acceptOccurrence, retainOccurrences);
                if (failed) result.gaps.push(gap('on-demand-reference-scan-incomplete'));
                else for (const item of blockGaps) result.resolvedGaps.add(item);
                continue;
            }
            for (const [cardIndex, records] of layout.fieldsByCard) {
                layout.fieldsByCard.set(cardIndex, records.filter(record =>
                    namespaceMatches(query, relationNamespaces(record))).map(record => {
                        const field = nativeRepeatedReferenceField(record);
                        return { ...record, field,
                            info: getCatalogFieldReferenceInfo({ keyword, cardIndex: record.cardIndex, field }) };
                    }));
            }
            const { nativeReadInputFormat, nativeReadInputFailure } = require('../semantics/nativeInputFormat');
            if (nativeReadInputFailure(layout.rule, sourceBlock.rawKeyword || sourceBlock.keyword, globalFormat)) continue;
            const readMode = nativeReadInputFormat(layout.rule, sourceBlock.rawKeyword || sourceBlock.keyword, globalFormat);
            const reader = nativeRepeatedReferenceReader(layout, keyword, readMode, (raw, lineIndex) => {
                if (!raw.includes('&') && !raw.trim().startsWith('<')) return raw;
                const value = analyzeIntegerParameterValueAtLocation(referenceIndex, raw, { documentPath: filePath, lineIndex });
                return value.resolved ? String(value.value) : raw;
            });
            const size = layout.cardCount + Number(layout.title && !['ordinal-fixed', 'batch-fixed'].includes(layout.kind));
            let ordinal = 0, pendingBlanks = 0, pendingStart = 0;
            let instance: any[] = [], failed = false;
            const prefixEntries: any[] = [];
            const retainedStart = result.occurrences.length;
            const parameters = require('../semantics/nativeParameterContext').createNativeParameterContext(referenceIndex, filePath, 0);
            const scanInstance = () => {
                const cardEntries = [...(layout.prefixCardCount || layout.repeatedTail ? prefixEntries : []), ...instance]
                    .filter(entry => entry.native.cardIndex !== 0);
                let scratch = null;
                for (const entry of cardEntries) {
                    for (const record of layout.fieldsByCard.get(entry.native.cardIndex) || []) {
                        const { info } = record;
                        const field = nativeRepeatedReferenceField(record, entry.text, readMode);
                        const range = formatTokenRange(entry.text, field, formatMode,
                            info.definitionRegistry, options, keyword);
                        if (range === null) continue;
                        // Prefilter only numeric tokens; binding below still applies parameters and INCLUDE offsets.
                        if (range && sourceIds && /^[+-]?\d+$/.test(range.raw) &&
                            !sourceIds.has(Math.abs(Number(range.raw)))) continue;
                        scratch ||= { complete: true, reasons: [], referenceOccurrences: [],
                            valueDomainOccurrences: [], referenceCoverage: { complete: true, gaps: [] } };
                        semanticOccurrence({ block, keyword, cardIndex: record.cardIndex,
                            field,
                            line: entry.text, lineIndex: entry.lineIndex, result: scratch,
                            options, formatMode, entries: cardEntries, parameters });
                    }
                }
                if (scratch && retainMatches(scratch, referenceIndex, query, result, seen, maxMatches, collectAllIds, acceptOccurrence, retainOccurrences)) failed = true;
                instance = [];
            };
            const scanRecord = (line, lineIndex) => {
                ordinal++;
                const native = reader ? reader.next(line, lineIndex) :
                    nativeRepeatedReferenceRecord(layout, ordinal, /_TITLE$/.test(keyword), line);
                if (!native) { failed = true; return; }
                if (native.cardIndex === 0) return;
                const entry = { text: line, lineIndex, native };
                if (layout.repeatedTail) {
                    if (!native.tail) {
                        prefixEntries.push(entry);
                        if (ordinal - layout.keywordPrefixCount < layout.repeatedTail - 1 + Number(layout.title)) return;
                    } else {
                        instance.push(entry);
                        if (reader ? !native.instanceComplete : instance.length < layout.tailCardCount) return;
                    }
                } else if (layout.prefixCardCount && ordinal <= layout.prefixCardCount) {
                    prefixEntries.push(entry);
                    return;
                } else {
                    instance.push(entry);
                    if (['controlled-reference-records', 'ale-motion-single', 'contact-optional-records', 'shell', 'ordinal-ambient', 'ordinal-d3spcm'].includes(layout.kind) ? !native.instanceComplete : layout.kind !== 'ale-trim-records' &&
                        (ordinal - layout.keywordPrefixCount - layout.prefixCardCount) % (size - layout.prefixCardCount) !== 0) return;
                }
                scanInstance();
            };
            const read = await scanBlockLines(block, (line, lineIndex) => {
                result.scannedLines++;
                const trimmed = line.trim();
                if (trimmed.startsWith('$') || trimmed.startsWith('*')) return;
                if (!trimmed) {
                    if (ordinal > 0) { if (!pendingBlanks) pendingStart = lineIndex; pendingBlanks++; }
                    return;
                }
                for (let index = 0; index < pendingBlanks; index++) scanRecord('', pendingStart + index);
                pendingBlanks = 0;
                scanRecord(line, lineIndex);
            }, cancellationToken);
            result.scannedBlocks++;
            if (read?.cancelled || cancellationToken?.isCancellationRequested) return { ...result, cancelled: true };
            if (!await fileUnchanged()) {
                result.occurrences.length = retainedStart;
                result.gaps.push(gap('on-demand-file-changed'));
                continue;
            }
            if (layout.kind === 'contact-optional-records' && instance.length && reader.complete()) scanInstance();
            if (read?.complete !== true || failed || instance.length > 0 ||
                layout.kind === 'reference-single' && ordinal - layout.keywordPrefixCount < layout.cardCount + Number(layout.cardSequence && layout.title) ||
                (reader ? !reader.complete() : layout.repeatedTail &&
                    (ordinal - layout.keywordPrefixCount < layout.repeatedTail - 1 + Number(layout.title) ||
                        (ordinal - layout.keywordPrefixCount - layout.repeatedTail + 1 - Number(layout.title)) % layout.tailCardCount !== 0))) {
                result.gaps.push(gap(read?.reason || 'on-demand-reference-scan-incomplete'));
            } else {
                for (const item of blockGaps) result.resolvedGaps.add(item);
            }
        }
    }
    return result;
}

async function queryRegistryReferences({ referenceIndex, fileIndexes, query, cancellationToken = null,
    collectReferences = collectRegistryReferenceMatches, retainVerifiedMatchesOnIncomplete = false,
    ...options } = {} as any) {
    const referenceLookup = await scanOnDemandReferences({ referenceIndex, fileIndexes, query, cancellationToken, ...options });
    if (referenceLookup.cancelled) return { state: 'cancelled', locations: [], reasons: ['cancelled'], referenceIndex, referenceLookup };
    const recovered = { ...referenceIndex,
        registryReferenceOccurrences: [...referenceIndex.registryReferenceOccurrences, ...referenceLookup.occurrences],
        registryReferenceCoverageGaps: [...referenceIndex.registryReferenceCoverageGaps, ...referenceLookup.gaps] };
    return { ...collectReferences(recovered, query, { cancellationToken, retainVerifiedMatchesOnIncomplete,
        resolvedCoverageGaps: referenceLookup.resolvedGaps }), referenceIndex: recovered, referenceLookup };
}

module.exports = { scanOnDemandReferences, queryRegistryReferences };
export {};
