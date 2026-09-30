import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/**
 * Read-only bridge for the efficiency-first relaxed description prototype.
 *
 * The source is deliberately kept outside SemanticRuntimeCatalogV2. A relaxed
 * model judgment can provide an authoring/preview description, but it never
 * becomes a reference, option-migration, definition-registry, F12, mutation,
 * or completeness authority.
 */

const STATIC_SOURCE_IDENTITIES: ReadonlyArray<{ kind: string; manifestSha256: string; contentSha256: string }> = [{"kind":"field-description-remaining-obligation-v38-manifest","manifestSha256":"5e8ce24861e232dbdd9905d1b1ccd367d876e2d2b0cdb49b6135743af3c915d1","contentSha256":"dba272469eabbb8c91a59b33a3e23933194081d6879ea404ebb6271fe62a06e7"},{"kind":"dynasense-public-relaxed-model-fixture-v1","manifestSha256":"b89b23e7abf50a204043ec53b7b79996b771832081cedc2213cc8a461ee080d0","contentSha256":"feb7cb8e625b52b7d48a4e1ce6b933c1d116d5ed7dbd43ab8647e9bb336efa6e"}];
const SHARD_PREFIXES = '0123456789abcdef'.split('');

export type RelaxedModelDescriptionRecordV1 = {
    finalPhysicalFieldId: string;
    finalTableId: string;
    fieldNameNormalized: string;
    sectionId: string;
    cardLabel: string;
    columnOrdinal: number;
    manualId: string;
    officialDescriptionText: string;
    descriptionStatus: 'approved-relaxed-model-semantic-judgment';
    bindingStatus: 'approved-relaxed-model-semantic-judgment';
    descriptionEvidence: {
        approvalBasis: 'model-semantic-judgment-v1';
        confidence: number;
        evidenceStandard: 'relaxed';
        exactIndependentLabeledProseRequired: false;
        humanReviewed: false;
        independentVerificationPerformed: false;
        modelSemanticAuthorizationGranted: true;
        renderCaptureRequired: false;
        relaxedConditionsUsed: string[];
        sourcePages: Array<Record<string, unknown>>;
        [key: string]: unknown;
    };
    descriptionEvidenceCount: number;
    descriptionEvidenceIds: string[];
    descriptionEvidenceKind: 'relaxed-model-semantic-judgment';
    sourceLookupObligationId: null;
    descriptionBindingApprovalPermission: true;
    pluginRuntimePermission: false;
    optionMigrationPermission: false;
    definitionRegistryPermission: false;
    semanticClassificationPermission: false;
    f12Permission: false;
    completenessClaimPermission: false;
    [key: string]: unknown;
};

export type RelaxedModelEvidenceV1Manifest = {
    schemaVersion: 1;
    kind: string;
    contentSha256: string;
    fieldShards: Array<{
        path: string;
        prefix: string;
        records: number;
        sha256: string;
    }>;
    policy: Record<string, boolean>;
    source: Record<string, unknown>;
    summary: Record<string, number>;
};

type ReadFile = (filePath: string) => Buffer;

function sha256(value: Buffer | string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: any): any {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
    }
    return value;
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

function assertContract(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function safeJoin(root: string | null, relative: string): string {
    assertContract(root !== null, 'relaxed model source is not configured');
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(root, relative);
    const relativePath = path.relative(resolvedRoot, resolved);
    assertContract(relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath),
        `relaxed model shard path is unsafe: ${relative}`);
    return resolved;
}

function validatePolicy(policy: any): void {
    const expected = {
        approvedBindingConsolidationPermission: true,
        completenessClaimPermission: false,
        definitionRegistryPermission: false,
        f12Permission: false,
        humanFieldReviewRequired: false,
        independentVerificationRequired: false,
        optionMigrationPermission: false,
        pluginRuntimePermission: false,
        relaxedModelApprovalAccepted: true,
        semanticClassificationPermission: false,
        signedValueDomainPermission: false,
    };
    assertContract(canonicalJson(policy) === canonicalJson(expected),
        'relaxed model policy is not the isolated v1 policy');
}

function validateManifest(raw: any, encoded: Buffer): RelaxedModelEvidenceV1Manifest {
    const encodedSha256 = sha256(encoded);
    const identity = STATIC_SOURCE_IDENTITIES.find(item => item.manifestSha256 === encodedSha256);
    assertContract(identity,
        'relaxed model source manifest file identity drift');
    assertContract(raw?.schemaVersion === 1 && raw.kind === identity.kind,
        'unsupported relaxed model source manifest');
    assertContract(raw.contentSha256 === identity.contentSha256,
        'relaxed model source manifest content identity drift');
    validatePolicy(raw.policy);
    assertContract(Array.isArray(raw.fieldShards) && raw.fieldShards.length === SHARD_PREFIXES.length,
        'relaxed model shard set is incomplete');
    const prefixes = raw.fieldShards.map((shard: any) => shard?.prefix);
    assertContract(SHARD_PREFIXES.every(prefix => prefixes.filter((value: any) => value === prefix).length === 1),
        'relaxed model shard prefixes are not unique');
    for (const shard of raw.fieldShards) {
        assertContract(SHARD_PREFIXES.includes(shard.prefix) &&
            shard.path === `fields/${shard.prefix}.json.gz` &&
            Number.isSafeInteger(shard.records) && shard.records >= 0 &&
            /^[0-9a-f]{64}$/.test(shard.sha256 || ''),
        `invalid relaxed model shard descriptor: ${shard?.prefix}`);
    }
    assertContract(Number.isSafeInteger(raw.summary?.approvedRelaxedModelV1Fields),
        'relaxed model summary is missing approved count');
    return raw as RelaxedModelEvidenceV1Manifest;
}

function validateSourceRecord(value: any): value is RelaxedModelDescriptionRecordV1 {
    const evidence = value?.descriptionEvidence;
    return value?.schemaVersion === 1 &&
        value.kind === 'field-description-relaxed-model-approval-record' &&
        /^global-manual-(?:physical|html-physical)-field:[0-9a-f]+$/.test(value.finalPhysicalFieldId || '') &&
        /^global-manual-card-grid:[0-9a-f]+$/.test(value.finalTableId || '') &&
        typeof value.fieldNameNormalized === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value.fieldNameNormalized) &&
        typeof value.sectionId === 'string' && value.sectionId.length > 0 &&
        typeof value.cardLabel === 'string' && /^Card [1-9][0-9]*$/.test(value.cardLabel) &&
        Number.isSafeInteger(value.columnOrdinal) && value.columnOrdinal >= 0 &&
        typeof value.manualId === 'string' && value.manualId.length > 0 &&
        typeof value.officialDescriptionText === 'string' && value.officialDescriptionText.length > 0 &&
        value.descriptionStatus === 'approved-relaxed-model-semantic-judgment' &&
        value.bindingStatus === 'approved-relaxed-model-semantic-judgment' &&
        value.descriptionBindingApprovalPermission === true &&
        value.pluginRuntimePermission === false &&
        value.optionMigrationPermission === false &&
        value.definitionRegistryPermission === false &&
        value.semanticClassificationPermission === false &&
        value.f12Permission === false &&
        value.completenessClaimPermission === false &&
        value.sourceLookupObligationId === null &&
        value.descriptionEvidenceCount === 1 &&
        Array.isArray(value.descriptionEvidenceIds) && value.descriptionEvidenceIds.length === 1 &&
        value.descriptionEvidenceKind === 'relaxed-model-semantic-judgment' &&
        evidence?.approvalBasis === 'model-semantic-judgment-v1' &&
        Number.isFinite(evidence.confidence) && evidence.confidence >= 0 && evidence.confidence <= 1 &&
        evidence.evidenceStandard === 'relaxed' &&
        evidence.exactIndependentLabeledProseRequired === false &&
        evidence.humanReviewed === false &&
        evidence.independentVerificationPerformed === false &&
        evidence.modelSemanticAuthorizationGranted === true &&
        evidence.renderCaptureRequired === false &&
        Array.isArray(evidence.relaxedConditionsUsed) && evidence.relaxedConditionsUsed.length > 0 &&
        Array.isArray(evidence.sourcePages) && evidence.sourcePages.length > 0;
}

function readShard(
    root: string | null,
    descriptor: RelaxedModelEvidenceV1Manifest['fieldShards'][number],
    readFile: ReadFile,
): any[] {
    const encoded = readFile(safeJoin(root, descriptor.path));
    assertContract(sha256(encoded) === descriptor.sha256,
        `relaxed model shard identity drift: ${descriptor.prefix}`);
    const payload = JSON.parse(zlib.gunzipSync(encoded).toString('utf8'));
    assertContract(payload?.schemaVersion === 1 &&
        payload.kind === 'field-description-remaining-obligation-shard' &&
        payload.prefix === descriptor.prefix &&
        Array.isArray(payload.records) && payload.records.length === descriptor.records,
    `relaxed model shard payload is invalid: ${descriptor.prefix}`);
    const relaxedRecords = payload.records.filter((record: any) =>
        record?.descriptionStatus === 'approved-relaxed-model-semantic-judgment' ||
        record?.kind === 'field-description-relaxed-model-approval-record');
    assertContract(relaxedRecords.every(validateSourceRecord),
        `relaxed model source record is invalid: ${descriptor.prefix}`);
    return payload.records;
}

export function relaxedModelEvidenceV1Root(): string | null {
    const configured = String(process.env.DYNASENSE_RELAXED_MODEL_ROOT || '').trim();
    if (configured) return path.resolve(configured);
    return null;
}

export class RelaxedModelEvidenceV1Catalog {
    private readonly root: string | null;
    private readonly readFile: ReadFile;
    private manifestValue: RelaxedModelEvidenceV1Manifest | null = null;
    private sourceManifestSha256Value: string | null = null;
    private recordsValue: RelaxedModelDescriptionRecordV1[] | null = null;
    private recordsById = new Map<string, RelaxedModelDescriptionRecordV1>();
    private failureReasonValue = '';

    constructor(root: string | null = relaxedModelEvidenceV1Root(), readFile: ReadFile = (filePath: string) => fs.readFileSync(filePath)) {
        this.root = root === null ? null : path.resolve(root);
        this.readFile = readFile;
    }

    status(): { ready: boolean; sourceManifestSha256: string | null; approvedRecords: number; failureReason: string } {
        if (this.failureReasonValue) {
            return {
                ready: false,
                sourceManifestSha256: null,
                approvedRecords: 0,
                failureReason: this.failureReasonValue,
            };
        }
        try {
            const manifest = this.manifest();
            const records = this.records();
            return {
                ready: true,
                sourceManifestSha256: this.sourceManifestSha256Value,
                approvedRecords: records.length,
                failureReason: '',
            };
        } catch (error) {
            this.failureReasonValue = error instanceof Error ? error.message : String(error);
            return {
                ready: false,
                sourceManifestSha256: null,
                approvedRecords: 0,
                failureReason: this.failureReasonValue,
            };
        }
    }

    manifest(): RelaxedModelEvidenceV1Manifest {
        if (this.manifestValue) return this.manifestValue;
        const encoded = this.readFile(safeJoin(this.root, 'manifest.json'));
        this.manifestValue = validateManifest(JSON.parse(encoded.toString('utf8')), encoded);
        this.sourceManifestSha256Value = sha256(encoded);
        return this.manifestValue;
    }

    records(): RelaxedModelDescriptionRecordV1[] {
        if (this.recordsValue) return this.recordsValue;
        const manifest = this.manifest();
        const sourceRecords = manifest.fieldShards
            .slice()
            .sort((left, right) => left.prefix.localeCompare(right.prefix))
            .flatMap(descriptor => readShard(this.root, descriptor, this.readFile))
            .sort((left, right) => String(left.finalPhysicalFieldId || '').localeCompare(String(right.finalPhysicalFieldId || '')));
        const { contentSha256, ...core } = manifest;
        assertContract(sha256(canonicalJson({ core: canonicalize(core), records: sourceRecords })) === contentSha256,
            'relaxed model source manifest content drift');
        assertContract(sourceRecords.length === manifest.summary.finalPhysicalFields,
            'relaxed model source population drift');
        const records = sourceRecords.filter(validateSourceRecord);
        assertContract(records.length === manifest.summary.approvedRelaxedModelV1Fields,
            'relaxed model approved count does not match source manifest');
        assertContract(new Set(records.map(record => record.finalPhysicalFieldId)).size === records.length,
            'relaxed model source contains duplicate physical field identities');
        this.recordsById = new Map(records.map(record => [record.finalPhysicalFieldId, record]));
        this.recordsValue = records;
        return records;
    }

    recordForField(finalPhysicalFieldId: string): RelaxedModelDescriptionRecordV1 | null {
        if (this.failureReasonValue) return null;
        try {
            this.records();
            return this.recordsById.get(String(finalPhysicalFieldId || '')) || null;
        } catch (error) {
            this.failureReasonValue = error instanceof Error ? error.message : String(error);
            return null;
        }
    }

    recordsForFieldName(fieldName: string): RelaxedModelDescriptionRecordV1[] {
        if (this.failureReasonValue) return [];
        try {
            const normalized = String(fieldName || '').trim().toUpperCase();
            return this.records().filter(record => record.fieldNameNormalized === normalized);
        } catch (error) {
            this.failureReasonValue = error instanceof Error ? error.message : String(error);
            return [];
        }
    }

    /** Explicitly false: this catalog cannot grant runtime/reference/mutation authority. */
    runtimeEligible(): false { return false; }

    /** Explicitly false: relaxed descriptions have no write or migration plan. */
    mutationEligible(): false { return false; }

    clear(): void {
        this.manifestValue = null;
        this.sourceManifestSha256Value = null;
        this.recordsValue = null;
        this.recordsById.clear();
        this.failureReasonValue = '';
    }
}

let defaultCatalog: RelaxedModelEvidenceV1Catalog | null = null;

export function getRelaxedModelEvidenceV1Catalog(): RelaxedModelEvidenceV1Catalog {
    if (!defaultCatalog) defaultCatalog = new RelaxedModelEvidenceV1Catalog();
    return defaultCatalog;
}

export function resetRelaxedModelEvidenceV1CatalogForTesting(): void {
    defaultCatalog = null;
}

module.exports = {
    RelaxedModelEvidenceV1Catalog,
    getRelaxedModelEvidenceV1Catalog,
    resetRelaxedModelEvidenceV1CatalogForTesting,
    relaxedModelEvidenceV1Root,
};
