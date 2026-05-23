'use strict';

const path = require('path');

function resolveTrackedFile(filePath) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
        throw new TypeError('file invalidation requires a file path');
    }
    return path.resolve(filePath);
}

function getTrackedFileKey(filePath) {
    const resolvedFilePath = resolveTrackedFile(filePath);
    return process.platform === 'win32'
        ? resolvedFilePath.toLowerCase()
        : resolvedFilePath;
}

function findAffectedProjectRoots(changedFilePath, manifestEntries = []) {
    const changedFileKey = getTrackedFileKey(changedFilePath);
    const affectedRoots = [];
    const seenRoots = new Set();

    for (const entry of manifestEntries) {
        if (!entry || typeof entry.rootFile !== 'string' || !Array.isArray(entry.trackedFiles)) continue;
        const rootFile = path.resolve(entry.rootFile);
        const rootFileKey = getTrackedFileKey(rootFile);
        if (seenRoots.has(rootFileKey)) continue;

        const matchesChangedFile = entry.trackedFiles.some(trackedFile => getTrackedFileKey(trackedFile) === changedFileKey);
        if (!matchesChangedFile) continue;

        seenRoots.add(rootFileKey);
        affectedRoots.push(rootFile);
    }

    return affectedRoots;
}

module.exports = {
    findAffectedProjectRoots,
};
