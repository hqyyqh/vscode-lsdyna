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
    return {
        ...snapshot,
        graph: snapshot.graph.toJSON(),
        keywordMap: [...(snapshot.keywordMap || new Map()).entries()],
        missingFiles: [...(snapshot.missingFiles || [])],
        cycles: [...(snapshot.cycles || [])],
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
    return {
        ...snapshot,
        graph,
        keywordMap: new Map(snapshot.keywordMap || []),
        missingFiles: graph.missingFiles,
        cycles: graph.cycles,
    };
}

module.exports = {
    hydrateProjectSnapshot,
    serializeProjectSnapshot,
};
