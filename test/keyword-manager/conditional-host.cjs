'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vscode = require('vscode');

async function checkConditionalCards(root, api, results) {
    const { families, fixture, sample, indexes } = require('./conditional-fixtures.cjs')({ vscode, generateCommentLine: api.generateCommentLine });
    const catalog = api.getCatalogInputFormCatalogV4();
    const { nativeFileReadContext } = require(path.join(vscode.extensions.getExtension('hqyyqh.dynasense').extensionPath,
        'out/core/semantics/nativeFileReadContext'));
    await checkPresentationProblems(root, api, results);
    for (const keyword of families) {
        const form = catalog.formForKeyword(keyword), rule = form.rules[form.reference.fieldRuleIds[0]];
        assert.equal(form.source.isUnauditedDiagnostic, false);
        const native = form.reference.formRuleIds.map(id => form.rules[id]).find(item => item.cardSetId === rule.cardSetId);
        const tested = new Set();
        for (const from of rule.states) for (const to of rule.states) {
            const diffs = from.domainIndexes.map((value, index) => value === to.domainIndexes[index] ? -1 : index).filter(index => index >= 0);
            if (diffs.length !== 1 || from.cardIndexes.join() === to.cardIndexes.join()) continue;
            const dim = diffs[0], control = rule.controllerFields.find(c => c.controllerId === rule.domains[dim].controllerId);
            if (tested.has(control.name) || !from.cardIndexes.includes(control.cardIndex) || !to.cardIndexes.includes(control.cardIndex)) continue;
            // Choose a transition without populated discarded controller fields,
            // so the host test does not require an unattended destructive dialog.
            const discardedController = rule.controllerFields.some(c => !to.cardIndexes.includes(c.cardIndex) &&
                sample(rule.domains.find(d => d.controllerId === c.controllerId).intervals[
                    from.domainIndexes[rule.domains.findIndex(d => d.controllerId === c.controllerId)]]) !== 0);
            if (discardedController) continue;
            const number = sample(rule.domains[dim].intervals[to.domainIndexes[dim]]);
            const field = native.cards.find(c => c.cardIndex === control.cardIndex).fields[control.fieldIndex];
            const value = (field.choices || []).find(choice => Number(choice) === number) ?? String(number);
            const select = text => nativeFileReadContext({ ...native, catalogSource: form.source }, '*' + keyword,
                text.split('\n').filter(line => !line.startsWith('$') && !line.startsWith('*')), 'standard').select(false,
                (record, index, raw) => record.cardIndex === control.cardIndex && index === control.fieldIndex ? value : raw);
            // Select a physically valid source for the positive host transition. Full pools
            // are tested below as negative cases whenever the native reader rejects them.
            if (![false, true].some(full => select(fixture(keyword, native, rule, from, full).getText())?.current)) continue;
            tested.add(control.name);
            for (const full of [false, true]) {
                const result = { name: 'conditional-apply-undo-redo-save-reopen', keyword, controller: control.name, value, full, passed: false };
                results.push(result);
                try {
                    const before = fixture(keyword, native, rule, from, full).getText();
                    const file = path.join(root, 'workspace', `${keyword}-${control.name}-${full}.k`);
                    fs.writeFileSync(file, before);
                    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                    const editor = await vscode.window.showTextDocument(document);
                    const base = api.buildKeywordOptionViewModel(editor, 0, {});
                    const fieldId = base.managerCards.find(card => card.cardIndex === control.cardIndex)?.fields[control.fieldIndex]?.fieldId
                        || `lspp-input:${keyword}:card:${control.cardIndex}:field:${control.fieldIndex}`;
                    const model = api.buildKeywordOptionViewModel(editor, 0, { fieldDrafts: {
                        [fieldId]: value,
                    } });
                    const view = api.buildKeywordOptionsViewState(model);
                    const selection = select(before);
                    if (!selection?.current) {
                        assert.equal(model.plan.status, 'blocked');
                        assert.equal(view.canApply, false);
                        assert.equal(document.getText(), before);
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                        result.name = 'invalid-physical-pool-remains-readonly';
                        result.passed = true;
                        continue;
                    }
                    const targetIndexes = (selection.target || selection.current).map(record => record.cardIndex);
                    assert.deepEqual(indexes(model), targetIndexes);
                    assert.equal(view.canApply, true, model.plan.reason);
                    assert.deepEqual(view.branchSummary.draft.filter(index => index !== 0), targetIndexes);
                    if (keyword === 'MAT_BARLAT_YLD2000') assert.ok(view.manualConditions.some(group => group.condition === 'FIT = 1'));
                    assert.ok(await api.applyKeywordOptionViewModel({ getModel: () => model, markStale() {} }, editor));
                    const after = document.getText();
                    assert.notEqual(after, before);
                    await vscode.commands.executeCommand('undo');
                    assert.equal(document.getText(), before);
                    await vscode.commands.executeCommand('redo');
                    assert.equal(document.getText(), after);
                    assert.equal(await document.save(), true);
                    assert.equal(fs.readFileSync(file, 'utf8'), after);
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    const reopened = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                    assert.equal(reopened.getText(), after);
                    const reopenedEditor = await vscode.window.showTextDocument(reopened);
                    const refreshed = api.buildKeywordOptionViewModel(reopenedEditor, 0, {});
                    assert.deepEqual(indexes(refreshed), targetIndexes);
                    assert.notEqual(refreshed.plan.status, 'blocked', refreshed.plan.reason);
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    result.passed = true;
                } catch (error) { result.error = error.stack || String(error); }
            }
        }
        assert.ok(tested.size, keyword);
    }
}
module.exports = { checkConditionalCards };

async function checkPresentationProblems(root, api, results) {
    const result = { name: 'conditional presentation and Problems lifecycle', passed: false }; results.push(result);
    const fixed = values => Array.from({ length: 8 }, (_, i) => String(values[i] ?? '').padStart(10)).join('');
    const before = ['*MAT_WINFRITH_CONCRETE', fixed([1,2,3,4,5,6,7,8]), fixed([1,2,3,4,8,6,7,8]),
        fixed([.1,.2,.3,.4,.5,.6,.7,.8]), fixed([1.1,1.2,1.3,1.4,1.5,1.6,1.7,1.8]), '*END'].join('\n');
    const file = path.join(root, 'workspace', 'structure-problems.k'); fs.writeFileSync(file, before);
    const uri = vscode.Uri.file(file);
    const errors = () => vscode.languages.getDiagnostics(uri).filter(item => item.code === 'keyword-structure');
    const waitFor = async (predicate, label) => {
        const until = Date.now() + 10000;
        while (Date.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
        assert.fail(label);
    };
    try {
        const document = await vscode.workspace.openTextDocument(uri), editor = await vscode.window.showTextDocument(document);
        await waitFor(() => errors().length === 1, 'automatic definite error must reach Problems');
        assert.equal(errors()[0].range.start.line, 0);
        await vscode.commands.executeCommand('extension.checkKeywordStructure', {
            uri: api.documentUriIdentity(document), documentVersion: document.version, keywordLine: 0,
        });
        assert.equal(errors().length, 1);
        const edit = new vscode.WorkspaceEdit(); edit.replace(uri, new vscode.Range(0, 0, document.lineCount - 1, 4), '*NODE\n         1         0         0         0\n*END');
        assert.ok(await vscode.workspace.applyEdit(edit));
        await waitFor(() => errors().length === 0, 'edits must clear obsolete errors');
        await vscode.commands.executeCommand('undo');
        assert.equal(document.getText(), before);
        await waitFor(() => errors().length === 1, 'undo must refresh Problems');
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        await waitFor(() => errors().length === 0, 'close must clear Problems');
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        result.passed = true;
    } catch (error) { result.error = error.stack || String(error); }
}
