import { predicateFieldsForCardAdvice } from './manualSemanticAdvisor';

function stable(value: any): any {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function conditionLabel(predicate: any): string | null {
    if (!predicate || typeof predicate !== 'object') return null;
    for (const [key, operator] of [['all', ' ∧ '], ['any', ' ∨ ']]) {
        if (Array.isArray(predicate[key])) {
            const labels = predicate[key].map(conditionLabel);
            return labels.length && labels.every(Boolean) ? `(${labels.join(operator)})` : null;
        }
    }
    if (predicate.not) { const label = conditionLabel(predicate.not); return label ? `¬(${label})` : null; }
    const op = { eq: '=', ne: '≠', lt: '<', le: '≤', gt: '>', ge: '≥' }[predicate.op];
    return op && typeof predicate.field === 'string' && ['number', 'string'].includes(typeof predicate.value)
        ? `${predicate.field} ${op} ${predicate.value}` : null;
}

/** Manual conditions stay separate from native GUI card ordinals and drafts. */
export function groupConditionalAdvice(advice: any): any[] {
    const groups = new Map<string, any>();
    for (const card of advice?.cards || []) {
        if (card.presence !== 'conditional') continue;
        const key = JSON.stringify(stable([card.when || card.ruleId, card.prerequisite, card.ordering, card.repeat]));
        let group = groups.get(key);
        if (!group) {
            group = { id: card.ruleId, condition: conditionLabel(card.when), fields: predicateFieldsForCardAdvice([card]),
                applicability: card.applicability, cards: [], summaries: [], evidence: [],
                unresolvedFields: advice?.unresolvedFields || [], reason: advice?.contextReason || null };
            groups.set(key, group);
        }
        if (group.applicability !== card.applicability) group.applicability = 'indeterminate';
        if (!group.cards.includes(card.card)) group.cards.push(card.card);
        if (!group.summaries.includes(card.summary)) group.summaries.push(card.summary);
        for (const evidence of card.evidence || []) {
            if (!group.evidence.some(item => item.evidenceId === evidence.evidenceId)) {
                group.evidence.push({ ...evidence, ruleId: card.ruleId });
            }
        }
    }
    return [...groups.values()];
}

/** Multiset subtraction preserves repeated native cards; comparing shared rows detects moves. */
export function nativeBranchSummary(current: number[], draft: number[]) {
    const subtract = (left: number[], right: number[]) => {
        const counts = new Map<number, number>();
        for (const value of right) counts.set(value, (counts.get(value) || 0) + 1);
        return left.filter(value => {
            const count = counts.get(value) || 0;
            if (!count) return true;
            counts.set(value, count - 1); return false;
        });
    };
    const added = subtract(draft, current), removed = subtract(current, draft);
    return { current, draft, added, removed,
        reordered: JSON.stringify(subtract(current, removed)) !== JSON.stringify(subtract(draft, added)) };
}
