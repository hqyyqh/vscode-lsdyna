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
const { nativeElementBinding } = require("../semantics/catalogNativeFileLayout");
const { queryRegistryReferences } = require('./onDemandReferenceScanner');
const { getReferenceRuleCatalog } = require('./referenceRuleCatalog');
const { relationNamespaces } = require('./registryReferenceScanner');
const {
    collectRegistryReferenceMatches,
    definitionLocations,
} = require('./registryReferenceNetwork');

function normalizeFilePath(value) {
    const resolved = path.resolve(String(value || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeIndexedEntityId(value) {
    if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw) return null;
    if (/^\+?\d+$/.test(raw)) {
        const numeric = Number(raw.replace(/^\+/, ''));
        return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
    }
    return /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(raw) ? raw : null;
}

function indexedEntityKinds({ definitionKeywords = runtimeDefinitionKeywords(),
    referenceKeywords = undefined } = {}) {
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
    const catalog = getReferenceRuleCatalog();
    const storedKinds = referenceKeywords === undefined ? catalog.referenceKinds() : undefined;
    if (storedKinds) for (const kind of storedKinds) kinds.add(kind);
    const records = referenceKeywords === undefined
        ? (storedKinds ? [] : catalog.keywords().flatMap(keyword => catalog.records(keyword) || []))
        : Object.values(referenceKeywords || {}).flat();
    for (const record of records) {
        if ((record as any)?.relation?.kind === 'non-reference') continue;
        for (const kind of relationNamespaces(record, undefined, null).targetKinds) kinds.add(kind);
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

function hasQueryCoordinates(location) {
    return typeof location?.filePath === 'string' && location.filePath.length > 0 &&
        Number.isSafeInteger(location.line) && location.line >= 0 &&
        Number.isSafeInteger(location.startCharacter) && location.startCharacter >= 0 &&
        Number.isSafeInteger(location.endCharacter) && location.endCharacter >= location.startCharacter;
}

function stableQueryLocations(locations) {
    const seen = new Set();
    const unique = [];
    for (const location of locations) {
        if (!hasQueryCoordinates(location)) continue;
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

function indexedEntityDisplay(block, location, entityId, kind, definitionKeywords, definition = null) {
    const keyword = String(block?.keyword || '').replace(/^\*/, '').toUpperCase().replace(/[+%\-]$/, '');
    const descriptor = definitionKeywords.generic?.[keyword] || definitionKeywords.onDemand?.[keyword];
    // A repeated element block's display identity belongs to its first record.
    const repeated = nativeElementBinding(keyword) || ['repeat-all-data-records', 'repeat-data-record-template'].includes(descriptor?.recordMode);
    const display = block && location.line <= block.endLine && !repeated ? block.displayIdentity : null;
    // Display identities describe the owning object, never the referenced ID.
    const ownerId = descriptor && display?.confidence === 'verified' && display.identity?.field === descriptor.fieldName
        ? normalizeIndexedEntityId(display.identity.value) : null;
    return {
        ...(location.role === 'definition' ? { entityId: String(entityId), entityKind: kind }
            : { ...(descriptor?.targetKind ? { entityKind: descriptor.targetKind } : {}),
                ...(ownerId !== null ? { entityId: String(ownerId) } : {}) }),
        ...(display?.confidence === 'verified' && display.title ? { entityName: display.title }
            : definition?.title ? { entityName: definition.title } : {}),
    };
}

async function queryIndexedEntityId({
    snapshot,
    id,
    targetKind,
    targetDefinitions = [],
    cancellationToken = null,
    definitionKeywords = runtimeDefinitionKeywords({ allowCandidate: false }),
    scanDefinitions = scanOnDemandDefinitions,
    scanBlockLines = undefined,
    collectReferences = collectRegistryReferenceMatches,
    queryReferences = queryRegistryReferences,
    onPhase = undefined,
    onLocations = undefined,
    referenceIndex: suppliedReferenceIndex = undefined,
} = {} as any) {
    let phaseStarted = performance.now();
    const phase = (name, details = {}) => {
        const now = performance.now();
        onPhase?.({ phase: name, durationMs: now - phaseStarted, ...details });
        phaseStarted = now;
    };
    const entityId = normalizeIndexedEntityId(id);
    const kind = String(targetKind || '').trim();
    if (!snapshot?.rootFile || !snapshot.fileIndexes || !isEntityIdentity(entityId) || !kind) {
        return { state: 'incomplete', id: entityId, targetKind: kind, locations: [], reasons: ['entity-query-invalid'] };
    }
    if (cancellationToken?.isCancellationRequested) {
        return { state: 'cancelled', id: entityId, targetKind: kind, locations: [], reasons: ['cancelled'] };
    }

    let referenceIndex = suppliedReferenceIndex || buildProjectReferenceIndex(snapshot);
    phase('reference-index');
    const query = { id: entityId, targetKinds: [kind], targetDefinitions };
    const indexedDefinitions = definitionLocations(referenceIndex, query);
    const lookupKinds = new Set([kind]);
    for (const occurrence of referenceIndex.registryReferenceOccurrences || []) {
        const search = occurrence.referenceValue?.targetSearch || occurrence.referenceValue?.semanticRelation?.targetSearch;
        if (search?.some(target => target.targetKinds.includes(kind))) {
            for (const target of search) for (const candidate of target.targetKinds) lookupKinds.add(candidate);
        }
    }
    const descriptors = selectOnDemandDefinitionDescriptors([...lookupKinds], targetDefinitions, definitionKeywords);
    const publishDefinitions = onLocations && (async definitions => {
        const locations = definitions.filter(definition => !definition.targetKind || definition.targetKind === kind)
            .map(definition => ({ filePath: definition.filePath, line: definition.idLine,
                startCharacter: definition.idStartChar, endCharacter: definition.idEndChar,
                role: 'definition', keyword: definition.keyword || definition.targetKeyword || '',
                fieldName: definition.fieldName || 'ID', entityId: String(entityId), entityKind: kind,
                ...(definition.title ? { entityName: definition.title } : {}) }));
        for (let offset = 0; offset < locations.length; offset += 200) await onLocations(locations.slice(offset, offset + 200));
    });
    let definitionLookup = { state: 'complete', definitions: [], reasons: [] } as any;
    if (descriptors.length > 0) {
        definitionLookup = await scanDefinitions({
            referenceIndex,
            fileIndexes: snapshot.fileIndexes,
            effectiveId: entityId,
            targetKinds: [...lookupKinds],
            targetDefinitions,
            projectScoped: snapshot.scope !== 'single-file',
            cancellationToken,
            definitionKeywords,
            ...(publishDefinitions ? { onDefinitions: publishDefinitions } : {}),
            ...(typeof scanBlockLines === 'function' ? { scanBlockLines } : {}),
        });
    } else if (!referenceIndex.indexedTargetKinds?.has(kind)) {
        definitionLookup = { state: 'incomplete', definitions: [], reasons: ['target-kind-unindexed'] };
    }
    phase('definitions', { scannedBlocks: definitionLookup.scannedBlockCount || 0,
        scannedLines: definitionLookup.scannedLineCount || 0 });
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
    referenceIndex = { ...referenceIndex, queryDefinitionLookup: { ...definitionLookup, id: entityId,
        targetKinds: descriptors.map(descriptor => descriptor.targetKind).filter(Boolean),
        targetDefinitions: descriptors.map(descriptor => descriptor.keyword) } };
    if (onLocations) {
        const definitions = indexedDefinitions.map(location => ({ ...location, role: 'definition', entityId: String(entityId), entityKind: kind }));
        for (let offset = 0; offset < definitions.length; offset += 200) await onLocations(definitions.slice(offset, offset + 200));
        if (!definitionLookup.definitionsStreamed) await publishDefinitions(definitionLookup.definitions || []);
    }
    const references = await queryReferences({ referenceIndex,
        fileIndexes: snapshot.fileIndexes, query, cancellationToken, collectReferences,
        ...(onLocations ? { onLocations } : {}),
        retainVerifiedMatchesOnIncomplete: true,
        ...(typeof scanBlockLines === 'function' ? { scanBlockLines } : {}) });
    referenceIndex = references.referenceIndex;
    const referenceLookup = references.referenceLookup;
    phase('references', { scannedBlocks: referenceLookup?.scannedBlocks || 0,
        scannedLines: referenceLookup?.scannedLines || 0 });
    if (references.state === 'cancelled') return { state: 'cancelled', id: entityId, targetKind: kind,
        locations: [], reasons: references.reasons || ['cancelled'], referenceIndex, definitionLookup };
    if (onLocations) {
        // Bounded fallback readers may return retained matches; persistent readers deliver them while reading pages.
        for (let offset = 0; offset < references.locations.length; offset += 200)
            await onLocations(references.locations.slice(offset, offset + 200).map(location => ({ ...location, role: 'reference' })));
        const complete = references.state === 'complete' && definitionLookup.state === 'complete';
        return { state: complete ? 'complete' : 'incomplete', locations: [],
            reasons: complete ? [] : compactIndexedEntityReasons([...(references.reasons || []), ...(definitionLookup.reasons || [])]) };
    }

    const fileBlocks = new Map((snapshot.fileIndexes instanceof Map
        ? [...snapshot.fileIndexes] : Object.entries(snapshot.fileIndexes))
        .map(([file, index]: [string, any]) => [normalizeFilePath(file), index.keywordBlocks || []]));
    const displayEntity = (location, definition = null) => {
        const blocks: any[] = fileBlocks.get(normalizeFilePath(location.filePath)) || [];
        let low = 0, high = blocks.length - 1;
        while (low <= high) {
            const middle = (low + high) >>> 1;
            if (blocks[middle].startLine <= location.line) low = middle + 1;
            else high = middle - 1;
        }
        const block = blocks[high];
        return indexedEntityDisplay(block, location, entityId, kind, definitionKeywords, definition);
    };
    const normalizedFiles = new Map();
    const metadataKey = (file, line, start, end) => {
        if (!normalizedFiles.has(file)) normalizedFiles.set(file, normalizeFilePath(file));
        return JSON.stringify([normalizedFiles.get(file), line, start, end]);
    };
    const metadataMap = (values, definition, locations) => {
        const map = new Map<string, any[]>();
        const wanted = new Set(locations.map(location => metadataKey(location.filePath, location.line,
            location.startCharacter, location.endCharacter)));
        if (!wanted.size) return map;
        for (const item of values || []) {
            const key = definition ? metadataKey(item.filePath, item.idLine, item.idStartChar, item.idEndChar)
                : metadataKey(item.filePath, item.lineIndex, item.startCharacter, item.endCharacter);
            if (!wanted.has(key)) continue;
            const entries = map.get(key) || []; entries.push(item); map.set(key, entries);
        }
        return map;
    };
    const definitionsByPosition = metadataMap(referenceIndex.allDefinitionOccurrences, true, indexedDefinitions);
    const referencesByPosition = metadataMap(references.metadataOccurrences || referenceIndex.registryReferenceOccurrences,
        false, references.locations);
    const metadataAt = (map, location) => map.get(metadataKey(location.filePath, location.line,
        location.startCharacter, location.endCharacter))?.[0];
    const definitionResults = indexedDefinitions.map(location => {
        const metadata = metadataAt(definitionsByPosition, location);
        return {
            ...location,
            role: 'definition',
            keyword: metadata?.keyword || metadata?.targetKeyword || '',
            fieldName: metadata?.fieldName || metadata?.idFieldName || 'ID',
            ...displayEntity({ ...location, role: 'definition' }, metadata),
        };
    });
    for (const definition of definitionLookup.definitions || []) {
        if (definition.targetKind && definition.targetKind !== kind) continue;
        definitionResults.push({
            filePath: definition.filePath,
            line: definition.idLine,
            startCharacter: definition.idStartChar,
            endCharacter: definition.idEndChar,
            role: 'definition',
            keyword: definition.keyword || definition.targetKeyword || '',
            fieldName: definition.fieldName || 'ID',
            ...displayEntity({ ...definition, line: definition.idLine, role: 'definition' }, definition),
        });
    }
    const referenceResults = references.locations.map(location => {
        const metadata = metadataAt(referencesByPosition, location);
        return {
            ...location,
            role: 'reference',
            keyword: metadata?.keyword || '',
            fieldName: metadata?.fieldName || '',
            ...displayEntity({ ...location, role: 'reference' }),
        };
    });
    const candidates = [...definitionResults, ...referenceResults];
    const locations = stableQueryLocations(candidates);
    const unavailableLocation = candidates.some(location => !hasQueryCoordinates(location));
    const partial = references.state !== 'complete' || definitionLookup.state !== 'complete' || unavailableLocation;
    phase('presentation', { locations: locations.length });
    return {
        state: partial && locations.length > 0 ? 'partial' : partial ? 'incomplete' : 'complete',
        scope: snapshot.scope === 'single-file' ? 'single-file' : 'project',
        id: entityId,
        targetKind: kind,
        locations,
        reasons: partial
            ? compactIndexedEntityReasons([
                ...(references.reasons || []),
                ...(definitionLookup.reasons || []),
                ...(unavailableLocation ? ['entity-query-location-unavailable'] : []),
            ])
            : [],
        referenceIndex,
        definitionLookup,
        referenceLookup,
    };
}

module.exports = {
    indexedEntityDisplay,
    indexedEntityKinds,
    compactIndexedEntityReasons,
    normalizeIndexedEntityId,
    queryIndexedEntityId,
    stableQueryLocations,
};

export {};
