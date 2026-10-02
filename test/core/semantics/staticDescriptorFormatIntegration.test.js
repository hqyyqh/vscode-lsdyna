'use strict';

const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock } = require("../../support/helpers");
const keywordSchema = require("../../../out/core/keywordSchema");
const {
    LsdynaFieldHoverProvider,
    fieldReferenceAtPosition,
    formatLineIfNeeded,
    getCardFieldsForLine,
    keywordManagerEditField,
} = require("../../../out/extension")._internals;

const schema = keywordSchema.loadKeywordSchema();
const hoverProvider = new LsdynaFieldHoverProvider();

function documentFor(keyword, line, suffix = '') {
    const uri = { scheme: 'file', fsPath: `/static-format/${keyword}${suffix}.k`,
        toString() { return `file://${this.fsPath}`; } };
    return {
        ...fakeDoc(`*${keyword}${suffix}\n${line}\n*END`, uri.fsPath),
        uri, version: 1, languageId: 'lsdyna', isDirty: true, isClosed: false,
    };
}

function resolve(document, geometryOnly = false) {
    const context = keywordSchema.readCardContext(document, 1, schema);
    assert.equal(context.status, 'resolved');
    return keywordSchema.resolveCardFromContext(context.context, schema, null, geometryOnly);
}

function hoverText(hover) {
    return (hover?.contents || []).map(item => item?.value ?? String(item)).join('\n');
}

const airbagCases = [
    { suffix: '', line: '  101  ,  1  ,,   , , , 2.5 , 3.75  ', reason: 'non-standard-input-format' },
    { suffix: '+', line: '101'.padStart(20) + '1'.padStart(20), reason: 'non-standard-input-format' },
    { suffix: '%', line: '101'.padStart(10) + '1'.padStart(10), reason: 'non-standard-input-format' },
];

describe('static descriptor production format boundary', () => {
    it('keeps the LS-PrePost native-dynamic AIRBAG counterexample closed in comma, LONG, and I10', async () => {
        for (const sample of airbagCases) {
            const document = documentFor('AIRBAG_ALE', sample.line, sample.suffix);
            assert.deepEqual(resolve(document), { status: 'unsupported', reason: sample.reason });
            const hover = await hoverProvider.provideHover(document,
                { line: 1, character: 1 }, { isCancellationRequested: false });
            assert.doesNotMatch(hoverText(hover), /\$\(symbol-field\)/);
            assert.equal(hover, null);
        }
    });

    it('does not turn comma whitespace, empty tokens, missing tails, or short fixed records into production authority', () => {
        for (const line of [' 101 , 1 , ,', '101,1,', '101,1']) {
            assert.deepEqual(resolve(documentFor('AIRBAG_ALE', line)),
                { status: 'unsupported', reason: 'non-standard-input-format' });
        }
        for (const [suffix, width] of [['+', 20], ['%', 10]]) {
            const short = '101'.padStart(width) + '1'.padStart(4);
            assert.deepEqual(resolve(documentFor('AIRBAG_ALE', short, suffix)),
                { status: 'unsupported', reason: 'non-standard-input-format' });
        }
    });

    it('does not let comma combined with LONG or I10 bypass the closed production path', () => {
        for (const suffix of ['+', '%']) {
            assert.deepEqual(resolve(documentFor('AIRBAG_ALE', '101,1', suffix)),
                { status: 'unsupported', reason: 'non-standard-input-format' });
        }
    });

    it('also fails closed for TITLE, repeat, and nonuniform layouts', async () => {
        const cases = [
            ['CONSTRAINED_BEAM_IN_SOLID_TITLE', 'title,bytes'],
            ['AIRBAG_SHELL_REFERENCE_GEOMETRY', '1,2'],
            ['AIRBAG_REFERENCE_GEOMETRY_BIRTH', '1,2'],
        ];
        for (const [keyword, line] of cases) {
            const document = documentFor(keyword, line);
            const result = resolve(document);
            assert.notEqual(result.status, 'resolved', keyword);
            const hover = await hoverProvider.provideHover(document,
                { line: 1, character: 0 }, { isCancellationRequested: false });
            assert.doesNotMatch(hoverText(hover), /\$\(symbol-field\)/, keyword);
        }
    });

    it('does not use descriptor display identity to grant geometry, formatting, editing, or references', async () => {
        for (const sample of airbagCases) {
            const document = documentFor('AIRBAG_ALE', sample.line, sample.suffix);
            const geometry = resolve(document, true);
            assert.deepEqual(geometry, { status: 'unsupported', reason: 'native-edit-binding-unverified' });
            assert.equal(getCardFieldsForLine(document, 1), null);
            assert.equal(fieldReferenceAtPosition(document, { line: 1, character: 1 }), null);

            const displayOnlyId = `AIRBAG_ALE:${sample.suffix || 'comma'}:display-only`;
            assert.equal(keywordManagerEditField({
                plan: { status: 'blocked', reason: 'static-format-edit-binding-unverified' },
                managerCards: [{ fields: [{ fieldId: displayOnlyId, editable: false }] }],
            }, displayOnlyId, '9'), null);

            const originalApplyEdit = vscodeMock.workspace.applyEdit;
            const edits = [];
            vscodeMock.workspace.applyEdit = edit => { edits.push(edit); return Promise.resolve(true); };
            try {
                await formatLineIfNeeded(document, 1);
            } finally {
                vscodeMock.workspace.applyEdit = originalApplyEdit;
            }
            assert.deepEqual(edits, []);
        }
    });
});
