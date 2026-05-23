'use strict';

const path = require('path');
const { createWorkerPool } = require('./workerPool');

function createProjectIndexLoader({
    createPool = createWorkerPool,
    workerPath = path.join(__dirname, 'scanWorker.js'),
} = {}) {
    let workerPool = null;

    function isPoolDisposed(pool) {
        return !pool || (typeof pool.isDisposed === 'function' && pool.isDisposed());
    }

    function getWorkerPool() {
        if (isPoolDisposed(workerPool)) {
            workerPool = null;
        }
        if (!workerPool) {
            workerPool = createPool({ workerPath });
        }
        return workerPool;
    }

    return {
        async buildProjectIndex(rootFile) {
            const pool = getWorkerPool();
            try {
                return await pool.buildProjectIndex(rootFile);
            } catch (error) {
                if (workerPool === pool && isPoolDisposed(pool)) {
                    workerPool = null;
                }
                throw error;
            }
        },
        async dispose() {
            if (!workerPool) return;
            await workerPool.dispose();
            workerPool = null;
        },
    };
}

module.exports = {
    createProjectIndexLoader,
};
