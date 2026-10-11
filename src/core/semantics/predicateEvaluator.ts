export type TriState = 'true' | 'false' | 'indeterminate';

export type PredicateContext = {
    currentValue?: unknown;
    fields?: Map<string, unknown> | Record<string, unknown>;
    keywordOptions?: Set<string> | string[];
    keywordOptionSlots?: Map<string, unknown> | Record<string, unknown>;
    version?: string;
    solverMode?: string;
};

type Comparable =
    | { state: 'known'; value: number | string; blank: boolean }
    | { state: 'indeterminate' };

function normalizeName(value: unknown): string {
    return String(value || '').trim().toUpperCase();
}

function lookupCollection(collection: Map<string, unknown> | Record<string, unknown> | undefined, name: string): { found: boolean; value?: unknown } {
    if (!collection) return { found: false };
    const normalized = normalizeName(name);
    if (collection instanceof Map) {
        if (collection.has(normalized)) return { found: true, value: collection.get(normalized) };
        for (const [key, value] of collection) {
            if (normalizeName(key) === normalized) return { found: true, value };
        }
        return { found: false };
    }
    for (const [key, value] of Object.entries(collection)) {
        if (normalizeName(key) === normalized) return { found: true, value };
    }
    return { found: false };
}

function comparable(raw: unknown): Comparable {
    if (raw === null || raw === undefined) return { state: 'known', value: '', blank: true };
    if (typeof raw === 'number') {
        return Number.isFinite(raw)
            ? { state: 'known', value: raw, blank: false }
            : { state: 'indeterminate' };
    }
    const text = String(raw).trim();
    if (!text) return { state: 'known', value: '', blank: true };
    if (/^-?&[A-Z_][A-Z0-9_-]*$/i.test(text) || /[&{}()[\]+*/^]/.test(text)) {
        return { state: 'indeterminate' };
    }
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return { state: 'known', value: numeric, blank: false };
    return { state: 'known', value: text.toUpperCase(), blank: false };
}

function triNot(value: TriState): TriState {
    return value === 'true' ? 'false' : value === 'false' ? 'true' : 'indeterminate';
}

function triAll(values: TriState[]): TriState {
    if (values.some(value => value === 'false')) return 'false';
    return values.some(value => value === 'indeterminate') ? 'indeterminate' : 'true';
}

function triAny(values: TriState[]): TriState {
    if (values.some(value => value === 'true')) return 'true';
    return values.some(value => value === 'indeterminate') ? 'indeterminate' : 'false';
}

function optionSet(context: PredicateContext): Set<string> {
    return new Set([...(context.keywordOptions || [])].map(normalizeName).filter(Boolean));
}

function evaluateKeywordOptionPredicate(predicate: any, context: PredicateContext): TriState | null {
    if (predicate.keywordOption) {
        if (predicate.op !== 'present') return 'indeterminate';
        if (!context.keywordOptions) return 'indeterminate';
        return optionSet(context).has(normalizeName(predicate.keywordOption)) ? 'true' : 'false';
    }
    if (predicate.keywordOptionSlot) {
        if (!context.keywordOptionSlots) return 'indeterminate';
        const slot = normalizeName(predicate.keywordOptionSlot);
        if (slot === 'ANY') {
            const values = context.keywordOptionSlots instanceof Map
                ? [...context.keywordOptionSlots.values()]
                : Object.values(context.keywordOptionSlots);
            if (values.length === 0) return 'indeterminate';
            const anyBlank = values.some(value => {
                const item = comparable(value);
                return item.state === 'known' && item.blank;
            });
            return predicate.op === 'blank'
                ? anyBlank ? 'true' : 'false'
                : 'indeterminate';
        }
        const found = lookupCollection(context.keywordOptionSlots, slot);
        if (!found.found) return 'indeterminate';
        const value = comparable(found.value);
        if (value.state === 'indeterminate') return 'indeterminate';
        if (predicate.op === 'blank') return value.blank ? 'true' : 'false';
        if (predicate.op === 'nonblank') return value.blank ? 'false' : 'true';
        return 'indeterminate';
    }
    return null;
}

function sameValue(left: number | string, right: unknown): boolean | null {
    const comparableRight = comparable(right);
    if (comparableRight.state === 'indeterminate') return null;
    if (typeof left === 'number' && typeof comparableRight.value === 'number') {
        return left === comparableRight.value;
    }
    return String(left).toUpperCase() === String(comparableRight.value).toUpperCase();
}

export function evaluatePredicate(predicate: any, context: PredicateContext = {}): TriState {
    if (!predicate || typeof predicate !== 'object') return 'indeterminate';
    if (Array.isArray(predicate.all)) {
        return triAll(predicate.all.map((child: any) => evaluatePredicate(child, context)));
    }
    if (Array.isArray(predicate.any)) {
        return triAny(predicate.any.map((child: any) => evaluatePredicate(child, context)));
    }
    if (predicate.not) return triNot(evaluatePredicate(predicate.not, context));

    const optionResult = evaluateKeywordOptionPredicate(predicate, context);
    if (optionResult) return optionResult;

    let rawValue = context.currentValue;
    if (predicate.field) {
        const found = lookupCollection(context.fields, predicate.field);
        if (!found.found) return 'indeterminate';
        rawValue = found.value;
    }
    const input = comparable(rawValue);
    if (input.state === 'indeterminate') return 'indeterminate';
    const op = String(predicate.op || '').toLowerCase();
    if (op === 'blank') return input.blank ? 'true' : 'false';
    if (op === 'nonblank' || op === 'present') return input.blank ? 'false' : 'true';
    if (input.blank) return 'indeterminate';

    if (op === 'in' || op === 'not-in') {
        if (!Array.isArray(predicate.values)) return 'indeterminate';
        let matched = false;
        for (const candidate of predicate.values) {
            const result = sameValue(input.value, candidate);
            if (result === null) return 'indeterminate';
            if (result) matched = true;
        }
        return (op === 'in' ? matched : !matched) ? 'true' : 'false';
    }

    const right = comparable(predicate.value);
    if (right.state === 'indeterminate' || right.blank) return 'indeterminate';
    if (op === 'eq' || op === 'ne') {
        const matched = sameValue(input.value, right.value);
        if (matched === null) return 'indeterminate';
        return (op === 'eq' ? matched : !matched) ? 'true' : 'false';
    }
    if (typeof input.value !== 'number' || typeof right.value !== 'number') {
        return 'indeterminate';
    }
    const matched = op === 'gt' ? input.value > right.value
        : op === 'ge' ? input.value >= right.value
            : op === 'lt' ? input.value < right.value
                : op === 'le' ? input.value <= right.value
                    : null;
    return matched === null ? 'indeterminate' : matched ? 'true' : 'false';
}

export function selectSemanticBranch(branches: any[], context: PredicateContext = {}): any {
    const evaluations = (branches || []).map(branch => ({
        branch,
        state: evaluatePredicate(branch.when, context),
    }));
    const matches = evaluations.filter(item => item.state === 'true');
    if (matches.length > 1) {
        return { state: 'indeterminate', reason: 'overlapping-branches', evaluations };
    }
    if (evaluations.some(item => item.state === 'indeterminate')) {
        return { state: 'indeterminate', reason: 'predicate-indeterminate', evaluations };
    }
    if (matches.length === 1) {
        return { state: 'resolved', branch: matches[0].branch, evaluations };
    }
    return { state: 'unmatched', evaluations };
}

export function applyReferenceIdTransform(rawValue: unknown, transform: string = 'identity'): number | null {
    const input = comparable(rawValue);
    if (input.state !== 'known' || input.blank || typeof input.value !== 'number' ||
        !Number.isSafeInteger(input.value)) {
        return null;
    }
    const transformed = transform === 'abs' ? Math.abs(input.value)
        : transform === 'negate' ? -input.value
            : transform === 'identity' ? input.value
                : Number.NaN;
    return transformed > 0 ? transformed : null;
}

export function resolveValueRole(relation: any, rawValue: unknown, context: PredicateContext = {}): any {
    const effectiveContext = { ...context, currentValue: rawValue };
    const branches = Array.isArray(relation?.branches) ? relation.branches : [];
    if (branches.length === 0) {
        return {
            state: 'resolved',
            role: relation?.kind === 'entity-reference' ? 'reference' : relation?.otherwise || 'unknown',
            targetKinds: relation?.targetKinds || (relation?.targetKind ? [relation.targetKind] : []),
            targetKeywords: relation?.targetKeywords || [],
            ...(relation?.targetSearch ? { targetSearch: relation.targetSearch } : {}),
            idTransform: relation?.idTransform || 'identity',
        };
    }
    const selection = selectSemanticBranch(branches, effectiveContext);
    if (selection.state === 'resolved') {
        return {
            ...selection,
            role: selection.branch.role || 'unknown',
            targetKinds: selection.branch.targetKinds || relation?.targetKinds ||
                (relation?.targetKind ? [relation.targetKind] : []),
            targetKeywords: selection.branch.targetKeywords || relation?.targetKeywords || [],
            ...(selection.branch.targetSearch || relation?.targetSearch
                ? { targetSearch: selection.branch.targetSearch || relation.targetSearch } : {}),
            idTransform: selection.branch.idTransform || 'identity',
        };
    }
    if (selection.state === 'unmatched') {
        return {
            ...selection,
            state: 'resolved',
            role: relation?.otherwise || 'unknown',
            targetKinds: [],
            targetKeywords: [],
        };
    }
    return selection;
}
