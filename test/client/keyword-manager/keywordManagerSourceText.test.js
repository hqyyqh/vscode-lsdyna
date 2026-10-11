'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const api = require('../../../out/extension')._internals;
const { getCatalogInputFormCatalogV4 } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
const i18n = require('../../../out/core/i18n');

describe('manager native branch source text conservation', () => {
    for (const [keyword, pool] of [['MAT_036', "record:e33060cfb3db352b1c00e0fe:19676e89920f625312d39e04"], ['MAT_3-PARAMETER_BARLAT_NLP', "record:e33060cfb3db352b1c00e0fe:ffa1f10215793311c1e4833f"]]) {
        it(`blocks unmodeled tails on removed ${keyword} cards before apply`, async () => {
            const form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
            const native = form.reference.formRuleIds.map(id => form.rules[id]).find(rule => rule.cardSetId === pool);
            for (const knownValue of ['', '         7']) {
                const lines = ['*' + keyword, ...native.cards.map((_card, index) =>
                    (index === 0 ? '         1' : index === 1 ? '        -1' : index === 2 ? knownValue : '').padEnd(80) +
                    (index === 2 ? 'TAIL' : '')), '*END'];
                const text = lines.join('\n');
                const document = { languageId: 'lsdyna', version: 1, lineCount: lines.length, eol: 1,
                    uri: vscode.Uri.file('D:/temp/keyword-options.key'), lineAt: index => ({ text: lines[index] }),
                    getText: () => text };
                const editor = { document, selection: { active: new vscode.Position(0, 0) } };
                const base = api.buildKeywordOptionViewModel(editor, 0, {});
                assert.equal(base.plan.status, 'no-change', base.plan.reason);
                assert.ok(base.plan.replacementRecords.some(record => record.text.includes('TAIL')));
                const controller = base.managerCards.flatMap(card => card.fields).find(field => field.name === 'M');
                const changed = api.buildKeywordOptionViewModel(editor, 0, { fieldDrafts: { [controller.fieldId]: '2' } });
                assert.equal(changed.plan.status, 'blocked', changed.plan.reason);
                assert.equal(changed.plan.reason, 'unmodeled-source-text');
                assert.equal(api.buildKeywordOptionsViewState(changed).canApply, false);
                const originalConfiguration = vscode.workspace.getConfiguration;
                try {
                    for (const [language, message] of [
                        ['en', 'Some record content may be lost in the selected layout. Input files are unchanged. Review the source file.'],
                        ['zh-cn', '无法确认所选布局能保留全部记录内容。输入文件未改动，请在源文件中核对。'],
                    ]) {
                        vscode.workspace.getConfiguration = (...args) => {
                            const configuration = originalConfiguration(...args);
                            return { ...configuration, get: (key, ...args) => key === 'language' ? language : configuration.get(key, ...args) };
                        };
                        i18n.updateLanguage();
                        assert.equal(api.buildKeywordOptionsViewState(changed).message, message);
                    }
                } finally { vscode.workspace.getConfiguration = originalConfiguration; i18n.updateLanguage(); }
                const originalApply = vscode.workspace.applyEdit;
                let writes = 0;
                vscode.workspace.applyEdit = async () => { writes++; return true; };
                try {
                    const provider = { getModel: () => changed, markStale() {} };
                    assert.equal(await api.applyKeywordOptionViewModel(provider, editor), null);
                    // A previously prepared ready view must also be rejected on revalidation.
                    changed.plan = { ...changed.plan, status: 'ready' };
                    assert.equal(await api.applyKeywordOptionViewModel(provider, editor), null);
                    assert.equal(writes, 0);
                    assert.equal(document.getText(), text);
                } finally { vscode.workspace.applyEdit = originalApply; }
            }
        });
    }
});
