import { randomUUID } from 'node:crypto';
import { EntityQueryBudgetError } from '../core/references/entityQueryBudgetError';
import { EntityIndexStore, EntityIndexBuild } from '../core/cache/entityIndexStore';
import { entityFilesUnchanged } from '../core/cache/entityFileRevision';
import { assertIndexPayload, boundedIndexPage, indexJsonBytes } from '../shared/indexPages';
const { normalizeIndexedEntityId } = require('../core/references/indexedEntityQuery');
const { throwIfCancellationRequested } = require('../core/scanner/scannerContracts');

/** Query-local ownership of provisional matches; cache readers never see an unfinished generation. */
export class ProgressiveEntityQueries {
    private entries = new Map<string, any>();
    private leases = new Map<string, any>();
    constructor(private getStore: () => Promise<EntityIndexStore | undefined>,
        private produce: (query: any, token: any, accept: (rows: any[]) => Promise<void>, sources: (snapshot: any, referenceIndex?: any) => void) => Promise<any>,
        private memoryBytes = 8 * 1024 * 1024,
        private filesUnchanged = entityFilesUnchanged) {}

    async request(request: any, token?: any) {
        throwIfCancellationRequested(token);
        if (request.action === 'query-release') return this.release(request.lease, request.retain === true);
        if (request.action === 'query-diagnostics') {
            const entry = this.leases.get(request.lease);
            return assertIndexPayload(entry?.id === request.revision && entry.diagnostics
                ? { ...entry.diagnostics, updating: entry.dirty === true } : {});
        }
        if (request.action === 'query-page') return this.page(request, token);
        if (request.action !== 'query-open') throw new Error('Unknown entity query action');
        const query = request.query;
        if (!query || !require('node:path').isAbsolute(query.rootFile || '') ||
            !['project', 'single-file'].includes(query.scope) || normalizeIndexedEntityId(query.id) === null ||
            typeof query.targetKind !== 'string' || !query.targetKind.trim()) throw new TypeError('Invalid entity query');
        const normalized = { rootFile: query.rootFile, scope: query.scope, id: normalizeIndexedEntityId(query.id),
            ...(query.diagnostics === true ? { diagnostics: true } : {}),
            targetKind: query.targetKind.trim(), excludeMeshEntities: query.excludeMeshEntities === true,
            targetDefinitions: Array.isArray(query.targetDefinitions) ? [...new Set(query.targetDefinitions.map(String))].sort() : [] };
        const key = JSON.stringify(normalized);
        let entry = this.entries.get(key);
        if (entry && entry.state !== 'scanning' && entry.files && !await this.current(entry, token)) {
            this.retire(entry); entry = undefined;
        }
        entry = this.entries.get(key) || entry;
        if (!entry) {
            for (const candidate of this.entries.values()) if (!candidate.leases.size && !candidate.retained) this.retire(candidate);
            if (this.entries.size >= 11) throw new Error('Too many active entity queries');
            entry = { id: randomUUID(), key, query: normalized, state: 'scanning', leases: new Set(),
                token: { isCancellationRequested: false }, rows: new Map(), bytes: 0, sequence: 0,
                counts: { definition: 0, reference: 0 }, reasons: [] };
            this.entries.set(key, entry);
            const current = entry;
            current.ready = this.run(current).catch(error => {
                if (current.diagnostics) current.diagnostics.error = { name:
                    ['Error', 'RangeError', 'TypeError', 'CancellationError', 'ScanChangedError'].includes(error?.name)
                        ? error.name : 'OtherError',
                    ...(error instanceof EntityQueryBudgetError ? { reason: error.reason, budgetBytes: error.budgetBytes } : {}),
                    frames: String(error?.stack || '').split('\n').slice(1, 6)
                        .map(line => line.match(/[\\/]([^\\/(): ]+\.(?:js|ts):\d+:\d+)/)?.[1]).filter(Boolean) };
                if (!current.token.isCancellationRequested) console.warn('[lsdyna] Progressive entity query incomplete:', error);
                current.state = current.token.isCancellationRequested ? 'stale' : 'incomplete';
                current.reasons = [error instanceof EntityQueryBudgetError ? error.reason : 'entity-query-incomplete'];
            });
        }
        throwIfCancellationRequested(token);
        entry.retained = false;
        const lease = randomUUID(); entry.leases.add(lease); this.leases.set(lease, entry);
        return { lease, revision: entry.id, state: entry.state };
    }

    private async run(entry: any) {
        do {
            entry.dirty = false;
            entry.files = undefined;
            entry.build = undefined;
            entry.rows.clear(); entry.bytes = 0; entry.sequence = 0;
            entry.counts = { definition: 0, reference: 0 };
            entry.epoch = (entry.epoch || 0) + 1;
            if (entry.query.diagnostics) entry.diagnostics = { epoch: entry.epoch, phase: 'initializing' };
            try { await this.runPass(entry); }
            catch (error) {
                if (entry.files && !await this.current(entry, entry.token)) entry.dirty = true;
                if (!entry.dirty && (error as any)?.name !== 'ScanChangedError') throw error;
                entry.dirty = true;
            }
            throwIfCancellationRequested(entry.token);
            if (entry.dirty) {
                entry.state = 'scanning';
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } while (entry.dirty);
    }

    private async runPass(entry: any) {
        entry.store = await this.getStore();
        if (entry.diagnostics) Object.assign(entry.diagnostics, { storage: entry.store ? 'sqlite' : 'memory', phase: 'structure' });
        entry.build = entry.store ? await entry.store.begin(`progressive-query:${entry.id}`, entry.id, entry.token) : undefined;
        if (entry.store && !entry.build) throw new Error('Cannot reserve query generation');
        const heartbeat = entry.build ? setInterval(() => {
            void entry.store.renew(entry.build).catch(() => { entry.token.isCancellationRequested = true; });
        }, 10000) : undefined;
        try {
            const result = await this.produce(entry.query, entry.token, async rows => {
                throwIfCancellationRequested(entry.token);
                if (!entry.files || !await this.filesUnchanged(entry.files, entry.token)) entry.dirty = true;
                if (entry.dirty) return;
                if (entry.store) {
                    for (let start = 0; start < rows.length; start += 64) {
                        const batch = rows.slice(start, start + 64).map(row => ({ key: this.locationKey(row),
                            kind: 'resolved', id: entry.query.id, role: row.role, file: row.filePath,
                            block: String(row.line), line: row.line, start: row.startCharacter,
                            end: row.endCharacter, context: '', payload: row }));
                        await entry.store.append(entry.build, batch, entry.token);
                    }
                } else {
                    for (const row of rows) {
                        const key = this.locationKey(row);
                        if (entry.rows.has(key)) continue;
                        const bytes = indexJsonBytes(row) * 4 + key.length * 2 + 256;
                        if ([...this.entries.values()].reduce((sum, current) => sum + current.bytes, 0) + bytes > this.memoryBytes)
                            throw new EntityQueryBudgetError('entity-query-result-budget', this.memoryBytes);
                        entry.rows.set(key, { ordinal: ++entry.sequence, location: row }); entry.bytes += bytes;
                        entry.counts[row.role]++;
                    }
                }
            }, (snapshot, referenceIndex) => {
                entry.files = [...snapshot.fileIndexes].map(([file, index]: any) => ({ file, revision: index.sourceRevision }));
                entry.includeOccurrences = snapshot.graph?.includeOccurrences;
                entry.missingFiles = snapshot.missingFiles;
                entry.searchPaths = snapshot.effectiveSearchPathsByFile;
                if (entry.diagnostics) Object.assign(entry.diagnostics, {
                    phase: referenceIndex ? 'entity-query' : 'reference-index',
                    structure: require('./entityQueryDiagnosticSummary').entityQueryDiagnosticSummary(snapshot, referenceIndex),
                });
            });
            throwIfCancellationRequested(entry.token);
            if (!entry.files || !await this.current(entry, entry.token)) entry.dirty = true;
            if (entry.dirty) return;
            entry.state = result.state === 'complete' ? 'complete' : 'incomplete'; entry.reasons = result.reasons || [];
            entry.outcome = result.state;
            if (entry.build) await entry.store.publish(entry.build,
                { state: entry.state === 'complete' ? 'complete' : 'partial', reasons: entry.reasons }, entry.token);
        } catch (error) {
            if (entry.build && !entry.dirty && !entry.token.isCancellationRequested && entry.files && await this.filesUnchanged(entry.files))
                await entry.store.publish(entry.build, { state: 'partial', reasons: ['entity-query-incomplete'] }).catch(() => {});
            throw error;
        } finally {
            clearInterval(heartbeat);
            // Does nothing to a published generation; failed producers cannot publish a complete cache entry.
            if (entry.build) await entry.store.abandon(entry.build);
        }
    }

    private locationKey(row: any) {
        return JSON.stringify([process.platform === 'win32' ? row.filePath.toLowerCase() : row.filePath,
            row.line, row.startCharacter, row.endCharacter, row.role]);
    }

    private async current(entry: any, token?: any) {
        if (!await this.filesUnchanged(entry.files, token)) return false;
        if (!entry.searchPaths) return true;
        const { resolveIncludeFromSearchPathsAsync } = require('../core/project/projectIndexer');
        const cache = new Map();
        for (const row of [...entry.includeOccurrences || [], ...entry.missingFiles || []]) {
            throwIfCancellationRequested(token);
            const resolved = await resolveIncludeFromSearchPathsAsync(row.fileName, entry.searchPaths.get(row.fromFile), cache);
            if (resolved !== (entry.missingFiles?.includes(row) ? null : row.filePath)) return false;
        }
        return true;
    }

    private async page(request: any, token: any) {
        const entry = this.leases.get(request.lease);
        if (!entry || entry.id !== request.revision || entry.state === 'stale') return { status: 'stale' };
        const epoch = entry.epoch;
        const current = !entry.files || await this.current(entry, token);
        if (epoch !== entry.epoch) return this.updating(entry);
        if (!current) {
            if (entry.state === 'scanning') entry.dirty = true;
            else { this.retire(entry); return { status: 'stale' }; }
        }
        if (request.epoch !== undefined && request.epoch !== epoch) return { status: 'stale' };
        if (entry.dirty) return this.updating(entry);
        const role = request.role || 'reference', after = request.after || 0;
        const limit = request.limit ?? 200;
        if (!['definition', 'reference'].includes(role) || !Number.isSafeInteger(after) || after < 0)
            throw new TypeError('Invalid entity page cursor');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new TypeError('Invalid entity page limit');
        let page;
        if (entry.store && entry.build) page = await entry.store.ownedResultPage(entry.build, role, after, token, limit);
        else {
            const rows = [...entry.rows.values()].filter(row => row.location.role === role && row.ordinal > after);
            const records = boundedIndexPage(rows.slice(0, limit), { counts: entry.counts, next: after });
            page = { records, counts: entry.counts, next: records.length ? records[records.length - 1].ordinal : after,
                more: rows.length > records.length, groupCounts: {} };
        }
        const filesCurrent = !entry.files || await this.filesUnchanged(entry.files, token);
        if (epoch !== entry.epoch || entry.dirty) return this.updating(entry);
        if (entry.state === 'scanning' && !filesCurrent) {
            entry.dirty = true; return this.updating(entry);
        }
        if (page.state === 'expired' || entry.state === 'stale' || !filesCurrent) {
            entry.state = 'stale'; return { status: 'stale' };
        }
        const counts = { definition: 0, reference: 0, ...page.counts };
        const complete = entry.state === 'complete';
        return assertIndexPayload({ status: 'ready', revision: entry.id, state: entry.state,
            result: { lifecycle: entry.state === 'scanning' ? 'loading' : 'ready',
                scanning: entry.state === 'scanning',
                state: entry.state === 'scanning' ? counts.definition + counts.reference ? 'partial' : 'loading' : entry.outcome === 'unsupported' ? 'unsupported' : !complete ? 'partial' : counts.definition > 1 ? 'ambiguous'
                    : counts.definition + counts.reference === 0 ? 'missing' : 'exact',
                rootFile: entry.query.rootFile, query: { id: entry.query.id, targetKinds: [entry.query.targetKind], targetDefinitions: entry.query.targetDefinitions },
                reasons: entry.reasons, locations: page.records.map(row => row.location),
                page: { counts, groupCounts: page.groupCounts, complete, epoch,
                    next: page.more ? { [role]: { role, after: page.next, revision: entry.id, lease: request.lease, epoch } } : {} } },
            after: page.next, more: page.more });
    }

    private updating(entry: any) {
        return { status: 'ready', revision: entry.id, state: 'scanning', result: {
            state: 'loading', scanning: true, locations: [], reasons: [],
            page: { counts: { definition: 0, reference: 0 }, next: {}, complete: false, epoch: entry.epoch },
        } };
    }

    private retire(entry: any) {
        entry.token.isCancellationRequested = true; entry.state = 'stale'; entry.rows.clear();
        if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    }
    release(lease: string, retain = false) {
        const entry = this.leases.get(lease); this.leases.delete(lease);
        if (entry) {
            entry.leases.delete(lease);
            if (!entry.leases.size && retain) {
                // Keep only the most recently retained query; physical/type caches remain shared.
                for (const previous of this.entries.values()) if (previous !== entry && previous.retained) this.retire(previous);
                entry.retained = true;
            } else if (!entry.leases.size && entry.state === 'scanning') this.retire(entry);
        }
        return { released: true };
    }
    invalidate(rootFile: string) {
        const key = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
        for (const entry of this.entries.values()) if (key(entry.query.rootFile) === key(rootFile) ||
            entry.files?.some(row => key(row.file) === key(rootFile))) {
                if (entry.state === 'scanning') entry.dirty = true;
                else this.retire(entry);
            }
    }
    async clear() {
        const pending = [...this.entries.values()].map(entry => entry.ready);
        for (const entry of this.entries.values()) this.retire(entry);
        this.leases.clear(); await Promise.allSettled(pending);
    }
}
