'use strict';

import type { KeywordOptionGrammarV2, OptionTargetV2 } from '../semantics/semanticRuntimeV2';

export type OptionGrammarEvaluation = {
    state: 'exact' | 'invalid' | 'ambiguous' | 'read-only';
    target: OptionTargetV2 | null;
    candidates: OptionTargetV2[];
    reasons: string[];
};

export type OptionGrammarEvaluationOptions = {
    currentSpelling?: string;
};

function normalizedSelection(value: Record<string, string[] | string> = {}): Record<string, string[]> {
    return Object.fromEntries(Object.entries(value).map(([slot, values]) => [
        slot,
        (Array.isArray(values) ? values : [values]).map(item => String(item).toUpperCase()),
    ]));
}

function targetMatches(target: OptionTargetV2, selection: Record<string, string[]>): boolean {
    const targetSelection = (target as any).selection || {};
    const expectedBySlot: Record<string, string[]> = targetSelection.slots || {
        [String(targetSelection.slotId || 'official-concrete-spelling')]: targetSelection.values || [target.spelling],
    };
    const expectedSlots = Object.fromEntries(Object.entries(expectedBySlot).map(([slot, values]) => [
        slot, (values || []).map(value => String(value).toUpperCase()),
    ]));
    for (const [slot, expected] of Object.entries(expectedSlots)) {
        const observed = selection[slot] || [];
        if (observed.length !== expected.length || observed.some((value, index) => value !== expected[index])) return false;
    }
    return Object.keys(selection).every(slot => slot in expectedSlots || selection[slot].length === 0);
}

function targetCompatible(target: OptionTargetV2, selection: Record<string, string[]>): boolean {
    const targetSelection = (target as any).selection || {};
    const expectedBySlot: Record<string, string[]> = targetSelection.slots || {
        [String(targetSelection.slotId || 'official-concrete-spelling')]: targetSelection.values || [target.spelling],
    };
    return Object.entries(selection).every(([slot, observed]) => {
        if (observed.length === 0) return true;
        const expected = (expectedBySlot[slot] || []).map(value => String(value).toUpperCase());
        return observed.length <= expected.length && observed.every((value, index) => value === expected[index]);
    });
}

export function evaluateOptionGrammar(
    grammar: KeywordOptionGrammarV2 | null,
    selection: Record<string, string[] | string>,
    options: OptionGrammarEvaluationOptions = {},
): OptionGrammarEvaluation {
    if (!grammar || grammar.permissions?.display !== true) {
        return { state: 'invalid', target: null, candidates: [], reasons: ['option-grammar-unavailable'] };
    }
    const normalized = normalizedSelection(selection);
    const candidates = (grammar.targets || []).filter(target => targetMatches(target, normalized));
    if (candidates.length === 0) {
        const compatible = (grammar.targets || []).filter(target => targetCompatible(target, normalized));
        if (compatible.length > 0) {
            return { state: 'ambiguous', target: null, candidates: compatible, reasons: ['option-selection-incomplete'] };
        }
        return { state: 'invalid', target: null, candidates: [], reasons: ['illegal-option-selection'] };
    }
    if (candidates.length > 1) {
        const current = candidates.filter(target => String(target.spelling).toUpperCase() ===
            String(options.currentSpelling || '').toUpperCase());
        if (current.length === 1) return { state: 'exact', target: current[0], candidates, reasons: [] };
        const preferred = candidates.filter(target => target.preferredForSelection === true);
        if (preferred.length === 1) return { state: 'exact', target: preferred[0], candidates, reasons: [] };
        return { state: 'ambiguous', target: null, candidates, reasons: ['ambiguous-option-selection'] };
    }
    const [target] = candidates;
    return { state: 'exact', target, candidates, reasons: [] };
}

export class OptionGrammarEvaluator {
    evaluate(grammar: KeywordOptionGrammarV2 | null, selection: Record<string, string[] | string>,
        options: OptionGrammarEvaluationOptions = {}) {
        return evaluateOptionGrammar(grammar, selection, options);
    }
}

module.exports = { OptionGrammarEvaluator, evaluateOptionGrammar };
