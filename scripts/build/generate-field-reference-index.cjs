'use strict';
// Public deterministic compiler; external collection and certification are separate.
const crypto = require('crypto');

const fs = require('fs');

const path = require('path');

const zlib = require('zlib');

const repoRoot = path.resolve(__dirname, "../..");

const manualRuntimePath = path.join(repoRoot, 'keywords/runtime/manual-semantics');

const schemaHelpers = () => require("../../out/core/keywordSchema");

const DRAWABLE_DEFINITIONS = new Set([
    'DEFINE_CURVE',
    'DEFINE_CURVE_FUNCTION',
    'DEFINE_CURVE_FUNCTION_TITLE',
    'DEFINE_CURVE_TITLE',
    'DEFINE_TABLE',
    'DEFINE_TABLE_2D',
    'DEFINE_TABLE_2D_TITLE',
    'DEFINE_TABLE_3D',
    'DEFINE_TABLE_3D_TITLE',
    'DEFINE_TABLE_4D',
    'DEFINE_TABLE_4D_TITLE',
    'DEFINE_TABLE_TITLE',
]);

const ON_DEMAND_TARGET_KINDS = new Set(['node', 'element']);

const REGISTRY_OWNED_DEFINITIONS = new Set(['SET_PART']);

function normalizeKeywordName(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0].replace(/\+$/, '');
}

function normalizeFieldName(value) {
    return String(value || '').trim().toUpperCase();
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    }
    return value;
}

function compactBlockedReferences(blocked) {
    const byKeyword = {};
    for (const item of blocked || []) {
        const coordinates = item.sourceCoordinates || [];
        for (const coordinate of coordinates) {
            const keyword = normalizeKeywordName(coordinate.keyword);
            if (!keyword) continue;
            const record = {
                reason: item.reason,
                linkCode: item.linkCode,
                mode: item.mode,
                ...(item.optionValue !== undefined ? { optionValue: item.optionValue } : {}),
                ...(item.targetKind ? { targetKind: item.targetKind } : {}),
                ...(item.targetKeywords?.length ? { targetKeywords: item.targetKeywords } : {}),
                ...Object.fromEntries(Object.entries(coordinate).filter(([key]) => key !== 'keyword')),
            };
            if (!byKeyword[keyword]) byKeyword[keyword] = [];
            const key = JSON.stringify(record);
            if (!byKeyword[keyword].some(candidate => JSON.stringify(candidate) === key)) {
                byKeyword[keyword].push(record);
            }
        }
    }
    return Object.fromEntries(Object.entries(byKeyword).sort(([a], [b]) => a.localeCompare(b)));
}

function writeBlockedRuntime(blockedReferences, destinationPath) {
    const payload = canonical({
        schemaVersion: 1,
        kind: 'dynasense-lspp-reference-blockers',
        blockedReferences,
    });
    const encoded = zlib.gzipSync(Buffer.from(`${JSON.stringify(payload)}\n`), { level: 9, mtime: 0 });
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, encoded);
    return {
        file: "keywords/runtime/references/lspp_reference_blockers.runtime.json.gz",
        sha256: sha256(encoded),
        compressedBytes: encoded.length,
        keywordCount: Object.keys(blockedReferences).length,
        recordCount: Object.values(blockedReferences).reduce((sum, records) => sum + records.length, 0),
    };
}

function isWithin(parent, child) {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function readManualRuntime(runtimeRoot = manualRuntimePath) {
    const manifestPath = path.join(runtimeRoot, 'manifest.json');
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    if (!manifest || manifest.schemaVersion !== 1 ||
        manifest.kind !== 'dynasense-manual-semantic-runtime' ||
        manifest.compression !== 'gzip-json' || !manifest.shards) {
        throw new Error(`Unsupported manual semantic runtime: ${runtimeRoot}`);
    }
    const rules = [];
    for (const [shardId, descriptor] of Object.entries(manifest.shards).sort(([a], [b]) => a.localeCompare(b))) {
        const shardPath = path.resolve(runtimeRoot, descriptor.file);
        if (!isWithin(runtimeRoot, shardPath)) {
            throw new Error(`Unsafe manual semantic shard path: ${descriptor.file}`);
        }
        const encoded = fs.readFileSync(shardPath);
        if (encoded.length !== descriptor.compressedBytes || sha256(encoded) !== descriptor.sha256) {
            throw new Error(`Manual semantic shard integrity mismatch: ${shardId}`);
        }
        const plain = zlib.gunzipSync(encoded);
        const payload = JSON.parse(plain.toString('utf8'));
        if (plain.length !== descriptor.uncompressedBytes ||
            payload.schemaVersion !== 1 || payload.kind !== 'dynasense-manual-semantic-shard' ||
            payload.shard !== shardId || !Array.isArray(payload.rules) ||
            payload.rules.length !== descriptor.rules) {
            throw new Error(`Invalid manual semantic shard payload: ${shardId}`);
        }
        rules.push(...payload.rules);
    }
    return {
        manifest,
        manifestSha256: sha256(manifestBytes),
        rules,
    };
}

function schemaVariants(schema, helpers = schemaHelpers()) {
    const {lookupKeywordSchema} = helpers;
    const byCanonical = new Map();
    for (const keyword of Object.keys(schema).sort()) {
        const lookup = lookupKeywordSchema(keyword, schema);
        if (!lookup) continue;
        const canonical = normalizeKeywordName(lookup.canonicalName);
        if (!byCanonical.has(canonical)) byCanonical.set(canonical, []);
        byCanonical.get(canonical).push({ keyword: normalizeKeywordName(keyword), lookup });
    }
    return byCanonical;
}

function locateDefinitionField(lookup, fieldName, selector = null, helpers = schemaHelpers()) {
    const {getRenderedCards} = helpers;
    const target = normalizeFieldName(selector?.fieldName || fieldName);
    const matches = [];
    const cards = getRenderedCards(lookup.entry, lookup.activeOptions);
    for (let cardOffset = 0; cardOffset < cards.length; cardOffset++) {
        for (let fieldIndex = 0; fieldIndex < (cards[cardOffset] || []).length; fieldIndex++) {
            const field = cards[cardOffset][fieldIndex];
            if (normalizeFieldName(field?.n) !== target) continue;
            if (selector && (
                fieldIndex !== selector.fieldIndex ||
                String(field.t || '').trim().toLowerCase() !== String(selector.fieldType || '').trim().toLowerCase() ||
                field.p !== selector.position ||
                field.w !== selector.width
            )) continue;
            matches.push({
                cardIndex: cardOffset + 1,
                fieldIndex,
                fieldName: target,
                fieldType: field.t,
                position: field.p,
                width: field.w,
            });
        }
    }
    return matches.length === 1 ? { descriptor: matches[0], matches } : { descriptor: null, matches };
}

function definitionTarget(rule, schema, fallbackTarget, helpers = schemaHelpers()) {
    const {lookupKeywordSchema} = helpers;
    const targetKind = rule.relation?.targetKind || null;
    const targetKeywords = (rule.relation?.targetKeywords || []).map(normalizeKeywordName).filter(Boolean);
    const declaredTarget = targetKeywords[0] || fallbackTarget || normalizeKeywordName(rule.keyword);
    const targetLookup = lookupKeywordSchema(declaredTarget, schema);
    return {
        targetKind,
        target: normalizeKeywordName(targetLookup?.canonicalName || declaredTarget),
    };
}

function applyUserReferenceExclusions(handoff, policy) {
    const { contentSha256, ...core } = policy || {};
    const { contentSha256: handoffHash, ...handoffCore } = handoff || {};
    const hashRecord = value => sha256(JSON.stringify(canonical(value)));
    const invalid = () => { throw new Error('User reference exclusion identity mismatch'); };
    if (core.schemaVersion !== 1 || core.kind !== 'dynasense-user-reference-exclusions' ||
        core.authority !== 'explicit-user-decision' || hashRecord(core) !== contentSha256 ||
        core.handoffContentSha256 !== handoffHash || hashRecord(handoffCore) !== handoffHash || !Array.isArray(core.excludedBlocked) ||
        !Array.isArray(core.excludedReferences)) invalid();
    const blocked = new Set(core.excludedBlocked), references = structuredClone(handoff.references);
    if (blocked.size !== core.excludedBlocked.length || handoff.blocked.length !== blocked.size ||
        handoff.blocked.some(record => !blocked.has(hashRecord(record)))) invalid();
    for (const exclusion of core.excludedReferences) {
        const matches = (references[exclusion.keyword] || []).filter(record => hashRecord(record) === exclusion.recordSha256);
        if (matches.length !== 1 || matches[0].fieldName !== exclusion.fieldName || exclusion.disposition !== 'user-excluded') invalid();
        matches[0].relation = { kind: 'non-reference', otherwise: 'non-reference', targetKinds: [], targetKeywords: [] };
        matches[0].userExclusion = { status: 'user-excluded', policyContentSha256: contentSha256 };
    }
    for (const binding of core.confirmedReferenceBindings || []) {
        const matches = (references[binding.keyword] || []).filter(record => hashRecord(record) === binding.recordSha256);
        if (matches.length !== 1 || matches[0].fieldName !== binding.fieldName) invalid();
        Object.assign(matches[0], { relation: binding.relation, siblingTargetBinding: binding.siblingTargetBinding,
            userReferenceDecision: { sourceKind: binding.sourceKind, policyContentSha256: contentSha256, nativeConsumerVerified: false } });
    }
    return { references, blocked: handoff.blocked.filter(record => !blocked.has(hashRecord(record))),
        policy: { contentSha256, excludedSourceBranches: blocked.size, excludedPublishedFields: core.excludedReferences.length,
            confirmedReferenceBindings: core.confirmedReferenceBindings?.length || 0,
            status: 'user-excluded', completenessClaim: false } };
}

function buildIndex(schema, semanticRules, source = {}, lsppHandoff = null, helpers = schemaHelpers(), userExclusions = null) {
    const projection = userExclusions ? applyUserReferenceExclusions(lsppHandoff, userExclusions) : lsppHandoff;
    const {lookupKeywordSchema} = helpers;
    // Runtime classification follows the consumer namespace. The original handoff
    // and its upstream source/content identities remain unchanged.
    const runtimeDescriptor = descriptor => Object.hasOwn(descriptor, 'source')
        ? { ...descriptor, source: "keyword-catalog" } : { ...descriptor };
    const variants = schemaVariants(schema, helpers);
    const descriptors = {};
    const blocked = [];

    for (const rule of (semanticRules || []).filter(item => item?.kind === 'entity-definition')) {
        const sourceLookup = lookupKeywordSchema(rule.keyword, schema);
        const canonical = normalizeKeywordName(sourceLookup?.canonicalName || rule.keyword);
        const candidates = variants.get(canonical) || [];
        if (candidates.length === 0) {
            blocked.push({
                ruleId: rule.ruleId,
                keyword: normalizeKeywordName(rule.keyword),
                fieldName: normalizeFieldName(rule.field),
                reason: 'keyword-not-in-field-schema',
            });
            continue;
        }
        const target = definitionTarget(rule, schema, canonical, helpers);
        for (const candidate of candidates) {
            const located = locateDefinitionField(candidate.lookup, rule.field, rule.selector, helpers);
            if (!located.descriptor || located.descriptor.fieldType !== 'integer') {
                blocked.push({
                    ruleId: rule.ruleId,
                    keyword: candidate.keyword,
                    fieldName: normalizeFieldName(rule.field),
                    reason: !located.descriptor
                        ? located.matches.length > 1 ? 'field-layout-ambiguous' : 'field-not-in-rendered-schema'
                        : 'definition-id-not-integer',
                    matches: located.matches,
                });
                continue;
            }
            descriptors[candidate.keyword] = {
                target: target.target,
                ...(target.targetKind ? { targetKind: target.targetKind } : {}),
                ...located.descriptor,
                ruleId: rule.ruleId,
                evidenceIds: (rule.evidence || []).map(item => item.evidenceId).filter(Boolean),
            };
        }
    }

    const lsppDescriptors = {};
    for (const [keyword, descriptor] of Object.entries(lsppHandoff?.definitions || {})) {
        if (REGISTRY_OWNED_DEFINITIONS.has(keyword)) continue;
        const lookup = lookupKeywordSchema(keyword, schema);
        const located = lookup && locateDefinitionField(lookup, descriptor.fieldName, descriptor, helpers);
        if (located?.descriptor?.fieldType === 'integer' && located.descriptor.cardIndex === descriptor.cardIndex) {
            lsppDescriptors[keyword] = { ...runtimeDescriptor(descriptor), ...located.descriptor };
        } else if (!lookup && sourceBoundDefinition(descriptor, lsppHandoff.source)) {
            // A pinned file-reader selector can cover a native spelling absent
            // from the independent editor schema (for example a TITLE alias).
            lsppDescriptors[keyword] = runtimeDescriptor(descriptor);
        }
    }
    const mergedDescriptors = { ...descriptors };
    // Keep semantic evidence while retaining the schema-matched native
    // namespace and selector. A semantic rule may omit its targetKind.
    for (const [keyword, descriptor] of Object.entries(lsppDescriptors)) {
        mergedDescriptors[keyword] = { ...descriptors[keyword], ...descriptor };
    }
    const scanned = Object.entries(mergedDescriptors)
        .filter(([, descriptor]) => descriptor.targetKind === 'curve' || descriptor.targetKind === 'table')
        .map(([keyword]) => keyword)
        .sort();
    const drawable = scanned.filter(keyword => DRAWABLE_DEFINITIONS.has(keyword));
    const generic = {};
    const onDemand = {};
    for (const [keyword, descriptor] of Object.entries(mergedDescriptors).sort(([a], [b]) => a.localeCompare(b))) {
        if (descriptor.targetKind === 'curve' || descriptor.targetKind === 'table') continue;
        (ON_DEMAND_TARGET_KINDS.has(descriptor.targetKind) || ['repeat-all-data-records', 'repeat-data-record-template'].includes(descriptor.recordMode)
            ? onDemand : generic)[keyword] = descriptor;
    }

    return {
        schemaVersion: 2,
        generatedFrom: {
            fieldData: "keywords/runtime/schema/field_data.json",
            manualSemanticRuntimeId: source.runtimeId || null,
            manualSemanticManifestSha256: source.manifestSha256 || null,
            ...(lsppHandoff ? {
                datasetVersion: lsppHandoff.source?.datasetVersion || null,
                lsppDatabaseSha256: lsppHandoff.source?.databaseSha256 || null,
                lsppHandoffSha256: source.lsppHandoffSha256 || null,
                lsppHandoffContentSha256: lsppHandoff.contentSha256 || null,
            } : {}),
        },
        definitionKeywords: {
            scanned,
            drawable,
            indexOnly: scanned.filter(keyword => !DRAWABLE_DEFINITIONS.has(keyword)),
            generic,
            onDemand,
            blocked,
        },
        references: Object.fromEntries(Object.entries(projection?.references || {})
            .map(([keyword, records]) => [keyword, records.map(runtimeDescriptor)])),
        ...(lsppHandoff ? { blockedReferences: compactBlockedReferences(projection.blocked) } : {}),
        ...(userExclusions ? { userReferenceExclusions: projection.policy } : {}),
        ...(lsppHandoff ? { lsppReferenceCoverage: lsppHandoff.summary } : {}),
        ...(lsppHandoff?.nativeIncludeOffsets ? { nativeIncludeOffsets: lsppHandoff.nativeIncludeOffsets } : {}),
        ...(lsppHandoff?.nativeAuxiliaryReferenceFields ? { nativeAuxiliaryReferenceFields: lsppHandoff.nativeAuxiliaryReferenceFields } : {}),
    };
}

function sourceBoundDefinition(descriptor, source) {
    const address = value => require('../../out/core/semantics/descriptorIdentity').isDescriptorIdentity(value, true);
    const formats = descriptor.formatContracts || [];
    return source?.datasetSha256 === "fc75cfb733be68b314152dc5a77e0a9a3c469444c917fc0f6adb004117d930f0" &&
        descriptor.source === "keyword-catalog" && descriptor.fieldType === 'integer' &&
        (descriptor.recordMode === 'exact-data-record-ordinal' || descriptor.recordMode === 'repeat-data-record-template' &&
            Number.isSafeInteger(descriptor.recordStride) && descriptor.recordStride > 0 && descriptor.dataRecordOrdinal < descriptor.recordStride) &&
        Number.isInteger(descriptor.dataRecordOrdinal) && descriptor.dataRecordOrdinal >= 0 &&
        descriptor.cardIndex === descriptor.dataRecordOrdinal + 1 &&
        Number.isInteger(descriptor.fieldIndex) && descriptor.fieldIndex >= 0 &&
        address(descriptor.nativeMapAddress) && address(descriptor.nativeCardArrayAddress) &&
        address(descriptor.nativeFieldAddress) && descriptor.selectorRuleId && descriptor.selectorEvidenceIds?.length &&
        formats.length === 4 && ['standard', 'long', 'i10'].every(mode => formats.some(format =>
            format.format === mode && format.mode === 'fixed' && Number.isInteger(format.position) && format.position >= 0 &&
            Number.isInteger(format.width) && format.width > 0 && format.width <= 256)) &&
        formats.some(format => format.format === 'comma' && format.mode === 'comma' &&
            format.fieldIndex === descriptor.fieldIndex);
}

module.exports = { readManualRuntime, buildIndex, writeBlockedRuntime };
