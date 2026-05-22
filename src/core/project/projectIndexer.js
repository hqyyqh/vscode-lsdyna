'use strict';

const fs = require('fs');
const path = require('path');

const includeScanner = require('../parser/includeScanner');
const keywordScanner = require('../parser/keywordScanner');

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
    const missingFiles = [];
    const cycles = [];
    const visited = new Set();

    async function visit(filePath, ancestry = []) {
        if (visited.has(filePath)) return;
        visited.add(filePath);
        files.push(filePath);

        const keywords = await keywordScanner.collectKeywordsFromFile(filePath);
        addKeywordUsages(keywordMap, keywords);

        const { includeEntries, searchPaths } = await includeScanner.collectIncludeDirectivesFromFile(filePath);
        for (const { fileName } of includeEntries) {
            const resolvedPath = resolveIncludeFromSearchPaths(fileName, searchPaths);
            if (!resolvedPath) {
                missingFiles.push({
                    fromFile: filePath,
                    fileName,
                });
                continue;
            }

            if (ancestry.includes(resolvedPath) || resolvedPath === filePath) {
                cycles.push({
                    fromFile: filePath,
                    toFile: resolvedPath,
                    path: [...ancestry, filePath, resolvedPath],
                });
                continue;
            }

            await visit(resolvedPath, [...ancestry, filePath]);
        }
    }

    await visit(rootFile);

    return {
        rootFile,
        files,
        keywordMap,
        missingFiles,
        cycles,
    };
}

module.exports = {
    buildProjectIndex,
};
