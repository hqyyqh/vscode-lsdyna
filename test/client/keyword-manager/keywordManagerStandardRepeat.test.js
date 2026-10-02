'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const api = require("../../../out/extension")._internals;
const { documentFor, editorFor } = require("../../support/keyword-manager/conditional-fixtures.cjs")({ vscode, generateCommentLine: api.generateCommentLine });
const { nativeFileReadContext } = require("../../../out/core/semantics/nativeFileReadContext");
const { CatalogInputFormCatalogV4 } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
const catalog = new CatalogInputFormCatalogV4({ rootDir: path.resolve(__dirname, "../../../keywords/runtime/input-form") });
const published = require("../../../keywords/runtime/native-readers/lspp-standard-repeat-readers.json");
const descriptors = require("../../fixtures/public-behavior/standard-repeat-fields.json");
describe('standard-only repeated records', () => {
    for (const keyword of Object.keys(published.bindings)) {
        const form = catalog.formForKeyword(keyword);
        const rule = { ...form.rules[form.reference.formRuleIds[0]], catalogSource: form.source };
        const nativeFields = rule.cards[0].fields.map(field => descriptors[field.fieldRecordId]);
        const row = value => {
            const text = Array(Math.max(...nativeFields.map(field => field.position + field.width))).fill(' ');
            for (const field of nativeFields) text.splice(field.position, field.width,
                ...String(field.position ? 1 : value).padStart(field.width));
            return text.join('');
        };
        for (const count of [1, 2, 3]) for (const comments of [[], ['$# WRONG, TITLE', '$ 中文说明']]) {
            it(`${keyword}: ${count} records, ${comments.length} comments, editable fields agree with Hover`, () => {
                const lines = ['*' + keyword, ...Array.from({ length: count }, (_, index) => [...comments, row(index + 1)]).flat(), '*END'];
                const document = documentFor(lines);
                const model = api.buildKeywordOptionViewModel(editorFor(document), 0, {});
                const view = api.buildKeywordOptionsViewState(model);
                assert.equal(view.canApply, false);
                assert.equal(model.managerCards.length, count);
                assert.equal(model.plan.status, 'no-change');
                assert.deepEqual(model.choices.map(choice => choice.targetKeyword), ['*' + keyword]);
                const fields = model.managerCards.flatMap(card => card.fields);
                assert.equal(new Set(fields.map(field => field.fieldId)).size, fields.length);
                for (const card of model.managerCards) {
                    assert.equal(card.editable, true);
                    const hover = api.getCardInfoForDocumentLineWithSuggest(document, card.line).cardInfo;
                    assert.deepEqual(hover.card.map(field => field.n), card.fields.map(field => field.name));
                    assert.deepEqual(card.fields.map(field => field.value), nativeFields.map(field =>
                        lines[card.line].slice(field.position, field.position + field.width).trim()));
                }
                assert.deepEqual(model.managerCards.map(card => card.fields[0].value), Array.from({ length: count }, (_, index) => String(index + 1)));
                const drafted = api.buildKeywordOptionViewModel(editorFor(document), 0, api.keywordManagerEditField(model, fields[0].fieldId, '999'));
                assert.equal(api.buildKeywordOptionsViewState(drafted).canApply, true);
            });
        }
        for (const [marker, global, rows] of [
            [' +', 'standard', [row(1)]], [' %', 'standard', [row(1)]],
            ['', 'long', [row(1)]], ['', 'i10', [row(1)]],
            ['', 'standard', [row(1), '2,1']],
        ]) it(`${keyword}: blocks ${marker || global} / ${rows.at(-1).includes(',') ? 'comma' : 'fixed'}`, () => {
            const context = nativeFileReadContext(rule, '*' + keyword + marker, rows, global);
            assert.ok(context.readInputFailure);
            assert.equal(context.select(), null);
            assert.equal(context.select(true), null);
            assert.equal(context.read(rows[0], 1, 0), '');
            assert.equal(context.writeCompatible([{ cardIndex: 1 }]), false);
        });
        it(`${keyword}: respects a local standard override`, () => {
            const context = nativeFileReadContext(rule, '*' + keyword + ' -', [row(1), row(2)], 'long');
            assert.equal(context.readInputFailure, undefined);
            assert.equal(context.select().current.length, 2);
            assert.equal(context.writeCompatible(context.select().current), true);
        });
        for (const [marker, value] of [[' +', row(1)], [' %', row(1)], ['', '1,2,3']]) {
            it(`${keyword}: unsupported formats cannot bypass the Hover ordinal fast path or manager protection (${marker || 'comma'})`, () => {
                const document = documentFor(['*' + keyword + marker, value, '*END']);
                const hover = api.getCardInfoForDocumentLineWithSuggest(document, 1);
                assert.equal(hover.cardInfo, null);
                assert.match(hover.reason, /format-not-supported-by-binding/);
                const model = api.buildKeywordOptionViewModel(editorFor(document), 0, {});
                assert.equal(model.managerCards.length, 0);
                assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
            });
        }
        it(`${keyword}: preserves a blank repeated record and stops at the next keyword`, () => {
            const model = api.buildKeywordOptionViewModel(editorFor(documentFor([
                '*' + keyword, row(1), ' '.repeat(row(1).length), row(3), '*NODE', '         9', '*END',
            ])), 0, {});
            assert.equal(model.block.records.length, 3);
            assert.equal(model.managerCards.length, 3);
            assert.ok(model.managerCards[1].fields.every(field => field.value === ''));
            assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
        });
        for (const occurrence of [0, 1, 2]) for (let fieldIndex = 0; fieldIndex < nativeFields.length; fieldIndex++) {
            it(`${keyword}: edits record ${occurrence + 1}, field ${nativeFields[fieldIndex].name} without touching other bytes`, async () => {
                const lines = ['*' + keyword, '$ first', row(1), '$# misleading title', row(2), '$ last', row(3), '*END'];
                const editor = editorFor(documentFor(lines));
                const model = api.buildKeywordOptionViewModel(editor, 0, {});
                const field = model.managerCards[occurrence].fields[fieldIndex];
                const drafts = api.keywordManagerEditField(model, field.fieldId, '7');
                assert.ok(drafts);
                const staged = api.buildKeywordOptionViewModel(editor, 0, drafts);
                assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true, staged.plan.reason);
                assert.equal(editor.document.getText(), lines.join('\n'));
                const originalApply = vscode.workspace.applyEdit, originalEditor = vscode.window.activeTextEditor;
                let applied;
                vscode.window.activeTextEditor = editor;
                vscode.workspace.applyEdit = async edit => { applied = edit; return true; };
                try { await api.applyKeywordOptionViewModel({ getModel: () => staged, markStale() {} }, editor); }
                finally { vscode.workspace.applyEdit = originalApply; vscode.window.activeTextEditor = originalEditor; }
                assert.ok(applied);
                const expected = lines.slice(0, -1), descriptor = nativeFields[fieldIndex];
                const source = expected[2 + occurrence * 2];
                expected[2 + occurrence * 2] = source.slice(0, descriptor.position) + '7'.padStart(descriptor.width) + source.slice(descriptor.position + descriptor.width);
                assert.equal(applied.edits[0].text, expected.join('\n') + '\n');
                const reopened = api.buildKeywordOptionViewModel(editorFor(documentFor([...expected, '*END'])), 0, {});
                assert.equal(reopened.managerCards[occurrence].fields[fieldIndex].value, '7');
                for (let index = 0; index < 3; index++) if (index !== occurrence)
                    assert.deepEqual(reopened.managerCards[index].fields.map(field => field.value), model.managerCards[index].fields.map(field => field.value));
            });
        }
    }
});
