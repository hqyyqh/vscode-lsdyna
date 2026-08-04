'use strict';

const loadedReferenceIndex = require('../../../keywords/field_reference_index.json');
const { parseNumericInput } = require('./referenceInputValue');
let referenceIndexCache = loadedReferenceIndex;

function normalizeKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function normalizeFieldName(value) {
    return String(value || '').trim().toUpperCase();
}

function loadReferenceIndex() {
    return referenceIndexCache;
}

function getFieldReferenceInfo({ keyword, cardIndex, field }) {
    if (!field || !field.n || !cardIndex) {
        return null;
    }
    const normalizedKeyword = normalizeKeyword(keyword);
    const normalizedField = normalizeFieldName(field.n);
    const index = loadReferenceIndex();
    const keywordReferences = (index.references || {})[normalizedKeyword];
    if (!keywordReferences) {
        return null;
    }
    const reference = keywordReferences[`${cardIndex}:${normalizedField}`];
    if (!reference) {
        return null;
    }
    return {
        keyword: normalizedKeyword,
        cardIndex,
        fieldName: normalizedField,
        fieldType: reference.fieldType,
        targetKinds: reference.targetKinds || [],
        targetDefinitions: reference.targetDefinitions || [],
        label: reference.label,
        allowSignedSwitch: reference.allowSignedSwitch !== false,
        requiresSignedSwitch: reference.requiresSignedSwitch === true,
        confidence: reference.confidence || 'high',
        source: reference.source || 'schema-help',
    };
}

function parseFieldReferenceValue(rawValue, info = null) {
    const raw = String(rawValue || '').trim();
    if (!raw) {
        return null;
    }

    const input = parseNumericInput(raw, {
        integerOnly: true,
        nonZero: true,
    });
    if (input.kind === 'parameter') {
        if (info && info.requiresSignedSwitch === true && !input.negated) {
            return null;
        }
        if (input.negated && info && info.allowSignedSwitch === false) {
            return null;
        }
        return {
            kind: 'parameter',
            parameterName: input.name,
            raw: input.raw,
            isSignedSwitch: input.negated,
            input,
        };
    }
    if (input.kind !== 'numeric') {
        return null;
    }
    if (info && info.requiresSignedSwitch === true && input.value > 0) {
        return null;
    }
    if (input.value < 0 && info && info.allowSignedSwitch === false) {
        return null;
    }
    return {
        kind: 'numeric',
        id: Math.abs(input.value),
        raw,
        isSignedSwitch: input.value < 0,
        input,
    };
}

function resetFieldReferenceIndexCacheForTesting() {
    referenceIndexCache = loadedReferenceIndex;
}

module.exports = {
    getFieldReferenceInfo,
    parseFieldReferenceValue,
    resetFieldReferenceIndexCacheForTesting,
};

export {};
