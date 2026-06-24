'use strict';

const fs = require('fs');
const path = require('path');

let referenceIndexCache = null;

function normalizeKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function normalizeFieldName(value) {
    return String(value || '').trim().toUpperCase();
}

function referenceIndexPath() {
    return path.join(__dirname, '..', '..', '..', 'keywords', 'field_reference_index.json');
}

function loadReferenceIndex() {
    if (referenceIndexCache) {
        return referenceIndexCache;
    }
    try {
        referenceIndexCache = JSON.parse(fs.readFileSync(referenceIndexPath(), 'utf8'));
    } catch (_error) {
        referenceIndexCache = { references: {} };
    }
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
        targetKinds: reference.targetKinds || [],
        label: reference.label,
        allowSignedSwitch: reference.allowSignedSwitch !== false,
        confidence: reference.confidence || 'high',
        source: reference.source || 'schema-help',
    };
}

function parseFieldReferenceValue(rawValue, info = null) {
    const raw = String(rawValue || '').trim();
    if (!raw || !/^-?\d+$/.test(raw)) {
        return null;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed === 0) {
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
    referenceIndexCache = null;
}

module.exports = {
    getFieldReferenceInfo,
    parseFieldReferenceValue,
    resetFieldReferenceIndexCacheForTesting,
};

export {};
