'use strict';

const crypto = require('node:crypto');
const { getSemanticRuntimeCatalogV2 } = require('../semantics/semanticRuntimeV2');

const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;
const MAX_KEYWORDS = 100_000;
const MAX_RELATIONS = 1_000_000;
const MAX_COORDINATES = 1_000_000;
const MAX_RELATIONS_PER_COORDINATE = 32;
const RELATION_KINDS = new Set(['entity-definition', 'entity-reference', 'value-branch']);
const FORBIDDEN_AUTHORING_KEYS = new Set([
    'legacyCandidates',
    'rawLinkCode',
    'sourceLocator',
    'toolObservation',
]);

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
    }
    return value;
}

function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

function finishSteps(steps) {
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
}

async function finishStepsAsync(steps) {
    let started = performance.now(), count = 0, step = steps.next();
    while (!step.done) {
        if (++count % 64 === 0 && performance.now() - started >= 8) {
            await new Promise<void>(resolve => setImmediate(resolve));
            started = performance.now();
        }
        step = steps.next();
    }
    return step.value;
}

/** Stream canonical bytes one relation at a time; never retain another whole catalog string. */
function* canonicalChunks(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth >= 3) {
        yield canonicalJson(value);
        return;
    }
    const array = Array.isArray(value);
    yield array ? '[' : '{';
    const keys = array ? Array.from({ length: value.length }, (_, i) => String(i))
        : Object.keys(value).sort().filter(key => value[key] !== undefined);
    for (let i = 0; i < keys.length; i++) {
        if (i) yield ',';
        if (!array) yield JSON.stringify(keys[i]) + ':';
        yield* canonicalChunks(value[keys[i]] === undefined ? null : value[keys[i]], depth + 1);
    }
    yield array ? ']' : '}';
}

function* canonicalDigestSteps(value) {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    for (const chunk of canonicalChunks(value)) {
        hash.update(chunk);
        bytes += Buffer.byteLength(chunk);
        yield;
    }
    return { sha256: hash.digest('hex'), bytes };
}

// Small headers and summaries; full catalog hashing uses canonicalDigestSteps.
function* canonicalJsonSteps(value) {
    yield;
    return canonicalJson(value);
}

function* assertNoAuthoringPayloadSteps(value) {
    if (!value || typeof value !== 'object') return;
    yield;
    for (const [key, child] of Object.entries(value)) {
        assertContract(!FORBIDDEN_AUTHORING_KEYS.has(key), `registry: forbidden authoring key ${key}`);
        yield* assertNoAuthoringPayloadSteps(child);
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function normalizeFieldName(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeFieldType(value) {
    return String(value || '').trim().toLowerCase();
}

function isSha256(value) {
    return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function isStableId(value, prefix) {
    return new RegExp(`^${prefix}:[0-9a-f]{24}$`).test(String(value || ''));
}

function assertContract(condition, message) {
    if (!condition) throw new Error(message);
}

function targetSummary(relation) {
    const branches = Array.isArray(relation?.branches) ? relation.branches : [];
    return {
        keywords: [...new Set([
            ...(relation?.targetKeywords || []),
            ...branches.flatMap(branch => branch?.targetKeywords || []),
        ])],
        kinds: [...new Set([
            ...(relation?.targetKinds || []),
            ...(relation?.targetKind ? [relation.targetKind] : []),
            ...branches.flatMap(branch => branch?.targetKinds || []),
        ])],
    };
}

function validatePredicate(predicate, context) {
    assertContract(predicate && typeof predicate === 'object', `${context}: predicate is missing`);
    const op = String(predicate.op || '').toLowerCase();
    assertContract(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'in', 'not-in'].includes(op),
        `${context}: unsupported predicate operator`);
    if (op === 'in' || op === 'not-in') {
        assertContract(Array.isArray(predicate.values) && predicate.values.length > 0,
            `${context}: predicate values are invalid`);
    } else {
        assertContract(Number.isFinite(predicate.value) || typeof predicate.value === 'string',
            `${context}: predicate value is invalid`);
    }
}

function validateFamilyProjection(projection, field, context) {
    if (projection === undefined) return false;
    const evidence = projection?.officialEvidence;
    const chapter = evidence?.chapter;
    assertContract(
        isStableId(projection?.familyProjectionId, 'family-projection') &&
        isStableId(projection?.projectionApprovalId, 'family-projection-approval') &&
        /^\*[A-Z0-9_+%\-]+$/.test(projection.manualKeyword || '') &&
        /^[A-Z0-9_+%\-]+$/.test(projection.option || '') &&
        projection.concreteKeyword === field?.keywordForm &&
        normalizeFieldName(projection.field) === normalizeFieldName(field?.fieldName) &&
        isSha256(evidence?.optionQuoteSha256) && isSha256(evidence?.cardQuoteSha256) &&
        typeof chapter?.chapterPath === 'string' && chapter.chapterPath.length > 0 &&
        !chapter.chapterPath.includes('..') && isSha256(chapter.chapterSha256) &&
        typeof chapter.manualId === 'string' && chapter.manualId.length > 0 &&
        typeof chapter.manualRevision === 'string' && chapter.manualRevision.length > 0 &&
        isSha256(chapter.manualPdfSha256) && Array.isArray(chapter.physicalPages) &&
        chapter.physicalPages.length > 0 && chapter.physicalPages.every(page =>
            Number.isInteger(page) && page > 0),
        `${context}: invalid official family projection provenance`,
    );
    return true;
}

function validateSemanticCorrection(correction, record, context) {
    if (correction === undefined) return false;
    const evidence = correction?.evidence;
    const basis = correction?.basis;
    assertContract(
        isStableId(correction?.correctionId, 'manual-relation-semantic-correction') &&
        isSha256(correction?.sourceSemanticSha256) &&
        RELATION_KINDS.has(correction?.originalKind) &&
        correction.originalRelation?.kind === correction.originalKind &&
        correction.originalKind !== record?.kind &&
        record?.kind === 'entity-definition' && record.relation?.kind === 'entity-definition' &&
        typeof record.relation?.targetKind === 'string' && record.relation.targetKind.length > 0 &&
        isStableId(evidence?.evidenceId, 'evidence') &&
        typeof evidence?.manualId === 'string' && evidence.manualId.length > 0 &&
        Number.isInteger(evidence?.page) && evidence.page > 0 && isSha256(evidence?.quoteSha256) &&
        Array.isArray(record?.evidence) && record.evidence.some(item =>
            canonicalJson(item) === canonicalJson(evidence)) &&
        basis?.code === 'unique-identifier-defines-entity' &&
        typeof basis.structuredSummary === 'string' && /\bunique\b/i.test(basis.structuredSummary) &&
        /\b(?:id|identifier|number)\b/i.test(basis.structuredSummary) &&
        isSha256(basis.structuredSummarySha256) &&
        basis.structuredSummarySha256 === sha256(Buffer.from(
            canonicalJson(basis.structuredSummary), 'utf8')),
        `${context}: invalid official semantic correction provenance`,
    );
    return true;
}

function validateRelationShape(record, keyword) {
    const relation = record.relation;
    assertContract(RELATION_KINDS.has(record.kind) && relation?.kind === record.kind, `${keyword}: invalid relation kind`);
    const branches = Array.isArray(relation.branches) ? relation.branches : [];
    for (const [index, branch] of branches.entries()) {
        assertContract(['reference', 'enum', 'literal', 'sentinel'].includes(branch?.role), `${keyword}: invalid branch role`);
        validatePredicate(branch.when, `${keyword}.branches[${index}]`);
        if (branch.role === 'reference') {
            assertContract(['identity', 'abs', 'negate'].includes(branch.idTransform), `${keyword}: invalid reference transform`);
            assertContract(
                (branch.targetKinds || []).length > 0 || (branch.targetKeywords || []).length > 0,
                `${keyword}: reference branch has no target`,
            );
        } else {
            assertContract(
                !Object.prototype.hasOwnProperty.call(branch, 'idTransform'),
                `${keyword}: non-reference branch has an ID transform`,
            );
        }
    }
    if (record.kind === 'entity-definition') {
        const targets = targetSummary(relation);
        assertContract(targets.kinds.length > 0 || targets.keywords.length > 0,
            `${keyword}: definition target missing`);
        assertContract(branches.length === 0, `${keyword}: definition relation must not branch`);
    }
    if (record.kind === 'entity-reference') {
        const targets = targetSummary(relation);
        assertContract(targets.kinds.length > 0 || targets.keywords.length > 0, `${keyword}: reference target missing`);
    }
    if (record.kind === 'value-branch') {
        assertContract(branches.length > 0 && relation.otherwise === 'unknown', `${keyword}: incomplete value-domain partition`);
    }
    assertContract(
        !Object.prototype.hasOwnProperty.call(record, 'targets') &&
        !Object.prototype.hasOwnProperty.call(record, 'branchAudit'),
        `${keyword}: derived relation payload must not be serialized`,
    );
}

function validateDefinitionRegistryRuntime(registry) {
    return finishSteps(validateDefinitionRegistrySteps(registry));
}

function* validateDefinitionRegistrySteps(registry) {
    if (registry?.projection?.format === 'operational-semantic-runtime-v1') {
        return yield* validateOperationalDefinitionRegistrySteps(registry);
    }
    assertContract(
        registry?.schemaVersion === 1 && registry.kind === 'dynasense-definition-registry' &&
        registry.generatorVersion === 3,
        'Unsupported Definition Registry runtime',
    );
    assertContract((yield* canonicalJsonSteps(registry.projection)) === (yield* canonicalJsonSteps({
        format: 'semantic-runtime-v3',
        derivedFieldsOmitted: ['branchAudit', 'targets'],
        derivationSource: 'relation',
        provenanceRetention: 'stable-identities-and-official-evidence',
        semanticCorrectionPolicy: 'preserve-when-present',
    })), 'Definition Registry projection contract changed');
    assertContract(registry.source && typeof registry.source === 'object' &&
        typeof registry.source.datasetReleaseId === 'string' &&
        /^semantic-dataset:[0-9a-f]{24}$/.test(registry.source.datasetReleaseId),
    'Definition Registry source identity invalid');
    assertContract((yield* canonicalJsonSteps(registry.permissions)) === (yield* canonicalJsonSteps({
        definitionRegistryRuntimePermission: true,
        fieldClassifierOverlayPermission: true,
        definitionIndexOverlayPermission: true,
        f12Permission: true,
        referenceProviderPermission: true,
        diagnosticPermission: false,
        automaticMutationPermission: false,
    })), 'Definition Registry permission drift');
    assertContract(registry.capacity?.maxRuntimeBytes <= MAX_RUNTIME_BYTES &&
        registry.capacity?.maxKeywords <= MAX_KEYWORDS && registry.capacity?.maxRelations <= MAX_RELATIONS &&
        registry.capacity?.maxCoordinates <= MAX_COORDINATES &&
        registry.capacity?.maxRelationsPerCoordinate <= MAX_RELATIONS_PER_COORDINATE,
    'Definition Registry capacity invalid');
    const { contentSha256, ...core } = registry;
    const digest = yield* canonicalDigestSteps(core);
    assertContract(
        isSha256(contentSha256) && digest.sha256 === contentSha256,
        'Definition Registry content hash drift',
    );
    assertContract(digest.bytes + Buffer.byteLength(JSON.stringify({ contentSha256 })) - 1 <= MAX_RUNTIME_BYTES, 'Definition Registry byte capacity exceeded');
    yield* assertNoAuthoringPayloadSteps(registry);

    const keywordEntries = Object.entries(registry.byKeyword || {});
    assertContract(keywordEntries.length <= MAX_KEYWORDS, 'Definition Registry keyword capacity exceeded');
    assertContract(
        (yield* canonicalJsonSteps(keywordEntries.map(([keyword]) => keyword))) ===
        (yield* canonicalJsonSteps(keywordEntries.map(([keyword]) => keyword).sort())),
        'Definition Registry keywords are not deterministic',
    );
    const allRelations = [];
    const relationIds = new Set();
    const recordsByRuleId = new Map();
    const manualRelationIds = new Set();
    let familyProjectionRelations = 0;
    const coordinateCounts = new Map();
    const kinds = {};
    for (const [keyword, relations] of keywordEntries) {
        assertContract(normalizeKeyword(keyword) === keyword && Array.isArray(relations), `Invalid registry keyword: ${keyword}`);
        let previousId = '';
        for (const record of relations as any[]) {
            yield;
            const field = record?.field;
            assertContract(
                normalizeKeyword(field?.keyword) === keyword &&
                typeof field.keywordForm === 'string' && field.keywordForm.length > 0 &&
                Number.isInteger(field.cardIndex) && field.cardIndex >= 1 &&
                Number.isInteger(field.fieldIndex) && field.fieldIndex >= 0 &&
                typeof field.fieldName === 'string' && field.fieldName.length > 0 &&
                typeof field.fieldType === 'string' && field.fieldType.length > 0 &&
                Number.isInteger(field.position) && field.position >= 0 &&
                Number.isInteger(field.width) && field.width > 0 &&
                Number.isInteger(field.cardFieldCount) && field.cardFieldCount > field.fieldIndex &&
                isSha256(field.cardSignature),
                `${keyword}: invalid field coordinate`,
            );
            assertContract(
                isStableId(record.authoringRelationId, 'authoring-relation') &&
                isStableId(record.coordinateId, 'field-coordinate') &&
                isStableId(record.manualRelationId, 'manual-relation') &&
                isStableId(record.sourceRuleId, 'rule') &&
                record.authoringRelationId > previousId,
                `${keyword}: invalid or non-deterministic relation identity`,
            );
            previousId = record.authoringRelationId;
            assertContract(!relationIds.has(record.authoringRelationId), `${keyword}: duplicate authoring relation ID`);
            relationIds.add(record.authoringRelationId);
            if (!recordsByRuleId.has(record.sourceRuleId)) recordsByRuleId.set(record.sourceRuleId, []);
            recordsByRuleId.get(record.sourceRuleId).push(record);
            manualRelationIds.add(record.manualRelationId);
            if (validateFamilyProjection(record.familyProjection, field, record.authoringRelationId)) {
                familyProjectionRelations += 1;
            }
            validateRelationShape(record, keyword);
            validateSemanticCorrection(record.semanticCorrection, record, record.authoringRelationId);
            assertContract(Array.isArray(record.evidence) && record.evidence.length > 0, `${keyword}: evidence missing`);
            for (const evidence of record.evidence) {
                assertContract(
                    isStableId(evidence?.evidenceId, 'evidence') && typeof evidence.manualId === 'string' &&
                    Number.isInteger(evidence.page) && evidence.page > 0 && isSha256(evidence.quoteSha256),
                    `${keyword}: invalid official-manual evidence`,
                );
            }
            const review = record.review;
            assertContract(
                isStableId(review?.semanticReviewId, 'semantic-review-decision') &&
                isStableId(review?.semanticJoinId, 'semantic-join') &&
                isStableId(review?.decisionId, 'semantic-review-decision') &&
                typeof review.retainedReviewState === 'string' &&
                typeof review.retainedClassification === 'string' &&
                Array.isArray(review.retainedReasonCodes) && isSha256(review.semanticFingerprint) &&
                isSha256(review.toolObservationFingerprint),
                `${keyword}: invalid review provenance`,
            );
            coordinateCounts.set(record.coordinateId, (coordinateCounts.get(record.coordinateId) || 0) + 1);
            kinds[record.kind] = (kinds[record.kind] || 0) + 1;
            allRelations.push(record);
        }
    }
    assertContract(allRelations.length <= MAX_RELATIONS, 'Definition Registry relation capacity exceeded');
    assertContract(coordinateCounts.size <= MAX_COORDINATES, 'Definition Registry coordinate capacity exceeded');
    const maxPerCoordinate = Math.max(...coordinateCounts.values());
    assertContract(maxPerCoordinate <= MAX_RELATIONS_PER_COORDINATE, 'Definition Registry co-located relation capacity exceeded');
    for (const [ruleId, records] of recordsByRuleId) {
        if (records.length === 1) continue;
        assertContract(
            records.every(record => record.familyProjection) &&
            new Set(records.map(record => record.manualRelationId)).size === 1 &&
            new Set(records.map(record => record.coordinateId)).size === records.length,
            `${ruleId}: duplicate source rule lacks one-to-many official family provenance`,
        );
    }
    assertContract((yield* canonicalJsonSteps(registry.summary)) === (yield* canonicalJsonSteps({
        keywords: keywordEntries.length,
        relations: allRelations.length,
        coordinates: coordinateCounts.size,
        distinctManualRelations: manualRelationIds.size,
        familyProjectionRelations,
        maxRelationsPerCoordinate: maxPerCoordinate,
        relationKinds: kinds,
    })), 'Definition Registry summary drift');
    return registry;
}

function* validateOperationalDefinitionRegistrySteps(registry) {
    assertContract(
        registry?.schemaVersion === 1 && registry.kind === 'dynasense-definition-registry' &&
        registry.generatorVersion === 3,
        'Unsupported operational Definition Registry runtime',
    );
    assertContract((yield* canonicalJsonSteps(registry.projection)) === (yield* canonicalJsonSteps({
        format: 'operational-semantic-runtime-v1',
        derivedFieldsOmitted: ['branchAudit', 'targets'],
        derivationSource: 'operational-semantic-projection-v1',
        provenanceRetention: 'stable-identities-and-source-provenance',
        semanticCorrectionPolicy: 'preserve-when-present',
    })), 'Operational Definition Registry projection contract changed');
    assertContract(registry.source && /^semantic-dataset:[0-9a-f]{24}$/.test(registry.source.datasetReleaseId || '') &&
        registry.source.publicationMode === 'operational-defaults' &&
        Number.isInteger(registry.source.sourceManualRelations) && registry.source.sourceManualRelations > 0,
    'Operational Definition Registry source identity invalid');
    assertContract((yield* canonicalJsonSteps(registry.permissions)) === (yield* canonicalJsonSteps({
        definitionRegistryRuntimePermission: true,
        fieldClassifierOverlayPermission: true,
        definitionIndexOverlayPermission: true,
        f12Permission: true,
        referenceProviderPermission: true,
        diagnosticPermission: false,
        automaticMutationPermission: false,
    })), 'Operational Definition Registry permission drift');
    assertContract(registry.capacity?.maxRuntimeBytes <= MAX_RUNTIME_BYTES &&
        registry.capacity?.maxKeywords <= MAX_KEYWORDS && registry.capacity?.maxRelations <= MAX_RELATIONS &&
        registry.capacity?.maxCoordinates <= MAX_COORDINATES &&
        registry.capacity?.maxRelationsPerCoordinate <= MAX_RELATIONS_PER_COORDINATE,
    'Operational Definition Registry capacity invalid');
    const { contentSha256, ...core } = registry;
    const digest = yield* canonicalDigestSteps(core);
    assertContract(isSha256(contentSha256) &&
        digest.sha256 === contentSha256,
    'Operational Definition Registry content hash drift');
    assertContract(digest.bytes + Buffer.byteLength(JSON.stringify({ contentSha256 })) - 1 <= MAX_RUNTIME_BYTES,
        'Operational Definition Registry byte capacity exceeded');
    yield* assertNoAuthoringPayloadSteps(registry);

    const keywordEntries = Object.entries(registry.byKeyword || {});
    assertContract(keywordEntries.length <= MAX_KEYWORDS && (yield* canonicalJsonSteps(keywordEntries.map(([keyword]) => keyword))) ===
        (yield* canonicalJsonSteps(keywordEntries.map(([keyword]) => keyword).sort())),
    'Operational Definition Registry keywords are not deterministic');
    const relationIds = new Set();
    const manualRelationIds = new Set();
    const coordinateCounts = new Map();
    const kinds = {};
    let relationCount = 0;
    let familyProjectionRelations = 0;
    for (const [keyword, relations] of keywordEntries) {
        assertContract(normalizeKeyword(keyword) === keyword && Array.isArray(relations),
            `Invalid operational registry keyword: ${keyword}`);
        let previousId = '';
        for (const record of relations as any[]) {
            yield;
            const field = record?.field;
            assertContract(
                normalizeKeyword(field?.keyword) === keyword && typeof field.keywordForm === 'string' &&
                Number.isInteger(field.cardIndex) && field.cardIndex >= 1 &&
                Number.isInteger(field.fieldIndex) && field.fieldIndex >= 0 &&
                typeof field.fieldName === 'string' && field.fieldName.length > 0 &&
                typeof field.fieldType === 'string' && field.fieldType.length > 0 &&
                Number.isInteger(field.position) && field.position >= 0 &&
                Number.isInteger(field.width) && field.width > 0 &&
                Number.isInteger(field.cardFieldCount) && field.cardFieldCount > field.fieldIndex &&
                isSha256(field.cardSignature),
                `${keyword}: invalid operational field coordinate`,
            );
            assertContract(isStableId(record.authoringRelationId, 'authoring-relation') &&
                isStableId(record.coordinateId, 'field-coordinate') &&
                isStableId(record.manualRelationId, 'manual-relation') &&
                isStableId(record.sourceRuleId, 'rule') && record.authoringRelationId > previousId &&
                !relationIds.has(record.authoringRelationId),
            `${keyword}: invalid operational relation identity`);
            previousId = record.authoringRelationId;
            relationIds.add(record.authoringRelationId);
            validateRelationShape(record, keyword);
            validateSemanticCorrection(record.semanticCorrection, record, record.authoringRelationId);
            assertContract(Array.isArray(record.evidence) && record.evidence.length > 0,
                `${keyword}: operational provenance missing`);
            assertContract(record.operationalProjection && typeof record.operationalProjection.strategy === 'string',
            `${keyword}: operational projection metadata missing`);
            manualRelationIds.add(record.manualRelationId);
            coordinateCounts.set(record.coordinateId, (coordinateCounts.get(record.coordinateId) || 0) + 1);
            kinds[record.kind] = (kinds[record.kind] || 0) + 1;
            if (record.familyProjection) familyProjectionRelations++;
            relationCount++;
        }
    }
    const maxRelationsPerCoordinate = Math.max(0, ...coordinateCounts.values());
    assertContract(relationCount <= MAX_RELATIONS && coordinateCounts.size <= MAX_COORDINATES &&
        maxRelationsPerCoordinate <= MAX_RELATIONS_PER_COORDINATE,
    'Operational Definition Registry relation capacity exceeded');
    assertContract(manualRelationIds.size === registry.source.sourceManualRelations,
        'Operational Definition Registry manual relation conservation failed');
    assertContract((yield* canonicalJsonSteps(registry.summary)) === (yield* canonicalJsonSteps({
        keywords: keywordEntries.length,
        relations: relationCount,
        coordinates: coordinateCounts.size,
        distinctManualRelations: manualRelationIds.size,
        familyProjectionRelations,
        maxRelationsPerCoordinate,
        relationKinds: kinds,
    })), 'Operational Definition Registry summary drift');
    return registry;
}

function* registryFacadeSteps(records = getSemanticRuntimeCatalogV2().allReferenceRecords()) {
    const catalog = getSemanticRuntimeCatalogV2();
    const manifest = catalog.manifest();
    assertContract(catalog.status().ready, 'Definition Registry semantic catalog is unavailable');
    assertContract(records.length === manifest.summary.referenceRelations, 'Definition Registry reference population drift');
    const operational = manifest.source?.producerHandoff?.publicationMode === 'operational-defaults';
    const byKeyword: Record<string, any[]> = {};
    for (const record of records) {
        yield;
        const keyword = normalizeKeyword(record.field?.keyword);
        if (!byKeyword[keyword]) byKeyword[keyword] = [];
        const { schemaVersion: _schemaVersion, disposition: _disposition,
            permissions: _permissions, field, ...legacy } = record;
        const { formats: _formats, ...legacyField } = field;
        byKeyword[keyword].push({ ...legacy, field: legacyField });
    }
    for (const relations of Object.values(byKeyword)) {
        relations.sort((left, right) => left.authoringRelationId.localeCompare(right.authoringRelationId));
    }
    const all = Object.values(byKeyword).flat();
    const coordinateCounts = new Map<string, number>();
    const manualRelationIds = new Set<string>();
    let familyProjectionRelations = 0;
    const relationKinds: Record<string, number> = {};
    for (const record of all) {
        coordinateCounts.set(record.coordinateId, (coordinateCounts.get(record.coordinateId) || 0) + 1);
        manualRelationIds.add(record.manualRelationId);
        if (record.familyProjection) familyProjectionRelations++;
        relationKinds[record.kind] = (relationKinds[record.kind] || 0) + 1;
    }
    const core = {
        schemaVersion: 1,
        kind: 'dynasense-definition-registry',
        generatorVersion: 3,
        projection: {
            format: operational ? 'operational-semantic-runtime-v1' : 'semantic-runtime-v3',
            derivedFieldsOmitted: ['branchAudit', 'targets'],
            derivationSource: operational ? 'operational-semantic-projection-v1' : 'relation',
            provenanceRetention: operational
                ? 'stable-identities-and-source-provenance' : 'stable-identities-and-official-evidence',
            semanticCorrectionPolicy: 'preserve-when-present',
        },
        source: { datasetReleaseId: manifest.datasetReleaseId,
            ...(operational ? { publicationMode: 'operational-defaults',
                sourceManualRelations: manifest.summary.sourceManualRelations } : {}) },
        permissions: {
            definitionRegistryRuntimePermission: manifest.permissions.referenceNavigation === true,
            fieldClassifierOverlayPermission: manifest.permissions.referenceNavigation === true,
            definitionIndexOverlayPermission: manifest.permissions.referenceNavigation === true,
            f12Permission: manifest.permissions.referenceNavigation === true,
            referenceProviderPermission: manifest.permissions.reverseReferenceNavigation === true,
            diagnosticPermission: false,
            automaticMutationPermission: false,
        },
        capacity: {
            maxRuntimeBytes: MAX_RUNTIME_BYTES,
            maxKeywords: MAX_KEYWORDS,
            maxRelations: MAX_RELATIONS,
            maxCoordinates: MAX_COORDINATES,
            maxRelationsPerCoordinate: MAX_RELATIONS_PER_COORDINATE,
        },
        summary: {
            keywords: Object.keys(byKeyword).length,
            relations: all.length,
            coordinates: coordinateCounts.size,
            distinctManualRelations: manualRelationIds.size,
            familyProjectionRelations,
            maxRelationsPerCoordinate: Math.max(...coordinateCounts.values()),
            relationKinds,
        },
        byKeyword: Object.fromEntries(Object.keys(byKeyword).sort().map(key => [key, byKeyword[key]])),
    };
    return { ...core, contentSha256: (yield* canonicalDigestSteps(core)).sha256 };
}

function selectorMatchesRecord(selector, record) {
    const field = record?.field;
    return !!selector && !!field &&
        selector.cardIndex === field.cardIndex && selector.fieldIndex === field.fieldIndex &&
        normalizeFieldName(selector.fieldName) === normalizeFieldName(field.fieldName) &&
        normalizeFieldType(selector.fieldType) === normalizeFieldType(field.fieldType) &&
        selector.position === field.position && selector.width === field.width;
}

function manualRuleMatchesRecord(rule, record) {
    return !!rule && !!record && rule.ruleId === record.sourceRuleId && rule.kind === record.kind &&
        normalizeKeyword(rule.keyword) === normalizeKeyword(record.field?.keyword) &&
        selectorMatchesRecord(rule.selector, record) &&
        canonicalJson(rule.relation) === canonicalJson(record.relation);
}

class DefinitionRegistryCatalog {
    private rawRegistry: any;
    private state: 'unloaded' | 'ready' | 'failed';
    private failureReason: string;
    private readonly rulesById: Map<string, any[]>;
    private readonly definitionDescriptorCache: Map<string, any>;
    private preparation: Promise<boolean> | null = null;

    constructor(rawRegistry = null) {
        this.rawRegistry = rawRegistry;
        this.state = 'unloaded';
        this.failureReason = '';
        this.rulesById = new Map();
        this.definitionDescriptorCache = new Map();
    }

    ensureLoaded() {
        if (this.state !== 'unloaded') return this.state === 'ready';
        try {
            if (!this.rawRegistry) this.rawRegistry = finishSteps(registryFacadeSteps());
            validateDefinitionRegistryRuntime(this.rawRegistry);
            this.install();
            return true;
        } catch (error) { return this.fail(error); }
    }

    private install() {
        for (const relations of Object.values(this.rawRegistry.byKeyword)) {
            for (const relation of relations as any[]) {
                if (!this.rulesById.has(relation.sourceRuleId)) {
                    this.rulesById.set(relation.sourceRuleId, []);
                }
                this.rulesById.get(relation.sourceRuleId)!.push(relation);
            }
        }
        this.state = 'ready';
    }

    private fail(error) {
        this.rulesById.clear();
        this.failureReason = error instanceof Error ? error.message : String(error);
        this.state = 'failed';
        return false;
    }

    prepare(): Promise<boolean> {
        if (this.state === 'failed' && !this.rawRegistry && !this.preparation) {
            this.state = 'unloaded';
            this.failureReason = '';
        }
        if (this.state !== 'unloaded') return Promise.resolve(this.state === 'ready');
        if (this.preparation) return this.preparation;
        this.preparation = (async () => {
            try {
                const registry = this.rawRegistry || await finishStepsAsync(registryFacadeSteps(
                    (await getSemanticRuntimeCatalogV2().prepareReferences()).records));
                await finishStepsAsync(validateDefinitionRegistrySteps(registry));
                if (this.state === 'unloaded') { this.rawRegistry = registry; this.install(); }
                return this.state === 'ready';
            } catch (error) { return this.fail(error); }
        })().finally(() => { this.preparation = null; });
        return this.preparation;
    }

    status() {
        const ready = this.ensureLoaded();
        return { ready, state: this.state, failureReason: this.failureReason };
    }

    permission(name) {
        if (!this.ensureLoaded()) return false;
        return this.rawRegistry.permissions?.[String(name || '')] === true;
    }

    rulesForKeyword(keyword) {
        if (!this.ensureLoaded()) return [];
        const normalized = normalizeKeyword(keyword);
        return this.rawRegistry.byKeyword[normalized] || [];
    }

    ruleForSourceRuleId(ruleId) {
        if (!this.ensureLoaded()) return null;
        const records = this.rulesById.get(String(ruleId || '')) || [];
        return records.length === 1 ? records[0] : null;
    }

    rulesForSourceRuleId(ruleId) {
        if (!this.ensureLoaded()) return [];
        return this.rulesById.get(String(ruleId || '')) || [];
    }

    definitionRecords() {
        if (!this.ensureLoaded()) return [];
        return Object.values(this.rawRegistry.byKeyword || {}).flat().filter((record: any) =>
            record.kind === 'entity-definition'
        );
    }

    definitionDescriptorForKeyword(keyword) {
        if (!this.permission('definitionIndexOverlayPermission')) return null;
        const requestedKeyword = normalizeKeyword(keyword);
        if (this.definitionDescriptorCache.has(requestedKeyword)) {
            return this.definitionDescriptorCache.get(requestedKeyword);
        }
        const finish = descriptor => {
            this.definitionDescriptorCache.set(requestedKeyword, descriptor);
            return descriptor;
        };
        let definitions = this.rulesForKeyword(requestedKeyword).filter(record =>
            record.kind === 'entity-definition'
        );

        // Definition records are authored against the canonical spelling (for
        // example SET_PART), while the document may use a schema alias such as
        // SET_PART_LIST_TITLE. Resolve the alias through the real rendered card
        // layout so a title card changes the physical card index correctly.
        let requestedLookup = null;
        let sourceLookup = null;
        if (definitions.length === 0) {
            try {
                const schema = require('../keywordSchema');
                requestedLookup = schema.lookupKeywordSchema(requestedKeyword);
                if (requestedLookup) {
                    const requestedCanonical = normalizeKeyword(requestedLookup.canonicalName);
                    const aliasCandidates = this.definitionRecords().filter((record: any) => {
                        if (record.kind !== 'entity-definition') return false;
                        const candidateLookup = schema.lookupKeywordSchema(
                            record.field?.keywordForm || record.field?.keyword,
                        );
                        return candidateLookup && normalizeKeyword(candidateLookup.canonicalName) ===
                            requestedCanonical;
                    });
                    definitions = aliasCandidates;
                    if (definitions.length === 1) {
                        sourceLookup = schema.lookupKeywordSchema(
                            definitions[0].field?.keywordForm || definitions[0].field?.keyword,
                        );
                    }
                }
            } catch (_error) {
                definitions = [];
            }
        }
        if (definitions.length !== 1) return finish(null);
        const record = definitions[0];
        const targetKind = record.relation?.targetKind;
        if (typeof targetKind !== 'string' || !targetKind) return finish(null);
        let cardIndex = record.field.cardIndex;
        if (requestedLookup && sourceLookup) {
            try {
                const schema = require('../keywordSchema');
                const sourceCards = schema.getRenderedCardsForLookup(sourceLookup);
                const requestedCards = schema.getRenderedCardsForLookup(requestedLookup);
                const cardSignature = card => JSON.stringify((card || []).map(field => [
                    normalizeFieldName(field?.n), normalizeFieldType(field?.t),
                    field?.p, field?.w,
                ]));
                const sourceSignature = cardSignature(sourceCards[record.field.cardIndex - 1]);
                const sourceMatches = sourceCards.filter(card => cardSignature(card) === sourceSignature);
                const requestedMatches = requestedCards
                    .map((card, index) => ({ card, index }))
                    .filter(item => cardSignature(item.card) === sourceSignature);
                if (!sourceSignature || sourceMatches.length !== 1 || requestedMatches.length !== 1) {
                    return finish(null);
                }
                const requestedCard = requestedMatches[0].card;
                const requestedField = requestedCard[record.field.fieldIndex];
                if (!requestedField || normalizeFieldName(requestedField.n) !==
                    normalizeFieldName(record.field.fieldName) ||
                    normalizeFieldType(requestedField.t) !== normalizeFieldType(record.field.fieldType) ||
                    requestedField.p !== record.field.position || requestedField.w !== record.field.width) {
                    return finish(null);
                }
                cardIndex = requestedMatches[0].index + 1;
            } catch (_error) {
                return finish(null);
            }
        }
        return finish({
            target: normalizeKeyword(record.field.keywordForm),
            targetKind,
            cardIndex,
            fieldIndex: record.field.fieldIndex,
            fieldName: record.field.fieldName,
            fieldType: record.field.fieldType,
            position: record.field.position,
            width: record.field.width,
            ruleId: record.sourceRuleId,
            evidenceIds: record.evidence.map(item => item.evidenceId),
            authority: 'definition-registry-exact-selector',
            authoringRelationId: record.authoringRelationId,
            coordinateId: record.coordinateId,
        });
    }

    approvedRecordForManualRule(rule) {
        const matches = this.rulesForSourceRuleId(rule?.ruleId).filter(record =>
            manualRuleMatchesRecord(rule, record)
        );
        const strict = matches.filter(record => record.review?.retainedReviewState);
        if (strict.length === 1) return strict[0];
        return matches.length === 1 ? matches[0] : null;
    }

    fieldRelations(keyword, cardIndex, field) {
        if (!Number.isInteger(cardIndex) || cardIndex < 1 || !field) return [];
        const fieldName = normalizeFieldName(field.n ?? field.fieldName ?? field);
        return this.rulesForKeyword(keyword).filter(record => {
            const selector = record.field;
            if (selector.cardIndex !== cardIndex || normalizeFieldName(selector.fieldName) !== fieldName) return false;
            if (typeof field !== 'object') return true;
            if (field.t !== undefined && normalizeFieldType(field.t) !== normalizeFieldType(selector.fieldType)) return false;
            if (field.p !== undefined && field.p !== selector.position) return false;
            if (field.w !== undefined && field.w !== selector.width) return false;
            return true;
        });
    }

    definitionRecordForOccurrence(definition) {
        if (!definition || !this.ensureLoaded()) return null;
        if (definition.ruleId) {
            const byRule = this.rulesForSourceRuleId(definition.ruleId).filter(record =>
                record.kind === 'entity-definition'
            );
            const strict = byRule.filter(record => record.review?.retainedReviewState);
            if (strict.length === 1) return strict[0];
            return byRule.length === 1 ? byRule[0] : null;
        }
        const candidates = this.rulesForKeyword(definition.keyword).filter(record =>
            record.kind === 'entity-definition'
        );
        const strict = candidates.filter(record => record.review?.retainedReviewState);
        if (strict.length === 1) return strict[0];
        return candidates.length === 1 ? candidates[0] : null;
    }
}

let defaultCatalog = null;

function getDefinitionRegistryCatalog() {
    if (!defaultCatalog) defaultCatalog = new DefinitionRegistryCatalog();
    return defaultCatalog;
}

function resetDefinitionRegistryForTesting() {
    defaultCatalog = null;
}

module.exports = {
    DefinitionRegistryCatalog,
    canonicalJson,
    getDefinitionRegistryCatalog,
    manualRuleMatchesRecord,
    normalizeKeyword,
    resetDefinitionRegistryForTesting,
    selectorMatchesRecord,
    validateDefinitionRegistryRuntime,
};

export {};
