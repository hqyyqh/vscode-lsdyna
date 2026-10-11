import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { EntityIndexStore } from '../core/cache/entityIndexStore';
import { entityFileSignature, entityFilesUnchanged } from '../core/cache/entityFileRevision';
import { EntityReferenceQueryService } from '../core/references/entityReferenceQueryService';
import { EntityQueryCache } from '../core/references/entityQueryCache';
import { SqliteDefinitionIndex } from '../core/references/sqliteDefinitionIndex';
import { SqliteReferenceIndex } from '../core/references/sqliteReferenceIndex';
import { SqliteEntityPages } from '../core/references/sqliteEntityPages';
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

    constructor(buildProjectIndex: (...args: any[]) => Promise<any>, private storageDirectory?: string,
        private memoryBytes = 256 * 1024 * 1024, private diskBytes = 4 * 1024 ** 3,
        private diagnostic: (error: unknown) => void = error => console.warn('[lsdyna] Entity persistence fallback:', error),
        private maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
        if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 32 * 1024 * 1024) throw new Error('Invalid worker entity memory budget');
        // Reserve one eighth for restoring physical-file facts; do not add a second cache budget.
        this.service = new EntityReferenceQueryService(Math.floor(memoryBytes / 4));
        this.fallback = new EntityQueryCache(Math.floor(memoryBytes / 16));
        this.snapshots = createIndexClient({ buildProjectIndex: (root, options, progress, token) =>
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
    private async initializeStore() {
        if (this.initialized) return;
        this.initialized = true;
        if (!this.storageDirectory) return;
        try {
            this.store = await EntityIndexStore.open(this.storageDirectory,
                { memoryBytes: Math.floor(this.memoryBytes / 8), diskBytes: this.diskBytes });
            await this.store.prune(this.maxAgeMs);
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
        throwIfCancellationRequested(token); await this.initialize(token);
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
            const load = () => this.snapshots.loadProjectSnapshot(request.rootFile,
                { singleFileOnly: request.scope === 'single-file', deferDisplayIdentity: true, referenceTargetKinds: [request.targetKind], excludeMeshEntities: request.excludeMeshEntities === true }, (event: any) => {
                    onProgress?.({ phase: event.phase || event.type || 'snapshot' });
                }, token);
            let snapshot = await load();
            // A newly created Include has no old file signature to compare against.
            if (snapshot.missingFiles?.length) {
                this.snapshots.invalidate(request.rootFile);
                snapshot = await load();
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

    invalidate(rootFile: string) { this.snapshots.invalidate(rootFile); this.service.markStale(rootFile); }
    control(action: 'stats' | 'clear') {
        if (this.disposed) return Promise.reject(new Error('Entity query worker is disposed'));
        if (!['stats', 'clear'].includes(action)) return Promise.reject(new Error('Invalid entity index operation'));
        if (action === 'stats') return this.stats();
        this.requests.clear();
        const operation = this.tail.then(async () => {
            await this.initialize(); this.service.clear(); this.fallback.clear();
            await this.snapshots.clearCaches();
            return { cleared: this.store ? await this.store.clear() : null, ...await this.stats() };
        });
        this.tail = operation.catch(() => {});
        return operation;
    }
    async stats() { return { snapshots: this.snapshots.getCacheStats(), memory: this.service.cacheStats(), fallback: this.fallback.stats(),
        sqlite: this.store ? await this.store.stats() : null, memoryBudget: this.memoryBytes }; }
    async dispose() {
        if (this.disposed) return;
        this.disposed = true; this.requests.clear();
        await this.tail; this.service.clear(); this.fallback.clear(); await this.store?.close();
    }
}
