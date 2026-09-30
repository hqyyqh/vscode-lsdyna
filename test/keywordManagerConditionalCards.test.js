'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');
const { nativeFileReadContext } = require('../out/core/semantics/nativeFileReadContext');
const { getCatalogInputFormCatalogV4 } = require("../out/core/semantics/catalogInputFormCatalogV4");
const {
    buildKeywordOptionViewModel: build, buildKeywordOptionsViewState: view,
    applyKeywordOptionViewModel: apply, generateCommentLine,
} = require('../out/extension')._internals;

const { families, documentFor, editorFor, indexes, sample, fixture } =
    require('./keyword-manager/conditional-fixtures.cjs')({ vscode, generateCommentLine });

describe('published conditional manager cards', function () {
    this.timeout(60000);
    let previous;
    before(() => { previous = process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG; delete process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG; });
    after(() => { if (previous === undefined) delete process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG;
        else process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG = previous; });

    for (const keyword of families) it(`${keyword}: switches, applies and reopens all one-controller layout transitions`, async () => {
        const form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
        assert.equal(form.source.isUnauditedDiagnostic, false);
        const rule = form.rules[form.reference.fieldRuleIds[0]];
        const native = form.reference.formRuleIds.map(id => form.rules[id]).find(rule2 => rule2.cardSetId === rule.cardSetId);
        let appliedCount = 0;
        const oldApply = vscode.workspace.applyEdit, oldEditor = vscode.window.activeTextEditor;
        const oldWarning = vscode.window.showWarningMessage;
        vscode.window.showWarningMessage = async (_message, _options, confirm) => confirm;
        try {
            for (const from of rule.states) for (const to of rule.states) {
                const dimensions = from.domainIndexes.map((value, index) => value === to.domainIndexes[index] ? -1 : index).filter(index => index >= 0);
                if (dimensions.length !== 1 || from.cardIndexes.join() === to.cardIndexes.join()) continue;
                const dimension = dimensions[0];
                const controller = rule.controllerFields.find(field => field.controllerId === rule.domains[dimension].controllerId);
                if (!from.cardIndexes.includes(controller.cardIndex) || !to.cardIndexes.includes(controller.cardIndex)) continue;
                const number = sample(rule.domains[dimension].intervals[to.domainIndexes[dimension]]);
                const field = native.cards.find(card => card.cardIndex === controller.cardIndex).fields[controller.fieldIndex];
                const value = (field.choices || []).find(choice => Number(choice) === number) ?? String(number);
                for (const full of [false, true]) {
                    const document = fixture(keyword, native, rule, from, full);
                    const original = document.getText(), editor = editorFor(document);
                    const base = build(editor, 0, {});
                    const fieldId = base.managerCards.find(card => card.cardIndex === controller.cardIndex)?.fields[controller.fieldIndex]?.fieldId
                        || `lspp-input:${keyword}:card:${controller.cardIndex}:field:${controller.fieldIndex}`;
                    const model = build(editor, 0, { fieldDrafts: {
                        [fieldId]: value,
                    } });
                    // GUI state pools are not physical file layouts. Compare against the same
                    // source reader as Hover; its native-record semantics have independent replay tests.
                    const rows = original.split('\n').filter(line => !line.startsWith('$') && !line.startsWith('*'));
                    const selection = nativeFileReadContext({ ...native, catalogSource: form.source }, '*' + keyword, rows, 'standard').select(false,
                        (record, index, raw) => record.cardIndex === controller.cardIndex && index === controller.fieldIndex ? value : raw);
                    if (!selection?.current) {
                        assert.equal(model.plan.status, 'blocked', `${keyword}: invalid physical pool must remain blocked`);
                        assert.equal(view(model).canApply, false);
                        assert.equal(document.getText(), original);
                        continue;
                    }
                    const targetIndexes = (selection.target || selection.current).map(record => record.cardIndex);
                    assert.deepEqual(indexes(model), targetIndexes, `${controller.name}=${value}, full=${full}`);
                    const state = view(model);
                    assert.equal(state.canApply, true, `${model.plan.reason}: ${controller.name}=${value}, ${JSON.stringify(model.fieldChanges)}`);
                    assert.deepEqual(state.branchSummary.draft.filter(index => index !== 0), targetIndexes);
                    if (keyword === 'MAT_BARLAT_YLD2000') {
                        assert.ok(state.manualConditions.some(group => group.condition === 'FIT = 1'));
                        assert.ok(state.manualConditions.some(group => group.condition === 'HARD = 3'));
                    }
                    let workspaceEdit;
                    vscode.window.activeTextEditor = editor;
                    vscode.workspace.applyEdit = async edit => { workspaceEdit = edit; return true; };
                    assert.ok(await apply({ getModel: () => model, markStale() {} }, editor));
                    const edit = workspaceEdit.edits[0];
                    // Apply the real submitted replacement to a separate document,
                    // then resolve again without the old draft or in-memory model.
                    const lines = original.split('\n');
                    const start = edit.range.start, end = edit.range.end;
                    const updated = [...lines.slice(0, start.line),
                        ...((lines[start.line] || '').slice(0, start.character) + edit.text +
                            (lines[end.line] || '').slice(end.character)).split(/\r?\n/),
                        ...lines.slice(end.line + 1)];
                    const reopened = build(editorFor(documentFor(updated)), 0, {});
                    assert.deepEqual(indexes(reopened), targetIndexes);
                    assert.notEqual(reopened.plan.status, 'blocked', reopened.plan.reason);
                    const written = reopened.managerCards.flatMap(card => card.fields).find(field =>
                        field.fieldId === fieldId);
                    assert.equal(Number(written.value), number);
                    assert.equal(document.getText(), original, 'building/submitting the plan must not mutate the source model');
                    appliedCount++;
                }
            }
        } finally { vscode.workspace.applyEdit = oldApply; vscode.window.activeTextEditor = oldEditor;
            vscode.window.showWarningMessage = oldWarning; }
        assert.ok(appliedCount > 0);
    });

    it('rejects an unlabelled full pool instead of granting selector write authority', async () => {
        const keyword = 'MAT_BARLAT_YLD2000', form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
        const rule = form.rules[form.reference.fieldRuleIds[0]], native = form.rules[form.reference.formRuleIds[0]];
        const document = fixture(keyword, native, rule, rule.states[0], true, false), editor = editorFor(document);
        const model = build(editor, 0, { fieldDrafts: { [`lspp-input:${keyword}:card:1:field:4`]: '1.0' } });
        assert.equal(model.plan.status, 'blocked');
        assert.equal(view(model).canApply, false);
        assert.equal(await apply({ getModel: () => model, markStale() {} }, editor), null);
    });

    it('preserves fitted data, reviews discarded ALPHA values, and accepts numeric enum spellings', async () => {
        const keyword = 'MAT_BARLAT_YLD2000', form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
        const rule = form.rules[form.reference.fieldRuleIds[0]], native = form.rules[form.reference.formRuleIds[0]];
        const from = rule.states.find(state => state.cardIndexes.join() === '1,2,4,7,8,9');
        const lines = fixture(keyword, native, rule, from, false).getText().split('\n');
        lines[6] = '42'.padStart(10) + lines[6].slice(10); // Active Card 4: ALPHA1; no inactive SIG00 record exists.
        const document = documentFor(lines), editor = editorFor(document);
        for (const value of ['1', '1.0', '1e0', '1D0']) {
            const model = build(editor, 0, { fieldDrafts: { [`lspp-input:${keyword}:card:1:field:4`]: value } });
            // Predicate parsing and enum validation must agree on numeric values.
            assert.deepEqual(indexes(model), [1, 2, 5, 6, 7, 8, 9], value);
            assert.equal(model.plan.status, 'ready', model.plan.reason);
            assert.ok(model.plan.discardedFields.some(field => field.name === 'ALPHA1' && Number(field.value) === 42));
            assert.equal(model.plan.replacementRecords[2].text.slice(0, 10).trim(), '');
            assert.equal(view(model).preview.reviewLevel, 'destructive');
        }
        const model = build(editor, 0, { fieldDrafts: { [`lspp-input:${keyword}:card:1:field:4`]: '1.0' } });
        const oldWarning = vscode.window.showWarningMessage, oldApply = vscode.workspace.applyEdit;
        const oldEditor = vscode.window.activeTextEditor;
        let warnings = 0, writes = 0;
        vscode.window.activeTextEditor = editor;
        vscode.window.showWarningMessage = async () => { warnings++; return undefined; };
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        try {
            assert.equal(await apply({ getModel: () => model, markStale() {} }, editor), null);
            assert.equal(warnings, 1);
            assert.equal(writes, 0);
            assert.equal(document.getText(), lines.join('\n'));
        } finally { vscode.window.showWarningMessage = oldWarning; vscode.workspace.applyEdit = oldApply;
            vscode.window.activeTextEditor = oldEditor; }
    });

    it('uses the native nonzero default for an empty SPR3 MODEL controller', () => {
        const keyword = 'MAT_CONSTRAINED_SPR3', form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
        const rule = form.rules[form.reference.fieldRuleIds[0]], native = form.rules[form.reference.formRuleIds[0]];
        const initial = rule.states.find(state => state.domainIndexes[0] === 0);
        const lines = fixture(keyword, native, rule, initial, false).getText().split('\n');
        lines[2] = lines[2].slice(0, 20) + ' '.repeat(10) + lines[2].slice(30);
        const editor = editorFor(documentFor(lines));
        assert.notEqual(build(editor, 0, {}).plan.status, 'blocked');
        const model = build(editor, 0, { fieldDrafts: { [`lspp-input:${keyword}:card:1:field:2`]: '2' } });
        assert.deepEqual(indexes(model), [1, 2, 5, 6]);
        assert.equal(view(model).canApply, true);
    });

    it('rejects a labelled NLP pool that belongs to a different MAT_036 file spelling', () => {
        const keyword = 'MAT_036', form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
        const rule = form.rules[form.reference.fieldRuleIds[0]];
        const native = form.reference.formRuleIds.map(id => form.rules[id]).find(item => item.cardSetId === rule.cardSetId);
        const from = rule.states.find(state => state.cardIndexes.join() === '1,2,4,5,6,7');
        const editor = editorFor(fixture(keyword, native, rule, from, true));
        const model = build(editor, 0, { fieldDrafts: { 'lspp-input:MAT_036:card:2:field:0': '3' } });
        assert.equal(model.plan.status, 'blocked');
        assert.equal(view(model).canApply, false);
        assert.equal(model.plan.reason, 'lspp-input-form-source-layout-unresolved');
    });

    for (const format of ['standard', 'long', 'i10', 'comma']) it(`handles Barlat controllers in ${format} without widening write authority`, () => {
        const keyword = 'MAT_BARLAT_YLD2000', form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
        const rule = form.rules[form.reference.fieldRuleIds[0]], native = form.rules[form.reference.formRuleIds[0]];
        const from = rule.states.find(state => state.cardIndexes.join() === '1,2,4,7,8,9');
        let lines = fixture(keyword, native, rule, from, false).getText().split('\n');
        lines = lines.map(line => {
            if (/^[*$]/.test(line)) return line;
            const cells = line.match(/.{10}/g);
            return format === 'long' ? cells.map(cell => cell.padStart(20)).join('') :
                format === 'comma' ? cells.map(cell => cell.trim()).join(',') : line;
        });
        if (format === 'long' || format === 'i10') lines.unshift(`*KEYWORD ${format.toUpperCase()}=Y`);
        const model = build(editorFor(documentFor(lines)), format === 'long' || format === 'i10' ? 1 : 0,
            { fieldDrafts: { [`lspp-input:${keyword}:card:1:field:4`]: '1.0' } });
        assert.deepEqual(indexes(model), [1, 2, 5, 6, 7, 8, 9]);
        assert.equal(view(model).canApply, format !== 'comma', model.plan.reason);
    });
});
