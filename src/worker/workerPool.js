'use strict';

const { Worker } = require('worker_threads');

const { hydrateProjectSnapshot } = require('../core/cache/snapshotSerializer');

function createWorkerPool({
    workerPath,
    workerFactory = (nextWorkerPath) => new Worker(nextWorkerPath),
} = {}) {
    if (typeof workerPath !== 'string' || workerPath.trim() === '') {
        throw new TypeError('createWorkerPool requires a workerPath');
    }
    if (typeof workerFactory !== 'function') {
        throw new TypeError('createWorkerPool requires a workerFactory function');
    }

    const worker = workerFactory(workerPath);
    const pendingRequests = new Map();
    let nextRequestId = 1;
    let disposed = false;

    function rejectPendingRequests(error) {
        for (const pendingRequest of pendingRequests.values()) {
            pendingRequest.reject(error);
        }
        pendingRequests.clear();
    }

    worker.on('message', (message) => {
        const pendingRequest = pendingRequests.get(message.requestId);
        if (!pendingRequest) return;
        pendingRequests.delete(message.requestId);

        if (message.type === 'error') {
            const error = new Error(message.error.message);
            error.name = message.error.name;
            error.stack = message.error.stack;
            pendingRequest.reject(error);
            return;
        }

        pendingRequest.resolve(hydrateProjectSnapshot(message.snapshot));
    });
    worker.on('error', (error) => {
        disposed = true;
        rejectPendingRequests(error);
    });
    worker.on('exit', (code) => {
        if (disposed && pendingRequests.size === 0) return;

        disposed = true;
        rejectPendingRequests(new Error(`scan worker exited with code ${code}`));
    });

    return {
        buildProjectIndex(rootFile) {
            if (disposed) {
                return Promise.reject(new Error('scan worker pool has been disposed'));
            }

            const requestId = nextRequestId++;
            return new Promise((resolve, reject) => {
                pendingRequests.set(requestId, { reject, resolve });
                worker.postMessage({
                    requestId,
                    rootFile,
                    type: 'buildProjectIndex',
                });
            });
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            rejectPendingRequests(new Error('scan worker pool has been disposed'));
            await worker.terminate();
        },
        isDisposed() {
            return disposed;
        },
    };
}

module.exports = {
    createWorkerPool,
};
