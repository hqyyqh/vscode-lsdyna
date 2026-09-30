'use strict';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

export type PredicateExprV2 =
    | { op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; value: number | string }
    | { op: 'in'; values: Array<number | string> }
    | { op: 'range'; minimum: number; maximum: number; includeMinimum?: boolean; includeMaximum?: boolean }
    | { op: 'all' | 'any'; operands: PredicateExprV2[] }
    | { op: 'not'; operand: PredicateExprV2 }
    | { op: 'symbolic'; reason: string };

export type FormatFieldCoordinateV2 = {
    mode: 'fixed' | 'comma';
    position?: number;
    width?: number;
    fieldIndex: number;
};

export type ReferenceRelationV2 = {
    schemaVersion: 2;
    kind: 'entity-definition' | 'entity-reference' | 'value-branch';
    disposition: 'definition' | 'reference' | 'value-branch' | 'non-reference';
    field: {
        keyword: string;
        keywordForm: string;
        cardIndex: number;
        fieldIndex: number;
        fieldName: string;
        fieldType: string;
        position: number;
        width: number;
        formats: Record<'standard' | 'i10' | 'long' | 'comma', FormatFieldCoordinateV2>;
        [key: string]: unknown;
    };
    relation: Record<string, unknown>;
    permissions: Record<string, boolean>;
    [key: string]: unknown;
};

export type DefinitionScannerDescriptorV2 = {
    keyword: string;
    targetKind: string;
    definitionField: string;
    physicalSelector: Record<string, unknown>;
    formatContracts: Array<Record<string, unknown>>;
    [key: string]: unknown;
};

export type OptionFieldLayoutV2 = {
    fieldMigrationId: string;
    name: string;
    type: string;
    position: number;
    width: number;
    canonicalFieldIdentity?: string;
    columnOrdinal?: number;
    fieldOrdinal?: number;
    removalDisposition?: 'official-target-absent';
};

export type OptionRecordLayoutV2 = {
    recordMigrationId: string;
    occurrence: { kind: 'exactly-once' | 'repeat' | 'conditional'; [key: string]: unknown };
    fields: OptionFieldLayoutV2[];
    removalDisposition?: 'official-target-absent';
};

export type OptionLayoutProfileV2 = {
    profileId: string;
    keyword: string;
    inputFormat: 'standard-fixed';
    records: OptionRecordLayoutV2[];
    commentContract: string;
    sourceIdentity: Record<string, unknown>;
};

export type FieldMigrationBindingV2 = {
    sourceFieldMigrationId: string;
    targetFieldMigrationId: string;
    evidenceId: string;
    strategy?: 'stable-physical-field-identity';
};

export type OptionDimensionV2 = {
    dimensionId: string;
    labels: { en: string; zh?: string };
    selectionMode: 'single' | 'multiple';
    required: boolean;
    values: Array<{
        valueId: string;
        labels: { en: string; zh?: string };
    }>;
};

export type OptionTargetV2 = {
    targetId: string;
    spelling: string;
    selection?: { slotId?: string; values?: string[]; slots?: Record<string, string[]> };
    semanticSelectionId?: string;
    preferredForSelection?: boolean;
    disposition: 'editable' | 'read-only-by-official-structure' |
        'read-only-by-product-format' | 'blocked-evidence-gap';
    writePermission: boolean;
    writeBlocker: string | null;
    applicationMode: 'layout-migration' | 'keyword-only-preserve-block';
    layouts: Array<{ postCount: number; layout: OptionLayoutProfileV2; bindings: FieldMigrationBindingV2[] }>;
    evidence: Array<Record<string, unknown>>;
};

export type KeywordOptionGrammarV2 = {
    schemaVersion: 2;
    kind: 'keyword-option-grammar-v2';
    grammarId: string;
    canonicalSectionId: string;
    grammarKind: 'exclusive' | 'ordered-subset' | 'allowed-sequences' |
        'cross-product' | 'compatibility-indeterminate';
    dimensions?: OptionDimensionV2[];
    slots: Array<Record<string, unknown>>;
    constraints: Array<Record<string, unknown>>;
    targets: OptionTargetV2[];
    status: string;
    permissions: Record<string, boolean>;
    evidence: Array<Record<string, unknown>>;
};

type ShardDescriptor = {
    prefix: string;
    path: string;
    records: number;
    scanners?: number;
    compressedBytes: number;
    uncompressedBytes: number;
    sha256: string;
    contentSha256: string;
};

export type SemanticRuntimeCatalogV2Manifest = {
    schemaVersion: 2;
    kind: 'dynasense-semantic-runtime-catalog-v2';
    datasetReleaseId: string;
    source: Record<string, unknown>;
    permissions: Record<string, boolean>;
    capacity: {
        maxCompressedShardBytes: number;
        maxUncompressedShardBytes: number;
        maxTotalCompressedBytes: number;
        lruUncompressedBytes: number;
    };
    summary: Record<string, number>;
    referenceShards: ShardDescriptor[];
    optionShards: ShardDescriptor[];
    referenceKeywordIndex: Record<string, string>;
    optionSpellingIndex: Record<string, string>;
    contentSha256: string;
};

function canonicalize(value: any): any {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
    }
    return value;
}
function canonicalJson(value: any): string { return JSON.stringify(canonicalize(value)); }
function sha256(value: Buffer | string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function stableId(prefix: string, value: unknown): string {
    return `${prefix}:${sha256(Buffer.from(canonicalJson(value))).slice(0, 24)}`;
}
function normalizeKeyword(value: string): string {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0]
        .replace(/[+%\-]$/, '');
}
function assertContract(condition: any, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

export function semanticRuntimeV2Root(): string {
    return path.resolve(__dirname, '..', '..', '..', 'keywords', 'semantic_runtime_v2');
}

function validateManifest(raw: any): SemanticRuntimeCatalogV2Manifest {
    assertContract(raw?.schemaVersion === 2 && raw.kind === 'dynasense-semantic-runtime-catalog-v2',
        'unsupported semantic runtime catalog');
    assertContract(/^semantic-dataset:[0-9a-f]{24}$/.test(raw.datasetReleaseId || ''),
        'invalid semantic dataset release identity');
    const { contentSha256, ...core } = raw;
    assertContract(/^[0-9a-f]{64}$/.test(contentSha256 || '') &&
        sha256(Buffer.from(canonicalJson(core))) === contentSha256, 'semantic manifest content drift');
    const capacity = raw.capacity || {};
    assertContract(Number.isInteger(capacity.maxCompressedShardBytes) &&
        capacity.maxCompressedShardBytes > 0 && capacity.maxCompressedShardBytes <= 2 * 1024 * 1024 &&
        Number.isInteger(capacity.maxUncompressedShardBytes) &&
        capacity.maxUncompressedShardBytes > 0 && capacity.maxUncompressedShardBytes <= 16 * 1024 * 1024 &&
        Number.isInteger(capacity.maxTotalCompressedBytes) &&
        capacity.maxTotalCompressedBytes > 0 && capacity.maxTotalCompressedBytes <= 64 * 1024 * 1024 &&
        Number.isInteger(capacity.lruUncompressedBytes) && capacity.lruUncompressedBytes > 0 &&
        capacity.lruUncompressedBytes <= 16 * 1024 * 1024, 'semantic runtime capacity invalid');
    const descriptors = [...(raw.referenceShards || []), ...(raw.optionShards || [])];
    assertContract(descriptors.length > 0 && descriptors.every((descriptor: any) =>
        /^[0-9a-f]$/.test(descriptor.prefix || '') &&
        /^[a-z]+\/[0-9a-f]\.json\.gz$/.test(descriptor.path || '') &&
        Number.isInteger(descriptor.records) && descriptor.records >= 0 &&
        descriptor.compressedBytes <= capacity.maxCompressedShardBytes &&
        descriptor.uncompressedBytes <= capacity.maxUncompressedShardBytes &&
        /^[0-9a-f]{64}$/.test(descriptor.sha256 || '') &&
        /^[0-9a-f]{64}$/.test(descriptor.contentSha256 || '')), 'semantic shard descriptor invalid');
    assertContract(descriptors.reduce((sum: number, item: any) => sum + item.compressedBytes, 0) <=
        capacity.maxTotalCompressedBytes, 'semantic runtime total capacity exceeded');
    assertContract((raw.referenceShards || []).length === 16 && (raw.optionShards || []).length === 16 &&
        new Set(raw.referenceShards.map((item: any) => item.prefix)).size === 16 &&
        new Set(raw.optionShards.map((item: any) => item.prefix)).size === 16,
    'semantic shard set incomplete');
    assertContract(raw.permissions?.referenceNavigation === true &&
        raw.permissions?.reverseReferenceNavigation === true && raw.permissions?.optionDisplay === true &&
        raw.permissions?.optionMutationByTarget === true && raw.permissions?.completenessClaim === false,
    'semantic runtime permission invalid');
    assertContract(Object.values(raw.referenceKeywordIndex || {}).every(prefix => /^[0-9a-f]$/.test(String(prefix))) &&
        Object.values(raw.optionSpellingIndex || {}).every(prefix => /^[0-9a-f]$/.test(String(prefix))),
    'semantic runtime index invalid');
    return raw;
}

function validatePredicate(node: any): boolean {
    if (!node || typeof node !== 'object') return false;
    if (['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(node.op)) return 'value' in node;
    if (node.op === 'in') return Array.isArray(node.values);
    if (node.op === 'range') return Number.isFinite(node.minimum) && Number.isFinite(node.maximum);
    if (node.op === 'all' || node.op === 'any') return Array.isArray(node.operands) && node.operands.every(validatePredicate);
    if (node.op === 'not') return validatePredicate(node.operand);
    return node.op === 'symbolic' && typeof node.reason === 'string' && node.reason.length > 0;
}

function validateReferenceRecord(record: any): boolean {
    if (record?.schemaVersion !== 2 || !['definition', 'reference', 'value-branch', 'non-reference'].includes(record.disposition)) return false;
    const formats = record.field?.formats;
    if (!formats || !['standard', 'i10', 'long', 'comma'].every(mode => formats[mode]?.fieldIndex >= 0)) return false;
    if (record.predicateAst !== undefined && !validatePredicate(record.predicateAst)) return false;
    const transform = record.idTransform || record.relation?.idTransform;
    if (transform !== undefined && !['identity', 'abs', 'negate'].includes(transform)) return false;
    return record.permissions?.classify === true && typeof record.permissions?.navigate === 'boolean';
}

function validateOptionRecord(grammar: any): boolean {
    if (grammar?.schemaVersion !== 2 || grammar.kind !== 'keyword-option-grammar-v2' ||
        !['exclusive', 'ordered-subset', 'allowed-sequences', 'cross-product', 'compatibility-indeterminate']
            .includes(grammar.grammarKind) || !Array.isArray(grammar.targets)) return false;
    const dimensions = grammar.dimensions || [];
    if (!Array.isArray(dimensions) || new Set(dimensions.map((item: any) => item.dimensionId)).size !== dimensions.length ||
        dimensions.some((dimension: any) => !dimension.dimensionId ||
            !['single', 'multiple'].includes(dimension.selectionMode) || typeof dimension.required !== 'boolean' ||
            !dimension.labels?.en || !Array.isArray(dimension.values) || dimension.values.length === 0 ||
            new Set(dimension.values.map((value: any) => value.valueId)).size !== dimension.values.length ||
            dimension.values.some((value: any) => !value.valueId || !value.labels?.en))) return false;
    const dispositions = new Set(['editable', 'read-only-by-official-structure',
        'read-only-by-product-format', 'blocked-evidence-gap']);
    for (const target of grammar.targets) {
        if (!dispositions.has(target.disposition) || target.writePermission !== (target.disposition === 'editable') ||
            !['layout-migration', 'keyword-only-preserve-block'].includes(target.applicationMode) ||
            (target.applicationMode === 'layout-migration' && !(target.layouts || []).length) ||
            (target.applicationMode === 'keyword-only-preserve-block' && (target.layouts || []).length !== 0)) return false;
        if (dimensions.length > 0) {
            const slots = target.selection?.slots;
            if (!target.semanticSelectionId || typeof target.preferredForSelection !== 'boolean' || !slots ||
                dimensions.some((dimension: any) => {
                    const values = slots[dimension.dimensionId];
                    const allowed = new Set(dimension.values.map((value: any) => String(value.valueId).toUpperCase()));
                    return !Array.isArray(values) || (dimension.required && values.length === 0) ||
                        (dimension.selectionMode === 'single' && values.length !== 1) ||
                        values.some((value: any) => !allowed.has(String(value).toUpperCase()));
                })) return false;
        }
        for (const candidate of target.layouts || []) {
            const layout = candidate.layout;
            if (layout?.inputFormat !== 'standard-fixed' || !layout.profileId || !Array.isArray(layout.records)) return false;
            if (!Array.isArray(candidate.bindings) || candidate.bindings.some((binding: any) =>
                !binding.sourceFieldMigrationId || !binding.targetFieldMigrationId || !binding.evidenceId)) return false;
            const recordIds = layout.records.map((record: any) => record.recordMigrationId);
            if (new Set(recordIds).size !== recordIds.length) return false;
            for (const record of layout.records) {
                if (!['exactly-once', 'repeat', 'conditional'].includes(record.occurrence?.kind)) return false;
                const fieldIds = (record.fields || []).map((field: any) => field.fieldMigrationId);
                if (new Set(fieldIds).size !== fieldIds.length) return false;
            }
        }
    }
    if (dimensions.length > 0) {
        const groups = new Map<string, any[]>();
        for (const target of grammar.targets) {
            if (!groups.has(target.semanticSelectionId)) groups.set(target.semanticSelectionId, []);
            groups.get(target.semanticSelectionId)!.push(target);
        }
        if ([...groups.values()].some(targets =>
            targets.filter(target => target.preferredForSelection === true).length !== 1)) return false;
    }
    return grammar.permissions?.display === true && typeof grammar.permissions?.mutate === 'boolean';
}

function materializeOptionBindings(grammar: any): any {
    for (const target of grammar?.targets || []) {
        for (const candidate of target?.layouts || []) {
            const hasBindings = Object.prototype.hasOwnProperty.call(candidate, 'bindings');
            const hasEncoding = Object.prototype.hasOwnProperty.call(candidate, 'bindingEncoding');
            if (!hasEncoding) {
                assertContract(hasBindings && Array.isArray(candidate.bindings),
                    `semantic option explicit bindings missing: ${target?.spelling || 'unknown'}`);
                continue;
            }
            assertContract(candidate.bindingEncoding === 'identity-derived-v1' && !hasBindings,
                `semantic option binding encoding invalid: ${target?.spelling || 'unknown'}`);
            const layout = candidate.layout;
            assertContract(typeof layout?.profileId === 'string' && layout.profileId.length > 0 &&
                Array.isArray(layout.records) && layout.records.every((record: any) =>
                    Array.isArray(record?.fields) && record.fields.every((field: any) =>
                        typeof field?.fieldMigrationId === 'string' && field.fieldMigrationId.length > 0)),
            `semantic option binding layout invalid: ${target?.spelling || 'unknown'}`);
            const bindings = layout.records.flatMap((record: any) => record.fields.map((field: any) => ({
                sourceFieldMigrationId: field.fieldMigrationId,
                targetFieldMigrationId: field.fieldMigrationId,
                evidenceId: stableId('option-binding-evidence', [layout.profileId, field.fieldMigrationId]),
                ...(field.canonicalFieldIdentity ? { strategy: 'stable-physical-field-identity' } : {}),
            })));
            delete candidate.bindingEncoding;
            candidate.bindings = bindings;
        }
    }
    return grammar;
}

function validateDefinitionScanner(scanner: any): boolean {
    return scanner?.schemaVersion === 2 && scanner.kind === 'definition-scanner-descriptor-v2' &&
        typeof scanner.keyword === 'string' && typeof scanner.targetKind === 'string' &&
        ['numeric', 'label'].includes(scanner.identityType) &&
        Array.isArray(scanner.formatContracts) &&
        ['standard', 'i10', 'long', 'comma'].every(format =>
            scanner.formatContracts.some((contract: any) => contract.format === format)) &&
        scanner.permissions?.scan === true && scanner.permissions?.completenessClaim === false;
}

type CachedShard = { records: any[]; scanners: any[]; bytes: number; lastAccessed: number };

export class SemanticRuntimeCatalogV2 {
    private readonly root: string;
    private manifestValue: SemanticRuntimeCatalogV2Manifest | null = null;
    private failureReasonValue = '';
    private readonly cache = new Map<string, CachedShard>();
    private clock = 0;
    private preparation: Promise<{ records: any[]; scanners: any[] }> | null = null;

    constructor(root = semanticRuntimeV2Root()) { this.root = root; }

    status() {
        if (this.failureReasonValue) {
            return { ready: false, datasetReleaseId: null, failureReason: this.failureReasonValue };
        }
        try {
            const manifest = this.manifest();
            return { ready: true, datasetReleaseId: manifest.datasetReleaseId, failureReason: '' };
        } catch (error) {
            this.failureReasonValue = error instanceof Error ? error.message : String(error);
            return { ready: false, datasetReleaseId: null, failureReason: this.failureReasonValue };
        }
    }

    manifest(prepared?: string): SemanticRuntimeCatalogV2Manifest {
        if (this.manifestValue) return this.manifestValue;
        const file = path.join(this.root, 'manifest.json');
        const manifest = validateManifest(JSON.parse(prepared ?? fs.readFileSync(file, 'utf8')));
        this.manifestValue = manifest;
        return this.manifestValue;
    }

    private descriptor(domain: 'references' | 'options', prefix: string): ShardDescriptor {
        const manifest = this.manifest();
        const descriptors = domain === 'references' ? manifest.referenceShards : manifest.optionShards;
        const matches = descriptors.filter(item => item.prefix === prefix);
        assertContract(matches.length === 1, `semantic ${domain} shard unavailable: ${prefix}`);
        return matches[0];
    }

    private load(domain: 'references' | 'options', prefix: string, prepared?: { compressed: Buffer; raw: Buffer }): any[] {
        const key = `${domain}:${prefix}`;
        const cached = this.cache.get(key);
        if (cached) { cached.lastAccessed = ++this.clock; return cached.records; }
        const descriptor = this.descriptor(domain, prefix);
        const compressed = prepared?.compressed || fs.readFileSync(path.join(this.root, descriptor.path));
        assertContract(compressed.length === descriptor.compressedBytes && sha256(compressed) === descriptor.sha256,
            `semantic ${domain} shard compressed drift: ${prefix}`);
        const raw = prepared?.raw || zlib.gunzipSync(compressed, { maxOutputLength: descriptor.uncompressedBytes });
        assertContract(raw.length === descriptor.uncompressedBytes && sha256(raw) === descriptor.contentSha256,
            `semantic ${domain} shard content drift: ${prefix}`);
        const payload = JSON.parse(raw.toString('utf8'));
        assertContract(payload?.schemaVersion === 2 && payload.kind === `dynasense-${domain}-shard-v2` &&
            payload.prefix === prefix && Array.isArray(payload.records) &&
            payload.records.length === descriptor.records, `semantic ${domain} shard contract invalid: ${prefix}`);
        if (domain === 'options') payload.records.forEach(materializeOptionBindings);
        assertContract(payload.records.every(domain === 'references' ? validateReferenceRecord : validateOptionRecord),
            `semantic ${domain} record contract invalid: ${prefix}`);
        const scanners = Array.isArray(payload.scanners) ? payload.scanners : [];
        assertContract(domain !== 'references' || scanners.length === (descriptor.scanners || 0),
            `semantic ${domain} scanner contract invalid: ${prefix}`);
        assertContract(domain !== 'references' || scanners.every(validateDefinitionScanner),
            `semantic ${domain} scanner descriptor invalid: ${prefix}`);
        this.cache.set(key, { records: payload.records, scanners, bytes: raw.length, lastAccessed: ++this.clock });
        this.evict();
        return payload.records;
    }

    /** Global relation identities require every reference shard, but never option shards. */
    prepareReferences(): Promise<{ records: any[]; scanners: any[] }> {
        if (this.preparation) return this.preparation;
        this.preparation = (async () => {
            if (!this.manifestValue) this.manifest(await fs.promises.readFile(path.join(this.root, 'manifest.json'), 'utf8'));
            const records = [], scanners = [];
            for (const descriptor of this.manifest().referenceShards) {
                const cached = this.cache.get(`references:${descriptor.prefix}`);
                if (cached) records.push(...cached.records);
                else {
                    const compressed = await fs.promises.readFile(path.join(this.root, descriptor.path));
                    assertContract(compressed.length === descriptor.compressedBytes && sha256(compressed) === descriptor.sha256,
                        `semantic references shard compressed drift: ${descriptor.prefix}`);
                    const raw = await new Promise<Buffer>((resolve, reject) => zlib.gunzip(compressed,
                        { maxOutputLength: descriptor.uncompressedBytes }, (error, value) => error ? reject(error) : resolve(value)));
                    records.push(...this.load('references', descriptor.prefix, { compressed, raw }));
                }
                scanners.push(...(this.cache.get(`references:${descriptor.prefix}`)?.scanners || []));
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            return { records, scanners };
        })().finally(() => { this.preparation = null; });
        return this.preparation;
    }

    private evict() {
        const budget = this.manifest().capacity.lruUncompressedBytes;
        let total = [...this.cache.values()].reduce((sum, item) => sum + item.bytes, 0);
        while (total > budget && this.cache.size > 1) {
            const [key, value] = [...this.cache].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)[0];
            this.cache.delete(key);
            total -= value.bytes;
        }
    }

    referenceRecordsForKeyword(keyword: string): ReferenceRelationV2[] {
        if (this.failureReasonValue) return [];
        try {
            const normalized = normalizeKeyword(keyword);
            const prefix = this.manifest().referenceKeywordIndex[normalized];
            if (!prefix) return [];
            return this.load('references', prefix).filter(record =>
                normalizeKeyword(record?.field?.keyword) === normalized);
        } catch (error) {
            this.failureReasonValue = error instanceof Error ? error.message : String(error);
            return [];
        }
    }

    allReferenceRecords(): ReferenceRelationV2[] {
        if (this.failureReasonValue) return [];
        try { return this.manifest().referenceShards.flatMap(item => this.load('references', item.prefix)); }
        catch (error) { this.failureReasonValue = error instanceof Error ? error.message : String(error); return []; }
    }

    definitionScannersForKeyword(keyword: string): DefinitionScannerDescriptorV2[] {
        if (this.failureReasonValue) return [];
        try {
            const normalized = normalizeKeyword(keyword);
            const prefix = sha256(Buffer.from(normalized)).slice(0, 1);
            this.load('references', prefix);
            return (this.cache.get(`references:${prefix}`)?.scanners || []).filter(scanner =>
                normalizeKeyword(scanner.keyword) === normalized);
        } catch (error) { this.failureReasonValue = error instanceof Error ? error.message : String(error); return []; }
    }

    allDefinitionScanners(): DefinitionScannerDescriptorV2[] {
        if (this.failureReasonValue) return [];
        try {
            return this.manifest().referenceShards.flatMap(item => {
                this.load('references', item.prefix);
                return this.cache.get(`references:${item.prefix}`)?.scanners || [];
            });
        } catch (error) { this.failureReasonValue = error instanceof Error ? error.message : String(error); return []; }
    }

    optionGrammarForSpelling(spelling: string): KeywordOptionGrammarV2 | null {
        if (this.failureReasonValue) return null;
        try {
            const normalized = `*${normalizeKeyword(spelling)}`;
            const prefix = this.manifest().optionSpellingIndex[normalized];
            if (!prefix) return null;
            const matches = this.load('options', prefix).filter(grammar =>
                (grammar.targets || []).some((target: any) => String(target.spelling).toUpperCase() === normalized));
            return matches.length === 1 ? matches[0] : null;
        } catch (error) { this.failureReasonValue = error instanceof Error ? error.message : String(error); return null; }
    }

    allOptionGrammars(): KeywordOptionGrammarV2[] {
        if (this.failureReasonValue) return [];
        try { return this.manifest().optionShards.flatMap(item => this.load('options', item.prefix)); }
        catch (error) { this.failureReasonValue = error instanceof Error ? error.message : String(error); return []; }
    }

    clearCache() { this.cache.clear(); }
}

let defaultCatalog: SemanticRuntimeCatalogV2 | null = null;
export function getSemanticRuntimeCatalogV2(): SemanticRuntimeCatalogV2 {
    if (!defaultCatalog) defaultCatalog = new SemanticRuntimeCatalogV2();
    return defaultCatalog;
}
export function resetSemanticRuntimeCatalogV2ForTesting() { defaultCatalog = null; }

module.exports = {
    SemanticRuntimeCatalogV2,
    getSemanticRuntimeCatalogV2,
    resetSemanticRuntimeCatalogV2ForTesting,
    semanticRuntimeV2Root,
};
