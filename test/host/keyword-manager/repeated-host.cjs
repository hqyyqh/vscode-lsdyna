'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');
module.exports = async (root, api, results) => {
    for (const keyword of ['LOAD_POINT_UVW', 'LOAD_POINT_UVW_SET', 'INTERFACE_COMPENSATION_3D_FLANGE', 'ELEMENT_SEATBELT', 'ELEMENT_TSHELL']) {
        const catalog = api.getCatalogInputFormCatalogV4();
        await catalog.prepareKeyword(keyword);
        const form = catalog.formForKeyword(keyword);
        const card = form.rules[form.reference.formRuleIds[0]].cards[0];
        const lines = ['*' + keyword, ...[1, 2, 3].flatMap(id => {
            const row = Array(Math.max(...card.fields.map(field => field.position + field.width))).fill(' ');
            for (const field of card.fields) row.splice(field.position, field.width,
                ...String(field.position ? 1 : id).padStart(field.width));
            return ['$# Wrong, ignored title', row.join('')];
        }), '*END'];
        for (const occurrence of [0, 1, 2]) for (let index = 0; index < card.fields.length; index++) {
            const before = lines.join('\n') + '\n';
            const file = path.join(root, 'workspace', keyword + '-' + occurrence + '-' + index + '.k');
            fs.writeFileSync(file, before);
            const document = await vscode.workspace.openTextDocument(file);
            const editor = await vscode.window.showTextDocument(document);
            const model = api.buildKeywordOptionViewModel(editor, 0, {});
            assert.equal(model.managerCards.length, 3);
            assert.equal(model.plan.status, 'no-change');
            const selected = model.managerCards[occurrence];
            const hover = api.getCardInfoForDocumentLineWithSuggest(document, selected.line).cardInfo;
            assert.deepEqual(hover.card.map(field => field.n), selected.fields.map(field => field.name));
            const drafts = api.keywordManagerEditField(model, selected.fields[index].fieldId, '7');
            assert.ok(drafts);
            const drafted = api.buildKeywordOptionViewModel(editor, 0, drafts);
            assert.equal(api.buildKeywordOptionsViewState(drafted).canApply, true);
            assert.equal(document.getText(), before);
            assert.equal(api.buildKeywordOptionViewModel(editor, 0, {}).plan.status, 'no-change');
            assert.ok(await api.applyKeywordOptionViewModel({ getModel: () => drafted, markStale() {} }, editor));
            const expected = [...lines], field = card.fields[index], line = 2 + occurrence * 2;
            expected[line] = expected[line].slice(0, field.position) + '7'.padStart(field.width) + expected[line].slice(field.position + field.width);
            const after = expected.join('\n') + '\n';
            assert.equal(document.getText(), after);
            await require("../../support/keyword-manager/document-history.cjs")(document, 'undo', before);
            await require("../../support/keyword-manager/document-history.cjs")(document, 'redo', after);
            assert.ok(await document.save());
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            const reopened = await vscode.workspace.openTextDocument(file);
            assert.equal(reopened.getText(), after);
            const reopenedEditor = await vscode.window.showTextDocument(reopened);
            const reopenedModel = api.buildKeywordOptionViewModel(reopenedEditor, 0, {});
            assert.equal(reopenedModel.managerCards[occurrence].fields[index].value, '7');
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            results.push({ name: keyword, occurrence, field: field.name, apply: true, undo: true, redo: true,
                saveReopen: true, discardedDraftUnchanged: true, hover: true, passed: true });
        }
        for (const [format, marker, row] of [['long', ' +', lines[2]], ['i10', ' %', lines[2]], ['comma', '', '1,2,3']]) {
            const before = ['*' + keyword + marker, row, '*END', ''].join('\n');
            const file = path.join(root, 'workspace', keyword + '-' + format + '.k');
            fs.writeFileSync(file, before);
            const document = await vscode.workspace.openTextDocument(file);
            const editor = await vscode.window.showTextDocument(document);
            const model = api.buildKeywordOptionViewModel(editor, 0, {});
            assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
            assert.equal(model.managerCards.length, 0);
            assert.equal(api.getCardInfoForDocumentLineWithSuggest(document, 1).cardInfo, null);
            assert.equal(document.getText(), before);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            results.push({ name: keyword, format, unsupportedFormatBlocked: true, passed: true });
        }
    }

    for (const family of ['BEAM','DISCRETE','NODE','PART','SEGMENT','SHELL','SOLID']) {
        for (const occurrence of [0, 1, 2]) {
            const keyword = '*SET_' + family + '_ADD';
            const header = ['NODE','PART'].includes(family) ? [8000002,0,0,0,0,'MECH'] :
                family === 'SOLID' ? [8000002,'MECH'] : [8000002];
            const lines = [keyword, header.map(value => String(value).padStart(10)).join(''),
                '$ first', '   2000106', '$# deliberately wrong SID', '   2000105', '$ last', '   2000104', '*END'];
            const before = lines.join('\n') + '\n';
            const file = path.join(root, 'workspace', family + '-' + occurrence + '.k');
            fs.writeFileSync(file, before);
            const document = await vscode.workspace.openTextDocument(file);
            const editor = await vscode.window.showTextDocument(document);
            const base = api.buildKeywordOptionViewModel(editor, 0, {});
            const field = base.managerCards.filter(card => card.cardIndex === 2)[occurrence].fields[0];
            const drafts = api.keywordManagerEditField(base, field.fieldId, '3000001');
            assert.ok(drafts);
            const staged = api.buildKeywordOptionViewModel(editor, 0, drafts);
            assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true);
            assert.equal(document.getText(), before, 'staging must not write');
            assert.equal(api.buildKeywordOptionViewModel(editor, 0, {}).plan.status, 'no-change', 'discarding drafts must not write');
            assert.ok(await api.applyKeywordOptionViewModel({ getModel: () => staged, markStale() {} }, editor));
            const expected = [...lines];
            expected[3 + occurrence * 2] = '   3000001'.padEnd(80);
            const after = expected.join('\n') + '\n';
            assert.equal(document.getText(), after);
            await vscode.commands.executeCommand('undo');
            assert.equal(document.getText(), before, 'one undo must restore every byte');
            await require("../../support/keyword-manager/document-history.cjs")(document, 'redo', after);
            assert.ok(await document.save());
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            const reopened = await vscode.workspace.openTextDocument(file);
            assert.equal(reopened.getText(), after);
            const reopenedEditor = await vscode.window.showTextDocument(reopened);
            const model = api.buildKeywordOptionViewModel(reopenedEditor, 0, {});
            assert.equal(model.plan.status, 'no-change');
            assert.equal(model.managerCards.filter(card => card.cardIndex === 2)[occurrence].fields[0].value, '3000001');
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            results.push({ name: keyword, occurrence, apply: true, undo: true, redo: true,
                saveReopen: true, discardedDraftUnchanged: true, passed: true });
        }
    }
};
