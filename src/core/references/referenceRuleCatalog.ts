import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { keywordDataPath } from '../keywordDataPath';
import { ByteLru } from '../cache/byteLru';

type Descriptor = { file: string; sha256: string; contentSha256: string; compressedBytes: number; uncompressedBytes: number };
const MAX_SHARD_BYTES = 16 * 1024 * 1024;
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;
const sha = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
function check(value: unknown, message: string): asserts value {
    if (!value) throw new Error(`Reference rule catalog: ${message}`);
}
function freeze(value: any): any {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freeze(child);
        Object.freeze(value);
    }
    return value;
}

export class ReferenceRuleCatalog {
    private manifestValue: any;
    private legacyValue: any;
    private readonly cache: ByteLru<any>;
    private readonly pending = new Map<string, Promise<void>>();
    private readonly recordIdentities = new WeakMap<object, { keyword: string; index: number }>();
    constructor(readonly root = keywordDataPath('references'), maximumCacheBytes = DEFAULT_CACHE_BYTES) {
        this.cache = new ByteLru(maximumCacheBytes);
    }

    private manifest(): any {
        if (this.manifestValue !== undefined) return this.manifestValue;
        const file = path.join(this.root, 'reference-rules.manifest.json');
        let bytes: Buffer;
        try { bytes = fs.readFileSync(file); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            this.manifestValue = null;
            return null;
        }
        const value = JSON.parse(bytes.toString('utf8'));
        check(value?.storageVersion === 1 && value.codec === 'br' && value.parts && value.keywords &&
            Array.isArray(value.referenceKinds) && value.referenceKinds.every(kind => typeof kind === 'string'), 'unsupported manifest');
        for (const descriptor of Object.values(value.parts) as Descriptor[]) {
            check(/^[a-z0-9-]+\.json\.br$/.test(descriptor.file) &&
                /^[a-f0-9]{64}$/.test(descriptor.sha256) && /^[a-f0-9]{64}$/.test(descriptor.contentSha256) &&
                Number.isSafeInteger(descriptor.compressedBytes) && descriptor.compressedBytes > 0 &&
                descriptor.compressedBytes <= MAX_SHARD_BYTES &&
                Number.isSafeInteger(descriptor.uncompressedBytes) && descriptor.uncompressedBytes > 0 &&
                descriptor.uncompressedBytes <= MAX_SHARD_BYTES, 'invalid shard descriptor');
        }
        check(Object.values(value.keywords).every(key => typeof key === 'string' && Object.prototype.hasOwnProperty.call(value.parts, key)),
            'missing keyword shard');
        this.manifestValue = freeze(value);
        return this.manifestValue;
    }
    private legacy(): any {
        // Development tools also require this JSON; reuse their module cache instead of retaining a second full copy.
        return this.legacyValue ||= require(path.join(this.root, 'field_reference_index.json'));
    }
    private decode(key: string, bytes: Buffer): any {
        const descriptor: Descriptor = this.manifest().parts[key];
        check(bytes.length === descriptor.compressedBytes && sha(bytes) === descriptor.sha256, 'compressed content mismatch');
        const raw = zlib.brotliDecompressSync(bytes, { maxOutputLength: descriptor.uncompressedBytes });
        check(raw.length === descriptor.uncompressedBytes && sha(raw) === descriptor.contentSha256, 'decoded content mismatch');
        const value = freeze(JSON.parse(raw.toString('utf8')));
        this.cache.set(key, value, raw.length);
        return value;
    }
    private part(key: string): any {
        const cached = this.cache.get(key);
        if (cached !== undefined) return cached;
        const descriptor = this.manifest().parts[key];
        check(descriptor, `missing part ${key}`);
        return this.decode(key, fs.readFileSync(path.join(this.root, descriptor.file)));
    }
    metadata(key: string): any {
        return this.manifest() ? this.part(key) : this.legacy()[key];
    }
    identity(): any {
        return this.manifest() ? this.part('identity') : this.legacy();
    }
    keywords(): string[] {
        return Object.keys(this.manifest()?.keywords || this.legacy().references);
    }
    records(keyword: string): any[] | undefined {
        const manifest = this.manifest();
        if (!manifest) return this.legacy().references?.[keyword];
        const key = manifest.keywords[keyword];
        if (!key) return undefined;
        const records = this.part(key)[keyword];
        check(Array.isArray(records), `missing records for ${keyword}`);
        if (records.length && !this.recordIdentities.has(records[0])) records.forEach((record, index) => {
            check(record && typeof record === 'object', `invalid record for ${keyword}`);
            this.recordIdentities.set(record, { keyword, index });
        });
        return records;
    }
    matchRecord(records: any[], previous: any): any | undefined {
        if (records.includes(previous)) return previous;
        const identity = previous && typeof previous === 'object' ? this.recordIdentities.get(previous) : undefined;
        if (!identity) return undefined;
        const candidate = records[identity.index];
        const current = candidate && this.recordIdentities.get(candidate);
        return current?.keyword === identity.keyword ? candidate : undefined;
    }
    referenceKinds(): string[] | undefined { return this.manifest()?.referenceKinds; }
    async prepareKeyword(keyword: string): Promise<void> {
        const manifest = this.manifest();
        if (!manifest) { this.legacy(); return; }
        const key = manifest.keywords[keyword];
        if (!key || this.cache.get(key) !== undefined) return;
        let pending = this.pending.get(key);
        if (!pending) {
            pending = fs.promises.readFile(path.join(this.root, manifest.parts[key].file))
                .then(bytes => { if (this.cache.get(key) === undefined) this.decode(key, bytes); })
                .finally(() => { this.pending.delete(key); });
            this.pending.set(key, pending);
        }
        await pending;
    }
}

let current: ReferenceRuleCatalog | undefined;
export function getReferenceRuleCatalog(): ReferenceRuleCatalog {
    const root = keywordDataPath('references');
    if (!current || current.root !== root) current = new ReferenceRuleCatalog(root);
    return current;
}
