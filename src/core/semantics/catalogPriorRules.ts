/**
 * Selector value constraints and form rule precedence for LS-PrePost layout resolution.
 */

/**
 * Returns the set of valid/legal selector values allowed by LS-DYNA / LS-PrePost grammar constraints.
 * Pre-pruning at the source eliminates cross-family invalid combinations (e.g. Thermal cards
 * in non-thermal contacts), guaranteeing exact mathematical determinism without comment dependence.
 */
export function getLegalSelectorValues(
    keyword: string,
    selector: any,
): string[] {
    const canonical = String(keyword || '').replace(/^\*/, '').toUpperCase();
    const values = (selector?.values || []).map((v: any) => String(v.value || ''));
    const label = String(selector?.label || selector?.controlId || '');
    const isContact = canonical.startsWith('CONTACT');

    // 1. ID / TITLE selector
    if (label.includes('ID') && label.includes('TITLE')) {
        const hasId = /(?:^|_)(?:ID)(?:$|_)/.test(canonical);
        const hasTitle = /(?:^|_)(?:TITLE)(?:$|_)/.test(canonical);
        if (hasId && values.includes('ID')) return ['ID'];
        if (hasTitle && values.includes('TITLE')) return ['TITLE'];
        return [''];
    }

    // 2. CONTACT family selectors
    if (isContact) {
        // Thermal / T_Friction
        const hasThermalValue = values.some((v: string) => /thermal|t_friction/i.test(v));
        if (hasThermalValue || label.includes('Thermal')) {
            const hasThermalFrictionKeyword = canonical.includes('THERMAL_FRICTION');
            const hasThermalKeyword = canonical.includes('THERMAL');
            if (hasThermalFrictionKeyword && values.includes('T_Friction')) {
                return ['T_Friction'];
            }
            if (hasThermalKeyword && values.includes('Thermal')) {
                return ['Thermal'];
            }
            return [''];
        }

        // MPP1 / MPP2
        const hasMppValue = values.some((v: string) => /mpp/i.test(v));
        if (hasMppValue || label.includes('MPP')) {
            const isMpp = canonical.includes('MPP');
            if (!isMpp) {
                return ['']; // Strictly pruned for non-MPP contacts!
            }
            return ['', ...values.filter((v: string) => /mpp/i.test(v))];
        }

    }

    // Default fallback: empty plus all declared values
    return ['', ...values];
}

/**
 * Resolves prior score for multi-form keyword candidates (e.g. MAT_036, MAT_230).
 * Baseline recommended form rule earns higher precedence.
 */
export function resolveFormRulePriorScore(
    _keyword: string,
    ruleId: string,
    candidateRuleIds: string[],
): number {
    const index = candidateRuleIds.indexOf(ruleId);
    if (index === 0) return 100;
    if (index > 0) return Math.max(0, 100 - index * 20);
    return 0;
}
