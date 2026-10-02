'use strict';
// Public deterministic compiler; external collection and certification are separate.
const FIELD_TYPES = new Set(['bool', 'integer', 'real', 'string']);

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireCardEdit(condition, message) {
    if (!condition) {
        throw new Error(`Invalid card-edit runtime: ${message}`);
    }
}

function normalizeKeyword(value) {
    return String(value || '').trim().replace(/^\*/, '').toUpperCase().split(/[\s,$]/)[0];
}

function normalizeField(value) {
    return String(value || '').trim().toUpperCase();
}

function validSha256(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function locateField(rule, schema, keywordSchema) {
    const lookup = keywordSchema.lookupKeywordSchema(normalizeKeyword(rule.keyword), schema);
    if (!lookup) {
        return { reason: 'keyword-not-in-field-schema', matches: [] };
    }
    const cards = keywordSchema.getRenderedCards(lookup.entry, lookup.activeOptions);
    if (rule.fieldLayout !== undefined) {
        const layout = rule.fieldLayout;
        const expectedType = String(layout?.fieldType || '').trim().toLowerCase();
        if (!layout || typeof layout !== 'object' ||
            !Number.isInteger(layout.cardIndex) || layout.cardIndex < 1 ||
            !Number.isInteger(layout.fieldIndex) || layout.fieldIndex < 0 ||
            !FIELD_TYPES.has(expectedType)) {
            return { reason: 'field-layout-invalid', matches: [] };
        }

        const field = cards[layout.cardIndex - 1]?.[layout.fieldIndex];
        if (!field) {
            return { reason: 'field-layout-out-of-range', matches: [] };
        }
        const selector = {
            cardIndex: layout.cardIndex,
            fieldIndex: layout.fieldIndex,
            fieldName: normalizeField(field.n),
            position: field.p,
            width: field.w,
            fieldType: String(field.t || '').trim().toLowerCase(),
        };
        if (!selector.fieldName || selector.fieldType !== expectedType) {
            return { reason: 'field-layout-type-mismatch', matches: [selector] };
        }
        return { selector, matches: [selector] };
    }

    const target = normalizeField(rule.field);
    const matches = [];
    for (let cardOffset = 0; cardOffset < cards.length; cardOffset++) {
        const card = cards[cardOffset] || [];
        for (let fieldIndex = 0; fieldIndex < card.length; fieldIndex++) {
            const field = card[fieldIndex];
            if (normalizeField(field?.n) === target) {
                matches.push({
                    cardIndex: cardOffset + 1,
                    fieldIndex,
                    fieldName: target,
                    position: field.p,
                    width: field.w,
                    fieldType: field.t,
                });
            }
        }
    }
    if (matches.length === 0) {
        return { reason: 'field-not-in-rendered-schema', matches };
    }
    if (matches.length > 1) {
        return { reason: 'field-layout-ambiguous', matches };
    }
    return { selector: matches[0], matches };
}

function bindRuleEvidence(rule, authorityContext) {
    if (authorityContext?.runtimeAuthority?.schemaVersion !== 2 ||
        !Array.isArray(rule?.evidence) || rule.evidence.length === 0) {
        return rule;
    }
    const defaultProfileId = authorityContext.defaultProfile.sourceProfileId;
    const sourceDocuments = authorityContext.documentsByProfile.get(defaultProfileId);
    const evidence = rule.evidence.map(item => {
        requireCardEdit(isPlainObject(item) &&
            typeof item.evidenceId === 'string' && item.evidenceId.length > 0 &&
            validSha256(item.quoteSha256) &&
            typeof item.manualId === 'string' && item.manualId.length > 0 &&
            Number.isSafeInteger(item.page) && item.page >= 1 &&
            !item.sourceProfileId && !item.locations,
        `${rule.ruleId || 'unknown rule'}: source evidence is invalid or already profile-bound`);
        const sourceDocument = sourceDocuments.get(item.manualId);
        requireCardEdit(sourceDocument && item.page <= sourceDocument.pages,
            `${item.evidenceId}: source evidence page is outside the default profile`);
        const locations = [{
            sourceProfileId: defaultProfileId,
            manualId: item.manualId,
            page: item.page,
        }];
        const key = `${item.manualId}\0${item.page}`;
        for (const profile of authorityContext.profiles) {
            if (profile.sourceProfileId === defaultProfileId) continue;
            const mapped = authorityContext.crosswalkByProfile
                .get(profile.sourceProfileId)?.get(key);
            if (!mapped) continue;
            locations.push({
                sourceProfileId: profile.sourceProfileId,
                manualId: mapped.manualId,
                page: mapped.targetPage,
            });
        }
        const {
            manualId: _manualId,
            page: _page,
            sourceProfileId: _sourceProfileId,
            locations: _locations,
            ...identity
        } = item;
        return { ...identity, locations };
    });
    return { ...rule, evidence };
}

function compileRule(rule, schema, keywordSchema, authorityContext = null) {
    const boundRule = bindRuleEvidence(rule, authorityContext);
    if (!rule.field) {
        return { rule: boundRule };
    }
    const located = locateField(rule, schema, keywordSchema);
    if (!located.selector) {
        return {
            blocked: {
                ruleId: rule.ruleId,
                keyword: rule.keyword,
                field: rule.field,
                kind: rule.kind,
                reason: located.reason,
                matches: located.matches,
            },
        };
    }
    return {
        rule: {
            ...boundRule,
            selector: located.selector,
        },
    };
}

module.exports = { compileRule };
