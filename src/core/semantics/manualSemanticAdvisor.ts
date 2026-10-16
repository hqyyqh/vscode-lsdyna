import {
    evaluatePredicate,
    PredicateContext,
    TriState,
} from './predicateEvaluator';
import {
    getManualSemanticCatalog,
    normalizeSemanticKeyword,
} from './manualSemanticCatalog';

type SemanticCatalog = {
    rulesForKeyword(keyword: string): any[];
};

export type SemanticEvidenceLocation = {
    evidenceId: string;
    manualId: string;
    page: number | null;
    sourceProfileId?: string;
};

export type KeywordOptionSlotAdvice = {
    ruleId: string;
    slot: string;
    slotOrder: number | null;
    required: boolean;
    summary: string;
    evidence: SemanticEvidenceLocation[];
};

export type CardApplicability =
    | 'required'
    | 'optional'
    | 'applicable'
    | 'not-applicable'
    | 'indeterminate'
    | 'informational';

export type CardPresenceAdvice = {
    ruleId: string;
    card: string;
    presence: string;
    applicability: CardApplicability;
    predicateState: TriState | null;
    when: any | null;
    repeat: any | null;
    prerequisite: any | null;
    ordering: any | null;
    summary: string;
    evidence: SemanticEvidenceLocation[];
};

export type KeywordSemanticAdvice = {
    keyword: string;
    optionSlots: KeywordOptionSlotAdvice[];
    cards: CardPresenceAdvice[];
};

export type FieldChoiceValueAdvice = {
    value: number | string;
    valueText: string;
    role: string;
};

export type FieldChoiceAdvice = {
    keyword: string;
    field: string;
    ruleId: string;
    summary: string;
    choices: FieldChoiceValueAdvice[];
    domainKind: 'closed' | 'mixed';
    domainComplete: boolean;
    automatic: boolean;
    evidence: SemanticEvidenceLocation[];
};

function collectPredicateFields(predicate: any, output: Set<string>): void {
    if (!predicate || typeof predicate !== 'object') return;
    if (typeof predicate.field === 'string' && predicate.field.trim()) {
        output.add(predicate.field.trim().toUpperCase());
    }
    for (const child of Array.isArray(predicate.all) ? predicate.all : []) {
        collectPredicateFields(child, output);
    }
    for (const child of Array.isArray(predicate.any) ? predicate.any : []) {
        collectPredicateFields(child, output);
    }
    if (predicate.not) collectPredicateFields(predicate.not, output);
}

export function predicateFieldsForCardAdvice(cards: CardPresenceAdvice[]): string[] {
    const fields = new Set<string>();
    for (const card of cards || []) collectPredicateFields(card.when, fields);
    return [...fields].sort();
}

function finiteChoiceValue(branch: any): FieldChoiceValueAdvice | null {
    const when = branch?.when;
    if (!when || typeof when !== 'object' || when.op !== 'eq' ||
        Object.keys(when).some(key => !['op', 'value'].includes(key))) {
        return null;
    }
    const value = when.value;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const valueText = String(value).trim();
    if (!valueText || valueText.length > 80) return null;
    const role = String(branch.role || 'unknown').trim().toLowerCase();
    return { value, valueText, role };
}

/** Builds completion-safe documented values from one conflict-free field selector. */
export function fieldChoiceAdviceFromRules(rules: any[]): FieldChoiceAdvice | null {
    const candidates = (rules || []).filter(rule =>
        rule?.kind === 'field-choice' && rule?.relation?.kind === 'field-choice'
    );
    if (candidates.length !== 1) return null;
    const rule = candidates[0];
    const branches = Array.isArray(rule.relation.branches) ? rule.relation.branches : [];
    const choices: FieldChoiceValueAdvice[] = [];
    const seen = new Set<string>();
    for (const branch of branches) {
        const choice = finiteChoiceValue(branch);
        if (!choice) continue;
        // Completion labels are textual. Numeric 1 and string "1" would be two
        // indistinguishable edits, so treat them as a conflict instead of showing
        // duplicate choices with potentially different meanings.
        const identity = choice.valueText.toUpperCase();
        if (seen.has(identity)) return null;
        seen.add(identity);
        choices.push(choice);
    }
    if (choices.length === 0) return null;
    // Automatic suggestions must be a small, closed set of documented equality
    // branches. If the manual also defines ranges, literals, or references, the
    // finite values are still useful on explicit Ctrl+Space but are not presented
    // as an automatic enum-like list.
    const domainComplete = branches.length === choices.length &&
        choices.every(choice => choice.role === 'enum' || choice.role === 'sentinel');
    const domainKind = domainComplete ? 'closed' : 'mixed';
    const automatic = domainComplete && choices.length <= 12;
    return {
        keyword: normalizeSemanticKeyword(rule.keyword),
        field: String(rule.field || rule.selector?.fieldName || '').trim().toUpperCase(),
        ruleId: String(rule.ruleId || ''),
        summary: String(rule.summary || ''),
        choices,
        domainKind,
        domainComplete,
        automatic,
        evidence: evidenceLocations(rule),
    };
}

function evidenceLocations(rule: any): SemanticEvidenceLocation[] {
    const locations: SemanticEvidenceLocation[] = [];
    for (const item of Array.isArray(rule?.evidence) ? rule.evidence : []) {
        const candidates = Array.isArray(item?.locations) && item.locations.length > 0
            ? item.locations
            : [item];
        for (const candidate of candidates) {
            const sourceProfileId = String(
                candidate?.sourceProfileId || item?.sourceProfileId || '',
            );
            locations.push({
                evidenceId: String(item?.evidenceId || candidate?.evidenceId || ''),
                manualId: String(candidate?.manualId || item?.manualId || ''),
                page: Number.isInteger(candidate?.page)
                    ? candidate.page
                    : Number.isInteger(item?.page) ? item.page : null,
                ...(sourceProfileId ? { sourceProfileId } : {}),
            });
        }
    }
    return locations;
}

function optionSlotOrder(slot: string): number | null {
    const match = /^OPTION([1-9][0-9]*)$/.exec(slot);
    return match ? Number(match[1]) : null;
}

function compareOptionSlots(left: KeywordOptionSlotAdvice, right: KeywordOptionSlotAdvice): number {
    if (left.slotOrder !== null && right.slotOrder !== null) {
        return left.slotOrder - right.slotOrder || left.ruleId.localeCompare(right.ruleId);
    }
    if (left.slotOrder !== null) return -1;
    if (right.slotOrder !== null) return 1;
    return left.slot.localeCompare(right.slot) || left.ruleId.localeCompare(right.ruleId);
}

function optionAdvice(rule: any): KeywordOptionSlotAdvice | null {
    const relation = rule?.relation;
    if (rule?.kind !== 'keyword-option' || relation?.kind !== 'keyword-option') return null;
    const slot = String(relation.optionSlot || '').trim().toUpperCase();
    if (!slot) return null;
    return {
        ruleId: String(rule.ruleId || ''),
        slot,
        slotOrder: optionSlotOrder(slot),
        required: relation.required === true,
        summary: String(rule.summary || ''),
        evidence: evidenceLocations(rule),
    };
}

function conditionalApplicability(state: TriState): CardApplicability {
    return state === 'true'
        ? 'applicable'
        : state === 'false'
            ? 'not-applicable'
            : 'indeterminate';
}

function cardAdvice(rule: any, context: PredicateContext): CardPresenceAdvice | null {
    const relation = rule?.relation;
    if (rule?.kind !== 'card-presence' || relation?.kind !== 'card-presence') return null;
    const presence = String(relation.presence || 'unspecified').trim().toLowerCase();
    const when = relation.when && typeof relation.when === 'object' ? relation.when : null;
    const predicateState = presence === 'conditional'
        ? when ? evaluatePredicate(when, context) : 'indeterminate'
        : null;
    const applicability: CardApplicability = presence === 'conditional'
        ? conditionalApplicability(predicateState as TriState)
        : presence === 'required'
            ? 'required'
            : presence === 'optional'
                ? 'optional'
                : 'informational';

    return {
        ruleId: String(rule.ruleId || ''),
        card: String(relation.card || rule.card || '').trim(),
        presence,
        applicability,
        predicateState,
        when,
        repeat: relation.repeat && typeof relation.repeat === 'object' ? relation.repeat : null,
        prerequisite: relation.prerequisite && typeof relation.prerequisite === 'object'
            ? relation.prerequisite
            : null,
        ordering: relation.ordering && typeof relation.ordering === 'object' ? relation.ordering : null,
        summary: String(rule.summary || ''),
        evidence: evidenceLocations(rule),
    };
}

/**
 * Supplements missing native decisions with published manual advice.
 *
 * The caller must supply the exact catalog keyword. This layer deliberately does not
 * infer families from prefixes (for example CONTACT_*) or turn LS-PrePost option lists
 * into solver semantics. Unknown and parameterized predicates remain indeterminate.
 */
export function getKeywordSemanticAdvice(
    keyword: string,
    context: PredicateContext = {},
    catalog: SemanticCatalog = getManualSemanticCatalog(),
): KeywordSemanticAdvice {
    const normalizedKeyword = normalizeSemanticKeyword(keyword);
    if (!normalizedKeyword) {
        return { keyword: '', optionSlots: [], cards: [] };
    }
    const name = normalizedKeyword.replace(/^\*/, '');
    const native = require("./catalogNativeFileLayout");
    const form = require("./catalogInputFormCatalogV4").getCatalogInputFormCatalogV4()
        .formForKeyword(native.nativeFileCatalogKeyword(name), false);
    const verifiedForm = form?.source?.datasetSha256 === native.NATIVE_FILE_SOURCE && !form.source.isUnauditedDiagnostic ? form : null;
    const { nativeCoversCondition, nativeCoversOptionSlot } = require('./nativeRuleCoverage');
    const rules = catalog.rulesForKeyword(normalizedKeyword);
    const optionSlots = rules.filter(rule => !nativeCoversOptionSlot(verifiedForm, rule.relation?.optionSlot))
        .map(optionAdvice)
        .filter((item): item is KeywordOptionSlotAdvice => item !== null)
        .sort(compareOptionSlots);
    const cards = rules.filter(rule => !nativeCoversCondition(name, rule.relation?.when))
        .map(rule => cardAdvice(rule, context))
        .filter((item): item is CardPresenceAdvice => item !== null);

    return {
        keyword: normalizedKeyword,
        optionSlots,
        cards,
    };
}
