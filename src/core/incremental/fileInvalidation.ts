'use strict';

/**
 * @fileoverview Utility to map workspace file changes to affected project root folders/files.
 * @module core/incremental/fileInvalidation
 * 
 * When a file in the workspace changes, this module queries the active cache manifest entries 
 * to find all project roots whose include trees contain the modified file, indicating those 
 * projects require cache invalidation.
 * 
 * Role in System: Handles workspace file watcher events, filtering and mapping them back to 
 * the project snapshot loader for targeted incremental index refreshes.
 */

const path = require('path');

/**
 * Resolves a tracked file path to an absolute path, validation checks included.
 * 
 * @param {string} filePath - Path to resolve.
 * @returns {string} Absolute path.
 * @throws {TypeError} If the path is not a valid string.
 */
function resolveTrackedFile(filePath) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
        throw new TypeError('file invalidation requires a file path');
    }
    return path.resolve(filePath);
}

/**
 * Generates a normalized map key for a tracked file. Handles Windows casing.
 * 
 * @param {string} filePath - File path to key.
 * @returns {string} The normalized lookup key.
 */
function getTrackedFileKey(filePath) {
    const resolvedFilePath = resolveTrackedFile(filePath);
    return process.platform === 'win32'
        ? resolvedFilePath.toLowerCase()
        : resolvedFilePath;
}

/**
 * Traverses manifest catalogs to find all project root files that include the changed file.
 * 
 * @param {string} changedFilePath - Path to the file that was modified.
 * @param {import('../cache/cacheManifestStore').ManifestEntry[]} [manifestEntries=[]] - All active manifest entries.
 * @returns {string[]} Absolute paths of all project root files affected by the change.
 */
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

export {};
