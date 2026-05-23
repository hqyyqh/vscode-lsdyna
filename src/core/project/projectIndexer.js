'use strict';

const fs = require('fs');
const path = require('path');

const includeScanner = require('../parser/includeScanner');
const keywordScanner = require('../parser/keywordScanner');
const { ProjectGraph } = require('./projectGraph');

function resolveProjectFile(filePath) {
    return path.resolve(filePath);
}

function getProjectFileCacheKey(filePath) {
    const resolvedFilePath = resolveProjectFile(filePath);
    return process.platform === 'win32'
        ? resolvedFilePath.toLowerCase()
        : resolvedFilePath;
}

function areFileSignaturesEqual(left, right) {
    return left
        && right
        && left.mtimeMs === right.mtimeMs
        && left.size === right.size;
}

async function readFileSignature(filePath) {
    const stat = await fs.promises.stat(filePath);
    return {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
    };
}

function resolveIncludeFromSearchPaths(fileName, searchPaths) {
    for (const searchPath of searchPaths) {
        const fullPath = path.resolve(searchPath, fileName);
        if (fs.existsSync(fullPath)) return fullPath;
    }
    return null;
}

function addKeywordUsages(keywordMap, keywords) {
    for (const keywordEntry of keywords) {
        if (!keywordMap.has(keywordEntry.keyword)) keywordMap.set(keywordEntry.keyword, []);
        keywordMap.get(keywordEntry.keyword).push(keywordEntry);
    }
}

function createProjectIndexer({
    collectIncludeDirectivesFromFile = includeScanner.collectIncludeDirectivesFromFile,
    collectKeywordsFromFile = keywordScanner.collectKeywordsFromFile,
    getFileSignature = readFileSignature,
} = {}) {
    if (typeof collectIncludeDirectivesFromFile !== 'function') {
        throw new TypeError('createProjectIndexer requires collectIncludeDirectivesFromFile to be a function');
    }
    if (typeof collectKeywordsFromFile !== 'function') {
        throw new TypeError('createProjectIndexer requires collectKeywordsFromFile to be a function');
    }
    if (typeof getFileSignature !== 'function') {
        throw new TypeError('createProjectIndexer requires getFileSignature to be a function');
    }

    const fileScanCache = new Map();

    async function loadFileScan(filePath, stats) {
        const resolvedFilePath = resolveProjectFile(filePath);
        const fileCacheKey = getProjectFileCacheKey(resolvedFilePath);
        const signature = await getFileSignature(resolvedFilePath);
        const cachedEntry = fileScanCache.get(fileCacheKey);

        if (cachedEntry && areFileSignaturesEqual(cachedEntry.signature, signature)) {
            stats.reusedFileCount += 1;
            return cachedEntry.scanResult;
        }

        const keywords = await collectKeywordsFromFile(resolvedFilePath);
        const { includeEntries, searchPaths } = await collectIncludeDirectivesFromFile(resolvedFilePath);
        const scanResult = {
            filePath: resolvedFilePath,
            keywords,
            includeEntries,
            searchPaths,
        };

        fileScanCache.set(fileCacheKey, {
            signature,
            scanResult,
        });
        stats.scannedFileCount += 1;
        return scanResult;
    }

    async function buildProjectIndex(rootFile) {
        const resolvedRootFile = resolveProjectFile(rootFile);
        const files = [];
        const keywordMap = new Map();
        const graph = new ProjectGraph();
        const visited = new Set();
        const stats = {
            scannedFileCount: 0,
            reusedFileCount: 0,
        };

        async function visit(filePath, ancestry = []) {
            const resolvedFilePath = resolveProjectFile(filePath);
            if (visited.has(resolvedFilePath)) return;
            visited.add(resolvedFilePath);
            files.push(resolvedFilePath);
            graph.addFile(resolvedFilePath);

            const scanResult = await loadFileScan(resolvedFilePath, stats);
            addKeywordUsages(keywordMap, scanResult.keywords);

            for (const { fileName } of scanResult.includeEntries) {
                const resolvedPath = resolveIncludeFromSearchPaths(fileName, scanResult.searchPaths);
                if (!resolvedPath) {
                    graph.addMissingFile({
                        fromFile: resolvedFilePath,
                        fileName,
                        filePath: path.resolve(scanResult.searchPaths[0] || path.dirname(resolvedFilePath), fileName),
                    });
                    continue;
                }

                if (ancestry.includes(resolvedPath) || resolvedPath === resolvedFilePath) {
                    graph.addCycle({
                        fromFile: resolvedFilePath,
                        toFile: resolvedPath,
                        path: [...ancestry, resolvedFilePath, resolvedPath],
                    });
                    continue;
                }

                graph.addIncludeEdge(resolvedFilePath, resolvedPath);
                await visit(resolvedPath, [...ancestry, resolvedFilePath]);
            }
        }

        await visit(resolvedRootFile);

        return {
            rootFile: resolvedRootFile,
            files,
            graph,
            keywordMap,
            missingFiles: graph.missingFiles,
            cycles: graph.cycles,
            stats,
        };
    }

    return {
        buildProjectIndex,
    };
}

const defaultProjectIndexer = createProjectIndexer();

module.exports = {
    buildProjectIndex: defaultProjectIndexer.buildProjectIndex,
    createProjectIndexer,
};
