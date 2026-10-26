'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.checkStartupSafety = async (root, api, results) => {
    // VS Code's extension loader and the test driver's require can use different
    // Windows path casing. Gate the live runtime, not only the driver's module copy.
    const prototypes = [...new Set(Object.values(require.cache)
        .filter(module => /[/\\](?:lspp|catalog)InputFormCatalogV4\.js$/i.test(module.filename))
        .map(module => module.exports.CatalogInputFormCatalogV4?.prototype).filter(Boolean))];
    assert.ok(prototypes.length);
    for (const scenario of ['switch', 'close', 'close-draft', 'edit']) {
        let release, entered;
        const gate = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { entered = resolve; });
        const seen = [];
        const originals = prototypes.map(prototype => prototype.prepareKeyword);
        try {
            prototypes.forEach((prototype, index) => {
                prototype.prepareKeyword = async function(keyword) {
                    seen.push(keyword);
                    if (keyword.replace(/^\*/, '') === 'MAT_ELASTIC') { entered(); await gate; }
                    return originals[index].call(this, keyword);
                };
            });
            const file = path.join(root, 'workspace', `startup-${scenario}.k`);
            const text = '*DATABASE_BINARY_BLSTFOR\n10,1,1,1,1\n*MAT_ELASTIC\n         7    7.8e-9    210000       0.3\n*END\n';
            fs.writeFileSync(file, text);
            const doc = await vscode.workspace.openTextDocument(file);
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            editor.selection = new vscode.Selection(0, 0, 0, 0);
            const model = await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');
            assert.ok(model);
            assert.equal(model.directoryStatus, 'loading');
            assert.equal(model.managerCards[0].fields[0].value, '10');
            await Promise.race([started, delay(10000).then(() => { throw Error(`Directory preparation never started: ${JSON.stringify({ seen, status: model.directoryStatus, instances: model.managerInstances.length })}`); })]);
            if (scenario === 'close-draft') {
                // Retain a host-accepted draft across disposal, without changing the source document.
                const field = model.managerCards[0].fields[0];
                model.fieldDrafts[field.fieldId] = '12';
                field.draft = '12';
            }
            if (scenario === 'switch') {
                const nextFile = path.join(root, 'workspace', 'startup-next.k');
                fs.writeFileSync(nextFile, '*DATABASE_BINARY_BLSTFOR\n20,1,1,1,1\n*END\n');
                const nextDoc = await vscode.workspace.openTextDocument(nextFile);
                const nextEditor = await vscode.window.showTextDocument(nextDoc, vscode.ViewColumn.One);
                nextEditor.selection = new vscode.Selection(0, 0, 0, 0);
                const next = await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');
                release();
                const until = Date.now() + 10000;
                while (next.directoryStatus === 'loading' && Date.now() < until) await delay(10);
                assert.equal(next.directoryStatus, 'ready');
                assert.equal(next.managerCards[0].fields[0].value, '20');
                assert.ok(next.managerInstances.every(instance => instance.uri === api.documentUriIdentity(nextDoc)));
            } else {
                if (scenario.startsWith('close')) await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                else await editor.edit(builder => builder.replace(new vscode.Range(1, 0, 1, 2), '30'));
                release();
                await delay(100);
                assert.equal(model.directoryStatus, 'loading', 'An invalidated task must not publish completion to the old model');
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                const reopened = await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions', 0);
                assert.ok(reopened);
                assert.equal(reopened.managerCards[0].fields[0].value, scenario === 'edit' ? '30' : '10');
                if (scenario === 'close-draft') {
                    assert.strictEqual(reopened, model, 'Reopening must retain the staged model');
                    const until = Date.now() + 10000;
                    while (reopened.directoryStatus === 'loading' && Date.now() < until) await delay(10);
                    assert.equal(reopened.directoryStatus, 'ready');
                    assert.equal(reopened.managerCards[0].fields[0].draft, '12');
                }
            }
            assert.equal(doc.getText(), scenario === 'edit' ? text.replace('10,', '30,') : text);
            results.push({ startup: scenario, passed: true });
            if (scenario === 'close-draft') {
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                await vscode.commands.executeCommand('extension.keywordOptions.reset');
            }
        } finally { release(); prototypes.forEach((prototype, index) => { prototype.prepareKeyword = originals[index]; }); }
    }
};
