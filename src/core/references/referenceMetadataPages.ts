import { createHash } from 'node:crypto';
import { EntityIndexStore, EntityIndexBuild } from '../cache/entityIndexStore';
import { EntityQueryCache } from './entityQueryCache';
import { indexJsonBytes, INDEX_PAYLOAD_BYTES } from '../../shared/indexPages';

const fields = ['targetKinds', 'targetDefinitions', 'targetKeywords', 'operationalProjection',
    'resolution', 'semanticRelation', 'targetSearch'];

/** Repeated rule descriptions live once per shard, outside the position rows. */
export class ReferenceMetadataPages {
    private pending = new Map<string, string>();
    private bytes = 0;
    constructor(private store: EntityIndexStore, private cache: EntityQueryCache) {}
    encode(record: any) {
        const value = { ...record }, metadata: any = {};
        for (const owner of ['', 'semantic', 'referenceValue']) {
            if (owner && !record[owner]) continue;
            const target = owner ? value[owner] = { ...record[owner] } : value;
            for (const field of fields) if (target[field] !== undefined) {
                (metadata[owner] ||= {})[field] = target[field]; delete target[field];
            }
        }
        indexJsonBytes(metadata);
        const text = JSON.stringify(metadata), key = createHash('sha256').update(text).digest('hex');
        if (!this.pending.has(key)) {
            this.bytes += Buffer.byteLength(text) * 2;
            if (this.bytes > 4 * INDEX_PAYLOAD_BYTES) throw new RangeError('Pending reference metadata budget exceeded');
            this.pending.set(key, text);
        }
        return { ...value, sharedMetadata: key };
    }
    async flush(build: EntityIndexBuild, token: any) {
        for (const [key, text] of this.pending) {
            const written = `reference-rule-written:${build.generation}:${key}`;
            if (this.cache.get(written)) continue;
            let batch = [];
            // Chunk only one bounded rule value, never a serialized file or project snapshot.
            for (let offset = 0; offset < text.length; offset += 1024) {
                batch.push({ section: 'reference-rule:' + key, ordinal: offset / 1024, payload: text.slice(offset, offset + 1024) });
                if (batch.length === 24) { await this.store.appendFacts(build, batch, token, true); batch = []; }
            }
            if (batch.length) await this.store.appendFacts(build, batch, token, true);
            this.cache.set(written, true);
        }
        this.pending.clear(); this.bytes = 0;
    }
    async restore(records: any[], key: string, revision: string, generation: string, token: any) {
        const result = [];
        for (const record of records) {
            if (!record.sharedMetadata) { result.push(record); continue; }
            const identity = record.sharedMetadata;
            const cacheKey = `reference-rule:${generation}:${identity}`;
            let metadata = this.cache.get(cacheKey);
            if (!metadata) {
                const parts = []; let offset = 0, bytes = 0;
                do {
                    const page = await this.store.factPage(key, revision, 'reference-rule:' + identity, offset, token, generation);
                    if (page.state !== 'ready' || !page.records.length) throw new Error('Reference rule metadata expired');
                    for (const part of page.records) {
                        bytes += Buffer.byteLength(part);
                        if (bytes > INDEX_PAYLOAD_BYTES) throw new RangeError('Reference rule restore budget exceeded');
                        parts.push(part);
                    }
                    offset = page.next;
                } while (offset !== undefined);
                const text = parts.join('');
                if (createHash('sha256').update(text).digest('hex') !== identity) throw new Error('Reference rule metadata damaged');
                metadata = JSON.parse(text); this.cache.set(cacheKey, metadata);
            }
            const { sharedMetadata, ...value } = record;
            for (const [owner, fields] of Object.entries(metadata)) {
                if (owner) value[owner] = { ...value[owner], ...fields as object };
                else Object.assign(value, fields);
            }
            result.push(value);
        }
        return result;
    }
}
