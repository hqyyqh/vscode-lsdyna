'use strict';

const { parseNumericInput, numericInputValue } = require('./referenceInputValue');
const { getDefinitionRegistryCatalog } = require('./definitionRegistry');
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

function genericDefinitionDescriptor(
    keyword,
    definitionKeywords = loadedReferenceIndex.definitionKeywords,
    registryCatalog = getDefinitionRegistryCatalog(),
) {
    const normalized = normalizeKeyword(keyword).replace(/[+%\-]$/, '');
    const indexed = definitionKeywords && definitionKeywords.generic
        ? definitionKeywords.generic[normalized] || null
        : null;
    return indexed || registryCatalog?.definitionDescriptorForKeyword(normalized) || null;
}

function isVerifiedScannedDefinition(keyword, definitionKeywords = loadedReferenceIndex.definitionKeywords) {
    const normalized = normalizeKeyword(keyword).replace(/[+%\-]$/, '');
    return Array.isArray(definitionKeywords?.scanned) &&
        definitionKeywords.scanned.includes(normalized);
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
    const text = String(line || '');
    // A comma marks a physical field even when its value is empty.
    // Filtering these cells shifts scale factors and drops zero curve points.
    if (text.includes(',')) return text.split(',').map(token => token.trim());
    return text
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

function definitionIdLocation(entry, idRaw, preferredStart = null, preferredWidth = null) {
    if (!entry || !Number.isInteger(entry.lineIndex)) return {};
    const text = String(entry.text || '');
    const raw = String(idRaw || '');
    if (!raw) return { idLine: entry.lineIndex };

    let start = -1;
    if (Number.isInteger(preferredStart) && preferredStart >= 0 &&
        Number.isInteger(preferredWidth) && preferredWidth > 0) {
        const cell = text.slice(preferredStart, preferredStart + preferredWidth);
        const cellOffset = cell.indexOf(raw);
        if (cellOffset >= 0) start = preferredStart + cellOffset;
    }
    if (start < 0) start = text.indexOf(raw);
    if (start < 0) return { idLine: entry.lineIndex };
    return {
        idLine: entry.lineIndex,
        idStartChar: start,
        idEndChar: start + raw.length,
    };
}

function genericDefinitionIdLocation(entry, idRaw, descriptor, keyword) {
    const text = String(entry?.text || '');
    if (text.includes(',')) {
        let start = 0;
        for (let index = 0; index <= descriptor.fieldIndex; index++) {
            const end = text.indexOf(',', start);
            const cellEnd = end >= 0 ? end : text.length;
            if (index === descriptor.fieldIndex) {
                const cell = text.slice(start, cellEnd);
                const offset = cell.indexOf(idRaw);
                if (offset >= 0) {
                    return {
                        idLine: entry.lineIndex,
                        idStartChar: start + offset,
                        idEndChar: start + offset + idRaw.length,
                    };
                }
                break;
            }
            if (end < 0) break;
            start = end + 1;
        }
    }

    const longFormatScale = /\+$/.test(normalizeKeyword(keyword)) ? 2 : 1;
    const fixed = definitionIdLocation(
        entry,
        idRaw,
        descriptor.position * longFormatScale,
        descriptor.width * longFormatScale
    );
    if (Number.isInteger(fixed.idStartChar)) return fixed;

    const tokens = [...text.matchAll(/[^,\s]+/g)];
    const token = tokens[descriptor.fieldIndex];
    if (token && token[0] === idRaw && Number.isInteger(token.index)) {
        return {
            idLine: entry.lineIndex,
            idStartChar: token.index,
            idEndChar: token.index + idRaw.length,
        };
    }
    return { idLine: entry.lineIndex };
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
            ...definitionIdLocation(idEntry, idRaw),
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
        // Native comma-format curve coordinates default empty cells to zero.
        // Keep raw text for display; do not apply this default to identifiers,
        // symbolic/invalid values, or other record families.
        const xInput = entry.text.includes(',') && xRaw === ''
            ? { ...parseNumericInput('0', { integerOnly: false }), raw: '' }
            : parseNumericInput(xRaw, { integerOnly: false });
        const yInput = entry.text.includes(',') && yRaw === ''
            ? { ...parseNumericInput('0', { integerOnly: false }), raw: '' }
            : parseNumericInput(yRaw, { integerOnly: false });
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
        ...definitionIdLocation(idEntry, idRaw),
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
    const dimension = normalized.match(/_([2-9])D(?:_|$)/)?.[1];
    return dimension ? `${dimension}d` : '1d';
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
    const dimension = Number.parseInt(tableType, 10);
    const childKind = dimension >= 3 ? 'table' : 'curve';
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
            const childLocation = definitionIdLocation(entry, childIdRaw, 20, 20);
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
                childIdLine: childLocation.idLine,
                childIdStartChar: childLocation.idStartChar,
                childIdEndChar: childLocation.idEndChar,
            });
        }
    }

    return {
        kind: 'table',
        tableType,
        id,
        idRaw,
        idInput,
        ...definitionIdLocation(idEntry, idRaw),
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

    const idLocation = genericDefinitionIdLocation(idEntry, idRaw, descriptor, keyword);

    return {
        kind: 'generic',
        id,
        idRaw,
        idInput,
        ...idLocation,
        keyword,
        targetKeyword: descriptor.target,
        ...(descriptor.targetKind ? { targetKind: descriptor.targetKind } : {}),
        idFieldName: descriptor.fieldName,
        ruleId: descriptor.ruleId,
        evidenceIds: descriptor.evidenceIds || [],
        filePath: block.filePath,
        startLine: block.startLine || 0,
        endLine: block.endLine || block.startLine || 0,
    };
}

async function scanCurveTableDefinitionsFromFileIndex(
    fileIndex,
    readBlockText,
    definitionKeywords = loadedReferenceIndex.definitionKeywords,
    options: {
        cancellationToken?: { isCancellationRequested?: boolean };
        registryCatalog?: any;
    } = {}
) {
    const curves = [];
    const tables = [];
    const genericDefinitions = [];
    if (!fileIndex || !Array.isArray(fileIndex.keywordBlocks) || typeof readBlockText !== 'function') {
        return { curves, tables, genericDefinitions };
    }

    const isCancelled = () => options.cancellationToken?.isCancellationRequested === true;
    const cancelledResult = () => ({ curves, tables, genericDefinitions, cancelled: true });

    for (let i = 0; i < fileIndex.keywordBlocks.length; i++) {
        if (isCancelled()) return cancelledResult();
        const block = fileIndex.keywordBlocks[i];
        const keyword = withStar(block.keyword);
        const genericDescriptor = genericDefinitionDescriptor(
            keyword,
            definitionKeywords,
            options.registryCatalog,
        );
        const verifiedScanned = isVerifiedScannedDefinition(keyword, definitionKeywords);
        const curveDefinition = verifiedScanned && isCurveKeyword(keyword);
        const tableDefinition = verifiedScanned && isTableKeyword(keyword);
        if (!curveDefinition && !tableDefinition && !genericDescriptor) {
            continue;
        }
        const text = await readBlockText(block);
        if (isCancelled()) return cancelledResult();
        if (curveDefinition) {
            const definition = parseCurveBlock(block, text);
            if (definition) {
                curves.push(definition);
            }
        } else if (tableDefinition) {
            const definition = parseTableBlock(block, text);
            if (definition) {
                tables.push(definition);
                
                // If it is a 1D table, resolve its child curves from subsequent blocks
                if (definition.tableType === '1d' && definition.rows.length > 0) {
                    let childCount = 0;
                    const requiredChildren = definition.rows.length;
                    for (let j = i + 1; j < fileIndex.keywordBlocks.length; j++) {
                        if (isCancelled()) return cancelledResult();
                        if (childCount >= requiredChildren) {
                            break;
                        }
                        const nextBlock = fileIndex.keywordBlocks[j];
                        const nextKeyword = withStar(nextBlock.keyword);
                        if (isVerifiedScannedDefinition(nextKeyword, definitionKeywords) && isCurveKeyword(nextKeyword)) {
                            const curveText = await readBlockText(nextBlock);
                            if (isCancelled()) return cancelledResult();
                            const curveDef = parseCurveBlock(nextBlock, curveText);
                            if (curveDef) {
                                const row = definition.rows[childCount];
                                row.childIdRaw = curveDef.idRaw;
                                row.childId = curveDef.id;
                                row.childIdInput = curveDef.idInput;
                                row.childKind = 'curve';
                                childCount++;
                            }
                        } else if (isVerifiedScannedDefinition(nextKeyword, definitionKeywords) && isTableKeyword(nextKeyword)) {
                            const tableText = await readBlockText(nextBlock);
                            if (isCancelled()) return cancelledResult();
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
    genericDefinitionDescriptor,
    scanCurveTableDefinitionsFromFileIndex,
    parseCurveBlock,
    parseTableBlock,
    parseGenericDefineBlock,
};

export {};
