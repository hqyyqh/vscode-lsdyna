'use strict';

const loadedReferenceIndex = require('../../../keywords/field_reference_index.json');
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
        label: reference.label,
        allowSignedSwitch: reference.allowSignedSwitch !== false,
        requiresSignedSwitch: reference.requiresSignedSwitch === true,
        confidence: reference.confidence || 'high',
        source: reference.source || 'schema-help',
    };
}

function parseReferenceInteger(raw) {
    if (!/^[+-]?\d+(?:\.0*)?$/.test(raw)) {
        return null;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed === 0) {
        return null;
    }
    return parsed;
}

function parseFieldReferenceValue(rawValue, info = null) {
    const raw = String(rawValue || '').trim();
    if (!raw) {
        return null;
    }
    const parsed = parseReferenceInteger(raw);
    if (parsed === null) {
        return null;
    }
    if (info && info.requiresSignedSwitch === true && parsed > 0) {
        return null;
    }
    if (parsed < 0 && info && info.allowSignedSwitch === false) {
        return null;
    }
    return {
        id: Math.abs(parsed),
        raw,
        isSignedSwitch: parsed < 0,
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
