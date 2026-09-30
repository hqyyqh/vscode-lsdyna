'use strict';

/**
 * @fileoverview Serialization and hydration helper for project snapshots.
 * @module core/cache/snapshotSerializer
 * 
 * This file transforms complex project snapshot objects (which contain instances of Map and ProjectGraph)
 * into JSON-friendly plain objects for disk storage, and restores them back into their active class structures.
 * 
 * Role in System: Decouples the persistent cache layer from the runtime object structures.
 */

const { ProjectGraph } = require('../project/projectGraph');
const { throwIfCancellationRequested } = require('../scanner/scannerContracts');

// Transport-only projection. Disk caches retain the complete snapshot contract.
// Each reference batch is parsed independently by the host's IPC reader.
async function serializeProjectSnapshotForClient(snapshot, sendChunk = null, cancellationToken = null) {
    const serialized = serializeProjectSnapshot(snapshot);
    const referenceChunks = [];
    serialized.fileIndexes = serialized.fileIndexes.map(([filePath, original]) => {
        const index = { ...original };
        if (sendChunk && index.keywordBlocks?.length > 512) {
            referenceChunks.push({ filePath, field: 'keywordBlocks', length: index.keywordBlocks.length, records: index.keywordBlocks });
            index.keywordBlocks = [];
        }
        if (!index.registryReferences) return [filePath, index];
        const registryReferences = { ...index.registryReferences };
        for (const field of ['referenceOccurrences', 'valueDomainOccurrences']) {
            const records = registryReferences[field];
            if (!Array.isArray(records) || records.length <= 512) continue;
            registryReferences[field] = [];
            referenceChunks.push({ filePath, field, length: records.length, records });
        }
        return [filePath, { ...index, registryReferences }];
    });
    for (const { filePath, field, records } of referenceChunks) {
        if (!sendChunk) {
            const index = serialized.fileIndexes.find(([file]) => file === filePath)[1];
            index.registryReferences.complete = false;
            index.registryReferences.reasons = [...new Set([
                ...(index.registryReferences.reasons || []), 'scan-progress-references-deferred',
            ])];
            continue;
        }
        for (let offset = 0; offset < records.length; offset += 512) {
            throwIfCancellationRequested(cancellationToken);
            const items = records.slice(offset, offset + 512);
            await sendChunk({ filePath, field, offset, ...encodeReferenceBatch(items, field) });
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    if (sendChunk) serialized.referenceChunks = referenceChunks.map(({ records, ...descriptor }) => descriptor);
    return serialized;
}

function receiveSnapshotChunk(chunks, chunk) {
    if (!['referenceOccurrences', 'valueDomainOccurrences', 'keywordBlocks'].includes(chunk.field) ||
        typeof chunk.filePath !== 'string' || !Array.isArray(chunk.items) || chunk.items.length > 512) {
        throw new Error('Invalid project reference batch');
    }
    const key = JSON.stringify([chunk.filePath, chunk.field]);
    const records = chunks.get(key) || [];
    if (chunk.offset !== records.length) throw new Error('Out-of-order project reference batch');
    records.push(...decodeReferenceBatch(chunk.items, chunk.templates));
    chunks.set(key, records);
}
function restoreSnapshotChunks(serialized, chunks) {
    const indexes = new Map(serialized.fileIndexes || []);
    for (const { filePath, field, length } of serialized.referenceChunks || []) {
        const key = JSON.stringify([filePath, field]);
        const records = chunks.get(key), index: any = indexes.get(filePath);
        if (!records || records.length !== length || !index ||
            !['referenceOccurrences', 'valueDomainOccurrences', 'keywordBlocks'].includes(field) ||
            (field !== 'keywordBlocks' && !index.registryReferences)) throw new Error('Incomplete project reference transfer');
        if (field === 'keywordBlocks') index.keywordBlocks = records;
        else index.registryReferences[field] = records;
        chunks.delete(key);
    }
    if (chunks.size) throw new Error('Unexpected project reference transfer');
    delete serialized.referenceChunks;
    return serialized;
}

// Repeated field metadata is a batch-local template; locations and values remain per row.
const templateFields = ['filePath', 'keyword', 'cardIndex', 'fieldName', 'fieldType',
    'position', 'width', 'authoringRelationId', 'coordinateId', 'sourceRuleId',
    'decisionId', 'operationalProjection', 'targetKinds', 'targetDefinitions'];
function encodeReferenceBatch(items, field) {
    if (field === 'keywordBlocks' || !items.some(item => item.operationalProjection)) return { items };
    const templates = [];
    const ids = new Map();
    const rows = items.map(item => {
        const template = {};
        const row: any = {};
        for (const key of Object.keys(item)) {
            if (templateFields.includes(key)) template[key] = item[key];
            else row[key] = item[key];
        }
        const key = JSON.stringify(template);
        if (!ids.has(key)) { ids.set(key, templates.length); templates.push(template); }
        row.__referenceTemplate = ids.get(key);
        return row;
    });
    return { items: rows, templates };
}
function decodeReferenceBatch(items, templates) {
    if (templates === undefined) return items;
    if (!Array.isArray(templates) || templates.length > 512) throw new Error('Invalid reference templates');
    return items.map(item => {
        const id = item.__referenceTemplate;
        if (!Number.isInteger(id) || id < 0 || id >= templates.length || !templates[id] ||
            typeof templates[id] !== 'object' || Array.isArray(templates[id]) ||
            Object.keys(templates[id]).some(key => !templateFields.includes(key))) {
            throw new Error('Invalid reference template id');
        }
        delete item.__referenceTemplate;
        // Decode into the freshly parsed row instead of allocating two extra objects.
        for (const key of Object.keys(templates[id])) {
            if (!Object.prototype.hasOwnProperty.call(item, key)) item[key] = templates[id][key];
        }
        return item;
    });
}

/**
 * @typedef {Object} SerializedProjectSnapshot
 * @property {string} rootFile - The root file path of the project.
 * @property {Object} graph - JSON representation of the ProjectGraph.
 * @property {Array<[string, Array<{keyword: string, filePath: string, lineIndex: number}>]>} keywordMap - Serialized Map entries associating files with keywords.
 * @property {string[]} missingFiles - List of missing include files.
 * @property {Array<string[]>} cycles - Detected circular include loops.
 */

/**
 * Serializes a runtime ProjectSnapshot object into a JSON-compatible format.
 * 
 * @param {Object} snapshot - The active runtime project snapshot.
 * @returns {SerializedProjectSnapshot} Plain JSON-serializable object.
 */
function serializeProjectSnapshot(snapshot) {
    const effective = snapshot.effectiveSearchPathsByFile;
    return {
        ...snapshot,
        graph: snapshot.graph.toJSON(),
        fileIndexes: [...(snapshot.fileIndexes || new Map()).entries()],
        keywordMap: [...(snapshot.keywordMap || new Map()).entries()],
        missingFiles: [...(snapshot.missingFiles || [])],
        cycles: [...(snapshot.cycles || [])],
        effectiveSearchPathsByFile: effective instanceof Map
            ? [...effective.entries()]
            : (effective || []),
    };
}

/**
 * Re-hydrates a serialized JSON snapshot back into a runtime ProjectSnapshot with active ProjectGraph instances.
 * 
 * @param {SerializedProjectSnapshot} snapshot - The plain JSON snapshot loaded from disk.
 * @returns {Object} Active runtime project snapshot with helper methods and class instances.
 */
function hydrateProjectSnapshot(snapshot) {
    const graph = ProjectGraph.fromJSON(snapshot.graph);
    const effectiveRaw = snapshot.effectiveSearchPathsByFile;
    const effectiveSearchPathsByFile = effectiveRaw instanceof Map
        ? effectiveRaw
        : new Map(Array.isArray(effectiveRaw) ? effectiveRaw : []);
    return {
        ...snapshot,
        graph,
        fileIndexes: new Map(snapshot.fileIndexes || []),
        keywordMap: new Map(snapshot.keywordMap || []),
        missingFiles: graph.missingFiles,
        cycles: graph.cycles,
        effectiveSearchPathsByFile,
    };
}

module.exports = {
    hydrateProjectSnapshot,
    encodeReferenceBatch,
    receiveSnapshotChunk,
    restoreSnapshotChunks,
    decodeReferenceBatch,
    serializeProjectSnapshot,
    serializeProjectSnapshotForClient,
};

export {};
