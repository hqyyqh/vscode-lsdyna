'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const api = require('../out/extension')._internals;
const { documentFor, editorFor } = require('./keyword-manager/conditional-fixtures.cjs')({ vscode, generateCommentLine: api.generateCommentLine });
const header = [8000002, 0, 0, 0, 0, 'MECH'].map(value => String(value).padStart(10)).join('');
function inspect(lines) {
    const model = api.buildKeywordOptionViewModel(editorFor(documentFor(lines)), 0, {});
    return { model, view: api.buildKeywordOptionsViewState(model) };
}
describe('repeated records are not fixed descriptor counts', () => {
    it('reports a missing mandatory header without inventing an exact count for an unbounded tail', () => {
        const { view } = inspect(['*SET_PART_ADD', '*END']);
        assert.equal(view.canApply, false);
        assert.equal(view.layoutDiagnostics[0].code, 'missing');
        assert.equal(view.layoutDiagnostics[0].expectedRecords, undefined);
    });
    for (const ending of [[], ['*NODE', '         9', '*END']]) it(`bounds the repeated tail at ${ending.length ? 'the next keyword' : 'end of file'}`, () => {
        const { model } = inspect(['*SET_PART_ADD', header, '   2000106', '   2000105', ...ending]);
        assert.equal(model.plan.status, 'no-change');
        assert.equal(model.block.records.length, 3);
        assert.deepEqual(model.managerCards.filter(card => card.cardIndex === 2).map(card => card.fields[0].value), ['2000106', '2000105']);
    });
    for (const comments of [[], ['$ unrelated text'], ['$# PSID8 WRONG', '$# SID DA1 DA2']]) {
        it(`does not claim that SET_PART_ADD requires exactly two records (${comments.length} comments)`, () => {
            const { model, view } = inspect(['*SET_PART_ADD', header, ...comments,
                '   2000106', ...comments, '   2000105', '*END']);
            assert.equal(model.block.records.length, 3);
            assert.ok((view.layoutDiagnostics || []).every(item => item.expectedRecords === undefined),
                JSON.stringify(view.layoutDiagnostics));
            assert.ok(!(view.layoutDiagnostics || []).some(item => item.code === 'extra'));
        });
    }
    it('does not discard a blank data record on an unproven fixed-length assumption', () => {
        const { model } = inspect(['*SET_PART_ADD', header, '   2000106', '          ', '*END']);
        assert.equal(model.block.records.length, 3);
    });
});

describe('verified SET ADD tail records', () => {
    const { cases, domains } = require('./fixtures/public-behavior/tail-repeat-cases.json');
    const evidence = { cases };
    for (const item of evidence.cases) {
        it(`replays ${item.keyword} ${item.format} with ${item.count} tail records in Hover and manager`, () => {
            const document = documentFor([...item.lines, '*END']);
            const model = api.buildKeywordOptionViewModel(editorFor(document), 0, {});
            assert.equal(model.plan.status, 'no-change', model.plan.reason);
            const tail = model.managerCards.filter(card => card.cardIndex === 2);
            assert.equal(tail.length, item.count);
            assert.equal(new Set(tail.flatMap(card => card.fields.map(field => field.fieldId))).size, item.count * 8);
            for (let index = 0; index < item.count; index++) {
                assert.equal(tail[index].fields[0].value, String(item.sid * 10 + index));
                const line = 2 + Number(item.keyword.endsWith('_TITLE')) + index;
                const hover = api.getCardInfoForDocumentLineWithSuggest(document, line).cardInfo;
                assert.equal(hover.nativeCardIndex, 2);
                const prefix = domains[item.keyword.replace(/_TITLE$/, '')];
                assert.deepEqual(hover.card.map(field => field.n), Array.from({length: 8}, (_, i) => prefix + (i + 1)));
            }
        });
    }
    for (const keyword of Object.keys(domains)) for (const index of [0, 1, 2]) it(`edits ${keyword} tail ${index + 1} without changing other records or comments`, async () => {
        const header = evidence.cases.find(item => item.keyword === keyword && item.format === 'standard').lines[1];
        const lines = ['*' + keyword, header, '$ first', '   2000106', '$# misleading SID', '   2000105', '$ last', '   2000104', '*END'];
        const editor = editorFor(documentFor(lines));
        const initial = api.buildKeywordOptionViewModel(editor, 0, {});
        const tail = initial.managerCards.filter(card => card.cardIndex === 2);
        const model = api.buildKeywordOptionViewModel(editor, 0, { fieldDrafts: { [tail[index].fields[0].fieldId]: '3000001' } });
        assert.equal(api.buildKeywordOptionsViewState(model).canApply, true, model.plan.reason);
        const previousApply = vscode.workspace.applyEdit, previousEditor = vscode.window.activeTextEditor;
        let edit;
        vscode.window.activeTextEditor = editor;
        vscode.workspace.applyEdit = async value => { edit = value; return true; };
        try { await api.applyKeywordOptionViewModel({ getModel: () => model, markStale() {} }, editor); }
        finally { vscode.workspace.applyEdit = previousApply; vscode.window.activeTextEditor = previousEditor; }
        assert.ok(edit);
        const expected = lines.slice(0, -1);
        // The existing fixed-width writer emits all eight 10-column fields on
        // the edited card. Untouched cards must retain their original bytes.
        expected[3 + index * 2] = '   3000001'.padEnd(80);
        assert.equal(edit.edits[0].text, expected.join('\n') + '\n');
        const reopened = inspect([...expected, '*END']).model;
        assert.equal(reopened.plan.status, 'no-change');
        assert.deepEqual(reopened.managerCards.filter(card => card.cardIndex === 2).map(card => card.fields[0].value),
            ['2000106','2000105','2000104'].map((value, item) => item === index ? '3000001' : value));
    });
    for (const keyword of Object.keys(domains)) for (const title of [false, true]) it(`preserves ${keyword} repeat items when ${title ? 'removing' : 'adding'} TITLE`, () => {
        const header = evidence.cases.find(item => item.keyword === keyword && item.format === 'standard').lines[1];
        const editor = editorFor(documentFor(['*' + keyword + (title ? '_TITLE' : ''),
            ...(title ? ['preserve title'] : []), header, '   2000106', '   2000105', '   2000104', '*END']));
        const initial = api.buildKeywordOptionViewModel(editor, 0, {});
        const control = initial.controls.find(control => control.choices.some(choice => choice.value === 'TITLE'));
        assert.ok(control);
        // The existing select renders an explicit empty/base option before its choices.
        const value = title ? '' : 'TITLE';
        const model = api.buildKeywordOptionViewModel(editor, 0, { draftControlState: { [control.controlId]: value } });
        assert.equal(api.buildKeywordOptionsViewState(model).canApply, true, model.plan.reason);
        assert.equal(model.targetKeyword, '*' + keyword + (title ? '' : '_TITLE'));
        const records = model.plan.replacementRecords;
        assert.deepEqual(records.slice(1 + Number(!title)).map(record => record.text), ['   2000106','   2000105','   2000104']);
        assert.equal(inspect([model.targetKeyword, ...records.flatMap(record => [...(record.comments || []), record.text]), '*END']).model.plan.status, 'no-change');
    });
});
