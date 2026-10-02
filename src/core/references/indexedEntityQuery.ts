'use strict';

const path = require('node:path');
const { getDefinitionRegistryCatalog } = require('./definitionRegistry');
const { isEntityIdentity } = require('./entityIdentity');
const {
    runtimeDefinitionKeywords,
    scanOnDemandDefinitions,
    selectOnDemandDefinitionDescriptors,
} = require('./onDemandDefinitionScanner');
const { buildProjectReferenceIndex } = require('./projectReferenceIndex');
const {
    collectRegistryReferenceMatches,
    definitionLocations,
} = require('./registryReferenceNetwork');

function normalizeFilePath(value) {
    const resolved = path.resolve(String(value || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeIndexedEntityId(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (/^\+?\d+$/.test(raw)) {
        const numeric = Number(raw.replace(/^\+/, ''));
        return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
    }
    return /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(raw) ? raw : null;
}

function indexedEntityKinds({ definitionKeywords = runtimeDefinitionKeywords() } = {}) {
    const kinds = new Set();
    for (const descriptor of Object.values({
        ...(definitionKeywords?.generic || {}),
        ...(definitionKeywords?.onDemand || {}),
    }) as any[]) {
        if (typeof descriptor?.targetKind === 'string' && descriptor.targetKind) {
            kinds.add(descriptor.targetKind);
        }
    }
    const registry = getDefinitionRegistryCatalog();
    for (const record of registry.definitionRecords()) {
        const kind = record?.relation?.targetKind;
        if (typeof kind === 'string' && kind) kinds.add(kind);
    }
    return [...kinds].sort();
}

function locationKey(location) {
    return [
        normalizeFilePath(location.filePath),
        location.line,
        location.startCharacter,
        location.endCharacter,
        location.role,
    ].join(':');
}

function occurrenceMetadata(referenceIndex, location) {
    return (referenceIndex?.registryReferenceOccurrences || []).find(occurrence =>
        normalizeFilePath(occurrence.filePath) === normalizeFilePath(location.filePath) &&
        occurrence.lineIndex === location.line &&
        occurrence.startCharacter === location.startCharacter &&
        occurrence.endCharacter === location.endCharacter
    ) || null;
}

function definitionMetadata(referenceIndex, location) {
    return (referenceIndex?.allDefinitionOccurrences || []).find(definition =>
        normalizeFilePath(definition.filePath) === normalizeFilePath(location.filePath) &&
        definition.idLine === location.line &&
        definition.idStartChar === location.startCharacter &&
        definition.idEndChar === location.endCharacter
    ) || null;
}

function stableQueryLocations(locations) {
    const seen = new Set();
    const unique = [];
    for (const location of locations) {
        if (!location?.filePath || !Number.isInteger(location.line) ||
            !Number.isInteger(location.startCharacter) || !Number.isInteger(location.endCharacter)) continue;
        const key = locationKey(location);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(location);
    }
    return unique.sort((left, right) =>
        (left.role === right.role ? 0 : left.role === 'definition' ? -1 : 1) ||
        normalizeFilePath(left.filePath).localeCompare(normalizeFilePath(right.filePath)) ||
        left.line - right.line || left.startCharacter - right.startCharacter
    );
}

function compactIndexedEntityReasons(reasons) {
    const counts = new Map();
    for (const reason of reasons || []) {
        const text = String(reason || '').trim();
        if (!text) continue;
        const kind = text.includes(':') ? text.slice(text.lastIndexOf(':') + 1) : text;
        counts.set(kind, (counts.get(kind) || 0) + 1);
    }
    return [...counts.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([reason, count]) => count > 1 ? `${reason} (${count} occurrences)` : reason);
}

async function queryIndexedEntityId({
    snapshot,
    id,
    targetKind,
    cancellationToken = null,
    definitionKeywords = runtimeDefinitionKeywords({ allowCandidate: false }),
    scanDefinitions = scanOnDemandDefinitions,
    scanBlockLines = undefined,
    collectReferences = collectRegistryReferenceMatches,
} = {} as any) {
    const entityId = normalizeIndexedEntityId(id);
    const kind = String(targetKind || '').trim();
    if (!snapshot?.rootFile || !snapshot.fileIndexes || !isEntityIdentity(entityId) || !kind) {
        return { state: 'incomplete', id: entityId, targetKind: kind, locations: [], reasons: ['entity-query-invalid'] };
    }
    if (cancellationToken?.isCancellationRequested) {
        return { state: 'cancelled', id: entityId, targetKind: kind, locations: [], reasons: ['cancelled'] };
    }

    const referenceIndex = buildProjectReferenceIndex(snapshot);
    const query = { id: entityId, targetKinds: [kind], targetDefinitions: [] };
    const references = collectReferences(referenceIndex, query, {
        cancellationToken,
        retainVerifiedMatchesOnIncomplete: true,
    });
    if (references.state === 'cancelled') {
        return {
            state: 'cancelled',
            id: entityId,
            targetKind: kind,
            locations: [],
            reasons: references.reasons || ['cancelled'],
            referenceIndex,
        };
    }

    const indexedDefinitions = definitionLocations(referenceIndex, query);
    const descriptors = selectOnDemandDefinitionDescriptors([kind], [], definitionKeywords);
    let definitionLookup = { state: 'complete', definitions: [], reasons: [] } as any;
    if (descriptors.length > 0) {
        definitionLookup = await scanDefinitions({
            referenceIndex,
            fileIndexes: snapshot.fileIndexes,
            effectiveId: entityId,
            targetKinds: [kind],
            targetDefinitions: [],
            projectScoped: snapshot.scope !== 'single-file',
            cancellationToken,
            definitionKeywords,
            ...(typeof scanBlockLines === 'function' ? { scanBlockLines } : {}),
        });
    }
    if (definitionLookup.state === 'cancelled' || cancellationToken?.isCancellationRequested) {
        return {
            state: 'cancelled',
            id: entityId,
            targetKind: kind,
            locations: [],
            reasons: ['cancelled'],
            referenceIndex,
            definitionLookup,
        };
    }

    const definitionResults = indexedDefinitions.map(location => {
        const metadata = definitionMetadata(referenceIndex, location);
        return {
            ...location,
            role: 'definition',
            keyword: metadata?.keyword || metadata?.targetKeyword || '',
            fieldName: metadata?.fieldName || metadata?.idFieldName || 'ID',
        };
    });
    for (const definition of definitionLookup.definitions || []) {
        definitionResults.push({
            filePath: definition.filePath,
            line: definition.idLine,
            startCharacter: definition.idStartChar,
            endCharacter: definition.idEndChar,
            role: 'definition',
            keyword: definition.keyword || definition.targetKeyword || '',
            fieldName: definition.fieldName || 'ID',
        });
    }
    const referenceResults = references.locations.map(location => {
        const metadata = occurrenceMetadata(referenceIndex, location);
        return {
            ...location,
            role: 'reference',
            keyword: metadata?.keyword || '',
            fieldName: metadata?.fieldName || '',
        };
    });
    const locations = stableQueryLocations([...definitionResults, ...referenceResults]);
    const partial = references.state !== 'complete' || definitionLookup.state !== 'complete';
    return {
        state: partial && locations.length > 0 ? 'partial' : partial ? 'incomplete' : 'complete',
        scope: snapshot.scope === 'single-file' ? 'single-file' : 'project',
        id: entityId,
        targetKind: kind,
        locations: partial && locations.length === 0 ? [] : locations,
        reasons: partial
            ? compactIndexedEntityReasons([
                ...(references.reasons || []),
                ...(definitionLookup.reasons || []),
            ])
            : [],
        referenceIndex,
        definitionLookup,
    };
}

module.exports = {
    indexedEntityKinds,
    compactIndexedEntityReasons,
    normalizeIndexedEntityId,
    queryIndexedEntityId,
    stableQueryLocations,
};

export {};
