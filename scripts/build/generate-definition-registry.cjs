'use strict';
// Public deterministic compiler; external collection and certification are separate.
const crypto = require('node:crypto');

const RELATION_KINDS = new Set(['entity-definition', 'entity-reference', 'value-branch']);

function fail(message) {
    throw new Error(message);
}

function requireCondition(condition, message) {
    if (!condition) fail(message);
}

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

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function isSha256(value) {
    return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function isStableId(value, prefix) {
    return new RegExp(`^${prefix}:[0-9a-f]{24}$`).test(String(value || ''));
}

function validateAuthorityLock(lock) {
    requireCondition(
        lock?.schemaVersion === 1 && lock.kind === 'dynasense-definition-registry-authority-lock',
        'Invalid Definition Registry authority lock',
    );
    const source = lock.source;
    requireCondition(
        source?.repositoryPath === 'lspp-keyword-database/normalized/link_census/authoring_semantic_handoff',
        'Definition Registry source repository path changed',
    );
    requireCondition(/^[0-9a-f]{40}$/.test(source.standaloneCommit || ''), 'Invalid standalone source commit');
    requireCondition(isSha256(source.manifestSha256), 'Invalid authoring handoff manifest SHA-256');
    requireCondition(isSha256(source.contentSha256), 'Invalid authoring handoff content SHA-256');
    requireCondition(
        Number.isInteger(source.relationShards) && source.relationShards === 16 &&
        Number.isInteger(source.authoringRelations) && source.authoringRelations > 0 &&
        Number.isInteger(source.distinctManualRelations) && source.distinctManualRelations > 0 &&
        source.distinctManualRelations <= source.authoringRelations &&
        Number.isInteger(source.familyProjectionRelations) && source.familyProjectionRelations >= 0 &&
        source.familyProjectionRelations <= source.authoringRelations &&
        Number.isInteger(source.uniqueCoordinates) && source.uniqueCoordinates > 0 &&
        source.uniqueCoordinates <= source.authoringRelations,
        'Invalid authoring handoff source counts',
    );
    requireCondition(canonicalJson(lock.permissions) === canonicalJson({
        definitionRegistryRuntimePermission: true,
        fieldClassifierOverlayPermission: true,
        definitionIndexOverlayPermission: true,
        f12Permission: true,
        referenceProviderPermission: true,
        diagnosticPermission: false,
        automaticMutationPermission: false,
    }), 'Definition Registry permission boundary changed');
    const capacity = lock.capacity;
    requireCondition(
        Number.isInteger(capacity?.maxRuntimeBytes) && capacity.maxRuntimeBytes >= 1024 &&
        Number.isInteger(capacity?.maxKeywords) && capacity.maxKeywords >= 1 &&
        Number.isInteger(capacity?.maxRelations) && capacity.maxRelations >= source.authoringRelations &&
        Number.isInteger(capacity?.maxCoordinates) && capacity.maxCoordinates >= source.uniqueCoordinates &&
        Number.isInteger(capacity?.maxRelationsPerCoordinate) && capacity.maxRelationsPerCoordinate >= 1,
        'Invalid Definition Registry capacity contract',
    );
}

function validateFamilyProjection(projection, fieldKeywordForm, fieldName, context) {
    if (projection === undefined) return false;
    const evidence = projection?.officialEvidence;
    const chapter = evidence?.chapter;
    requireCondition(
        isStableId(projection?.familyProjectionId, 'family-projection') &&
        isStableId(projection?.projectionApprovalId, 'family-projection-approval') &&
        /^\*[A-Z0-9_+%\-]+$/.test(projection.manualKeyword || '') &&
        /^[A-Z0-9_+%\-]+$/.test(projection.option || '') &&
        projection.concreteKeyword === fieldKeywordForm &&
        String(projection.field || '').toUpperCase() === String(fieldName || '').toUpperCase() &&
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

function validateSemanticCorrection(correction, relation, context) {
    if (correction === undefined) return false;
    const evidence = correction?.evidence;
    const basis = correction?.basis;
    requireCondition(
        isStableId(correction?.correctionId, 'manual-relation-semantic-correction') &&
        isSha256(correction?.sourceSemanticSha256) &&
        RELATION_KINDS.has(correction?.originalKind) &&
        correction.originalRelation?.kind === correction.originalKind &&
        correction.originalKind !== relation?.kind &&
        relation?.kind === 'entity-definition' &&
        relation.relation?.kind === 'entity-definition' &&
        typeof relation.relation?.targetKind === 'string' && relation.relation.targetKind.length > 0 &&
        isStableId(evidence?.evidenceId, 'evidence') &&
        typeof evidence?.manualId === 'string' && evidence.manualId.length > 0 &&
        Number.isInteger(evidence?.page) && evidence.page > 0 && isSha256(evidence?.quoteSha256) &&
        Array.isArray(relation?.evidence) && relation.evidence.some(item =>
            canonicalJson(item) === canonicalJson(evidence)) &&
        basis?.code === 'unique-identifier-defines-entity' &&
        typeof basis.structuredSummary === 'string' && /\bunique\b/i.test(basis.structuredSummary) &&
        /\b(?:id|identifier|number)\b/i.test(basis.structuredSummary) &&
        isSha256(basis.structuredSummarySha256) &&
        basis.structuredSummarySha256 === sha256Bytes(Buffer.from(
            canonicalJson(basis.structuredSummary), 'utf8')),
        `${context}: invalid official semantic correction provenance`,
    );
    return true;
}

function projectRecord(record) {
    const field = record.fieldIdentity;
    const manual = record.manualRelation;
    const review = record.reviewProvenance;
    return canonicalize({
        authoringRelationId: record.authoringRelationId,
        coordinateId: record.coordinateId,
        field: {
            keyword: field.canonicalKeyword,
            keywordForm: field.keywordForm,
            cardIndex: field.schemaCardIndex + 1,
            fieldIndex: field.schemaFieldIndex,
            fieldName: field.fieldName,
            fieldType: field.fieldType,
            position: field.position,
            width: field.width,
            cardFieldCount: field.cardFieldCount,
            cardSignature: field.cardSignature,
        },
        manualRelationId: manual.manualRelationId,
        sourceRuleId: manual.sourceRuleId,
        kind: manual.kind,
        relation: manual.relation,
        evidence: manual.evidence,
        fieldLayoutEvidence: manual.fieldLayoutEvidence,
        ...(manual.semanticCorrection ? { semanticCorrection: manual.semanticCorrection } : {}),
        ...(record.familyProjection ? { familyProjection: record.familyProjection } : {}),
        review: {
            semanticReviewId: review.semanticReviewId,
            semanticJoinId: review.semanticJoinId,
            decisionId: review.decisionId,
            authorityBasis: review.authorityBasis,
            retainedClassification: review.retainedClassification,
            retainedReviewState: review.retainedReviewState,
            retainedReasonCodes: review.retainedReasonCodes,
            semanticFingerprint: review.semanticFingerprint,
            toolObservationFingerprint: review.toolObservationFingerprint,
        },
    });
}

function registryContentHash(core) {
    return sha256Bytes(Buffer.from(canonicalJson(core), 'utf8'));
}

function buildRegistry(handoff, authorityLock, authorityLockSha256) {
    validateAuthorityLock(authorityLock);
    requireCondition(isSha256(authorityLockSha256), 'Invalid authority-lock SHA-256');
    const byKeyword = {};
    const kinds = {};
    const coordinateCounts = new Map();
    const manualRelationIds = new Set();
    const projected = handoff.records.map(projectRecord)
        .sort((left, right) => left.authoringRelationId.localeCompare(right.authoringRelationId));
    for (const relation of projected) {
        const keyword = normalizeKeyword(relation.field.keyword);
        requireCondition(keyword, `${relation.authoringRelationId}: empty normalized keyword`);
        if (!byKeyword[keyword]) byKeyword[keyword] = [];
        byKeyword[keyword].push(relation);
        kinds[relation.kind] = (kinds[relation.kind] || 0) + 1;
        manualRelationIds.add(relation.manualRelationId);
        coordinateCounts.set(relation.coordinateId, (coordinateCounts.get(relation.coordinateId) || 0) + 1);
    }
    for (const relations of Object.values(byKeyword)) {
        relations.sort((left, right) => left.authoringRelationId.localeCompare(right.authoringRelationId));
    }
    const summary = canonicalize({
        keywords: Object.keys(byKeyword).length,
        relations: projected.length,
        coordinates: coordinateCounts.size,
        distinctManualRelations: manualRelationIds.size,
        familyProjectionRelations: projected.filter(relation => relation.familyProjection).length,
        maxRelationsPerCoordinate: Math.max(...coordinateCounts.values()),
        relationKinds: kinds,
    });
    const capacity = authorityLock.capacity;
    requireCondition(
        summary.keywords <= capacity.maxKeywords && summary.relations <= capacity.maxRelations &&
        summary.coordinates <= capacity.maxCoordinates &&
        summary.maxRelationsPerCoordinate <= capacity.maxRelationsPerCoordinate,
        'Definition Registry capacity exceeded',
    );
    const core = canonicalize({
        schemaVersion: 1,
        kind: 'dynasense-definition-registry',
        generatorVersion: 3,
        projection: {
            format: 'semantic-runtime-v3',
            derivedFieldsOmitted: ['branchAudit', 'targets'],
            derivationSource: 'relation',
            provenanceRetention: 'stable-identities-and-official-evidence',
            semanticCorrectionPolicy: 'preserve-when-present',
        },
        source: {
            authorityLockSha256,
            standaloneCommit: authorityLock.source.standaloneCommit,
            authoringHandoffManifestSha256: authorityLock.source.manifestSha256,
            authoringHandoffContentSha256: authorityLock.source.contentSha256,
        },
        permissions: authorityLock.permissions,
        capacity: authorityLock.capacity,
        summary,
        byKeyword: canonicalize(byKeyword),
    });
    return { ...core, contentSha256: registryContentHash(core) };
}

function validateRegistry(registry, authorityLock, serializedBytes = null) {
    validateAuthorityLock(authorityLock);
    requireCondition(
        registry?.schemaVersion === 1 && registry.kind === 'dynasense-definition-registry' &&
        registry.generatorVersion === 3,
        'Unsupported Definition Registry runtime',
    );
    requireCondition(canonicalJson(registry.projection) === canonicalJson({
        format: 'semantic-runtime-v3',
        derivedFieldsOmitted: ['branchAudit', 'targets'],
        derivationSource: 'relation',
        provenanceRetention: 'stable-identities-and-official-evidence',
        semanticCorrectionPolicy: 'preserve-when-present',
    }), 'Definition Registry projection contract changed');
    requireCondition(
        registry.source?.standaloneCommit === authorityLock.source.standaloneCommit &&
        registry.source?.authoringHandoffManifestSha256 === authorityLock.source.manifestSha256 &&
        registry.source?.authoringHandoffContentSha256 === authorityLock.source.contentSha256 &&
        isSha256(registry.source?.authorityLockSha256),
        'Definition Registry source lock drift',
    );
    requireCondition(
        canonicalJson(registry.permissions) === canonicalJson(authorityLock.permissions) &&
        canonicalJson(registry.capacity) === canonicalJson(authorityLock.capacity),
        'Definition Registry policy drift',
    );
    const { contentSha256, ...core } = registry;
    requireCondition(isSha256(contentSha256) && registryContentHash(core) === contentSha256, 'Definition Registry content hash drift');
    const relations = Object.values(registry.byKeyword || {}).flat();
    requireCondition(
        relations.length === registry.summary?.relations &&
        Object.keys(registry.byKeyword || {}).length === registry.summary?.keywords &&
        new Set(relations.map(item => item.authoringRelationId)).size === relations.length &&
        new Set(relations.map(item => item.coordinateId)).size === registry.summary?.coordinates,
        'Definition Registry summary drift',
    );
    for (const [keyword, keywordRelations] of Object.entries(registry.byKeyword || {})) {
        requireCondition(normalizeKeyword(keyword) === keyword && Array.isArray(keywordRelations), `Invalid registry keyword: ${keyword}`);
        for (const relation of keywordRelations) {
            requireCondition(
                normalizeKeyword(relation?.field?.keyword) === keyword &&
                isStableId(relation?.authoringRelationId, 'authoring-relation') &&
                isStableId(relation?.coordinateId, 'field-coordinate') &&
                isStableId(relation?.sourceRuleId, 'rule') && RELATION_KINDS.has(relation?.kind) &&
                relation?.relation?.kind === relation.kind && Array.isArray(relation?.evidence) &&
                relation.evidence.length > 0 &&
                !Object.prototype.hasOwnProperty.call(relation, 'targets') &&
                !Object.prototype.hasOwnProperty.call(relation, 'branchAudit'),
                `${keyword}: invalid registry relation`,
            );
            validateFamilyProjection(
                relation.familyProjection,
                relation.field.keywordForm,
                relation.field.fieldName,
                relation.authoringRelationId,
            );
            validateSemanticCorrection(
                relation.semanticCorrection,
                relation,
                relation.authoringRelationId,
            );
        }
    }
    requireCondition(
        new Set(relations.map(item => item.manualRelationId)).size === registry.summary?.distinctManualRelations &&
        registry.summary.distinctManualRelations === authorityLock.source.distinctManualRelations &&
        relations.filter(item => item.familyProjection).length === registry.summary?.familyProjectionRelations &&
        registry.summary.familyProjectionRelations === authorityLock.source.familyProjectionRelations,
        'Definition Registry manual relation or family projection summary drift',
    );
    if (serializedBytes) {
        requireCondition(serializedBytes.length <= authorityLock.capacity.maxRuntimeBytes, 'Definition Registry byte capacity exceeded');
    }
    return registry;
}

module.exports = { buildRegistry, validateRegistry };
