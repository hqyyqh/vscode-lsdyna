'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const api = require('../../../out/extension')._internals;

module.exports = function assertReadonlyReader(document, line = 0) {
    const before = document.getText(), previous = vscode.workspace.fs;
    const readonlyDocument = { ...document, uri: { ...document.uri, scheme: 'file' } };
    vscode.workspace.fs = { ...previous, isWritableFileSystem: () => false };
    try {
        const model = api.buildKeywordOptionViewModel({ document: readonlyDocument,
            selection: { active: new vscode.Position(line, 0) } }, line, {});
        assert.equal(model.readonly, true);
        assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
        const fields = model.managerCards.flatMap(card => card.fields || []);
        assert.ok(fields.length, 'Read-only source fields must remain visible');
        for (const field of fields) {
            assert.equal(field.editable, false);
            assert.equal(api.keywordManagerEditField(model, field.fieldId, '1'), null);
        }
        assert.equal(document.getText(), before, 'Read-only inspection changed source');
    } finally { vscode.workspace.fs = previous; }
};
