'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { getCatalogInputFormCatalogV4 } = require(path.join(
    vscode.extensions.getExtension('hqyyqh.dynasense').extensionPath, 'out/extension'))._internals;

function sharedByteFixture() {
    const keyword = 'CONSTRAINED_SOIL_PILE_CONSTANTS';
    const rule = getCatalogInputFormCatalogV4().formForKeyword(keyword).rules['input-form-1198'];
    assert.ok(rule.cards[1].sharedByteEditing, 'the candidate must contain the real projected contract');
    // A hand-authored edit fixture using the complete EXE card geometry.
    const cards = rule.cards.map(card => {
        const bytes = Array(Math.max(...card.fields.map(field => field.position + field.width))).fill(' ');
        for (const field of card.fields) bytes[field.position + field.width - 1] = '0';
        return bytes.join('');
    });
    return { keyword, cards, text: ['*KEYWORD', `*${keyword}`, ...cards, '*END', ''].join('\n') };
}

async function checkSafety(root, api, results) {
    const check = async (name, operation) => {
        const result = { mode: 'host-safety', name, passed: false };
        results.push(result);
        try { await operation(result); result.passed = true; }
        catch (error) { result.error = error.stack || String(error); }
        finally {
            const panels = vscode.window.tabGroups.all.flatMap(group => group.tabs)
                .filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('lsdynaKeywordManager'));
            if (panels.length) await vscode.window.tabGroups.close(panels);
        }
    };
    const open = async (name, text, keyword) => {
        const uri = vscode.Uri.file(path.join(root, 'workspace', name));
        fs.writeFileSync(uri.fsPath, text);
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document);
        const line = text.split(/\r?\n/).indexOf(keyword);
        assert.ok(line >= 0);
        editor.selection = new vscode.Selection(line, 0, line, 0);
        return { uri, document, editor, line,
            base: api.buildKeywordOptionViewModel(editor, line, { provisional: true }) };
    };
    const stage = (opened, fieldName, value) => {
        const field = opened.base.managerCards.flatMap(card => card.fields).find(item => item.name === fieldName);
        assert.ok(field?.editable, `field ${fieldName} is not editable`);
        const drafts = api.keywordManagerEditField(opened.base, field.fieldId, value);
        assert.ok(drafts);
        return { field, model: api.buildKeywordOptionViewModel(opened.editor, opened.line,
            { ...drafts, provisional: true }) };
    };
    const apply = (opened, model) => api.applyKeywordOptionViewModel({ getModel: () => model, markStale() {} }, opened.editor);
    const numericSource = fs.readFileSync(path.join(__dirname,
        "../../fixtures/public-behavior/native-formats/native-standard.k"), 'utf8');

    await check('opening at a new cursor block cannot inherit the previous keyword spelling', async result => {
        const { text, keyword } = sharedByteFixture();
        const opened = await open('command-cursor.k', text, '*KEYWORD');
        const previous = await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions', 0);
        assert.equal(previous.currentKeyword, '*KEYWORD');
        const sourceEditor = await vscode.window.showTextDocument(opened.document, opened.editor.viewColumn);
        sourceEditor.selection = new vscode.Selection(1, 0, 1, 0);
        result.reopenActiveSource = vscode.window.activeTextEditor?.document.uri.toString() || null;
        result.reopenActiveLine = vscode.window.activeTextEditor?.selection.active.line ?? null;
        assert.equal(vscode.window.activeTextEditor?.document, opened.document, 'The source editor must own the command');
        const current = await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');
        assert.equal(current.currentKeyword, `*${keyword}`);
        assert.equal(current.targetKeyword, current.currentKeyword);
        assert.equal(api.buildKeywordOptionsViewState(current).canApply, false, 'opening must not invent an edit');
        assert.equal(opened.document.getText(), text);
    });

    await check('shared-byte edit, linked preview, atomic undo and reopen', async result => {
        const { keyword, cards, text: before } = sharedByteFixture();
        const opened = await open('shared-byte.k', before, `*${keyword}`);
        const { model } = stage(opened, 'TIMSTR', '12');
        const view = api.buildKeywordOptionsViewState(model);
        assert.deepEqual(view.preview.sharedByteChanges, ['TIMSTR: 0 → 12', 'ICD7A: 0 → 12']);
        assert.ok(await apply(opened, model));
        const after = opened.document.getText();
        const expected = [...cards];
        expected[1] = expected[1].slice(0, 30) + '12'.padStart(10) + expected[1].slice(40);
        assert.equal(after, ['*KEYWORD', `*${keyword}`, ...expected, '*END', ''].join('\n'));
        await vscode.commands.executeCommand('undo');
        assert.equal(opened.document.getText(), before);
        await vscode.commands.executeCommand('redo');
        assert.equal(opened.document.getText(), after);
        assert.ok(await opened.document.save());
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        assert.equal((await vscode.workspace.openTextDocument(opened.uri)).getText(), after);
        result.linkedFields = ['TIMSTR', 'ICD7A'];
        result.modifiedByteRange = [30, 40];
    });

    await check('OS readonly file rejects a previously staged edit', async () => {
        const opened = await open('readonly.k', numericSource, '*MAT_ELASTIC');
        const { model } = stage(opened, 'DA', '0.5');
        const originalMode = fs.statSync(opened.uri.fsPath).mode;
        try {
            fs.chmodSync(opened.uri.fsPath, 0o444);
            assert.equal(fs.statSync(opened.uri.fsPath).mode & 0o200, 0, 'readonly setup failed');
            assert.equal(await apply(opened, model), null);
            assert.equal(opened.document.getText(), numericSource);
            assert.equal(fs.readFileSync(opened.uri.fsPath, 'utf8'), numericSource);
        } finally { fs.chmodSync(opened.uri.fsPath, originalMode & 0o777); }
    });

    await check('external block change rejects stale drafts without rebasing', async () => {
        const opened = await open('stale.k', numericSource, '*MAT_ELASTIC');
        const { model, field } = stage(opened, 'DA', '0.5');
        const external = new vscode.WorkspaceEdit();
        external.insert(opened.uri, new vscode.Position(field.line, 0), '$ external edit\n');
        assert.ok(await vscode.workspace.applyEdit(external));
        const changed = opened.document.getText();
        assert.notEqual(changed, numericSource);
        assert.equal(await apply(opened, model), null);
        assert.equal(opened.document.getText(), changed);
        await vscode.commands.executeCommand('undo');
        assert.equal(opened.document.getText(), numericSource);
    });

    await check('over-width, newline and numeric comma drafts cannot reach the document', async () => {
        const opened = await open('invalid.k', numericSource, '*MAT_ELASTIC');
        const field = opened.base.managerCards.flatMap(card => card.fields).find(item => item.name === 'DA');
        assert.ok(field?.editable);
        for (const value of ['12345678901', '1\n2', '1,2']) {
            assert.equal(api.keywordManagerEditField(opened.base, field.fieldId, value), null, value);
            assert.equal(api.buildKeywordOptionsViewState(opened.base).canApply, false, value);
            assert.equal(await apply(opened, opened.base), null);
            assert.equal(opened.document.getText(), numericSource);
            assert.equal(fs.readFileSync(opened.uri.fsPath, 'utf8'), numericSource);
        }
    });

    for (const [controller, value, expectedCards, addedField] of [
        ['FIT', '1.0', [1, 2, 5, 6, 7, 8, 9], 'SIG00'],
        ['HARD', '3.0', [1, 2, 4, 10, 11, 12, 7, 8, 9]],
        ['A', '-1', [1, 2, 3, 4, 7, 8, 9]],
    ]) {
        await check(`${controller} changes native card layout, applies and reopens`, async result => {
            const cards = require("../../../keywords/runtime/schema/field_data.json").MAT_BARLAT_YLD2000.c;
            const records = [0, 1, 3, 6, 7, 8].map(index => {
                const values = index === 0 ? { MID: 1, FIT: 0 } : index === 1 ? { HARD: 1, A: 0 } : {};
                const bytes = Array(80).fill(' ');
                for (const field of cards[index]) {
                    if (!Object.hasOwn(values, field.n)) continue;
                    const text = String(values[field.n]).padStart(field.w);
                    bytes.splice(field.p, field.w, ...text);
                }
                return bytes.join('');
            });
            const before = ['*KEYWORD', '*MAT_BARLAT_YLD2000', ...records, '*END', ''].join('\n');
            const opened = await open(`controller-${controller}.k`, before, '*MAT_BARLAT_YLD2000');
            assert.deepEqual(opened.base.managerCards.map(card => card.cardIndex), [1, 2, 4, 7, 8, 9]);
            let { model } = stage(opened, controller, value);
            assert.deepEqual(model.managerCards.map(card => card.cardIndex), expectedCards);
            if (addedField) {
                const field = model.managerCards.flatMap(card => card.fields).find(item => item.name === addedField);
                assert.ok(field?.editable);
                const drafts = api.keywordManagerEditField(model, field.fieldId, '123');
                assert.ok(drafts);
                model = api.buildKeywordOptionViewModel(opened.editor, opened.line, { ...drafts, provisional: true });
            }
            assert.equal(api.buildKeywordOptionsViewState(model).canApply, true);
            assert.equal(model.plan.requiresLossConfirmation, false, 'fixture contains no discarded values');
            assert.ok(await apply(opened, model));
            const after = opened.document.getText();
            const refreshed = api.buildKeywordOptionViewModel(opened.editor, opened.line, { provisional: true });
            assert.deepEqual(refreshed.managerCards.map(card => card.cardIndex), expectedCards);
            const fields = refreshed.managerCards.flatMap(card => card.fields);
            assert.equal(Number(fields.find(field => field.name === controller)?.value), Number(value));
            assert.equal(fields.find(field => field.name === 'MID')?.value, '1');
            if (addedField) assert.equal(fields.find(field => field.name === addedField)?.value, '123');
            // Unaffected physical cards retain every byte, despite shifted source lines.
            for (const card of opened.base.managerCards.filter(card => [7, 8, 9].includes(card.cardIndex))) {
                const retained = refreshed.managerCards.find(item => item.cardIndex === card.cardIndex);
                assert.equal(opened.document.lineAt(retained.fields[0].line).text,
                    before.split('\n')[card.fields[0].line]);
            }
            await vscode.commands.executeCommand('undo');
            assert.equal(opened.document.getText(), before);
            await vscode.commands.executeCommand('redo');
            assert.equal(opened.document.getText(), after);
            assert.ok(await opened.document.save());
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            const reopened = await vscode.workspace.openTextDocument(opened.uri);
            assert.equal(reopened.getText(), after);
            const editor = await vscode.window.showTextDocument(reopened);
            assert.deepEqual(api.buildKeywordOptionViewModel(editor, opened.line, { provisional: true })
                .managerCards.map(card => card.cardIndex), expectedCards);
            result.controller = { name: controller, value };
            result.visibleCardsAfter = expectedCards;
        });
    }
}

module.exports = { checkSafety, sharedByteFixture };
