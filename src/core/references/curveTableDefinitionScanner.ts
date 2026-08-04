'use strict';

const { parseNumericInput, numericInputValue } = require('./referenceInputValue');
const loadedReferenceIndex = require('../../../keywords/field_reference_index.json');

function normalizeKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function withStar(keyword) {
    const normalized = normalizeKeyword(keyword);
    return normalized ? `*${normalized}` : '';
}

function isCurveKeyword(keyword) {
    return normalizeKeyword(keyword).startsWith('DEFINE_CURVE');
}

function isTableKeyword(keyword) {
    return normalizeKeyword(keyword).startsWith('DEFINE_TABLE');
}

function genericDefinitionDescriptor(keyword, definitionKeywords = loadedReferenceIndex.definitionKeywords) {
    const normalized = normalizeKeyword(keyword).replace(/\+$/, '');
    return definitionKeywords && definitionKeywords.generic
        ? definitionKeywords.generic[normalized] || null
        : null;
}

function splitLines(text) {
    return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function isCommentOrBlank(line) {
    const trimmed = String(line || '').trim();
    return trimmed === '' || trimmed.startsWith('$');
}

function isKeywordLine(line) {
    return String(line || '').trimStart().startsWith('*');
}

function tokenize(line) {
    return String(line || '')
        .split(/[,\s]+/)
        .map(token => token.trim())
        .filter(Boolean);
}

function parseNumberToken(token) {
    return numericInputValue(parseNumericInput(token, { integerOnly: false }));
}

function parseDefinitionIdInput(token) {
    return parseNumericInput(token, {
        integerOnly: true,
        nonZero: true,
        absoluteNumeric: true,
    });
}

function completenessFromInputs(inputs) {
    const unresolved = (inputs || []).filter(input => input && input.kind !== 'numeric');
    return unresolved.length === 0
        ? { state: 'complete', reasons: [] }
        : {
            state: 'incomplete',
            reasons: [...new Set(unresolved.map(input =>
                input.kind === 'parameter' ? 'parameter-unresolved' : 'reference-data-unresolved'
            ))],
        };
}

function nonCommentEntries(lines, startLine) {
    const entries = [];
    for (let index = 1; index < lines.length; index++) {
        const line = lines[index];
        if (isKeywordLine(line)) {
            break;
        }
        if (isCommentOrBlank(line)) {
            continue;
        }
        entries.push({
            text: line,
            lineIndex: startLine + index,
            tokens: tokenize(line),
        });
    }
    return entries;
}

function parseScale(tokens, names) {
    const scale = {};
    for (const [name, rawIndex] of Object.entries(names)) {
        const index = Number(rawIndex);
        const value = parseNumberToken(tokens[index]);
        if (value !== null) {
            scale[name] = value;
        }
    }
    return scale;
}

function parseCurveBlock(block, text) {
    const keyword = withStar(block.keyword);
    const normalized = normalizeKeyword(keyword);
    const entries = nonCommentEntries(splitLines(text), block.startLine || 0);
    let cursor = 0;
    let title;

    if (normalized.includes('TITLE') && entries[cursor]) {
        title = entries[cursor].text.trim();
        cursor += 1;
    }

    const idEntry = entries[cursor];
    if (!idEntry || idEntry.tokens.length === 0) {
        return null;
    }
    const idRaw = idEntry.tokens[0];
    const idInput = parseDefinitionIdInput(idRaw);
    const id = numericInputValue(idInput);
    if (idInput.kind === 'blank' || idInput.kind === 'invalid') {
        return null;
    }
    cursor += 1;

    if (normalized.includes('FUNCTION')) {
        const functionText = entries.slice(cursor).map(entry => entry.text.trim()).join('\n').trim();
        return {
            kind: 'functionCurve',
            id,
            idRaw,
            idInput,
            keyword,
            filePath: block.filePath,
            startLine: block.startLine || 0,
            endLine: block.endLine || block.startLine || 0,
            ...(title ? { title } : {}),
            points: [],
            functionText,
            dataCompleteness: { state: 'complete', reasons: [] },
        };
    }

    const points = [];
    const pointInputs = [];
    for (const entry of entries.slice(cursor)) {
        if (entry.tokens.length < 2) {
            continue;
        }
        const xRaw = entry.tokens[0];
        const yRaw = entry.tokens[1];
        const xInput = parseNumericInput(xRaw, { integerOnly: false });
        const yInput = parseNumericInput(yRaw, { integerOnly: false });
        pointInputs.push(xInput, yInput);
        points.push({
            xRaw,
            yRaw,
            x: numericInputValue(xInput),
            y: numericInputValue(yInput),
            xInput,
            yInput,
            lineIndex: entry.lineIndex,
        });
    }

    return {
        kind: 'curve',
        id,
        idRaw,
        idInput,
        keyword,
        filePath: block.filePath,
        startLine: block.startLine || 0,
        endLine: block.endLine || block.startLine || 0,
        ...(title ? { title } : {}),
        points,
        dataCompleteness: completenessFromInputs(pointInputs),
        scale: parseScale(idEntry.tokens, { sfa: 2, sfo: 3, offa: 4, offo: 5 }),
    };
}

function tableTypeFromKeyword(keyword) {
    const normalized = normalizeKeyword(keyword);
    if (normalized.includes('_4D')) {
        return '4d';
    }
    if (normalized.includes('_3D')) {
        return '3d';
    }
    if (normalized.includes('_2D')) {
        return '2d';
    }
    return '1d';
}

function parseTableBlock(block, text) {
    const keyword = withStar(block.keyword);
    const normalized = normalizeKeyword(keyword);
    const entries = nonCommentEntries(splitLines(text), block.startLine || 0);
    let cursor = 0;
    let title;

    if (normalized.includes('TITLE') && entries[cursor]) {
        title = entries[cursor].text.trim();
        cursor += 1;
    }

    const idEntry = entries[cursor];
    if (!idEntry || idEntry.tokens.length === 0) {
        return null;
    }
    const idRaw = idEntry.tokens[0];
    const idInput = parseDefinitionIdInput(idRaw);
    const id = numericInputValue(idInput);
    if (idInput.kind === 'blank' || idInput.kind === 'invalid') {
        return null;
    }
    cursor += 1;

    const tableType = tableTypeFromKeyword(keyword);
    const childKind = tableType === '3d' || tableType === '4d' ? 'table' : 'curve';
    const rows = [];
    const rowInputs = [];
    
    if (tableType === '1d') {
        for (const entry of entries.slice(cursor)) {
            for (const token of entry.tokens) {
                const valueInput = parseNumericInput(token, { integerOnly: false });
                rowInputs.push(valueInput);
                rows.push({
                    valueRaw: token,
                    value: numericInputValue(valueInput),
                    valueInput,
                    childIdRaw: '',
                    childId: null,
                    childIdInput: { kind: 'blank', raw: '' },
                    childKind,
                    lineIndex: entry.lineIndex,
                });
            }
        }
    } else {
        for (const entry of entries.slice(cursor)) {
            if (entry.tokens.length < 2) {
                continue;
            }
            const valueRaw = entry.tokens[0];
            const childIdRaw = entry.tokens[1];
            const valueInput = parseNumericInput(valueRaw, { integerOnly: false });
            const childIdInput = parseDefinitionIdInput(childIdRaw);
            rowInputs.push(valueInput, childIdInput);
            rows.push({
                valueRaw,
                value: numericInputValue(valueInput),
                valueInput,
                childIdRaw,
                childId: numericInputValue(childIdInput),
                childIdInput,
                childKind,
                lineIndex: entry.lineIndex,
            });
        }
    }

    return {
        kind: 'table',
        tableType,
        id,
        idRaw,
        idInput,
        keyword,
        filePath: block.filePath,
        startLine: block.startLine || 0,
        endLine: block.endLine || block.startLine || 0,
        ...(title ? { title } : {}),
        rows,
        dataCompleteness: completenessFromInputs(rowInputs),
        scale: parseScale(idEntry.tokens, { sfa: 1, offa: 2 }),
    };
}

function descriptorRawCandidates(entry, descriptor, keyword) {
    if (entry.text.includes(',')) {
        const values = entry.text.split(',').map(value => value.trim());
        return [values[descriptor.fieldIndex] || ''];
    }

    const longFormatScale = /\+$/.test(normalizeKeyword(keyword)) ? 2 : 1;
    const start = descriptor.position * longFormatScale;
    const width = descriptor.width * longFormatScale;
    const fixedValue = entry.text.slice(start, start + width).trim();
    const tokenValue = entry.tokens[descriptor.fieldIndex] || '';
    return fixedValue === tokenValue ? [fixedValue] : [fixedValue, tokenValue];
}

function parseGenericDefineBlock(block, text, descriptor) {
    if (!descriptor) {
        return null;
    }
    const keyword = withStar(block.keyword);
    const entries = nonCommentEntries(splitLines(text), block.startLine || 0);
    const idEntry = entries[descriptor.cardIndex - 1];
    if (!idEntry) {
        return null;
    }

    let idRaw = '';
    let idInput = { kind: 'blank', raw: '' };
    for (const candidate of descriptorRawCandidates(idEntry, descriptor, block.keyword)) {
        const parsed = parseDefinitionIdInput(candidate);
        if (parsed.kind !== 'blank' && parsed.kind !== 'invalid') {
            idRaw = candidate;
            idInput = parsed;
            break;
        }
    }
    if (idInput.kind === 'blank' || idInput.kind === 'invalid') {
        return null;
    }
    const id = numericInputValue(idInput);

    return {
        kind: 'generic',
        id,
        idRaw,
        idInput,
        keyword,
        targetKeyword: descriptor.target,
        idFieldName: descriptor.fieldName,
        filePath: block.filePath,
        startLine: block.startLine || 0,
        endLine: block.endLine || block.startLine || 0,
    };
}

async function scanCurveTableDefinitionsFromFileIndex(
    fileIndex,
    readBlockText,
    definitionKeywords = loadedReferenceIndex.definitionKeywords
) {
    const curves = [];
    const tables = [];
    const genericDefinitions = [];
    if (!fileIndex || !Array.isArray(fileIndex.keywordBlocks) || typeof readBlockText !== 'function') {
        return { curves, tables, genericDefinitions };
    }

    for (let i = 0; i < fileIndex.keywordBlocks.length; i++) {
        const block = fileIndex.keywordBlocks[i];
        const keyword = withStar(block.keyword);
        const genericDescriptor = genericDefinitionDescriptor(keyword, definitionKeywords);
        if (!isCurveKeyword(keyword) && !isTableKeyword(keyword) && !genericDescriptor) {
            continue;
        }
        const text = await readBlockText(block);
        if (isCurveKeyword(keyword)) {
            const definition = parseCurveBlock(block, text);
            if (definition) {
                curves.push(definition);
            }
        } else if (isTableKeyword(keyword)) {
            const definition = parseTableBlock(block, text);
            if (definition) {
                tables.push(definition);
                
                // If it is a 1D table, resolve its child curves from subsequent blocks
                if (definition.tableType === '1d' && definition.rows.length > 0) {
                    let childCount = 0;
                    const requiredChildren = definition.rows.length;
                    for (let j = i + 1; j < fileIndex.keywordBlocks.length; j++) {
                        if (childCount >= requiredChildren) {
                            break;
                        }
                        const nextBlock = fileIndex.keywordBlocks[j];
                        const nextKeyword = withStar(nextBlock.keyword);
                        if (isCurveKeyword(nextKeyword)) {
                            const curveText = await readBlockText(nextBlock);
                            const curveDef = parseCurveBlock(nextBlock, curveText);
                            if (curveDef) {
                                const row = definition.rows[childCount];
                                row.childIdRaw = curveDef.idRaw;
                                row.childId = curveDef.id;
                                row.childIdInput = curveDef.idInput;
                                row.childKind = 'curve';
                                childCount++;
                            }
                        } else if (isTableKeyword(nextKeyword)) {
                            const tableText = await readBlockText(nextBlock);
                            const tableDef = parseTableBlock(nextBlock, tableText);
                            if (tableDef) {
                                const row = definition.rows[childCount];
                                row.childIdRaw = tableDef.idRaw;
                                row.childId = tableDef.id;
                                row.childIdInput = tableDef.idInput;
                                row.childKind = 'table';
                                childCount++;
                            }
                        }
                    }
                    definition.dataCompleteness = completenessFromInputs(
                        definition.rows.flatMap(row => [row.valueInput, row.childIdInput])
                    );
                }
            }
        } else {
            const definition = parseGenericDefineBlock(block, text, genericDescriptor);
            if (definition) {
                genericDefinitions.push(definition);
            }
        }
    }

    return { curves, tables, genericDefinitions };
}

module.exports = {
    scanCurveTableDefinitionsFromFileIndex,
    parseCurveBlock,
    parseTableBlock,
    parseGenericDefineBlock,
};

export {};
