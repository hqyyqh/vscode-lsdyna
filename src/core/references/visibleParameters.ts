import { performance } from 'node:perf_hooks';
const { parameterContextsForDocument } = require('./projectReferenceIndex');
const { throwIfCancellationRequested } = require('../scanner/scannerContracts');

export const parameterBindingId = (binding: any) => binding?.filePath && binding?.occurrenceId ? JSON.stringify([
    binding.filePath, binding.occurrenceId, binding.definitionLine, binding.sequence,
]) : null;

export function parameterQueryBudget(token?: any) {
    let work = 0, started = performance.now();
    return async () => {
        if (++work > 500000) throw Object.assign(new RangeError('Parameter scope exceeds budget'), { code: 'PARAMETER_QUERY_BUDGET' });
        if (work % 256) return;
        throwIfCancellationRequested(token);
        if (performance.now() - started >= 8) {
            await new Promise(resolve => setImmediate(resolve));
            started = performance.now();
        }
    };
}

/** Restore each occurrence once per request, never once per completion candidate. */
export async function visibleParameters(index: any, file: string, line: number, character: number, token?: any) {
    const contexts = parameterContextsForDocument(index, file);
    const reasons = new Set<string>(index.completenessReasons || []);
    const scopes: Map<string, any>[] = [];
    const step = parameterQueryBudget(token);
    throwIfCancellationRequested(token);
    if (!contexts.length) reasons.add('parameter-context-unavailable');
    for (const context of contexts) {
        await step();
        const bindings = new Map<string, any>();
        for (const [name, binding] of context.initialBindings || []) { await step(); bindings.set(name, binding); }
        for (const reason of context.initialUncertaintyReasons || []) reasons.add(reason);
        for (const point of context.timeline || []) {
            await step();
            const at = point.availableLine ?? point.lineIndex;
            if (at > line || at === line && (point.availableCharacter ?? 0) >= character) continue;
            for (const [name, binding] of point.updates || []) {
                await step();
                if (binding) bindings.set(name, binding); else bindings.delete(name);
            }
            for (const reason of point.uncertaintyReasons || []) reasons.add(reason);
        }
        scopes.push(bindings);
    }
    throwIfCancellationRequested(token);
    return { scopes, reasons: [...reasons] };
}

export async function parameterCompletionPage(index: any, file: string, line: number, character: number,
    prefix: string, token?: any) {
    const { scopes, reasons } = await visibleParameters(index, file, line, character, token);
    if (reasons.length) return { items: [], reasons, incomplete: true };
    const items = [];
    let incomplete = false;
    for (const [name, first] of scopes[0] || []) {
        if (!name.startsWith(prefix.toUpperCase()) || !scopes.every(scope => scope.has(name))) continue;
        if (items.length >= 200) { incomplete = true; break; }
        const bindings = scopes.map(scope => scope.get(name));
        if (bindings.some(binding => !parameterBindingId(binding)))
            return { items: [], reasons: ['parameter-definition-source-unavailable'], incomplete: true };
        const identity = parameterBindingId(first);
        const same = bindings.every(binding => parameterBindingId(binding) === identity);
        const numeric = same && ['integer', 'real'].includes(first.valueState) && Number.isFinite(first.value);
        items.push({ name, parameterType: bindings.every(binding => binding.parameterType === first.parameterType)
            ? first.parameterType : '?', value: numeric ? first.value : null,
            rawValue: same ? String(first.rawValue).slice(0, 512) : '',
            filePath: same ? first.filePath : null, line: same ? first.definitionLine : null,
            ambiguous: !same, reason: !same ? 'parameter-occurrence-ambiguous' : numeric ? null : first.reason });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { items, reasons, incomplete };
}
