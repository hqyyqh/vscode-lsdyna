import { createHash } from 'node:crypto';
import { EntityIndexStore } from '../cache/entityIndexStore';
import { entityFilesUnchanged } from '../cache/entityFileRevision';
import { EntityQueryCache } from './entityQueryCache';
import { populateEntityPageDisplay } from './entityPageDisplay';
const { FILE_SCAN_CACHE_SCHEMA_VERSION } = require('../cache/fileScanCacheStore');
const { throwIfCancellationRequested } = require('../scanner/scannerContracts');
const { resolveIncludeFromSearchPathsAsync } = require('../project/projectIndexer');

/** Published pages contain resolved matches; raw candidates still use the semantic query engine. */
export class SqliteEntityPages {
    constructor(private store: EntityIndexStore, private displayCache: EntityQueryCache) {}
    private key(request: any) {
        return 'resolved-query-v2:' + createHash('sha256').update(JSON.stringify([FILE_SCAN_CACHE_SCHEMA_VERSION,
            request.rootFile, request.scope, request.targetKind, request.id, request.excludeMeshEntities === true])).digest('hex');
    }

    private async includesUnchanged(key: string, revision: string, generation: string, token: any) {
        let offset = 0;
        const resolutions = new Map();
        do {
            const page = await this.store.factPage(key, revision, 'includes', offset, token, generation);
            if (page.state !== 'ready') return false;
            for (const row of page.records) {
                throwIfCancellationRequested(token);
                if (await resolveIncludeFromSearchPathsAsync(row.fileName, row.searchPaths, resolutions) !== row.filePath) return false;
            }
            offset = page.next;
        } while (offset !== undefined);
        return true;
    }

    async read(request: any, query: string, token: any) {
        const key = this.key(request);
        const first = await this.store.factPage(key, undefined, 'envelope', 0, token);
        if (first.state !== 'ready' || first.records.length !== 1) return null;
        const files = [];
        let cursor;
        do {
            const page = await this.store.filePage(key, first.revision, cursor, token);
            if (page.state !== 'ready' || page.generation !== first.generation) return null;
            files.push(...page.files); cursor = page.next;
        } while (cursor);
        if (!files.length || !await entityFilesUnchanged(files, token)) {
            throwIfCancellationRequested(token); return { status: 'refresh' };
        }
        if (!await this.includesUnchanged(key, first.revision, first.generation, token)) return { status: 'refresh' };
        if (request.cursor && (request.cursor.revision !== first.revision || request.cursor.query !== query))
            return { status: 'expired', revision: first.revision };
        const locations = [], next = {}, fileIndexes = new Map();
        for (const role of ['definition', 'reference']) {
            if (request.cursor && request.cursor.role !== role) continue;
            const page = await this.store.factPage(key, first.revision, role, request.cursor?.offset || 0, token, first.generation);
            if (page.state !== 'ready') return null;
            for (const row of page.records) {
                locations.push(row.location);
                const file = row.location.filePath;
                if (!fileIndexes.has(file)) fileIndexes.set(file, { sourceRevision: files.find(item => item.file === file)?.revision,
                    keywordBlocks: [] });
                fileIndexes.get(file).keywordBlocks.push(...row.blocks);
            }
            if (page.next !== undefined) next[role] = { revision: first.revision, query, role, offset: page.next };
        }
        for (const index of fileIndexes.values()) index.keywordBlocks = [...new Map<number, any>(
            index.keywordBlocks.map(block => [block.startLine, block])).values()].sort((a, b) => a.startLine - b.startLine);
        await populateEntityPageDisplay({ fileIndexes }, locations, request, this.displayCache, token);
        if (!await entityFilesUnchanged(files, token) || !await this.includesUnchanged(key, first.revision, first.generation, token)) {
            throwIfCancellationRequested(token); return { status: 'refresh' };
        }
        const envelope = first.records[0];
        return { status: 'ready', revision: first.revision, result: { ...envelope, locations,
            page: { ...envelope.page, next, ...(request.cursor ? { appendRole: request.cursor.role } : {}) } } };
    }

    async write(request: any, snapshot: any, revision: string, result: any, token: any) {
        // Missing Includes can appear without changing any existing file's identity.
        if (snapshot.missingFiles?.length || result.lifecycle !== 'ready') return;
        const files = [...snapshot.fileIndexes].map(([file, index]: any) => ({ file, revision: index.sourceRevision,
            parser: FILE_SCAN_CACHE_SCHEMA_VERSION }));
        if (!files.length || files.some(file => !file.revision)) return;
        const build = await this.store.begin(this.key(request), revision, token);
        if (!build) return;
        try {
            for (let i = 0; i < files.length; i += 32) await this.store.metadata(build, { files: files.slice(i, i + 32) }, token);
            const includes = request.scope === 'project' ? snapshot.graph?.includeOccurrences || [] : [];
            const resolutions = new Map();
            let includeBatch = [], includeBytes = 0;
            for (let ordinal = 0; ordinal < includes.length; ordinal++) {
                const row = includes[ordinal];
                const searchPaths = snapshot.effectiveSearchPathsByFile?.get(row.fromFile);
                if (!searchPaths || await resolveIncludeFromSearchPathsAsync(row.fileName, searchPaths, resolutions) !== row.filePath) {
                    const error = new Error('Include resolution changed before query publication'); error.name = 'ScanChangedError'; throw error;
                }
                const fact = { section: 'includes', ordinal,
                    payload: { fileName: row.fileName, searchPaths, filePath: row.filePath } };
                const bytes = Buffer.byteLength(JSON.stringify(fact));
                if (includeBatch.length && includeBytes + bytes > 128 * 1024) {
                    await this.store.appendFacts(build, includeBatch, token); includeBatch = []; includeBytes = 0;
                }
                includeBatch.push(fact); includeBytes += bytes;
            }
            if (includeBatch.length) await this.store.appendFacts(build, includeBatch, token);
            const { definitions, references } = result;
            const groupCounts = {};
            for (const row of references) groupCounts[row.entityKind || ''] = (groupCounts[row.entityKind || ''] || 0) + 1;
            const envelope = { state: result.state, lifecycle: result.lifecycle, queryIdentity: result.queryIdentity,
                rootFile: result.rootFile, query: result.query, sourceId: result.sourceId, effectiveId: result.effectiveId,
                reasons: result.reasons, page: { counts: { definition: definitions.length, reference: references.length }, groupCounts } };
            await this.store.appendFacts(build, [{ section: 'envelope', ordinal: 0, payload: envelope }], token);
            const directives = new Map<string, any[]>();
            for (const [file, index] of snapshot.fileIndexes)
                directives.set(file, (index.keywordBlocks || []).filter(block => block.keyword === '*KEYWORD'));
            for (const [role, rows] of [['definition', definitions], ['reference', references]] as const) {
                let batch = [], bytes = 0;
                for (let ordinal = 0; ordinal < rows.length; ordinal++) {
                    const location = rows[ordinal], blocks = snapshot.fileIndexes.get(location.filePath)?.keywordBlocks || [];
                    let low = 0, high = blocks.length - 1;
                    while (low <= high) { const middle = (low + high) >>> 1;
                        if (blocks[middle].startLine <= location.line) low = middle + 1; else high = middle - 1; }
                    const block = blocks[high];
                    // KEYWORD format directives are small and preserve state across multiple format changes.
                    const displayBlocks = (directives.get(location.filePath) || []).filter(item => item.startLine <= location.line);
                    if (block && location.line <= block.endLine && block.keyword !== '*KEYWORD') displayBlocks.push(block);
                    const row = { section: role, ordinal, payload: { location, blocks: displayBlocks } };
                    const size = Buffer.byteLength(JSON.stringify(row));
                    if (batch.length && bytes + size > 128 * 1024) {
                        await this.store.appendFacts(build, batch, token); batch = []; bytes = 0;
                    }
                    batch.push(row); bytes += size;
                }
                if (batch.length) await this.store.appendFacts(build, batch, token);
            }
            if (!await entityFilesUnchanged(files, token)) throw new Error('Resolved query changed before publication');
            await this.store.publish(build, { state: 'complete', reasons: [] }, token);
        } catch (error) { await this.store.abandon(build).catch(() => {}); throw error; }
    }
}
