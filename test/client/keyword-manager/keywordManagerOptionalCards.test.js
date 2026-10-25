'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const api = require('../../../out/extension')._internals;
const { nativeFormSelectors } = require('../../../out/core/semantics/nativeOptionalCards');
const { documentFor, editorFor } = require('../../support/keyword-manager/conditional-fixtures.cjs')({ vscode });
const build = (lines, value) => {
    const document = documentFor([...lines, '*END']);
    const model = api.buildKeywordOptionViewModel(editorFor(document), 0,
        value === undefined ? {} : { draftControlState: { 'optional-cards': value } });
    return { document, model, state: api.buildKeywordOptionsViewState(model) };
};

describe('native optional-card controls', () => {
    it('opens a keyword-only template with required cards and no optional card', () => {
        const { model } = build(['*DATABASE_BINARY_D3PLOT']);
        assert.equal(model.controls.find(control => control.controlId === 'optional-cards').value, '');
        assert.equal(model.managerCards.length, 1);
        assert.equal(model.plan.replacementRecords.length, 1);
    });
    it('rejects parser-only suffixes while retaining evidenced prefix cards and explicit controls', () => {
        const selector = { controlId: 'suffix', values: [{ value: 'ID', cards: [] }, { value: 'TITLE', cards: [{}] }] };
        assert.deepEqual(nativeFormSelectors({ ownerDefinitionFile: 'native-spelling:DATABASE', selectors: [selector] })[0].values,
            [{ value: 'TITLE', cards: [{}] }]);
        assert.deepEqual(nativeFormSelectors({ ownerDefinitionFile: 'native-gui', selectors: [selector] }), [selector]);
    });
    it('projects all cardinalities for a native control with more than one optional card', () => {
        for (const value of ['', '1', '2']) {
            const { model } = build(['*ALE_INJECTION', '         1'], value);
            const control = model.controls.find(control => control.controlId === 'optional-cards');
            assert.deepEqual(control.choices.map(choice => choice.value), ['1', '2']);
            assert.equal(model.managerCards.length, 1 + Number(value));
            assert.equal(model.plan.status, value ? 'ready' : 'no-change', model.plan.reason);
        }
    });
    for (const keyword of ['DATABASE_BINARY_D3PLOT', 'DATABASE_BINARY_D3PART', 'DATABASE_BINARY_D3DUMP']) {
        it(`${keyword}: keeps None unchanged and adds only the requested optional card`, () => {
            const lines = ['*' + keyword, '     0.005'];
            const before = build(lines);
            assert.deepEqual(before.model.controls.map(control => control.controlId), ['optional-cards']);
            assert.equal(before.model.controls[0].value, '');
            assert.equal(before.model.controls[0].visible, true);
            assert.equal(before.model.controls[0].choices[0].enabled, true);
            assert.equal(before.state.canApply, false);
            assert.equal(before.model.plan.replacementRecords.length, 1);
            const added = build(lines, '1');
            assert.equal(added.state.canApply, true, added.model.plan.reason);
            assert.equal(added.state.hasDrafts, true);
            assert.equal(added.model.targetKeyword, '*' + keyword);
            assert.equal(added.model.plan.replacementRecords.length, 2);
            assert.equal(added.model.plan.replacementRecords[0].text, lines[1]);
            assert.equal(added.model.managerCards.length, 2);
            const field = added.model.managerCards[1].fields[0];
            const edited = api.buildKeywordOptionViewModel(editorFor(added.document), 0, {
                draftControlState: { 'optional-cards': '1' }, selectedFieldId: field.fieldId,
                fieldDrafts: { [field.fieldId]: '2' },
            });
            assert.equal(edited.selectedInstanceId, before.model.selectedInstanceId);
            assert.equal(api.buildKeywordOptionsViewState(edited).canApply, true);
            assert.equal(edited.help.status, 'ready');
            assert.notEqual(edited.help.reason, 'branch-unverified');
        });
    }

    it('previews discarded values and preserves user comments when removing the optional card', () => {
        const lines = ['*DATABASE_BINARY_D3PLOT', '     0.005', '$ retain this note', '         2       0.1'];
        const before = build(lines);
        assert.equal(before.model.controls[0].value, '1');
        assert.equal(before.state.canApply, false);
        const removed = build(lines, '');
        assert.equal(removed.state.canApply, true, removed.model.plan.reason);
        assert.equal(removed.model.plan.requiresLossConfirmation, true);
        assert.equal(removed.state.preview.reviewLevel, 'destructive');
        assert.deepEqual(removed.model.plan.discardedFields.map(field => field.name), ['IOOPT', 'RATE']);
        const replacement = api.optionSwitchReplacement(removed.document, removed.model, removed.model);
        assert.ok(replacement.text.includes('$ retain this note'));
        assert.equal(removed.model.plan.replacementRecords.length, 1);
    });

    it('rejects forged cardinality and optional controls on unrelated keywords', () => {
        for (const value of ['2', '-1', '1.5', 'NaN']) {
            const result = build(['*DATABASE_BINARY_D3PLOT', '     0.005'], value);
            assert.equal(result.state.canApply, false, value);
        }
        const result = build(['*NODE', '1,0,0,0'], '1');
        assert.equal(result.state.canApply, false);
    });

    it('applies the optional-card draft through the guarded commit service', async () => {
        const { document, model } = build(['*DATABASE_BINARY_D3PLOT', '     0.005'], '1');
        const field = model.managerCards[1].fields[0];
        const editor = editorFor(document);
        const staged = api.buildKeywordOptionViewModel(editor, 0, {
            draftControlState: { 'optional-cards': '1' }, fieldDrafts: { [field.fieldId]: '2' },
        });
        const oldApply = vscode.workspace.applyEdit, oldEditor = vscode.window.activeTextEditor;
        let edits;
        vscode.window.activeTextEditor = editor;
        vscode.workspace.applyEdit = async edit => { edits = edit.edits; return true; };
        try { assert.ok(await api.applyKeywordOptionViewModel({ getModel: () => staged, markStale() {} }, editor)); }
        finally { vscode.workspace.applyEdit = oldApply; vscode.window.activeTextEditor = oldEditor; }
        assert.equal(edits.length, 1);
        const reopened = build(edits[0].text.trimEnd().split('\n'));
        assert.equal(reopened.model.controls[0].value, '1');
        assert.equal(reopened.model.managerCards[1].fields[0].value.trim(), '2');
    });
});
