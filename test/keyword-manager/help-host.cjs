const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
exports.run = async () => {
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    await extension.activate();
    const api = require(path.join(extension.extensionPath, 'out/extension'))._internals;
    const ks = require(path.join(extension.extensionPath, 'out/core/keywordSchema'));
    const schema = ks.loadKeywordSchema(() => 'zh');
    const root = process.env.KEYWORD_HELP_EVIDENCE;
    const fixed = values => values.map(value => String(value).padStart(10)).join('').padEnd(80);
    const cases = [
        { keyword: 'CONTACT_AUTOMATIC_SINGLE_SURFACE_ID', lines: [
                '         1Contact help verification'.padEnd(80),
                fixed([1, 2, 0, 2, 0, 0, 0, 0]), fixed([0.1, 0.1, 0, 0, 0, 0, 0, 0]), fixed([1, 1, 0, 0, 1, 1, 0, 0]),
            ], name: 'SURFA', schemaName: 'SSID' },
        { keyword: 'ALE_STRUCTURED_MESH_VOLUME_FILLING', lines: [
                fixed([1, 0, 1, 0, 1, 0, 0, 0]), fixed(['PART', 0, 1, 0, 0, 0, 0]),
            ], name: 'PID', schemaName: 'PID' },
    ];
    for (const fixture of require('./help-branch-fixtures.cjs').filter(fixture => ['mat-elastic','mat-fluid','trim-partset','trim-sphere'].includes(fixture.id))) {
        cases.push({ keyword: fixture.keyword,
            lines: [...(fixture.header ? ['$#' + fixture.header.map((name,index)=>name.padStart(index===0?8:10)).join('')] : []), ...fixture.lines],
            name: fixture.field, schemaName: fixture.reason ? undefined : fixture.field,
            reason: fixture.reason, schemaKeyword: fixture.source });
    }
    const results = [];
    for (const fixture of cases) {
        const file = path.join(root, `${fixture.keyword}-${results.length}.k`);
        const before = [`*${fixture.keyword}`, ...fixture.lines, '*END'].join('\n');
        fs.writeFileSync(file, before);
        const document = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');
        const model = api.buildKeywordOptionViewModel(editor, 0, {});
        const selected = model.managerCards.flatMap(card => card.fields).find(field => field.name === fixture.name);
        assert.ok(selected, `${fixture.keyword}: native field ${fixture.name}`);
        const help = api.keywordManagerHelpState({ ...model, selectedFieldId: selected.fieldId });
        assert.equal(help.schemaName, fixture.schemaName);
        assert.equal(help.reason, fixture.reason);
        if (fixture.schemaKeyword) assert.equal(help.schemaKeyword, fixture.schemaKeyword);
        if (fixture.reason) assert.ok(!help.english && !help.localized);
        else assert.ok(help.english || help.localized);
        const cardInfo = ks.getCardInfoForDocumentLine(document, selected.line, schema);
        const field = cardInfo?.card?.find(field => field.p === selected.position && field.w === selected.width);
        if (fixture.keyword.startsWith('CONTACT')) {
            assert.equal(help.english, ks.getEnglishFieldHelp(field));
            assert.equal(help.localized, ks.getLocalizedFieldHelp(field));
        }
        assert.equal(document.getText(), before);
        assert.equal(fs.readFileSync(file, 'utf8'), before);
        results.push({ keyword: fixture.keyword, name: selected.name, schemaName: help.schemaName, status: help.status, reason: help.reason, schemaKeyword: help.schemaKeyword, sourceUnchanged: true });
    }
    fs.writeFileSync(path.join(root, 'help-results.json'), JSON.stringify(results, null, 2));
    // Exercise real WorkspaceEdit/save/close/reopen using the extracted choices.
    const handoff = require('../fixtures/public-behavior/trim-record-selection.json');
    const trimFile = path.join(root, 'trim-mixed-roundtrip.k');
    const rows = handoff.recordSelection.cases.map((item, i) => `${i+1},${item.value},,,${101+i},${201+i},${301+i},${401+i}`);
    const before = [`*${handoff.keyword}`, ...rows, '*END'].join('\n');
    fs.writeFileSync(trimFile, before);
    let document = await vscode.workspace.openTextDocument(trimFile);
    let editor = await vscode.window.showTextDocument(document);
    let model = api.buildKeywordOptionViewModel(editor, 0, {});
    assert.equal(model.managerCards.length, rows.length);
    function edit(row, index, value) {
        const staged = api.keywordManagerEditField(model, model.managerCards[row].fields[index].fieldId, value);
        assert.ok(staged);
        model = api.buildKeywordOptionViewModel(editor, 0, staged);
        assert.equal(model.plan.status, 'ready', model.plan.reason);
    }
    edit(0, 1, 'SPHERE');
    edit(0, 4, '42');
    assert.equal(document.getText(), before);
    assert.equal(fs.readFileSync(trimFile, 'utf8'), before);
    assert.ok(await api.applyKeywordOptionViewModel({ getModel: () => model, markStale() {} }, editor));
    // The native serializer writes the edited row in its fixed-width format.
    assert.equal(document.getText().split(/\r?\n/)[1], fixed([1, 'SPHERE', '', '', 42]));
    assert.deepEqual(document.getText().split(/\r?\n/).slice(2), [...rows.slice(1), '*END']);
    await vscode.window.showTextDocument(document, { preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), before);
    await vscode.commands.executeCommand('redo');
    await document.save();
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    document = await vscode.workspace.openTextDocument(trimFile);
    editor = await vscode.window.showTextDocument(document);
    model = api.buildKeywordOptionViewModel(editor, 0, {});
    assert.equal(model.managerCards[0].fields[4].name, 'NID');
    assert.equal(model.managerCards[0].fields[4].value, '42');
    assert.deepEqual(model.managerCards[0].fields.slice(5).map(field => field.value), ['', '', '']);
    assert.deepEqual(document.getText().split(/\r?\n/).slice(2), [...rows.slice(1), '*END']);
    const selectedFieldId = model.managerCards[0].fields[4].fieldId;
    const focused = api.buildKeywordOptionViewModel(editor, 0, { selectedFieldId });
    fs.writeFileSync(path.join(root, 'trim-webview-state.json'), JSON.stringify(api.buildKeywordOptionsViewState(focused), null, 2));
    fs.writeFileSync(path.join(root, 'trim-roundtrip-results.json'), JSON.stringify({ choices: rows.length,
        nativeFields: model.managerCards.map(card => card.fields.map(field => field.name)),
        apply: true, undo: true, redo: true, saveAndReopen: true, otherRowsUnchanged: true }, null, 2));
    console.log(JSON.stringify(results));
    await require('./remaining-host.cjs')(api, root);
};
