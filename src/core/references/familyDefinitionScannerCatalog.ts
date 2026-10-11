'use strict';

const { getSemanticRuntimeCatalogV2 } = require('../semantics/semanticRuntimeV2');

let cache = null;
let keywordCache = new Map();

function legacyDescriptor(descriptor) {
    const standard = descriptor.formatContracts.find(contract => contract.format === 'standard') || {};
    const i10 = descriptor.formatContracts.find(contract => contract.format === 'i10') || {};
    const long = descriptor.formatContracts.find(contract => contract.format === 'long') || {};
    return {
        ...descriptor,
        fieldName: descriptor.definitionField,
        targetToken: descriptor.targetToken || `*${descriptor.keyword}`,
        titleCardCount: descriptor.titleCardCount || 0,
        fieldIndex: descriptor.physicalSelector.fieldIndex,
        dataRecordOrdinal: descriptor.physicalSelector.dataRecordOrdinal,
        recordMode: descriptor.physicalSelector.recordMode,
        position: standard.position,
        width: standard.width,
        valueDomain: {
            kind: descriptor.identityType === 'numeric'
                ? 'positive-integer' : 'positive-integer-or-alphanumeric-label',
            commaDelimited: true,
            i10Width: i10.width,
            longWidth: long.width,
            standardWidth: standard.width,
            ...descriptor.valueDomain,
        },
    };
}

function loadFamilyDefinitionScannerCatalog(prepared = undefined) {
    if (cache) return cache;
    const semantic = getSemanticRuntimeCatalogV2();
    const descriptors = (prepared || semantic.allDefinitionScanners()).map(legacyDescriptor);
    if (!semantic.status().ready || descriptors.length === 0) {
        throw new Error(semantic.status().failureReason || 'family definition scanner runtime unavailable');
    }
    const byKeyword = new Map(descriptors.map(descriptor => [descriptor.keyword, descriptor]));
    if (byKeyword.size !== descriptors.length) throw new Error('family definition scanner runtime duplicate keyword');
    const manifest = semantic.manifest();
    cache = {
        schemaVersion: 2,
        kind: 'dynasense-family-definition-scanner-runtime-v2',
        datasetReleaseId: manifest.datasetReleaseId,
        descriptors,
        byKeyword,
        summary: {
            descriptors: descriptors.length,
            base: descriptors.filter(item => item.titleCardCount === 0).length,
            title: descriptors.filter(item => item.titleCardCount > 0).length,
            labelCapable: descriptors.filter(item => item.identityType === 'label').length,
            integerOnly: descriptors.filter(item => item.identityType === 'numeric').length,
            exact: descriptors.filter(item => item.provenanceKind === 'exact').length,
        },
        permissions: {
            catalogLoadPermission: true,
            scannerExecutionPermission: true,
            definitionRegistryPermission: true,
            definitionProviderPermission: true,
            referenceProviderPermission: true,
        },
        permission(name) { return this.permissions?.[name] === true; },
    };
    return cache;
}

async function prepareFamilyDefinitionScannerCatalog() {
    if (cache) return;
    const prepared = await getSemanticRuntimeCatalogV2().prepareReferences();
    loadFamilyDefinitionScannerCatalog(prepared.scanners);
}

function familyDefinitionKeywords({
    allowCandidate = false,
    requiredPermission = 'definitionProviderPermission',
} = {}) {
    const catalog = loadFamilyDefinitionScannerCatalog();
    const cacheKey = `${allowCandidate}:${requiredPermission}`;
    if (keywordCache.has(cacheKey)) return keywordCache.get(cacheKey);
    if (!catalog.permission('catalogLoadPermission') || !catalog.permission('scannerExecutionPermission') ||
        (!allowCandidate && (!catalog.permission('definitionRegistryPermission') ||
            !catalog.permission(requiredPermission)))) {
        const denied = { onDemand: {} };
        keywordCache.set(cacheKey, denied);
        return denied;
    }
    const keywords = {
        onDemand: Object.fromEntries(catalog.descriptors.map(descriptor => [descriptor.keyword, descriptor])),
    };
    keywordCache.set(cacheKey, keywords);
    return keywords;
}

function resetFamilyDefinitionScannerCatalogForTesting() {
    cache = null;
    keywordCache = new Map();
}

module.exports = { familyDefinitionKeywords, loadFamilyDefinitionScannerCatalog, prepareFamilyDefinitionScannerCatalog,
    resetFamilyDefinitionScannerCatalogForTesting };
export {};
