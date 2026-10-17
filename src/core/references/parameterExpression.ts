/** Bounded LS-DYNA numeric expressions; bindings are already evaluated at their definition. */
import { EntityQueryCache } from './entityQueryCache';
export type ParameterNumber = { value: number; valueState: 'integer' | 'real'; dependencyDepth?: number };
export type ParameterExpressionResult = ({ resolved: true } & ParameterNumber) | { resolved: false; reason: string };

const LIMITS = { bytes: 16 * 1024, nodes: 4096, depth: 64, bindings: 4096, operations: 100000 };
const nearest = (value: number) => Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
const cache = new EntityQueryCache(16 * 1024 * 1024);

export function evaluateParameterExpression(source: string, lookup: (name: string) => any,
    options: { self?: string; token?: { isCancellationRequested: boolean } } = {}): ParameterExpressionResult {
    let offset = 0, nodes = 0, operations = 0, dependencyDepth = 0;
    const names = new Set<string>();
    const dependencies = new Map<string, any>();
    const fail = (reason: string): never => { throw new Error(reason); };
    const step = (depth: number) => {
        if (options.token?.isCancellationRequested) fail('parameter-evaluation-cancelled');
        if (++operations > LIMITS.operations || depth > LIMITS.depth) fail('parameter-evaluation-budget');
    };
    const numeric = (value: number, integer: boolean): ParameterNumber => {
        if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) fail('parameter-value-unsafe');
        return { value, valueState: integer ? 'integer' : 'real' };
    };
    const space = () => { while (/\s/.test(source[offset] || '') && offset < source.length) offset++; };
    const take = (token: string) => { space(); if (source.startsWith(token, offset)) { offset += token.length; return true; } return false; };
    const call = (name: string, args: ParameterNumber[]): ParameterNumber => {
        const binary = ['atan2', 'min', 'max', 'mod', 'sign'].includes(name);
        if (args.length !== (binary ? 2 : 1)) fail('parameter-expression-unsupported');
        const a = args[0].value, b = args[1]?.value;
        const integer = args.every(arg => arg.valueState === 'integer');
        switch (name) {
            case 'abs': return numeric(Math.abs(a), integer);
            case 'min': return numeric(Math.min(a, b), integer);
            case 'max': return numeric(Math.max(a, b), integer);
            case 'sign': return numeric((b < 0 ? -1 : 1) * Math.abs(a), args[0].valueState === 'integer');
            case 'mod': return numeric(nearest(a) % nearest(b), true);
            case 'int': return numeric(Math.trunc(a), true);
            case 'aint': return numeric(Math.trunc(a), false);
            case 'nint': return numeric(nearest(a), true);
            case 'anint': return numeric(nearest(a), false);
            case 'float': return numeric(a, false);
            case 'csc': return numeric(1 / Math.sin(a), false);
            case 'sec': return numeric(1 / Math.cos(a), false);
            case 'ctn': return numeric(1 / Math.tan(a), false);
            case 'atan2': return numeric(Math.atan2(a, b), false);
            default: {
                const functions: Record<string, (value: number) => number> = {
                    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
                    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh,
                    atanh: Math.atanh, sqrt: Math.sqrt, exp: Math.exp, log: Math.log, log10: Math.log10,
                };
                if (!Object.hasOwnProperty.call(functions, name)) fail('parameter-expression-unsupported');
                return numeric(functions[name](a), false);
            }
        }
    };
    function atom(depth: number): ParameterNumber {
        step(depth); space();
        if (++nodes > LIMITS.nodes) fail('parameter-evaluation-budget');
        if (take('(')) {
            const result = expression(0, depth + 1);
            if (!take(')')) fail('parameter-expression-unsupported');
            return result;
        }
        const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eEdD][+-]?\d+)?/.exec(source.slice(offset));
        if (number) {
            offset += number[0].length;
            return numeric(Number(number[0].replace(/[dD]/, 'e')), !/[.eEdD]/.test(number[0]));
        }
        const explicit = take('&');
        const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(offset));
        if (!identifier) fail('parameter-expression-unsupported');
        offset += identifier[0].length;
        const name = identifier[0];
        if (!explicit && name.toLowerCase() === 'pi') return numeric(Math.PI, false);
        if (!explicit && take('(')) {
            const args: ParameterNumber[] = [];
            if (!take(')')) {
                do {
                    if (args.length >= 2) fail('parameter-expression-unsupported');
                    args.push(expression(0, depth + 1));
                } while (take(','));
                if (!take(')')) fail('parameter-expression-unsupported');
            }
            return call(name.toLowerCase(), args);
        }
        const normalized = name.toUpperCase();
        names.add(normalized);
        if (names.size > LIMITS.bindings) fail('parameter-evaluation-budget');
        const binding = lookup(normalized);
        dependencies.set(normalized, binding);
        if (!binding) fail(normalized === options.self ? 'parameter-cycle' : 'parameter-undefined');
        if (!['integer', 'real'].includes(binding.valueState)) fail(binding.reason || 'parameter-unresolved');
        dependencyDepth = Math.max(dependencyDepth, 1 + (binding.dependencyDepth || 0));
        if (dependencyDepth > LIMITS.depth) fail('parameter-evaluation-budget');
        return numeric(binding.value, binding.valueState === 'integer');
    }
    function expression(minimum: number, depth: number): ParameterNumber {
        step(depth); space();
        let left: ParameterNumber;
        // LS-DYNA R17, PARAMETER 36-9: unary signs bind before exponentiation.
        if (take('+')) left = expression(4, depth + 1);
        else if (take('-')) { const arg = expression(4, depth + 1); left = numeric(-arg.value, arg.valueState === 'integer'); }
        else left = atom(depth);
        for (;;) {
            space();
            const operator = source.startsWith('**', offset) ? '**' : source[offset];
            const priority = operator === '**' ? 3 : operator === '*' || operator === '/' ? 2 : operator === '+' || operator === '-' ? 1 : 0;
            if (!priority || priority < minimum) break;
            offset += operator.length;
            const right = expression(priority + (operator === '**' ? 0 : 1), depth + 1);
            const integer = left.valueState === 'integer' && right.valueState === 'integer';
            const a = left.value, b = right.value;
            const value = operator === '+' ? a + b : operator === '-' ? a - b : operator === '*' ? a * b
                : operator === '/' ? a / b : a ** b;
            left = numeric(integer ? Math.trunc(value) : value, integer);
        }
        return left;
    }
    try {
        if (Buffer.byteLength(source, 'utf8') > LIMITS.bytes) fail('parameter-evaluation-budget');
        if (options.token?.isCancellationRequested) fail('parameter-evaluation-cancelled');
        const cached = cache.get(source);
        if (cached && cached.dependencies.every(([name, binding]) => lookup(name) === binding)) return cached.result;
        const value = expression(0, 0); space();
        if (offset !== source.length) fail('parameter-expression-unsupported');
        const result = { resolved: true as const, ...value, dependencyDepth };
        cache.set(source, { result, dependencies: [...dependencies] });
        return result;
    } catch (error) {
        return { resolved: false, reason: error instanceof Error ? error.message : 'parameter-expression-unsupported' };
    }
}
