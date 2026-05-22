'use strict';

function createIndexClient({ buildProjectIndex } = {}) {
    if (typeof buildProjectIndex !== 'function') {
        throw new TypeError('createIndexClient requires a buildProjectIndex function');
    }

    async function loadProjectSnapshot(rootFile) {
        return buildProjectIndex(rootFile);
    }

    return {
        loadProjectSnapshot,
    };
}

module.exports = {
    createIndexClient,
};
