'use strict';

const assert = require('assert');
const { fakeDoc, vscodeMock } = require('../../helpers');
const keywordValidator = require('../../../src/core/parser/keywordValidator');

// The validator needs a built-in keyword set injected via init(); the schema
// (field_data.json) is also consulted, but these tests rely only on the set so
// they stay independent of schema drift.
keywordValidator.init(new Set(['NODE', 'END', 'PART', 'SECTION_SHELL']));

function unknownDiagnostics(document) {
    return keywordValidator
        .collectKeywordValidationDiagnostics(document, () => false)
        .filter(d => d.code === 'unknown-keyword');
}

/**
 * Run `fn` with lsdyna config overrides applied to the shared vscode mock,
 * restoring the original getConfiguration afterwards. The default mock returns
 * each setting's own defaultValue, so only overridden keys need listing.
 */
function withConfig(overrides, fn) {
    const original = vscodeMock.workspace.getConfiguration;
    vscodeMock.workspace.getConfiguration = () => ({
        get: (key, defaultValue) =>
            Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : defaultValue,
    });
    try {
        return fn();
    } finally {
        vscodeMock.workspace.getConfiguration = original;
    }
}

function allDiagnostics(document) {
    return keywordValidator.collectKeywordValidationDiagnostics(document, () => false);
}

describe('keywordValidator *END awareness', () => {
    it('does not flag unknown keywords after a column-1 *END', () => {
        const doc = fakeDoc([
            '*NODE',
            '       1       0.0       0.0       0.0',
            '*END',
            '*MY_SCRATCH_NOTE',
            '*ANOTHER_RETIRED_BLOCK',
        ].join('\n'));

        const unknowns = unknownDiagnostics(doc).map(d => d.unknownKeyword);
        assert.deepStrictEqual(unknowns, []);
    });

    it('still flags unknown keywords before *END', () => {
        const doc = fakeDoc([
            '*NODE',
            '*BOGUS_BEFORE_END',
            '*END',
            '*BOGUS_AFTER_END',
        ].join('\n'));

        const unknowns = unknownDiagnostics(doc).map(d => d.unknownKeyword);
        assert.deepStrictEqual(unknowns, ['BOGUS_BEFORE_END']);
    });

    it('validates the *END line itself but nothing after it', () => {
        const doc = fakeDoc([
            '*NODE',
            '*END',
        ].join('\n'));
        // *END is a valid keyword (in the injected set), so no unknown diagnostic.
        assert.deepStrictEqual(unknownDiagnostics(doc).map(d => d.unknownKeyword), []);
    });

    it('treats an indented *END as data, not a terminator (strict column 1)', () => {
        const doc = fakeDoc([
            '*NODE',
            '   *END',
            '*BOGUS_AFTER_INDENTED_END',
        ].join('\n'));
        // The indented *END does not terminate, so the later bogus keyword is flagged.
        const unknowns = unknownDiagnostics(doc).map(d => d.unknownKeyword);
        assert.ok(unknowns.includes('BOGUS_AFTER_INDENTED_END'));
    });

    it('no *END: whole file still validated (regression)', () => {
        const doc = fakeDoc([
            '*NODE',
            '*BOGUS_ONE',
            '*BOGUS_TWO',
        ].join('\n'));
        const unknowns = unknownDiagnostics(doc).map(d => d.unknownKeyword).sort();
        assert.deepStrictEqual(unknowns, ['BOGUS_ONE', 'BOGUS_TWO']);
    });
});

describe('keywordValidator.findEndDirectiveLine', () => {
    it('returns the line of a column-1 *END', () => {
        const doc = fakeDoc(['*NODE', '*END', 'junk'].join('\n'));
        assert.strictEqual(keywordValidator.findEndDirectiveLine(doc), 1);
    });

    it('returns lineCount when no *END is present', () => {
        const doc = fakeDoc(['*NODE', '*PART'].join('\n'));
        assert.strictEqual(keywordValidator.findEndDirectiveLine(doc), 2);
    });

    it('ignores an indented *END', () => {
        const doc = fakeDoc(['*NODE', '   *END'].join('\n'));
        assert.strictEqual(keywordValidator.findEndDirectiveLine(doc), 2);
    });
});

describe('keywordValidator lowercase-keyword warning', () => {
    function lowercaseDiagnostics(document) {
        // Lowercase warnings are the non-error, non-unknown diagnostics.
        return allDiagnostics(document).filter(
            d => d.code !== 'unknown-keyword' && d.severity === vscodeMock.DiagnosticSeverity.Warning,
        );
    }

    it('does not warn on a lowercase keyword by default (opt-in off)', () => {
        const doc = fakeDoc(['*node', '       1       0.0       0.0       0.0'].join('\n'));
        const warnings = withConfig({}, () => lowercaseDiagnostics(doc));
        assert.deepStrictEqual(warnings, []);
    });

    it('warns on a lowercase keyword when warnLowercaseKeyword is enabled', () => {
        const doc = fakeDoc(['*node', '       1       0.0       0.0       0.0'].join('\n'));
        const warnings = withConfig({ warnLowercaseKeyword: true }, () => lowercaseDiagnostics(doc));
        assert.strictEqual(warnings.length, 1);
    });

    it('leaves ** invalid-format errors intact regardless of the lowercase switch', () => {
        const doc = fakeDoc(['**node'].join('\n'));
        const errors = withConfig({ warnLowercaseKeyword: false }, () =>
            allDiagnostics(doc).filter(d => d.severity === vscodeMock.DiagnosticSeverity.Error),
        );
        assert.strictEqual(errors.length, 1);
    });

    it('does not suppress unknown-keyword diagnostics when lowercase warning is off', () => {
        const doc = fakeDoc(['*BOGUS_KEYWORD'].join('\n'));
        const unknowns = withConfig({ warnLowercaseKeyword: false }, () =>
            allDiagnostics(doc).filter(d => d.code === 'unknown-keyword'),
        );
        assert.strictEqual(unknowns.length, 1);
    });
});
