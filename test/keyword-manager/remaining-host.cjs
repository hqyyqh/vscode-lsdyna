const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
module.exports = async function verifyRemainingRelations(api, root) {
    const catalog = require("../../out/core/semantics/catalogInputFormCatalogV4").getCatalogInputFormCatalogV4();
    const form = catalog.formForKeyword('MAT_036');
    const state = form.rules[form.reference.fieldRuleIds[0]];
    const native = form.reference.formRuleIds.map(id => form.rules[id])
        .find(rule => rule.cardSetId === state.cardSetId);
    const rows = native.cards.flatMap((card, index) => [
        '$#' + card.fields.map((field, i) => field.name.toLowerCase().padStart(i ? 10 : 8)).join(''),
        (index < 2 ? '         1' : '').padEnd(80),
    ]);
    const file = path.join(root, 'mat036-nlp-title.k');
    const before = ['*MAT_036', ...rows, '*END'].join('\n');
    fs.writeFileSync(file, before);
    let document = await vscode.workspace.openTextDocument(file);
    let editor = await vscode.window.showTextDocument(document);
    const base = api.buildKeywordOptionViewModel(editor, 0, {});
    const m = base.managerCards.flatMap(card => card.fields).find(field => field.name === 'M');
    const title = base.controls.find(control => control.choices.some(choice => choice.value === 'TITLE'));
    const model = api.buildKeywordOptionViewModel(editor, 0, {
        fieldDrafts: { [m.fieldId]: '2' }, draftControlState: { [title.controlId]: 'TITLE' },
    });
    assert.equal(document.getText(), before);
    assert.ok(await api.applyKeywordOptionViewModel({ getModel: () => model, markStale() {} }, editor));
    assert.equal(document.lineAt(0).text, '*MAT_036_TITLE');
    await document.save();
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    document = await vscode.workspace.openTextDocument(file);
    editor = await vscode.window.showTextDocument(document);
    const reopened = api.buildKeywordOptionViewModel(editor, 0, {});
    assert.equal(reopened.plan.status, 'no-change', reopened.plan.reason);
    assert.deepEqual(reopened.targetLayout.records.map(record => record.lsppCardIndex), [0, 1, 2, 4, 5, 6, 7]);
    const nlp = reopened.managerCards.flatMap(card => card.fields).find(field => field.name === 'NLP');
    assert.equal(api.keywordManagerHelpState({ ...reopened, selectedFieldId: nlp.fieldId }).schemaName, 'NLP');
    fs.writeFileSync(path.join(root, 'mat036-roundtrip-results.json'), JSON.stringify({
        sourceRule: state.cardSetId, apply: true, saveAndReopen: true,
        cards: [0, 1, 2, 4, 5, 6, 7], help: 'NLP',
    }, null, 2));
};
