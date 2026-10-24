import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { entityFilesUnchanged } from '../core/cache/entityFileRevision';
import { INDEX_PROTOCOL_VERSION, assertIndexPayload, boundedIndexPage, indexJsonBytes } from '../shared/indexPages';
const { throwIfCancellationRequested, createCancellationError } = require('../core/scanner/scannerContracts');
const { estimateMemorySize } = require('../core/cache/memorySize');

type State = 'scanning' | 'complete' | 'incomplete' | 'cancelled' | 'stale';
type Entry = {
    id: string; key: string; rootFile: string; generation: number; state: State;
    subscribers: Set<string>; token: { isCancellationRequested: boolean };
    rows: Map<string, { sequence: number; value: any; bytes: number }>;
    sequence: number; bytes: number; snapshot?: any; error?: string; ready: Promise<void>;
    viewerProgress?: any;
    reconcileChanges?: boolean;
    ownedSizes: Map<string, number>; ownedBytes: number;
    unpublishedOwnership?: Set<string>;
    lastAccess: number;
    store?: any; build?: any; pending: Map<string, any>; fileOrder: Map<string, number>;
    flushing?: Promise<void>; committed: number; heartbeat?: ReturnType<typeof setInterval>;
};

/** Worker-owned structure sessions. Only requested, bounded projections cross the worker boundary. */
export class ProjectSessions {
    private entries = new Map<string, Entry>();
    private leases = new Map<string, Entry>();
    private generation = 0;
    constructor(private build: (root: string, options: any, progress?: any) => Promise<any>,
        private maxBytes = 64 * 1024 * 1024,
        private filesUnchanged = entityFilesUnchanged,
        private getStore?: () => Promise<any>) {}

    private key(rootFile: string, options: any) {
        return JSON.stringify([process.platform === 'win32' ? rootFile.toLowerCase() : rootFile,
            options.singleFileOnly === true, options.largeFileThresholdBytes ?? null]);
    }

    private publish(entry: Entry, key: string, value: any, sourceBytes = 0) {
        throwIfCancellationRequested(entry.token);
        const bytes = indexJsonBytes(value) * 4;
        // Disk-backed keyword projections leave memory after flush; their pending bytes
        // are bounded separately. Retain the physical block and ownership-map cost once.
        const ownedBytes = sourceBytes + (entry.store && value.type === 'keyword' ? 0 : bytes) + key.length * 2 + 128;
        const ownedTotal = [...this.entries.values()].reduce((total, current) => total + current.ownedBytes, 0);
        if (ownedTotal - (entry.ownedSizes.get(key) || 0) + ownedBytes > this.maxBytes * 4)
            throw new RangeError('Retained project structure exceeds memory budget');
        entry.ownedBytes += ownedBytes - (entry.ownedSizes.get(key) || 0);
        entry.ownedSizes.set(key, ownedBytes);
        entry.unpublishedOwnership?.delete(key);
        const previous = entry.store ? entry.pending.get(key) : entry.rows.get(key);
        const totalBytes = [...this.entries.values()].reduce((total, current) => total + current.bytes, 0);
        if (totalBytes - (previous?.bytes || 0) + bytes > this.maxBytes)
            throw new RangeError('Project structure exceeds memory budget');
        entry.bytes += bytes - (previous?.bytes || 0);
        const row = { key, sequence: ++entry.sequence, value, bytes };
        if (entry.store) {
            const physicalFile = value.type === 'include' ? value.fromFile : value.filePath;
            if (!entry.fileOrder.has(physicalFile)) entry.fileOrder.set(physicalFile, entry.fileOrder.size);
            entry.pending.set(key, { ...row, fileOrder: entry.fileOrder.get(physicalFile) });
            if (value.type !== 'keyword') entry.rows.set(key, row);
        } else entry.rows.set(key, row);
    }

    private async flush(entry: Entry) {
        if (!entry.store) return;
        while (entry.flushing) await entry.flushing;
        if (!entry.pending.size) return;
        const rows = [...entry.pending.values()].sort((a, b) => a.sequence - b.sequence);
        entry.pending.clear();
        entry.flushing = (async () => {
            let batch = [], bytes = 0;
            const write = async () => {
                if (!batch.length) return;
                await entry.store.appendProjectRows(entry.build, batch, entry.token);
                throwIfCancellationRequested(entry.token);
                entry.committed = batch[batch.length - 1].sequence;
                for (const row of batch) entry.bytes -= row.bytes;
                batch = []; bytes = 0;
            };
            for (const row of rows) {
                const size = indexJsonBytes(row);
                // SQL rows repeat keys and paths and quote JSON payloads. Reserve space for that envelope.
                if (batch.length && bytes + size > 64 * 1024) await write();
                batch.push(row); bytes += size;
            }
            await write();
        })();
        try { await entry.flushing; } finally { entry.flushing = undefined; }
    }

    private block(entry: Entry, block: any, complete: boolean) {
        // No semantic metadata or block text is part of the structural projection.
        this.publish(entry, `keyword:${block.filePath}:${block.startLine}`, {
            type: 'keyword', filePath: block.filePath, fileName: path.basename(block.filePath), keyword: block.keyword,
            startLine: block.startLine, endLine: complete ? block.endLine : block.startLine,
            complete, ...(complete && block.displayIdentity ? { displayIdentity: block.displayIdentity } : {}),
        }, estimateMemorySize({ ...block, filePath: undefined }, this.maxBytes * 4));
    }

    private async file(entry: Entry, event: any) {
        const { filePath, fileIndex, graph } = event;
        const metadataBytes = estimateMemorySize({
            parameterEvents: fileIndex.parameterEvents, nativeReadEvents: fileIndex.nativeReadEvents,
            largeFileLineMap: fileIndex.largeFileLineMap, includeEntries: fileIndex.includeEntries,
            pathEntries: fileIndex.pathEntries, searchPaths: fileIndex.searchPaths,
        }, this.maxBytes * 4);
        this.publish(entry, `file:${filePath}`, { type: 'file', filePath,
            state: 'complete', size: fileIndex.size, revision: fileIndex.sourceRevision }, metadataBytes);
        let count = 0;
        for (const block of fileIndex.keywordBlocks || []) {
            this.block(entry, block, true);
            if (++count % 100 === 0) await this.flush(entry);
        }
        for (const occurrence of graph.includeOccurrences.filter(row => row.fromFile === filePath)) {
            const cycle = occurrence.cycle && graph.cycles.find(row => row.fromFile === filePath && row.lineIndex === occurrence.lineIndex);
            this.publish(entry, `include:${filePath}:${occurrence.lineIndex}`, { type: 'include', ...occurrence,
                ...(cycle ? { toFile: cycle.toFile, path: cycle.path } : {}) });
        }
        for (const missing of graph.missingFiles.filter(row => row.fromFile === filePath)) {
            this.publish(entry, `include:${filePath}:${missing.lineIndex}`, { type: 'include', ...missing, missing: true });
        }
        await this.flush(entry);
    }

    private async valid(entry: Entry, token?: any) {
        if (entry.state === 'scanning') return true;
        if (entry.state !== 'complete' || !entry.snapshot) return false;
        if (entry.snapshot.missingFiles?.length) return false;
        if (!await this.filesUnchanged([...entry.snapshot.fileIndexes].map(([file, index]: any) =>
            ({ file, revision: index.sourceRevision })), token)) return false;
        const { resolveIncludeFromSearchPathsAsync } = require('../core/project/projectIndexer');
        const resolutions = new Map();
        for (const row of entry.snapshot.graph.includeOccurrences) {
            throwIfCancellationRequested(token);
            if (await resolveIncludeFromSearchPathsAsync(row.fileName,
                entry.snapshot.effectiveSearchPathsByFile.get(row.fromFile), resolutions) !== row.filePath) return false;
        }
        return true;
    }

    private retire(entry: Entry, retainStructure = false) {
        const retain = retainStructure && !!entry.snapshot;
        entry.token.isCancellationRequested = true;
        entry.state = 'stale';
        entry.viewerProgress = undefined;
        entry.rows.clear(); entry.bytes = 0;
        if (!retain) {
            entry.snapshot = undefined;
            entry.ownedSizes.clear(); entry.ownedBytes = 0;
        }
        entry.pending.clear(); clearInterval(entry.heartbeat);
        const build = entry.build; entry.build = undefined;
        if (build) void entry.ready.then(() => entry.store.abandon(build)).catch(() => {});
        if (!retain && this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    }

    async open(rootFile: string, options: any = {}, token?: any) {
        if (!path.isAbsolute(rootFile || '')) throw new TypeError('Project requires an absolute root path');
        rootFile = path.resolve(rootFile);
        const key = this.key(rootFile, options);
        let entry = this.entries.get(key);
        let previousFileIndexes, ownedSizes, ownedBytes;
        if (entry && !await this.valid(entry, token)) {
            previousFileIndexes = entry.snapshot && new Map(entry.snapshot.fileIndexes);
            if (previousFileIndexes) {
                ownedSizes = entry.ownedSizes; ownedBytes = entry.ownedBytes;
                entry.ownedSizes = new Map();
            }
            this.retire(entry); entry = undefined;
        }
        throwIfCancellationRequested(token);
        // Another opener may have created this session while source validation was awaiting I/O.
        entry = this.entries.get(key) || entry;
        if (!entry) {
            for (const candidate of this.entries.values()) {
                if (!candidate.subscribers.size) this.retire(candidate);
            }
            // Bound simultaneous project ownership as well as each individual session.
            if (this.entries.size >= 4) throw new Error('Too many active project sessions');
            entry = { id: randomUUID(), key, rootFile, generation: ++this.generation, state: 'scanning',
                subscribers: new Set(), token: { isCancellationRequested: false }, rows: new Map(),
                sequence: 0, bytes: 0, ready: Promise.resolve(), lastAccess: Date.now(), pending: new Map(),
                ownedSizes: ownedSizes || new Map(), ownedBytes: ownedBytes || 0,
                unpublishedOwnership: ownedSizes && new Set(ownedSizes.keys()),
                fileOrder: new Map(), committed: 0 };
            this.entries.set(key, entry);
            this.publish(entry, `file:${rootFile}`, { type: 'file', filePath: rootFile, state: 'scanning' });
            const current = entry;
            current.ready = Promise.resolve().then(async () => {
                current.store = await this.getStore?.();
                if (current.store) {
                    current.build = await current.store.begin('project-view:' + current.id, String(current.generation), current.token);
                    if (!current.build) throw new Error('Cannot reserve project structure storage');
                    current.heartbeat = setInterval(() => {
                        const build = current.build;
                        if (build) void current.store.renew(build).catch(() => {
                            if (current.build === build) current.token.isCancellationRequested = true;
                        });
                    }, 10000);
                    current.heartbeat.unref?.();
                    for (const [key, row] of current.rows) { current.bytes -= row.bytes; this.publish(current, key, row.value); }
                }
                const snapshot = await this.build(rootFile, { singleFileOnly: options.singleFileOnly === true,
                    get reconcileChanges() { return current.reconcileChanges === true; },
                    previousFileIndexes,
                    highWaterMark: 64 * 1024,
                    largeFileThresholdBytes: options.largeFileThresholdBytes, structureOnly: true,
                    cancellationToken: current.token,
                    onStructureQueued: (filePath, order) => current.fileOrder.set(filePath, order),
                    onLargeFileProgress: progress => {
                        if (options.singleFileOnly) current.viewerProgress = progress;
                    },
                    onStructureBlock: (block, complete) => this.block(current, block, complete),
                    onStructureStart: filePath => this.publish(current, `file:${filePath}`,
                        { type: 'file', filePath, state: 'scanning' }),
                    onStructureFailure: async (filePath, error) => {
                        this.publish(current, `file:${filePath}`, { type: 'file', filePath, state: 'failed',
                            reason: error?.name === 'RangeError' ? 'index-budget-exceeded' : 'structure-scan-failed' });
                        await this.flush(current);
                    },
                    flushStructure: () => this.flush(current),
                    onIncludePending: (filePath, entries) => {
                        for (const row of entries) this.publish(current, `include:${filePath}:${row.lineIndex}`,
                            { type: 'include', ...row, fromFile: filePath, pending: true,
                                filePath: path.resolve(path.dirname(filePath), row.fileName) });
                    },
                    onStructureFile: event => this.file(current, event),
                    onStructureRestart: async () => {
                        throwIfCancellationRequested(current.token);
                        if (current.flushing) await current.flushing;
                        const previous = current.build; current.build = undefined;
                        current.generation = ++this.generation;
                        current.viewerProgress = undefined;
                        current.rows.clear(); current.bytes = 0; current.sequence = 0; current.committed = 0;
                        current.ownedSizes.clear(); current.ownedBytes = 0;
                        current.unpublishedOwnership = undefined; previousFileIndexes?.clear();
                        current.pending.clear(); current.fileOrder.clear();
                        if (previous) await current.store.abandon(previous);
                        if (current.store) current.build = await current.store.begin('project-view:' + current.id,
                            String(current.generation), current.token);
                        this.publish(current, `file:${rootFile}`, { type: 'file', filePath: rootFile, state: 'scanning' });
                        await this.flush(current);
                    },
                });
                throwIfCancellationRequested(current.token);
                await this.flush(current);
                for (const key of current.unpublishedOwnership || []) {
                    current.ownedBytes -= current.ownedSizes.get(key) || 0;
                    current.ownedSizes.delete(key);
                }
                current.unpublishedOwnership = undefined;
                previousFileIndexes?.clear();
                current.snapshot = snapshot;
                current.viewerProgress = undefined;
                current.state = snapshot.failedFiles?.length ? 'incomplete' : 'complete';
                if (snapshot.failedFiles?.length) current.error = 'structure-scan-failed';
            }).catch(error => {
                if (current.state === 'stale') return;
                console.warn('[lsdyna] Shared project structure incomplete:', error);
                current.state = error?.name === 'CancellationError' ? 'cancelled' : 'incomplete';
                current.viewerProgress = undefined;
                current.error = error?.name === 'RangeError' ? 'index-budget-exceeded' : 'structure-scan-failed';
                current.token.isCancellationRequested = true;
            }).finally(() => { previousFileIndexes?.clear(); });
        }
        if (options.reconcileChanges) entry.reconcileChanges = true;
        const lease = randomUUID();
        entry.subscribers.add(lease); this.leases.set(lease, entry);
        return { protocolVersion: INDEX_PROTOCOL_VERSION, lease, generation: entry.generation,
            rootFile, state: entry.state };
    }

    async read(request: any) {
        const entry = this.leases.get(request.lease);
        if (!entry || entry.generation !== request.generation || entry.state === 'stale')
            return { state: 'stale', generation: entry?.generation };
        const after = request.after ?? 0;
        if (!Number.isSafeInteger(after) || after < 0 || after > entry.sequence)
            throw new TypeError('Invalid project cursor');
        entry.lastAccess = Date.now();
        if (entry.build) {
            let stored;
            try { stored = await entry.store.projectRows(entry.build, request); }
            catch { this.retire(entry); return { state: 'stale' }; }
            if (this.entries.get(entry.key) !== entry || entry.generation !== request.generation)
                return { state: 'stale', generation: entry.generation };
            const header = { state: entry.state, generation: entry.generation, after, pending: false,
                error: entry.error, protocolVersion: INDEX_PROTOCOL_VERSION };
            const rows: any[] = boundedIndexPage(stored.values, header);
            return assertIndexPayload({ ...header, rows, after: rows.length ? rows[rows.length - 1].sequence : after,
                pending: stored.values.length > rows.length });
        }
        // Replacing a row moves its sequence forward; sort the bounded references, not serialized data.
        const changes = [...entry.rows.values()].filter(row => row.sequence > after &&
            (!request.kind || row.value.type === request.kind) &&
            (!request.kinds || request.kinds.includes(row.value.type))).sort((a, b) => a.sequence - b.sequence);
        const header = { state: entry.state, generation: entry.generation, after,
            pending: false, error: entry.error, protocolVersion: INDEX_PROTOCOL_VERSION };
        const rows = boundedIndexPage(changes.map(row => ({ sequence: row.sequence, ...row.value })), header);
        return assertIndexPayload({ ...header, rows, after: rows.length ? rows[rows.length - 1].sequence : after,
            pending: changes.length > rows.length });
    }

    async keywordPage(request: any) {
        const entry = this.leases.get(request.lease);
        if (!entry || entry.generation !== request.generation || entry.state === 'stale') return { state: 'stale' };
        const offset = request.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid keyword page cursor');
        const revision = entry.build ? entry.committed : entry.sequence;
        if (offset && request.revision !== revision) return { state: 'stale' };
        if (entry.build) {
            let stored;
            try { stored = await entry.store.projectRows(entry.build, request); }
            catch { this.retire(entry); return { state: 'stale' }; }
            if (this.entries.get(entry.key) !== entry || entry.generation !== request.generation || entry.committed !== revision)
                return { state: 'stale' };
            const header = { state: entry.state, revision, generation: entry.generation, total: stored.total,
                complete: entry.state === 'complete', next: 0 };
            const rows = boundedIndexPage(stored.values, header);
            return assertIndexPayload({ ...header, rows, next: offset + rows.length < stored.total ? offset + rows.length : undefined });
        }
        const { resolveKeywordCategory, getCategory } = require('../core/keywordCategory');
        const { normalizeKeyword } = require('../core/keywordDisplayIdentity');
        const fileOrder = entry.fileOrder;
        const keywords = [];
        for (const row of entry.rows.values()) {
            if (row.value.type !== 'keyword') continue;
            const value = row.value;
            if (!fileOrder.has(value.filePath)) fileOrder.set(value.filePath, fileOrder.size);
            const keyword = normalizeKeyword(value.keyword);
            const category = resolveKeywordCategory(keyword).primaryCategory;
            if (request.filePath && request.filePath !== value.filePath ||
                request.keyword && request.keyword !== keyword || request.category && request.category !== category) continue;
            if (request.atLine !== undefined && (!Number.isSafeInteger(request.atLine) ||
                request.atLine < value.startLine || request.atLine > value.endLine)) continue;
            if (typeof request.search === 'string' && request.search &&
                !require('../core/search/lsdynaTextMatch').scoreKeywordName(request.search,
                    [keyword, value.displayIdentity?.title || '', path.basename(value.filePath), category].join(' '))) continue;
            keywords.push({ ...value, keyword, category, fileOrder: fileOrder.get(value.filePath) });
        }
        let values: any[];
        if (request.groupBy) {
            if (!['filePath', 'keyword', 'category'].includes(request.groupBy)) throw new TypeError('Invalid keyword grouping');
            const groups = new Map<string, any>();
            for (const row of keywords) {
                const key = row[request.groupBy];
                const group = groups.get(key) || { type: 'group', key, count: 0, first: row };
                group.count++; groups.set(key, group);
            }
            values = [...groups.values()];
            if (request.groupBy === 'keyword') values.sort((a, b) => a.key.localeCompare(b.key));
            if (request.groupBy === 'category') values.sort((a, b) =>
                (getCategory(a.key)?.displayIndex ?? Infinity) - (getCategory(b.key)?.displayIndex ?? Infinity) || a.key.localeCompare(b.key));
        } else {
            values = keywords.sort((a, b) => a.fileOrder - b.fileOrder || a.startLine - b.startLine);
        }
        const header = { state: entry.state, revision: entry.sequence, generation: entry.generation,
            total: values.length, complete: entry.state === 'complete', next: 0 };
        const rows = boundedIndexPage(values.slice(offset), header);
        return assertIndexPayload({ ...header, rows, next: offset + rows.length < values.length ? offset + rows.length : undefined });
    }

    release(lease: string) {
        const entry = this.leases.get(lease);
        this.leases.delete(lease);
        if (entry) {
            entry.subscribers.delete(lease);
            if (!entry.subscribers.size && entry.state === 'scanning') this.retire(entry);
        }
        return { released: true };
    }

    affected(rootFile: string) {
        const normalized = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
        const root = normalized(rootFile), directory = normalized(path.dirname(rootFile));
        const roots = [];
        for (const entry of this.entries.values()) {
            const files = [...entry.rows.values()].map(row => row.value).filter(row => row.type === 'file' || row.type === 'include');
            if (normalized(entry.rootFile) === root || files.some(row => row.filePath && normalized(row.filePath) === root ||
                row.candidatePaths?.some(file => normalized(file) === root)) ||
                [...(entry.snapshot?.effectiveSearchPathsByFile?.values() || [])].some((paths: any) =>
                    paths.some(file => normalized(file) === directory))) roots.push(entry.rootFile);
        }
        return [...new Set(roots)];
    }

    invalidate(rootFile: string) {
        const roots = new Set(this.affected(rootFile));
        // In-flight structures validate sources before completion and reuse unchanged file scans.
        for (const entry of this.entries.values()) if (roots.has(entry.rootFile) &&
            !(entry.state === 'scanning' && entry.reconcileChanges)) this.retire(entry, true);
        return [...roots];
    }

    async snapshot(lease: string, generation: number) {
        const entry = this.leases.get(lease);
        if (!entry || entry.generation !== generation) throw new Error('Expired project session');
        await entry.ready;
        if (entry.generation !== generation || this.leases.get(lease) !== entry)
            throw new Error('Expired project session');
        if (!entry.snapshot || !['complete', 'incomplete'].includes(entry.state))
            throw new Error('Project structure is not current');
        if (!await this.filesUnchanged([...entry.snapshot.fileIndexes].map(([file, index]: any) =>
            ({ file, revision: index.sourceRevision })))) {
            const error = new Error('Project structure is not current');
            error.name = 'ScanChangedError'; throw error;
        }
        if (entry.generation !== generation || this.leases.get(lease) !== entry)
            throw new Error('Expired project session');
        return entry.snapshot;
    }

    async loadStructure(rootFile: string, options: any, token?: any) {
        const handle = await this.open(rootFile, options, token);
        const registration = token?.onCancellationRequested?.(() => this.release(handle.lease));
        let cancellationPoll: ReturnType<typeof setInterval>;
        try {
            const entry = this.leases.get(handle.lease);
            await new Promise<void>((resolve, reject) => {
                if (token) cancellationPoll = setInterval(() => {
                    if (token.isCancellationRequested) reject(createCancellationError());
                }, 20);
                Promise.resolve(entry?.ready).then(resolve, reject);
            });
            throwIfCancellationRequested(token);
            // Internal consumers have not published a cursor yet and can use the retried generation.
            if (entry && this.leases.get(handle.lease) === entry) handle.generation = entry.generation;
            const snapshot = await this.snapshot(handle.lease, handle.generation);
            throwIfCancellationRequested(token);
            return { ...snapshot, fileIndexes: new Map([...snapshot.fileIndexes].map(([file, index]: any) => {
                const gaps = index.keywordBlocks.filter(block =>
                            !['*KEYWORD', '*END'].includes(block.keyword) && !(options.excludeMeshEntities &&
                                require('../core/scanner/scannerContracts').isMeshKeyword(block.keyword)))
                            .map(block => ({ reason: 'registry-reference-scan-deferred', scope: 'all',
                                keyword: block.keyword, startLine: block.startLine, targetKinds: [], targetDefinitions: [] }));
                return [file, { ...index, excludeMeshEntities: options.excludeMeshEntities === true,
                    registryReferences: { complete: gaps.length === 0, referenceOccurrences: [], valueDomainOccurrences: [],
                        referenceCoverage: { complete: gaps.length === 0, gaps } } }];
            })) };
        } finally { clearInterval(cancellationPoll); registration?.dispose?.(); this.release(handle.lease); }
    }

    private async fileView(request: any, token?: any) {
        let handle = request;
        if (request.action === 'file-view-open') handle = await this.open(request.rootFile,
            { singleFileOnly: true, largeFileThresholdBytes: 0 }, token);
        try {
            if (request.action === 'file-view-open' && request.progressive) return handle;
            if (request.action === 'file-view-open') {
                let entry = this.leases.get(handle.lease);
                await entry?.ready;
                // A delayed watcher may invalidate a reload before its first cursor is published.
                if (entry?.state === 'stale') {
                    this.release(handle.lease);
                    handle = await this.open(request.rootFile,
                        { singleFileOnly: true, largeFileThresholdBytes: 0 }, token);
                    entry = this.leases.get(handle.lease);
                    await entry?.ready;
                }
                if (entry && this.leases.get(handle.lease) === entry) handle.generation = entry.generation;
            }
            const entry = this.leases.get(handle.lease);
            if (!entry || entry.generation !== handle.generation || entry.state === 'stale') {
                if (request.action === 'file-view-open') throw new Error('Project structure is not current');
                return { state: 'stale' };
            }
            const partial = entry.state === 'scanning';
            if (partial && !entry.viewerProgress) return { state: 'scanning', scannedBytes: 0 };
            const snapshot = partial ? undefined : await this.snapshot(handle.lease, handle.generation);
            throwIfCancellationRequested(token);
            const index = partial ? entry.viewerProgress : snapshot.fileIndexes.get(snapshot.rootFile);
            if (!index?.largeFileLineMap) {
                if (request.action === 'file-view-open') this.release(handle.lease);
                return { state: 'incomplete', reason: 'large-file-line-map-unavailable' };
            }
            const header = { state: partial ? 'scanning' : 'complete', lease: handle.lease, generation: handle.generation,
                scannedBytes: partial ? index.scannedBytes : index.size,
                confirmedThroughLine: index.keywordBlocks?.at(-1)?.endLine ?? -1,
                size: index.size, mtimeMs: index.mtimeMs, scannerVersion: index.scannerVersion,
                lineCount: index.largeFileLineMap.lineCount };
            if (request.action === 'file-view-open' || request.mode === 'progress') return header;
            if (partial && request.mode !== 'window') return { state: 'scanning' };
            const anchor = Math.max(0, Math.min(index.largeFileLineMap.lineCount - 1, Number(request.line) || 0));
            if (request.mode === 'keyword') {
                const filter = String(request.filter || '').replace(/^\*/, '').toUpperCase();
                let count = 0, selected, selectedIndex = -1, first, last;
                for (const block of index.keywordBlocks) {
                    if (filter && !String(block.keyword).replace(/^\*/, '').toUpperCase().includes(filter)) continue;
                    first ||= block; last = block;
                    if (request.direction > 0 ? !selected && block.startLine > anchor : block.startLine < anchor) {
                        selected = block; selectedIndex = count;
                    }
                    count++;
                }
                if (!selected && count) { selected = request.direction > 0 ? first : last; selectedIndex = request.direction > 0 ? 0 : count - 1; }
                return { ...header, count, currentIndex: selectedIndex,
                    block: selected ? { startLine: selected.startLine, keyword: selected.keyword } : null };
            }
            if (request.mode === 'name') {
                const registry = require('../core/references/definitionRegistry').getDefinitionRegistryCatalog();
                let found, count = 0;
                for (const block of index.keywordBlocks) {
                    const display = block.displayIdentity;
                    if (display?.confidence !== 'verified' || !display.identity) continue;
                    const descriptor = registry.definitionDescriptorForKeyword(display.canonicalKeyword || block.keyword);
                    if (descriptor?.targetKind === request.targetKind && descriptor.recordMode !== 'repeat-all-data-records' &&
                        display.identity.field === descriptor.fieldName && String(display.identity.value) === String(request.id)) {
                        found = display.title; count++;
                    }
                }
                return { ...header, name: count === 1 ? found : undefined };
            }
            const start = Math.max(0, anchor - 60), end = Math.min(index.largeFileLineMap.lineCount - 1, anchor + 299);
            const checkpoint = Math.max(0, Math.min(index.largeFileLineMap.offsets.length - 1, Math.floor(start / index.largeFileLineMap.stride)));
            const blocks = index.keywordBlocks.filter(block => block.endLine >= start && block.startLine <= end);
            const offset = request.blockOffset || 0;
            if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError('Invalid file window cursor');
            const rows = boundedIndexPage(blocks.slice(offset), header);
            const keywordHeader = index.keywordBlocks.find(block => /^\*KEYWORD$/i.test(block.keyword));
            return assertIndexPayload({ ...header, windowLine: anchor, keywordBlocks: rows,
                next: offset + rows.length < blocks.length ? offset + rows.length : undefined,
                inputFormat: keywordHeader ? require('../core/parser/inputFormat').globalInputFormatFromKeywordLine(keywordHeader.rawKeyword) : 'standard',
                largeFileLineMap: { stride: index.largeFileLineMap.stride, offsets: [index.largeFileLineMap.offsets[checkpoint]],
                    baseLine: checkpoint * index.largeFileLineMap.stride, lineCount: index.largeFileLineMap.lineCount, complete: !partial } });
        } catch (error) {
            if (request.action === 'file-view-open') this.release(handle.lease);
            throw error;
        }
    }

    async request(request: any, token?: any) {
        if (request?.protocolVersion !== INDEX_PROTOCOL_VERSION) throw new Error('Project protocol mismatch; reload window');
        throwIfCancellationRequested(token);
        switch (request.action) {
            case 'file-view-open': case 'file-view': return this.fileView(request, token);
            case 'open': return this.open(request.rootFile, request.options, token);
            case 'read': return this.read(request);
            case 'keywords': return this.keywordPage(request);
            case 'status': {
                const entry = this.leases.get(request.lease);
                return entry && entry.generation === request.generation
                    ? { state: entry.state, sequence: entry.store ? entry.committed : entry.sequence, generation: entry.generation, error: entry.error }
                    : { state: 'stale', generation: entry?.generation };
            }
            case 'release': return this.release(request.lease);
            case 'affected': return { roots: this.affected(request.rootFile) };
            case 'metrics': return { memory: process.memoryUsage(), projects: [...this.entries.values()].map(entry => ({
                rootFile: entry.rootFile, generation: entry.generation, state: entry.state, projectionBytes: entry.bytes,
                retainedStructureBytes: entry.ownedBytes,
                stats: entry.snapshot?.stats, error: entry.error })) };
            case 'invalidate': return { invalidated: true, roots: this.invalidate(request.rootFile) };
            default: throw new TypeError('Unknown project session action');
        }
    }

    clear() {
        const pending = [...this.entries.values()].map(entry => entry.ready);
        for (const entry of this.entries.values()) this.retire(entry);
        this.leases.clear();
        return Promise.allSettled(pending);
    }
}
