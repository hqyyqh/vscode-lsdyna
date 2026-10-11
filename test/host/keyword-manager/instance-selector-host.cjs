'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function checkInstanceSelector(root, api, results) {
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    const loaded = relative => {
        const target = path.join(extension.extensionPath, 'out', relative).toLowerCase();
        const file = Object.keys(require.cache).find(file => file.toLowerCase() === target);
        assert.ok(file, 'use the activated product module: ' + relative);
        return require.cache[file].exports;
    };
    const Provider = loaded('client/KeywordOptionsWebviewProvider.js').KeywordOptionsWebviewProvider;
    const catalog = Object.getPrototypeOf(api.getCatalogInputFormCatalogV4());
    const originalPrepare = catalog.prepareKeyword;
    const schema = loaded('core/keywordSchema.js');
    const originalLookup = schema.lookupKeywordSchema;
    const originalShow = Provider.prototype.showPanel;
    const originalWarning = vscode.window.showWarningMessage;
    let provider;
    let preparationGate, readonlyProvider, readonlyEvents, lastRequest;
    const until = async predicate => {
        const deadline = Date.now() + 10000;
        while (!predicate()) { if (Date.now() > deadline) throw Error('Selector host state timed out'); await delay(20); }
    };
    Provider.prototype.showPanel = function (...args) { provider = this; return originalShow.apply(this, args); };
    const uri = vscode.Uri.file(path.join(root, 'workspace', 'instance-selection.k'));
    const fixed = values => values.map(value => String(value).padStart(10)).join('');
    const text = ['*KEYWORD', '*MAT_ELASTIC_TITLE', 'Reviewed steel', fixed([9,7.85,210000,0.3,0,0,0,0]),
        '*MAT_ELASTIC', fixed([2,2.7,70000,0.33,0,0,0,0]), '*DATABASE_SLEOUT', fixed([0.01,1,12,0]),
        '*MAT_ELASTIC', fixed([2,1.1,5000,0.35,0,0,0,0]), '*END'].join('\n');
    fs.writeFileSync(uri.fsPath, text);
    const document = await vscode.workspace.openTextDocument(uri);
    let editor = await vscode.window.showTextDocument(document);
    const open = async line => {
        editor = await vscode.window.showTextDocument(document);
        editor.selection = new vscode.Selection(line, 0, line, 0);
        const model = await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');
        const deadline = Date.now() + 10000;
        while (provider.getState().directoryStatus === 'loading' && Date.now() < deadline) await delay(20);
        assert.equal(provider.getState().directoryStatus, 'ready');
        return model;
    };
    try {
        await open(1);
        let state = provider.getState();
        assert.equal(state.instances.length, 3);
        assert.deepEqual(state.instances.map(item => item.identity.value), ['9', '2', '2']);
        assert.equal(state.instances[0].title, 'Reviewed steel');
        assert.ok(state.instances.every(item => item.uri === api.documentUriIdentity(document)));
        const current = state.selectedInstanceId, target = state.instances[1].instanceId;
        const ro = state.cards.flatMap(card => card.fields).find(field => field.name === 'RO');
        assert.ok(await provider.actions.updateField(ro.fieldId, '8.0'));
        const draftState = provider.getState();
        assert.equal(await provider.actions.selectInstance(current), true);
        assert.strictEqual(provider.getState(), draftState, 'current-item selection must publish nothing');
        vscode.window.showWarningMessage = async () => undefined;
        assert.equal(await provider.actions.selectInstance(target), 'cancelled');
        assert.equal(provider.getState().hasDrafts, true);
        assert.equal(document.getText(), text);
        vscode.window.showWarningMessage = async (_message, _options, _apply, discard) => discard;
        assert.equal(await provider.actions.selectInstance(target), true);
        assert.equal(provider.getState().selectedInstanceId, target);
        assert.equal(provider.getState().hasDrafts, false);
        assert.equal(document.getText(), text);
        state = provider.getState();
        api.keywordManagerInstanceDirectories.delete(document);
        assert.ok(await provider.actions.updateField(state.cards.flatMap(card => card.fields).find(field => field.name === 'RO').fieldId, '3.1'));
        assert.equal(await provider.actions.selectInstance(current), true, 'switch waits for the directory reloaded by draft submission');
        assert.equal(await provider.actions.selectInstance(target), true);
        assert.equal(document.getText(), text);
        state = provider.getState();
        assert.ok(await provider.actions.updateField(state.cards.flatMap(card => card.fields).find(field => field.name === 'RO').fieldId, '3'));
        vscode.window.showWarningMessage = async (_message, _options, _apply, discard) => {
            await editor.edit(builder => builder.insert(new vscode.Position(0, 0), '$ changed during confirmation\n'));
            return discard;
        };
        assert.equal(await provider.actions.selectInstance(current), false);
        assert.equal(provider.getState().hasDrafts, true, 'failed discard transition must preserve drafts');
        vscode.window.showWarningMessage = async (_message, _options, _apply, discard) => discard;
        await vscode.commands.executeCommand('extension.keywordOptions.refresh');
        await open(document.getText().split(/\r?\n/).findIndex(line => line === '*MAT_ELASTIC'));
        state = provider.getState();
        const destination = state.instances[2].instanceId;
        assert.ok(await provider.actions.updateField(state.cards.flatMap(card => card.fields).find(field => field.name === 'RO').fieldId, '3'));
        vscode.window.showWarningMessage = async (_message, _options, apply) => apply;
        assert.equal(await provider.actions.selectInstance(destination), 'applied-reselect');
        assert.equal(provider.getState().hasDrafts, false);
        assert.notEqual(provider.getState().selectedInstanceId, destination);
        assert.equal(provider.getState().directoryStatus, 'ready');
        assert.equal(Number(provider.getState().cards.flatMap(card => card.fields).find(field => field.name === 'RO').value), 3);
        assert.ok(document.getText().includes(fixed([2,1.1,5000,0.35,0,0,0,0])), 'non-target material bytes remain unchanged');
        results.push({ mode: 'instance-selector', passed: true, checks: ['same-file-type', 'title-and-owning-id',
            'current-no-op', 'cancel-preserves-draft', 'discard-switch', 'draft-directory-reload-switch', 'changed-target-retains-draft', 'apply-reselect'] });
        vscode.window.showWarningMessage = originalWarning;
        await open(document.getText().split(/\r?\n/).findIndex(line => line === '*MAT_ELASTIC_TITLE'));
        fs.writeFileSync(path.join(root, 'selector-ready.json'), JSON.stringify({
            hostLanguage: vscode.env.language, pluginLanguage: vscode.workspace.getConfiguration('lsdyna').get('language'),
            sourceText: document.getText(), source: uri.fsPath, state: provider.getState(), checks: results,
            runtimeSha256: Object.fromEntries(['out/extension.js', 'out/client/services/keywordManager.js',
                'out/core/keywordDisplayIdentity.js', 'out/core/i18n.js',
                ...fs.readdirSync(path.join(extension.extensionPath, 'out/webview/keyword-options/assets'))
                    .map(name => 'out/webview/keyword-options/assets/' + name)]
                .filter(relative => fs.existsSync(path.join(extension.extensionPath, relative)))
                .map(relative => [relative, crypto.createHash('sha256').update(fs.readFileSync(path.join(extension.extensionPath, relative))).digest('hex')])),
        }, null, 2));
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
        if (process.env.KEYWORD_MANAGER_SELECTOR_GUI === '1') {
            if (fs.existsSync(path.join(root, 'gui-finish.json')) || fs.existsSync(path.join(root, 'selector-finish.json'))) return;
            await new Promise(resolve => {
                const watcher = fs.watch(root, (_event, name) => {
                    if (String(name) === 'selector-request.json') {
                        const request = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
                        if (request.id === lastRequest) return;
                        lastRequest = request.id;
                        void (async () => {
                            if (request.action === 'single') {
                                await open(document.getText().split(/\r?\n/).findIndex(line => line === '*DATABASE_SLEOUT'));
                            } else if (request.action === 'clear-notifications') {
                                await vscode.commands.executeCommand('notifications.clearAll');
                            } else if (request.action === 'loading') {
                                api.keywordManagerInstanceDirectories.delete(document);
                                catalog.prepareKeyword = async function (keyword) {
                                    if (String(keyword).includes('MAT_ELASTIC')) await new Promise(resolve => {
                                        preparationGate = { resolve };
                                    });
                                    return originalPrepare.call(this, keyword);
                                };
                                await provider.actions.reset();
                                await until(() => preparationGate && provider.getState().directoryStatus === 'loading');
                            } else if (request.action === 'failure') {
                                catalog.prepareKeyword = originalPrepare;
                                schema.lookupKeywordSchema = function (...args) {
                                    if (String(new Error().stack).includes('keywordManagerTypeKey')) {
                                        schema.lookupKeywordSchema = originalLookup;
                                        throw Error('Injected directory identity read failure');
                                    }
                                    return originalLookup.apply(this, args);
                                };
                                preparationGate.resolve();
                                preparationGate = null;
                                await until(() => provider.getState().directoryStatus === 'error');
                            } else if (request.action === 'stale') {
                                const edit = new vscode.WorkspaceEdit();
                                edit.insert(document.uri, new vscode.Position(0, 0), '$ external change\n');
                                assert.ok(await vscode.workspace.applyEdit(edit));
                                await until(() => provider.getState().status === 'stale');
                            } else if (request.action === 'readonly') {
                                const source = ['*MAT_ELASTIC', fixed([11,7.85,210000,0.3,0,0,0,0]),
                                    '*MAT_ELASTIC', fixed([12,2.7,70000,0.33,0,0,0,0]), '*END'].join('\n');
                                readonlyEvents = new vscode.EventEmitter();
                                readonlyProvider = vscode.workspace.registerFileSystemProvider('selector-readonly', {
                                    onDidChangeFile: readonlyEvents.event,
                                    watch: () => new vscode.Disposable(() => {}),
                                    stat: () => ({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: Buffer.byteLength(source) }),
                                    readFile: () => Buffer.from(source), readDirectory: () => [],
                                    writeFile: () => { throw vscode.FileSystemError.NoPermissions(); },
                                    createDirectory: () => { throw vscode.FileSystemError.NoPermissions(); },
                                    delete: () => { throw vscode.FileSystemError.NoPermissions(); },
                                    rename: () => { throw vscode.FileSystemError.NoPermissions(); },
                                }, { isReadonly: true });
                                const target = await vscode.workspace.openTextDocument(vscode.Uri.parse('selector-readonly:/readonly.k'));
                                const targetEditor = await vscode.window.showTextDocument(target);
                                targetEditor.selection = new vscode.Selection(0, 0, 0, 0);
                                await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions');
                                await until(() => provider.getState().directoryStatus === 'ready');
                                assert.ok(provider.getState().instances.every(item => item.readonly));
                            } else if (request.action === 'empty-view') {
                                // Renderer-only replay of the production initial state; not an empty source catalog.
                                provider.publish(api.keywordOptionEmptyViewState(false));
                            } else if (request.action === 'material') {
                                await open(document.getText().split(/\r?\n/).findIndex(line => line === '*MAT_ELASTIC_TITLE'));
                            } else throw Error('Unknown selector request: ' + request.action);
                            fs.writeFileSync(path.join(root, 'selector-applied.json'), JSON.stringify({
                                id: request.id, action: request.action, state: provider.getState(),
                            }, null, 2));
                        })().catch(error => fs.writeFileSync(path.join(root, 'selector-applied.json'),
                            JSON.stringify({ id: request.id, error: String(error.stack || error) })));
                    }
                    if (String(name) === 'theme-request.json') {
                        const theme = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
                        void vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global)
                            .then(() => fs.writeFileSync(path.join(root, 'theme-applied.json'), JSON.stringify(theme)));
                    }
                    if (String(name) === 'appearance-request.json') {
                        const appearance = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
                        void vscode.workspace.getConfiguration('window').update('zoomLevel', appearance.zoom, vscode.ConfigurationTarget.Global)
                            .then(() => fs.writeFileSync(path.join(root, 'appearance-applied.json'), JSON.stringify(appearance)));
                    }
                    if (String(name) === 'selector-finish.json' || String(name) === 'gui-finish.json') { watcher.close(); resolve(); }
                });
            });
        }
    } finally {
        catalog.prepareKeyword = originalPrepare;
        schema.lookupKeywordSchema = originalLookup;
        preparationGate?.resolve(false);
        readonlyProvider?.dispose();
        readonlyEvents?.dispose();
        Provider.prototype.showPanel = originalShow;
        vscode.window.showWarningMessage = originalWarning;
    }
};
