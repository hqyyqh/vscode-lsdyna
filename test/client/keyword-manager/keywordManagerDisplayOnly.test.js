'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const api = require('../../../out/extension')._internals;
const { documentFor, editorFor } = require('../../support/keyword-manager/conditional-fixtures.cjs')({ vscode, generateCommentLine: api.generateCommentLine });

describe('manager edits verified records independently of reader display-only metadata', () => {
    const layouts = {
        ELEMENT_MASS: [8, 8, 16, 8],
        ELEMENT_MASS_PART_SET: [8, 16, 16, 16, 8],
        DATABASE_HISTORY_NODE_SET: Array(8).fill(10),
    };
    for (const [keyword, widths] of Object.entries(layouts)) {
        for (const format of ['standard', 'long', 'i10', 'comma']) {
            for (const occurrence of [0, 1, 2]) for (let fieldIndex = 0; fieldIndex < widths.length; fieldIndex++) it(`${keyword} ${format}: edits only record ${occurrence + 1}, field ${fieldIndex + 1}`, async () => {
                const sizes = widths.map(w => format === 'long' ? 20 : format === 'i10' ? Math.max(10, w) : w);
                const values = widths.map((_w, i) => String(i + 1));
                const row = format === 'comma' ? values.join(',') : values.map((v, i) => v.padStart(sizes[i])).join('');
                const header = '*' + keyword + (format === 'long' ? ' +' : format === 'i10' ? ' %' : '');
                const lines = [header, '$ first / 第一条', row, '', '$ second', row, '$ third', row, '*END'];
                const editor = editorFor(documentFor(lines));
                const initial = api.buildKeywordOptionViewModel(editor, 0, {});
                const sourceCard = initial.managerCards.find(card => card.line === [2, 5, 7][occurrence]);
                assert.deepEqual(sourceCard.fields.map(field => field.value), values);
                const field = sourceCard.fields[fieldIndex];
                assert.equal(field.editable, true, field.reason);
                const drafts = api.keywordManagerEditField(initial, field.fieldId, '77');
                assert.ok(drafts);
                const staged = api.buildKeywordOptionViewModel(editor, 0, drafts);
                assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true, staged.plan.reason);
                const expected = lines.slice(0, -1);
                const changedValues = values.map((v, i) => i === fieldIndex ? '77' : v);
                expected[[2, 5, 7][occurrence]] = format === 'comma'
                    ? changedValues.join(',') : changedValues.map((v, i) => v.padStart(sizes[i])).join('');
                const previousApply = vscode.workspace.applyEdit, previousEditor = vscode.window.activeTextEditor;
                let applied;
                vscode.window.activeTextEditor = editor;
                vscode.workspace.applyEdit = async edit => { applied = edit; return true; };
                try { await api.applyKeywordOptionViewModel({ getModel: () => staged, markStale() {} }, editor); }
                finally { vscode.workspace.applyEdit = previousApply; vscode.window.activeTextEditor = previousEditor; }
                assert.ok(applied);
                assert.equal(applied.edits[0].text, expected.join('\n') + '\n');
                assert.equal(editor.document.getText(), lines.join('\n'));
                const reopened = api.buildKeywordOptionViewModel(editorFor(documentFor([...expected, '*END'])), 0, {});
                assert.deepEqual([2, 5, 7].map(line => reopened.managerCards.find(card => card.line === line).fields.map(field => field.value)),
                    [0, 1, 2].map(index => index === occurrence ? changedValues : values));
            });
        }
    }
    it('preserves the reported scientific-notation records and rejects values that exceed the field', () => {
        const lines = ['*ELEMENT_MASS', '$主驾', '    8010    8010           0.077', '$副驾',
            '    8020    8020           0.050', '$主驾后排', '    8030    8030           1.E-7',
            '$副驾后排', '    8040    8040           1.E-7', '*END'];
        const editor = editorFor(documentFor(lines));
        const initial = api.buildKeywordOptionViewModel(editor, 0, {});
        const field = initial.managerCards[0].fields.find(field => field.name === 'MASS');
        const staged = api.buildKeywordOptionViewModel(editor, 0, api.keywordManagerEditField(initial, field.fieldId, '0.125'));
        assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true);
        assert.deepEqual(staged.plan.replacementRecords.slice(1).map(record => record.text), [lines[4], lines[6], lines[8]]);
        assert.equal(staged.plan.replacementRecords[0].text.slice(0, 16), lines[2].slice(0, 16));
        const invalid = api.buildKeywordOptionViewModel(editor, 0, { fieldDrafts: { [field.fieldId]: '12345678901234567' } });
        assert.equal(api.buildKeywordOptionsViewState(invalid).canApply, false);
        assert.equal(editor.document.getText(), lines.join('\n'));
    });
    it('keeps actual filesystem read-only protection and explains it', () => {
        const previous = vscode.workspace.fs;
        vscode.workspace.fs = { ...previous, isWritableFileSystem: () => false };
        try {
            const document = documentFor(['*ELEMENT_MASS', '1,2,0.077', '*END']);
            document.uri.scheme = 'file';
            const model = api.buildKeywordOptionViewModel(editorFor(document), 0, {});
            assert.equal(model.readonly, true);
            assert.ok(model.managerCards.every(card => card.fields.every(field => !field.editable && field.reason === 'document-readonly')));
        } finally { vscode.workspace.fs = previous; }
    });
    it('explains edit limitations without suggesting that the input is invalid', () => {
        const { userFacingReason } = require('../../../out/core/userFacingReason');
        for (const reason of ['document-readonly', 'field-geometry-unsupported', 'native-file-write-unverified', 'input-format-long']) {
            assert.doesNotMatch(userFacingReason(reason, 'zh-cn'), /部分信息尚未确认/);
            assert.doesNotMatch(userFacingReason(reason, 'en'), /Some information could not be confirmed/);
        }
    });
});
