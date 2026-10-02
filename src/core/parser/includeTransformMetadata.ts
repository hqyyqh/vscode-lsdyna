'use strict';

const { parseNumericInput } = require('../references/referenceInputValue');

const OFFSET_FIELDS = [
    'idnoff',
    'ideoff',
    'idpoff',
    'idmoff',
    'idsoff',
    'idfoff',
    'iddoff',
];

function blankInput() {
    return { kind: 'blank', raw: '' };
}

function splitCardFields(line, fieldCount) {
    const text = String(line || '');
    if (text.includes(',')) {
        const fields = text.split(',').map(value => value.trim());
        while (fields.length < fieldCount) fields.push('');
        return fields.slice(0, fieldCount);
    }

    const whitespaceFields = text.trim().split(/\s+/).filter(Boolean);
    if (whitespaceFields.length >= fieldCount) {
        return whitespaceFields.slice(0, fieldCount);
    }

    if (text.length >= 10) {
        const fixed = [];
        for (let index = 0; index < fieldCount; index++) {
            fixed.push(text.slice(index * 10, (index + 1) * 10).trim());
        }
        if (fixed.some(Boolean)) {
            return fixed;
        }
    }

    const fields = whitespaceFields;
    while (fields.length < fieldCount) fields.push('');
    return fields.slice(0, fieldCount);
}

function parseIntegerField(raw) {
    return parseNumericInput(raw, { integerOnly: true });
}

function createIncludeTransformMetadata(keyword, keywordLine, filenameLine) {
    const offsets = {};
    for (const field of [...OFFSET_FIELDS, 'idroff']) {
        offsets[field] = blankInput();
    }
    return {
        keyword,
        keywordLine,
        filenameLine,
        offsets,
        tranid: blankInput(),
        rawCards: [],
        parseCompleteness: {
            state: 'incomplete',
            reasons: ['transform-cards-not-finalized'],
        },
    };
}

function applyIncludeTransformDataCard(metadata, cardNumber, line, lineIndex) {
    if (!metadata) return;
    metadata.rawCards.push({ cardNumber, lineIndex, raw: String(line || '') });

    if (cardNumber === 2) {
        const fields = splitCardFields(line, OFFSET_FIELDS.length);
        for (let index = 0; index < OFFSET_FIELDS.length; index++) {
            metadata.offsets[OFFSET_FIELDS[index]] = parseIntegerField(fields[index]);
        }
        return;
    }
    if (cardNumber === 3) {
        metadata.offsets.idroff = parseIntegerField(splitCardFields(line, 1)[0]);
        return;
    }
    if (cardNumber === 5) {
        metadata.tranid = parseIntegerField(splitCardFields(line, 1)[0]);
    }
}

function finalizeIncludeTransformMetadata(metadata) {
    if (!metadata) return null;
    const reasons = [];
    const idfoff = metadata.offsets.idfoff;
    if (!metadata.rawCards.some(card => card.cardNumber === 2)) {
        reasons.push('transform-offset-card-missing');
    } else if (idfoff.kind === 'blank') {
        reasons.push('transform-idfoff-blank');
    } else if (idfoff.kind === 'invalid' || idfoff.kind === 'expression') {
        reasons.push('transform-idfoff-unparsed');
    } else if (idfoff.kind === 'parameter') {
        reasons.push('transform-idfoff-parameterized');
    }
    metadata.parseCompleteness = reasons.length === 0
        ? { state: 'complete', reasons: [] }
        : { state: 'incomplete', reasons };
    return metadata;
}

function isTransformIncludeKeyword(keyword) {
    const normalized = String(keyword || '').trim().toUpperCase();
    return normalized === '*INCLUDE_TRANSFORM' || normalized === '*INCLUDE_TRANSFORM_BINARY';
}

module.exports = {
    OFFSET_FIELDS,
    splitCardFields,
    createIncludeTransformMetadata,
    applyIncludeTransformDataCard,
    finalizeIncludeTransformMetadata,
    isTransformIncludeKeyword,
};

export {};
