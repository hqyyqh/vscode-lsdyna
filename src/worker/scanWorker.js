'use strict';

const { parentPort } = require('worker_threads');

const { serializeProjectSnapshot } = require('../core/cache/snapshotSerializer');
const { buildProjectIndex } = require('../core/project/projectIndexer');

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
