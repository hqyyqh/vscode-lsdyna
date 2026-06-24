'use strict';

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
    if (!token || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(token)) {
        return null;
    }
    const value = Number(token);
    return Number.isFinite(value) ? value : null;
}

function parseIntegerToken(token) {
    if (!token || !/^[+-]?\d+$/.test(token)) {
        return null;
    }
    const value = Number.parseInt(token, 10);
    return Number.isFinite(value) && value !== 0 ? Math.abs(value) : null;
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
    const id = parseIntegerToken(idRaw);
    if (id === null) {
        return null;
    }
    cursor += 1;

    if (normalized.includes('FUNCTION')) {
        const functionText = entries.slice(cursor).map(entry => entry.text.trim()).join('\n').trim();
        return {
            kind: 'functionCurve',
            id,
            idRaw,
            keyword,
            filePath: block.filePath,
            startLine: block.startLine || 0,
            endLine: block.endLine || block.startLine || 0,
            ...(title ? { title } : {}),
            points: [],
            functionText,
        };
    }

    const points = [];
    for (const entry of entries.slice(cursor)) {
        if (entry.tokens.length < 2) {
            continue;
        }
        const xRaw = entry.tokens[0];
        const yRaw = entry.tokens[1];
        points.push({
            xRaw,
            yRaw,
            x: parseNumberToken(xRaw),
            y: parseNumberToken(yRaw),
            lineIndex: entry.lineIndex,
        });
    }

    return {
        kind: 'curve',
        id,
        idRaw,
        keyword,
        filePath: block.filePath,
        startLine: block.startLine || 0,
        endLine: block.endLine || block.startLine || 0,
        ...(title ? { title } : {}),
        points,
        scale: parseScale(idEntry.tokens, { sfa: 2, sfo: 3, offa: 4, offo: 5 }),
    };
}

function tableTypeFromKeyword(keyword) {
    const normalized = normalizeKeyword(keyword);
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
    const id = parseIntegerToken(idRaw);
    if (id === null) {
        return null;
    }
    cursor += 1;

    const tableType = tableTypeFromKeyword(keyword);
    const childKind = tableType === '3d' ? 'table' : 'curve';
    const rows = [];
    for (const entry of entries.slice(cursor)) {
        if (entry.tokens.length < 2) {
            continue;
        }
        const valueRaw = entry.tokens[0];
        const childIdRaw = entry.tokens[1];
        rows.push({
            valueRaw,
            value: parseNumberToken(valueRaw),
            childIdRaw,
            childId: parseIntegerToken(childIdRaw),
            childKind,
            lineIndex: entry.lineIndex,
        });
    }

    return {
        kind: 'table',
        tableType,
        id,
        idRaw,
        keyword,
        filePath: block.filePath,
        startLine: block.startLine || 0,
        endLine: block.endLine || block.startLine || 0,
        ...(title ? { title } : {}),
        rows,
        scale: parseScale(idEntry.tokens, { sfa: 1, offa: 2 }),
    };
}

async function scanCurveTableDefinitionsFromFileIndex(fileIndex, readBlockText) {
    const curves = [];
    const tables = [];
    if (!fileIndex || !Array.isArray(fileIndex.keywordBlocks) || typeof readBlockText !== 'function') {
        return { curves, tables };
    }

    for (const block of fileIndex.keywordBlocks) {
        const keyword = withStar(block.keyword);
        if (!isCurveKeyword(keyword) && !isTableKeyword(keyword)) {
            continue;
        }
        const text = await readBlockText(block);
        if (isCurveKeyword(keyword)) {
            const definition = parseCurveBlock(block, text);
            if (definition) {
                curves.push(definition);
            }
        } else {
            const definition = parseTableBlock(block, text);
            if (definition) {
                tables.push(definition);
            }
        }
    }

    return { curves, tables };
}

module.exports = {
    scanCurveTableDefinitionsFromFileIndex,
    parseCurveBlock,
    parseTableBlock,
};

export {};
