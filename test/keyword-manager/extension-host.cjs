'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const dataLines = text => text.split(/\r?\n/).filter(line => line.trim() && !line.trimStart().startsWith('$'));

async function run() {
    const root = process.env.KEYWORD_MANAGER_HOST_EVIDENCE;
    assert.ok(root);
    const results = [];
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    assert.ok(extension, 'development extension must be loaded');
    await extension.activate();
    const manifestPath = path.join(extension.extensionPath, 'out/runtime',
        fs.existsSync(path.join(extension.extensionPath, 'out/runtime/catalog-input-form/manifest.json'))
            ? 'catalog-input-form' : 'lspp-input-form', 'manifest.json');
    const diagnostic = process.env.KEYWORD_MANAGER_DIAGNOSTIC === '1';
    const injection = diagnostic ? require('./unpublished-catalog.cjs') : {
        manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
        candidateSource: null,
        restore() {},
    };
    const entryPath = path.join(extension.extensionPath, 'out/extension.js');
    const loadedEntry = Object.keys(require.cache).find(file => file.toLowerCase() === entryPath.toLowerCase());
    assert.ok(loadedEntry, 'use the activated extension module without loading a second Windows path casing');
    const api = require.cache[loadedEntry].exports._internals;
    fs.writeFileSync(path.join(root, 'loaded-runtime-modules.json'), JSON.stringify(Object.keys(require.cache)
        .filter(file => /(?:extension|(?:catalog|lspp)InputFormCatalogV4)\.js$/i.test(file)), null, 2));
    let restorePreparation, releasePreparation;
    try {
        if (process.env.KEYWORD_MANAGER_REPEATED === '1') {
            await require('./repeated-host.cjs')(root, api, results);
        } else if (process.env.KEYWORD_MANAGER_EXPLICIT === '1') {
            await require('./explicit-navigation-host.cjs').checkExplicitNavigation(root, api, results);
            return;
        } else if (process.env.KEYWORD_MANAGER_STARTUP_SAFETY === '1') {
            await require('./startup-host.cjs').checkStartupSafety(root, api, results);
            return;
        } else if (process.env.KEYWORD_MANAGER_CONDITIONAL === '1') {
            await require('./conditional-host.cjs').checkConditionalCards(root, api, results);
        } else
        if (process.env.KEYWORD_MANAGER_SAFETY === '1') {
            await require('./host-safety.cjs').checkSafety(root, api, results);
        } else
        if (process.env.KEYWORD_MANAGER_GUI === '1') {
            const comments = process.env.KEYWORD_MANAGER_GUI_COMMENTS;
            const incomplete = process.env.KEYWORD_MANAGER_GUI_INCOMPLETE === '1';
            const repeated = !!process.env.KEYWORD_MANAGER_GUI_REPEAT;
            const unverified = process.env.KEYWORD_MANAGER_GUI_REPEAT === 'unverified';
            const standardRepeat = process.env.KEYWORD_MANAGER_GUI_REPEAT === 'standard';
            const shared = process.env.KEYWORD_MANAGER_GUI_SHARED === '1'
                ? require('./host-safety.cjs').sharedByteFixture() : null;
            const uri = vscode.Uri.file(path.join(root, 'workspace', shared ? 'shared-byte.k' : 'standard-curve.k'));
            if (shared) fs.writeFileSync(uri.fsPath, shared.text);
            const templateLines = incomplete ? [...require(path.join(extension.extensionPath, 'snippets/lsdyna.json'))['*MAT_DAMAGE_1_TITLE'].body
                .map(line => line.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '')), '*END'] : null;
            if (templateLines) {
                // Explicit invalid source values: current built-in snippets correctly use blank defaults.
                templateLines[2] = 'TITLE'.padEnd(80);
                templateLines[4] = templateLines[4].slice(0, 10) + 'RO'.padStart(10) + 'E'.padStart(10) + templateLines[4].slice(30);
            }
            const template = templateLines?.join('\r\n');
            if (incomplete) fs.writeFileSync(uri.fsPath, template);
            const commentText = comments ? require('./comment-fixture.cjs').specimen(comments === 'missing', comments === 'missing' ? 'wrong' : comments).join('\n') : null;
            if (comments) fs.writeFileSync(uri.fsPath, commentText);
            const repeatedText = standardRepeat ? ['*LOAD_POINT_UVW', ...[1,2,3].flatMap(id => ['$# WRONG, TITLE', [id,1,1].map(value => String(value).padStart(10)).join('')]), '*END'].join('\n') : unverified ? ['*MAT_DAMAGE_1', '         1', '', '', '', '', '', 'unassigned record', '*END'].join('\n') : ['*SET_PART_ADD', '   8000002         0         0         0         0      MECH',
                '$ first', '   2000106', '$# deliberately wrong SID', '   2000105', '$ last', '   2000104', '*END'].join('\n');
            if (repeated) fs.writeFileSync(uri.fsPath, repeatedText);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document);
            const line = document.getText().split(/\r?\n/).findIndex(text =>
                text === (standardRepeat ? '*LOAD_POINT_UVW' : unverified ? '*MAT_DAMAGE_1' : repeated ? '*SET_PART_ADD' : comments ? '*MAT_BARLAT_YLD2000' : incomplete ? '*MAT_DAMAGE_1_TITLE' : shared ? `*${shared.keyword}` : '*DEFINE_CURVE_TITLE'));
            editor.selection = new vscode.Selection(line, 0, line, 0);
            await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');
            await vscode.commands.executeCommand('workbench.action.closeSidebar');
            await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
            fs.writeFileSync(path.join(root, 'gui-ready.json'), JSON.stringify({
                hostLanguage: vscode.env.language,
                source: uri.fsPath, keywordLine: line, beforeSha256: hash(document.getText()),
                scope: diagnostic ? 'diagnostic GUI with unpublished data' : 'published catalog with default product settings',
            }));
            await new Promise((resolve, reject) => {
                if (fs.existsSync(path.join(root, 'gui-finish.json'))) { resolve(); return; }
                let lastEditorRequest;
                const watcher = fs.watch(root, async (_event, name) => {
                    if (String(name) === 'editor-request.json') {
                        try {
                            const request = JSON.parse(fs.readFileSync(path.join(root, String(name)), 'utf8'));
                            if (request.id === lastEditorRequest) return;
                            lastEditorRequest = request.id;
                            await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
                            await vscode.commands.executeCommand('hideSuggestWidget');
                            await vscode.commands.executeCommand('editor.action.hideHover');
                            const keywordHover = request.action === 'keyword-hover';
                            const file = path.join(root, 'workspace', keywordHover ? 'keyword-options.k' : 'editor-acceptance.k');
                            if (!fs.existsSync(file)) fs.writeFileSync(file, keywordHover
                                ? '*KEYWORD\n*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE\n*END\n'
                                : '*KEYWORD\n*MAT_DAMAGE_1\n' + ' '.repeat(80) + '\n' + ' '.repeat(70) + '0'.padStart(10) + '\n*INCLUDE\nmissing-ui.k\n*END\n');
                            const target = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                            const targetEditor = await vscode.window.showTextDocument(target);
                            targetEditor.selection = keywordHover ? new vscode.Selection(1, 10, 1, 10) : new vscode.Selection(3, 75, 3, 75);
                            targetEditor.revealRange(new vscode.Range(0, 0, 6, 0));
                            if (request.action === 'prepare-waiting' || request.action === 'prepare-failure') {
                                restorePreparation?.(); releasePreparation?.();
                                const catalog = Object.getPrototypeOf(api.getCatalogInputFormCatalogV4()), original = catalog.prepareKeyword;
                                const gate = new Promise(resolve => { releasePreparation = resolve; });
                                // Test-only delay/failure injection; successful preparation still runs every production validation.
                                catalog.prepareKeyword = async function (...args) {
                                    fs.appendFileSync(path.join(root, 'injected-preparation.jsonl'), JSON.stringify({ action: request.action, args }) + '\n');
                                    if (request.action === 'prepare-failure') throw Error('Injected preparation read failure');
                                    await gate;
                                    return original.apply(this, args);
                                };
                                restorePreparation = () => { catalog.prepareKeyword = original; };
                                await targetEditor.edit(edit => edit.replace(new vscode.Range(3, 79, 3, 80), target.lineAt(3).text[79] === '1' ? '0' : '1'));
                                void vscode.commands.executeCommand('extension.pickOfficialFieldValue');
                            }
                            if (request.action === 'prepare-stale') {
                                targetEditor.selection = new vscode.Selection(5, 0, 5, 0);
                                restorePreparation?.(); releasePreparation?.();
                            }
                            if (request.action === 'prepare-retry') {
                                restorePreparation?.(); releasePreparation?.();
                                void vscode.commands.executeCommand('extension.pickOfficialFieldValue');
                            }
                            if (request.action === 'hover' || keywordHover) {
                                await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                                await vscode.commands.executeCommand('editor.action.showHover');
                            }
                            if (request.action === 'completion') await vscode.commands.executeCommand('editor.action.triggerSuggest');
                            if (request.action === 'choices') void vscode.commands.executeCommand('extension.pickOfficialFieldValue');
                            if (request.action === 'sidebar') await vscode.commands.executeCommand('lsdynaEntityReferences.focus');
                            if (request.action === 'marks') await targetEditor.edit(edit => edit.replace(new vscode.Range(3, 79, 3, 80), '1'));
                            if (request.action === 'include-created') fs.writeFileSync(path.join(root, 'workspace', 'missing-ui.k'), '*KEYWORD\n*END\n');
                            if (request.action === 'include-deleted' && fs.existsSync(path.join(root, 'workspace', 'missing-ui.k')))
                                fs.unlinkSync(path.join(root, 'workspace', 'missing-ui.k'));
                            fs.writeFileSync(path.join(root, 'editor-applied.json'), JSON.stringify({ ...request,
                                version: target.version, text: target.getText(), hostLanguage: vscode.env.language }));
                        } catch (error) {
                            fs.writeFileSync(path.join(root, 'editor-applied.json'), JSON.stringify({ error: String(error) }));
                        }
                        return;
                    }
                    if (String(name) === 'appearance-request.json') {
                        try {
                            const request = JSON.parse(fs.readFileSync(path.join(root, String(name)), 'utf8'));
                            await vscode.workspace.getConfiguration('window').update('zoomLevel', request.zoom, vscode.ConfigurationTarget.Global);
                            await vscode.commands.executeCommand('workbench.action.closeSidebar');
                            await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
                            fs.writeFileSync(path.join(root, 'appearance-applied.json'), JSON.stringify(request));
                        } catch {}
                        return;
                    }
                    if (String(name) === 'theme-request.json') {
                        try {
                            const theme = JSON.parse(fs.readFileSync(path.join(root, String(name)), 'utf8'));
                            await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
                            if ((await vscode.commands.getCommands()).includes('notifications.clearAll'))
                                await vscode.commands.executeCommand('notifications.clearAll');
                            fs.writeFileSync(path.join(root, 'theme-applied.json'), JSON.stringify(theme));
                        } catch {}
                        return;
                    }
                    if (String(name) !== 'gui-finish.json') return;
                    clearTimeout(timer);
                    watcher.close();
                    resolve();
                });
                const timer = setTimeout(() => {
                    watcher.close();
                    reject(new Error('GUI validation reached its ten-minute bound'));
                }, 600_000);
            });
            const expected = JSON.parse(fs.readFileSync(path.join(root, 'gui-finish.json'), 'utf8'));
            if (expected.error) throw Error(expected.error);
            assert.ok(await document.save());
            assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), document.getText());
            const view = api.buildKeywordOptionViewModel(editor, line, { provisional: true });
            const fields = view.managerCards.flatMap(card => card.fields);
            if (unverified) {
                assert.equal(document.getText(), repeatedText);
                assert.equal(view.plan.status, 'blocked');
                assert.equal(editor.selection.active.line, 0);
            } else if (repeated) {
                const after = standardRepeat ? repeatedText.replace('         2', '         7') : repeatedText.replace('   2000105', '   3000001'.padEnd(80));
                assert.equal(document.getText(), after);
                assert.deepEqual(view.managerCards.filter(card => card.cardIndex === (standardRepeat ? 1 : 2)).map(card => card.fields[0].value), standardRepeat ? ['1','7','3'] : ['2000106','3000001','2000104']);
                await require('./document-history.cjs')(document, 'undo', repeatedText);
                await require('./document-history.cjs')(document, 'redo', after);
                assert.ok(await document.save());
            }
            for (const [name, value] of Object.entries(expected.fields || {})) {
                assert.equal(fields.find(field => field.name === name)?.value, value);
            }
            if (incomplete) {
                assert.equal(view.managerCards.length, 7);
                assert.equal(document.getText(), template.replace('        RO', '      7.85'));
                assert.equal(fields.find(field => field.name === 'E').value, 'E');
                assert.ok(fields.find(field => field.name === 'E').editable);
            }
            if (shared) {
                const expectedCards = [...shared.cards];
                expectedCards[1] = expectedCards[1].slice(0, 30) + '12'.padStart(10) + expectedCards[1].slice(40);
                assert.equal(document.getText(), ['*KEYWORD', `*${shared.keyword}`, ...expectedCards, '*END', ''].join('\n'));
            }
            if (comments) {
                if (comments === 'missing') {
                    assert.equal(document.getText(), commentText);
                    assert.equal(view.plan.status, 'blocked');
                    const state = api.buildKeywordOptionsViewState(view);
                    assert.equal(state.layoutDiagnostics[0].expectedRecords, 11);
                    assert.equal(state.layoutDiagnostics[0].actualRecords, 10);
                    const controlLine = state.layoutDiagnostics[0].line;
                    const deadline = Date.now() + 15000;
                    while (editor.selection.active.line !== controlLine && Date.now() < deadline)
                        await new Promise(resolve => setTimeout(resolve, 25));
                    assert.equal(editor.selection.active.line, controlLine, 'Locate must select the actual control record');
                } else {
                    const rows = commentText.split('\n');
                    const dataIndex = rows.findIndex((text, index) => index > 1 && !text.startsWith('$'));
                    rows[dataIndex] = rows[dataIndex].slice(0, 10) + '7.85'.padStart(10) + rows[dataIndex].slice(20);
                    assert.equal(document.getText(), rows.join('\n'));
                    const edited = document.getText();
                    await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, preserveFocus: false });
                    await vscode.commands.executeCommand('undo');
                    assert.equal(document.getText(), commentText);
                    await vscode.commands.executeCommand('redo');
                    assert.equal(document.getText(), edited);
                }
            }
            results.push({ mode: 'GUI', passed: true, afterSha256: hash(document.getText()),
                expectedFields: expected.fields });
            return;
        }
        for (const format of ['standard', 'long', 'i10', 'free']) {
            for (const [family, keyword, fieldName] of [
                ['node', '*NODE', 'X'], ['material', '*MAT_ELASTIC', 'DA'],
                ['curve', '*DEFINE_CURVE_TITLE', 'O1'],
            ]) {
                const record = { format, family, fieldName, passed: false };
                results.push(record);
                try {
                    const uri = vscode.Uri.file(path.join(root, 'workspace', `${format}-${family}.k`));
                    const document = await vscode.workspace.openTextDocument(uri);
                    const editor = await vscode.window.showTextDocument(document);
                    const before = document.getText();
                    record.beforeSha256 = hash(before);
                    const line = before.split(/\r?\n/).findIndex(text =>
                        text.trim().replace(/%$/, '').trim().toUpperCase() === keyword);
                    assert.ok(line >= 0, `keyword absent: ${keyword}`);
                    editor.selection = new vscode.Selection(line, 0, line, 0);
                    const base = api.buildKeywordOptionViewModel(editor, line, { provisional: true });
                    assert.equal(base.inputFormSourceError, '', 'source-locked data should reach the product');
                    const field = base.managerCards.flatMap(card => card.fields)
                        .find(item => item.name.toUpperCase() === fieldName);
                    assert.ok(field, `missing field ${fieldName}: ${base.plan?.reason}`);
                    if (!diagnostic && format === 'free' && family === 'material') {
                        assert.equal(field.editable, false);
                        assert.equal(field.reason, 'field-geometry-unsupported');
                        assert.equal(api.keywordManagerEditField(base, field.fieldId, '0.5'), null);
                        assert.equal(api.buildKeywordOptionsViewState(base).canApply, false);
                        assert.equal(await api.applyKeywordOptionViewModel({ getModel: () => base, markStale() {} }, editor), null);
                        assert.equal(document.getText(), before);
                        assert.equal(hash(fs.readFileSync(uri.fsPath)), record.beforeSha256);
                        record.access = 'readonly';
                        record.reason = field.reason;
                        record.passed = true;
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                        continue;
                    }
                    assert.ok(field.editable, `field blocked: ${field.reason}`);
                    const drafts = api.keywordManagerEditField(base, field.fieldId, '0.5');
                    assert.ok(drafts, 'edit rejected');
                    const model = api.buildKeywordOptionViewModel(editor, line, { ...drafts, provisional: true });
                    const view = api.buildKeywordOptionsViewState(model);
                    assert.equal(view.canApply, true, JSON.stringify(view.preview));
                    assert.equal(model.plan.requiresLossConfirmation, false);
                    const applied = await api.applyKeywordOptionViewModel({ getModel: () => model, markStale() {} }, editor);
                    assert.ok(applied, 'host did not apply');
                    const after = document.getText();
                    record.afterSha256 = hash(after);
                    const beforeRecords = dataLines(before);
                    const afterRecords = dataLines(after);
                    assert.equal(afterRecords.length, beforeRecords.length, 'numeric edit changed record count');
                    const changed = afterRecords.flatMap((text, index) => text !== beforeRecords[index] ? [index] : []);
                    assert.equal(changed.length, 1, 'numeric edit changed more than its data record');
                    record.changedRecord = { before: beforeRecords[changed[0]], after: afterRecords[changed[0]] };
                    const refreshed = api.buildKeywordOptionViewModel(editor, line, { provisional: true });
                    assert.equal(refreshed.managerCards.flatMap(card => card.fields)
                        .find(item => item.fieldId === field.fieldId)?.value, '0.5');
                    await vscode.commands.executeCommand('undo');
                    assert.equal(document.getText(), before, 'one undo must restore all source bytes');
                    await vscode.commands.executeCommand('redo');
                    assert.equal(document.getText(), after, 'one redo must restore the exact edit');
                    assert.ok(await document.save());
                    assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), after);
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    const reopened = await vscode.workspace.openTextDocument(uri);
                    assert.equal(reopened.getText(), after, 'saved document did not reopen byte-identically');
                    record.passed = true;
                } catch (error) {
                    record.error = error.stack || String(error);
                }
            }
        }
    } finally {
        restorePreparation?.(); releasePreparation?.();
        injection.restore();
        fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({
            scope: diagnostic ? 'diagnostic Extension Host with unpublished data' : 'published catalog, default product settings, development Extension Host',
            vscodeVersion: vscode.version, hostLanguage: vscode.env.language,
            installedVsix: !!process.env.LSDYNA_INSTALLED_EXTENSION_PATH,
            publishedCatalogUsed: !diagnostic, formalReleaseAccepted: false,
            candidateSource: injection.candidateSource,
            manifestSha256: hash(fs.readFileSync(manifestPath)),
            results,
        }, null, 2));
    }
    const failures = results.filter(item => !item.passed);
    console.log(JSON.stringify({ cases: results.length, passed: results.length - failures.length,
        failures: failures.map(item => ({ name: item.name, format: item.format, family: item.family, error: item.error })) }));
    assert.equal(failures.length, 0, 'See preserved host result.json for the exact failed operations');
}

module.exports = { run };
