'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const api = require('../out/extension')._internals;
const { documentFor, editorFor } = require('./keyword-manager/conditional-fixtures.cjs')({ vscode, generateCommentLine: api.generateCommentLine });
const { specimen } = require('./keyword-manager/comment-fixture.cjs');
function build(lines, drafts = {}) { return api.buildKeywordOptionViewModel(editorFor(documentFor(lines)), 1, { fieldDrafts: drafts }); }
function semantic(model) {
    const view = api.buildKeywordOptionsViewState(model);
    return { status: model.plan.status, reason: model.plan.reason, canApply: view.canApply,
        cards: model.managerCards.map(card => ({ card: card.cardIndex, editable: card.editable,
            fields: card.fields.map(field => ({ id: field.fieldId, name: field.name, value: field.value, editable: field.editable })) })),
        diagnostics: (view.layoutDiagnostics || []).map(({ code, expectedRecords, actualRecords }) => ({ code, expectedRecords, actualRecords })),
        output: (model.plan.replacementRecords || []).map(record => record.text) };
}
describe('manager comments never confer layout or write authority', () => {
    it('keeps first-view fields, diagnostics and edit permissions identical before the directory is complete', () => {
        for (const format of ['standard', 'long', 'i10', 'comma']) for (const missing of [false, true]) {
            for (const comments of ['none', 'wrong', 'correct']) {
                const lines = specimen(missing, comments, format);
                const early = api.buildKeywordOptionViewModel(editorFor(documentFor(lines)), 1, { deferInstances: true });
                assert.equal(early.directoryStatus, 'loading');
                assert.deepEqual(semantic(early), semantic(build(lines)), `${format}/${missing}/${comments}`);
            }
        }
    });
    it('preserves empty physical data records and cannot repair missing source records through drafts', () => {
        const empty = build(specimen(false, 'none').map(line => line.trim() ? line : ''));
        assert.equal(empty.plan.status, 'no-change');
        assert.equal(empty.block.records.length, 11);
        assert.equal(empty.managerCards.length, 11);
        const missing = build(specimen(true, 'wrong'), { 'lspp-input:MAT_BARLAT_YLD2000:card:2:field:6': '0' });
        assert.equal(missing.plan.reason, 'lspp-input-form-source-layout-unresolved');
        const diagnostic = api.buildKeywordOptionsViewState(missing).layoutDiagnostics[0];
        assert.equal(diagnostic.expectedRecords, 11);
        assert.equal(diagnostic.actualRecords, 10);
    });
    it('does not let invalid control drafts change original record identity', () => {
        const original = build(specimen(false, 'none'));
        const invalid = build(specimen(false, 'none'), { 'lspp-input:MAT_BARLAT_YLD2000:card:2:field:6': '&MISSING' });
        assert.equal(invalid.plan.reason, 'lspp-input-form-field-draft-invalid');
        assert.equal(api.buildKeywordOptionsViewState(invalid).canApply, false);
        assert.deepEqual(invalid.currentLayout, original.currentLayout);
        assert.deepEqual(invalid.managerCards.map(card => card.fields.map(field => [field.fieldId, field.name, field.value])),
            original.managerCards.map(card => card.fields.map(field => [field.fieldId, field.name, field.value])));
    });
    it('matches Hover record and field identities and read windows in all supported read formats', () => {
        for (const format of ['standard', 'long', 'i10', 'comma']) for (const comments of ['none', 'wrong']) {
            const document = documentFor(specimen(false, comments, format));
            const model = api.buildKeywordOptionViewModel(editorFor(document), 1, {});
            for (const card of model.managerCards) {
                const hover = api.getCardInfoForDocumentLineWithSuggest(document, card.line).cardInfo;
                assert.equal(card.cardIndex, hover.nativeCardIndex);
                assert.deepEqual(card.fields.map(field => field.name), hover.card.map(field => field.n));
                for (const [index, field] of card.fields.entries()) {
                    const range = hover.card[index].nativeRange;
                    assert.ok(range, `${format}: ${card.cardIndex}/${field.name}`);
                    assert.equal(field.value, document.lineAt(card.line).text.slice(range.start, range.end).trim());
                }
            }
        }
    });
    it('keeps edits and conditional migrations invariant, including discarded values', () => {
        for (const drafts of [{ 'lspp-input:MAT_BARLAT_YLD2000:card:1:field:1': '7.85' },
            { 'lspp-input:MAT_BARLAT_YLD2000:card:1:field:4': '0' }]) {
            const models = ['none', 'correct', 'wrong'].map(comments => build(specimen(false, comments), drafts));
            for (const model of models) assert.equal(api.buildKeywordOptionsViewState(model).canApply, true);
            assert.deepEqual(semantic(models[0]), semantic(models[1]));
            assert.deepEqual(semantic(models[0]), semantic(models[2]));
        }
    });
    it('rejects the same ambiguous MAT_230 data regardless of field-header claims', () => {
        for (const header of ['', '$# MID RO E PR', '$# MID RO K VC', '$ 用户注释']) {
            const document = documentFor(['*MAT_230', ...(header ? [header] : []), '         1         1         2       0.3', '*END']);
            const model = api.buildKeywordOptionViewModel(editorFor(document), 0, {});
            assert.equal(model.plan.reason, 'lspp-input-form-source-layout-ambiguous');
            assert.equal(model.managerCards.length, 0);
            assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
        }
    });
    for (const format of ['standard', 'long', 'i10', 'comma']) for (const missing of [false, true])
        it(`${format}: ${missing ? 'missing' : 'complete'} records are invariant under misleading comments`, () => {
            const models = ['none', 'correct', 'wrong'].map(comments => build(specimen(missing, comments, format)));
            assert.deepEqual(semantic(models[1]), semantic(models[0]));
            assert.deepEqual(semantic(models[2]), semantic(models[0]));
            assert.equal(models[0].plan.status === 'blocked', missing || format === 'comma');
        });
    it('reports counts without claiming a missing-record location', () => {
        const model = build(specimen(true));
        const state = api.buildKeywordOptionsViewState(model);
        assert.equal(state.layoutDiagnostics[0].code, 'missing');
        assert.equal(state.layoutDiagnostics[0].expectedRecords, 11);
        assert.equal(state.layoutDiagnostics[0].actualRecords, 10);
        assert.ok(state.unresolvedRecords.length > 0);
        assert.ok(model.managerCards.every(card => card.editable === false));
        assert.ok(model.managerCards.every(card => card.cardIndex <= 2));
    });
});
module.exports = { specimen, semantic };
