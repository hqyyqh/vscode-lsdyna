const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeDoc, vscodeMock: vscode } = require('./helpers');
const api = require('../src/extension')._internals;
const { getCatalogInputFormCatalogV4 } = require("../src/core/semantics/catalogInputFormCatalogV4");

describe('manager catalog write authority', () => {
    for (const sourceChange of [{ isUnauditedDiagnostic: true }, { conservationSatisfied: false }, { datasetSha256: '0'.repeat(64) }]) {
        it(`keeps fields viewable but rejects editing and prior plans for ${JSON.stringify(sourceChange)}`, async () => {
            const text = fs.readFileSync(path.join(__dirname, 'fixtures/lspp-native-formats/native-standard.k'), 'utf8');
            const document = Object.assign(fakeDoc(text), { languageId: 'lsdyna', version: 1 });
            const editor = { document };
            const line = text.split(/\r?\n/).indexOf('*MAT_ELASTIC');
            const base = api.buildKeywordOptionViewModel(editor, line, {});
            const field = base.managerCards.flatMap(c => c.fields).find(f => f.name === 'DA');
            const drafts = api.keywordManagerEditField(base, field.fieldId, '0.5');
            assert.ok(drafts);
            const staged = api.buildKeywordOptionViewModel(editor, line, drafts);
            assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true);
            const catalog = getCatalogInputFormCatalogV4({ allowUnaudited: false });
            const original = catalog.resolveFormForKeyword, originalApply = vscode.workspace.applyEdit;
            let writes = 0;
            catalog.resolveFormForKeyword = function (...args) {
                const form = original.apply(this, args);
                return form && { ...form, source: { ...form.source, ...sourceChange } };
            };
            vscode.workspace.applyEdit = async () => { writes++; return true; };
            try {
                const readonly = api.buildKeywordOptionViewModel(editor, line, {});
                assert.ok(readonly.managerCards.length, 'diagnostic fields remain visible');
                assert.equal(readonly.readonly, true);
                assert.equal(api.buildKeywordOptionsViewState(readonly).canApply, false);
                assert.equal(api.keywordManagerEditField(readonly, field.fieldId, '0.5'), null);
                assert.equal(await api.applyKeywordOptionViewModel({ getModel: () => staged, markStale() {} }, editor), null);
                assert.equal(writes, 0);
                assert.equal(document.getText(), text);
                assert.equal(Object.hasOwn(api.buildKeywordOptionsViewState(readonly), 'sourceDocument'), false);
            } finally {
                catalog.resolveFormForKeyword = original;
                vscode.workspace.applyEdit = originalApply;
            }
        });
    }
});
