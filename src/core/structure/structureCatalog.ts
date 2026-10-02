import { keywordDataPath } from "../keywordDataPath";
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { StructureBinding, StructureGrammar, VerificationStatus } from './types';

const DEFAULT_MANIFEST_BYTES = 2_200_000;
const DEFAULT_SHARD_BYTES = 131_072;
const DEFAULT_RUNTIME_BYTES = 3_200_000;
const DEFAULT_CACHE_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STABLE_GRAMMAR_PATTERN = /^structure-grammar:[0-9a-f]{24}$/;
const STABLE_NODE_PATTERN = /^structure-node:[0-9a-f]{24}$/;
const VERIFIED = new Set<VerificationStatus>(['verified-full', 'verified-boundary-only']);
const INVENTORY_STATUSES = new Set([
    ...VERIFIED,
    'profile-unverified',
    'schema-manual-drift',
    'manual-only',
    'schema-only',
    'manual-navigation-only',
    'unsupported-format',
    'deferred-complex-grammar',
    'deferred-unclassified-structure-signal',
    'rejected-conflict',
]);
const NODE_TYPES = new Set([
    'sequence', 'empty', 'record', 'opaqueRecord', 'choice', 'conditional',
    'optional', 'repeat', 'repeatGroup', 'textBody', 'continuation', 'prefix',
    'suffix', 'marker', 'formatChoice', 'preprocessorGuard',
]);

type LoadedShard = {
    bytes: number;
    grammars: Map<string, StructureGrammar>;
};

class ByteLru<T extends { bytes: number }> {
    private readonly values = new Map<string, T>();
    private total = 0;

    constructor(private readonly maximumBytes: number) {}

    get(key: string): T | null {
        const value = this.values.get(key);
        if (!value) return null;
        this.values.delete(key);
        this.values.set(key, value);
        return value;
    }

    set(key: string, value: T): void {
        const previous = this.values.get(key);
        if (previous) {
            this.total -= previous.bytes;
            this.values.delete(key);
        }
        if (value.bytes > this.maximumBytes) return;
        this.values.set(key, value);
        this.total += value.bytes;
        while (this.total > this.maximumBytes && this.values.size > 0) {
            const oldest = this.values.keys().next().value;
            const removed = this.values.get(oldest);
            this.values.delete(oldest);
            this.total -= removed?.bytes || 0;
        }
    }

    clear(): void {
        this.values.clear();
        this.total = 0;
    }

    stats(): { entries: number; bytes: number; maximumBytes: number } {
        return { entries: this.values.size, bytes: this.total, maximumBytes: this.maximumBytes };
    }
}

export type StructureCatalogOptions = {
    runtimeRoot?: string;
    maximumManifestBytes?: number;
    maximumShardBytes?: number;
    cacheBytes?: number;
};

export type StructureCatalogBindingResult = {
    keyword: string;
    sourceProfileId?: string;
    binding?: StructureBinding;
    identitySource?: any;
    status: 'verified' | 'profile-unverified' | 'unsupported-input';
    reason: string;
};

export type StructureCatalogGrammarResult = StructureCatalogBindingResult & {
    grammar?: StructureGrammar;
};

function sha256(bytes: Buffer): string {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value: any): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function stableId(prefix: string, value: any): string {
    return `${prefix}:${sha256(Buffer.from(canonicalJson(value), 'utf8')).slice(0, 24)}`;
}

function childNodes(node: any): any[] {
    if (node?.type === 'sequence' || node?.type === 'repeatGroup') return node.nodes || [];
    if (node?.type === 'choice') return node.branches || [];
    if (node?.type === 'conditional') return [node.thenNode, node.elseNode].filter(Boolean);
    if (['optional', 'repeat', 'prefix', 'suffix', 'marker', 'continuation',
        'formatChoice', 'preprocessorGuard'].includes(node?.type)) {
        return node.node ? [node.node] : [];
    }
    return [];
}

function validateNodeIdentity(
    node: any,
    sourceProfileId: string,
    expectedStatus: VerificationStatus,
    seenIds: Set<string>,
): void {
    if (!node || !STABLE_NODE_PATTERN.test(String(node.nodeId || '')) ||
        seenIds.has(node.nodeId) || !NODE_TYPES.has(node.type) ||
        node.sourceProfileId !== sourceProfileId || node.verificationStatus !== expectedStatus ||
        !Array.isArray(node.evidenceIds) || !Array.isArray(node.locations) ||
        node.evidenceIds.length !== node.locations.length) {
        throw new Error(`grammar-node-contract-invalid:${node?.nodeId || 'missing'}`);
    }
    seenIds.add(node.nodeId);
    for (let index = 0; index < node.locations.length; index++) {
        const location = node.locations[index];
        if (!location || typeof location.manualId !== 'string' ||
            typeof node.evidenceIds[index] !== 'string' || !node.evidenceIds[index] ||
            location.evidenceId !== node.evidenceIds[index] ||
            !Number.isInteger(location.page) || location.page < 1 ||
            !SHA256_PATTERN.test(String(location.evidenceTextSha256 || '')) ||
            !SHA256_PATTERN.test(String(location.quoteSha256 || ''))) {
            throw new Error(`grammar-node-evidence-invalid:${node.nodeId}`);
        }
    }
    const identity = { ...node };
    delete identity.nodeId;
    if (node.nodeId !== stableId('structure-node', identity)) {
        throw new Error(`grammar-node-content-hash-mismatch:${node.nodeId}`);
    }
    if (node.type === 'record' && expectedStatus === 'verified-full' &&
        (!node.geometryRef || node.geometryRef.kind === 'none')) {
        throw new Error(`verified-full-record-geometry-missing:${node.nodeId}`);
    }
    for (const child of childNodes(node)) {
        validateNodeIdentity(child, sourceProfileId, expectedStatus, seenIds);
    }
}

function validateGrammarIdentity(grammar: StructureGrammar, shardId: string): void {
    if (!grammar || !STABLE_GRAMMAR_PATTERN.test(String(grammar.grammarId || '')) ||
        !/^\*[A-Z0-9_/-]+$/.test(String(grammar.keyword || '')) ||
        !SHA256_PATTERN.test(String(grammar.sourceProfileId || '')) ||
        !VERIFIED.has(grammar.verificationStatus) ||
        grammar.repairPolicy?.automatic !== false ||
        shardIdForKeyword(grammar.keyword) !== shardId) {
        throw new Error(`grammar-contract-invalid:${grammar?.grammarId || 'missing'}`);
    }
    if (grammar.verificationStatus === 'verified-boundary-only' &&
        grammar.repairPolicy?.uniqueRepairEligible !== false) {
        throw new Error(`boundary-grammar-repair-authority-invalid:${grammar.grammarId}`);
    }
    const seenIds = new Set<string>();
    validateNodeIdentity(grammar.root, grammar.sourceProfileId, grammar.verificationStatus, seenIds);
    for (const prefix of grammar.prefixes || []) {
        validateNodeIdentity(prefix.node, grammar.sourceProfileId, 'verified-full', seenIds);
    }
    for (const suffix of grammar.suffixes || []) {
        validateNodeIdentity(suffix.node, grammar.sourceProfileId, 'verified-full', seenIds);
    }
    const identity = { ...grammar };
    delete identity.grammarId;
    if (grammar.grammarId !== stableId('structure-grammar', identity)) {
        throw new Error(`grammar-content-hash-mismatch:${grammar.grammarId}`);
    }
}

function canonicalKeyword(value: string): string {
    const token = String(value || '').trim().split(/[\s,]+/, 1)[0].toUpperCase();
    if (!token) return '';
    return token.startsWith('*') ? token : `*${token}`;
}

function shardIdForKeyword(keyword: string): string {
    const hash = crypto.createHash('sha256').update(keyword, 'utf8').digest();
    return (hash.readUInt32BE(0) % 32).toString(16).padStart(2, '0');
}

function safeChild(root: string, relativeFile: string): string | null {
    const candidate = path.resolve(root, relativeFile);
    const relative = path.relative(path.resolve(root), candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return candidate;
}

export class KeywordStructureCatalog {
    private readonly runtimeRoot: string;
    private readonly maximumManifestBytes: number;
    private readonly maximumShardBytes: number;
    private readonly cache: ByteLru<LoadedShard>;
    private manifest: any = null;
    private manifestError: string | null = null;
    private manifestReads = 0;
    private shardReads = 0;

    constructor(options: StructureCatalogOptions = {}) {
        this.runtimeRoot = path.resolve(options.runtimeRoot || keywordDataPath("structure-v2"));
        this.maximumManifestBytes = options.maximumManifestBytes || DEFAULT_MANIFEST_BYTES;
        this.maximumShardBytes = options.maximumShardBytes || DEFAULT_SHARD_BYTES;
        this.cache = new ByteLru(options.cacheBytes || DEFAULT_CACHE_BYTES);
    }

    private loadManifest(): any {
        if (this.manifest) return this.manifest;
        if (this.manifestError) throw new Error(this.manifestError);
        try {
            const bytes = fs.readFileSync(path.join(this.runtimeRoot, 'manifest.json'));
            this.manifestReads++;
            if (bytes.length > this.maximumManifestBytes) {
                throw new Error('manifest-capacity-exceeded');
            }
            const manifest = JSON.parse(bytes.toString('utf8'));
            if (manifest?.schemaVersion !== 2 ||
                manifest?.kind !== 'lsdyna-keyword-structure-runtime-v2' ||
                manifest?.policy?.id !== 'official-keyword-structure-grammar-v2' ||
                manifest?.policy?.authority !== 'official-pdf-profile-scoped' ||
                manifest?.policy?.failClosed !== true ||
                manifest?.policy?.unknownIsValid !== false ||
                manifest?.policy?.automaticMutation !== false ||
                canonicalJson(manifest?.policy?.diagnosticEligibleStatuses) !==
                    canonicalJson(['verified-full']) ||
                !manifest?.sourceProfiles || !manifest?.identitySources || !manifest?.shards) {
                throw new Error('manifest-contract-invalid');
            }
            const capacity = manifest?.capacityContract;
            if (!capacity ||
                !Number.isInteger(capacity.manifestBytesMax) || capacity.manifestBytesMax < 1 ||
                !Number.isInteger(capacity.singleShardBytesMax) || capacity.singleShardBytesMax < 1 ||
                !Number.isInteger(capacity.runtimeBytesMax) || capacity.runtimeBytesMax < 1 ||
                !Number.isInteger(capacity.grammarShardLruBytes) || capacity.grammarShardLruBytes < 1 ||
                capacity.manifestBytesMax > this.maximumManifestBytes ||
                bytes.length > capacity.manifestBytesMax ||
                capacity.singleShardBytesMax > this.maximumShardBytes ||
                capacity.runtimeBytesMax > DEFAULT_RUNTIME_BYTES ||
                capacity.grammarShardLruBytes > DEFAULT_CACHE_BYTES) {
                throw new Error('manifest-capacity-contract-invalid');
            }
            const identities = Object.keys(manifest.identitySources);
            const profileIds = Object.keys(manifest.sourceProfiles);
            if (identities.some(keyword => !/^\*[^\r\n\0]{1,255}$/.test(keyword) ||
                keyword !== keyword.toUpperCase()) ||
                profileIds.some(profileId => !SHA256_PATTERN.test(profileId))) {
                throw new Error('manifest-identity-contract-invalid');
            }
            let bindingCount = 0;
            let verifiedBindingCount = 0;
            for (const profileId of profileIds) {
                const profile = manifest.sourceProfiles[profileId];
                if (profile?.sourceProfileId !== profileId ||
                    !SHA256_PATTERN.test(String(profile.manualPackManifestSha256 || '')) ||
                    !SHA256_PATTERN.test(String(profile.pdfAuthorityIndexSha256 || '')) ||
                    Object.keys(profile.bindings || {}).length !== identities.length) {
                    throw new Error(`manifest-profile-inventory-invalid:${profileId}`);
                }
                for (const keyword of identities) {
                    const binding = profile.bindings[keyword];
                    if (!binding || !INVENTORY_STATUSES.has(binding.status)) {
                        throw new Error(`manifest-binding-missing:${profileId}:${keyword}`);
                    }
                    if (VERIFIED.has(binding.status)) {
                        if (!STABLE_GRAMMAR_PATTERN.test(String(binding.grammarId || '')) || binding.reason) {
                            throw new Error(`manifest-verified-binding-invalid:${profileId}:${keyword}`);
                        }
                        verifiedBindingCount++;
                    } else if (!binding.reason || binding.grammarId) {
                        throw new Error(`manifest-unverified-binding-invalid:${profileId}:${keyword}`);
                    }
                    bindingCount++;
                }
            }
            if (Number(manifest.counts?.identities) !== identities.length ||
                Number(manifest.counts?.sourceProfiles) !== profileIds.length ||
                Number(manifest.counts?.bindings) !== bindingCount ||
                Number(manifest.counts?.verifiedBindings) !== verifiedBindingCount ||
                Number(manifest.counts?.shards) !== Object.keys(manifest.shards).length) {
                throw new Error('manifest-census-invalid');
            }
            let declaredRuntimeBytes = bytes.length;
            let declaredGrammarCount = 0;
            for (const [shardId, descriptor] of Object.entries(manifest.shards) as Array<[string, any]>) {
                if (!/^[0-9a-f]{2}$/.test(shardId) ||
                    !/^shards\/[0-9a-f]{2}\.[0-9a-f]{16}\.json$/.test(String(descriptor?.file || '')) ||
                    !SHA256_PATTERN.test(String(descriptor?.sha256 || '')) ||
                    descriptor.file !== `shards/${shardId}.${descriptor.sha256.slice(0, 16)}.json` ||
                    !Number.isInteger(descriptor?.bytes) || descriptor.bytes < 1 ||
                    descriptor.bytes > this.maximumShardBytes ||
                    !Number.isInteger(descriptor?.grammars) || descriptor.grammars < 0) {
                    throw new Error(`manifest-shard-descriptor-invalid:${shardId}`);
                }
                declaredRuntimeBytes += descriptor.bytes;
                declaredGrammarCount += descriptor.grammars;
            }
            if (declaredRuntimeBytes > capacity.runtimeBytesMax ||
                declaredGrammarCount !== Number(manifest.counts?.grammars)) {
                throw new Error('manifest-runtime-census-invalid');
            }
            this.manifest = manifest;
            return manifest;
        } catch (error) {
            this.manifestError = `structure-runtime-manifest-unavailable:${error?.message || error}`;
            throw new Error(this.manifestError);
        }
    }

    lookupBinding(sourceProfileId: string | null | undefined, keywordValue: string): StructureCatalogBindingResult {
        const keyword = canonicalKeyword(keywordValue);
        if (!sourceProfileId) {
            return { keyword, status: 'profile-unverified', reason: 'active-source-profile-unavailable' };
        }
        let manifest: any;
        try {
            manifest = this.loadManifest();
        } catch (error) {
            return { keyword, sourceProfileId, status: 'unsupported-input', reason: String(error?.message || error) };
        }
        const profile = manifest.sourceProfiles[sourceProfileId];
        if (!profile || profile.sourceProfileId !== sourceProfileId) {
            return { keyword, sourceProfileId, status: 'profile-unverified', reason: 'source-profile-not-packaged' };
        }
        const binding: StructureBinding | undefined = profile.bindings?.[keyword];
        if (!binding) {
            return { keyword, sourceProfileId, status: 'profile-unverified', reason: 'keyword-not-in-runtime-inventory' };
        }
        const base = {
            keyword,
            sourceProfileId,
            binding,
            identitySource: manifest.identitySources?.[keyword],
        };
        if (!VERIFIED.has(binding.status as VerificationStatus) || !binding.grammarId) {
            return {
                ...base,
                status: 'profile-unverified',
                reason: binding.reason || 'binding-not-verified',
            };
        }
        return { ...base, status: 'verified', reason: binding.status };
    }

    private loadShard(shardId: string, manifest: any): LoadedShard {
        const cached = this.cache.get(shardId);
        if (cached) return cached;
        const descriptor = manifest.shards?.[shardId];
        if (!descriptor || !SHA256_PATTERN.test(String(descriptor.sha256 || '')) ||
            !Number.isInteger(descriptor.bytes) || descriptor.bytes < 1 ||
            descriptor.bytes > this.maximumShardBytes) {
            throw new Error(`shard-descriptor-invalid:${shardId}`);
        }
        const shardPath = safeChild(this.runtimeRoot, descriptor.file);
        if (!shardPath) throw new Error(`shard-path-unsafe:${shardId}`);
        const bytes = fs.readFileSync(shardPath);
        this.shardReads++;
        if (bytes.length !== descriptor.bytes || bytes.length > this.maximumShardBytes ||
            sha256(bytes) !== descriptor.sha256) {
            throw new Error(`shard-integrity-mismatch:${shardId}`);
        }
        const payload = JSON.parse(bytes.toString('utf8'));
        if (payload?.schemaVersion !== 2 ||
            payload?.kind !== 'lsdyna-keyword-structure-grammar-shard-v2' ||
            payload?.shard !== shardId || !payload?.grammars) {
            throw new Error(`shard-contract-invalid:${shardId}`);
        }
        const grammars = new Map<string, StructureGrammar>();
        for (const [key, grammar] of Object.entries(payload.grammars) as Array<[string, StructureGrammar]>) {
            if (!grammar?.grammarId || grammars.has(grammar.grammarId)) {
                throw new Error(`shard-grammar-identity-invalid:${shardId}`);
            }
            if (key !== grammar.grammarId) throw new Error(`shard-grammar-key-mismatch:${shardId}`);
            validateGrammarIdentity(grammar, shardId);
            grammars.set(grammar.grammarId, grammar);
        }
        if (grammars.size !== descriptor.grammars) {
            throw new Error(`shard-grammar-count-mismatch:${shardId}`);
        }
        const loaded = { bytes: bytes.length, grammars };
        this.cache.set(shardId, loaded);
        return loaded;
    }

    grammarForKeyword(
        sourceProfileId: string | null | undefined,
        keywordValue: string,
    ): StructureCatalogGrammarResult {
        const lookup = this.lookupBinding(sourceProfileId, keywordValue);
        if (lookup.status !== 'verified') return lookup;
        try {
            const manifest = this.loadManifest();
            const shardId = shardIdForKeyword(lookup.keyword);
            const grammar = this.loadShard(shardId, manifest).grammars.get(lookup.binding.grammarId);
            if (!grammar || grammar.keyword !== lookup.keyword ||
                grammar.sourceProfileId !== lookup.sourceProfileId ||
                grammar.verificationStatus !== lookup.binding.status) {
                throw new Error(`grammar-binding-mismatch:${lookup.keyword}`);
            }
            return { ...lookup, grammar };
        } catch (error) {
            return {
                ...lookup,
                status: 'unsupported-input',
                reason: `structure-runtime-grammar-unavailable:${error?.message || error}`,
            };
        }
    }

    /** Identity membership does not require a selected solver profile or grant a grammar. */
    hasKeywordIdentity(keywordValue: string): boolean | null {
        try { return Object.prototype.hasOwnProperty.call(this.loadManifest().identitySources, canonicalKeyword(keywordValue)); }
        catch { return null; }
    }

    clear(): void {
        this.cache.clear();
        this.manifest = null;
        this.manifestError = null;
    }

    cacheStats(): Record<string, number> {
        const stats = this.cache.stats();
        return {
            entries: stats.entries,
            bytes: stats.bytes,
            maximumBytes: stats.maximumBytes,
            manifestReads: this.manifestReads,
            shardReads: this.shardReads,
        };
    }
}

export const DEFAULT_STRUCTURE_SOURCE_PROFILE_EN =
    '7228f3a1ffa8d305ed8800136c8447f288d95090cb540b170c52d7acef6be1e6';
export const DEFAULT_STRUCTURE_SOURCE_PROFILE_BILINGUAL =
    'b4dfa3ef1f41ba19eee0a48679031c7bfb24081f4ef9ff523b42d6cec4e543b3';

export const keywordStructureRuntimeInternals = {
    canonicalJson,
    canonicalKeyword,
    shardIdForKeyword,
    stableId,
};
