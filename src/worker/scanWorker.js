'use strict';

const { parentPort } = require('worker_threads');

const { buildProjectIndex } = require('../core/project/projectIndexer');

function serializeProjectSnapshot(snapshot) {
    return {
        ...snapshot,
        graph: snapshot.graph.toJSON(),
        keywordMap: [...snapshot.keywordMap.entries()],
        missingFiles: [...snapshot.missingFiles],
        cycles: [...snapshot.cycles],
    };
}

function serializeError(error) {
    return {
        message: error.message,
        stack: error.stack,
        name: error.name,
    };
}

parentPort.on('message', async (message) => {
    if (!message || message.type !== 'buildProjectIndex') return;

    try {
        const snapshot = await buildProjectIndex(message.rootFile);
        parentPort.postMessage({
            requestId: message.requestId,
            snapshot: serializeProjectSnapshot(snapshot),
            type: 'result',
        });
    } catch (error) {
        parentPort.postMessage({
            error: serializeError(error),
            requestId: message.requestId,
            type: 'error',
        });
    }
});
