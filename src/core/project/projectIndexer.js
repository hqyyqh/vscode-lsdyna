'use strict';

const fs = require('fs');
const path = require('path');

const includeScanner = require('../parser/includeScanner');
const keywordScanner = require('../parser/keywordScanner');
const { ProjectGraph } = require('./projectGraph');

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

async function buildProjectIndex(rootFile) {
    const files = [];
    const keywordMap = new Map();
    const graph = new ProjectGraph();
    const visited = new Set();

    async function visit(filePath, ancestry = []) {
        if (visited.has(filePath)) return;
        visited.add(filePath);
        files.push(filePath);
        graph.addFile(filePath);

        const keywords = await keywordScanner.collectKeywordsFromFile(filePath);
        addKeywordUsages(keywordMap, keywords);

        const { includeEntries, searchPaths } = await includeScanner.collectIncludeDirectivesFromFile(filePath);
        for (const { fileName } of includeEntries) {
            const resolvedPath = resolveIncludeFromSearchPaths(fileName, searchPaths);
            if (!resolvedPath) {
                graph.addMissingFile({
                    fromFile: filePath,
                    fileName,
                });
                continue;
            }

            if (ancestry.includes(resolvedPath) || resolvedPath === filePath) {
                graph.addCycle({
                    fromFile: filePath,
                    toFile: resolvedPath,
                    path: [...ancestry, filePath, resolvedPath],
                });
                continue;
            }

            graph.addIncludeEdge(filePath, resolvedPath);
            await visit(resolvedPath, [...ancestry, filePath]);
        }
    }

    await visit(rootFile);

    return {
        rootFile,
        files,
        graph,
        keywordMap,
        missingFiles: graph.missingFiles,
        cycles: graph.cycles,
    };
}

module.exports = {
    buildProjectIndex,
};
