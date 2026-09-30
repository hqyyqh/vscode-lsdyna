'use strict';

import runtimeTableLayoutCorrections = require('../runtimeTableLayoutCorrections.json');
import runtimeSemanticRelationCorrections = require('../runtimeSemanticRelationCorrections.json');

const crypto = require('crypto');

const {
    getRenderedCardsForLookup,
    loadKeywordSchema,
    lookupKeywordSchema,
} = require('../keywordSchema');
const { getManualSemanticCatalog } = require('../semantics/manualSemanticCatalog');
const {
    applyReferenceIdTransform,
    resolveValueRole,
} = require('../semantics/predicateEvaluator');
const { parseNumericInput } = require('./referenceInputValue');
const { isLabelIdentity } = require('./entityIdentity');
const { getDefinitionRegistryCatalog } = require('./definitionRegistry');
const { loadFamilyDefinitionScannerCatalog } = require('./familyDefinitionScannerCatalog');
const { getSemanticRuntimeCatalogV2 } = require('../semantics/semanticRuntimeV2');
const RUNTIME_TABLE_CORRECTION_SOURCES_SHA256 =
    'd8c5df4537d57803c5071a93548cda1e19a62792c613a7fa14c478bdacffac22';
const RUNTIME_LAYOUT_UNIVERSE_SOURCE_SHA256 =
    "ff86cfcf947cb0aa9d2bfa6057cfd9d59d9ab7b18373eadba7d2411191edc07e";
const RUNTIME_TABLE_CORRECTION_SET_SHA256 =
    '3dd87e1e875b976db5996349705c188ae2b577c3566d704b103b29a561fade5f';
const RUNTIME_TABLE_SCOPE_SET_SHA256 =
    '121981a88f027a096f230df730549835a015057b43bb5a19702779178a29e80b';
const RUNTIME_DUPLICATE_TABLE_REPRESENTATION_SET_SHA256 =
    'f5f94145813a79d04394b0cbf6df1d65a2567ce6eb1f73519c804c58941c8c34';
const RUNTIME_OPTION_TABLE_SELECTION_SET_SHA256 =
    'c59601893426fcf274bdde7ffc3e9eb591d67f6ded499d63a8a069b8c46f28a4';
const RUNTIME_DIRECT_SOURCE_FIELD_SELECTION_SET_SHA256 =
    'bad22307dbcffe1e1b97113330c4e26123d6c4cb31db28811bf57cdbf65556ab';
const RUNTIME_SEMANTIC_CORRECTION_SOURCES_SHA256 =
    'ac805f0aef378c446342ab8e20f1e56be4417e46ab9e6a9460bb07d65ec101e3';
const RUNTIME_SEMANTIC_CORRECTION_SET_SHA256 =
    '692428a956eac9e4d48fdc09fc7cab5937749aaa60ac1f3457283f977c95e9cd';

function normalizeKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function normalizeFieldName(value) {
    return String(value || '').trim().toUpperCase();
}

function normalizeFieldType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'real' ? 'float' : normalized;
}

function normalizeTargetKeyword(value) {
    return normalizeKeyword(value).replace(/[+%\-]$/, '');
}

function unique(values) {
    return [...new Set((values || []).filter(Boolean))];
}

function canonicalJson(value) {
    const normalize = item => Array.isArray(item) ? item.map(normalize)
        : item && typeof item === 'object'
            ? Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]))
            : item;
    return JSON.stringify(normalize(value));
}

function canonicalSha256(value) {
    return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isUnambiguousOperationalProjection(value) {
    return value?.operationalProjection?.ambiguous !== true &&
        value?.operationalProjection?.targetBindingComplete !== false;
}

function targetKindMatchesDefinitionKind(targetKind, definitionKind) {
    if (targetKind === definitionKind) return true;
    // Project indexing intentionally exposes DEFINE_FUNCTION occurrences in
    // the curve namespace because LS-DYNA accepts a function wherever these
    // reviewed relations request a load curve.
    return targetKind === 'curve' && definitionKind === 'function';
}

function isCoherentReferenceTargetNamespace(info, registryCatalog = getDefinitionRegistryCatalog()) {
    const relation = info?.relation;
    if (!relation || typeof relation !== 'object') return false;
    const clauses = [relation, ...(Array.isArray(relation.branches) ? relation.branches : [])];
    for (const clause of clauses) {
        const targetKinds = unique(clause?.targetKinds);
        const targetKeywords = unique(clause?.targetKeywords);
        if (targetKinds.length === 0 || targetKeywords.length === 0) continue;
        for (const targetKeyword of targetKeywords) {
            const definition = registryCatalog.definitionDescriptorForKeyword(targetKeyword) ||
                loadFamilyDefinitionScannerCatalog().byKeyword.get(normalizeKeyword(targetKeyword));
            if (definition?.targetKind && !targetKinds.some(targetKind =>
                targetKindMatchesDefinitionKind(targetKind, definition.targetKind)
            )) return false;
        }
    }
    return true;
}

function referenceTargets(relation) {
    const branches = Array.isArray(relation?.branches) ? relation.branches : [];
    const directKinds = relation?.targetKinds || [];
    const directKeywords = relation?.targetKeywords || [];
    return {
        targetKinds: unique([
            ...directKinds,
            ...branches.filter(branch => branch?.role === 'reference')
                .flatMap(branch => branch.targetKinds || []),
        ]),
        targetDefinitions: unique([
            ...directKeywords.map(normalizeTargetKeyword),
            ...branches.filter(branch => branch?.role === 'reference')
                .flatMap(branch => (branch.targetKeywords || []).map(normalizeTargetKeyword)),
        ]),
    };
}

function siblingTargetRelation(binding) {
    const branches = Array.isArray(binding?.branches) ? binding.branches : [];
    return {
        kind: 'entity-reference',
        targetKeywords: unique(branches.flatMap(branch => branch.relation?.targetKeywords || [])),
        targetKinds: unique(branches.flatMap(branch => branch.relation?.targetKinds || [])),
    };
}

function fieldMatchesSelector(field, selector, fieldName) {
    if (!field || !selector || normalizeFieldName(field.n) !== fieldName) return false;
    return normalizeFieldName(selector.fieldName) === fieldName &&
        normalizeFieldType(field.t) === normalizeFieldType(selector.fieldType) &&
        Number.isInteger(field.p) && field.p === selector.position &&
        Number.isInteger(field.w) && field.w === selector.width;
}

function validDirectTargetFormats(formats, selector) {
    return canonicalJson(formats) === canonicalJson({
        standard: { mode: 'fixed', position: selector.position, width: selector.width },
        i10: { mode: 'fixed', position: selector.position, width: selector.width },
        long: { mode: 'fixed', position: selector.position * 2, width: selector.width * 2 },
        comma: { mode: 'comma', fieldIndex: selector.fieldIndex },
    });
}

function compileRuntimeSemanticRelationCorrections(registry) {
    if (!registry || registry.schemaVersion !== 3 ||
        registry.id !== 'runtime-semantic-relation-source-locked-corrections-v3' ||
        registry.policy !== 'exact-record-and-direct-pdf-relation-correction-only-v3' ||
        canonicalSha256(registry.documents) !== RUNTIME_SEMANTIC_CORRECTION_SOURCES_SHA256 ||
        canonicalSha256(registry.correctionGroups) !== RUNTIME_SEMANTIC_CORRECTION_SET_SHA256 ||
        canonicalJson(registry.capture) !== canonicalJson({
            textCommand: 'pdftotext -layout -enc UTF-8 (page form-feed split)',
            renderCommand: 'pdftoppm -r 144 -png -singlefile',
            renderDpi: 144,
            toolVersion: '24.03.0',
        }) ||
        canonicalJson(registry.permissions) !== canonicalJson({
            exactRelationCorrection: true,
            newRelationApproval: false,
            targetNamespaceExpansion: false,
            fieldLayoutMutation: false,
            automaticPredicateMutation: false,
            contextFreeNegativeLcidporApproval: false,
            sourceLockedReferenceSuppression: true,
            sourceLockedTargetNamespaceCorrection: true,
        })) return null;
    const sourcePages = new Set();
    for (const document of registry.documents || []) {
        if (!document.manualId || !/^[0-9a-f]{64}$/.test(document.pdfSha256 || '') ||
            !Number.isInteger(document.pdfSize) || document.pdfSize <= 0) return null;
        for (const page of document.pages || []) {
            const key = `${document.manualId}:${page.physicalPage}`;
            if (sourcePages.has(key) || !Number.isInteger(page.physicalPage) ||
                !/^[0-9a-f]{64}$/.test(page.textSha256 || '') ||
                !/^[0-9a-f]{64}$/.test(page.renderSha256 || '') ||
                !Number.isInteger(page.renderByteLength) || page.renderByteLength <= 0) return null;
            sourcePages.add(key);
        }
    }
    const byAuthoringRelation = new Map();
    for (const group of registry.correctionGroups || []) {
        if (!group.id?.startsWith('runtime-semantic-relation-correction-group:') ||
            !['replace-reference-predicate-op', 'deduplicate-identical-branches',
                'retain-existing-branches', 'suppress-non-reference-extraction',
                'replace-reference-target-kind']
                .includes(group.operation) ||
            !group.keyword || !group.coordinateId || !group.physicalTableId ||
            !group.physicalFieldId || !Number.isInteger(group.field?.cardIndex) ||
            !Number.isInteger(group.field?.fieldIndex) || !group.field?.fieldName ||
            !group.field?.fieldType || !Number.isInteger(group.field?.position) ||
            !Number.isInteger(group.field?.width) || group.field.width <= 0 ||
            !group.source?.manualId || !Array.isArray(group.source.physicalPages) ||
            group.source.physicalPages.length === 0 ||
            !group.source.physicalPages.every(page =>
                sourcePages.has(`${group.source.manualId}:${page}`))) return null;
        if (group.operation === 'replace-reference-predicate-op' &&
            canonicalJson(group.replacePredicate) !== canonicalJson({
                from: { op: 'gt', value: 0 },
                to: { op: 'lt', value: 0 },
                role: 'reference',
                idTransform: 'negate',
            })) return null;
        if (group.operation === 'replace-reference-target-kind' &&
            canonicalJson(group.targetKindReplacement) !== canonicalJson({
                from: ['set'], to: ['node-set'], targetKeywords: ['*SET_NODE'],
            })) return null;
        const retainedByKind = group.retainedBranchesByKind || {};
        const retainedSets = group.operation === 'retain-existing-branches'
            ? [group.retainedBranches, ...Object.values(retainedByKind)].filter(Boolean)
            : [];
        if (group.operation === 'retain-existing-branches' &&
            (retainedSets.length === 0 || retainedSets.some(branches =>
                !Array.isArray(branches) || branches.length === 0 ||
                new Set(branches.map(canonicalJson)).size !== branches.length))) return null;
        if (group.contextualReferenceBranch) {
            if (group.id !==
                'runtime-semantic-relation-correction-group:clis-lcidpor-conservative' ||
                canonicalJson(group.contextualReferenceBranch) !== canonicalJson({
                    branch: { role: 'reference', targetKinds: ['curve'],
                        when: { op: 'lt', value: 0 }, idTransform: 'abs' },
                    all: [
                        { fieldName: 'CTYPE', cardIndex: 2, fieldType: 'integer',
                            defaultValue: 2, predicate: { op: 'in', values: [11, 12] },
                            formats: {
                                standard: { mode: 'fixed', position: 50, width: 10 },
                                i10: { mode: 'fixed', position: 50, width: 10 },
                                long: { mode: 'fixed', position: 100, width: 20 },
                                comma: { mode: 'comma', fieldIndex: 5 },
                            } },
                        { fieldName: 'POREINI', cardIndex: 6, fieldType: 'float',
                            defaultValue: 0, predicate: { any: [
                                { op: 'eq', value: 0 }, { op: 'gt', value: 0 },
                            ] }, formats: {
                                standard: { mode: 'fixed', position: 70, width: 10 },
                                i10: { mode: 'fixed', position: 70, width: 10 },
                                long: { mode: 'fixed', position: 140, width: 20 },
                                comma: { mode: 'comma', fieldIndex: 7 },
                            } },
                    ],
                })) return null;
        }
        for (const correction of group.records || []) {
            if (byAuthoringRelation.has(correction.authoringRelationId) ||
                !correction.authoringRelationId || !correction.sourceRuleId ||
                !correction.manualRelationId || !correction.evidenceId ||
                !/^[0-9a-f]{64}$/.test(correction.quoteSha256 || '') ||
                !/^[0-9a-f]{64}$/.test(correction.originalRelationSha256 || '')) return null;
            byAuthoringRelation.set(correction.authoringRelationId, { group, correction });
        }
    }
    return byAuthoringRelation.size === 47 ? byAuthoringRelation : null;
}

let defaultRuntimeSemanticCorrections = undefined;

function applyRuntimeSemanticRelationCorrection(
    record,
    registry = runtimeSemanticRelationCorrections,
) {
    const corrections = registry === runtimeSemanticRelationCorrections
        ? defaultRuntimeSemanticCorrections === undefined
            ? (defaultRuntimeSemanticCorrections =
                compileRuntimeSemanticRelationCorrections(registry))
            : defaultRuntimeSemanticCorrections
        : compileRuntimeSemanticRelationCorrections(registry);
    const compiled = corrections?.get(record?.authoringRelationId);
    if (!compiled) return record;
    const { group, correction } = compiled;
    const field = record.field || {};
    const evidence = (record.evidence || []).find(item =>
        item.evidenceId === correction.evidenceId &&
        item.quoteSha256 === correction.quoteSha256);
    if (normalizeKeyword(field.keyword) !== normalizeKeyword(group.keyword) ||
        field.cardIndex !== group.field.cardIndex ||
        field.fieldIndex !== group.field.fieldIndex ||
        normalizeFieldName(field.fieldName) !== normalizeFieldName(group.field.fieldName) ||
        normalizeFieldType(field.fieldType) !== normalizeFieldType(group.field.fieldType) ||
        field.position !== group.field.position || field.width !== group.field.width ||
        record.coordinateId !== group.coordinateId ||
        record.sourceRuleId !== correction.sourceRuleId ||
        record.manualRelationId !== correction.manualRelationId ||
        record.operationalProjection?.physicalTableId !== group.physicalTableId ||
        record.operationalProjection?.physicalFieldId !== group.physicalFieldId ||
        !evidence || canonicalSha256(record.relation) !==
            correction.originalRelationSha256) return record;
    let correctedRelation = structuredClone(record.relation);
    const originalBranches = record.relation?.branches;
    if (group.operation === 'suppress-non-reference-extraction') {
        if (record.relation?.kind !== 'entity-reference' ||
            Array.isArray(originalBranches) && originalBranches.length > 0) return record;
        correctedRelation = { kind: 'non-reference' };
    } else if (group.operation === 'replace-reference-target-kind') {
        const replacement = group.targetKindReplacement;
        if (record.relation?.kind !== 'entity-reference' ||
            Array.isArray(originalBranches) && originalBranches.length > 0 ||
            canonicalJson(record.relation.targetKinds) !== canonicalJson(replacement.from) ||
            canonicalJson(record.relation.targetKeywords) !==
                canonicalJson(replacement.targetKeywords)) return record;
        correctedRelation.targetKinds = [...replacement.to];
    } else if (!Array.isArray(originalBranches) || originalBranches.length === 0) {
        return record;
    } else if (group.operation === 'replace-reference-predicate-op') {
        if (originalBranches.length !== 1 ||
            originalBranches[0].role !== group.replacePredicate.role ||
            originalBranches[0].idTransform !== group.replacePredicate.idTransform ||
            canonicalJson(originalBranches[0].when) !==
                canonicalJson(group.replacePredicate.from)) return record;
        correctedRelation.branches[0].when = group.replacePredicate.to;
    } else if (group.operation === 'deduplicate-identical-branches') {
        if (originalBranches.length < 2 ||
            !originalBranches.every(branch =>
                canonicalJson(branch) === canonicalJson(originalBranches[0]))) return record;
        correctedRelation.branches = [originalBranches[0]];
    } else {
        const retained = group.retainedBranches ||
            group.retainedBranchesByKind?.[record.relation.kind];
        const originalBranchSet = new Set(originalBranches.map(canonicalJson));
        if (!Array.isArray(retained) || retained.length === 0 ||
            retained.length >= originalBranches.length ||
            !retained.every(branch => originalBranchSet.has(canonicalJson(branch)))) return record;
        correctedRelation.branches = retained;
    }
    const originalTargets = referenceTargets(record.relation);
    const correctedTargets = referenceTargets(correctedRelation);
    if (group.contextualReferenceBranch && !originalBranches.some(branch =>
        canonicalJson(branch) ===
            canonicalJson(group.contextualReferenceBranch.branch))) return record;
    const approvedTargetKindReplacement = group.operation === 'replace-reference-target-kind' &&
        canonicalJson(originalTargets.targetKinds) === canonicalJson(['set']) &&
        canonicalJson(correctedTargets.targetKinds) === canonicalJson(['node-set']) &&
        canonicalJson(originalTargets.targetDefinitions) ===
            canonicalJson(correctedTargets.targetDefinitions);
    if ((!approvedTargetKindReplacement && correctedTargets.targetKinds.some(kind =>
        !originalTargets.targetKinds.includes(kind))) ||
        correctedTargets.targetDefinitions.some(keyword =>
            !originalTargets.targetDefinitions.includes(keyword))) return record;
    return {
        ...record,
        relation: correctedRelation,
        runtimeSemanticCorrection: {
            correctionId: group.id,
            operation: group.operation,
            originalRelation: record.relation,
            authorityBasis: 'source-locked-direct-pdf-relation-correction',
            contextualReferenceBranch: group.contextualReferenceBranch || null,
        },
    };
}

function providedFieldMatchesSelector(field, selector, fieldName) {
    if (!field || !selector || normalizeFieldName(field.n) !== fieldName ||
        normalizeFieldName(selector.fieldName) !== fieldName) return false;
    if (field.t !== undefined && normalizeFieldType(field.t) !== normalizeFieldType(selector.fieldType)) {
        return false;
    }
    if (field.p !== undefined && field.p !== selector.position) return false;
    if (field.w !== undefined && field.w !== selector.width) return false;
    return true;
}

function cardLayoutSignature(card) {
    if (!Array.isArray(card) || card.length === 0) return null;
    const fields = [];
    for (const field of card) {
        const name = normalizeFieldName(field?.n);
        const type = normalizeFieldType(field?.t);
        if (!name || !type || !Number.isInteger(field?.p) ||
            !Number.isInteger(field?.w) || field.w <= 0) {
            return null;
        }
        fields.push([name, type, field.p, field.w]);
    }
    return JSON.stringify(fields);
}

function uniqueCardLayoutIndex(cards, signature) {
    if (!signature) return null;
    let match = null;
    for (let index = 0; index < cards.length; index++) {
        if (cardLayoutSignature(cards[index]) !== signature) continue;
        if (match !== null) return null;
        match = index;
    }
    return match;
}

/**
 * Maps a canonical manual selector through an option/alias card insertion.
 * Every physical field on the source card participates in the identity.  A
 * duplicated layout is deliberately ambiguous even if the selected field name
 * happens to match on both cards.
 */
function selectorMapsToRequestedCard(selector, canonicalCards, requestedCards, requestedCardIndex) {
    if (!selector || !Number.isInteger(selector.cardIndex) || selector.cardIndex < 1 ||
        !Number.isInteger(selector.fieldIndex) || selector.fieldIndex < 0 ||
        !Number.isInteger(requestedCardIndex) || requestedCardIndex < 1) {
        return false;
    }
    const canonicalIndex = selector.cardIndex - 1;
    const canonicalCard = canonicalCards[canonicalIndex];
    const signature = cardLayoutSignature(canonicalCard);
    if (!signature || uniqueCardLayoutIndex(canonicalCards, signature) !== canonicalIndex) {
        return false;
    }
    const requestedIndex = uniqueCardLayoutIndex(requestedCards, signature);
    if (requestedIndex === null || requestedIndex !== requestedCardIndex - 1) {
        return false;
    }
    const fieldName = normalizeFieldName(selector.fieldName);
    return fieldMatchesSelector(requestedCards[requestedIndex]?.[selector.fieldIndex], selector, fieldName);
}

let runtimeTableLayoutCache = new WeakMap();

function compileRuntimeTableCorrections(registry) {
    if (!registry || registry.schemaVersion !== 7 ||
        registry.id !== 'runtime-table-layout-source-locked-corrections-v7' ||
        registry.policy !==
            'complete-table-only-direct-pdf-type-option-alias-concrete-family-duplicate-representation-option-table-direct-source-field-exact-and-sibling-target-binding-scope-v7' ||
        canonicalSha256(registry.layoutUniverseSource) !==
            RUNTIME_LAYOUT_UNIVERSE_SOURCE_SHA256 ||
        canonicalSha256(registry.sources) !== RUNTIME_TABLE_CORRECTION_SOURCES_SHA256 ||
        canonicalSha256(registry.corrections) !== RUNTIME_TABLE_CORRECTION_SET_SHA256 ||
        canonicalSha256(registry.tableScopes) !== RUNTIME_TABLE_SCOPE_SET_SHA256 ||
        canonicalSha256(registry.duplicateTableRepresentations) !==
            RUNTIME_DUPLICATE_TABLE_REPRESENTATION_SET_SHA256 ||
        canonicalSha256(registry.optionTableSelections) !==
            RUNTIME_OPTION_TABLE_SELECTION_SET_SHA256 ||
        canonicalSha256(registry.directSourceFieldSelections) !==
            RUNTIME_DIRECT_SOURCE_FIELD_SELECTION_SET_SHA256 ||
        canonicalJson(registry.permissions) !== canonicalJson({
            completeTableLayoutCorrection: true,
            concreteFamilyTableScope: true,
            duplicateTableRepresentationEquivalence: true,
            optionTableSelection: true,
            directSourceFieldSelection: true,
            exactTargetBindingApproval: true,
            siblingTargetBindingApproval: true,
            singleFieldFallback: false,
            newRelationApproval: false,
            targetNamespaceMutation: false,
            predicateMutation: false,
            optionMutation: false,
            automaticValueMutation: false,
        })) return null;
    const byRelation = new Map();
    const protectedTables = new Set();
    for (const correction of registry.corrections) {
        const keyword = normalizeKeyword(correction.keyword);
        const relationId = String(correction.authoringRelationId || '');
        const tableId = String(correction.physicalTableId || '');
        const key = `${keyword}|${relationId}`;
        if (!keyword || !relationId || !tableId || byRelation.has(key) ||
            !selectorLayoutSignature(correction.from) ||
            !selectorLayoutSignature(correction.to) ||
            !Number.isInteger(correction.from?.cardIndex) ||
            !Number.isInteger(correction.from?.cardFieldCount) ||
            !Number.isInteger(correction.from?.fieldIndex)) return null;
        byRelation.set(key, correction);
        protectedTables.add(`${keyword}|${tableId}`);
    }
    const tableScopes = new Map();
    for (const scope of registry.tableScopes) {
        const keyword = normalizeKeyword(scope.keyword);
        const tableId = String(scope.physicalTableId || '');
        const key = `${keyword}|${tableId}`;
        const records = new Map();
        if (!keyword || !tableId || tableScopes.has(key) ||
            normalizeKeyword(scope.sourceSelectorKeyword) !== keyword ||
            scope.strategy !== 'concrete-keyword-field-name' ||
            !Array.isArray(scope.records) || scope.records.length < 1) return null;
        for (const record of scope.records) {
            const relationId = String(record.authoringRelationId || '');
            if (!relationId || records.has(relationId) ||
                !Number.isInteger(record.fieldIndex) || record.fieldIndex < 0 ||
                !record.sourceRuleId || !record.physicalFieldId) return null;
            records.set(relationId, record);
        }
        if ([...records.values()].some((record, index) => record.fieldIndex !== index)) return null;
        tableScopes.set(key, { ...scope, keyword, records });
        protectedTables.add(key);
    }
    const duplicateTableRepresentations = new Map();
    const duplicateIds = new Set();
    const protectedDuplicateRelations = new Set();
    for (const equivalence of registry.duplicateTableRepresentations) {
        const keyword = normalizeKeyword(equivalence.keyword);
        const id = String(equivalence.id || '');
        const sourceSignature = selectorLayoutSignature(equivalence.source);
        const targetSignature = selectorLayoutSignature(equivalence.target);
        if (!keyword || !id || duplicateIds.has(id) ||
            !id.startsWith('duplicate-table-representation-equivalence:') ||
            !sourceSignature || sourceSignature !== targetSignature ||
            !Number.isInteger(equivalence.source?.cardIndex) ||
            !Number.isInteger(equivalence.source?.cardFieldCount) ||
            !Number.isInteger(equivalence.source?.fieldIndex) ||
            !Number.isInteger(equivalence.target?.cardIndex) ||
            !Number.isInteger(equivalence.target?.cardFieldCount) ||
            !Number.isInteger(equivalence.target?.fieldIndex) ||
            equivalence.source.cardIndex === equivalence.target.cardIndex ||
            equivalence.source.cardFieldCount !== equivalence.target.cardFieldCount ||
            equivalence.source.fieldIndex !== equivalence.target.fieldIndex ||
            !equivalence.sectionId || !equivalence.sourceRuleId ||
            !equivalence.sourceSelectorKeyword ||
            !Array.isArray(equivalence.representations) ||
            equivalence.representations.length !== 2) return null;
        const relationIds = new Set();
        const tableIds = new Set();
        const fieldIds = new Set();
        for (const representation of equivalence.representations) {
            if (!representation.authoringRelationId ||
                relationIds.has(representation.authoringRelationId) ||
                !representation.physicalTableId || tableIds.has(representation.physicalTableId) ||
                !representation.physicalFieldId || fieldIds.has(representation.physicalFieldId) ||
                !Number.isInteger(representation.candidateCount) ||
                representation.candidateCount < 2 ||
                !Number.isInteger(representation.tableOrdinal) ||
                !Number.isInteger(representation.markerLine) ||
                !/^[0-9a-f]{64}$/.test(representation.rawTableSha256 || '')) return null;
            relationIds.add(representation.authoringRelationId);
            protectedDuplicateRelations.add(representation.authoringRelationId);
            tableIds.add(representation.physicalTableId);
            fieldIds.add(representation.physicalFieldId);
            protectedTables.add(`${keyword}|${representation.physicalTableId}`);
        }
        duplicateIds.add(id);
        if (!duplicateTableRepresentations.has(keyword)) {
            duplicateTableRepresentations.set(keyword, []);
        }
        duplicateTableRepresentations.get(keyword).push(equivalence);
    }
    const optionTableSelections = new Map();
    const optionSelectionIds = new Set();
    const protectedOptionSelectionRelations = new Set();
    for (const selection of registry.optionTableSelections) {
        const keyword = normalizeKeyword(selection.keyword);
        const id = String(selection.id || '');
        const alternatives = [selection.selected, ...(selection.excluded || [])];
        if (!keyword || !id || optionSelectionIds.has(id) ||
            !id.startsWith('option-table-selection:') ||
            !Array.isArray(selection.activeOptions) ||
            selection.activeOptions.some(option => normalizeKeyword(option) !== option) ||
            selectorLayoutSignature(selection.source) !==
                selectorLayoutSignature(selection.target) ||
            !Number.isInteger(selection.source?.cardIndex) ||
            !Number.isInteger(selection.source?.cardFieldCount) ||
            !Number.isInteger(selection.source?.fieldIndex) ||
            !Number.isInteger(selection.target?.cardIndex) ||
            !Number.isInteger(selection.target?.cardFieldCount) ||
            !Number.isInteger(selection.target?.fieldIndex) ||
            selection.source.cardIndex === selection.target.cardIndex ||
            selection.source.cardFieldCount !== selection.target.cardFieldCount ||
            selection.source.fieldIndex !== selection.target.fieldIndex ||
            !selection.sectionId || !selection.sourceRuleId ||
            normalizeKeyword(selection.sourceSelectorKeyword) !== keyword ||
            !selection.selected || !Array.isArray(selection.excluded) ||
            selection.excluded.length < 1) return null;
        const relationIds = new Set();
        const tableIds = new Set();
        const fieldIds = new Set();
        for (const alternative of alternatives) {
            if (!alternative?.authoringRelationId ||
                relationIds.has(alternative.authoringRelationId) ||
                !alternative.physicalTableId || tableIds.has(alternative.physicalTableId) ||
                !alternative.physicalFieldId || fieldIds.has(alternative.physicalFieldId) ||
                !Number.isInteger(alternative.candidateCount) || alternative.candidateCount < 2 ||
                !Number.isInteger(alternative.tableOrdinal) ||
                !Number.isInteger(alternative.markerLine) ||
                !/^[0-9a-f]{64}$/.test(alternative.rawTableSha256 || '')) return null;
            relationIds.add(alternative.authoringRelationId);
            tableIds.add(alternative.physicalTableId);
            fieldIds.add(alternative.physicalFieldId);
            protectedOptionSelectionRelations.add(alternative.authoringRelationId);
        }
        optionSelectionIds.add(id);
        if (!optionTableSelections.has(keyword)) optionTableSelections.set(keyword, []);
        optionTableSelections.get(keyword).push(selection);
    }
    const directSourceFieldSelections = new Map();
    const directSelectionIds = new Set();
    const protectedDirectSelectionRules = new Set();
    const protectedDirectSelectionRelations = new Set();
    for (const selection of registry.directSourceFieldSelections) {
        const keyword = normalizeKeyword(selection.keyword);
        const id = String(selection.id || '');
        const bindingStatus = selection.targetBindingStatus;
        if (!keyword || !id.startsWith('direct-source-field-selection:') ||
            directSelectionIds.has(id) || !Array.isArray(selection.activeOptions) ||
            selection.activeOptions.some(option => normalizeKeyword(option) !== option) ||
            !selection.sourceRuleId || !selection.manualRelationId ||
            !selection.selectedAuthoringRelationId || !selection.relation ||
            !selection.sectionId || !selection.physicalTableId ||
            !selection.physicalFieldId || !selection.cardLabel ||
            !Number.isInteger(selection.tableOrdinal) || selection.tableOrdinal < 0 ||
            !Number.isInteger(selection.markerLine) || selection.markerLine < 0 ||
            !/^[0-9a-f]{64}$/.test(selection.rawTableSha256 || '') ||
            !Number.isInteger(selection.candidateCount) || selection.candidateCount < 2 ||
            selectorLayoutSignature(selection.source) !==
                selectorLayoutSignature(selection.target) ||
            !Number.isInteger(selection.source?.cardIndex) ||
            !Number.isInteger(selection.source?.cardFieldCount) ||
            !Number.isInteger(selection.source?.fieldIndex) ||
            !Number.isInteger(selection.target?.cardIndex) ||
            !Number.isInteger(selection.target?.cardFieldCount) ||
            !Number.isInteger(selection.target?.fieldIndex) ||
            !validDirectTargetFormats(selection.targetFormats, selection.target) ||
            !['sibling-discriminator-required', 'sibling-discriminator-approved',
                'exact-target-keyword-required',
                'exact-target-keyword-approved']
                .includes(bindingStatus) ||
            !Array.isArray(selection.targetBindingValues) ||
            (bindingStatus === 'sibling-discriminator-required' &&
                (!selection.targetBindingField || selection.targetBindingValues.length < 2)) ||
            (bindingStatus === 'sibling-discriminator-approved' && (() => {
                const binding = selection.targetBinding;
                const selector = binding?.selector;
                const formats = binding?.formats;
                const branches = binding?.branches;
                const values = Array.isArray(branches) ? branches.map(branch => branch.value) : [];
                return !selection.targetBindingField || selection.targetBindingValues.length < 2 ||
                    !selector || normalizeFieldName(selector.fieldName) !==
                        normalizeFieldName(selection.targetBindingField) ||
                    !Number.isInteger(selector.fieldIndex) || selector.fieldIndex < 0 ||
                    !Number.isInteger(selector.position) || !Number.isInteger(selector.width) ||
                    selector.width < 1 || !formats ||
                    canonicalJson(Object.keys(formats).sort()) !==
                        canonicalJson(['comma', 'i10', 'long', 'standard']) ||
                    !Array.isArray(branches) || branches.length !==
                        selection.targetBindingValues.length ||
                    canonicalJson(values) !== canonicalJson(selection.targetBindingValues) ||
                    !values.includes(String(binding.defaultValue)) ||
                    new Set(values).size !== values.length || branches.some(branch =>
                        canonicalJson(branch.relation) !== canonicalJson({
                            kind: 'entity-reference',
                            targetKeywords: branch.relation?.targetKeywords,
                            targetKinds: branch.relation?.targetKinds,
                        }) || branch.relation.targetKeywords.length !== 1 ||
                        branch.relation.targetKinds.length !== 1
                    ) || siblingTargetRelation(binding).targetKeywords.length !== branches.length;
            })()) ||
            (bindingStatus === 'exact-target-keyword-required' &&
                (selection.targetBindingField !== null ||
                    selection.targetBindingValues.length !== 0 ||
                    selection.approvedTargetRelation !== undefined)) ||
            (bindingStatus === 'exact-target-keyword-approved' &&
                (selection.targetBindingField !== null ||
                    selection.targetBindingValues.length !== 0 ||
                    canonicalJson(selection.approvedTargetRelation) !== canonicalJson({
                        kind: 'entity-reference',
                        targetKeywords: ['*SET_NODE'],
                        targetKinds: ['node-set'],
                    })))) return null;
        directSelectionIds.add(id);
        protectedDirectSelectionRules.add(`${keyword}|${selection.sourceRuleId}`);
        protectedDirectSelectionRelations.add(selection.selectedAuthoringRelationId);
        if (!directSourceFieldSelections.has(keyword)) {
            directSourceFieldSelections.set(keyword, []);
        }
        directSourceFieldSelections.get(keyword).push(selection);
    }
    return { byRelation, protectedTables, tableScopes, duplicateTableRepresentations,
        protectedDuplicateRelations, optionTableSelections,
        protectedOptionSelectionRelations, directSourceFieldSelections,
        protectedDirectSelectionRules, protectedDirectSelectionRelations };
}

function isProtectedDuplicateRepresentationRecord(keyword, record, compiledCorrections) {
    if (!compiledCorrections) return false;
    if (compiledCorrections.protectedDuplicateRelations.has(record?.authoringRelationId)) {
        return true;
    }
    const normalizedKeyword = normalizeKeyword(keyword);
    return (compiledCorrections.duplicateTableRepresentations.get(normalizedKeyword) || [])
        .some(equivalence => record?.sourceRuleId === equivalence.sourceRuleId &&
            canonicalJson({
                cardIndex: record.field?.cardIndex,
                cardFieldCount: record.field?.cardFieldCount,
                fieldIndex: record.field?.fieldIndex,
                fieldName: record.field?.fieldName,
                fieldType: record.field?.fieldType,
                position: record.field?.position,
                width: record.field?.width,
            }) === canonicalJson(equivalence.source));
}

function duplicateRepresentationMappings(keyword, cards, runtimeRecords, compiledCorrections) {
    const result = new Map();
    const normalizedKeyword = normalizeKeyword(keyword);
    const equivalences = compiledCorrections?.duplicateTableRepresentations.get(normalizedKeyword) || [];
    for (const equivalence of equivalences) {
        const expectedIds = new Set(equivalence.representations.map(item => item.authoringRelationId));
        const sourcePeers = runtimeRecords.filter(record =>
            record.sourceRuleId === equivalence.sourceRuleId &&
            canonicalJson({
                cardIndex: record.field?.cardIndex,
                cardFieldCount: record.field?.cardFieldCount,
                fieldIndex: record.field?.fieldIndex,
                fieldName: record.field?.fieldName,
                fieldType: record.field?.fieldType,
                position: record.field?.position,
                width: record.field?.width,
            }) === canonicalJson(equivalence.source));
        if (sourcePeers.length !== 2 ||
            sourcePeers.some(record => !expectedIds.has(record.authoringRelationId)) ||
            new Set(sourcePeers.map(record => record.authoringRelationId)).size !== 2) continue;
        const matched = [];
        for (const representation of equivalence.representations) {
            const records = sourcePeers.filter(record =>
                record.authoringRelationId === representation.authoringRelationId);
            if (records.length !== 1) { matched.length = 0; break; }
            const record = records[0];
            const projection = record.operationalProjection;
            if (projection?.physicalTableId !== representation.physicalTableId ||
                projection?.physicalFieldId !== representation.physicalFieldId ||
                projection?.sectionId !== equivalence.sectionId ||
                normalizeKeyword(projection?.sourceSelectorKeyword) !==
                    normalizeKeyword(equivalence.sourceSelectorKeyword) ||
                normalizeKeyword(projection?.projectedSourceKeyword) !== normalizedKeyword ||
                projection?.sourceKeywordStrategy !== 'concrete-keyword' ||
                projection?.strategy !== 'concrete-keyword-field-name' ||
                projection?.ambiguous !== true ||
                projection?.candidateCount !== representation.candidateCount) {
                matched.length = 0; break;
            }
            matched.push(record);
        }
        if (matched.length !== 2 ||
            canonicalJson(matched[0].relation) !== canonicalJson(matched[1].relation) ||
            matched[0].kind !== matched[1].kind) continue;
        const targetCard = cards[equivalence.target.cardIndex - 1];
        const targetField = targetCard?.[equivalence.target.fieldIndex];
        if (targetCard?.length !== equivalence.target.cardFieldCount ||
            !fieldMatchesSelector(targetField, equivalence.target,
                normalizeFieldName(equivalence.target.fieldName))) continue;
        const representative = matched[0];
        const synthesized = {
            ...representative,
            authoringRelationId: equivalence.id,
            coordinateId: equivalence.id,
            field: { ...representative.field, ...equivalence.target },
            operationalProjection: {
                ...representative.operationalProjection,
                physicalTableId: equivalence.id,
                physicalFieldId: equivalence.id,
                sourceKind: 'duplicate-table-representation-equivalence',
                ambiguous: false,
                candidateCount: 1,
                duplicateRepresentationEquivalenceId: equivalence.id,
                representationAuthoringRelationIds: equivalence.representations
                    .map(item => item.authoringRelationId),
                representationPhysicalTableIds: equivalence.representations
                    .map(item => item.physicalTableId),
                representationPhysicalFieldIds: equivalence.representations
                    .map(item => item.physicalFieldId),
            },
        };
        const key = mappedFieldKey(equivalence.target.cardIndex, targetField);
        if (!key || result.has(key)) return new Map();
        result.set(key, [synthesized]);
    }
    return result;
}

function isProtectedOptionTableSelectionRecord(keyword, record, compiledCorrections) {
    if (!compiledCorrections) return false;
    if (compiledCorrections.protectedOptionSelectionRelations.has(record?.authoringRelationId)) {
        return true;
    }
    const normalizedKeyword = normalizeKeyword(keyword);
    return (compiledCorrections.optionTableSelections.get(normalizedKeyword) || [])
        .some(selection => record?.sourceRuleId === selection.sourceRuleId &&
            canonicalJson({
                cardIndex: record.field?.cardIndex,
                cardFieldCount: record.field?.cardFieldCount,
                fieldIndex: record.field?.fieldIndex,
                fieldName: record.field?.fieldName,
                fieldType: record.field?.fieldType,
                position: record.field?.position,
                width: record.field?.width,
            }) === canonicalJson(selection.source));
}

function optionTableSelectionMappings(
    keyword, activeOptions, cards, runtimeRecords, compiledCorrections,
) {
    const result = new Map();
    const normalizedKeyword = normalizeKeyword(keyword);
    const selections = compiledCorrections?.optionTableSelections.get(normalizedKeyword) || [];
    for (const selection of selections) {
        if (canonicalJson((activeOptions || []).map(normalizeKeyword)) !==
            canonicalJson(selection.activeOptions)) continue;
        const alternatives = [selection.selected, ...selection.excluded];
        const expectedIds = new Set(alternatives.map(item => item.authoringRelationId));
        const sourcePeers = runtimeRecords.filter(record =>
            record.sourceRuleId === selection.sourceRuleId &&
            canonicalJson({
                cardIndex: record.field?.cardIndex,
                cardFieldCount: record.field?.cardFieldCount,
                fieldIndex: record.field?.fieldIndex,
                fieldName: record.field?.fieldName,
                fieldType: record.field?.fieldType,
                position: record.field?.position,
                width: record.field?.width,
            }) === canonicalJson(selection.source));
        if (sourcePeers.length !== alternatives.length ||
            sourcePeers.some(record => !expectedIds.has(record.authoringRelationId)) ||
            new Set(sourcePeers.map(record => record.authoringRelationId)).size !==
                alternatives.length) continue;
        const matched = [];
        for (const alternative of alternatives) {
            const records = sourcePeers.filter(record =>
                record.authoringRelationId === alternative.authoringRelationId);
            if (records.length !== 1) { matched.length = 0; break; }
            const record = records[0];
            const projection = record.operationalProjection;
            if (projection?.physicalTableId !== alternative.physicalTableId ||
                projection?.physicalFieldId !== alternative.physicalFieldId ||
                projection?.sectionId !== selection.sectionId ||
                normalizeKeyword(projection?.sourceSelectorKeyword) !==
                    normalizeKeyword(selection.sourceSelectorKeyword) ||
                normalizeKeyword(projection?.projectedSourceKeyword) !== normalizedKeyword ||
                projection?.sourceKeywordStrategy !== 'concrete-keyword' ||
                projection?.strategy !== 'concrete-keyword-field-name' ||
                projection?.ambiguous !== true ||
                projection?.candidateCount !== alternative.candidateCount) {
                matched.length = 0; break;
            }
            matched.push(record);
        }
        if (matched.length !== alternatives.length || matched.some(record =>
            canonicalJson(record.relation) !== canonicalJson(matched[0].relation) ||
            record.kind !== matched[0].kind)) continue;
        const targetCard = cards[selection.target.cardIndex - 1];
        const targetField = targetCard?.[selection.target.fieldIndex];
        if (targetCard?.length !== selection.target.cardFieldCount ||
            !fieldMatchesSelector(targetField, selection.target,
                normalizeFieldName(selection.target.fieldName))) continue;
        const selectedRecord = matched.find(record =>
            record.authoringRelationId === selection.selected.authoringRelationId);
        if (!selectedRecord) continue;
        const synthesized = {
            ...selectedRecord,
            authoringRelationId: selection.id,
            coordinateId: selection.id,
            field: { ...selectedRecord.field, ...selection.target },
            operationalProjection: {
                ...selectedRecord.operationalProjection,
                physicalTableId: selection.id,
                physicalFieldId: selection.id,
                sourceKind: 'option-table-selection',
                ambiguous: false,
                candidateCount: 1,
                optionTableSelectionId: selection.id,
                activeOptions: selection.activeOptions,
                selectedAuthoringRelationId: selection.selected.authoringRelationId,
                selectedPhysicalTableId: selection.selected.physicalTableId,
                selectedPhysicalFieldId: selection.selected.physicalFieldId,
                excludedAuthoringRelationIds: selection.excluded
                    .map(item => item.authoringRelationId),
                excludedPhysicalTableIds: selection.excluded.map(item => item.physicalTableId),
                excludedPhysicalFieldIds: selection.excluded.map(item => item.physicalFieldId),
            },
        };
        const key = mappedFieldKey(selection.target.cardIndex, targetField);
        if (!key || result.has(key)) return new Map();
        result.set(key, [synthesized]);
    }
    return result;
}

function isProtectedDirectSourceFieldSelectionRecord(keyword, record, compiledCorrections) {
    if (!compiledCorrections) return false;
    const normalizedKeyword = normalizeKeyword(keyword);
    return compiledCorrections.protectedDirectSelectionRelations.has(
        record?.authoringRelationId,
    ) || compiledCorrections.protectedDirectSelectionRules.has(
        `${normalizedKeyword}|${record?.sourceRuleId || ''}`,
    ) || (compiledCorrections.directSourceFieldSelections.get(normalizedKeyword) || [])
        .some(selection => selectorLayoutSignature(record?.field) ===
            selectorLayoutSignature(selection.target));
}

function directSourceFieldSelectionMappings(
    keyword, activeOptions, cards, runtimeRecords, compiledCorrections,
) {
    const result = new Map();
    const normalizedKeyword = normalizeKeyword(keyword);
    const selections = compiledCorrections?.directSourceFieldSelections
        .get(normalizedKeyword) || [];
    for (const selection of selections) {
        if (canonicalJson((activeOptions || []).map(normalizeKeyword)) !==
            canonicalJson(selection.activeOptions)) continue;
        const peers = runtimeRecords.filter(record =>
            record.sourceRuleId === selection.sourceRuleId);
        if (peers.length !== selection.candidateCount || peers.some(record =>
            record.manualRelationId !== selection.manualRelationId ||
            canonicalJson(record.relation) !== canonicalJson(selection.relation) ||
            record.kind !== 'entity-reference' ||
            record.operationalProjection?.ambiguous !== true ||
            record.operationalProjection?.candidateCount !== selection.candidateCount ||
            normalizeKeyword(record.operationalProjection?.projectedSourceKeyword) !==
                normalizedKeyword ||
            record.operationalProjection?.strategy !== 'global-field-name')) continue;
        const selected = peers.filter(record =>
            record.authoringRelationId === selection.selectedAuthoringRelationId);
        if (selected.length !== 1) continue;
        const selectedRecord = selected[0];
        const projection = selectedRecord.operationalProjection;
        const selectedSource = {
            cardIndex: selectedRecord.field?.cardIndex,
            cardFieldCount: selectedRecord.field?.cardFieldCount,
            fieldIndex: selectedRecord.field?.fieldIndex,
            fieldName: selectedRecord.field?.fieldName,
            fieldType: selectedRecord.field?.fieldType,
            position: selectedRecord.field?.position,
            width: selectedRecord.field?.width,
        };
        if (canonicalJson(selectedSource) !== canonicalJson(selection.source) ||
            projection?.sectionId !== selection.sectionId ||
            projection?.physicalTableId !== selection.physicalTableId ||
            projection?.physicalFieldId !== selection.physicalFieldId ||
            normalizeKeyword(projection?.sourceSelectorKeyword) !==
                normalizeKeyword(selection.sourceSelectorKeyword) ||
            projection?.sourceKeywordStrategy !== 'concrete-keyword') continue;
        const targetCard = cards[selection.target.cardIndex - 1];
        const targetField = targetCard?.[selection.target.fieldIndex];
        if (targetCard?.length !== selection.target.cardFieldCount ||
            !fieldMatchesSelector(targetField, selection.target,
                normalizeFieldName(selection.target.fieldName))) continue;
        if (selection.targetBindingStatus === 'sibling-discriminator-required') {
            const bindingField = targetCard.find(field =>
                normalizeFieldName(field?.n) ===
                    normalizeFieldName(selection.targetBindingField));
            if (!bindingField || canonicalJson(bindingField.e || []) !==
                canonicalJson(selection.targetBindingValues)) continue;
        }
        if (selection.targetBindingStatus === 'sibling-discriminator-approved') {
            const bindingField = targetCard[selection.targetBinding.selector.fieldIndex];
            if (!fieldMatchesSelector(bindingField, selection.targetBinding.selector,
                normalizeFieldName(selection.targetBindingField)) ||
                canonicalJson(bindingField.e || []) !==
                    canonicalJson(selection.targetBindingValues) ||
                String(bindingField.d) !== String(selection.targetBinding.defaultValue)) continue;
        }
        const excludedIds = peers
            .filter(record => record !== selectedRecord)
            .map(record => record.authoringRelationId).sort();
        const targetBindingComplete = ['exact-target-keyword-approved',
            'sibling-discriminator-approved'].includes(selection.targetBindingStatus);
        const synthesized = {
            ...selectedRecord,
            relation: selection.targetBindingStatus === 'sibling-discriminator-approved'
                ? siblingTargetRelation(selection.targetBinding)
                : targetBindingComplete ? selection.approvedTargetRelation
                    : selectedRecord.relation,
            authoringRelationId: selection.id,
            coordinateId: selection.id,
            field: { ...selectedRecord.field, ...selection.target },
            operationalProjection: {
                ...projection,
                physicalTableId: selection.id,
                physicalFieldId: selection.id,
                sourceKind: 'direct-source-field-selection',
                ambiguous: false,
                candidateCount: 1,
                targetBindingComplete,
                targetBindingStatus: selection.targetBindingStatus,
                targetBindingField: selection.targetBindingField,
                targetBindingValues: selection.targetBindingValues,
                directTargetFormats: selection.targetFormats,
                siblingTargetBinding: selection.targetBindingStatus ===
                    'sibling-discriminator-approved' ? selection.targetBinding : null,
                directSourceFieldSelectionId: selection.id,
                selectedAuthoringRelationId: selection.selectedAuthoringRelationId,
                selectedPhysicalTableId: selection.physicalTableId,
                selectedPhysicalFieldId: selection.physicalFieldId,
                excludedAuthoringRelationIds: excludedIds,
            },
        };
        const key = mappedFieldKey(selection.target.cardIndex, targetField);
        if (!key || result.has(key)) return new Map();
        result.set(key, [synthesized]);
    }
    return result;
}

function recordMatchesRuntimeTableScope(keyword, record, compiledCorrections) {
    const projection = record?.operationalProjection;
    const key = `${normalizeKeyword(keyword)}|${projection?.physicalTableId || ''}`;
    const scope = compiledCorrections?.tableScopes.get(key);
    if (!scope) return true;
    const locked = scope.records.get(record?.authoringRelationId || '');
    return Boolean(locked &&
        record.sourceRuleId === locked.sourceRuleId &&
        record.field?.fieldIndex === locked.fieldIndex &&
        projection?.physicalFieldId === locked.physicalFieldId &&
        normalizeKeyword(projection?.projectedSourceKeyword) === scope.keyword &&
        normalizeKeyword(projection?.sourceSelectorKeyword) === scope.keyword &&
        projection?.strategy === scope.strategy &&
        projection?.ambiguous === false && projection?.candidateCount === 1);
}

function correctedRuntimeTableSelector(keyword, record, compiledCorrections) {
    const selector = record?.field;
    if (!compiledCorrections) return selector;
    const correction = compiledCorrections.byRelation.get(
        `${normalizeKeyword(keyword)}|${record?.authoringRelationId || ''}`,
    );
    if (!correction) return selector;
    const actual = {
        cardIndex: selector?.cardIndex,
        cardFieldCount: selector?.cardFieldCount,
        fieldIndex: selector?.fieldIndex,
        fieldName: selector?.fieldName,
        fieldType: selector?.fieldType,
        position: selector?.position,
        width: selector?.width,
    };
    if (canonicalJson(actual) !== canonicalJson(correction.from) ||
        record?.sourceRuleId !== correction.sourceRuleId ||
        record?.operationalProjection?.physicalTableId !== correction.physicalTableId ||
        record?.operationalProjection?.physicalFieldId !== correction.physicalFieldId) return null;
    return { ...selector, ...correction.to };
}

function selectorLayoutSignature(selector) {
    const name = normalizeFieldName(selector?.fieldName);
    const type = normalizeFieldType(selector?.fieldType);
    if (!name || !type || !Number.isInteger(selector?.position) ||
        !Number.isInteger(selector?.width) || selector.width <= 0) return null;
    return JSON.stringify([name, type, selector.position, selector.width]);
}

function mappedFieldKey(cardIndex, field) {
    const name = normalizeFieldName(field?.n ?? field?.fieldName);
    const type = normalizeFieldType(field?.t ?? field?.fieldType);
    const position = field?.p ?? field?.position;
    const width = field?.w ?? field?.width;
    if (!Number.isInteger(cardIndex) || cardIndex < 1 || !name || !type ||
        !Number.isInteger(position) || !Number.isInteger(width) || width <= 0) return null;
    return JSON.stringify([cardIndex, name, type, position, width]);
}

/**
 * Some producer records retain the manual table identity but collapse every
 * table-local card ordinal to Card 1.  Recover only tables whose complete
 * physical field signature is present in the source-locked runtime.  The
 * complete table must match exactly one rendered schema card, and that target
 * card must be claimed by exactly one complete physical table.  A partial
 * table, duplicated layout, option-only card, or upstream drift maps nothing.
 */
function buildRuntimeTableLayoutIndex(
    keyword,
    runtimeCatalog,
    correctionRegistry = runtimeTableLayoutCorrections,
) {
    const lookup = lookupKeywordSchema(keyword, loadKeywordSchema(() => 'en'));
    if (!lookup) return new Map();
    const cards = getRenderedCardsForLookup(lookup);
    const runtimeRecords = runtimeCatalog.referenceRecordsForKeyword(keyword);
    const compiledCorrections = compileRuntimeTableCorrections(correctionRegistry);
    if (!compiledCorrections) return new Map();
    const groups = new Map();
    for (const record of runtimeRecords) {
        if (isProtectedDuplicateRepresentationRecord(keyword, record, compiledCorrections)) {
            continue;
        }
        if (isProtectedOptionTableSelectionRecord(keyword, record, compiledCorrections)) continue;
        if (isProtectedDirectSourceFieldSelectionRecord(
            keyword, record, compiledCorrections,
        )) continue;
        const rawSelector = record?.field;
        const selector = correctedRuntimeTableSelector(keyword, record, compiledCorrections);
        const tableId = record?.operationalProjection?.physicalTableId;
        if (!recordMatchesRuntimeTableScope(keyword, record, compiledCorrections)) continue;
        if (typeof tableId !== 'string' || !tableId ||
            !Number.isInteger(rawSelector?.cardFieldCount) || rawSelector.cardFieldCount < 1 ||
            !Number.isInteger(rawSelector?.fieldIndex) || rawSelector.fieldIndex < 0 ||
            rawSelector.fieldIndex >= rawSelector.cardFieldCount) continue;
        let group = groups.get(tableId);
        if (!group) {
            group = {
                fieldCount: rawSelector.cardFieldCount,
                fields: new Map(),
                records: [],
                invalid: false,
            };
            groups.set(tableId, group);
        }
        if (group.fieldCount !== rawSelector.cardFieldCount || !selector) group.invalid = true;
        const signature = selectorLayoutSignature(selector);
        if (!signature) group.invalid = true;
        const previous = group.fields.get(rawSelector.fieldIndex);
        if (previous && previous !== signature) group.invalid = true;
        if (signature) group.fields.set(rawSelector.fieldIndex, signature);
        group.records.push(record);
    }

    const completeTableIds = new Set();
    const candidates = [];
    const targetCounts = new Map();
    for (const [tableId, group] of groups) {
        const scope = compiledCorrections?.tableScopes.get(
            `${normalizeKeyword(keyword)}|${tableId}`,
        );
        if (scope && (group.records.length !== scope.records.size ||
            unique(group.records.map(record => record.authoringRelationId)).length !==
                scope.records.size)) continue;
        if (group.fields.size !== group.fieldCount ||
            [...Array(group.fieldCount).keys()].some(index => !group.fields.has(index))) continue;
        completeTableIds.add(tableId);
        if (group.invalid) continue;
        const fields = [];
        for (let index = 0; index < group.fieldCount; index++) {
            const signature = group.fields.get(index);
            if (!signature) { group.invalid = true; break; }
            fields.push(JSON.parse(signature));
        }
        if (group.invalid) continue;
        const tableSignature = JSON.stringify(fields);
        const matches = cards.map((card, index) => ({
            cardIndex: index + 1,
            signature: cardLayoutSignature(card),
        })).filter(candidate => candidate.signature === tableSignature);
        if (matches.length !== 1) continue;
        const candidate = { group, cardIndex: matches[0].cardIndex };
        candidates.push(candidate);
        targetCounts.set(candidate.cardIndex, (targetCounts.get(candidate.cardIndex) || 0) + 1);
    }

    const result = duplicateRepresentationMappings(
        keyword, cards, runtimeRecords, compiledCorrections,
    );
    const optionSelections = optionTableSelectionMappings(
        keyword, lookup.activeOptions, cards, runtimeRecords, compiledCorrections,
    );
    for (const [key, records] of optionSelections) {
        if (result.has(key)) return new Map();
        result.set(key, records);
    }
    const directSelections = directSourceFieldSelectionMappings(
        keyword, lookup.activeOptions, cards, runtimeRecords, compiledCorrections,
    );
    for (const [key, records] of directSelections) {
        if (result.has(key)) return new Map();
        result.set(key, records);
    }
    for (const { group, cardIndex } of candidates) {
        if (targetCounts.get(cardIndex) !== 1) continue;
        const sourceCardIndices = unique(group.records.map(record => record.field.cardIndex));
        if (sourceCardIndices.length !== 1 || sourceCardIndices[0] === cardIndex) continue;
        for (const record of group.records) {
            const field = cards[cardIndex - 1]?.[record.field.fieldIndex];
            const key = mappedFieldKey(cardIndex, field);
            if (!key || selectorLayoutSignature(correctedRuntimeTableSelector(
                keyword, record, compiledCorrections,
            )) !==
                JSON.stringify(JSON.parse(key).slice(1))) continue;
            if (!result.has(key)) result.set(key, []);
            result.get(key).push(record);
        }
    }

    // A runtime may contain only the reference-bearing subset of a physical
    // table, so a complete table signature is not always available.  In that
    // case retain the source-locked physicalFieldId and require its exact
    // name/type/position/width signature to occur once across every rendered
    // card.  A target coordinate claimed by two physical identities is not a
    // tie to break: both remain blocked.
    const physicalFields = new Map();
    for (const record of runtimeRecords) {
        if (isProtectedDuplicateRepresentationRecord(keyword, record, compiledCorrections)) {
            continue;
        }
        if (isProtectedOptionTableSelectionRecord(keyword, record, compiledCorrections)) continue;
        if (isProtectedDirectSourceFieldSelectionRecord(
            keyword, record, compiledCorrections,
        )) continue;
        const selector = record?.field;
        const physicalFieldId = record?.operationalProjection?.physicalFieldId;
        const physicalTableId = record?.operationalProjection?.physicalTableId;
        if (typeof physicalFieldId !== 'string' || !physicalFieldId ||
            typeof physicalTableId !== 'string' || !physicalTableId ||
            (completeTableIds.has(physicalTableId) || compiledCorrections?.protectedTables.has(
                `${normalizeKeyword(keyword)}|${physicalTableId}`,
            ))) continue;
        let group = physicalFields.get(physicalFieldId);
        if (!group) {
            group = {
                signature: selectorLayoutSignature(selector),
                tableId: physicalTableId,
                sourceCardIndex: selector?.cardIndex,
                fieldIndex: selector?.fieldIndex,
                records: [],
                invalid: false,
            };
            physicalFields.set(physicalFieldId, group);
        }
        if (!group.signature || group.signature !== selectorLayoutSignature(selector) ||
            group.tableId !== physicalTableId || group.sourceCardIndex !== selector?.cardIndex ||
            group.fieldIndex !== selector?.fieldIndex) group.invalid = true;
        group.records.push(record);
    }

    const physicalCandidates = [];
    const physicalTargetCounts = new Map();
    for (const [physicalFieldId, group] of physicalFields) {
        if (group.invalid || !Number.isInteger(group.sourceCardIndex) ||
            !Number.isInteger(group.fieldIndex)) continue;
        const matches = [];
        for (let cardOffset = 0; cardOffset < cards.length; cardOffset++) {
            for (let fieldIndex = 0; fieldIndex < cards[cardOffset].length; fieldIndex++) {
                if (selectorLayoutSignature({
                    fieldName: cards[cardOffset][fieldIndex].n,
                    fieldType: cards[cardOffset][fieldIndex].t,
                    position: cards[cardOffset][fieldIndex].p,
                    width: cards[cardOffset][fieldIndex].w,
                }) === group.signature) {
                    matches.push({ cardIndex: cardOffset + 1, fieldIndex });
                }
            }
        }
        if (matches.length !== 1 || matches[0].cardIndex === group.sourceCardIndex) continue;
        const candidate = { physicalFieldId, group, ...matches[0] };
        physicalCandidates.push(candidate);
        const targetKey = JSON.stringify([candidate.cardIndex, candidate.fieldIndex]);
        physicalTargetCounts.set(targetKey, (physicalTargetCounts.get(targetKey) || 0) + 1);
    }
    for (const candidate of physicalCandidates) {
        const targetKey = JSON.stringify([candidate.cardIndex, candidate.fieldIndex]);
        if (physicalTargetCounts.get(targetKey) !== 1) continue;
        const field = cards[candidate.cardIndex - 1]?.[candidate.fieldIndex];
        const key = mappedFieldKey(candidate.cardIndex, field);
        if (!key || result.has(key)) continue;
        result.set(key, candidate.group.records);
    }
    return result;
}

function runtimeTableMappedFieldRelations(keyword, cardIndex, field) {
    const runtimeCatalog = getSemanticRuntimeCatalogV2();
    let byKeyword = runtimeTableLayoutCache.get(runtimeCatalog);
    if (!byKeyword) {
        byKeyword = new Map();
        runtimeTableLayoutCache.set(runtimeCatalog, byKeyword);
    }
    const normalizedKeyword = normalizeKeyword(keyword);
    if (!byKeyword.has(normalizedKeyword)) {
        byKeyword.set(normalizedKeyword,
            buildRuntimeTableLayoutIndex(normalizedKeyword, runtimeCatalog));
    }
    const key = mappedFieldKey(cardIndex, field);
    return key ? byKeyword.get(normalizedKeyword).get(key) || [] : [];
}

function registryRelationsForField(registryCatalog, keyword, cardIndex, field) {
    const direct = registryCatalog.fieldRelations(keyword, cardIndex, field)
        .map(record => applyRuntimeSemanticRelationCorrection(record));
    if (direct.some(isUnambiguousOperationalProjection)) return direct;
    const mapped = runtimeTableMappedFieldRelations(keyword, cardIndex, field)
        .map(record => applyRuntimeSemanticRelationCorrection(record));
    return mapped.length > 0 ? mapped : direct;
}

function schemaMappedFieldRules(keyword, cardIndex, field, catalog) {
    const schema = loadKeywordSchema(() => 'en');
    const lookup = lookupKeywordSchema(keyword, schema);
    if (!lookup) return [];

    const canonicalLookup = lookupKeywordSchema(lookup.canonicalName, schema);
    if (!canonicalLookup) return [];
    const canonicalCards = getRenderedCardsForLookup(canonicalLookup);
    const requestedCards = getRenderedCardsForLookup(lookup);
    const fieldName = normalizeFieldName(field?.n ?? field);
    return catalog.rulesForKeyword(lookup.canonicalName).filter(rule => {
        const selector = rule.selector;
        if (!selector || normalizeFieldName(selector.fieldName) !== fieldName) return false;
        if (!selectorMapsToRequestedCard(
            selector,
            canonicalCards,
            requestedCards,
            cardIndex,
        )) return false;
        return typeof field !== 'object' || providedFieldMatchesSelector(field, selector, fieldName);
    });
}

function manualRulesForField(keyword, cardIndex, field) {
    const catalog = getManualSemanticCatalog();
    const fieldName = normalizeFieldName(field?.n ?? field);
    const exact = catalog.fieldRules(keyword, cardIndex, fieldName);
    const safeExact = typeof field === 'object'
        ? exact.filter(rule => providedFieldMatchesSelector(field, rule.selector, fieldName))
        : exact;
    return safeExact.length > 0
        ? safeExact
        : schemaMappedFieldRules(keyword, cardIndex, field, catalog);
}

function chooseReferenceRule(rules) {
    // value-branch is the complete role partition when both projections were published;
    // entity-reference may intentionally contain only the reference-producing subset.
    return rules.find(rule =>
            rule.kind === 'value-branch' &&
            (rule.relation?.branches || []).some(branch => branch?.role === 'reference')
        ) || rules.find(rule => rule.kind === 'entity-reference') || null;
}

function publishedEvidenceLocations(evidence) {
    const result = [];
    for (const item of evidence || []) {
        const locations = Array.isArray(item?.locations) && item.locations.length > 0
            ? item.locations
            : [item];
        for (const location of locations) {
            const manualId = String(location?.manualId || item?.manualId || '');
            const page = Number(location?.page ?? item?.page);
            const sourceProfileId = String(
                location?.sourceProfileId || item?.sourceProfileId || '',
            );
            if (!item?.evidenceId || !manualId || !Number.isInteger(page) || page < 1) continue;
            result.push({
                evidenceId: item.evidenceId,
                manualId,
                page,
                ...(sourceProfileId ? { sourceProfileId } : {}),
            });
        }
    }
    return result;
}

function registryReferenceInfo(record, registryCatalog, keyword, cardIndex, field) {
    if (!record) return null;
    const relation = record.relation || {};
    const targets = referenceTargets(relation);
    if (targets.targetKinds.length === 0 && targets.targetDefinitions.length === 0) return null;
    return {
        keyword,
        cardIndex,
        fieldName: normalizeFieldName(field.n),
        fieldType: field.t || record.field?.fieldType,
        ...targets,
        relation,
        contextualReferenceBranch:
            record.runtimeSemanticCorrection?.contextualReferenceBranch || null,
        ruleId: record.sourceRuleId,
        evidence: publishedEvidenceLocations(record.evidence),
        summary: '',
        conditional: Array.isArray(relation.branches) && relation.branches.length > 0,
        confidence: 'manual-explicit',
        source: 'official-manual-definition-registry',
        definitionRegistry: {
            approved: true,
            authoringRelationId: record.authoringRelationId,
            coordinateId: record.coordinateId,
            sourceRuleId: record.sourceRuleId,
            decisionId: record.review?.decisionId || record.authoringRelationId,
            retainedReviewState: record.review?.retainedReviewState || 'operational-default',
            f12Authorized: registryCatalog.permission('f12Permission') &&
                isUnambiguousOperationalProjection(record),
            selectorSource: 'operational-projection',
            operationalProjection: record.operationalProjection || null,
            ...(record.familyProjection ? {
                familyProjectionId: record.familyProjection.familyProjectionId,
                projectionApprovalId: record.familyProjection.projectionApprovalId,
                familyKeyword: record.familyProjection.manualKeyword,
                familyOption: record.familyProjection.option,
            } : record.operationalProjection?.sourceSelectorKeyword &&
                normalizeKeyword(record.operationalProjection.sourceSelectorKeyword) !== normalizeKeyword(keyword)
                ? {
                    familyKeyword: record.operationalProjection.sourceSelectorKeyword,
                    familyOption: normalizeKeyword(keyword).replace(
                        `${normalizeKeyword(record.operationalProjection.sourceSelectorKeyword)}_`, ''),
                    familyProjectionId: `operational-projection:${record.authoringRelationId.split(':')[1]}`,
                }
                : {}),
        },
    };
}

function getFieldReferenceInfo({ keyword, cardIndex, field }) {
    if (!field || !field.n || !Number.isInteger(cardIndex) || cardIndex < 1) {
        return null;
    }
    const normalizedKeyword = normalizeKeyword(keyword);
    const normalizedField = normalizeFieldName(field.n);
    const registryCatalog = getDefinitionRegistryCatalog();
    const rules = manualRulesForField(normalizedKeyword, cardIndex, field);
    const rule = chooseReferenceRule(rules);
    if (!rule) {
        const directRegistryRecord = chooseReferenceRule(
            registryRelationsForField(registryCatalog, normalizedKeyword, cardIndex, field),
        );
        return directRegistryRecord ? registryReferenceInfo(
            directRegistryRecord,
            registryCatalog,
            normalizedKeyword,
            cardIndex,
            field,
        ) : null;
    }

    const sourceRuleCandidates = registryCatalog.rulesForSourceRuleId(rule.ruleId)
        .filter(record => record.kind === rule.kind)
        .map(record => applyRuntimeSemanticRelationCorrection(record));
    const concreteSourceRuleCandidates = sourceRuleCandidates.filter(record =>
        normalizeKeyword(record.field?.keyword) === normalizedKeyword
    );
    const fieldRegistryCandidates = registryRelationsForField(registryCatalog,
        normalizedKeyword, cardIndex, field,
    ).filter(record => record.kind === rule.kind);
    const exactUnambiguous = fieldRegistryCandidates.filter(record =>
        record.operationalProjection?.ambiguous !== true &&
        canonicalJson(record.relation) === canonicalJson(rule.relation)
    );
    const manualApproval = applyRuntimeSemanticRelationCorrection(
        registryCatalog.approvedRecordForManualRule(rule),
    );
    const approvedRegistryRecord =
        (isUnambiguousOperationalProjection(manualApproval) ? manualApproval : null) ||
        (exactUnambiguous.length === 1 ? exactUnambiguous[0] : null) ||
        fieldRegistryCandidates.find(record =>
            record.sourceRuleId === rule.ruleId && record.kind === rule.kind
        ) || manualApproval ||
        (concreteSourceRuleCandidates.length === 1 ? concreteSourceRuleCandidates[0] : null) ||
        (sourceRuleCandidates.length === 1 ? sourceRuleCandidates[0] : null);

    const approvedDirectSelection = approvedRegistryRecord?.operationalProjection?.sourceKind ===
        'direct-source-field-selection' &&
        approvedRegistryRecord.operationalProjection.targetBindingComplete === true;
    const relation = approvedDirectSelection || approvedRegistryRecord?.runtimeSemanticCorrection
        ? approvedRegistryRecord.relation || {}
        : rule.relation || {};
    const targets = referenceTargets(relation);
    if (targets.targetKinds.length === 0 && targets.targetDefinitions.length === 0) {
        return null;
    }
    return {
        keyword: normalizedKeyword,
        cardIndex,
        fieldName: normalizedField,
        fieldType: field.t || rule.selector?.fieldType,
        ...targets,
        relation,
        contextualReferenceBranch:
            approvedRegistryRecord?.runtimeSemanticCorrection?.contextualReferenceBranch || null,
        ruleId: rule.ruleId,
        evidence: publishedEvidenceLocations(rule.evidence),
        summary: rule.summary || '',
        conditional: Array.isArray(relation.branches) && relation.branches.length > 0,
        confidence: 'manual-explicit',
        source: 'official-manual',
        ...(approvedRegistryRecord ? {
            definitionRegistry: {
                approved: true,
                authoringRelationId: approvedRegistryRecord.authoringRelationId,
                coordinateId: approvedRegistryRecord.coordinateId,
                sourceRuleId: approvedRegistryRecord.sourceRuleId,
                decisionId: approvedRegistryRecord.review?.decisionId || approvedRegistryRecord.authoringRelationId,
                retainedReviewState: approvedRegistryRecord.review?.retainedReviewState || 'operational-default',
                f12Authorized: registryCatalog.permission('f12Permission') &&
                    isUnambiguousOperationalProjection(approvedRegistryRecord),
                selectorSource: providedFieldMatchesSelector(
                    field, approvedRegistryRecord.field, normalizedField,
                ) ? 'operational-projection' : 'manual-semantic',
                operationalProjection: approvedRegistryRecord.operationalProjection || null,
                ...(approvedRegistryRecord.familyProjection ? {
                    familyProjectionId: approvedRegistryRecord.familyProjection.familyProjectionId,
                    projectionApprovalId: approvedRegistryRecord.familyProjection.projectionApprovalId,
                    familyKeyword: approvedRegistryRecord.familyProjection.manualKeyword,
                    familyOption: approvedRegistryRecord.familyProjection.option,
                } : approvedRegistryRecord.operationalProjection?.sourceSelectorKeyword &&
                    normalizeKeyword(approvedRegistryRecord.operationalProjection.sourceSelectorKeyword) !== normalizedKeyword
                    ? {
                        familyKeyword: approvedRegistryRecord.operationalProjection.sourceSelectorKeyword,
                        familyOption: normalizedKeyword.replace(
                            `${normalizeKeyword(approvedRegistryRecord.operationalProjection.sourceSelectorKeyword)}_`, ''),
                        familyProjectionId: `operational-projection:${approvedRegistryRecord.authoringRelationId.split(':')[1]}`,
                    }
                    : {}),
            },
        } : {}),
    };
}

function getActionableFieldReferenceInfo(options) {
    const info = getFieldReferenceInfo(options);
    const registryCatalog = getDefinitionRegistryCatalog();
    const exactDefinition = registryRelationsForField(registryCatalog,
        options.keyword, options.cardIndex, options.field,
    ).some(record => record.kind === 'entity-definition');
    const scannerDefinition = getSemanticRuntimeCatalogV2()
        .definitionScannersForKeyword(options.keyword)
        .some(scanner => {
            const standard = (scanner.formatContracts || []).find(contract =>
                contract.format === 'standard' && contract.mode === 'fixed');
            return scanner.permissions?.scan === true &&
                scanner.physicalSelector?.dataRecordOrdinal === options.cardIndex - 1 &&
                normalizeFieldName(scanner.definitionField) === normalizeFieldName(options.field?.n) &&
                standard?.position === options.field?.p && standard?.width === options.field?.w;
        });
    const exactManualSelector = info?.definitionRegistry?.selectorSource !== 'manual-semantic' ||
        manualRulesForField(options.keyword, options.cardIndex, options.field).some(rule =>
            rule.ruleId === info.ruleId &&
            providedFieldMatchesSelector(
                options.field, rule.selector, normalizeFieldName(options.field?.n),
            )
        );
    return info?.definitionRegistry?.approved === true &&
        options.field?.di !== 'self' &&
        !exactDefinition && !scannerDefinition &&
        exactManualSelector &&
        isUnambiguousOperationalProjection(info.definitionRegistry) &&
        isCoherentReferenceTargetNamespace(info) &&
        hasRealizableNumericReferenceWitness(info, options.field) ? info : null;
}

function hasRealizableNumericReferenceWitness(info, field) {
    const fieldType = String(field?.t || '').toLowerCase();
    if (!['integer', 'real', 'float'].includes(fieldType)) return true;
    const candidates = new Set([
        -1_000_001, -1_001, -100, -10, -2, -1,
        1, 2, 10, 100, 1_001, 1_000_001,
    ]);
    const collectThresholds = value => {
        if (!value || typeof value !== 'object') return;
        if (Number.isFinite(value.value)) {
            candidates.add(value.value);
            candidates.add(value.value - 1);
            candidates.add(value.value + 1);
        }
        for (const child of Object.values(value)) collectThresholds(child);
    };
    collectThresholds(info?.relation);
    for (const candidate of candidates) {
        if (candidate !== 0 && Number.isSafeInteger(candidate) &&
            parseFieldReferenceValue(String(candidate), info)) return true;
    }
    return false;
}

function getRegistryApprovedFieldReferenceInfo(options) {
    const info = getActionableFieldReferenceInfo(options);
    if (info?.definitionRegistry?.approved !== true) return null;
    return info;
}

function resolveReferenceValueSemantics(infoOrRelation, rawValue) {
    const relation = infoOrRelation?.relation || infoOrRelation;
    if (!relation || typeof relation !== 'object') {
        return { state: 'indeterminate', reason: 'reference-relation-unavailable' };
    }
    const resolved = resolveValueRole(relation, rawValue);
    if (resolved.state !== 'resolved') {
        return {
            state: 'indeterminate',
            reason: resolved.reason || 'reference-predicate-indeterminate',
            resolution: resolved,
        };
    }
    if (resolved.role !== 'reference') {
        return { state: 'non-reference', role: resolved.role, resolution: resolved };
    }
    const id = applyReferenceIdTransform(rawValue, resolved.idTransform || 'identity');
    if (id === null) {
        return {
            state: 'indeterminate',
            reason: 'reference-id-transform-unsafe',
            resolution: resolved,
        };
    }
    const targets = referenceTargets({
        targetKinds: resolved.targetKinds,
        targetKeywords: resolved.targetKeywords,
    });
    if (targets.targetKinds.length === 0 && targets.targetDefinitions.length === 0) {
        return {
            state: 'indeterminate',
            reason: 'reference-target-unavailable',
            resolution: resolved,
        };
    }
    return {
        state: 'reference',
        id,
        idTransform: resolved.idTransform || 'identity',
        ...targets,
        resolution: resolved,
    };
}

function parseLegacyReferenceValue(input, raw, info) {
    if (input.kind === 'parameter') {
        if (info?.requiresSignedSwitch === true && !input.negated) return null;
        if (input.negated && info?.allowSignedSwitch === false) return null;
        return {
            kind: 'parameter',
            parameterName: input.name,
            raw: input.raw,
            isSignedSwitch: input.negated,
            input,
        };
    }
    if (input.kind !== 'numeric') return null;
    if (info?.requiresSignedSwitch === true && input.value > 0) return null;
    if (input.value < 0 && info?.allowSignedSwitch === false) return null;
    return {
        kind: 'numeric',
        id: Math.abs(input.value),
        raw,
        isSignedSwitch: input.value < 0,
        input,
    };
}

function parseFieldReferenceValue(rawValue, info = null) {
    const raw = String(rawValue || '').trim();
    if (!raw) return null;
    const input = parseNumericInput(raw, { integerOnly: true, nonZero: true });

    // Kept for internal compatibility with callers that parse a value without a semantic rule.
    // Product features always pass an official-manual relation through getFieldReferenceInfo().
    if (!info?.relation) return parseLegacyReferenceValue(input, raw, info);

    if (input.kind === 'parameter') {
        const targets = referenceTargets(info.relation);
        if (targets.targetKinds.length === 0 && targets.targetDefinitions.length === 0) return null;
        return {
            kind: 'parameter',
            parameterName: input.name,
            raw: input.raw,
            isSignedSwitch: input.negated,
            input,
            semanticRelation: info.relation,
            ...targets,
        };
    }
    if (input.kind !== 'numeric') {
        const targets = referenceTargets(info.relation);
        const labelTargets = new Set(['MAT', 'MAT_THERMAL', 'EOS', 'SECTION']);
        const branches = Array.isArray(info.relation?.branches) ? info.relation.branches : [];
        const labelAllowed = info.relation?.kind === 'entity-reference' && branches.length === 0 &&
            targets.targetDefinitions.some(target => labelTargets.has(normalizeTargetKeyword(target))) &&
            !raw.startsWith('&') && !(raw.startsWith('<') && raw.endsWith('>')) &&
            !/^[+-]?\d+$/.test(raw) &&
            isLabelIdentity(raw);
        if (!labelAllowed) return null;
        return {
            kind: 'label',
            id: raw,
            raw,
            isSignedSwitch: false,
            idTransform: 'identity',
            input: { kind: 'label', raw, value: raw },
            semanticRelation: info.relation,
            targetKinds: targets.targetKinds,
            targetDefinitions: targets.targetDefinitions,
        };
    }

    const semantic: any = resolveReferenceValueSemantics(info, input.value);
    if (semantic.state !== 'reference') return null;
    return {
        kind: 'numeric',
        id: semantic.id,
        raw,
        isSignedSwitch: semantic.idTransform !== 'identity',
        idTransform: semantic.idTransform,
        input,
        semanticRelation: info.relation,
        targetKinds: semantic.targetKinds,
        targetDefinitions: semantic.targetDefinitions,
    };
}

function resetFieldReferenceIndexCacheForTesting() {
    runtimeTableLayoutCache = new WeakMap();
    defaultRuntimeSemanticCorrections = undefined;
}

module.exports = {
    buildRuntimeTableLayoutIndex,
    applyRuntimeSemanticRelationCorrection,
    getActionableFieldReferenceInfo,
    getFieldReferenceInfo,
    getRegistryApprovedFieldReferenceInfo,
    isCoherentReferenceTargetNamespace,
    isUnambiguousOperationalProjection,
    manualRulesForField,
    parseFieldReferenceValue,
    referenceTargets,
    resolveReferenceValueSemantics,
    resetFieldReferenceIndexCacheForTesting,
    selectorMapsToRequestedCard,
};

export {};
