import { createHash } from 'node:crypto';
import { EntityIndexStore } from './entityIndexStore';
const { FILE_SCAN_CACHE_SCHEMA_VERSION } = require('./fileScanCacheStore');
const { restoreReferenceMetadata } = require('../references/referenceMetadata');
const { throwIfCancellationRequested } = require('../scanner/scannerContracts');

/** Shared physical-file facts. Reference variants never overwrite the common structure. */
export class SqliteFileScanCache {
    constructor(private getStore: () => Promise<EntityIndexStore | undefined>, private maxBytes = 32 * 1024 * 1024) {}
    private key(file: string, variant: string) {
        return 'file-facts-v2:' + createHash('sha256').update(JSON.stringify([file, variant, FILE_SCAN_CACHE_SCHEMA_VERSION])).digest('hex');
    }
    private revision(signature: any) { return JSON.stringify([signature.size, signature.mtimeMs, signature.sourceRevision]); }

    private async read(store: EntityIndexStore, key: string, revision: string, token: any) {
        const header = await store.factPage(key, revision, 'header', 0, token);
        if (header.state !== 'ready' || header.records.length !== 1) return null;
        const { value, arrays } = header.records[0];
        let bytes = Buffer.byteLength(JSON.stringify(header.records)) * 4;
        for (const descriptor of arrays) {
            let parent = value;
            for (const part of descriptor.path.slice(0, -1)) parent = parent[part];
            const rows = parent[descriptor.path[descriptor.path.length - 1]];
            let offset = 0;
            do {
                const page = await store.factPage(key, revision, JSON.stringify(descriptor.path), offset, token, header.generation);
                if (page.state !== 'ready') return null;
                bytes += Buffer.byteLength(JSON.stringify(page.records)) * 4;
                if (bytes > this.maxBytes) return null;
                for (const group of page.records) rows.push(...group.map(row =>
                    descriptor.sharedFilePath ? { ...row, filePath: descriptor.sharedFilePath } : row));
                offset = page.next;
            } while (offset !== undefined);
            if (rows.length !== descriptor.length) return null;
        }
        return value;
    }

    private async write(store: EntityIndexStore, key: string, revision: string, input: any, token: any) {
        const arrays: { path: string[]; rows: any[]; sharedFilePath?: string }[] = [];
        const split = (value: any, path: string[]): any => {
            if (Array.isArray(value)) {
                const sharedFilePath = value.length && typeof value[0]?.filePath === 'string' &&
                    value.every(row => row?.filePath === value[0].filePath) ? value[0].filePath : undefined;
                arrays.push({ path, rows: value, sharedFilePath }); return [];
            }
            if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
                .map(([key, child]) => [key, split(child, [...path, key])]));
            return value;
        };
        const value = split(input, []);
        const build = await store.begin(key, revision, token);
        if (!build) return;
        try {
            await store.appendFacts(build, [{ section: 'header', ordinal: 0, payload: { value,
                arrays: arrays.map(({ path, rows, sharedFilePath }) => ({ path, length: rows.length, sharedFilePath })) } }], token);
            let total = Buffer.byteLength(JSON.stringify(value)) * 4;
            for (const array of arrays) {
                let batch = [], bytes = 0;
                let group = [], groupBytes = 2, ordinal = 0;
                const flushGroup = async () => {
                    if (!group.length) return;
                    const fact = { section: JSON.stringify(array.path), ordinal: ordinal++, payload: group };
                    const size = Buffer.byteLength(JSON.stringify(fact));
                    if (batch.length && bytes + size > 220 * 1024) {
                        await store.appendFacts(build, batch, token); batch = []; bytes = 0;
                    }
                    batch.push(fact); bytes += size; group = []; groupBytes = 2;
                };
                // Physical facts restore by file. Small bounded groups avoid a SQLite row per scalar/field.
                // Resolved entity matches remain individual rows with their own 200-result page boundary.
                const groupLimit = Math.min(8 * 1024, store.maxFactBytes);
                for (const item of array.rows) {
                    const payload = array.sharedFilePath ? { ...item } : item;
                    if (array.sharedFilePath) delete payload.filePath;
                    const size = Buffer.byteLength(JSON.stringify(payload)); total += size * 4;
                    if (total > this.maxBytes) throw new Error('File index exceeds restore memory budget');
                    if (group.length && groupBytes + size + 1 > groupLimit) await flushGroup();
                    group.push(payload); groupBytes += size + 1;
                }
                await flushGroup();
                if (batch.length) await store.appendFacts(build, batch, token);
            }
            await store.publish(build, { state: 'complete', reasons: [] }, token);
        } catch (error) { await store.abandon(build).catch(() => {}); throw error; }
    }

    async get(file: string, signature: any, options: any = {}) {
        const store = await this.getStore();
        if (!store || !signature.sourceRevision) return null;
        const revision = this.revision(signature);
        const structure = await this.read(store, this.key(file, options.structureOptionsKey), revision, options.cancellationToken);
        if (!structure) return null;
        let reference = {};
        if (!options.structureOnly) {
            reference = await this.read(store, this.key(file, 'references:' + options.scanOptionsKey), revision, options.cancellationToken);
            if (!reference) return null;
        }
        const fileIndex = { ...structure.fileIndex, ...reference };
        await restoreReferenceMetadata([fileIndex]);
        throwIfCancellationRequested(options.cancellationToken);
        return { filePath: file, fileIndex, scanOptionsKey: options.scanOptionsKey,
            keywords: require('../project/projectIndexer').keywordsFromFileIndex(fileIndex),
            includeEntries: fileIndex.includeEntries || [], searchPaths: fileIndex.searchPaths || [] };
    }

    async set(file: string, signature: any, scan: any, options: any = {}) {
        const store = await this.getStore();
        if (!store || !signature.sourceRevision) return;
        const revision = this.revision(signature);
        const { referenceDefinitions, registryReferences, excludeMeshEntities, ...structure } = scan.fileIndex;
        const key = this.key(file, structure.structureOptionsKey);
        const existing = await store.factPage(key, revision, 'header', 0, options.cancellationToken);
        if (existing.state !== 'ready') await this.write(store, key, revision, { fileIndex: structure }, options.cancellationToken);
        if (!options.structureOnly) await this.write(store, this.key(file, 'references:' + scan.scanOptionsKey), revision,
            { referenceDefinitions, registryReferences, excludeMeshEntities }, options.cancellationToken);
    }
}
