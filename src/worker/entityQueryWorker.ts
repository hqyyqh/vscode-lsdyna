import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { EntityIndexStore } from '../core/cache/entityIndexStore';
import { entityFileSignature, entityFilesUnchanged } from '../core/cache/entityFileRevision';
import { EntityReferenceQueryService } from '../core/references/entityReferenceQueryService';
import { EntityQueryCache } from '../core/references/entityQueryCache';
import { SqliteDefinitionIndex } from '../core/references/sqliteDefinitionIndex';
import { SqliteReferenceIndex } from '../core/references/sqliteReferenceIndex';
import { SqliteEntityPages } from '../core/references/sqliteEntityPages';
import { ProgressiveEntityQueries } from './progressiveEntityQueries';
import { assertIndexPayload, boundedIndexPage } from '../shared/indexPages';
const { createIndexClient } = require('../client/services/indexClient');
const { populateEntityPageDisplay } = require('../core/references/entityPageDisplay');
const { normalizeIndexedEntityId } = require('../core/references/indexedEntityQuery');
const { throwIfCancellationRequested } = require('../core/scanner/scannerContracts');
const { FILE_SCAN_CACHE_SCHEMA_VERSION } = require('../core/cache/fileScanCacheStore');

export type WorkerEntityQuery = {
    rootFile: string; scope: 'project' | 'single-file'; id: number | string; targetKind: string;
    excludeMeshEntities?: boolean;
    cursor?: { revision: string; query: string; role: 'definition' | 'reference'; offset: number };
};

/** Owns query memory in the worker; the host receives location pages, never reference indexes. */
export class EntityQueryWorker {
    private readonly service: EntityReferenceQueryService;
    private readonly fallback: EntityQueryCache;
    private readonly requests = new EntityQueryCache(0);
    private readonly snapshots: any;
    private tail: Promise<unknown> = Promise.resolve();
    private store?: EntityIndexStore;
    private definitions?: SqliteDefinitionIndex;
    private references?: SqliteReferenceIndex;
    private pages?: SqliteEntityPages;
    private initialized = false;
    private initialization?: Promise<void>;
    private lastDiagnostic = '';
    private disposed = false;
    private progressive?: ProgressiveEntityQueries;

    constructor(buildProjectIndex: (...args: any[]) => Promise<any>, private storageDirectory?: string,
        private memoryBytes = 256 * 1024 * 1024, private diskBytes = 4 * 1024 ** 3,
        private diagnostic: (error: unknown) => void = error => console.warn('[lsdyna] Entity persistence fallback:', error),
        private maxAgeMs = 30 * 24 * 60 * 60 * 1000,
        private loadStructure?: (root: string, options: any, token?: any) => Promise<any>,
        private liveSource?: any) {
        if (!Number.isSafeInteger(memoryBytes) || (memoryBytes !== 0 && memoryBytes < 32 * 1024 * 1024)) throw new Error('Invalid worker entity memory budget');
        // Reserve one eighth for restoring physical-file facts; do not add a second cache budget.
        this.service = new EntityReferenceQueryService(Math.floor(memoryBytes / 4));
        this.fallback = new EntityQueryCache(Math.floor(memoryBytes / 16));
        this.snapshots = memoryBytes === 0 ? undefined : createIndexClient({ buildProjectIndex: (root, options, progress, token) =>
            buildProjectIndex(root, { ...options, referenceScanCache: this.fallback }, progress, token),
            getFileSignature: entityFileSignature,
            maxSnapshotBytes: Math.floor(memoryBytes / 4), cacheSingleFileSnapshots: true });
    }

    private report = (error: unknown) => {
        const identity = String((error as any)?.code || (error as Error)?.message || error);
        if (identity !== this.lastDiagnostic) { this.lastDiagnostic = identity; this.diagnostic(error); }
    };
    private async initialize(token?: any) {
        if (!this.initialization) this.initialization = this.initializeStore().finally(() => { this.initialization = undefined; });
        await this.initialization;
        throwIfCancellationRequested(token);
    }
    async indexStore() { await this.initialize(); return this.store; }
    async sourceAnalysis(request: any, token?: any) {
        if (!path.isAbsolute(request.rootFile || '') || !path.isAbsolute(request.filePath || '') ||
            !Number.isSafeInteger(request.line) || request.line < 0 ||
            !['project', 'single-file'].includes(request.scope)) throw new TypeError('Invalid source analysis request');
        await this.initialize(token);
        if (this.memoryBytes === 0) return { status: 'limited', reasons: ['entity-query-low-memory'] };
        const { analyzeReference, attachResolvedTableChildren } = require('../core/references/projectReferenceIndex');
        const { runtimeDefinitionKeywords, mergeOnDemandDefinitions } = require('../core/references/onDemandDefinitionScanner');
        const { queryFromReferenceSource, definitionAtPosition } = require('../core/references/registryReferenceNetwork');
        const source = request.source;
        if (source?.operationalProjection?.ambiguous === true)
            return { status: 'ready', queryState: { state: 'ambiguous', query: null,
                reasons: ['operational-source-selector-ambiguous'] } };
        const targetKinds = source?.referenceValue?.targetKinds || source?.referenceInfo?.targetKinds ||
            (request.mode === 'preview' ? ['curve', 'table'] : []);
        try {
        let snapshot = await this.loadStructure(request.rootFile, { singleFileOnly: request.scope === 'single-file' }, token);
        if (['parameter-completion', 'parameter-navigation'].includes(request.mode)) {
            const completion = request.mode === 'parameter-completion';
            if (!Number.isSafeInteger(request.character) || request.character < 0 ||
                (completion ? typeof request.prefix !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,8}$|^$/.test(request.prefix)
                    : typeof request.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,8}$/.test(request.name) ||
                        typeof request.declaration !== 'boolean' || typeof request.references !== 'boolean' ||
                        typeof request.includeDeclaration !== 'boolean')) throw new TypeError('Invalid parameter query');
            if ((completion || !request.references) && request.scope === 'single-file' && [...snapshot.fileIndexes.values()].some((file: any) =>
                file.keywordBlocks?.some(block => /^\*INCLUDE(?:_|$)/.test(block.keyword))))
                return { status: 'ready', items: [], reasons: ['parameter-project-context-unavailable'], incomplete: true };
            const index = await this.service.indexAsync(snapshot, token);
            const key = JSON.stringify([request.mode, this.fallback.identity(index), request.filePath,
                request.line, request.character, request.prefix, request.name, request.declaration, request.references, request.includeDeclaration]);
            const result = this.fallback.get(key) || (completion
                ? await require('../core/references/visibleParameters').parameterCompletionPage(
                    index, request.filePath, request.line, request.character, request.prefix, token)
                : await require('../core/references/parameterNavigation').parameterNavigation(index, snapshot.fileIndexes,
                    request, token, this.liveSource?.scanBlockLines));
            this.fallback.set(key, result);
            if (!await (this.liveSource?.unchanged || entityFilesUnchanged)([...snapshot.fileIndexes].map(([file,index]:any)=>
                ({file,revision:index.sourceRevision})),token)) return {status:'stale'};
            const items = boundedIndexPage(result.items, { status: 'ready', ...result, items: [] });
            return assertIndexPayload({ status: 'ready', ...result, items,
                incomplete: result.incomplete || items.length !== result.items.length });
        }
        if (request.mode === 'parameters') {
            if (!Array.isArray(request.fields) || request.fields.length > 200) throw new TypeError('Invalid parameter page');
            const parameterIndex = await this.service.indexAsync(snapshot, token);
            const { analyzeIntegerParameterValueAtLocation, analyzeNumericParameterValueAtLocation } = require('../core/references/projectReferenceIndex');
            const results = [];
            let started = performance.now();
            for (const field of request.fields) {
                throwIfCancellationRequested(token);
                if (typeof field.raw !== 'string' || Buffer.byteLength(field.raw) > 16 * 1024 ||
                    !Number.isSafeInteger(field.line) || field.line < 0) throw new TypeError('Invalid parameter field');
                const result = (field.allowReal ? analyzeNumericParameterValueAtLocation : analyzeIntegerParameterValueAtLocation)(
                    parameterIndex, field.raw, { documentPath: request.filePath, lineIndex: field.line });
                results.push(result.resolved ? { resolved: true, value: result.value } : { resolved: false, reasons: result.reasons });
                if (performance.now() - started >= 8) {
                    await new Promise(resolve => setImmediate(resolve));
                    started = performance.now();
                }
            }
            if (!await (this.liveSource?.unchanged || entityFilesUnchanged)([...snapshot.fileIndexes].map(([file,index]:any)=>
                ({file,revision:index.sourceRevision})),token)) return {status:'stale'};
            return assertIndexPayload({status:'ready',results});
        }
        if (request.mode === 'preview' || request.mode === 'hover' && targetKinds.some(kind => ['curve', 'functionCurve', 'table'].includes(kind)))
            snapshot = await this.prepareDefinitions(snapshot, { targetKinds }, token);
        const files = [...snapshot.fileIndexes].map(([file, index]: any) => ({ file, revision: index.sourceRevision }));
        const current = () => (this.liveSource?.unchanged || entityFilesUnchanged)(files, token);
        const referenceIndex = await this.service.indexAsync(snapshot, token), projectScoped = request.scope === 'project';
        const context = { projectScoped, documentPath: request.filePath, lineIndex: request.line,
            rootFile: request.rootFile, documentVersion: request.documentVersion };
        let response: any;
        if (request.mode === 'preview') {
            const identity = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
            const file = [...snapshot.fileIndexes].find(([file]: any) => identity(file) === identity(request.filePath))?.[1] as any;
            const definitions = file?.referenceDefinitions;
            const definition = [...definitions?.curves || [], ...definitions?.tables || []].find(row => row.startLine === request.line);
            response = { definition: definition?.kind === 'table'
                ? attachResolvedTableChildren(definition, referenceIndex, { projectScoped }) : definition || null };
        } else if (source) {
            let analysis = analyzeReference(referenceIndex, source.referenceValue, targetKinds, { ...context,
                targetDefinitions: source.referenceValue?.targetDefinitions || source.referenceInfo?.targetDefinitions });
            if (['navigation', 'hover'].includes(request.mode) && Number.isSafeInteger(analysis.id) && analysis.id > 0) {
                const lookup = await (this.definitions?.scan || (options => require('../core/references/entityTypeDefinitionIndex')
                    .scanIndexedTypeDefinitions(options, this.fallback)))({ referenceIndex, fileIndexes: snapshot.fileIndexes,
                    effectiveId: analysis.id, targetKinds,
                    targetDefinitions: source.referenceValue?.targetDefinitions || source.referenceInfo?.targetDefinitions || [],
                    projectScoped, cancellationToken: token, definitionKeywords: runtimeDefinitionKeywords({ allowCandidate: request.allowFamilyCandidate === true }),
                    ...(this.liveSource ? { scanBlockLines: this.liveSource.scanBlockLines } : {}) });
                analysis = mergeOnDemandDefinitions(analysis, lookup, referenceIndex);
                if (source.referenceValue?.isSignedSwitch && lookup.definitions?.some(row => Number.isSafeInteger(row.idfoffOffset) && row.idfoffOffset !== 0))
                    analysis = { ...analysis, state: 'uncertain', reasons: [...new Set([...analysis.reasons, 'signed-switch-transform-unverified'])] };
            }
            if (request.mode === 'hover') analysis = { ...analysis, definitions: analysis.definitions.map(definition =>
                definition.kind === 'table' ? attachResolvedTableChildren(definition, referenceIndex, { projectScoped }) : definition) };
            // Lookup internals belong to the worker, not to a hover or navigation response.
            const { onDemandLookup, ...publicAnalysis } = analysis;
            const definitions = boundedIndexPage(publicAnalysis.definitions || [], { ...publicAnalysis, definitions: [] });
            const limited = definitions.length !== (publicAnalysis.definitions || []).length;
            analysis = { ...publicAnalysis, definitions, ...(limited ? { state: 'uncertain',
                reasons: [...new Set([...publicAnalysis.reasons, 'source-result-page-limit'])] } : {}) };
            const resolved = queryFromReferenceSource(referenceIndex, source, context);
            response = { analysis, queryState: { state: resolved.state, query: resolved.query, reasons: resolved.reasons } };
        } else {
            let resolved = definitionAtPosition(referenceIndex, request.filePath, { line: request.line, character: request.character || 0 });
            if (resolved.state === 'none') {
                const fileIndex = [...snapshot.fileIndexes].find(([file]: any) =>
                    process.platform === 'win32' ? file.toLowerCase() === request.filePath.toLowerCase() : file === request.filePath)?.[1] as any;
                const block = fileIndex?.keywordBlocks.find(block => block.startLine <= request.line && block.endLine >= request.line);
                if (block) {
                    const lines = new Map<number, string>();
                    let bytes = 0, ordinal = -1;
                    const read = await (this.liveSource?.scanBlockLines || require('../core/references/onDemandDefinitionScanner').scanBlockLinesFromDisk)(
                        block, (line, number, metadata) => {
                            lines.set(block.startLine, metadata.keywordLineText);
                            if (number <= request.line && !line.trimStart().startsWith('$') && !line.trimStart().startsWith('*')) ordinal++;
                            if (number >= request.line) {
                                bytes += Buffer.byteLength(line, 'utf8') + 32;
                                if (bytes > 1024 * 1024) throw new RangeError('Definition origin window exceeds budget');
                                lines.set(number, line);
                            }
                        }, token, { endLine: Math.min(block.endLine, request.line + 199) });
                    for (const header of fileIndex.keywordBlocks) if (header.keyword === '*KEYWORD' && header.startLine <= request.line)
                        lines.set(header.startLine, header.rawKeyword || header.keyword);
                    resolved = read.complete ? require('../core/references/onDemandDefinitionScanner').queryOnDemandDefinitionAtPosition({
                        referenceIndex, fileIndex, filePath: request.filePath, position: { line: request.line, character: request.character || 0 },
                        projectScoped, lineAt: line => lines.get(line), sourceDataRecordOrdinal: ordinal,
                        definitionKeywords: runtimeDefinitionKeywords() })
                        : { state: 'incomplete', query: null, reasons: [read.reason || 'definition-origin-line-unavailable'] };
                }
            }
            response = { queryState: { state: resolved.state, query: resolved.query, reasons: resolved.reasons } };
        }
        throwIfCancellationRequested(token);
        if (!await current()) return { status: 'stale' };
        return assertIndexPayload({ status: 'ready', ...response }); }
        catch (error) {
            if (!(error instanceof RangeError)) throw error;
            return { status: 'limited', reasons: ['source-analysis-budget'] };
        }
    }
    async projectQuery(request: any, token?: any) {
        if (!this.progressive) this.progressive = new ProgressiveEntityQueries(() => this.indexStore(),
            async (query, cancellationToken, accept, sources) => {
                if (this.memoryBytes === 0) {
                    sources({ fileIndexes: new Map() });
                    return { state: 'partial', reasons: ['entity-query-low-memory'] };
                }
                await this.initialize(cancellationToken);
                const snapshot = await this.loadStructure(query.rootFile,
                    { singleFileOnly: query.scope === 'single-file', excludeMeshEntities: query.excludeMeshEntities,
                        reconcileChanges: true }, cancellationToken);
                if (query.excludeMeshEntities && require('../core/scanner/scannerContracts').isMeshEntityKind(query.targetKind)) {
                    sources(snapshot); return { state: 'unsupported', reasons: ['mesh-entity-index-disabled'] };
                }
                // ID queries use the shared typed definition store, not every definition preview.
                sources(snapshot);
                const referenceIndex = await this.service.indexAsync(snapshot, cancellationToken);
                if (query.diagnostics) sources(snapshot, referenceIndex);
                return require('../core/references/indexedEntityQuery').queryIndexedEntityId({ snapshot,
                    referenceIndex,
                    id: query.id, targetKind: query.targetKind, targetDefinitions: query.targetDefinitions, cancellationToken,
                    ...(this.liveSource ? { scanBlockLines: this.liveSource.scanBlockLines } : {}),
                    scanDefinitions: this.definitions?.scan || (options => require('../core/references/entityTypeDefinitionIndex')
                        .scanIndexedTypeDefinitions(options, this.fallback)),
                    queryReferences: this.references?.query || (options => require('../core/references/entityTypeReferenceIndex')
                        .queryIndexedTypeReferences(options, this.fallback)),
                    onLocations: async rows => {
                        await populateEntityPageDisplay(snapshot, rows, query, this.fallback, cancellationToken);
                        await accept(rows);
                    } });
            }, Math.floor(this.memoryBytes / 32), this.liveSource?.unchanged || entityFilesUnchanged);
        return this.progressive.request(request, token);
    }
    invalidateProgressive(rootFile: string) { this.progressive?.invalidate(rootFile); }
    private async prepareDefinitions(snapshot: any, request: any, token: any) {
        const indexes = new Map<string, any>();
        let retainedBytes = 0;
        const retainedLimit = Math.floor(this.memoryBytes / 4);
        for (const [file, structure] of snapshot.fileIndexes) {
            const targetKinds = request.targetKinds || [request.targetKind];
            const key = JSON.stringify(['project-definitions', file, structure.sourceRevision, targetKinds,
                request.excludeMeshEntities === true]);
            const completed = await this.fallback.run(key, token, async cancellationToken => ({ state: 'complete', value:
                await require('../core/scanner/fileIndexBuilder').completeFileIndex(structure,
                    { cancellationToken, definitionsOnly: true, referenceTargetKinds: targetKinds, definitionCache: this.fallback,
                        ...(Number.isInteger(structure.documentVersion) ? { readBlockText: async (block, options) => {
                            const key = JSON.stringify(['live-definition-text', block.contentIdentity,
                                options.headerDataRecords, options.maxBytes]);
                            const read = async () => {
                                let truncated = false;
                                const text = await this.liveSource.blockText(block, { ...options,
                                    onTruncated: () => { truncated = true; } });
                                return { state: truncated ? 'partial' : 'complete', text, truncated };
                            };
                            const value = block.contentIdentity ? await this.fallback.run(key, cancellationToken, read) : await read();
                            if (value.truncated) options.onTruncated?.();
                            return value.text;
                        } } : {}),
                        excludeMeshEntities: request.excludeMeshEntities === true }) }));
            retainedBytes += require('../core/cache/memorySize').estimateMemorySize(
                completed.value.referenceDefinitions, retainedLimit - retainedBytes);
            if (retainedBytes > retainedLimit) throw new RangeError('Project definition previews exceed budget');
            indexes.set(file, completed.value);
        }
        return { ...snapshot, fileIndexes: indexes };
    }
    private async initializeStore() {
        if (this.initialized) return;
        this.initialized = true;
        if (!this.storageDirectory || this.memoryBytes === 0) return;
        try {
            this.store = await EntityIndexStore.open(this.storageDirectory,
                { memoryBytes: Math.floor(this.memoryBytes / 8), diskBytes: this.diskBytes });
            await this.store.prune(this.maxAgeMs);
            const legacy = await this.store.cleanLegacy();
            if (legacy.retained) console.info('[lsdyna] Cache directories retained: ownership is unverified or an index is in use.', legacy);
            this.store.startMaintenance(this.maxAgeMs, this.report);
            this.definitions = new SqliteDefinitionIndex(this.store, this.fallback, this.report, Math.floor(this.memoryBytes / 32));
            this.references = new SqliteReferenceIndex(this.store, this.fallback, this.report, Math.floor(this.memoryBytes / 32));
            this.pages = new SqliteEntityPages(this.store, this.fallback);
        } catch (error) {
            await this.store?.close().catch(() => {}); this.store = undefined;
            if ((error as Error)?.name === 'CancellationError') { this.initialized = false; throw error; }
            this.report(error);
        }
    }

    query(request: WorkerEntityQuery, token: any = null, onProgress?: (event: any) => void) {
        if (this.disposed) return Promise.reject(new Error('Entity query worker is disposed'));
        if (!request || !path.isAbsolute(request.rootFile || '') || !['project', 'single-file'].includes(request.scope) ||
            normalizeIndexedEntityId(request.id) === null || typeof request.targetKind !== 'string' || !request.targetKind.trim())
            return Promise.reject(new Error('Invalid entity query request'));
        if (request.cursor && (!['definition', 'reference'].includes(request.cursor.role) ||
            !Number.isSafeInteger(request.cursor.offset) || request.cursor.offset < 0 || typeof request.cursor.revision !== 'string'))
            return Promise.reject(new Error('Invalid entity query cursor'));
        const normalized = { ...request, rootFile: path.resolve(request.rootFile), id: normalizeIndexedEntityId(request.id),
            targetKind: request.targetKind.trim() };
        return this.requests.run(JSON.stringify(normalized), token, sharedToken => {
            const operation = this.tail.then(() => this.execute(normalized, sharedToken, onProgress));
            this.tail = operation.catch(() => {});
            return operation;
        });
    }

    private async execute(request: WorkerEntityQuery, token: any, onProgress?: (event: any) => void) {
        throwIfCancellationRequested(token);
        if (this.memoryBytes === 0) return { status: 'ready', result: { state: 'partial', locations: [], reasons: ['entity-query-low-memory'] } };
        await this.initialize(token);
        const query = createHash('sha256').update(JSON.stringify([request.id, request.targetKind])).digest('hex');
        if (this.pages) {
            try {
                const restored = await this.pages.read(request, query, token);
                if (restored?.status === 'refresh') {
                    this.snapshots.invalidate(request.rootFile); this.service.markStale(request.rootFile);
                } else if (restored) return restored;
            } catch (error) { throwIfCancellationRequested(token); this.report(error); }
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const load = () => this.loadStructure ? this.loadStructure(request.rootFile,
                { singleFileOnly: request.scope === 'single-file', excludeMeshEntities: request.excludeMeshEntities === true }, token)
                : this.snapshots.loadProjectSnapshot(request.rootFile,
                { singleFileOnly: request.scope === 'single-file', deferDisplayIdentity: true, referenceTargetKinds: [request.targetKind], excludeMeshEntities: request.excludeMeshEntities === true }, (event: any) => {
                    onProgress?.({ phase: event.phase || event.type || 'snapshot' });
                }, token);
            let snapshot = await load();
            // A newly created Include has no old file signature to compare against.
            if (snapshot.missingFiles?.length) {
                this.snapshots.invalidate(request.rootFile);
                snapshot = await load();
            }
            if (this.loadStructure) {
                snapshot = await this.prepareDefinitions(snapshot, request, token);
            }
            throwIfCancellationRequested(token);
            const files = [...snapshot.fileIndexes].map(([file, index]: [string, any]) => ({ file, revision: index.sourceRevision }));
            if (files.some(file => !file.revision)) throw new Error('Entity worker requires validated file revisions');
            const revision = createHash('sha256').update(JSON.stringify([request.rootFile, request.scope,
                FILE_SCAN_CACHE_SCHEMA_VERSION, request.excludeMeshEntities === true, files])).digest('hex');
            if (request.cursor && (request.cursor.revision !== revision || request.cursor.query !== query))
                return { status: 'expired', revision };
            const result = await this.service.queryById(snapshot, request.id, request.targetKind, {
                cancellationToken: token, ...(this.definitions ? { scanDefinitions: this.definitions.scan } : {}),
                ...(this.references ? { queryReferences: this.references.query } : {}), onPhase: onProgress });
            throwIfCancellationRequested(token);
            const counts = { definition: result.definitions.length, reference: result.references.length };
            const groupCounts = result.references.reduce((groups, location) => {
                const kind = location.entityKind || '';
                groups[kind] = (groups[kind] || 0) + 1;
                return groups;
            }, {});
            const next = {} as Record<string, WorkerEntityQuery['cursor']>;
            const locations = [];
            for (const role of ['definition', 'reference'] as const) {
                if (request.cursor && request.cursor.role !== role) continue;
                const all = role === 'definition' ? result.definitions : result.references;
                const start = request.cursor?.offset || 0;
                locations.push(...all.slice(start, start + 200).map(location => ({ ...location })));
                if (start + 200 < all.length) next[role] = { revision, query, role, offset: start + 200 };
            }
            await populateEntityPageDisplay(snapshot, locations, request, this.fallback, token);
            if (!await entityFilesUnchanged(files, token)) {
                throwIfCancellationRequested(token);
                this.snapshots.invalidate(request.rootFile); this.service.markStale(request.rootFile);
                continue;
            }
            if (this.pages && !request.cursor) {
                try { await this.pages.write(request, snapshot, revision, result, token); }
                catch (error) {
                    throwIfCancellationRequested(token);
                    if ((error as Error)?.name === 'ScanChangedError') {
                        this.snapshots.invalidate(request.rootFile); this.service.markStale(request.rootFile); continue;
                    }
                    this.report(error);
                }
                if (!await entityFilesUnchanged(files, token)) {
                    throwIfCancellationRequested(token);
                    this.snapshots.invalidate(request.rootFile); this.service.markStale(request.rootFile);
                    continue;
                }
            }
            return { status: 'ready', revision, result: { state: result.state, lifecycle: result.lifecycle,
                queryIdentity: result.queryIdentity, rootFile: result.rootFile, query: result.query,
                sourceId: result.sourceId, effectiveId: result.effectiveId, reasons: result.reasons, locations,
                page: { counts, groupCounts, next, ...(request.cursor ? { appendRole: request.cursor.role } : {}) } } };
        }
        return { status: 'stale' };
    }

    invalidate(rootFile: string) { this.snapshots?.invalidate(rootFile); this.service.markStale(rootFile); }
    control(action: 'stats' | 'clear') {
        if (this.disposed) return Promise.reject(new Error('Entity query worker is disposed'));
        if (!['stats', 'clear'].includes(action)) return Promise.reject(new Error('Invalid entity index operation'));
        if (action === 'stats') return this.stats();
        this.requests.clear();
        const operation = this.tail.then(async () => {
            await this.progressive?.clear();
            await this.initialize(); this.service.clear(); this.fallback.clear();
            await this.snapshots?.clearCaches();
            const cleared = this.store ? await this.store.clear() : null;
            const legacy = this.store ? await this.store.cleanLegacy() : null;
            if (cleared && legacy) {
                cleared.reclaimedBytes += legacy.reclaimedBytes;
                cleared.removed += legacy.removed;
                if (cleared.retainedReason || legacy.retained)
                    console.info('[lsdyna] Cache cleanup retained protected data.', { reason: cleared.retainedReason, legacy });
            }
            return { cleared, legacy, ...await this.stats() };
        });
        this.tail = operation.catch(() => {});
        return operation;
    }
    async stats() { return { snapshots: this.snapshots?.getCacheStats(), memory: this.service.cacheStats(), fallback: this.fallback.stats(),
        sqlite: this.store ? await this.store.stats() : null, memoryBudget: this.memoryBytes }; }
    async dispose() {
        if (this.disposed) return;
        this.disposed = true; this.requests.clear();
        await this.progressive?.clear();
        await this.tail; this.service.clear(); this.fallback.clear(); await this.store?.close();
    }
}
