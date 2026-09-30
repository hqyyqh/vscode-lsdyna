import type {
    DecodedField,
    StructureContext,
    StructurePredicate,
    TriState,
} from './types';

export type FieldEnvironment = Map<string, DecodedField[]>;

function invert(value: TriState): TriState {
    if (value === 'true') return 'false';
    if (value === 'false') return 'true';
    return 'unknown';
}

function scalarEqual(left: unknown, right: unknown): boolean {
    if (typeof left === 'number' && typeof right === 'number') return Object.is(left, right);
    if (typeof left === 'number' && typeof right === 'string' && right.trim() !== '') {
        const numeric = Number(right);
        return Number.isFinite(numeric) && Object.is(left, numeric);
    }
    if (typeof right === 'number' && typeof left === 'string' && left.trim() !== '') {
        const numeric = Number(left);
        return Number.isFinite(numeric) && Object.is(right, numeric);
    }
    return String(left).trim().toUpperCase() === String(right).trim().toUpperCase();
}

function resolvedField(
    name: string,
    fields: FieldEnvironment,
    context: StructureContext,
): { state: 'known' | 'blank' | 'unknown'; value?: unknown } {
    const normalized = String(name || '').trim().toUpperCase();
    const candidates = fields.get(normalized) || [];
    const known = candidates.filter(field => field.state === 'known').map(field => field.value);
    if (known.length > 0) {
        if (!known.every(value => scalarEqual(value, known[0]))) return { state: 'unknown' };
        return { state: 'known', value: known[0] };
    }
    if (candidates.length > 0 && candidates.every(field => field.state === 'blank')) {
        return { state: 'blank' };
    }
    if (candidates.some(field => field.state === 'invalid')) return { state: 'unknown' };
    const contextual = Object.entries(context.fields || {})
        .find(([key]) => key.trim().toUpperCase() === normalized);
    if (contextual) {
        const value = contextual[1];
        return value === null || value === undefined || String(value).trim() === ''
            ? { state: 'blank' }
            : { state: 'known', value };
    }
    if (candidates.length === 0 || candidates.some(field => field.state === 'parameter')) {
        return { state: 'unknown' };
    }
    return { state: 'unknown' };
}

function compare(
    op: string,
    actual: unknown,
    expected: unknown,
    expectedValues: unknown[],
): TriState {
    if (op === 'eq') return scalarEqual(actual, expected) ? 'true' : 'false';
    if (op === 'ne') return scalarEqual(actual, expected) ? 'false' : 'true';
    if (op === 'in') return expectedValues.some(value => scalarEqual(actual, value)) ? 'true' : 'false';
    if (op === 'not-in') return expectedValues.some(value => scalarEqual(actual, value)) ? 'false' : 'true';
    const left = Number(actual);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return 'unknown';
    if (op === 'gt') return left > right ? 'true' : 'false';
    if (op === 'ge') return left >= right ? 'true' : 'false';
    if (op === 'lt') return left < right ? 'true' : 'false';
    if (op === 'le') return left <= right ? 'true' : 'false';
    return 'unknown';
}

export function evaluatePredicate(
    predicate: StructurePredicate,
    fields: FieldEnvironment = new Map(),
    context: StructureContext = {},
): TriState {
    if (!predicate || typeof predicate !== 'object') return 'unknown';
    const op = String(predicate.op || '').toLowerCase();
    const children = Array.isArray(predicate.predicates) ? predicate.predicates : [];
    if (op === 'all') {
        const values = children.map(child => evaluatePredicate(child, fields, context));
        if (values.some(value => value === 'false')) return 'false';
        return values.every(value => value === 'true') ? 'true' : 'unknown';
    }
    if (op === 'any') {
        const values = children.map(child => evaluatePredicate(child, fields, context));
        if (values.some(value => value === 'true')) return 'true';
        return values.every(value => value === 'false') ? 'false' : 'unknown';
    }
    if (op === 'not') {
        const child = predicate.predicate || children[0];
        return child ? invert(evaluatePredicate(child, fields, context)) : 'unknown';
    }
    if (op === 'keyword-option') {
        const target = String(predicate.option ?? predicate.value ?? '').trim().toUpperCase();
        if (!target || !context.keywordOptions) return 'unknown';
        let values: unknown[];
        try {
            values = typeof context.keywordOptions === 'string'
                ? [context.keywordOptions]
                : [...context.keywordOptions];
        } catch (_error) {
            return 'unknown';
        }
        const options = new Set(values.map(value => String(value).trim().toUpperCase()));
        return options.has(target) ? 'true' : 'false';
    }
    if (op === 'version') {
        if (context.version === undefined) return 'unknown';
        return compare('eq', context.version, predicate.value, []);
    }
    if (op === 'solver-mode') {
        if (!context.solverMode) return 'unknown';
        return compare('eq', context.solverMode, predicate.value, []);
    }
    if (!predicate.field) return 'unknown';
    const resolved = resolvedField(predicate.field, fields, context);
    if (op === 'present') return resolved.state === 'unknown' ? 'unknown' : 'true';
    if (op === 'blank') {
        if (resolved.state === 'unknown') return 'unknown';
        return resolved.state === 'blank' ? 'true' : 'false';
    }
    if (op === 'nonblank') {
        if (resolved.state === 'unknown') return 'unknown';
        return resolved.state === 'known' ? 'true' : 'false';
    }
    if (resolved.state !== 'known') return 'unknown';
    const values = Array.isArray(predicate.values)
        ? predicate.values
        : predicate.value === undefined ? [] : [predicate.value];
    return compare(op, resolved.value, predicate.value, values);
}

export function mergeDecodedFields(matches: Array<{ decodedFields?: DecodedField[] }>): FieldEnvironment {
    const environment: FieldEnvironment = new Map();
    for (const match of matches) {
        for (const field of match.decodedFields || []) {
            const name = String(field.name || '').trim().toUpperCase();
            if (!name) continue;
            const existing = environment.get(name) || [];
            existing.push(field);
            environment.set(name, existing);
        }
    }
    return environment;
}

export const predicateInternals = { scalarEqual, resolvedField };
