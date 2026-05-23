'use strict';

const { ProjectGraph } = require('../project/projectGraph');

function serializeProjectSnapshot(snapshot) {
    return {
        ...snapshot,
        graph: snapshot.graph.toJSON(),
        keywordMap: [...(snapshot.keywordMap || new Map()).entries()],
        missingFiles: [...(snapshot.missingFiles || [])],
        cycles: [...(snapshot.cycles || [])],
    };
}

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
