import { keywordDataPath } from "../keywordDataPath";
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

const DEFAULT_CACHE_BYTES = 2 * 1024 * 1024;

export function normalizeSemanticKeyword(value: string): string {
    const normalized = String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
    return normalized ? `*${normalized}` : '';
}

function defaultRuntimeRoot(): string {
    return keywordDataPath("manual-semantics");
}

function sha256(value: Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

class ByteLru<T> {
    private readonly entries = new Map<string, { value: T; bytes: number }>();
    private totalBytes = 0;

    constructor(private readonly maximumBytes: number) {}

    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: T, bytes: number): void {
        const normalizedBytes = Math.max(0, Number.isFinite(bytes) ? Math.ceil(bytes) : 0);
        const previous = this.entries.get(key);
        if (previous) {
            this.entries.delete(key);
            this.totalBytes -= previous.bytes;
        }
        if (this.maximumBytes <= 0 || normalizedBytes > this.maximumBytes) {
            return;
        }
        this.entries.set(key, { value, bytes: normalizedBytes });
        this.totalBytes += normalizedBytes;
        while (this.totalBytes > this.maximumBytes && this.entries.size > 0) {
            const oldestKey = this.entries.keys().next().value!;
            const oldest = this.entries.get(oldestKey)!;
            this.entries.delete(oldestKey);
            this.totalBytes -= oldest.bytes;
        }
    }

    clear(): void {
        this.entries.clear();
        this.totalBytes = 0;
    }

    stats(): { entries: number; bytes: number; maximumBytes: number } {
        return {
            entries: this.entries.size,
            bytes: this.totalBytes,
            maximumBytes: this.maximumBytes,
        };
    }
}

export type ManualSemanticCatalogOptions = {
    rootDir?: string;
    maximumCacheBytes?: number;
    readFile?: (filePath: string) => Buffer;
};

type LoadedShard = {
    rulesByKeyword: Map<string, any[]>;
};

function bindDefaultEvidenceProfile(rule: any, sourceProfileId: string): any {
    if (!sourceProfileId || !Array.isArray(rule?.evidence) || rule.evidence.length === 0) return rule;
    let changed = false;
    const evidence = rule.evidence.map((item: any) => {
        if (!item || typeof item !== 'object' || item.sourceProfileId ||
            (Array.isArray(item.locations) && item.locations.length > 0)) {
            return item;
        }
        changed = true;
        return { ...item, sourceProfileId };
    });
    return changed ? { ...rule, evidence } : rule;
}

function defaultEvidenceSourceProfile(evidenceAuthority: any): string {
    const legacy = String(evidenceAuthority?.sourceProfileId || '');
    if (/^[a-f0-9]{64}$/i.test(legacy)) return legacy;
    const profileId = String(evidenceAuthority?.defaultSourceProfileId || '');
    if (!/^[a-f0-9]{64}$/i.test(profileId) ||
        !Array.isArray(evidenceAuthority?.profiles) ||
        !evidenceAuthority.profiles.some((profile: any) =>
            profile?.sourceProfileId === profileId)) {
        return '';
    }
    return profileId;
}

export class ManualSemanticCatalog {
    private manifest: any | null = null;
    private manifestReads = 0;
    private shardReads = 0;
    private readonly rootDir: string;
    private readonly readFile: (filePath: string) => Buffer;
    private readonly shardCache: ByteLru<LoadedShard>;
    private readonly preparing = new Map<string, Promise<void>>();
    private manifestPreparation: Promise<any> | undefined;
    private readonly readFileAsync: (filePath: string) => Promise<Buffer>;

    constructor(options: ManualSemanticCatalogOptions = {}) {
        this.rootDir = path.resolve(options.rootDir || defaultRuntimeRoot());
        this.readFile = options.readFile || ((filePath: string) => fs.readFileSync(filePath));
        this.readFileAsync = options.readFile ? async filePath => this.readFile(filePath) : filePath => fs.promises.readFile(filePath);
        this.shardCache = new ByteLru<LoadedShard>(
            Number.isFinite(options.maximumCacheBytes)
                ? Math.max(0, Number(options.maximumCacheBytes))
                : DEFAULT_CACHE_BYTES,
        );
    }

    private loadManifest(prepared?: Buffer): any {
        if (this.manifest) return this.manifest;
        const manifestPath = path.join(this.rootDir, 'manifest.json');
        const bytes = prepared || this.readFile(manifestPath);
        this.manifestReads++;
        const manifest = JSON.parse(bytes.toString('utf8'));
        if (!manifest || manifest.schemaVersion !== 1 ||
            manifest.kind !== 'dynasense-manual-semantic-runtime' ||
            manifest.compression !== 'gzip-json' ||
            !Number.isInteger(manifest.shardFunction?.count) ||
            manifest.shardFunction.count < 1 || !manifest.shards) {
            throw new Error('Unsupported DynaSense manual semantic runtime');
        }
        this.manifest = manifest;
        return manifest;
    }

    private shardIdForKeyword(keyword: string, manifest: any): string {
        const digest = crypto.createHash('sha256').update(keyword, 'utf8').digest();
        const value = digest.readUInt32BE(0);
        return (value % manifest.shardFunction.count).toString(16).padStart(2, '0');
    }

    private loadShard(shardId: string, manifest: any, prepared?: { encoded: Buffer; decoded: Buffer }): LoadedShard {
        const cached = this.shardCache.get(shardId);
        if (cached) return cached;
        const descriptor = manifest.shards[shardId];
        if (!descriptor || typeof descriptor.file !== 'string') {
            throw new Error(`Manual semantic shard is missing: ${shardId}`);
        }
        const shardPath = path.resolve(this.rootDir, descriptor.file);
        const relative = path.relative(this.rootDir, shardPath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Manual semantic shard path is unsafe: ${descriptor.file}`);
        }
        const encoded = prepared?.encoded || this.readFile(shardPath);
        this.shardReads++;
        if (encoded.length !== descriptor.compressedBytes || sha256(encoded) !== descriptor.sha256) {
            throw new Error(`Manual semantic shard integrity mismatch: ${shardId}`);
        }
        const plain = prepared?.decoded || zlib.gunzipSync(encoded, { maxOutputLength: descriptor.uncompressedBytes });
        if (plain.length !== descriptor.uncompressedBytes) {
            throw new Error(`Manual semantic shard size mismatch: ${shardId}`);
        }
        const payload = JSON.parse(plain.toString('utf8'));
        if (!payload || payload.schemaVersion !== 1 ||
            payload.kind !== 'dynasense-manual-semantic-shard' ||
            payload.shard !== shardId || !Array.isArray(payload.rules) ||
            payload.rules.length !== descriptor.rules) {
            throw new Error(`Manual semantic shard payload is invalid: ${shardId}`);
        }
        const rulesByKeyword = new Map<string, any[]>();
        const defaultEvidenceProfile = defaultEvidenceSourceProfile(
            manifest.sourceRuntime?.evidenceAuthority,
        );
        for (const sourceRule of payload.rules) {
            const rule = bindDefaultEvidenceProfile(sourceRule, defaultEvidenceProfile);
            const keyword = normalizeSemanticKeyword(rule.keyword);
            if (!rulesByKeyword.has(keyword)) rulesByKeyword.set(keyword, []);
            rulesByKeyword.get(keyword)!.push(rule);
        }
        const loaded = { rulesByKeyword };
        this.shardCache.set(shardId, loaded, descriptor.uncompressedBytes);
        return loaded;
    }

    rulesForKeyword(keyword: string): any[] {
        const normalized = normalizeSemanticKeyword(keyword);
        if (!normalized) return [];
        const manifest = this.loadManifest();
        const shardId = this.shardIdForKeyword(normalized, manifest);
        return this.loadShard(shardId, manifest).rulesByKeyword.get(normalized) || [];
    }

    async prepareKeyword(keyword: string): Promise<void> {
        const normalized = normalizeSemanticKeyword(keyword);
        if (!normalized) return;
        if (!this.manifest) {
            if (!this.manifestPreparation) this.manifestPreparation = this.readFileAsync(path.join(this.rootDir, 'manifest.json'))
                .then(bytes => this.loadManifest(bytes)).finally(() => { this.manifestPreparation = undefined; });
            await this.manifestPreparation;
        }
        const manifest = this.manifest, id = this.shardIdForKeyword(normalized, manifest);
        if (this.shardCache.get(id)) return;
        if (this.preparing.has(id)) return this.preparing.get(id);
        const pending = (async () => {
            const descriptor = manifest.shards[id];
            if (!descriptor || typeof descriptor.file !== 'string') throw new Error(`Manual semantic shard is missing: ${id}`);
            const file = path.resolve(this.rootDir, descriptor.file), relative = path.relative(this.rootDir, file);
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe manual semantic shard path');
            const encoded = await this.readFileAsync(file);
            if (encoded.length !== descriptor.compressedBytes || sha256(encoded) !== descriptor.sha256)
                throw new Error(`Manual semantic shard integrity mismatch: ${id}`);
            const decoded = await new Promise<Buffer>((resolve, reject) => zlib.gunzip(encoded,
                { maxOutputLength: descriptor.uncompressedBytes }, (error, value) => error ? reject(error) : resolve(value)));
            this.loadShard(id, manifest, { encoded, decoded });
        })();
        this.preparing.set(id, pending);
        try { await pending; } finally { this.preparing.delete(id); }
    }

    fieldRules(keyword: string, cardIndex: number, fieldName: string): any[] {
        const normalizedField = String(fieldName || '').trim().toUpperCase();
        if (!Number.isInteger(cardIndex) || cardIndex < 1 || !normalizedField) return [];
        return this.rulesForKeyword(keyword).filter(rule =>
            rule.selector?.cardIndex === cardIndex &&
            String(rule.selector?.fieldName || '').toUpperCase() === normalizedField
        );
    }

    keywordRules(keyword: string): any[] {
        return this.rulesForKeyword(keyword).filter(rule => !rule.selector);
    }

    summary(): any {
        const manifest = this.loadManifest();
        return {
            runtimeId: manifest.runtimeId,
            counts: manifest.counts,
            sourceLock: manifest.sourceRuntime?.sourceLock,
            evidenceAuthority: manifest.sourceRuntime?.evidenceAuthority,
        };
    }

    cacheStats(): any {
        return {
            manifestLoaded: !!this.manifest,
            manifestReads: this.manifestReads,
            shardReads: this.shardReads,
            ...this.shardCache.stats(),
        };
    }

    clearCache(): void {
        this.shardCache.clear();
    }
}

let defaultCatalog: ManualSemanticCatalog | null = null;

export function getManualSemanticCatalog(): ManualSemanticCatalog {
    if (!defaultCatalog) defaultCatalog = new ManualSemanticCatalog();
    return defaultCatalog;
}

export function resetManualSemanticCatalogForTesting(): void {
    defaultCatalog = null;
}
