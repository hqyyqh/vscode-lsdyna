'use strict';

type NumericInput =
    | { kind: 'numeric'; raw: string; value: number }
    | { kind: 'parameter'; raw: string; name: string; negated: boolean }
    | { kind: 'expression'; raw: string }
    | { kind: 'blank'; raw: string }
    | { kind: 'invalid'; raw: string; reason: string };

type ParseNumericInputOptions = {
    integerOnly?: boolean;
    nonZero?: boolean;
    absoluteNumeric?: boolean;
};

const PARAMETER_PATTERN = /^(-?)&([A-Za-z_][A-Za-z0-9_-]{0,8})$/;
const INTEGER_PATTERN = /^[+-]?\d+(?:\.0*)?$/;
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/;

function parseNumericInput(rawValue, options: ParseNumericInputOptions = {}): NumericInput {
    const raw = String(rawValue ?? '').trim();
    if (!raw) {
        return { kind: 'blank', raw };
    }

    const parameterMatch = PARAMETER_PATTERN.exec(raw);
    if (parameterMatch) {
        return {
            kind: 'parameter',
            raw,
            name: parameterMatch[2],
            negated: parameterMatch[1] === '-',
        };
    }

    if (raw.startsWith('<') && raw.endsWith('>')) {
        return { kind: 'expression', raw };
    }

    const numericPattern = options.integerOnly === false ? NUMBER_PATTERN : INTEGER_PATTERN;
    if (!numericPattern.test(raw)) {
        return { kind: 'invalid', raw, reason: 'unsupported-numeric-input' };
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || (options.integerOnly !== false && !Number.isInteger(parsed))) {
        return { kind: 'invalid', raw, reason: 'non-finite-or-non-integer' };
    }
    if (options.nonZero && parsed === 0) {
        return { kind: 'invalid', raw, reason: 'zero-not-allowed' };
    }

    return {
        kind: 'numeric',
        raw,
        value: options.absoluteNumeric ? Math.abs(parsed) : parsed,
    };
}

function numericInputValue(input: NumericInput | null | undefined) {
    return input && input.kind === 'numeric' ? input.value : null;
}

function isUnresolvedNumericInput(input: NumericInput | null | undefined) {
    return !!input && input.kind !== 'numeric' && input.kind !== 'blank';
}

module.exports = {
    parseNumericInput,
    numericInputValue,
    isUnresolvedNumericInput,
};

export {};
