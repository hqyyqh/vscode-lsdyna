import { EntityQueryCache } from './entityQueryCache';
import { createHash } from 'node:crypto';
const { scanOnDemandDefinitions, selectOnDemandDefinitionDescriptors } = require('./onDemandDefinitionScanner');
const { parameterContextsForDocument } = require('./projectReferenceIndex');
const { estimateMemorySize } = require('../cache/memorySize');

/** A file shard is reusable only while both its text and its semantic contexts agree. */
export async function scanIndexedTypeDefinitions(options: any, cache: EntityQueryCache) {
    const kinds = [...new Set<string>(options.targetKinds)].sort();
    const descriptors = selectOnDemandDefinitionDescriptors(kinds, options.targetDefinitions, options.definitionKeywords);
    const result = { state: 'complete', definitions: [], reasons: [], descriptors,
        scannedBlockCount: 0, scannedLineCount: 0, totalMatchCount: 0, cacheable: true };
    const entries = options.fileIndexes instanceof Map ? [...options.fileIndexes] : Object.entries(options.fileIndexes || {});
    if (!entries.length || !descriptors.length) return scanOnDemandDefinitions(options);
    for (const [file, index] of entries) {
        const contexts = options.projectScoped ? parameterContextsForDocument(options.referenceIndex, file) : [];
        const contextRevision = createHash('sha256').update(JSON.stringify(contexts,
            (_key, value) => value instanceof Map ? [...value] : value)).digest('hex');
        for (const kind of kinds.filter(kind => descriptors.some(descriptor => descriptor.targetKind === kind))) {
            const scoped = { ...options, fileIndexes: new Map([[file, index]]), targetKinds: [kind] };
            const key = JSON.stringify(['definition-type', file, cache.fileRevision(index), index.documentVersion,
                options.projectScoped, contextRevision, kind, options.targetDefinitions,
                cache.identity(options.definitionKeywords), cache.identity(options.scanBlockLines)]);
            let built = false;
            const stored: any = await cache.run(key, options.cancellationToken, async sharedToken => {
                built = true;
                let exhausted = false, bytes = 256;
                const reservation = cache.reserveBuild();
                const buildBudget = reservation.bytes;
                if (!buildBudget) { reservation.release(); return { state: 'budget-fallback' }; }
                const token = { get isCancellationRequested() {
                    return exhausted || sharedToken.isCancellationRequested;
                } };
                try {
                    const lookup = await scanOnDemandDefinitions({ ...scoped, collectAllIds: true,
                    maxStoredMatches: Number.MAX_SAFE_INTEGER, cancellationToken: token,
                    acceptDefinition: definition => {
                        bytes += estimateMemorySize(definition, cache.maxBytes) + 256 + definition.filePath.length * 2;
                        exhausted = bytes > buildBudget;
                        return !exhausted;
                    } });
                    if (exhausted) return { state: 'budget-fallback' };
                    const byId = new Map();
                    for (const definition of lookup.definitions) {
                        const records = byId.get(definition.id) || [];
                        records.push(definition); byId.set(definition.id, records);
                    }
                    return { ...lookup, definitions: undefined, byId };
                } finally { reservation.release(); }
            });
            const lookup = stored.state === 'budget-fallback' ? await scanOnDemandDefinitions(scoped)
                : { ...stored, definitions: stored.byId.get(options.effectiveId) || [],
                    scannedBlockCount: built ? stored.scannedBlockCount : 0,
                    scannedLineCount: built ? stored.scannedLineCount : 0 };
            if (lookup.state === 'cancelled') return lookup;
            if (lookup.state !== 'complete') result.state = 'partial';
            for (const definition of lookup.definitions) result.definitions.push(definition);
            result.reasons.push(...lookup.reasons);
            result.scannedBlockCount += lookup.scannedBlockCount || 0;
            result.scannedLineCount += lookup.scannedLineCount || 0;
            result.cacheable &&= lookup.cacheable;
        }
    }
    result.totalMatchCount = result.definitions.length;
    result.reasons = [...new Set(result.reasons)];
    return result;
}
