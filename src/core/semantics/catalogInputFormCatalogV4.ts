import { keywordDataPath } from "../keywordDataPath";
import { isDescriptorIdentity, descriptorIdentityAt } from './descriptorIdentity';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { serialize, deserialize } from 'v8';
import { contactThermalCatalogKeyword, withContactThermalForm } from './contactThermal';

const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;

function sha256(value: Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeKeyword(value: string): string {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function defaultRuntimeRoot(): string {
    return keywordDataPath("input-form");
}

import { ByteLru } from '../cache/byteLru';

export type CatalogInputFormCatalogOptions = {
    rootDir?: string;
    maximumCacheBytes?: number;
    readFile?: (filePath: string) => Buffer;
    allowUnaudited?: boolean;
};

export type CatalogInputForm = {
    keyword: string;
    reference: Record<string, string[] | string | undefined>;
    rules: Record<string, any>;
    source: {
        schemaVersion: 4;
        datasetVersion: string;
        datasetSha256: string;
        conservationSatisfied: boolean;
        isUnauditedDiagnostic?: boolean;
    };
};

type LoadedShard = {
    keywords: Record<string, Record<string, string[] | string | undefined>>;
    rules: Record<string, any>;
    projectedRules: Map<string, any>;
};

/** Adapt verified raw branch descriptors into effective GUI cards, retaining
 * the common head from the initial card. This does not authorize publication. */
export function projectNativeStringTailCards(rule: any, structure: any, datasetSha256: string): any[] {
    const fail = () => { throw new Error('native string-tail descriptors are invalid'); };
    const selection = structure?.recordSelection;
    if (!selection || selection.kind !== 'native-string-tail-replacement' ||
        !Array.isArray(selection.cases) || !Array.isArray(selection.prefixCardIndexes) ||
        selection.datasetSha256 !== datasetSha256 || structure.source?.sha256 !== datasetSha256 ||
        structure.nativeIdentity?.cardSetId !== rule.cardSetId ||
        !Array.isArray(structure.branchFields) || !Array.isArray(structure.prefixFields) || !Array.isArray(rule.cards) ||
        structure.nativeIdentity.descriptorPoolCount !== rule.cards.length) return fail();
    const firstTail = selection.appendStartFieldIndex;
    const nativeByIndex = new Map<number, any>(structure.branchFields.map(card => [card.cardIndex, card]));
    const prefixByIndex = new Map<number, any>(structure.prefixFields.map(card => [card.cardIndex, card]));
    if (nativeByIndex.size !== structure.branchFields.length ||
        prefixByIndex.size !== structure.prefixFields.length ||
        prefixByIndex.size !== selection.prefixCardIndexes?.length ||
        selection.prefixCardIndexes.some(index => !prefixByIndex.has(index) || nativeByIndex.has(index)) ||
        selection.cases.some(item => !nativeByIndex.has(item.cardIndex))) return fail();
    const base = nativeByIndex.get(selection.controllerCardIndex);
    if (!base || !Number.isInteger(firstTail) || firstTail <= selection.controllerFieldIndex ||
        firstTail >= base.fields.length || selection.clearedFieldIndexesOnCardChange.length !== base.fields.length - firstTail ||
        selection.clearedFieldIndexesOnCardChange.some((value, index) => value !== firstTail + index)) return fail();
    const nativeChoices = base.fields[selection.controllerFieldIndex]?.options?.values;
    if (selection.controllerReadWidth !== undefined || structure.controllerReadWindow !== undefined) {
        const window = structure.controllerReadWindow;
        if (!Number.isInteger(selection.controllerReadWidth) || selection.controllerReadWidth <= 0 ||
            selection.controllerReadWidth > base.fields[selection.controllerFieldIndex]?.width ||
            window?.datasetSha256 !== datasetSha256 || window?.width !== selection.controllerReadWidth ||
            window?.format !== 'fixed' || window?.instruction?.mnemonic !== 'mov' ||
            window.instruction.operands !== `r8d, 0x${selection.controllerReadWidth.toString(16)}` ||
            !isDescriptorIdentity(window.instruction.address)) return fail();
    }
    if (!Array.isArray(nativeChoices) || selection.cases.length !== nativeChoices.length ||
        new Set(selection.cases.map(item => item.value)).size !== nativeChoices.length ||
        nativeByIndex.size !== new Set(selection.cases.map(item => item.cardIndex)).size ||
        selection.cases.some((item, index) => item.value !== nativeChoices[index])) return fail();
    return rule.cards.map(card => {
        const isPrefix = prefixByIndex.has(card.cardIndex);
        const native = prefixByIndex.get(card.cardIndex) || nativeByIndex.get(card.cardIndex);
        if (!native || native.fields.length !== card.fields.length ||
            (!isPrefix && native.fields.length !== base.fields.length)) return fail();
        const fields = card.fields.map((field, index) => {
            const raw = native.fields[index];
            if (field.fieldRecordId !== raw.field_record_id || field.fieldIndex !== raw.field_index ||
                field.name !== raw.name || field.type !== raw.type ||
                field.position !== raw.position || field.width !== raw.width) return fail();
            const effective = !isPrefix && index < firstTail ? base.fields[index] : raw;
            // GUI append starts at firstTail; common head retains its original
            // physical descriptor, rather than acquiring the branch duplicate.
            if (effective.name !== raw.name || effective.type !== raw.type ||
                effective.position !== raw.position || effective.width !== raw.width) return fail();
            const choices = effective.options?.values || [];
            const defaultValue = effective.options && effective.default === effective.options.raw
                ? choices[0] ?? null : effective.default;
            return { ...field, fieldRecordId: effective.field_record_id, help: effective.help,
                choices: [...choices], defaultValue };
        });
        return { ...card, fields };
    });
}

/** Project a source-verified extent without changing the stored raw rule. */
export function projectNativeDescriptorExtent(rule: any, datasetSha256: string): any {
    const extent = rule.nativeDescriptorExtent;
    if (extent === undefined) return rule;
    const reject = () => { throw new Error('native descriptor extent is invalid'); };
    if (extent?.consumption !== undefined && extent.consumption !== 'static-descriptor-records') reject();
    if (!extent || extent.kind !== 'native-descriptor-extent-v1' ||
        extent.datasetSha256 !== datasetSha256 ||
        !/^[a-f0-9]{64}$/.test(extent.evidenceSha256 || '') ||
        !isDescriptorIdentity(extent.rowRecordId) ||
        !Number.isInteger(extent.nativeKey) || extent.nativeKey < 0 || extent.nativeKey > 0xffffffff ||
        extent.cardSetId !== rule.cardSetId ||
        !isDescriptorIdentity(rule.cardSetId) ||
        !Number.isInteger(extent.cardCount) || extent.cardCount < 1 ||
        !Array.isArray(rule.cards) || extent.cardCount > rule.cards.length) reject();
    const cards = rule.cards.slice(0, extent.cardCount);
    const expectedControls = new Map<string, { cardIndex: number; fieldIndex: number }>();
    for (const [index, card] of cards.entries()) {
        if (card.cardIndex !== index + 1 ||
            card.cardRecordId !== descriptorIdentityAt(rule.cardSetId, index) ||
            !Array.isArray(card.fields) || card.fields.length === 0) reject();
        for (const [fieldIndex, field] of card.fields.entries()) {
            if (field.fieldIndex !== fieldIndex || typeof field.fieldId !== 'string' ||
                expectedControls.has(field.fieldId)) reject();
            expectedControls.set(field.fieldId, { cardIndex: card.cardIndex, fieldIndex });
        }
    }
    if (extent.consumption === 'static-descriptor-records') {
        const nonempty = (value: any) => value != null && (Array.isArray(value)
            ? value.length > 0 : typeof value === 'object' ? Object.keys(value).length > 0 : true);
        if (nonempty(rule.states) || nonempty(rule.domains) || nonempty(rule.recordSelection) ||
            rule.cards.some((card: any) => nonempty(card.when) ||
                card.fields.some((field: any) => nonempty(field.when)))) reject();
        const addresses = new Set<string>(cards.flatMap((card: any) => card.fields.map((field: any) => field.fieldRecordId)));
        if (addresses.size !== expectedControls.size || [...addresses].some(address =>
            typeof address !== 'string' || !isDescriptorIdentity(address)) ||
            !Array.isArray(extent.fieldHelp) || extent.fieldHelp.length !== addresses.size) reject();
        const helpByAddress = new Map<string, string | null>();
        for (const item of extent.fieldHelp) {
            if (!item || !addresses.has(item.fieldRecordId) || helpByAddress.has(item.fieldRecordId) ||
                (item.help !== null && typeof item.help !== 'string')) reject();
            helpByAddress.set(item.fieldRecordId, item.help);
        }
        const projectedCards = cards.map((card: any) => ({ ...card, fields: card.fields.map((field: any) => {
            const { help: _historicalHelp, ...descriptor } = field;
            const help = helpByAddress.get(field.fieldRecordId);
            return help === null ? descriptor : { ...descriptor, help };
        }) }));
        // This is a descriptor/record consumer policy, not native GUI state.
        // Keep historical snapshots on disk only, outside the effective rule.
        const { initialSnapshot: _historicalSnapshot, ...effective } = rule;
        return { ...effective, cards: projectedCards };
    }
    const snapshot = extent.initialSnapshot;
    if (!snapshot || !Array.isArray(snapshot.cardOrder) ||
        JSON.stringify(snapshot.cardOrder) !== JSON.stringify(cards.map((card: any) => card.cardIndex)) ||
        !Array.isArray(snapshot.controls) || snapshot.controls.length !== expectedControls.size) reject();
    const seen = new Set<string>();
    for (const control of snapshot.controls) {
        const expected = expectedControls.get(control.controlId);
        if (!expected || seen.has(control.controlId) || expected.cardIndex !== control.cardIndex ||
            expected.fieldIndex !== control.fieldIndex || typeof control.visible !== 'boolean' ||
            typeof control.enabled !== 'boolean') reject();
        seen.add(control.controlId);
    }
    return { ...rule, cards, initialSnapshot: snapshot };
}

export class CatalogInputFormCatalogV4 {
    private manifest: any | null = null;
    private manifestError: Error | null = null;
    private readonly rootDir: string;
    private readonly readFile: (filePath: string) => Buffer;
    private readonly readFileAsync: (filePath: string) => Promise<Buffer>;
    private readonly preparing = new Map<string, Promise<void>>();
    private manifestPreparation: Promise<any> | undefined;
    private readonly cache: ByteLru<LoadedShard>;
    private readonly allowUnaudited: boolean;

    constructor(options: CatalogInputFormCatalogOptions = {}) {
        this.rootDir = path.resolve(options.rootDir || defaultRuntimeRoot());
        this.readFile = options.readFile || ((filePath: string) => fs.readFileSync(filePath));
        this.readFileAsync = options.readFile ? async filePath => this.readFile(filePath)
            : filePath => fs.promises.readFile(filePath);
        this.allowUnaudited = options.allowUnaudited ?? (process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG === '1');
        this.cache = new ByteLru<LoadedShard>(
            Number.isFinite(options.maximumCacheBytes)
                ? Math.max(0, Number(options.maximumCacheBytes))
                : DEFAULT_CACHE_BYTES,
        );
    }

    private loadManifest(prepared?: Buffer): any {
        if (this.manifestError) throw this.manifestError;
        if (this.manifest) return this.manifest;
        try {
            const manifestPath = this.rootDir === path.resolve(defaultRuntimeRoot())
                ? path.join(__dirname, '..', '..', 'runtime', 'lspp-input-form', 'manifest.json')
                : path.join(this.rootDir, 'manifest.json');
            const value = JSON.parse((prepared || this.readFile(manifestPath)).toString('utf8'));
            if (!value || value.schemaVersion !== 4 ||
                (value.storageVersion !== undefined && value.storageVersion !== 1) ||
                value.kind !== "keyword-input-form-manifest" ||
                !/^[a-f0-9]{64}$/.test(value.dataset?.sha256 || '') ||
                !value.shards || !value.keywords) {
                throw new Error('Input Form manifest is incomplete or unsupported');
            }
            if (value.summary?.conservationSatisfied !== true ||
                value.summary?.unresolvedRelations !== 0 ||
                value.summary?.safeWriteGaps !== 0) {
                throw new Error('Input Form manifest has not passed conservation and safe-write checks');
            }
            if (!/^[a-f0-9]{64}$/.test(value.auditSha256 || '')) {
                if (this.allowUnaudited) {
                    value.isUnauditedDiagnostic = true;
                } else {
                    throw new Error('Input Form manifest auditSha256 is missing or invalid');
                }
            }
            this.manifest = value;
            return value;
        } catch (error) {
            this.manifestError = error instanceof Error ? error : new Error(String(error));
            throw this.manifestError;
        }
    }

    private shardLocation(contentHash: string, manifest: any) {
        const descriptor = manifest.shards[contentHash];
        if (!descriptor || descriptor.uncompressedSha256 !== contentHash ||
            (manifest.storageVersion === 1 && (!Number.isSafeInteger(descriptor.uncompressedBytes) ||
                descriptor.uncompressedBytes <= 0 || descriptor.uncompressedBytes > 16 * 1024 * 1024 ||
                !new RegExp(`^${contentHash}\\.json\\.(gz|br)$`).test(descriptor.file))) ||
            typeof descriptor.file !== 'string') {
            throw new Error(`Input Form shard is missing: ${contentHash}`);
        }
        const shardPath = path.resolve(this.rootDir, descriptor.file.replace(/^card_conditions\.v4[\\/]/, ''));
        const relative = path.relative(this.rootDir, shardPath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Input Form shard path is unsafe: ${descriptor.file}`);
        }
        return { descriptor, shardPath };
    }

    private loadShard(contentHash: string, manifest: any, prepared?: { encoded: Buffer; decoded: Buffer }): LoadedShard {
        const cached = this.cache.get(contentHash);
        if (cached) return cached;
        const { descriptor, shardPath } = this.shardLocation(contentHash, manifest);
        const encoded = prepared?.encoded || this.readFile(shardPath);
        if (encoded.length !== descriptor.compressedBytes || sha256(encoded) !== descriptor.sha256) {
            throw new Error(`Input Form shard integrity mismatch: ${contentHash}`);
        }
        const decode = descriptor.file.endsWith('.json.br') ? zlib.brotliDecompressSync : zlib.gunzipSync;
        const decoded = prepared?.decoded || decode(encoded, { maxOutputLength: descriptor.uncompressedBytes });
        if (decoded.length !== descriptor.uncompressedBytes || sha256(decoded) !== contentHash) {
            throw new Error(`Input Form shard content mismatch: ${contentHash}`);
        }
        const payload = JSON.parse(decoded.toString('utf8'));
        if (!payload || payload.schemaVersion !== 4 ||
            payload.kind !== "keyword-input-form-shard" ||
            payload.datasetSha256 !== manifest.dataset.sha256 ||
            !payload.keywords || !payload.rules) {
            throw new Error(`Input Form shard payload is invalid: ${contentHash}`);
        }
        const loaded: LoadedShard = { keywords: payload.keywords, rules: payload.rules,
            projectedRules: new Map() };
        this.cache.set(contentHash, loaded, decoded.length);
        return loaded;
    }

    async prepareKeyword(keyword: string): Promise<void> {
        if (!this.manifest) {
            if (!this.manifestPreparation) {
                const file = this.rootDir === path.resolve(defaultRuntimeRoot())
                    ? path.join(__dirname, '..', '..', 'runtime', 'lspp-input-form', 'manifest.json')
                    : path.join(this.rootDir, 'manifest.json');
                this.manifestPreparation = this.readFileAsync(file).then(bytes => this.loadManifest(bytes))
                    .finally(() => { this.manifestPreparation = undefined; });
            }
            await this.manifestPreparation;
        }
        const manifest = this.loadManifest();
        let normalized = normalizeKeyword(keyword);
        if (this.rootDir === path.resolve(defaultRuntimeRoot())) normalized = contactThermalCatalogKeyword(normalized) || normalized;
        if (!manifest.keywords[normalized]) {
            const alias = require(keywordDataPath("native-readers/lspp-node-readers.json"))?.bindings?.[normalized]?.aliasOf ||
                require("./catalogNativeFileLayout").nativeSpellingBinding(normalized)?.referenceKeyword;
            if (alias && manifest.keywords[alias]) normalized = alias;
        }
        const index = manifest.keywords[normalized];
        if (!index) return;
        if (manifest.storageVersion === 1 && index) {
            // Sequential decompression bounds transient memory when a form spans buckets.
            for (const hash of this.compactRuleShards(index)) await this.prepareShard(hash, manifest);
        } else if (index.shard) {
            await this.prepareShard(index.shard, manifest);
        }
        if (!manifest.isUnauditedDiagnostic && this.rootDir === path.resolve(defaultRuntimeRoot())) {
            const shard = manifest.storageVersion === 1 ? this.compactShard(normalized, index, manifest)
                : this.loadShard(index.shard, manifest);
            const reference = shard.keywords[normalized];
            const ids = new Set<string>(Object.values(reference || {}).filter(Array.isArray).flat() as string[]);
            const fields = [...ids].flatMap(id => {
                const rule = shard.rules[id];
                return [...(rule?.cards || []), ...(rule?.recordSelection?.cards || [])].flatMap(card => card.fields || []);
            });
            await require('./nativeDescriptorHelp').prepareNativeDescriptorHelp(fields);
        }
    }

    private compactRuleShards(index: any): string[] {
        if (!index.reference || !Array.isArray(index.ruleShards) || index.ruleShards.length > 128 ||
            index.ruleShards.some((hash: any) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))
            throw new Error('Input Form shared rule index is invalid');
        return index.ruleShards;
    }

    private compactShard(keyword: string, index: any, manifest: any): LoadedShard {
        const rules: Record<string, any> = {};
        const ids = new Set<string>(Object.values(index.reference || {}).filter(Array.isArray).flat() as string[]);
        for (const hash of this.compactRuleShards(index)) {
            const shard = this.loadShard(hash, manifest);
            for (const id of ids) if (Object.prototype.hasOwnProperty.call(shard.rules, id)) {
                if (Object.prototype.hasOwnProperty.call(rules, id)) throw new Error(`Duplicate shared rule: ${id}`);
                // Never expose objects held by the shared bucket cache to consumers.
                rules[id] = JSON.parse(JSON.stringify(shard.rules[id]));
            }
        }
        return { keywords: { [keyword]: JSON.parse(JSON.stringify(index.reference)) }, rules, projectedRules: new Map() };
    }

    private async prepareShard(hash: string, manifest: any): Promise<void> {
        if (this.cache.get(hash)) return;
        if (this.preparing.has(hash)) return this.preparing.get(hash);
        const preparation = (async () => {
            const { descriptor, shardPath } = this.shardLocation(hash, manifest);
            const encoded = await this.readFileAsync(shardPath);
            if (encoded.length !== descriptor.compressedBytes || sha256(encoded) !== descriptor.sha256) {
                throw new Error(`Input Form shard integrity mismatch: ${hash}`);
            }
            const decoded = await new Promise<Buffer>((resolve, reject) => {
                const callback = (error: Error | null, value: Buffer) => error ? reject(error) : resolve(value);
                const options = { maxOutputLength: descriptor.uncompressedBytes };
                if (descriptor.file.endsWith('.json.br')) zlib.brotliDecompress(encoded, options, callback);
                else zlib.gunzip(encoded, options, callback);
            });
            await new Promise(resolve => setTimeout(resolve, 0));
            // Reuse every synchronous integrity and payload check after async I/O/decompression.
            this.loadShard(hash, manifest, { encoded, decoded });
            await new Promise(resolve => setTimeout(resolve, 0));
        })();
        this.preparing.set(hash, preparation);
        try { await preparation; } finally { this.preparing.delete(hash); }
    }

    formForKeyword(keyword: string, composeContactThermal = true): CatalogInputForm | null {
        let normalized = normalizeKeyword(keyword);
        if (!normalized) return null;
        const manifest = this.loadManifest();
        const requested = normalized;
        const composition = composeContactThermal && this.rootDir === path.resolve(defaultRuntimeRoot());
        if (composition) normalized = contactThermalCatalogKeyword(normalized) || normalized;
        let index = manifest.keywords[normalized];
        if (!index) {
            const alias = require(keywordDataPath("native-readers/lspp-node-readers.json"))?.bindings?.[normalized]?.aliasOf ||
                require("./catalogNativeFileLayout").nativeSpellingBinding(normalized)?.referenceKeyword;
            if (alias && manifest.keywords[alias]) {
                normalized = alias;
                index = manifest.keywords[alias];
            }
        }
        if (!index || (manifest.storageVersion !== 1 && typeof index.shard !== 'string')) return null;
        const shard = manifest.storageVersion === 1 ? this.compactShard(normalized, index, manifest)
            : this.loadShard(index.shard, manifest);
        const reference = shard.keywords[normalized];
        if (!reference) throw new Error(`Input Form shard omitted ${normalized}`);
        if (Array.isArray(reference.formRuleIds) && reference.formRuleIds.some((ruleId: string) =>
            shard.rules[ruleId]?.nativeDescriptorExtent?.consumption === 'static-descriptor-records') &&
            Array.isArray(reference.fieldRuleIds) && reference.fieldRuleIds.length > 0) {
            throw new Error('native descriptor extent conflicts with field state rules');
        }
        const ruleIds = Object.values(reference).filter(Array.isArray).flat();
        if (ruleIds.some(ruleId => !shard.rules[ruleId])) {
            throw new Error(`Input Form rules are incomplete for ${normalized}`);
        }
        // A shard contains many unrelated forms. Validate/project only the requested
        // rules here; eagerly joining native help for every form blocks first Hover.
        const rules = Object.fromEntries(ruleIds.map(ruleId => {
            if (!shard.projectedRules.has(ruleId)) {
                const nativeHelp = !manifest.isUnauditedDiagnostic && this.rootDir === path.resolve(defaultRuntimeRoot())
                    ? require('./nativeDescriptorHelp').withNativeDescriptorHelp : (rule: any) => rule;
                const projected = nativeHelp(projectNativeDescriptorExtent(shard.rules[ruleId], manifest.dataset.sha256));
                // Serialize legacy projections once; each read still owns its nested values.
                shard.projectedRules.set(ruleId, manifest.storageVersion === 1 ? projected : serialize(projected));
            }
            const projected = shard.projectedRules.get(ruleId);
            return [ruleId, manifest.storageVersion === 1 ? projected : deserialize(projected)];
        }));
        const form: CatalogInputForm = {
            keyword: normalized,
            reference: manifest.storageVersion === 1 ? reference : structuredClone(reference),
            rules,
            source: {
                schemaVersion: 4,
                datasetVersion: String(manifest.dataset.datasetVersion || ''),
                datasetSha256: manifest.dataset.sha256,
                conservationSatisfied: manifest.isUnauditedDiagnostic ? false : true,
                isUnauditedDiagnostic: Boolean(manifest.isUnauditedDiagnostic),
            },
        };
        return composition ? withContactThermalForm(form, requested) : form;
    }

    resolveFormForKeyword(keyword: string): CatalogInputForm | null {
        return this.formForKeyword(keyword);
    }

    summary(): any {
        const manifest = this.loadManifest();
        return {
            schemaVersion: 4,
            datasetVersion: manifest.dataset.datasetVersion,
            datasetSha256: manifest.dataset.sha256,
            keywordCount: Object.keys(manifest.keywords).length,
            shardCount: manifest.sourceShardCount ?? Object.keys(manifest.shards).length,
            safeWriteGaps: [],
        };
    }
}

let defaultCatalog: CatalogInputFormCatalogV4 | null = null;
let defaultCatalogAllowUnaudited: boolean | undefined;

export function getCatalogInputFormCatalogV4(options?: CatalogInputFormCatalogOptions): CatalogInputFormCatalogV4 {
    const requestedAllowUnaudited = options?.allowUnaudited ??
        (process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG === '1');
    const needsRecreate = !defaultCatalog ||
        (options?.rootDir !== undefined) ||
        (requestedAllowUnaudited !== defaultCatalogAllowUnaudited);
    if (needsRecreate) {
        defaultCatalog = new CatalogInputFormCatalogV4(options);
        defaultCatalogAllowUnaudited = requestedAllowUnaudited;
    }
    return defaultCatalog;
}

export function resetCatalogInputFormCatalogV4ForTesting(): void {
    defaultCatalog = null;
    defaultCatalogAllowUnaudited = undefined;
}

export const reloadCatalogInputFormCatalogV4 = resetCatalogInputFormCatalogV4ForTesting;
