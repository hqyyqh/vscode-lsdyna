import { createHash } from 'node:crypto';
import { EntityIndexStore } from '../cache/entityIndexStore';
import { entityFilesUnchanged } from '../cache/entityFileRevision';
import { EntityQueryCache } from './entityQueryCache';
import { scanIndexedTypeDefinitions } from './entityTypeDefinitionIndex';
import { buildSqliteDefinitionShard } from './sqliteDefinitionShard';
const { stripKeywordInputFormatMarker } = require('../parser/inputFormat');
const { selectOnDemandDefinitionDescriptors } = require('./onDemandDefinitionScanner');
const { parameterContextsForDocument } = require('./projectReferenceIndex');
const { FILE_SCAN_CACHE_SCHEMA_VERSION } = require('../cache/fileScanCacheStore');
const { throwIfCancellationRequested } = require('../scanner/scannerContracts');

export class SqliteDefinitionIndex {
    private readonly keywordSets = new WeakMap<object, Set<string>>();
    constructor(private store: EntityIndexStore, private fallback: EntityQueryCache,
        private onFallback: (error: unknown) => void, private resultBytes = 8 * 1024 * 1024) {}

    readonly scan = async (options: any) => {
        try { return await this.scanStored(options); }
        catch (error) {
            if (['CancellationError', 'ScanChangedError'].includes((error as Error)?.name)) throw error;
            throwIfCancellationRequested(options.cancellationToken);
            this.onFallback(error);
            return scanIndexedTypeDefinitions(options, this.fallback);
        }
    };

    private async scanStored(options: any) {
        const kinds = [...new Set<string>(options.targetKinds)].sort();
        const descriptors = selectOnDemandDefinitionDescriptors(kinds, options.targetDefinitions, options.definitionKeywords);
        const result = { state: 'complete', definitions: [], reasons: [], descriptors,
            scannedBlockCount: 0, scannedLineCount: 0, totalMatchCount: 0, cacheable: true };
        const entries = options.fileIndexes instanceof Map ? [...options.fileIndexes] : Object.entries(options.fileIndexes || {});
        if (!entries.length || !descriptors.length) return scanIndexedTypeDefinitions(options, this.fallback);
        if (entries.some(([, index]) => !index.sourceRevision || Number.isInteger(index.documentVersion)))
            return scanIndexedTypeDefinitions(options, this.fallback);
        const files = entries.map(([file, index]) => ({ file, revision: index.sourceRevision }));
        const verify = async () => {
            if (!await entityFilesUnchanged(files, options.cancellationToken)) {
                throwIfCancellationRequested(options.cancellationToken);
                const error = new Error('Entity definition source changed'); error.name = 'ScanChangedError'; throw error;
            }
        };
        await verify();
        let bytes = 0;
        for (const [file, index] of entries) {
            throwIfCancellationRequested(options.cancellationToken);
            const contexts = options.projectScoped ? parameterContextsForDocument(options.referenceIndex, file) : [];
            let blockKeywords = this.keywordSets.get(index);
            if (!blockKeywords && Array.isArray(index.keywordBlocks)) {
                blockKeywords = new Set(index.keywordBlocks.map(block => stripKeywordInputFormatMarker(
                    String(block.keyword || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0])));
                this.keywordSets.set(index, blockKeywords);
            }
            for (const kind of kinds.filter(kind => descriptors.some(descriptor => descriptor.targetKind === kind))) {
                if (blockKeywords && !descriptors.some(descriptor => descriptor.targetKind === kind &&
                    blockKeywords.has(descriptor.keyword))) continue;
                const key = createHash('sha256').update(JSON.stringify(['definitions', file, options.projectScoped, contexts,
                    kind, descriptors.filter(descriptor => descriptor.targetKind === kind), FILE_SCAN_CACHE_SCHEMA_VERSION, index.excludeMeshEntities === true],
                    (_key, value) => value instanceof Map ? [...value] : value)).digest('hex');
                let page = await this.store.page(key, index.sourceRevision, kind, options.effectiveId, 'definition', undefined, options.cancellationToken);
                if (page.state === 'miss') {
                    let builtHere = false;
                    const shared: any = await this.fallback.run(`sqlite-definition:${key}:${index.sourceRevision}`,
                        options.cancellationToken, async cancellationToken => {
                            builtHere = true;
                            const lookup = await buildSqliteDefinitionShard(this.store, key, index.sourceRevision,
                                file, index, FILE_SCAN_CACHE_SCHEMA_VERSION,
                                { ...options, targetKinds: [kind], sourceRevision: index.sourceRevision, cancellationToken });
                            // Coalesce only the in-flight build; SQLite owns completed generations and their eviction.
                            return { state: 'persisted', lookup };
                        });
                    const built = shared.lookup;
                    if (built.state !== 'complete') return scanIndexedTypeDefinitions(options, this.fallback);
                    if (builtHere) {
                        result.scannedBlockCount += built.scannedBlockCount;
                        result.scannedLineCount += built.scannedLineCount;
                    }
                    page = await this.store.page(key, index.sourceRevision, kind, options.effectiveId, 'definition', undefined, options.cancellationToken);
                }
                for (;;) {
                    if (page.state !== 'ready' || page.coverage.state !== 'complete') throw new Error('Entity definition generation changed');
                    for (const definition of page.records) {
                        bytes += Buffer.byteLength(JSON.stringify(definition)) * 4 + 256;
                        if (bytes > this.resultBytes) throw new Error('Entity definition result budget exhausted');
                        result.definitions.push(definition);
                    }
                    if (!page.next) break;
                    page = await this.store.page(key, index.sourceRevision, kind, options.effectiveId, 'definition', page.next, options.cancellationToken);
                }
            }
        }
        await verify();
        result.totalMatchCount = result.definitions.length;
        return result;
    }
}
