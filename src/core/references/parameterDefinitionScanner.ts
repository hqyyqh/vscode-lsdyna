'use strict';

const { parseNumericInput } = require('./referenceInputValue');
const {
    classifyParameterKeyword,
    parseParameterDataLine,
} = require('../parser/parameterSyntax');
const {
    globalInputFormatFromKeywordLine,
} = require('../parser/inputFormat');
const { throwIfCancellationRequested } = require('../scanner/scannerContracts');

function normalizeKeyword(value) {
    let token = String(value || '').trim().toUpperCase().split(/[\s,$]/)[0];
    if (!token.startsWith('*')) token = `*${token}`;
    return /[+%\-]$/.test(token) ? token.slice(0, -1) : token;
}

function dataLines(block, text) {
    return String(text || '').split(/\r?\n/)
        .map((line, offset) => ({
            text: line,
            lineIndex: (block.startLine || 0) + offset,
        }))
        .filter((entry, index) => {
            if (index === 0 && entry.text.trimStart().startsWith('*')) return false;
            const trimmed = entry.text.trim();
            return trimmed !== '' && !trimmed.startsWith('$');
        });
}

function firstCardField(line, width) {
    if (line.includes(',')) return line.split(',')[0].trim();
    return line.slice(0, width).trim();
}

function definitionEvent(definition) {
    let value = null;
    let valueState = 'unknown';
    let reason = definition.expression
        ? 'parameter-expression-unresolved'
        : 'unsupported-parameter-type';
    if (!definition.expression && ['I', 'R'].includes(definition.parameterType)) {
        const integer = definition.parameterType === 'I';
        const input = parseNumericInput(definition.value, { integerOnly: integer });
        if (input.kind === 'numeric' && (!integer || Number.isSafeInteger(input.value))) {
            value = input.value;
            valueState = integer ? 'integer' : 'real';
            reason = null;
        } else {
            reason = input.kind === 'parameter'
                ? 'parameter-definition-reference-unresolved'
                : 'parameter-value-unresolved';
        }
    }

    return {
        type: 'definition',
        keyword: definition.keyword,
        lineIndex: definition.lineIndex,
        sequence: definition.sequence,
        name: definition.normalizedName,
        rawName: definition.name,
        parameterType: definition.parameterType,
        rawValue: definition.value,
        value,
        valueState,
        reason,
        local: definition.options.local,
        mutable: definition.options.mutable,
        noecho: definition.options.noecho,
        expression: definition.expression,
        format: definition.format,
        ...(definition.parameterUsageType
            ? { parameterUsageType: definition.parameterUsageType }
            : {}),
    };
}

function scanParameterDefinitionBlock(block, text, options: { globalLongFormat?: boolean } = {}) {
    const keyword = classifyParameterKeyword(block.keyword);
    if (!keyword || (keyword.kind !== 'definition' && keyword.kind !== 'parameter-type')) {
        return [];
    }

    const events = [];
    let currentExpressionEvent = null;
    for (const entry of dataLines(block, text)) {
        const parsed = parseParameterDataLine(
            entry.text,
            entry.lineIndex,
            keyword,
            options.globalLongFormat === true,
        );
        if (parsed.isContinuation) {
            if (currentExpressionEvent && parsed.expressionSegments[0]) {
                currentExpressionEvent.rawValue += `\n${parsed.expressionSegments[0].text}`;
            }
            continue;
        }
        currentExpressionEvent = null;
        for (const definition of parsed.definitions) {
            const event = definitionEvent(definition);
            events.push(event);
            if (definition.expression) currentExpressionEvent = event;
        }
    }
    return events;
}

function scanParameterDuplicationBlock(block, text, options: { globalLongFormat?: boolean } = {}) {
    const entry = dataLines(block, text)[0];
    const keyword = classifyParameterKeyword(block.keyword);
    const longFormat = keyword?.inputFormatOverride === 'long' ||
        (keyword?.inputFormatOverride === null && options.globalLongFormat);
    const width = longFormat ? 20 : 10;
    if (!entry) {
        return [{
            type: 'duplication',
            keyword: normalizeKeyword(block.keyword),
            lineIndex: block.startLine || 0,
            sequence: 0,
            rawValue: '',
            dflag: 1,
        }];
    }
    const raw = firstCardField(entry.text, width);
    const parsed = parseNumericInput(raw, { integerOnly: true });
    return [{
        type: 'duplication',
        keyword: normalizeKeyword(block.keyword),
        lineIndex: entry.lineIndex,
        sequence: 0,
        rawValue: raw,
        dflag: parsed.kind === 'numeric' && parsed.value >= 1 && parsed.value <= 5
            ? parsed.value
            : null,
    }];
}

function classifyParameterKeywordKind(keyword) {
    return classifyParameterKeyword(keyword)?.kind || null;
}

async function scanParameterEventsFromFileIndex(
    fileIndex,
    readKeywordBlockText,
    options: { cancellationToken?: { isCancellationRequested?: boolean } } = {},
) {
    const events = [];
    let globalInputFormat = 'standard';
    for (const block of fileIndex && fileIndex.keywordBlocks || []) {
        throwIfCancellationRequested(options.cancellationToken);
        const normalized = normalizeKeyword(block.keyword);
        if (normalized === '*KEYWORD') {
            const headerText = await readKeywordBlockText(block);
            throwIfCancellationRequested(options.cancellationToken);
            const firstLine = String(headerText || '').split(/\r?\n/)[0];
            globalInputFormat = globalInputFormatFromKeywordLine(firstLine, globalInputFormat);
            continue;
        }

        const kind = classifyParameterKeywordKind(block.keyword);
        if (!kind) continue;
        if (kind === 'scope-control') {
            events.push({
                type: kind,
                keyword: normalizeKeyword(block.keyword),
                lineIndex: block.startLine || 0,
                sequence: 0,
            });
            continue;
        }

        const text = await readKeywordBlockText(block);
        throwIfCancellationRequested(options.cancellationToken);
        if (kind === 'duplication') {
            events.push(...scanParameterDuplicationBlock(block, text, {
                globalLongFormat: globalInputFormat === 'long',
            }));
        } else {
            events.push(...scanParameterDefinitionBlock(block, text, {
                globalLongFormat: globalInputFormat === 'long',
            }));
        }
    }

    return events.sort((left, right) =>
        left.lineIndex - right.lineIndex || left.sequence - right.sequence
    );
}

module.exports = {
    scanParameterEventsFromFileIndex,
    scanParameterDefinitionBlock,
    classifyParameterKeyword: classifyParameterKeywordKind,
};

export {};
