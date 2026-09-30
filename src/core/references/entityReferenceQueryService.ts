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
        reasons: [...new Set(additions.reasons || [])].sort(),
        ...additions,
    };
}

export class EntityReferenceQueryService {
    private readonly lifecycleByRoot = new Map<string, EntityReferenceLifecycleState>();

    lifecycle(rootFile: string): EntityReferenceLifecycleState {
        return this.lifecycleByRoot.get(String(rootFile || '')) || 'ready';
    }

    markStale(rootFile: string): void {
        this.lifecycleByRoot.set(String(rootFile || ''), 'stale');
    }

    markNeedsRefresh(rootFile: string): void {
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
        this.lifecycleByRoot.set(String(snapshot?.rootFile || ''), 'loading');
        try {
            const indexed = await queryIndexedEntityId({ snapshot, id, targetKind, ...context });
            const definitions = (indexed.locations || []).filter((item: any) => item.role === 'definition');
            const references = (indexed.locations || []).filter((item: any) => item.role === 'reference');
            const complete = indexed.state === 'complete';
            const state: EntityReferenceQueryState = indexed.state === 'partial' ? 'partial'
                : !complete ? 'indeterminate'
                    : definitions.length === 0 && references.length === 0 ? 'missing'
                        : definitions.length > 1 ? 'ambiguous' : 'exact';
            this.lifecycleByRoot.set(String(snapshot?.rootFile || ''), 'ready');
            return result(state, request, { query: { id, targetKinds: [targetKind], targetDefinitions: [] },
                definitions, references, locations: indexed.locations || [], reasons: indexed.reasons,
                referenceIndex: indexed.referenceIndex, sourceId: id, effectiveId: id });
        } catch (error) {
            this.lifecycleByRoot.set(String(snapshot?.rootFile || ''), 'failed');
            return result('indeterminate', request, { lifecycle: 'failed',
                reasons: [error instanceof Error ? error.message : String(error)] });
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

    index(snapshot: any) { return buildProjectReferenceIndex(snapshot); }
}

module.exports = { EntityReferenceQueryService };
