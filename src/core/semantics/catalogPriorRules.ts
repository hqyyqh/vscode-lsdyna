/**
 * Precedence and prior scoring rules for LS-PrePost input form selector and layout resolution.
 *
 * Used by the keyword manager to break ties when resolving layouts from source lines
 * in the presence of ambiguous selectors (e.g. non-suffix card selectors like Contact A-G vs Thermal)
 * or multiple form rules with the same card count.
 */

export type SelectorPriorScoreResult = {
    score: number;
    reasons: string[];
};

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
        const hasId = /(?:^|_)(?:ID)(?:$|_)/.test(canonical) || canonical.endsWith('_ID');
        const hasTitle = /(?:^|_)(?:TITLE)(?:$|_)/.test(canonical) || canonical.endsWith('_TITLE');
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
            return ['', ...values];
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

        // A / ABCDEFG mechanical cards
        const hasCardLetterValue = values.some((v: string) => /^[A-G]+$/.test(v));
        if (hasCardLetterValue || label.includes('ABCDEFG')) {
            return ['', ...values];
        }
    }

    // 3. ICFD_MAT family selectors (A / AB)
    if (canonical.startsWith('ICFD_MAT')) {
        const hasAB = values.some((v: string) => v === 'A' || v === 'AB');
        if (hasAB) {
            return ['', ...values];
        }
    }

    // Default fallback: empty plus all declared values
    return ['', ...values];
}

/**
 * Resolves structural precedence / prior score for a candidate selector state.
 * Evaluates domain semantics to break ties when lexical evidence (comments) is equal or absent.

 *
 * Rules:
 * 1. *CONTACT_* family:
 *    - If keyword does not contain THERMAL:
 *      Leaving Thermal/T_Friction empty ("") earns high precedence (+100 points).
 *      Selecting Thermal/T_Friction when keyword is non-thermal earns 0 points.
 *    - If keyword contains THERMAL:
 *      Selecting Thermal earns precedence (+100 points).
 *    - If keyword does not contain MPP:
 *      Leaving MPP empty ("") earns precedence (+100 points).
 *    - Standard mechanical optional cards (A~G):
 *      Selecting standard mechanical cards for structural contact earns +50 points.
 * 2. *ICFD_MAT* family:
 *    - Natural alphabetical card order (A earns +50 points).
 */
export function resolveSelectorPriorScore(
    keyword: string,
    selections: Record<string, string>,
    selectors: any[],
): SelectorPriorScoreResult {
    const canonical = String(keyword || '').replace(/^\*/, '').toUpperCase();
    let score = 0;
    const reasons: string[] = [];

    const isContact = canonical.startsWith('CONTACT');
    const isThermalKeyword = canonical.includes('THERMAL');
    const isMppKeyword = canonical.includes('MPP');

    for (const selector of selectors || []) {
        const controlId = String(selector.controlId || '');
        const val = String(selections[controlId] || '');
        const values = (selector.values || []).map((v: any) => String(v.value || ''));

        if (isContact) {
            const hasThermalValue = values.some((v: string) => /thermal|t_friction/i.test(v));
            if (hasThermalValue) {
                if (!isThermalKeyword) {
                    if (!val) {
                        score += 100;
                        reasons.push('contact-non-thermal-empty-preferred');
                    }
                } else {
                    if (val) {
                        score += 100;
                        reasons.push('contact-thermal-active-preferred');
                    }
                }
            }

            const hasMppValue = values.some((v: string) => /mpp/i.test(v));
            if (hasMppValue) {
                if (!isMppKeyword) {
                    if (!val) {
                        score += 100;
                        reasons.push('contact-non-mpp-empty-preferred');
                    }
                } else {
                    if (val) {
                        score += 100;
                        reasons.push('contact-mpp-active-preferred');
                    }
                }
            }

            const hasCardLetterValue = values.some((v: string) => /^[A-G]+$/.test(v));
            if (hasCardLetterValue) {
                if (val) {
                    score += 50;
                    reasons.push(`contact-mechanical-cards-${val}`);
                }
            }
        } else if (canonical.startsWith('ICFD_MAT')) {
            if (val === 'A') {
                score += 50;
                reasons.push('icfd-mat-card-a-preferred');
            }
        }
    }

    return { score, reasons };
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
