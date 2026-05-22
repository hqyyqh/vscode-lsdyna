'use strict';

const path = require('path');

function resolveRootFile(rootFile) {
    if (typeof rootFile !== 'string' || rootFile.trim() === '') {
        throw new TypeError('loadProjectSnapshot requires a rootFile path');
    }
    return path.resolve(rootFile);
}

function getRootCacheKey(rootFile) {
    const resolvedRootFile = resolveRootFile(rootFile);
    return process.platform === 'win32'
        ? resolvedRootFile.toLowerCase()
        : resolvedRootFile;
}

function createIndexClient({ buildProjectIndex } = {}) {
    if (typeof buildProjectIndex !== 'function') {
        throw new TypeError('createIndexClient requires a buildProjectIndex function');
    }

    const snapshots = new Map();
    const generations = new Map();

    function getGeneration(rootCacheKey) {
        return generations.get(rootCacheKey) || 0;
    }

    async function loadProjectSnapshot(rootFile) {
        const resolvedRootFile = resolveRootFile(rootFile);
        const rootCacheKey = getRootCacheKey(rootFile);
        const cachedEntry = snapshots.get(rootCacheKey);

        if (cachedEntry) {
            if (cachedEntry.snapshot) return cachedEntry.snapshot;
            if (cachedEntry.promise) return cachedEntry.promise;
        }

        const generation = getGeneration(rootCacheKey);
        const promise = Promise.resolve(buildProjectIndex(resolvedRootFile))
            .then(snapshot => {
                const currentEntry = snapshots.get(rootCacheKey);
                if (getGeneration(rootCacheKey) === generation && currentEntry && currentEntry.promise === promise) {
                    snapshots.set(rootCacheKey, { snapshot });
                }
                return snapshot;
            })
            .catch(error => {
                const currentEntry = snapshots.get(rootCacheKey);
                if (currentEntry && currentEntry.promise === promise) {
                    snapshots.delete(rootCacheKey);
                }
                throw error;
            });

        snapshots.set(rootCacheKey, { promise });
        return promise;
    }

    function invalidate(rootFile) {
        const rootCacheKey = getRootCacheKey(rootFile);
        generations.set(rootCacheKey, getGeneration(rootCacheKey) + 1);
        snapshots.delete(rootCacheKey);
    }

    return {
        invalidate,
        loadProjectSnapshot,
    };
}

module.exports = {
    createIndexClient,
};
