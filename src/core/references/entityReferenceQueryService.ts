'use strict';

import * as crypto from 'node:crypto';

const { buildProjectReferenceIndex } = require('./projectReferenceIndex');
const {
    collectRegistryReferenceMatches,
    definitionAtPosition,
    definitionLocations,
    queryFromReferenceSource,
} = require('./registryReferenceNetwork');
const { queryIndexedEntityId } = require('./indexedEntityQuery');
import { EntityQueryCache } from './entityQueryCache';
import { scanIndexedTypeDefinitions } from './entityTypeDefinitionIndex';
import { queryIndexedTypeReferences } from './entityTypeReferenceIndex';

export type EntityReferenceQueryState =
    'exact' | 'ambiguous' | 'missing' | 'partial' | 'indeterminate' | 'unsupported';
export type EntityReferenceLifecycleState =
    'loading' | 'ready' | 'stale' | 'needs-refresh' | 'failed';

function stableIdentity(value: unknown): string {
    const normalize = (item: any): any => Array.isArray(item) ? item.map(normalize)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]))
            : item;
    const canonical = JSON.stringify(normalize(value));
    return `entity-query:${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

function queryIdentityValue(value: any): any {
    if (!value || value.id === undefined) return value;
    const normalizeNamespace = (items: any[] = []) => [...new Set(items.map(item =>
        String(item || '').replace(/^\*/, '').toUpperCase()))].sort();
    return {
        id: value.id,
        targetKinds: normalizeNamespace(value.targetKinds),
        targetDefinitions: normalizeNamespace(value.targetDefinitions),
    };
}

function result(state: EntityReferenceQueryState, request: any, additions: any = {}) {
    return {
        state,
        lifecycle: 'ready' as EntityReferenceLifecycleState,
        queryIdentity: stableIdentity(queryIdentityValue(additions.query || additions.queryIdentityCore || request)),
        documentVersion: request.documentVersion ?? null,
        rootFile: request.rootFile ?? null,
        query: additions.query || null,
        definitions: additions.definitions || [],
        references: additions.references || [],
        ...additions,
        reasons: [...new Set(additions.reasons || [])].sort(),
    };
}

export class EntityReferenceQueryService {
    private readonly cache: EntityQueryCache;
    private indexBuildTail: Promise<void> = Promise.resolve();
    constructor(maxBytes = 512 * 1024 * 1024) { this.cache = new EntityQueryCache(maxBytes); }
    clear() { this.cache.clear(); }
    cacheStats() { return this.cache.stats(); }
    private readonly lifecycleByRoot = new Map<string, EntityReferenceLifecycleState>();
    private readonly pendingByRoot = new Map<string, number>();

    lifecycle(rootFile: string): EntityReferenceLifecycleState {
        const root = String(rootFile || '');
        const state = this.lifecycleByRoot.get(root) || 'ready';
        return this.pendingByRoot.has(root) && state !== 'stale' && state !== 'needs-refresh'
            ? 'loading' : state;
    }

    markStale(rootFile: string): void {
        this.cache.invalidateQueries();
        this.lifecycleByRoot.set(String(rootFile || ''), 'stale');
    }

    markNeedsRefresh(rootFile: string): void {
        this.cache.invalidateQueries();
        this.lifecycleByRoot.set(String(rootFile || ''), 'needs-refresh');
    }

    queryFromSource(referenceIndex: any, source: any, context: any = {}) {
        const request = { kind: 'source', rootFile: context.rootFile, documentVersion: context.documentVersion,
            filePath: context.documentPath, line: context.lineIndex, source };
        if (!source?.referenceValue) {
            return result('unsupported', request, { reasons: ['unindexed-relation'] });
        }
        if (source?.operationalProjection?.ambiguous === true) {
            return result('ambiguous', request, {
                reasons: ['operational-source-selector-ambiguous'],
                sourceCandidates: source.operationalProjection.candidateCount || 2,
                operationalProjection: source.operationalProjection,
            });
        }
        const resolved = queryFromReferenceSource(referenceIndex, source, context);
        if (resolved.state !== 'ready') {
            return result('indeterminate', request, { reasons: resolved.reasons, analysis: resolved.analysis });
        }
        return this.collect(referenceIndex, resolved.query, request, resolved.analysis);
    }

    queryFromDefinition(referenceIndex: any, documentPath: string, position: any, context: any = {}) {
        const request = { kind: 'definition', rootFile: context.rootFile,
            documentVersion: context.documentVersion, documentPath, position };
        const resolved = definitionAtPosition(referenceIndex, documentPath, position);
        if (resolved.state === 'none') return result('unsupported', request, { reasons: ['unindexed-relation'] });
        if (resolved.state === 'ambiguous') {
            return result('ambiguous', request, { definitions: resolved.definitions, reasons: resolved.reasons });
        }
        if (resolved.state !== 'ready') return result('indeterminate', request, { reasons: resolved.reasons });
        return this.collect(referenceIndex, resolved.query, request, null);
    }

    async queryById(snapshot: any, id: string | number, targetKind: string, context: any = {}) {
        const request = { kind: 'id', rootFile: snapshot?.rootFile, documentVersion: context.documentVersion,
            id, targetKind };
        if (require('../scanner/scannerContracts').isMeshEntityKind(targetKind) &&
            (snapshot?.fileIndexes instanceof Map ? [...snapshot.fileIndexes.values()] :
                Object.values(snapshot?.fileIndexes || {})).some(index => (index as any).excludeMeshEntities)) {
            return result('unsupported', request, { locations: [], reasons: ['mesh-entity-index-disabled'] });
        }
        const root = String(snapshot?.rootFile || '');
        const pending = this.pendingByRoot.get(root) || 0;
        if (pending === 0) this.lifecycleByRoot.set(root, 'loading');
        this.pendingByRoot.set(root, pending + 1);
        try {
            const revision = this.cache.revision(snapshot);
            const key = JSON.stringify([revision, id, targetKind,
                ...['scanBlockLines', 'scanDefinitions', 'queryReferences', 'collectReferences', 'definitionKeywords']
                    .map(name => this.cache.identity(context[name]))]);
            const indexed = await this.cache.run(key, context.cancellationToken, async cancellationToken => {
                const referenceIndex = this.index(snapshot, context.onPhase);
                return queryIndexedEntityId({ snapshot, id, targetKind, ...context, cancellationToken, referenceIndex,
                    scanDefinitions: context.scanDefinitions || (options => scanIndexedTypeDefinitions(options, this.cache)),
                    queryReferences: context.queryReferences || (options => queryIndexedTypeReferences({ ...options, revision }, this.cache)) });
            }, context.onPhase);
            const definitions = indexed.locations.filter((item: any) => item.role === 'definition');
            const references = indexed.locations.filter((item: any) => item.role === 'reference');
            const complete = indexed.state === 'complete';
            const state: EntityReferenceQueryState = indexed.state === 'partial' ? 'partial'
                : !complete ? 'indeterminate'
                    : definitions.length === 0 && references.length === 0 ? 'missing'
                        : definitions.length > 1 ? 'ambiguous' : 'exact';
            if (this.lifecycleByRoot.get(root) === 'loading') this.lifecycleByRoot.set(root, 'ready');
            return result(state, request, { query: { id, targetKinds: [targetKind], targetDefinitions: [] },
                definitions, references, locations: indexed.locations, reasons: indexed.reasons,
                referenceIndex: indexed.referenceIndex, sourceId: id, effectiveId: id });
        } catch (error) {
            const state = this.lifecycleByRoot.get(root);
            if ((error as any)?.name === 'CancellationError') {
                if (state === 'loading' && this.pendingByRoot.get(root) === 1) this.lifecycleByRoot.set(root, 'ready');
                return result('indeterminate', request, { reasons: ['cancelled'] });
            }
            if (state !== 'stale' && state !== 'needs-refresh') this.lifecycleByRoot.set(root, 'failed');
            return result('indeterminate', request, { lifecycle: 'failed',
                reasons: [error instanceof Error ? error.message : String(error)] });
        } finally {
            const remaining = this.pendingByRoot.get(root) - 1;
            if (remaining > 0) this.pendingByRoot.set(root, remaining);
            else this.pendingByRoot.delete(root);
        }
    }

    private collect(referenceIndex: any, query: any, request: any, analysis: any) {
        const definitions = definitionLocations(referenceIndex, query);
        const references = collectRegistryReferenceMatches(referenceIndex, query);
        if (references.state === 'partial') {
            return result('partial', request, { query, definitions, references: references.locations,
                reasons: references.reasons, analysis, sourceId: analysis?.sourceId,
                effectiveId: query.id, transform: analysis?.transformResolution });
        }
        if (references.state !== 'complete' || (referenceIndex.completenessReasons || []).length > 0) {
            return result('indeterminate', request, { query, reasons: [
                ...(references.reasons || []), ...(referenceIndex.completenessReasons || []),
            ], analysis });
        }
        if (definitions.length === 0) {
            return result('missing', request, { query, references: references.locations, analysis,
                sourceId: analysis?.sourceId, effectiveId: query.id,
                transform: analysis?.transformResolution });
        }
        return result(definitions.length === 1 ? 'exact' : 'ambiguous', request, {
            query, definitions, references: references.locations, analysis,
            sourceId: analysis?.sourceId, effectiveId: query.id,
            transform: analysis?.transformResolution,
        });
    }

    index(snapshot: any, onPhase?: (phase: any) => void) {
        const key = 'index:' + this.cache.revision(snapshot);
        let referenceIndex = this.cache.get(key);
        if (!referenceIndex) {
            const started = performance.now();
            referenceIndex = buildProjectReferenceIndex(snapshot);
            onPhase?.({ phase: 'reference-index-build', durationMs: performance.now() - started });
            this.cache.set(key, referenceIndex);
        }
        return referenceIndex;
    }

    async indexAsync(snapshot: any, token: any) {
        const key = 'async-index:' + this.cache.revision(snapshot);
        const completed: any = await this.cache.run(key, token, cancellationToken => {
            const build = this.indexBuildTail.then(async () => {
                require('../scanner/scannerContracts').throwIfCancellationRequested(cancellationToken);
                // Project context uses the service's budget, not a single result's quarter share.
                const reservation = this.cache.reserveResult(this.cache.maxBytes);
                try { return { state: 'complete', value: await require('./projectReferenceIndex')
                    .buildProjectReferenceIndexAsync(snapshot, cancellationToken, reservation.bytes) }; }
                finally { reservation.release(); }
            });
            this.indexBuildTail = build.then(() => undefined, () => undefined);
            return build;
        });
        return completed.value;
    }
}

module.exports = { EntityReferenceQueryService };
