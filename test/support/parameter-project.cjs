'use strict';
const { buildProjectReferenceIndex } = require('../../out/core/references/projectReferenceIndex');
const { scanParameterEventsFromFileIndex } = require('../../out/core/references/parameterDefinitionScanner');
exports.parameterProject = async (root, sources, edges = []) => {
    const fileIndexes = new Map();
    for (const [file, text] of sources) {
        const lines = text.split('\n'), blocks = [];
        for (let line = 0; line < lines.length; line++) if (lines[line].startsWith('*')) {
            if (blocks.length) blocks.at(-1).endLine = line - 1;
            blocks.push({ keyword: lines[line].split(/\s/)[0], rawKeyword: lines[line], startLine: line, endLine: lines.length - 1 });
        }
        const fileIndex = { keywordBlocks: blocks };
        fileIndex.parameterEvents = await scanParameterEventsFromFileIndex(fileIndex,
            block => lines.slice(block.startLine, block.endLine + 1).join('\n'));
        fileIndexes.set(file, fileIndex);
    }
    const index = buildProjectReferenceIndex({ rootFile: root, files: [...sources.keys()], fileIndexes,
        graph: { includeOccurrences: edges, includeOccurrencesComplete: true } });
    const scanBlockLines = async (block, visit, token) => {
        const lines = sources.get(block.filePath).split('\n');
        for (let line = block.startLine + 1; line <= block.endLine; line++) {
            if (token?.isCancellationRequested) throw new Error('Cancelled');
            await visit(lines[line], line);
        }
        return { complete: true };
    };
    return { index, fileIndexes, scanBlockLines };
};

exports.parameterDocumentQueryClient = document => ({ sourceAnalysis: async (request, token) => {
    const data = await exports.parameterProject(document.uri.fsPath, new Map([[document.uri.fsPath, document.getText()]]));
    const result = request.mode === 'parameter-completion'
        ? await require('../../out/core/references/visibleParameters').parameterCompletionPage(
            data.index, request.filePath, request.line, request.character, request.prefix, token)
        : await require('../../out/core/references/parameterNavigation').parameterNavigation(
            data.index, data.fileIndexes, request, token, data.scanBlockLines);
    return { status: 'ready', ...result };
} });
