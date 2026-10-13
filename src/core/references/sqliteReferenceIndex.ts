import { createHash } from 'node:crypto';
import { EntityIndexStore, EntityIndexRecord } from '../cache/entityIndexStore';
import { entityFilesUnchanged, entityFileRevision } from '../cache/entityFileRevision';
import { EntityQueryCache } from './entityQueryCache';
import { queryIndexedTypeReferences } from './entityTypeReferenceIndex';
import { ReferenceMetadataPages } from './referenceMetadataPages';
const { scanOnDemandReferences } = require('./onDemandReferenceScanner');
const { scanBlockLinesFromDisk } = require('./onDemandDefinitionScanner');
const { parameterContextsForDocument } = require('./projectReferenceIndex');
const { namespaceMatches, occurrenceBinding, collectRegistryReferenceMatches } = require('./registryReferenceNetwork');
const { FILE_SCAN_CACHE_SCHEMA_VERSION } = require('../cache/fileScanCacheStore');
const { throwIfCancellationRequested } = require('../scanner/scannerContracts');
const { estimateMemorySize } = require('../cache/memorySize');

/** Persist parsed facts and candidate IDs; the existing resolver still decides each match. */
export class SqliteReferenceIndex {
    constructor(private store: EntityIndexStore, private fallback: EntityQueryCache,
        private onFallback: (error: unknown) => void, private resultBytes = 8 * 1024 * 1024) {}

    readonly query = async (options: any) => {
        try { return await this.queryStored(options); }
        catch (error) {
            if (['CancellationError', 'ScanChangedError'].includes((error as Error)?.name)) throw error;
            throwIfCancellationRequested(options.cancellationToken);
            this.onFallback(error);
            return queryIndexedTypeReferences(options, this.fallback);
        }
    };

    private async queryStored(options: any) {
        const entries = [...options.fileIndexes] as [string, any][];
        if (entries.some(([, index]) => !index.sourceRevision || Number.isInteger(index.documentVersion)))
            return queryIndexedTypeReferences(options, this.fallback);
        const files = entries.map(([file, index]) => ({ file, revision: index.sourceRevision }));
        const verify = async () => {
            if (!await entityFilesUnchanged(files, options.cancellationToken)) {
                throwIfCancellationRequested(options.cancellationToken);
                const error = new Error('Entity reference source changed'); error.name = 'ScanChangedError'; throw error;
            }
        };
        await verify();
        const referenceFiles = new Set(options.referenceIndex.registryReferenceOccurrences
            .filter(occurrence => namespaceMatches(options.query, occurrence)).map(occurrence => occurrence.filePath));
        const occurrences = [], recoveredGaps = [], resolvedGaps = new Set();
        const streamedReasons = new Set<string>();
        let bytes = 0, coverageBytes = 0, scannedBlocks = 0, scannedLines = 0;
        const metadata = new ReferenceMetadataPages(this.store, this.fallback);
        for (const [file, index] of entries) {
            const gaps = options.referenceIndex.registryReferenceCoverageGaps.filter(gap => gap.filePath === file);
            if (!gaps.length && !referenceFiles.has(file)) continue;
            const contexts = parameterContextsForDocument(options.referenceIndex, file);
            const key = createHash('sha256').update(JSON.stringify(['reference-facts-v3', file, contexts, gaps,
                options.query.targetKinds, options.query.targetDefinitions, FILE_SCAN_CACHE_SCHEMA_VERSION, index.excludeMeshEntities === true],
                (_key, value) => value instanceof Map ? [...value] : value)).digest('hex');
            let first = await this.store.page(key, index.sourceRevision, 'reference', options.query.id, 'reference', undefined, options.cancellationToken);
            if (first.state === 'miss') {
                let builtHere = false;
                const shared: any = await this.fallback.run(`sqlite-reference:${key}:${index.sourceRevision}`, options.cancellationToken,
                    async cancellationToken => {
                        builtHere = true;
                        return { state: 'persisted', lookup: await this.build(key, file, index, gaps, { ...options, cancellationToken }) };
                    });
                if (!shared.lookup) return queryIndexedTypeReferences(options, this.fallback);
                if (builtHere) { scannedBlocks += shared.lookup.scannedBlocks; scannedLines += shared.lookup.scannedLines; }
                first = await this.store.page(key, index.sourceRevision, 'reference', options.query.id, 'reference', undefined, options.cancellationToken);
            }
            if (first.state !== 'ready') throw new Error('Entity reference generation changed');
            const generation = first.generation;
            const coverageGaps = [];
            let coverageOffset = 0, coverageRecords = 0;
            do {
                const page = await this.store.factPage(key, index.sourceRevision, 'reference-coverage', coverageOffset,
                    options.cancellationToken, generation);
                if (page.state !== 'ready') throw new Error('Reference coverage expired');
                coverageRecords += page.records.length;
                const gapRows = await metadata.restore(page.records.filter(row => row.gap).map(row => row.gap),
                    key, index.sourceRevision, generation, options.cancellationToken);
                for (const gap of gapRows) {
                    coverageBytes += estimateMemorySize(gap, this.resultBytes) + 256;
                    if (coverageBytes > this.resultBytes) throw new RangeError('Reference coverage workspace exhausted');
                    coverageGaps.push(gap);
                }
                for (const row of page.records) if (Number.isSafeInteger(row.resolved)) {
                    if (!gaps[row.resolved]) throw new Error('Invalid resolved coverage record');
                    resolvedGaps.add(gaps[row.resolved]);
                }
                coverageOffset = page.next;
            } while (coverageOffset !== undefined);
            if (coverageRecords !== first.coverage.records) throw new Error('Reference coverage records missing');
            recoveredGaps.push(...coverageGaps);
            for (const [kind, id] of [['reference', options.query.id], ['dynamic', 'all']] as [string, string | number][]) {
                let page = kind === 'reference' ? first : await this.store.page(key, index.sourceRevision, kind, id, 'reference', undefined, options.cancellationToken);
                for (;;) {
                    if (page.state !== 'ready' || page.generation !== generation) throw new Error('Entity reference generation changed');
                    page.records = await metadata.restore(page.records, key, index.sourceRevision, generation, options.cancellationToken);
                    if (options.onLocations) {
                        const collected = (options.collectReferences || collectRegistryReferenceMatches)({ ...options.referenceIndex,
                            registryReferenceOccurrences: page.records,
                            registryReferenceCoverageGaps: [...gaps, ...coverageGaps] }, options.query,
                            { cancellationToken: options.cancellationToken, retainVerifiedMatchesOnIncomplete: true,
                                resolvedCoverageGaps: resolvedGaps });
                        for (const reason of collected.reasons || []) streamedReasons.add(reason);
                        await verify();
                        await options.onLocations(collected.locations.map(location => {
                            const occurrence = page.records.find(row => row.filePath === location.filePath &&
                                row.lineIndex === location.line && row.startCharacter === location.startCharacter);
                            return { ...location, role: 'reference', keyword: occurrence?.keyword || '',
                                fieldName: occurrence?.fieldName || '' };
                        }));
                    } else {
                    for (const occurrence of page.records) {
                        bytes += Buffer.byteLength(JSON.stringify(occurrence)) * 4 + 256;
                        if (bytes > this.resultBytes) throw new Error('Entity reference result budget exhausted');
                        occurrences.push(occurrence);
                    }
                    }
                    if (!page.next) break;
                    page = await this.store.page(key, index.sourceRevision, kind, id, 'reference', page.next, options.cancellationToken);
                }
            }
        }
        await verify();
        const referenceIndex = { ...options.referenceIndex, registryReferenceOccurrences: occurrences,
            registryReferenceCoverageGaps: [...options.referenceIndex.registryReferenceCoverageGaps, ...recoveredGaps] };
        const collect = options.collectReferences || collectRegistryReferenceMatches;
        const collected = collect(referenceIndex, options.query, { cancellationToken: options.cancellationToken,
            retainVerifiedMatchesOnIncomplete: options.retainVerifiedMatchesOnIncomplete, resolvedCoverageGaps: resolvedGaps }),
            reasons = [...new Set([...collected.reasons, ...streamedReasons])];
        return { ...collected, ...(reasons.length ? { state: 'partial', reasons } : {}),
            referenceIndex, metadataOccurrences: occurrences, referenceLookup: { scannedBlocks, scannedLines } };
    }

    private async build(key: string, file: string, index: any, gaps: any[], options: any) {
        const token = options.cancellationToken;
        if (await entityFileRevision(file) !== index.sourceRevision) throw new Error('Entity reference source revision is stale');
        const build = await this.store.begin(key, index.sourceRevision, token);
        if (!build) return null;
        let batch: EntityIndexRecord[] = [], bytes = 0, failure: unknown;
        let confirmed: any[] = [];
        const metadata = new ReferenceMetadataPages(this.store, this.fallback);
        const flush = async () => {
            if (!batch.length) return;
            try {
                await metadata.flush(build, token); await this.store.append(build, batch, token);
                if (confirmed.length && options.onLocations) {
                    if (await entityFileRevision(file) !== index.sourceRevision) {
                        const error = new Error('Entity reference source changed during construction');
                        error.name = 'ScanChangedError'; throw error;
                    }
                    try { await options.onLocations(confirmed); }
                    catch (error) {
                        // A departed reader cannot cancel the type shard needed by another reader.
                        if (error?.name !== 'CancellationError' || token?.isCancellationRequested) throw error;
                    }
                }
            }
            catch (error) { failure = error; throw error; }
            batch = []; confirmed = []; bytes = 0;
        };
        const accept = (occurrence: any) => {
            if (!namespaceMatches(options.query, occurrence)) return true;
            const search = occurrence.referenceValue?.targetSearch || occurrence.referenceValue?.semanticRelation?.targetSearch;
            const contexts = occurrence.occurrenceId === undefined ? parameterContextsForDocument(options.referenceIndex, file) : [];
            const bindings = search ? [] : contexts.length > 1
                ? contexts.map(context => occurrenceBinding(options.referenceIndex,
                    { ...occurrence, occurrenceId: context.occurrenceId }, { bindingOnly: true }))
                : [occurrenceBinding(options.referenceIndex, occurrence, { bindingOnly: true })];
            const dynamic = search || bindings.some(binding => !binding.ready || binding.unresolvedOccurrenceReasons?.length);
            const ids = dynamic ? ['all'] : [...new Set<string | number>(bindings.map(binding => binding.analysis.id))];
            if (options.onLocations && (dynamic || ids.includes(options.query.id))) {
                const matches = (options.collectReferences || collectRegistryReferenceMatches)({ ...options.referenceIndex,
                    registryReferenceOccurrences: [occurrence], registryReferenceCoverageGaps: [] }, options.query,
                    { cancellationToken: token, retainVerifiedMatchesOnIncomplete: true });
                for (const location of matches.locations) confirmed.push({ ...location, role: 'reference',
                    keyword: occurrence.keyword || '', fieldName: occurrence.fieldName || '' });
            }
            const payload = metadata.encode(occurrence);
            for (const id of ids) {
                const record: EntityIndexRecord = { key: JSON.stringify([occurrence.lineIndex, occurrence.startCharacter,
                    occurrence.endCharacter, occurrence.occurrenceId ?? '']), kind: dynamic ? 'dynamic' : 'reference', id,
                    role: 'reference', file, block: `b:${occurrence.startLine ?? occurrence.lineIndex}`, line: occurrence.lineIndex,
                    start: occurrence.startCharacter, end: occurrence.endCharacter, context: occurrence.occurrenceId || '', payload };
                bytes += Buffer.byteLength(JSON.stringify(record));
                if (bytes > 512 * 1024) {
                    failure = new Error('Entity reference context batch exceeds memory budget'); throw failure;
                }
                batch.push(record);
            }
            return true;
        };
        try {
            await this.store.metadata(build, { files: [{ file, revision: index.sourceRevision, parser: FILE_SCAN_CACHE_SCHEMA_VERSION }] }, token);
            let count = 0;
            for (const occurrence of options.referenceIndex.registryReferenceOccurrences) {
                if (++count % 256 === 0) { await new Promise(resolve => setImmediate(resolve)); throwIfCancellationRequested(token); }
                if (occurrence.filePath !== file) continue;
                accept(occurrence);
                if (bytes >= 128 * 1024 || batch.length >= 128) await flush();
            }
            const reader = options.scanBlockLines || scanBlockLinesFromDisk;
            let renewed = Date.now();
            const lookup = await scanOnDemandReferences({ ...options, fileIndexes: new Map([[file, index]]),
                referenceIndex: { ...options.referenceIndex, registryReferenceCoverageGaps: gaps },
                collectAllIds: true, retainOccurrences: false, acceptOccurrence: accept,
                scanBlockLines: async (block, visit, cancellationToken) => reader(block, async (...args) => {
                    await visit(...args);
                    if (bytes >= 128 * 1024 || batch.length >= 128) await flush();
                    if (Date.now() - renewed > 5000) { await this.store.renew(build); renewed = Date.now(); }
                }, cancellationToken) });
            if (failure) throw failure;
            throwIfCancellationRequested(token);
            if (lookup.cancelled) throw new Error('Entity reference scan cancelled');
            await flush();
            if (await entityFileRevision(file) !== index.sourceRevision) throw new Error('Entity reference source changed during construction');
            const unresolved = [...gaps.filter(gap => !lookup.resolvedGaps.has(gap)), ...lookup.gaps];
            let coverageRows = [], ordinal = 0;
            const flushCoverage = async () => {
                if (!coverageRows.length) return;
                await metadata.flush(build, token);
                await this.store.appendFacts(build, coverageRows, token);
                coverageRows = [];
            };
            for (const gap of lookup.gaps) {
                coverageRows.push({ section: 'reference-coverage', ordinal: ordinal++, payload: { gap: metadata.encode(gap) } });
                if (coverageRows.length >= 64) await flushCoverage();
            }
            for (let index = 0; index < gaps.length; index++) if (lookup.resolvedGaps.has(gaps[index])) {
                coverageRows.push({ section: 'reference-coverage', ordinal: ordinal++, payload: { resolved: index } });
                if (coverageRows.length >= 64) await flushCoverage();
            }
            await flushCoverage();
            const coverage = { state: unresolved.length ? 'partial' : 'complete',
                reasons: [...new Set<string>(unresolved.map(gap => String(gap.reason)))], records: ordinal };
            await this.store.publish(build, coverage, token);
            return { scannedBlocks: lookup.scannedBlocks, scannedLines: lookup.scannedLines };
        } catch (error) { await this.store.abandon(build).catch(() => {}); throw error; }
    }
}
