import { createHash } from 'node:crypto';
import { EntityQueryCache } from './entityQueryCache';
const { scanOnDemandReferences, queryRegistryReferences } = require('./onDemandReferenceScanner');
const { parameterContextsForDocument } = require('./projectReferenceIndex');
const { collectRegistryReferenceMatches, namespaceMatches, occurrenceBinding, DEFAULT_MAX_MATCHES } = require('./registryReferenceNetwork');
const { estimateMemorySize } = require('../cache/memorySize');

/** Cache parsed facts, including unresolved bindings; each ID still uses the semantic resolver. */
export async function queryIndexedTypeReferences(options: any, cache: EntityQueryCache) {
    const { referenceIndex, query } = options;
    const entries = options.fileIndexes instanceof Map ? [...options.fileIndexes] : Object.entries(options.fileIndexes || {});
    const recovered = { occurrences: [], gaps: [], resolvedGaps: new Set(), scannedBlocks: 0, scannedLines: 0 };
    const shardIdentities = [];
    for (const [file, index] of entries as [string, any][]) {
        const gaps = (referenceIndex.registryReferenceCoverageGaps || []).filter(gap => gap.filePath === file);
        if (!gaps.length) continue;
        const contextRevision = createHash('sha256').update(JSON.stringify([
            parameterContextsForDocument(referenceIndex, file), gaps],
            (_key, value) => value instanceof Map ? [...value] : value)).digest('hex');
        const key = JSON.stringify(['reference-type', file, cache.fileRevision(index), contextRevision,
            query.targetKinds, query.targetDefinitions, cache.identity(options.scanBlockLines)]);
        let built = false;
        const shard: any = await cache.run(key, options.cancellationToken, async sharedToken => {
            built = true;
            const reservation = cache.reserveBuild();
            let bytes = 256, exhausted = reservation.bytes === 0;
            try {
                if (exhausted) return { state: 'budget-fallback' };
                const token = { get isCancellationRequested() { return exhausted || sharedToken.isCancellationRequested; } };
                const lookup = await scanOnDemandReferences({ ...options,
                    referenceIndex: { ...referenceIndex, registryReferenceCoverageGaps: gaps },
                    fileIndexes: new Map([[file, index]]), query: { ...query, id: undefined },
                    collectAllIds: true, maxMatches: Number.MAX_SAFE_INTEGER, cancellationToken: token,
                    acceptOccurrence: occurrence => {
                        bytes += estimateMemorySize(occurrence, reservation.bytes) + 256;
                        exhausted = bytes > reservation.bytes;
                        return !exhausted;
                    } });
                if (exhausted) return { state: 'budget-fallback' };
                // Only publish fully recovered scans. Unresolved binding facts remain in occurrences.
                return { ...lookup, state: lookup.cancelled ? 'cancelled' : lookup.gaps.length ? 'partial' : 'complete',
                    resolvedGaps: undefined, resolved: gaps.map(gap => lookup.resolvedGaps.has(gap)) };
            } finally { reservation.release(); }
        });
        if (shard.state === 'budget-fallback') return queryRegistryReferences(options);
        if (shard.cancelled) return { state: 'cancelled', locations: [], reasons: ['cancelled'], referenceIndex };
        shardIdentities.push(cache.identity(shard));
        for (const occurrence of shard.occurrences) recovered.occurrences.push(occurrence);
        recovered.gaps.push(...shard.gaps);
        gaps.forEach((gap, index) => { if (shard.resolved[index]) recovered.resolvedGaps.add(gap); });
        if (built) { recovered.scannedBlocks += shard.scannedBlocks; recovered.scannedLines += shard.scannedLines; }
    }
    const combined = { ...referenceIndex,
        registryReferenceOccurrences: [...referenceIndex.registryReferenceOccurrences, ...recovered.occurrences],
        registryReferenceCoverageGaps: [...referenceIndex.registryReferenceCoverageGaps, ...recovered.gaps] };
    const candidates = await referenceCandidates(combined, options, shardIdentities, cache);
    const selected = candidates ? { ...combined, registryReferenceOccurrences: candidates } : combined;
    const collect = options.collectReferences || collectRegistryReferenceMatches;
    const reservation = cache.reserveBuild();
    try {
        const longestPath = entries.reduce((length, [file]) => Math.max(length, String(file).length), 0);
        const maxMatches = Math.floor(reservation.bytes / (2048 + longestPath * 4));
        return { ...collect(selected, query, { cancellationToken: options.cancellationToken,
            ...(maxMatches > DEFAULT_MAX_MATCHES ? { maxMatches } : {}),
            retainVerifiedMatchesOnIncomplete: options.retainVerifiedMatchesOnIncomplete,
            resolvedCoverageGaps: recovered.resolvedGaps }), referenceIndex: combined,
            metadataOccurrences: selected.registryReferenceOccurrences, referenceLookup: recovered };
    } finally { reservation.release(); }
}

async function referenceCandidates(referenceIndex: any, options: any, shards: number[], cache: EntityQueryCache) {
    // Target-priority relations depend on the requested definition lookup. Keep them
    // as dynamic candidates rather than binding them against another ID's lookup.
    const key = JSON.stringify(['reference-bindings', options.revision ?? cache.identity(options.referenceIndex), options.query.targetKinds,
        options.query.targetDefinitions, shards]);
    const bins: any = await cache.run(key, options.cancellationToken, async token => {
        const reservation = cache.reserveBuild();
        let bytes = 256, count = 0;
        const byId = new Map(), dynamic = [];
        try {
            if (!reservation.bytes) return { state: 'budget-fallback' };
            for (const occurrence of referenceIndex.registryReferenceOccurrences || []) {
                if (++count % 256 === 0) await new Promise(resolve => setImmediate(resolve));
                if (token.isCancellationRequested) return { state: 'cancelled' };
                if (!namespaceMatches(options.query, occurrence)) continue;
                const search = occurrence.referenceValue?.targetSearch || occurrence.referenceValue?.semanticRelation?.targetSearch;
                const contexts = occurrence.occurrenceId === undefined
                    ? parameterContextsForDocument(referenceIndex, occurrence.filePath) : [];
                const bindings = search ? [] : contexts.length > 1
                    ? contexts.map(context => occurrenceBinding(referenceIndex,
                        { ...occurrence, occurrenceId: context.occurrenceId }, { bindingOnly: true }))
                    : [occurrenceBinding(referenceIndex, occurrence, { bindingOnly: true })];
                const ids = new Set(bindings.filter(binding => binding.ready).map(binding => binding.analysis.id));
                bytes += estimateMemorySize(occurrence, reservation.bytes) + 256 * (ids.size + 1);
                if (bytes > reservation.bytes) return { state: 'budget-fallback' };
                const record = { occurrence, ordinal: count };
                if (search || bindings.some(binding => !binding.ready)) dynamic.push(record);
                else for (const id of ids) {
                    const records = byId.get(id) || [];
                    records.push(record); byId.set(id, records);
                }
            }
            return { state: 'complete', byId, dynamic };
        } finally { reservation.release(); }
    });
    if (bins.state !== 'complete') return null;
    return [...(bins.byId.get(options.query.id) || []), ...bins.dynamic]
        .sort((left, right) => left.ordinal - right.ordinal).map(record => record.occurrence);
}
