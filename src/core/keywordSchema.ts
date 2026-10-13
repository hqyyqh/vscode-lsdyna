import { contactKeywordParts, contactKeywordKey } from './contactKeywordName';
import { keywordDataPath } from "./keywordDataPath";
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { classifyKeywordLine, isKeywordCommentLine } from './parser/keywordLine';
import { readFieldContext, clearFieldContextCache, type FieldContextOptions, type FieldContext } from './parser/fieldContext';
export { readFieldContext, clearFieldContextCache } from './parser/fieldContext';
import {
    globalInputFormatFromKeywordLine,
    keywordInputFormat,
} from './parser/inputFormat';
import {
    classifyParameterKeyword,
    type ParameterDefinitionOptions,
} from './parser/parameterSyntax';
const keywordSpellingAliases = require(keywordDataPath("engineering/keywordSpellingAliases.json"));
const keywordLayoutCorrections = require(keywordDataPath("engineering/keywordLayoutCorrections.json"));
import { resolveNativeFieldCard, nativeFieldsNeedOnlyOrdinal, hasNativeFileReader, nativeFieldDisplayOnly, type NativeFieldIdentity } from './semantics/nativeFieldResolution';
import type { RecordFormat } from './edit/keywordRecordSerializer';
import { nativeFieldDefinitions } from './semantics/nativeFieldDefinitions';

export type KeywordField = {
    definitionSource?: { datasetSha256: string; fieldRecordId: string; alignmentMayOmit: boolean };
    n: string;
    hi?: number;
    di?: 'self' | 'reference';
    p?: number;
    w?: number;
    h?: string;
    t?: string;
    d?: unknown;
    e?: unknown[];
    active?: string;
    nativeIdentity?: NativeFieldIdentity;
    /** Complete fixed source card agrees with the existing schema; operation approval remains separate. */
    nativeStaticBinding?: boolean;
    rawValue?: string;
    nativeHelpField?: KeywordField;
    nativeRange?: { start: number; end: number };
    ref?: {
        targetKinds?: string[];
        label?: string;
        allowSignedSwitch?: boolean;
    };
};

export type KeywordCard = KeywordField[];

export type TextCardMetadata = {
    name: string;
    f: Array<Pick<KeywordField, 'n' | 'p' | 'w' | 't'>>;
};

export type KeywordOption = {
    n: string;
    co: string;
    to?: number;
    c: KeywordCard[];
    active?: string;
};

export type KeywordEntry = {
    c: KeywordCard[];
    r?: number;
    o?: KeywordOption[];
    a?: string[];
    v?: Record<string, { active?: string[] }>;
    x?: string;
    active?: string[];
    tc?: TextCardMetadata[];
};

export type KeywordSchema = Record<string, KeywordEntry>;

export type KeywordLookup = {
    inputName: string;
    canonicalName: string;
    entry: KeywordEntry;
    activeOptions: string[];
};

type PrefixLayoutStep = {
    template: string;
    whenOption?: string;
    whenAnyOptions?: string[];
    recordMarker?: { kind: 'column-one'; value: '&' };
};

type PrefixLayoutPolicy = {
    policyId: string;
    decision: 'allow' | 'deny';
    match: { kind: 'exact' | 'prefix'; value: string };
    options: string[];
    steps: PrefixLayoutStep[];
    evidenceIds: string[];
};

type PrefixLayoutRuntime = {
    schemaVersion: 1;
    kind: 'lsdyna-keyword-prefix-layout-runtime';
    policy: { failClosed: true; diagnosticEligible: false };
    templates: Record<string, KeywordCard>;
    policies: PrefixLayoutPolicy[];
};

export type VerifiedPrefixLayout = {
    status: 'none' | 'verified' | 'unsupported-option' | 'unverified';
    cards: KeywordCard[];
    requiredCardCount: number;
    activePreOptions: string[];
    unsupportedOptions: string[];
    policyIds: string[];
    conditionalMarkerPresent: boolean;
};

export type CardCommentDifference = {
    position: number;
    width: number;
    observed: string;
    expected: string;
};

export type CardCommentNotice = {
    kind: 'definition-mismatch';
    physicalCardIndex: number;
    commentHeaderCardIndex?: number;
    style: 'dollar-hash-fixed' | 'dollar-pipe-fixed' | 'dollar-fixed';
    observedFieldNames: string[];
    expectedFieldNames: string[];
    matchedFieldCount: number;
    differences: CardCommentDifference[];
};

export type KeywordCardInfo = {
    card: KeywordCard;
    cardIndex: number;
    keywordName: string;
    activeOptions: string[];
    isTextCard?: boolean;
    isLeadingOptionCard?: boolean;
    leadingOptionCardCount?: number;
    observedDataLineOrdinal?: number;
    resolutionSource?: 'text-card' | 'leading-option' | 'physical-order' | 'ordinal' | 'native-file-reader';
    nativeCardIndex?: number;
    nativeInstanceStart?: number;
    nativeConditions?: string[];
    inputFormat?: RecordFormat;
    cardCommentNotice?: CardCommentNotice;
    prefixLayoutStatus?: VerifiedPrefixLayout['status'];
    unsupportedPrefixOptions?: string[];
};

type FieldHelpDelta = {
    formatVersion: number;
    baseSha256: string;
    sourceLocalizedSha256: string;
    helpSlotCount: number;
    localizedCount: number;
    values: Array<string | null>;
};

type FieldHelpLocalizationState = {
    state: 'unloaded' | 'loaded' | 'unavailable';
    reason?: string;
    helpSlotCount: number;
    localizedCount: number;
};

type FieldHelpShardManifestEntry = {
    file: string;
    shardIndex: number;
    start: number;
    count: number;
    compressedBytes: number;
    sha256: string;
};

type FieldHelpRuntimeManifest = {
    storageCodec?: 'br';
    formatVersion: number;
    baseSha256: string;
    localizedSourceSha256: string;
    helpSlotCount: number;
    localizedCount: number;
    shardSize: number;
    shardCount: number;
    shards: FieldHelpShardManifestEntry[];
    textIndex?: { file: string; sha256: string; sourceSha256: string };
};

let fieldHelpTextIndex: Record<string, number | string> | null | undefined;
let fieldHelpTextIndexPreparation: Promise<void> | undefined;

type FieldHelpShard = {
    formatVersion: number;
    baseSha256: string;
    shardIndex: number;
    start: number;
    count: number;
    english: string[];
    localized: Array<string | null>;
};

type CachedFieldHelpShard = {
    payload: FieldHelpShard;
    estimatedBytes: number;
};

const FIELD_HELP_DELTA_FORMAT_VERSION = 1;
const FIELD_SCHEMA_RUNTIME_FORMAT_VERSION = 1;
const FIELD_HELP_RUNTIME_FORMAT_VERSION = 1;
const FIELD_SCHEMA_RUNTIME_FILE = 'field_schema.runtime.json.gz';
const FIELD_HELP_RUNTIME_DIRECTORY = 'field_help';
const FIELD_HELP_RUNTIME_MANIFEST_FILE = 'manifest.json';
const FIELD_HELP_RUNTIME_SHARDS_DIRECTORY = 'shards';
const FIELD_HELP_MANIFEST_MAX_BYTES = 512 * 1024;
const FIELD_HELP_SHARD_MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
const FIELD_HELP_SHARD_MAX_DECODED_BYTES = 4 * 1024 * 1024;
const FIELD_HELP_SHARD_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const FIELD_HELP_SHARD_CACHE_MAX_ENTRIES = 8;
const KEYWORD_PREFIX_LAYOUT_RUNTIME_FILE = 'keyword_prefix_layouts.json';

let schemaCache: KeywordSchema | undefined;
let schemaSha256 = '';
let schemaHelpSlotCount = 0;
let fieldHelpManifest: FieldHelpRuntimeManifest | undefined;
let fieldHelpUnavailableReason = '';
let fieldHelpUnavailableWarned = false;
let fieldHelpShardCache = new Map<number, CachedFieldHelpShard>();
let fieldHelpShardCacheBytes = 0;
let fieldHelpIndexCache = new WeakMap<object, number>();
let contactBaseIndexCache = new WeakMap<object, Map<string, string | null>>();
let aliasCanonicalIndexCache = new WeakMap<object, Map<string, string>>();
let prefixLayoutRuntimeCache: PrefixLayoutRuntime | null | undefined;
let localizationState: FieldHelpLocalizationState = {
    state: 'unloaded',
    helpSlotCount: 0,
    localizedCount: 0,
};

function normalizeKeywordName(name: string): string {
    return String(name || '')
        .trim()
        .replace(/^\*/, '')
        .toUpperCase()
        .split(/[\s,$]/)[0]
        .replace(/[+%\-]$/, '');
}

function loadPrefixLayoutRuntime(): PrefixLayoutRuntime | null {
    if (prefixLayoutRuntimeCache !== undefined) return prefixLayoutRuntimeCache;
    try {
        const runtime = JSON.parse(
            fs.readFileSync(path.join(schemaDir(), KEYWORD_PREFIX_LAYOUT_RUNTIME_FILE), 'utf8'),
        );
        if (!runtime || runtime.schemaVersion !== 1 ||
            runtime.kind !== 'lsdyna-keyword-prefix-layout-runtime' ||
            runtime.policy?.failClosed !== true ||
            runtime.policy?.diagnosticEligible !== false ||
            !runtime.templates || typeof runtime.templates !== 'object' ||
            !Array.isArray(runtime.policies)) {
            throw new Error('invalid keyword prefix layout runtime contract');
        }
        prefixLayoutRuntimeCache = runtime as PrefixLayoutRuntime;
    } catch (_error) {
        prefixLayoutRuntimeCache = null;
    }
    return prefixLayoutRuntimeCache;
}

/** Test seam; production callers use the source-locked packaged runtime. */
export function setPrefixLayoutRuntimeForTesting(runtime?: PrefixLayoutRuntime | null): void {
    prefixLayoutRuntimeCache = runtime;
}

/**
 * True when a keyword line requests an input layout that is incompatible with
 * the schema's standard fixed columns.  For example, official *NODE long input
 * uses I20 rather than the standard I8 first field, while `%` selects I10.
 * Callers use this to bail out of column-based cell editing / alignment rather
 * than rewrite the line against the wrong widths.
 *
 * Long format is signalled two ways:
 * - a `+` immediately after the keyword token, e.g. `*NODE+` / `*ELEMENT_SHELL+`;
 * - a `LONG=Y` / `LONG=K` option on `*KEYWORD`, e.g. `*KEYWORD LONG=Y`.
 *
 * `LONG=S` explicitly selects standard input and therefore returns false.
 *
 * @param {string} keywordLineText Raw text of the `*KEYWORD` line.
 * @returns {boolean}
 */
export function isLongFormatKeyword(keywordLineText: string): boolean {
    const raw = String(keywordLineText || '').trim();
    if (!raw.startsWith('*')) return false;
    const token = raw.split(/[\s,]/)[0];
    const normalizedToken = token.replace(/[+%\-]$/, '');
    const mode = /^\*KEYWORD$/i.test(normalizedToken)
        ? globalInputFormatFromKeywordLine(raw)
        : keywordInputFormat(raw);
    return mode !== 'standard';
}

function schemaDir(): string {
    return keywordDataPath("schema");
}

function runtimeDataDir(): string {
    return path.join(__dirname, '..', 'runtime');
}

function sha256(value: string | Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function loadEnglishSchema(): KeywordSchema {
    if (!schemaCache) {
        try {
            const encoded = fs.readFileSync(path.join(runtimeDataDir(), FIELD_SCHEMA_RUNTIME_FILE));
            installSchemaRuntime(zlib.gunzipSync(encoded).toString('utf8'));
        } catch (runtimeError) {
            // Development fallback only. The VSIX content contract requires the
            // compact runtime and excludes the 35 MiB authoring source.
            const text = fs.readFileSync(path.join(schemaDir(), 'field_data.json'), 'utf8');
            const schema = JSON.parse(text);
            if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('invalid field schema source');
            schemaCache = schema;
            schemaSha256 = sha256(Buffer.from(text, 'utf8'));
            schemaHelpSlotCount = visitHelpSlots(schemaCache, (owner, _englishHelp, index) => {
                fieldHelpIndexCache.set(owner, index);
            });
            console.warn(
                `[DynaSense] Compact field schema runtime unavailable; using authoring source: `
                + `${runtimeError instanceof Error ? runtimeError.message : String(runtimeError)}`,
            );
        }
    }
    return schemaCache;
}

function installSchemaRuntime(text: string): void {
    const runtime = JSON.parse(text);
    if (!runtime || runtime.formatVersion !== FIELD_SCHEMA_RUNTIME_FORMAT_VERSION
        || !runtime.schema || typeof runtime.schema !== 'object' || Array.isArray(runtime.schema)
        || !/^[0-9a-f]{64}$/.test(runtime.baseSha256 || '')
        || runtime.keywordCount !== Object.keys(runtime.schema).length
        || !Number.isSafeInteger(runtime.helpSlotCount)
        || runtime.helpSlotCount < 0) {
        throw new Error('invalid compact field schema runtime contract');
    }
    schemaCache = runtime.schema;
    schemaSha256 = runtime.baseSha256;
    schemaHelpSlotCount = runtime.helpSlotCount;
}

function visitHelpSlots(node: unknown, visit: (owner: object, englishHelp: string, index: number) => void): number {
    let index = 0;

    function walk(value: unknown): void {
        if (Array.isArray(value)) {
            value.forEach(walk);
            return;
        }
        if (!value || typeof value !== 'object') {
            return;
        }
        for (const key of Object.keys(value)) {
            const child = (value as Record<string, unknown>)[key];
            if (key === 'h' && typeof child === 'string') {
                visit(value, child, index);
                index++;
            } else if (key === 'hi' && Number.isSafeInteger(child) && Number(child) >= 0) {
                if (Number(child) !== index) {
                    throw new Error(`compact field-help slot ${child} is out of sequence at ${index}`);
                }
                visit(value, '', index);
                index++;
            } else {
                walk(child);
            }
        }
    }

    walk(node);
    return index;
}

function clearFieldHelpShardCache(): void {
    fieldHelpShardCache.clear();
    fieldHelpShardCacheBytes = 0;
}

function markFieldHelpUnavailable(error: unknown): void {
    fieldHelpUnavailableReason = error instanceof Error ? error.message : String(error);
    fieldHelpManifest = undefined;
    clearFieldHelpShardCache();
    localizationState = {
        state: 'unavailable',
        reason: fieldHelpUnavailableReason,
        helpSlotCount: 0,
        localizedCount: 0,
    };
    if (!fieldHelpUnavailableWarned) {
        fieldHelpUnavailableWarned = true;
        console.warn(`[DynaSense] Field-help shard runtime unavailable: ${fieldHelpUnavailableReason}`);
    }
}

function validateFieldHelpManifest(value: unknown): FieldHelpRuntimeManifest {
    const manifest = value as Partial<FieldHelpRuntimeManifest> | null;
    if (!manifest || manifest.formatVersion !== FIELD_HELP_RUNTIME_FORMAT_VERSION
        || (manifest.storageCodec !== undefined && manifest.storageCodec !== 'br')
        || manifest.baseSha256 !== schemaSha256
        || !/^[0-9a-f]{64}$/.test(manifest.localizedSourceSha256 || '')
        || manifest.helpSlotCount !== schemaHelpSlotCount
        || !Number.isSafeInteger(manifest.localizedCount)
        || Number(manifest.localizedCount) < 0
        || Number(manifest.localizedCount) > schemaHelpSlotCount
        || !Number.isSafeInteger(manifest.shardSize)
        || Number(manifest.shardSize) <= 0
        || Number(manifest.shardSize) > 65_536
        || !Array.isArray(manifest.shards)
        || manifest.shardCount !== manifest.shards.length
        || manifest.shardCount !== Math.ceil(schemaHelpSlotCount / Number(manifest.shardSize))) {
        throw new Error('field-help manifest does not match the compact schema');
    }
    const shardSize = Number(manifest.shardSize);
    for (let index = 0; index < manifest.shards.length; index++) {
        const shard = manifest.shards[index];
        const expectedStart = index * shardSize;
        const expectedCount = Math.min(shardSize, schemaHelpSlotCount - expectedStart);
        const expectedFile = `${String(index).padStart(4, '0')}.json.${manifest.storageCodec === 'br' ? 'br' : 'gz'}`;
        if (!shard || shard.file !== expectedFile
            || shard.shardIndex !== index
            || shard.start !== expectedStart
            || shard.count !== expectedCount
            || !Number.isSafeInteger(shard.compressedBytes)
            || shard.compressedBytes <= 0
            || shard.compressedBytes > FIELD_HELP_SHARD_MAX_COMPRESSED_BYTES
            || !/^[0-9a-f]{64}$/.test(shard.sha256 || '')) {
            throw new Error(`field-help manifest shard ${index} is invalid or non-contiguous`);
        }
    }
    return manifest as FieldHelpRuntimeManifest;
}

function loadFieldHelpManifest(): FieldHelpRuntimeManifest | null {
    loadEnglishSchema();
    if (fieldHelpManifest) return fieldHelpManifest;
    if (fieldHelpUnavailableReason) return null;
    try {
        const manifestPath = path.join(
            runtimeDataDir(),
            FIELD_HELP_RUNTIME_DIRECTORY,
            FIELD_HELP_RUNTIME_MANIFEST_FILE,
        );
        const stat = fs.statSync(manifestPath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > FIELD_HELP_MANIFEST_MAX_BYTES) {
            throw new Error(`field-help manifest size ${stat.size} is outside the runtime limit`);
        }
        const text = fs.readFileSync(manifestPath, 'utf8');
        fieldHelpManifest = validateFieldHelpManifest(JSON.parse(text));
        return fieldHelpManifest;
    } catch (error) {
        markFieldHelpUnavailable(error);
        return null;
    }
}

function validateFieldHelpShard(
    value: unknown,
    manifest: FieldHelpRuntimeManifest,
    entry: FieldHelpShardManifestEntry,
): FieldHelpShard {
    const shard = value as Partial<FieldHelpShard> | null;
    if (!shard || shard.formatVersion !== FIELD_HELP_RUNTIME_FORMAT_VERSION
        || shard.baseSha256 !== manifest.baseSha256
        || shard.shardIndex !== entry.shardIndex
        || shard.start !== entry.start
        || shard.count !== entry.count
        || !Array.isArray(shard.english)
        || shard.english.length !== entry.count
        || shard.english.some(value => typeof value !== 'string')
        || !Array.isArray(shard.localized)
        || shard.localized.length !== entry.count
        || shard.localized.some(value => value !== null && (typeof value !== 'string' || value.length === 0))) {
        throw new Error(`field-help shard ${entry.shardIndex} does not match its manifest`);
    }
    return shard as FieldHelpShard;
}

function cacheFieldHelpShard(shardIndex: number, payload: FieldHelpShard, estimatedBytes: number): void {
    if (estimatedBytes > FIELD_HELP_SHARD_CACHE_MAX_BYTES) return;
    while (fieldHelpShardCache.size >= FIELD_HELP_SHARD_CACHE_MAX_ENTRIES
        || fieldHelpShardCacheBytes + estimatedBytes > FIELD_HELP_SHARD_CACHE_MAX_BYTES) {
        const oldest = fieldHelpShardCache.entries().next().value as [number, CachedFieldHelpShard];
        fieldHelpShardCache.delete(oldest[0]);
        fieldHelpShardCacheBytes -= oldest[1].estimatedBytes;
    }
    fieldHelpShardCache.set(shardIndex, { payload, estimatedBytes });
    fieldHelpShardCacheBytes += estimatedBytes;
}

function loadFieldHelpShard(helpIndex: number): FieldHelpShard | null {
    const manifest = loadFieldHelpManifest();
    if (!manifest || !Number.isSafeInteger(helpIndex) || helpIndex < 0 || helpIndex >= manifest.helpSlotCount) {
        return null;
    }
    const shardIndex = Math.floor(helpIndex / manifest.shardSize);
    const cached = fieldHelpShardCache.get(shardIndex);
    if (cached) {
        fieldHelpShardCache.delete(shardIndex);
        fieldHelpShardCache.set(shardIndex, cached);
        return cached.payload;
    }
    const entry = manifest.shards[shardIndex];
    try {
        const shardPath = path.join(
            runtimeDataDir(),
            FIELD_HELP_RUNTIME_DIRECTORY,
            FIELD_HELP_RUNTIME_SHARDS_DIRECTORY,
            entry.file,
        );
        const encoded = fs.readFileSync(shardPath);
        if (!Buffer.isBuffer(encoded)
            || encoded.length !== entry.compressedBytes
            || sha256(encoded) !== entry.sha256) {
            throw new Error(`field-help shard ${shardIndex} failed its compressed identity check`);
        }
        const decoded = (manifest.storageCodec === 'br' ? zlib.brotliDecompressSync : zlib.gunzipSync)(encoded,
            { maxOutputLength: FIELD_HELP_SHARD_MAX_DECODED_BYTES });
        const payload = validateFieldHelpShard(JSON.parse(decoded.toString('utf8')), manifest, entry);
        const estimatedBytes = decoded.length * 2 + entry.count * 16 + 256;
        cacheFieldHelpShard(shardIndex, payload, estimatedBytes);
        return payload;
    } catch (error) {
        markFieldHelpUnavailable(error);
        return null;
    }
}

function fieldHelpIndexFor(field: object): number | null {
    const direct = (field as { hi?: unknown }).hi;
    if (Number.isSafeInteger(direct) && Number(direct) >= 0 && Number(direct) < schemaHelpSlotCount) {
        return Number(direct);
    }
    const fallback = fieldHelpIndexCache.get(field);
    return Number.isSafeInteger(fallback) ? Number(fallback) : null;
}

export function decodeFieldHelpDelta(encoded: Buffer): FieldHelpDelta {
    return JSON.parse(zlib.gunzipSync(encoded).toString('utf8'));
}

export function buildLocalizedHelpCache(
    schema: KeywordSchema,
    baseSha256: string,
    delta: FieldHelpDelta,
): { cache: WeakMap<object, string>; helpSlotCount: number; localizedCount: number } {
    if (!delta || delta.formatVersion !== FIELD_HELP_DELTA_FORMAT_VERSION) {
        throw new Error(`unsupported field-help delta format ${delta?.formatVersion}`);
    }
    if (delta.baseSha256 !== baseSha256) {
        throw new Error('field-help delta base hash does not match field_data.json');
    }
    if (!Array.isArray(delta.values)) {
        throw new Error('field-help delta values must be an array');
    }
    if (!Number.isSafeInteger(delta.helpSlotCount) || delta.helpSlotCount !== delta.values.length) {
        throw new Error('field-help delta slot count does not match its values');
    }
    if (delta.values.some(value => value !== null && (typeof value !== 'string' || value.length === 0))) {
        throw new Error('field-help delta contains an invalid localized value');
    }
    const declaredLocalizedCount = delta.values.reduce(
        (count, value) => count + (value === null ? 0 : 1),
        0,
    );
    if (!Number.isSafeInteger(delta.localizedCount) || delta.localizedCount !== declaredLocalizedCount) {
        throw new Error('field-help delta localized count does not match its values');
    }

    const nextCache = new WeakMap<object, string>();
    const visited = visitHelpSlots(schema, (owner, _englishHelp, index) => {
        const localized = delta.values[index];
        if (typeof localized === 'string') {
            nextCache.set(owner, localized);
        }
    });
    if (visited !== delta.helpSlotCount) {
        throw new Error(`field-help delta has ${delta.helpSlotCount} slots but schema has ${visited}`);
    }
    return {
        cache: nextCache,
        helpSlotCount: visited,
        localizedCount: declaredLocalizedCount,
    };
}

export function resetKeywordSchemaCache(): void {
    fieldHelpTextIndex = undefined;
    fieldHelpTextIndexPreparation = undefined;
    schemaPreparation = undefined;
    schemaCache = undefined;
    clearFieldContextCache();
    schemaSha256 = '';
    schemaHelpSlotCount = 0;
    fieldHelpManifest = undefined;
    fieldHelpUnavailableReason = '';
    fieldHelpUnavailableWarned = false;
    clearFieldHelpShardCache();
    fieldHelpIndexCache = new WeakMap<object, number>();
    contactBaseIndexCache = new WeakMap();
    aliasCanonicalIndexCache = new WeakMap<object, Map<string, string>>();
    localizationState = {
        state: 'unloaded',
        helpSlotCount: 0,
        localizedCount: 0,
    };
}

let schemaPreparation: Promise<void> | undefined;

/** Read and inflate off the event loop; separate parsing from the first field query. */
export function prepareKeywordSchema(): Promise<void> {
    if (!schemaPreparation) {
        schemaPreparation = (async () => {
            try {
                if (!schemaCache) {
                    const encoded = await fs.promises.readFile(path.join(runtimeDataDir(), FIELD_SCHEMA_RUNTIME_FILE));
                    const decoded = await new Promise<Buffer>((resolve, reject) =>
                        zlib.gunzip(encoded, (error, result) => error ? reject(error) : resolve(result)));
                    if (!schemaCache) installSchemaRuntime(decoded.toString('utf8'));
                }
            } catch (error) {
                // The synchronous loader retains the development-source fallback.
                loadEnglishSchema();
            }
            // A timer turn also lets timers/UI work run between schema parsing
            // and the caller's first synchronous native field lookup.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
        })().catch(error => {
            schemaPreparation = undefined;
            throw error;
        });
    }
    return schemaPreparation;
}

export function loadKeywordSchema(_getLanguage: () => string = () => 'en'): KeywordSchema {
    return loadEnglishSchema();
}

export function getEnglishFieldHelp(field: object | null | undefined): string | null {
    if (!field || typeof field !== 'object') return null;
    const direct = (field as { h?: unknown }).h;
    if (typeof direct === 'string') return direct || null;
    loadEnglishSchema();
    const helpIndex = fieldHelpIndexFor(field);
    if (helpIndex === null) return null;
    const shard = loadFieldHelpShard(helpIndex);
    const value = shard?.english[helpIndex - (shard?.start || 0)];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

export function getLocalizedFieldHelp(field: object | null | undefined): string | null {
    if (!field || typeof field !== 'object') {
        return null;
    }
    loadEnglishSchema();
    const direct = (field as { h?: unknown }).h;
    const helpIndex = fieldHelpIndexFor(field);
    if (helpIndex === null) return typeof direct === 'string' ? getLocalizedHelpForText(direct) : null;
    const shard = loadFieldHelpShard(helpIndex);
    if (!shard) return null;
    // A runtime override may retain the schema slot. Its old translation is not
    // evidence for changed English (notably PARAMETER manual descriptions).
    if (typeof direct === 'string' && direct !== shard.english[helpIndex - shard.start]) {
        return getLocalizedHelpForText(direct);
    }
    const manifest = fieldHelpManifest;
    if (manifest) {
        localizationState = {
            state: 'loaded',
            helpSlotCount: manifest.helpSlotCount,
            localizedCount: manifest.localizedCount,
        };
    }
    const value = shard.localized[helpIndex - shard.start];
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function fieldHelpTextIndexPath(manifest: FieldHelpRuntimeManifest): string {
    const descriptor = manifest.textIndex!;
    if (descriptor.file !== `text-index.json.${manifest.storageCodec === 'br' ? 'br' : 'gz'}`) throw new Error('Invalid help text index path');
    return path.join(runtimeDataDir(), FIELD_HELP_RUNTIME_DIRECTORY, descriptor.file);
}

function loadFieldHelpTextIndex(manifest: FieldHelpRuntimeManifest, prepared?: { encoded: Buffer; decoded: Buffer }): void {
    if (fieldHelpTextIndex === undefined) {
        fieldHelpTextIndex = null;
        try {
            const descriptor = manifest.textIndex!;
            const encoded = prepared?.encoded || fs.readFileSync(fieldHelpTextIndexPath(manifest));
            if (crypto.createHash('sha256').update(encoded).digest('hex') !== descriptor.sha256) {
                throw new Error('Help text index hash mismatch');
            }
            const decoded = prepared?.decoded || (manifest.storageCodec === 'br' ? zlib.brotliDecompressSync : zlib.gunzipSync)(encoded,
                { maxOutputLength: 16 * 1024 * 1024 });
            fieldHelpTextIndex = JSON.parse(decoded.toString('utf8'));
        } catch (error) {
            console.warn(`[DynaSense] Help text translations unavailable: ${error}`);
        }
    }
}

/** Prepare the shared translation index before the first synchronous manager model. */
export async function prepareFieldHelpTextIndex(): Promise<void> {
    const manifest = loadFieldHelpManifest();
    if (!manifest?.textIndex || fieldHelpTextIndex !== undefined) return;
    if (!fieldHelpTextIndexPreparation) {
        fieldHelpTextIndexPreparation = (async () => {
            try {
                const encoded = await fs.promises.readFile(fieldHelpTextIndexPath(manifest));
                if (sha256(encoded) !== manifest.textIndex!.sha256) throw new Error('Help text index hash mismatch');
                const decoded = await new Promise<Buffer>((resolve, reject) => {
                    const callback = (error: Error | null, value: Buffer) => error ? reject(error) : resolve(value);
                    const options = { maxOutputLength: 16 * 1024 * 1024 };
                    if (manifest.storageCodec === 'br') zlib.brotliDecompress(encoded, options, callback);
                    else zlib.gunzip(encoded, options, callback);
                });
                if (fieldHelpManifest === manifest) loadFieldHelpTextIndex(manifest, { encoded, decoded });
            } catch (error) {
                if (fieldHelpManifest === manifest && fieldHelpTextIndex === undefined) {
                    fieldHelpTextIndex = null;
                    console.warn(`[DynaSense] Help text translations unavailable: ${error}`);
                }
            }
        })();
    }
    await fieldHelpTextIndexPreparation;
}

/** Reuse only complete source text, allowing layout whitespace differences. */
export function getLocalizedHelpForText(english: string): string | null {
    if (!english?.trim()) return null;
    const manifest = loadFieldHelpManifest();
    if (!manifest?.textIndex) return null;
    loadFieldHelpTextIndex(manifest);
    const normalized = english.trim().replace(/\s+/gu, ' ');
    const key = crypto.createHash('sha256').update(normalized).digest('hex');
    const value = fieldHelpTextIndex?.[key];
    if (typeof value === 'string') return value || null;
    if (!Number.isSafeInteger(value)) return null;
    const shard = loadFieldHelpShard(Number(value));
    const index = Number(value) - (shard?.start || 0);
    return shard?.english[index]?.trim().replace(/\s+/gu, ' ') === normalized
        ? shard.localized[index] || null : null;
}

export function getFieldHelpLocalizationState(): FieldHelpLocalizationState {
    return { ...localizationState };
}

function optionName(option: KeywordOption): string {
    return normalizeKeywordName(option.n);
}

function titleOptions(entry: KeywordEntry): KeywordOption[] {
    return (entry.o || []).filter(option => (option.to || 0) > 0);
}

function splitOptionName(name: string): string[] {
    return normalizeKeywordName(name).split('_').filter(Boolean);
}

function inferActiveOptionsFromSuffix(entry: KeywordEntry, suffix: string): string[] | null {
    const suffixTokens = splitOptionName(suffix);
    if (suffixTokens.length === 0) {
        return [];
    }

    const options = titleOptions(entry).slice().sort((a, b) => splitOptionName(b.n).length - splitOptionName(a.n).length);
    const active: string[] = [];
    let cursor = 0;

    while (cursor < suffixTokens.length) {
        const match = options.find(option => {
            const candidate = splitOptionName(option.n);
            return candidate.length > 0 && candidate.every((token, index) => suffixTokens[cursor + index] === token);
        });
        if (!match || active.includes(optionName(match))) {
            return null;
        }
        active.push(optionName(match));
        cursor += splitOptionName(match.n).length;
    }

    return active;
}

export const STANDARD_NUMBERED_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    MAT_041: 'MAT_USER_DEFINED_MATERIAL_MODELS',
    MAT_042: 'MAT_USER_DEFINED_MATERIAL_MODELS',
    MAT_043: 'MAT_USER_DEFINED_MATERIAL_MODELS',
    MAT_044: 'MAT_USER_DEFINED_MATERIAL_MODELS',
    MAT_045: 'MAT_USER_DEFINED_MATERIAL_MODELS',
    MAT_046: 'MAT_USER_DEFINED_MATERIAL_MODELS',
    MAT_047: 'MAT_USER_DEFINED_MATERIAL_MODELS',
    MAT_048: 'MAT_USER_DEFINED_MATERIAL_MODELS',
    MAT_049: 'MAT_USER_DEFINED_MATERIAL_MODELS',
    MAT_050: 'MAT_USER_DEFINED_MATERIAL_MODELS',
    MAT_054: 'MAT_ENHANCED_COMPOSITE_DAMAGE',
    MAT_055: 'MAT_ENHANCED_COMPOSITE_DAMAGE',
    MAT_084_REINF: 'MAT_WINFRITH_CONCRETE_REINFORCEMENT',
    MAT_122_3D: 'MAT_HILL_3R_3D',
    MAT_122_TABULATED: 'MAT_HILL_3R_TABULATED',
    MAT_135_PLC: 'MAT_WTM_STM_PLC',
    MAT_160: 'MAT_ALE_INCOMPRESSIBLE',
    MAT_230_FLUID: 'MAT_PML_ELASTIC_FLUID',
    MAT_BILKHU: 'MAT_075',
    MAT_BILKHU_DUBOIS_FOAM: 'MAT_075',
    MAT_CONSTRAINED: 'MAT_265',
    EOS_022: 'EOS_USER_DEFINED',
    EOS_023: 'EOS_USER_DEFINED',
    EOS_024: 'EOS_USER_DEFINED',
    EOS_025: 'EOS_USER_DEFINED',
    EOS_026: 'EOS_USER_DEFINED',
    EOS_027: 'EOS_USER_DEFINED',
    EOS_028: 'EOS_USER_DEFINED',
    EOS_029: 'EOS_USER_DEFINED',
    EOS_030: 'EOS_USER_DEFINED',
    EOS_042: 'EOS_USER_LIBRARY',
});

function findAliasCanonical(name: string, schema: KeywordSchema): string | null {
    let index = aliasCanonicalIndexCache.get(schema);
    if (!index) {
        index = new Map();
        // Preserve schema objects/help slots while accepting case-insensitive
        // input. Ambiguous folded keys must not select an arbitrary definition.
        for (const keyword of Object.keys(schema)) {
            const normalized = normalizeKeywordName(keyword);
            if (normalized !== keyword.toUpperCase()) continue; // Descriptive annotations are not spellings.
            index.set(normalized, index.has(normalized) ? '' : keyword);
        }
        for (const [keyword, entry] of Object.entries(schema)) {
            for (const alias of entry.a || []) {
                const normalizedAlias = normalizeKeywordName(alias);
                if (normalizedAlias && !index.has(normalizedAlias)) {
                    index.set(normalizedAlias, keyword);
                }
            }
        }
        for (const [alias, canonical] of Object.entries(STANDARD_NUMBERED_ALIASES)) {
            const normalizedAlias = normalizeKeywordName(alias);
            const normalizedCanonical = normalizeKeywordName(canonical);
            if (normalizedAlias && normalizedCanonical && schema[normalizedCanonical] && !index.has(normalizedAlias)) {
                index.set(normalizedAlias, normalizedCanonical);
            }
        }
        for (const item of keywordSpellingAliases.aliases || []) {
            const alias = normalizeKeywordName(item.manualKeyword);
            const canonical = normalizeKeywordName(item.schemaKeyword);
            const entry = schema[canonical];
            const expectedCard = item.card || [];
            const actualCard = entry?.c?.[item.cardIndex - 1];
            const layoutMatches = Array.isArray(actualCard) &&
                actualCard.length === expectedCard.length &&
                actualCard.every((field, fieldIndex) => {
                    const expected = expectedCard[fieldIndex];
                    return normalizeFieldLabel(field.n) === normalizeFieldLabel(expected.name) &&
                        String(field.t || '').toLowerCase() === String(expected.type || '').toLowerCase() &&
                        field.p === expected.position && field.w === expected.width;
                });
            if (alias && canonical && layoutMatches && !index.has(alias)) {
                index.set(alias, canonical);
            }
        }
        aliasCanonicalIndexCache.set(schema, index);
    }
    return index.get(name) || null;
}

function cardMatchesLockedShape(card: KeywordCard | undefined, expected: Array<{
    name: string; type: string; position: number; width: number;
}>): boolean {
    return Array.isArray(card) && card.length === expected.length && card.every((field, index) => {
        const target = expected[index];
        return normalizeFieldLabel(field.n) === normalizeFieldLabel(target.name) &&
            String(field.t || '').toLowerCase() === String(target.type || '').toLowerCase() &&
            field.p === target.position && field.w === target.width;
    });
}

function applySourceLockedLayoutCorrection(
    canonicalName: string,
    entry: KeywordEntry,
): KeywordEntry | null {
    const correction = (keywordLayoutCorrections.corrections || []).find(item =>
        normalizeKeywordName(item.keyword) === canonicalName
    );
    if (!correction) return entry;
    const cardOffset = correction.cardIndex - 1;
    const sourceCard = entry.c?.[cardOffset];
    if (!cardMatchesLockedShape(sourceCard, correction.sourceCard) ||
        correction.officialCard.length !== correction.sourceCard.length) {
        return null;
    }
    const correctedCard = sourceCard.map((field, index) => ({
        ...field,
        p: correction.officialCard[index].position,
        w: correction.officialCard[index].width,
    }));
    if (!cardMatchesLockedShape(correctedCard, correction.officialCard)) return null;
    return {
        ...entry,
        c: entry.c.map((card, index) => index === cardOffset ? correctedCard : card),
    };
}

function makeLookup(inputName: string, matchedName: string, schema: KeywordSchema,
    activeOptions: string[] = []): KeywordLookup | null {
    let canonicalName = matchedName;
    let canonicalEntry = schema[canonicalName];
    const visited = new Set<string>();
    const active = new Set<string>();
    while (canonicalEntry) {
        if (visited.has(canonicalName)) return null;
        visited.add(canonicalName);
        for (const option of canonicalEntry.active || []) active.add(normalizeKeywordName(option));
        if (!canonicalEntry.x) break;
        const targetName = normalizeKeywordName(canonicalEntry.x);
        const nextName = schema[targetName] ? targetName : findAliasCanonical(targetName, schema);
        if (!nextName) return null;
        canonicalName = nextName;
        canonicalEntry = schema[canonicalName];
    }
    if (!canonicalEntry) return null;
    const correctedEntry = applySourceLockedLayoutCorrection(canonicalName, canonicalEntry);
    if (!correctedEntry) return null;
    for (const option of activeOptions) active.add(normalizeKeywordName(option));

    return {
        inputName,
        canonicalName,
        entry: correctedEntry,
        activeOptions: [...active],
    };
}

const PARAMETER_OPTION_ENTRIES: KeywordOption[] = [
    { n: 'LOCAL', co: 'title/1', to: 1, c: [] },
    { n: 'MUTABLE', co: 'title/2', to: 2, c: [] },
    { n: 'NOECHO', co: 'title/3', to: 3, c: [] },
];

const PARAMETER_MANUAL_HELP: Record<string, Record<string, string>> = {
    PARAMETER: {
        PRMR: 'The first character selects R (real), I (integer), or C (character). The remaining parameter name is 1-9 letters, digits, or underscores; its first character cannot be a digit. TIME (case-insensitive) and names reserved in Appendix U are not allowed.',
        VAL: 'Defines a real number, integer, or character string consistent with the type selected in PRMR.',
    },
    PARAMETER_EXPRESSION: {
        PRMR: 'The first character selects R (real), I (integer), or C (character). The remaining parameter name is 1-9 letters, digits, or underscores; its first character cannot be a digit. TIME (case-insensitive) and names reserved in Appendix U are not allowed.',
        EXPRESSION: 'General algebraic expression stored in PRMR. Previously defined parameters may be referenced with or without a leading &. Continue an expression by leaving the first 10 columns of the next line blank (20 columns in long format). Character expressions are stored as strings.',
    },
    PARAMETER_TYPE: {
        PRMR: 'Defines an integer parameter. The first character must be I; the remaining parameter name is 1-9 letters, digits, or underscores and cannot start with a digit.',
        VAL: 'Integer value assigned to the parameter.',
        PRTYP: 'LS-PrePost usage metadata describing the ID represented by VAL. LS-DYNA ignores PRTYP; it is used when LS-PrePost combines keyword decks and applies ID offsets.',
    },
};

function parameterFieldHelp(canonicalName: string, fieldName: string): string | null {
    const family = PARAMETER_MANUAL_HELP[canonicalName];
    if (!family) return null;
    const normalizedField = normalizeFieldLabel(fieldName).replace(/[1-4]$/, '');
    return family[normalizedField] || null;
}

function manualAuthoritativeParameterEntry(
    canonicalName: string,
    source: KeywordEntry,
    supportsOptions: boolean,
): KeywordEntry {
    return {
        ...source,
        c: (source.c || []).map(card => card.map(field => ({
            ...field,
            h: parameterFieldHelp(canonicalName, field.n) || getEnglishFieldHelp(field) || undefined,
        }))),
        ...(supportsOptions ? { o: PARAMETER_OPTION_ENTRIES } : {}),
    };
}

function lookupParameterFamily(inputName: string, schema: KeywordSchema): KeywordLookup | null {
    const classification = classifyParameterKeyword(`*${inputName}`);
    if (!classification || classification.kind === 'scope-control') return null;
    let canonicalName: string;
    if (classification.kind === 'duplication') {
        canonicalName = 'PARAMETER_DUPLICATION';
    } else if (classification.kind === 'parameter-type') {
        canonicalName = 'PARAMETER_TYPE';
    } else {
        canonicalName = classification.expression ? 'PARAMETER_EXPRESSION' : 'PARAMETER';
    }
    const source = schema[canonicalName];
    if (!source) return null;
    const activeOptions = classification.kind === 'definition'
        ? ['LOCAL', 'MUTABLE', 'NOECHO'].filter(option =>
            classification.options[option.toLowerCase() as keyof ParameterDefinitionOptions]
        )
        : [];
    return {
        inputName,
        canonicalName,
        entry: manualAuthoritativeParameterEntry(
            canonicalName,
            source,
            classification.kind === 'definition',
        ),
        activeOptions,
    };
}

function lookupContactOptions(inputName: string, schema: KeywordSchema): KeywordLookup | null {
    const parts = contactKeywordParts(inputName);
    if (!parts) return null;
    const options = parts.options.filter(option => option === 'ID' || option === 'MPP');
    const base = [parts.type, ...parts.options.filter(option => option !== 'ID' && option !== 'MPP')].join('_');
    let index = contactBaseIndexCache.get(schema);
    if (!index) {
        index = new Map();
        for (const [name, entry] of Object.entries(schema)) {
            if (entry.x) continue;
            const key = contactKeywordKey(name);
            if (key) index.set(key, index.has(key) ? null : name);
        }
        contactBaseIndexCache.set(schema, index);
    }
    const canonical = index.get(contactKeywordKey(base) || '');
    if (!canonical || inferActiveOptionsFromSuffix(schema[canonical], options.join('_')) === null) return null;
    return makeLookup(inputName, canonical, schema, options);
}

export function lookupKeywordSchema(name: string, schema: KeywordSchema = loadKeywordSchema()): KeywordLookup | null {
    const inputName = normalizeKeywordName(name);
    if (!inputName || inputName.endsWith('_') || inputName.includes('__')) {
        return null;
    }

    const parameterLookup = lookupParameterFamily(inputName, schema);
    if (parameterLookup) return parameterLookup;

    if (schema[inputName]) {
        return makeLookup(inputName, inputName, schema);
    }

    const aliasCanonical = findAliasCanonical(inputName, schema);
    if (aliasCanonical && schema[aliasCanonical]) {
        return makeLookup(inputName, aliasCanonical, schema);
    }

    const tokens = inputName.split('_');
    for (let length = tokens.length - 1; length >= 1; length--) {
        const candidate = tokens.slice(0, length).join('_');
        const foldedCandidate = schema[candidate] ? candidate : findAliasCanonical(candidate, schema);
        const baseLookup = foldedCandidate ? makeLookup(candidate, foldedCandidate, schema) : null;
        if (!baseLookup) {
            continue;
        }

        const suffix = tokens.slice(length).join('_');
        // Only accept a prefix match when the entire leftover suffix maps to known
        // title/options (e.g. _ID, _MPP, _TITLE); never accept an unknown remainder.
        const activeOptions = inferActiveOptionsFromSuffix(schema[foldedCandidate], suffix)
            ?? inferActiveOptionsFromSuffix(baseLookup.entry, suffix);
        if (activeOptions === null || activeOptions.some(option => baseLookup.activeOptions.includes(option))) {
            continue;
        }
        return makeLookup(inputName, foldedCandidate, schema, activeOptions);
    }

    return lookupContactOptions(inputName, schema);
}

function parseCardOrder(cardOrder: string): { position: string; index: number } {
    const [position, rawIndex] = String(cardOrder || '').split('/');
    const index = Number.parseInt(rawIndex, 10);
    return {
        position,
        index: Number.isFinite(index) ? index : 0,
    };
}

function prefixPolicyMatches(policy: PrefixLayoutPolicy, canonicalName: string): boolean {
    const keyword = normalizeKeywordName(canonicalName);
    const value = normalizeKeywordName(policy.match?.value || '');
    return policy.match?.kind === 'exact'
        ? keyword === value
        : policy.match?.kind === 'prefix' && keyword.startsWith(value);
}

function prefixPolicySpecificity(policy: PrefixLayoutPolicy): [number, number] {
    return [policy.match.kind === 'exact' ? 2 : 1, policy.match.value.length];
}

function compareSpecificity(left: [number, number], right: [number, number]): number {
    return left[0] - right[0] || left[1] - right[1];
}

function prefixPolicyForOption(canonicalName: string, optionName: string): PrefixLayoutPolicy | null {
    const runtime = loadPrefixLayoutRuntime();
    if (!runtime) return null;
    const normalizedOption = normalizeKeywordName(optionName);
    const matches = runtime.policies.filter(policy =>
        policy.options.map(normalizeKeywordName).includes(normalizedOption) &&
        prefixPolicyMatches(policy, canonicalName),
    );
    if (!matches.length) return null;
    let best = prefixPolicySpecificity(matches[0]);
    for (const policy of matches.slice(1)) {
        const candidate = prefixPolicySpecificity(policy);
        if (compareSpecificity(candidate, best) > 0) best = candidate;
    }
    const finalists = matches.filter(policy =>
        compareSpecificity(prefixPolicySpecificity(policy), best) === 0,
    );
    return finalists.length === 1 ? finalists[0] : null;
}

export function keywordPrefixOptionDecision(
    canonicalName: string,
    optionName: string,
): 'allow' | 'deny' | 'unverified' {
    return prefixPolicyForOption(canonicalName, optionName)?.decision || 'unverified';
}

function activePreOptionNames(lookup: KeywordLookup): string[] {
    const selected = new Set(lookup.activeOptions.map(normalizeKeywordName));
    return (lookup.entry.o || [])
        .filter(option => parseCardOrder(option.co).position === 'pre')
        .map(option => normalizeKeywordName(option.n))
        .filter((name, index, names) => selected.has(name) && names.indexOf(name) === index);
}

function stepIsActive(step: PrefixLayoutStep, activeOptions: Set<string>): boolean {
    if (step.whenOption) return activeOptions.has(normalizeKeywordName(step.whenOption));
    return (step.whenAnyOptions || []).some(option => activeOptions.has(normalizeKeywordName(option)));
}

function clonePrefixCard(card: KeywordCard): KeywordCard {
    return card.map(field => ({ ...field }));
}

/** Source-locked steps, including optional markers, for an explicitly planned layout. */
export function getVerifiedPrefixLayoutSteps(canonicalName: string, options: string[]) {
    const runtime = loadPrefixLayoutRuntime();
    const active = new Set(options.map(normalizeKeywordName));
    const policies = [...new Set(options.map(option => prefixPolicyForOption(canonicalName, option)))];
    if (!runtime || policies.some(policy => !policy || policy.decision !== 'allow')) return null;
    const steps = policies.flatMap(policy => policy!.steps.filter(step => stepIsActive(step, active))
        .map(step => ({ ...step, policyId: policy!.policyId, evidenceIds: [...policy!.evidenceIds],
            card: runtime.templates[step.template] })));
    if (steps.some(step => !Array.isArray(step.card) || !step.card.length)) return null;
    return steps.map(step => ({ ...step, recordMarker: step.recordMarker ? { ...step.recordMarker } : undefined,
        card: clonePrefixCard(step.card) }));
}

function enrichVerifiedPrefixCards(
    lookup: KeywordLookup,
    cards: KeywordCard[],
): KeywordCard[] {
    const selected = new Set(lookup.activeOptions.map(normalizeKeywordName));
    const legacyFields = (lookup.entry.o || [])
        .filter(option => selected.has(optionName(option)))
        .filter(option => parseCardOrder(option.co).position === 'pre')
        .flatMap(option => option.c || [])
        .flatMap(card => card || []);
    return cards.map(card => card.map(field => {
        const matches = legacyFields.filter(candidate =>
            normalizeFieldLabel(candidate.n) === normalizeFieldLabel(field.n)
            && Number(candidate.p) === Number(field.p)
            && Number(candidate.w) === Number(field.w),
        );
        if (matches.length !== 1) return field;
        const source = matches[0];
        return {
            ...field,
            ...(source.h !== undefined ? { h: source.h } : {}),
            ...(source.hi !== undefined ? { hi: source.hi } : {}),
            ...(source.d !== undefined ? { d: source.d } : {}),
            ...(source.e !== undefined ? { e: source.e } : {}),
            ...(source.di !== undefined ? { di: source.di } : {}),
            ...(source.ref !== undefined ? { ref: { ...source.ref } } : {}),
            ...(source.active !== undefined ? { active: source.active } : {}),
        };
    }));
}

/**
 * Resolve only layouts whose physical order is source-locked to the official
 * manual. Optional CONTACT MPP2 is present solely when its physical record has
 * `&` in column one; no comment header or schema default may synthesize it.
 */
export function getVerifiedPrefixLayout(
    lookup: KeywordLookup,
    observedDataLines: string[] = [],
): VerifiedPrefixLayout {
    const activePreOptions = activePreOptionNames(lookup);
    const activeSet = new Set(lookup.activeOptions.map(normalizeKeywordName));
    const unverifiedNonPrefixOptions = (lookup.entry.o || [])
        .filter(option => activeSet.has(optionName(option)))
        .filter(option => (option.to || 0) > 0 && (option.c || []).length > 0)
        .filter(option => parseCardOrder(option.co).position !== 'pre')
        .map(optionName);
    if (unverifiedNonPrefixOptions.length) {
        return {
            status: 'unverified', cards: [], requiredCardCount: 0,
            activePreOptions: [...activePreOptions, ...unverifiedNonPrefixOptions],
            unsupportedOptions: [], policyIds: [], conditionalMarkerPresent: false,
        };
    }
    if (!activePreOptions.length) {
        return {
            status: 'none', cards: [], requiredCardCount: 0,
            activePreOptions, unsupportedOptions: [], policyIds: [],
            conditionalMarkerPresent: false,
        };
    }
    const runtime = loadPrefixLayoutRuntime();
    if (!runtime) {
        return {
            status: 'unverified', cards: [], requiredCardCount: 0,
            activePreOptions, unsupportedOptions: [], policyIds: [],
            conditionalMarkerPresent: false,
        };
    }
    const policies: PrefixLayoutPolicy[] = [];
    const unsupportedOptions: string[] = [];
    for (const option of activePreOptions) {
        const policy = prefixPolicyForOption(lookup.canonicalName, option);
        if (!policy) {
            return {
                status: 'unverified', cards: [], requiredCardCount: 0,
                activePreOptions, unsupportedOptions: [], policyIds: [],
                conditionalMarkerPresent: false,
            };
        }
        if (policy.decision === 'deny') unsupportedOptions.push(option);
        if (!policies.some(candidate => candidate.policyId === policy.policyId)) policies.push(policy);
    }
    if (unsupportedOptions.length) {
        return {
            status: 'unsupported-option', cards: [], requiredCardCount: 0,
            activePreOptions, unsupportedOptions,
            policyIds: policies.map(policy => policy.policyId),
            conditionalMarkerPresent: false,
        };
    }

    const activePrefixSet = new Set(activePreOptions);
    const cards: KeywordCard[] = [];
    let requiredCardCount = 0;
    let conditionalMarkerPresent = false;
    for (const policy of policies) {
        for (const step of policy.steps) {
            if (!stepIsActive(step, activePrefixSet)) continue;
            const template = runtime.templates[step.template];
            if (!Array.isArray(template) || !template.length) {
                return {
                    status: 'unverified', cards: [], requiredCardCount: 0,
                    activePreOptions, unsupportedOptions: [], policyIds: [],
                    conditionalMarkerPresent: false,
                };
            }
            if (step.recordMarker) {
                const candidate = String(observedDataLines[cards.length] || '');
                if (!candidate.startsWith(step.recordMarker.value)) continue;
                conditionalMarkerPresent = true;
            } else {
                requiredCardCount++;
            }
            cards.push(clonePrefixCard(template));
        }
    }
    return {
        status: 'verified', cards: enrichVerifiedPrefixCards(lookup, cards), requiredCardCount,
        activePreOptions, unsupportedOptions: [],
        policyIds: policies.map(policy => policy.policyId),
        conditionalMarkerPresent,
    };
}

function renderSelectedOptions(
    baseCards: KeywordCard[],
    options: KeywordOption[],
    verifiedPrefixCards?: KeywordCard[],
): KeywordCard[] {
    const pre: Array<{ index: number; option: KeywordOption }> = [];
    const main: Array<{ index: number; option: KeywordOption }> = [];
    const post: Array<{ index: number; option: KeywordOption }> = [];

    for (const option of options) {
        const order = parseCardOrder(option.co);
        const item = { index: order.index, option };
        if (order.position === 'pre') {
            pre.push(item);
        } else if (order.position === 'main') {
            main.push(item);
        } else {
            post.push(item);
        }
    }

    const rendered: KeywordCard[] = [];
    if (verifiedPrefixCards !== undefined) {
        rendered.push(...verifiedPrefixCards);
    } else {
        // `pre/N` is a title-token position, not a physical-card ordinal.
        // CONTACT, for example, declares ID as pre/2 and MPP as pre/1 while
        // the official reader order is ID then MPP. Keep this legacy fallback
        // consistent; source-locked callers use verifiedPrefixCards above.
        pre.sort((a, b) => b.index - a.index).forEach(item => rendered.push(...item.option.c));
    }
    rendered.push(...baseCards);

    let inserted = 0;
    main.sort((a, b) => a.index - b.index).forEach(item => {
        const insertAt = Math.max(0, Math.min(rendered.length, item.index + 1 + inserted));
        rendered.splice(insertAt, 0, ...item.option.c);
        inserted += item.option.c.length;
    });

    post.sort((a, b) => a.index - b.index).forEach(item => rendered.push(...item.option.c));
    return rendered;
}

/**
 * Compatibility name retained for callers/tests created by the original MAT
 * TITLE fix. The result now covers every source-locked leading option layout.
 */
export function getLeadingMaterialTitleCardCount(lookup: KeywordLookup): number {
    const layout = getVerifiedPrefixLayout(lookup);
    return layout.status === 'verified' ? layout.cards.length : 0;
}

function postOptions(entry: KeywordEntry, selectedNames: Set<string>): KeywordOption[] {
    return (entry.o || [])
        .filter(option => !selectedNames.has(optionName(option)))
        .filter(option => parseCardOrder(option.co).position === 'post')
        .sort((a, b) => parseCardOrder(a.co).index - parseCardOrder(b.co).index);
}

function normalizeFieldLabel(value: string): string {
    return normalizeKeywordName(value).replace(/^_/, '');
}

type CardCommentStyle = CardCommentNotice['style'];

type CardHeaderCardAnalysis = {
    card: KeywordCard;
    cardIndex: number;
    style: CardCommentStyle;
    observedFieldNames: string[];
    expectedFieldNames: string[];
    matches: number;
    anchorMatches: number;
    observedCount: number;
    expectedCount: number;
    differences: CardCommentDifference[];
    exactMatch: boolean;
    possibleVersionDrift: boolean;
};

export type CardCommentHeaderMatch = {
    card: KeywordCard;
    cardIndex: number;
    style: CardCommentStyle;
    exactMatch: boolean;
    possibleVersionDrift: boolean;
    matchedFieldCount: number;
    differences: CardCommentDifference[];
};

const NON_ANCHOR_HEADER_LABELS = new Set(['UNUSED', 'BLANK', 'N/A', 'NA', 'NONE']);

// CONTACT naming compatibility: https://github.com/ansys/pydyna/issues/698
// Shared by comment recognition and keyword-scoped field-help matching.
export const CONTACT_FIELD_LABEL_SYNONYMS: Readonly<Record<string, string>> = {
    SSID: 'SURFA', MSID: 'SURFB', SSTYP: 'SURFATYP', STYP: 'SURFATYP',
    MSTYP: 'SURFBTYP', MSTYPE: 'SURFBTYP', SBOXID: 'SABOXID', MBOXID: 'SBBOXID',
    SPR: 'SAPR', MPR: 'SBPR', SFS: 'SFSA', SFM: 'SFSB', SST: 'SAST', MST: 'SBST',
    SFST: 'SFSAT', SFMT: 'SFSBT',
};
const FIELD_LABEL_SYNONYMS: Record<string, string> = {
    CID: 'ID', NAME: 'TITLE', RHO: 'RO', ...CONTACT_FIELD_LABEL_SYNONYMS,
};

export function canonicalCommentFieldLabel(label: string): string {
    const normalized = normalizeFieldLabel(label);
    return FIELD_LABEL_SYNONYMS[normalized] || normalized;
}

function cardCommentStyle(lineText: string): CardCommentStyle | null {
    const trimmed = String(lineText || '').trimStart();
    if (!trimmed.startsWith('$')) return null;
    if ((trimmed.match(/\|/g) || []).length >= 2) return 'dollar-pipe-fixed';
    return trimmed.startsWith('$#') ? 'dollar-hash-fixed' : 'dollar-fixed';
}

function normalizeCommentSlot(raw: string, firstField: boolean): string {
    let value = String(raw || '');
    if (firstField) value = value.replace(/^\s*\$[\s#]?/, '');
    value = value.replace(/\|/g, ' ').trim().replace(/[:;]+$/, '').trim();
    if (!value || /^[-=_]+$/.test(value)) return '';
    const tokens = value.split(/\s+/).filter(Boolean);
    if (tokens.length !== 1) return '';
    const normalized = normalizeFieldLabel(tokens[0]);
    return /^[A-Z0-9&][A-Z0-9_./+&-]*$/.test(normalized) ? normalized : '';
}

function analyzeHeaderForCard(
    lineText: string,
    card: KeywordCard,
    cardIndex: number,
): CardHeaderCardAnalysis | null {
    const style = cardCommentStyle(lineText);
    if (!style || card.length === 0) return null;

    const expectedFieldNames: string[] = [];
    const observedFieldNames: string[] = [];
    const differences: CardCommentDifference[] = [];
    let matches = 0;
    let anchorMatches = 0;
    let observedCount = 0;
    let expectedCount = 0;

    for (const field of card) {
        const position = Number(field.p);
        const width = Number(field.w);
        if (!Number.isInteger(position) || !Number.isInteger(width) || width < 1) continue;
        const expected = normalizeFieldLabel(field.n);
        const observed = normalizeCommentSlot(
            String(lineText || '').slice(position, position + width),
            position === 0,
        );
        expectedFieldNames.push(expected);
        if (expected && !NON_ANCHOR_HEADER_LABELS.has(expected)) expectedCount++;
        if (!observed) continue;
        observedCount++;
        observedFieldNames.push(observed);
        const isMatch = observed === expected ||
            (!!observed && !!expected && canonicalCommentFieldLabel(observed) === canonicalCommentFieldLabel(expected));
        if (isMatch) {
            matches++;
            if (!NON_ANCHOR_HEADER_LABELS.has(expected)) anchorMatches++;
        } else {
            differences.push({ position, width, observed, expected });
        }
    }

    const minimumMatches = expectedCount <= 1 ? 1 : 2;
    const expectedCoverage = expectedCount > 0 ? matches / expectedCount : 0;
    const observedAgreement = observedCount > 0 ? matches / observedCount : 0;
    const exactMatch = differences.length === 0
        && matches >= minimumMatches
        && expectedCoverage >= 0.5;
    const possibleVersionDrift = differences.length >= 1
        && differences.length <= 3
        && matches >= Math.max(2, minimumMatches)
        && anchorMatches >= 2
        && expectedCoverage >= 0.5
        && observedAgreement >= 0.6;

    if (!exactMatch && !possibleVersionDrift) {
        // `$` prose, preprocessor metadata and low-coverage headers remain unknown.
        return {
            card, cardIndex, style, observedFieldNames, expectedFieldNames,
            matches, anchorMatches, observedCount, expectedCount, differences,
            exactMatch: false, possibleVersionDrift: false,
        };
    }
    return {
        card, cardIndex, style, observedFieldNames, expectedFieldNames,
        matches, anchorMatches, observedCount, expectedCount, differences,
        exactMatch, possibleVersionDrift,
    };
}

function renderHeaderCandidateCards(
    entry: KeywordEntry,
    activeOptions: string[],
    verifiedPrefixCards?: KeywordCard[],
): KeywordCard[] {
    const selectedNames = new Set(activeOptions.map(normalizeKeywordName));
    for (const option of postOptions(entry, selectedNames)) {
        selectedNames.add(optionName(option));
    }

    const selectedOptions = (entry.o || []).filter(option => selectedNames.has(optionName(option)));
    return renderSelectedOptions(entry.c || [], selectedOptions, verifiedPrefixCards);
}

function bestAnalysisForPhysicalCard(
    headerTexts: string[],
    physicalCard: KeywordCard,
    physicalCardIndex: number,
): CardHeaderCardAnalysis | null {
    const analyses = headerTexts
        .map(text => analyzeHeaderForCard(text, physicalCard, physicalCardIndex))
        .filter((analysis): analysis is CardHeaderCardAnalysis => !!analysis)
        .sort((left, right) =>
            Number(right.exactMatch) - Number(left.exactMatch)
            || Number(right.possibleVersionDrift) - Number(left.possibleVersionDrift)
            || right.matches - left.matches
            || left.differences.length - right.differences.length,
        );
    return analyses[0] || null;
}

/**
 * Recognize one field-header comment against a bounded set of candidate cards.
 * Unknown prose and metadata return null; ties across different physical cards
 * remain unresolved so comment-only editing cannot promote a guess.
 */
export function analyzeCardCommentHeader(
    lineText: string,
    cards: KeywordCard[],
): CardCommentHeaderMatch | null {
    const analyses = cards
        .map((card, index) => analyzeHeaderForCard(lineText, card, index + 1))
        .filter((analysis): analysis is CardHeaderCardAnalysis =>
            !!analysis && (analysis.exactMatch || analysis.possibleVersionDrift))
        .sort((left, right) =>
            Number(right.exactMatch) - Number(left.exactMatch)
            || right.matches - left.matches
            || right.anchorMatches - left.anchorMatches
            || left.differences.length - right.differences.length,
        );
    if (analyses.length === 0) return null;
    const best = analyses[0];
    const tied = analyses.some(candidate =>
        candidate !== best
        && candidate.exactMatch === best.exactMatch
        && candidate.matches === best.matches
        && candidate.anchorMatches === best.anchorMatches
        && candidate.differences.length === best.differences.length
        && !cardsHaveSamePhysicalSignature(candidate.card, best.card),
    );
    if (tied) return null;
    return {
        card: best.card,
        cardIndex: best.cardIndex,
        style: best.style,
        exactMatch: best.exactMatch,
        possibleVersionDrift: best.possibleVersionDrift,
        matchedFieldCount: best.matches,
        differences: best.differences,
    };
}

function expandRepeatingCards(cards: KeywordCard[], observedDataLineCount?: number): KeywordCard[] {
    if (!observedDataLineCount || cards.length === 0 || cards.length >= observedDataLineCount) {
        return cards;
    }

    const expanded = cards.slice();
    const last = cards[cards.length - 1];
    while (expanded.length < observedDataLineCount) {
        expanded.push(last);
    }
    return expanded;
}

export function getRenderedCards(
    entry: KeywordEntry,
    activeOptions: string[] = [],
    observedDataLineCount?: number,
): KeywordCard[] {
    const selectedNames = new Set(activeOptions.map(normalizeKeywordName));
    const selectedOptions = (entry.o || []).filter(option => selectedNames.has(optionName(option)));
    let rendered = renderSelectedOptions(entry.c || [], selectedOptions);

    if (observedDataLineCount) {
        for (const option of postOptions(entry, selectedNames)) {
            if (rendered.length >= observedDataLineCount) {
                break;
            }
            selectedNames.add(optionName(option));
            selectedOptions.push(option);
            rendered = renderSelectedOptions(entry.c || [], selectedOptions);
        }
    }

    // entry.r: last card is an explicit table/series row.
    if (entry.r) {
        rendered = expandRepeatingCards(rendered, observedDataLineCount);
    }

    return rendered;
}

/** Render cards using the manual-verified physical prefix when one is active. */
export function getRenderedCardsForLookup(
    lookup: KeywordLookup,
    observedDataLines: string[] = [],
    observedDataLineCount?: number,
    options: Partial<Pick<FieldContext, 'keywordText' | 'globalInputFormat' | 'parameterContext' | 'recordLines'>> = {},
): KeywordCard[] {
    const thermal = require('./semantics/contactThermalFieldResolution').renderContactThermalCards(lookup, observedDataLines, options);
    if (thermal) return thermal.cards.slice(0, Math.max(thermal.prefixCardCount + lookup.entry.c.length,
        observedDataLineCount ?? observedDataLines.length));
    const layout = getVerifiedPrefixLayout(lookup, observedDataLines);
    if (layout.status === 'unsupported-option') {
        // The keyword spelling is not an official variant. Do not synthesize the
        // database's stale option card; the base cards remain useful for a compact
        // keyword overview while all position-sensitive writes fail closed.
        return getRenderedCards(lookup.entry, [], observedDataLineCount);
    }
    if (layout.status !== 'verified') {
        return getRenderedCards(lookup.entry, lookup.activeOptions, observedDataLineCount);
    }

    const selectedNames = new Set(lookup.activeOptions.map(normalizeKeywordName));
    const selectedOptions = (lookup.entry.o || []).filter(option => selectedNames.has(optionName(option)));
    let rendered = renderSelectedOptions(lookup.entry.c || [], selectedOptions, layout.cards);
    if (observedDataLineCount) {
        for (const option of postOptions(lookup.entry, selectedNames)) {
            if (rendered.length >= observedDataLineCount) break;
            selectedNames.add(optionName(option));
            selectedOptions.push(option);
            rendered = renderSelectedOptions(lookup.entry.c || [], selectedOptions, layout.cards);
        }
    }
    if (lookup.entry.r) {
        rendered = expandRepeatingCards(rendered, observedDataLineCount);
    }
    return rendered;
}

/**
 * All finite cards reachable from the current keyword spelling, including
 * post-option cards but excluding repeat expansion. Used only by bounded,
 * explicit comment maintenance.
 */
export function getFiniteRenderedCardsForLookup(
    lookup: KeywordLookup,
    observedDataLines: string[] = [],
): KeywordCard[] {
    const layout = getVerifiedPrefixLayout(lookup, observedDataLines);
    const verifiedPrefixCards = layout.status === 'verified' ? layout.cards : undefined;
    return renderHeaderCandidateCards(
        lookup.entry,
        lookup.activeOptions,
        verifiedPrefixCards,
    );
}

function maximumFiniteRenderedCardCount(
    entry: KeywordEntry,
    activeOptions: string[],
    verifiedPrefixCards?: KeywordCard[],
): number {
    const selectedNames = new Set(activeOptions.map(normalizeKeywordName));
    const selectedOptions = (entry.o || []).filter(option => selectedNames.has(optionName(option)));
    for (const option of postOptions(entry, selectedNames)) {
        selectedNames.add(optionName(option));
        selectedOptions.push(option);
    }
    return Math.max(1, renderSelectedOptions(entry.c || [], selectedOptions, verifiedPrefixCards).length);
}

/** Resolve one observed card without materializing a repeated array for every data row. */
function cardForObservedDataLine(
    entry: KeywordEntry,
    activeOptions: string[],
    observedDataLineCount: number,
    verifiedPrefixCards?: KeywordCard[],
): KeywordCard | null {
    const selectedNames = new Set(activeOptions.map(normalizeKeywordName));
    const selectedOptions = (entry.o || []).filter(option => selectedNames.has(optionName(option)));
    let rendered = renderSelectedOptions(entry.c || [], selectedOptions, verifiedPrefixCards);

    for (const option of postOptions(entry, selectedNames)) {
        if (rendered.length >= observedDataLineCount) break;
        if (option.active) return null;
        selectedNames.add(optionName(option));
        selectedOptions.push(option);
        rendered = renderSelectedOptions(entry.c || [], selectedOptions, verifiedPrefixCards);
    }

    if (observedDataLineCount <= rendered.length) {
        return rendered[observedDataLineCount - 1] || null;
    }
    if (entry.r && rendered.length > 0) {
        return rendered[rendered.length - 1];
    }
    return null;
}

function keywordLineName(lineText: string): string {
    const trimmed = lineText.trim();
    return normalizeKeywordName(trimmed.startsWith('*') ? trimmed.slice(1) : trimmed);
}

function cardMatchesTextSignature(card: KeywordCard, signature: TextCardMetadata['f']): boolean {
    return card.length === signature.length && card.every((field, index) => {
        const expected = signature[index];
        return field.n === expected.n
            && field.p === expected.p
            && field.w === expected.w
            && field.t === expected.t;
    });
}

function cardsHaveSamePhysicalSignature(left: KeywordCard, right: KeywordCard): boolean {
    return left.length === right.length && left.every((field, index) => {
        const candidate = right[index];
        return normalizeFieldLabel(field.n) === normalizeFieldLabel(candidate?.n || '')
            && Number(field.p) === Number(candidate?.p)
            && Number(field.w) === Number(candidate?.w)
            && String(field.t || '').toLowerCase() === String(candidate?.t || '').toLowerCase();
    });
}

function findTextCard(entry: KeywordEntry, rendered: KeywordCard[]): { card: KeywordCard; cardIndex: number } | null {
    for (const metadata of entry.tc || []) {
        const index = rendered.findIndex(card => cardMatchesTextSignature(card, metadata.f));
        if (index >= 0) {
            return { card: rendered[index], cardIndex: index + 1 };
        }
    }
    return null;
}

export type GetCardInfoOptions = FieldContextOptions & {
    keywordOverride?: string | null;
};

export type CardResolution = {
    status: 'resolved' | 'unresolved' | 'unsupported' | 'truncated';
    reason: string;
    /** Separates incomplete input from a reader/evidence implementation gap. */
    failureKind?: 'input-uncertain' | 'implementation-gap';
    cardInfo?: KeywordCardInfo;
    unsupportedOptions?: string[];
};

/** Pure layout selection. Comments never enter this function's inputs. */
export function resolveCardFromContext(
    context: FieldContext,
    schema: KeywordSchema,
    keywordOverride?: string | null,
    geometryOnly = false,
): CardResolution {
    const fail = (status: CardResolution['status'], reason: string): CardResolution => ({ status, reason });
    const keyword = keywordOverride || keywordLineName(context.keywordText);
    const lookup = lookupKeywordSchema(keyword, schema);
    const thermal = require('./semantics/contactThermalFieldResolution').resolveContactThermalFieldCard(context, lookup);
    // Verified file spellings retain native identity; manual-only dynamic rows
    // and explicitly approved edit geometry keep the imported composition.
    if (thermal && (geometryOnly || thermal.status !== 'resolved' && thermal.reason !== 'contact-thermal-format-unverified' ||
        thermal.reason === 'contact-thermal-manual-extension' || !hasNativeFileReader(keyword))) return geometryOnly && thermal.cardInfo?.inputFormat !== 'standard'
        ? fail('unsupported', 'non-standard-input-format') : thermal;
    // File identity is independent of whether the help schema contains this spelling.
    const native = resolveNativeFieldCard(context, keyword, schema, lookup?.activeOptions);
    if (native) {
        if (geometryOnly && nativeFieldDisplayOnly(keyword)) {
            return fail('unsupported', 'native-edit-binding-unverified');
        }
        if (geometryOnly && native.cardInfo && native.cardInfo.inputFormat !== 'standard') {
            // Preserve the existing explicit comma-to-fixed conversion picker.
            // Its target geometry is separate from the actual source ranges.
            if (['PART', 'NODE'].includes(keyword) && native.cardInfo.inputFormat === 'comma' &&
                keywordInputFormat(context.keywordText, context.globalInputFormat) === 'standard') {
                const target = resolveNativeFieldCard({ ...context, currentText: '' }, keyword, schema, lookup?.activeOptions);
                if (target?.cardInfo?.card.every(field => field.nativeStaticBinding)) return target;
            }
            return fail('unsupported', 'native-format-edit-binding-unverified');
        }
        return native;
    }
    if (!lookup) return fail('unsupported', 'keyword-schema-unavailable');
    // Restoring a display lookup must not also authorize fixed-column edits
    // for a spelling that previously had no operational schema binding.
    if (geometryOnly && !schema[normalizeKeywordName(lookup.canonicalName)]) {
        return fail('unsupported', 'schema-spelling-edit-binding-unverified');
    }
    if (keywordInputFormat(context.keywordText, context.globalInputFormat) !== 'standard') {
        return fail('unsupported', 'non-standard-input-format');
    }
    const layout = getVerifiedPrefixLayout(lookup, context.observedDataLines);
    if (layout.status === 'unsupported-option' || layout.status === 'unverified') {
        return { ...fail('unsupported', layout.status === 'unverified' ? 'prefix-layout-unverified' : 'unsupported-keyword-option'), unsupportedOptions: layout.unsupportedOptions };
    }
    if (layout.status === 'verified' && context.observedDataLines.length <
        Math.min(context.dataLineOrdinal, layout.cards.length + 1)) {
        return fail('unresolved', 'prefix-record-context-unavailable');
    }
    const prefix = layout.status === 'verified' ? layout.cards : undefined;
    // Only finite templates are materialized. Repeated instances share geometry.
    const rendered = getRenderedCardsForLookup(lookup, context.observedDataLines);
    const textCard = findTextCard(lookup.entry, rendered);
    if (context.dataLineOrdinal === undefined && !context.homogeneousRepeat) return fail('unresolved', 'record-position-unavailable');
    const ordinal = context.dataLineOrdinal ?? 1;
    const isTextCard = !!textCard && ordinal >= textCard.cardIndex;
    if (!isTextCard && isKeywordCommentLine(context.currentText)) return fail('unsupported', 'comment-line');
    if (!geometryOnly && !isTextCard && context.currentText.includes(',')) return fail('unsupported', 'free-format-input');
    const bodyOrdinal = ordinal - (prefix?.length || 0);
    const schemaCard = isTextCard ? textCard.card
        : cardForObservedDataLine(lookup.entry, lookup.activeOptions, ordinal, prefix);
    let card = nativeFieldDefinitions(lookup.inputName, schema, schemaCard, bodyOrdinal);
    if (!card) return fail('unresolved', 'record-layout-unavailable');
    const finiteCount = maximumFiniteRenderedCardCount(lookup.entry, lookup.activeOptions, prefix);
    const cardIndex = isTextCard ? textCard.cardIndex : schemaCard ? Math.min(ordinal, finiteCount) : ordinal;
    return {
        status: 'resolved', reason: 'data-layout',
        cardInfo: {
            card, cardIndex, keywordName: lookup.inputName, activeOptions: lookup.activeOptions,
            observedDataLineOrdinal: context.dataLineOrdinal, leadingOptionCardCount: prefix?.length || 0,
            isLeadingOptionCard: ordinal <= (prefix?.length || 0),
            ...(isTextCard ? { isTextCard: true } : {}), resolutionSource: isTextCard ? 'text-card' : ordinal <= (prefix?.length || 0)
                ? 'leading-option' : 'physical-order', prefixLayoutStatus: layout.status,
        },
    };
}

export function readCardContext(document: any, lineNum: number, schema: KeywordSchema, options: GetCardInfoOptions = {}) {
    return readFieldContext(document, lineNum, schema, {
        ...options,
        recordOrdinalOnly: keywordText => nativeFieldsNeedOnlyOrdinal(keywordLineName(keywordText)),
        segmentedRecords: keywordText => hasNativeFileReader(keywordLineName(keywordText)),
        homogeneousRepeat: keywordText => {
            const lookup = lookupKeywordSchema(keywordLineName(keywordText), schema);
            return !!lookup?.entry.r && lookup.entry.c.length === 1 && !lookup.entry.tc?.length &&
                !lookup.entry.o?.length && getVerifiedPrefixLayout(lookup).status === 'none';
        },
    });
}

export function resolveCardForDocumentLine(
    document: any, lineNum: number, schema: KeywordSchema = loadKeywordSchema(),
    options: GetCardInfoOptions = {},
): CardResolution {
    const result = readCardContext(document, lineNum, schema, options);
    if (result.status !== 'resolved') return result;
    return resolveCardFromContext(result.context, schema, options.keywordOverride);
}

/** Continue bounded native record scans without blocking cancellation or mixing versions. */
export async function resolveCardForDocumentLineAsync(
    document: any, lineNum: number, schema: KeywordSchema = loadKeywordSchema(), options: GetCardInfoOptions = {},
): Promise<CardResolution> {
    const version = document.version;
    for (;;) {
        if (options.cancellationToken?.isCancellationRequested) return { status: 'truncated', reason: 'field-context-cancelled' };
        if (document.version !== version) return { status: 'truncated', reason: 'field-context-version-changed' };
        const result = resolveCardForDocumentLine(document, lineNum, schema, options);
        if (document.version !== version) return { status: 'truncated', reason: 'field-context-version-changed' };
        if (result.reason !== 'field-context-checkpoint-pending') return result;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

export function getCardInfoForDocumentLine(
    document: any, lineNum: number, schema: KeywordSchema = loadKeywordSchema(),
    options: GetCardInfoOptions = {},
): KeywordCardInfo | null {
    return resolveCardForDocumentLine(document, lineNum, schema, options).cardInfo || null;
}

/** Optional annotation, compared only with a card already selected from data. */
export function assessCardComment(cardInfo: KeywordCardInfo, headers: string[]): CardCommentNotice | undefined {
    const analysis = bestAnalysisForPhysicalCard(headers.slice(-8), cardInfo.card, cardInfo.cardIndex);
    if (!analysis?.possibleVersionDrift || !analysis.differences.length) return undefined;
    return {
        kind: 'definition-mismatch', physicalCardIndex: cardInfo.cardIndex,
        style: analysis.style, observedFieldNames: analysis.observedFieldNames,
        expectedFieldNames: analysis.expectedFieldNames, matchedFieldCount: analysis.matches,
        differences: analysis.differences,
    };
}

export function getCardForDocumentLine(
    document: any,
    lineNum: number,
    schema: KeywordSchema = loadKeywordSchema(),
    options: GetCardInfoOptions = {},
): KeywordCard | null {
    const info = getCardInfoForDocumentLine(document, lineNum, schema, options);
    return info ? info.card : null;
}
