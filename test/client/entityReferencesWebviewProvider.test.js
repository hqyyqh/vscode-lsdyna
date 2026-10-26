'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { LsdynaEntityReferenceProvider } = require('../../out/client/providers/entityReferenceProvider');
const { EntityReferencesWebviewProvider } = require('../../out/client/EntityReferencesWebviewProvider');

function view() {
    return {
        webview: {
            cspSource: 'vscode-resource:',
            asWebviewUri: uri => uri,
            posted: [],
            postMessage(message) { this.posted.push(message); return Promise.resolve(true); },
            onDidReceiveMessage(callback) { this.receive = callback; return { dispose() {} }; },
        },
        onDidDispose(callback) { this.disposeCallback = callback; return { dispose() {} }; },
    };
}

function actions(calls) {
    const called = (name, ...args) => { calls.push([name, ...args]); return true; };
    return {
        query: (...args) => called('query', ...args), infer: () => called('infer'),
        refresh: () => called('refresh'), togglePin: key => called('pin', key),
        selectSession: key => called('select', key), removeSession: key => called('remove', key),
        clear: () => called('clear'), open: (...args) => called('open', ...args),
        openLargeFile: uri => called('openLargeFile', uri.fsPath),
    };
}

describe('EntityReferencesWebviewProvider', () => {
    it('explains index, result and internal failures without showing raw reason codes', () => {
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['material'], actions([]));
        try {
            for (const reason of ['entity-query-cancelled', 'entity-query-index-budget', 'entity-query-result-budget', 'entity-query-incomplete', 'entity-query-low-memory']) {
                model.publish({ targetKind: 'material', id: 1, scope: { kind: 'single-file', filePath: path.resolve('main.k') } },
                    { state: 'partial', locations: [], reasons: [reason] });
                const state = provider.viewState();
                assert.equal(state.reasonDetails.length, 1);
                assert.notEqual(state.reasonDetails[0], reason);
                assert.equal(state.status, 'partial');
            }
        } finally { provider.dispose(); model.dispose(); }
    });
    it('keeps partial coverage in both languages without rendering repetitive reason warnings', () => {
        const i18n = require('../../out/core/i18n'), original = i18n.getLanguage;
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['part'], actions([]));
        const reasons = ['unknown (8010 occurrences)', 'deferred (12 occurrences)'];
        try {
            model.publish({ targetKind: 'part', id: 1, scope: { kind: 'single-file', filePath: path.resolve('main.k') } },
                { state: 'partial', locations: [], reasons });
            for (const [language, label] of [['zh-cn', '部分结果'], ['en', 'Partial results']]) {
                i18n.getLanguage = () => language;
                const state = provider.viewState();
                assert.equal(state.status, 'partial');
                assert.equal(state.labels.partial, label);
                assert.deepEqual(state.reasonDetails, []);
                assert.deepEqual(state.reasons, reasons, 'coverage evidence is preserved');
            }
        } finally { i18n.getLanguage = original; provider.dispose(); model.dispose(); }
    });
    it('opens the next search during indexing and ignores the superseded query failure', async () => {
        const original = vscode.window.createQuickPick, pickers = [], queries = [];
        vscode.window.createQuickPick = () => {
            const picker = { value: '', items: [], selectedItems: [],
                onDidChangeValue(fn) { this.change = fn; return { dispose() {} }; },
                onDidChangeActive() { return { dispose() {} }; },
                onDidAccept(fn) { this.accept = fn; return { dispose() {} }; },
                onDidHide(fn) { this.hidden = fn; return { dispose() {} }; },
                show() {}, hide() { this.hidden(); }, dispose() {} };
            pickers.push(picker); return picker;
        };
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], {
            ...actions([]), query: () => new Promise((resolve, reject) => queries.push({ resolve, reject })),
        });
        const select = picker => { picker.value = '1001'; picker.change(); picker.selectedItems = [picker.items[0]]; picker.accept(); };
        try {
            const first = provider.search(); select(pickers[0]); await Promise.resolve();
            assert.equal(queries.length, 1);
            const second = provider.search(); assert.equal(pickers.length, 2);
            queries[0].reject(new Error('old query failed')); await first;
            assert.equal(provider.searchPending, true, 'old completion cannot unlock the new picker');
            assert.equal(provider.message, '');
            select(pickers[1]); await Promise.resolve(); queries[1].resolve(true);
            assert.equal(await second, true);
        } finally { provider.dispose(); model.dispose(); vscode.window.createQuickPick = original; }
    });
    it('names reference-only query types in both languages and preserves keyword identifiers', () => {
        const i18n = require('../../out/core/i18n');
        const original = i18n.getLanguage;
        const { ENTITY_KIND_LABELS, shortEntityKindLabel } = require('../../out/client/entityKindLabels');
        try {
            for (const [language, expected] of [['zh-cn', ['气囊', 'CESE 状态方程', '安全带卷收器']],
                ['en', ['Airbag', 'CESE equation of state', 'Seatbelt retractor']]]) {
                i18n.getLanguage = () => language;
                assert.deepEqual(['airbag-id', 'cese-eos', 'seatbelt-retractor'].map(shortEntityKindLabel), expected);
                assert.equal(ENTITY_KIND_LABELS['airbag-id'][1], '*AIRBAG_ID');
            }
        } finally { i18n.getLanguage = original; }
    });
    it('mounts the loading UI before preparation and ignores a disposed ready request', async () => {
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => {
            throw Error('unprepared directory');
        }, actions([]), () => pending);
        const webview = view(); webview.visible = true;
        const token = { isCancellationRequested: false };
        await provider.resolveWebviewView(webview, undefined, token);
        assert.equal(provider.isFollowingCursor(), false);
        assert.ok(webview.webview.html.includes('<div id="root">'));
        assert.ok(webview.webview.html.includes("default-src 'none';"));
        assert.ok(webview.webview.html.includes('font-src vscode-resource:;'));
        const ready = webview.webview.receive({ id: 'ready', method: 'entityReferences/ready', receiver: { type: 'extension' }, params: { revision: 0 } });
        webview.disposeCallback();
        release(); await ready;
        assert.equal(provider.isFollowingCursor(), false);
        provider.dispose(); model.dispose();
    });
    it('preserves ambiguous results and releases pagination when sessions are cleared', async () => {
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], actions([]));
        const scope = { kind: 'single-file', filePath: path.resolve('main.k') };
        for (let id = 1; id <= 20; id++) {
            model.publish({ targetKind: 'curve', id, scope }, { state: 'ambiguous', locations: [1, 2].map(line =>
                ({ role: 'definition', filePath: scope.filePath, line, startCharacter: 0, endCharacter: 1 })) });
            const state = provider.viewState();
            assert.equal(state.ambiguous, true);
            assert.equal(state.activeSession.definitionCount, 2);
            assert.equal(provider.visibleCounts.size, 1);
            assert.strictEqual(provider.resultGroups(model.getActiveSession()), provider.resultGroups(model.getActiveSession()));
        }
        await model.clear(); provider.viewState();
        assert.equal(provider.visibleCounts.size, 0);
        provider.dispose(); model.dispose();
    });
    it('mounts without preparing kinds and retries only when search requests preparation', async () => {
        let attempts = 0, follow = 0;
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => { throw Error('unexpected lookup'); },
            { ...actions([]), follow: () => follow++ }, async () => { attempts++; throw Error('directory unavailable'); });
        const webview = view(); webview.visible = true;
        await provider.resolveWebviewView(webview);
        await webview.webview.receive({ id: 'ready', method: 'entityReferences/ready', receiver: { type: 'extension' }, params: { revision: 0 } });
        assert.equal(attempts, 0); assert.equal(follow, 0);
        assert.equal(provider.isFollowingCursor(), false);
        assert.equal(await provider.search(), false);
        assert.equal(provider.viewState().message, require('../../out/core/i18n').get('entityReferencesIncompleteHint'));
        assert.equal(await provider.search(), false);
        assert.equal(attempts, 2);
        provider.dispose(); model.dispose();
    });

    for (const status of ['complete', 'partial', 'missing', 'incomplete']) {
        it(`queries the selected native scope for ${status} results and rejects unavailable scopes`, async () => {
            const calls = [], model = new LsdynaEntityReferenceProvider();
            const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], actions(calls));
            const filePath = path.resolve('part.k'), projectRoot = path.resolve('main.k');
            provider.setScopeContext({ filePath, projectRoot });
            model.publish({ targetKind: 'curve', id: 3, scope: { kind: 'single-file', filePath } }, { state: status, locations: [] });
            try {
                assert.equal(await provider.setScopePreference('project'), true);
                assert.deepEqual(calls, [['query', 'curve', '3', 'project']]);
                assert.equal(await provider.setScopePreference('file'), true);
                assert.deepEqual(calls[1], ['query', 'curve', '3', 'file']);
                provider.setScopeContext({ filePath });
                assert.equal(await provider.setScopePreference('project'), false);
                assert.equal(provider.viewState().message, require('../../out/core/i18n').get('entityReferencesProjectScopeUnavailable'));
                provider.setScopeContext({});
                assert.equal(await provider.setScopePreference('project'), false);
                assert.equal(provider.viewState().message, require('../../out/core/i18n').get('entityReferencesProjectScopeUnavailable'));
                assert.equal(await provider.setScopePreference('file'), false);
                assert.equal(provider.viewState().message, require('../../out/core/i18n').get('entityReferencesFileScopeUnavailable'));
                assert.equal(calls.length, 2);
            } finally { provider.dispose(); model.dispose(); }
        });
    }

    for (const replacement of ['message', 'input', 'session']) it(`does not publish obsolete scope feedback after a newer ${replacement}`, async () => {
        const model = new LsdynaEntityReferenceProvider();
        let finish;
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], {
            ...actions([]), query: () => new Promise(resolve => { finish = resolve; }),
        });
        const filePath = path.resolve('part.k');
        provider.setScopeContext({ filePath, projectRoot: path.resolve('main.k') });
        const identity = { targetKind: 'curve', id: 3, scope: { kind: 'single-file', filePath } };
        model.publish(identity, { state: 'complete', locations: [] });
        try {
            const pending = provider.setScopePreference('project');
            if (replacement === 'message') provider.setMessage('New feedback');
            if (replacement === 'input') provider.setInput('curve', '4');
            if (replacement === 'session') model.publish({ ...identity, id: 4 }, { state: 'complete', locations: [] });
            const expected = provider.viewState().message;
            finish(false); await pending;
            assert.equal(provider.viewState().message, expected);
        } finally { provider.dispose(); model.dispose(); }
    });

    it('relocalizes existing scope feedback when the plugin language changes', async () => {
        const i18n = require('../../out/core/i18n'), config = vscode.workspace.getConfiguration;
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(),model,()=>[],actions([]));
        try {
            vscode.workspace.getConfiguration=()=>({get:()=> 'en'});i18n.updateLanguage();
            await provider.setScopePreference('project');
            assert.match(provider.viewState().message,/No main deck/);
            vscode.workspace.getConfiguration=()=>({get:()=> 'zh-cn'});i18n.updateLanguage();provider.refreshUiLanguage();
            assert.match(provider.viewState().message,/尚未确定主文件/);
        } finally {provider.dispose();model.dispose();vscode.workspace.getConfiguration=config;i18n.updateLanguage();}
    });

    for (const current of ['file', 'project']) it(`uses the keyword-index scope picker design from ${current}`, async () => {
        const original = vscode.window.showQuickPick, calls = [], model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], actions(calls));
        const filePath = path.resolve('main.k'), i18n = require('../../out/core/i18n');
        provider.setScopeContext({filePath, projectRoot:filePath});
        model.publish({targetKind:'curve',id:3,scope:current==='file'?{kind:'single-file',filePath}:{kind:'project',rootFile:filePath}},
            {state:'complete',locations:[]});
        let choice;
        vscode.window.showQuickPick = async (items, options) => {
            assert.deepEqual(items.map(item=>item.label),[i18n.get('keywordIndexScopeCurrentFile'),i18n.get('keywordIndexScopeProject')]);
            assert.equal(items.filter(item=>item.picked).length,1);
            assert.equal(items.find(item=>item.picked).scope,current);
            assert.equal(options.ignoreFocusOut,true);
            return items.find(item=>item.scope===choice);
        };
        try {
            await provider.chooseScope(); assert.equal(calls.length,0,'Escape leaves scope and results alone');
            choice=current;await provider.chooseScope();assert.equal(calls.length,0,'Repeated selection does not query');
            choice=current==='file'?'project':'file';await provider.chooseScope();
            assert.deepEqual(calls,[['query','curve','3',choice]]);
            const manifest=require('../../package.json');
            const action=manifest.contributes.menus['view/title'].find(item=>item.command==='extension.entityReferences.chooseScope');
            assert.equal(action.group,'navigation@2');assert.equal(action.when,'view == lsdynaEntityReferences');
            assert.equal(manifest.contributes.commands.find(item=>item.command===action.command).icon,'$(filter)');
        } finally {vscode.window.showQuickPick=original;provider.dispose();model.dispose();}
    });

    it('shows progress until a scope query completes, then clears it', async () => {
        let finish;
        const pending = new Promise(resolve => { finish = resolve; });
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], {
            ...actions([]), query: (kind, id, scope) => {
                provider.setInput(kind, id, scope);
                return pending;
            },
        });
        const filePath = path.resolve('part.k');
        provider.setScopeContext({ filePath, projectRoot: path.resolve('main.k') });
        model.publish({ targetKind: 'curve', id: 3, scope: { kind: 'single-file', filePath } }, { state: 'complete', locations: [] });
        try {
            const change = provider.setScopePreference('project');
            assert.equal(provider.viewState().message, require('../../out/core/i18n').get('entityReferencesChangingScope'));
            finish(true);
            assert.equal(await change, true);
            assert.equal(provider.viewState().message, '');
        } finally { finish(false); provider.dispose(); model.dispose(); }
    });

    for (const failure of [false, 'reject']) {
        it(`reports native scope failure and retries the selected scope: ${failure}`, async () => {
            let attempts = 0;
            const model = new LsdynaEntityReferenceProvider();
            const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], {
                ...actions([]), query: async (kind, id, scope) => {
                    assert.equal(scope, 'project'); attempts++;
                    if (attempts > 1) return true;
                    if (failure === 'reject') throw Error('internal-offline');
                    return false;
                },
            });
            const filePath = path.resolve('part.k');
            provider.setScopeContext({ filePath, projectRoot: path.resolve('main.k') });
            model.publish({ targetKind: 'curve', id: 3, scope: { kind: 'single-file', filePath } }, { state: 'complete', locations: [] });
            try {
                assert.equal(await provider.setScopePreference('project'), false);
                assert.equal(provider.viewState().message, require('../../out/core/i18n').get('entityReferencesIncompleteHint'));
                assert.equal(await provider.setScopePreference('project'), true);
                assert.equal(provider.viewState().message, '');
                assert.equal(attempts, 2);
            } finally { provider.dispose(); model.dispose(); }
        });
        it(`reports native search failure and unlocks a retry: ${failure}`, async () => {
            const original = vscode.window.createQuickPick;
            let accept, hide, created = 0, disposed = 0, queries = 0, finish;
            const picker = { value: 'curve 3', items: [], selectedItems: [],
                onDidChangeValue() { return { dispose() {} }; },
                onDidChangeActive() { return { dispose() {} }; },
                onDidAccept(fn) { accept = fn; return { dispose() {} }; },
                onDidHide(fn) { hide = fn; return { dispose() {} }; },
                show() {}, hide() { hide(); }, dispose() { disposed++; },
            };
            vscode.window.createQuickPick = () => { created++; return picker; };
            const model = new LsdynaEntityReferenceProvider();
            const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], {
                ...actions([]), query: async () => {
                    queries++;
                    if (queries > 1) return true;
                    if (failure === 'reject') throw Error('internal-offline');
                    return new Promise(resolve => { finish = resolve; });
                },
            });
            try {
                const first = provider.search();
                assert.equal(await provider.search(), true);
                assert.equal(created, 1, 'only one native picker may be active');
                picker.selectedItems = [picker.items[0]]; accept();
                if (failure === false) { await Promise.resolve(); finish(false); }
                assert.equal(await first, false);
                assert.equal(provider.viewState().message, require('../../out/core/i18n').get('entityReferencesIncompleteHint'));
                assert.equal(disposed, 1);
                const retry = provider.search();
                assert.equal(provider.viewState().message, '');
                picker.selectedItems = [picker.items[0]]; accept();
                assert.equal(await retry, true);
                assert.equal(queries, 2); assert.equal(created, 2); assert.equal(disposed, 2);
            } finally { vscode.window.createQuickPick = original; provider.dispose(); model.dispose(); }
        });
    }

    it('synchronizes native pin, scope and follow controls with the active session', async () => {
        const original = vscode.commands.executeCommand, contexts = new Map();
        vscode.commands.executeCommand = (command, key, value) => { if (command === 'setContext') contexts.set(key, value); };
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], actions([]));
        const webview = view(); webview.visible = true;
        try {
            await provider.resolveWebviewView(webview);
            assert.equal(webview.description, require('../../out/core/i18n').get('keywordIndexScopeCurrentFile'));
            assert.equal(contexts.get('lsdynaEntityReferences.pinned'), false);
            provider.toggleFollowCursor(); assert.equal(contexts.get('lsdynaEntityReferences.following'), true);
            const rootFile = path.resolve('main.k');
            model.publish({ targetKind: 'curve', id: 3, scope: { kind: 'project', rootFile } }, { state: 'complete', locations: [] });
            provider.refreshUiLanguage(); // The portable VS Code mock does not emit model events; the real host verifies automatic publication.
            assert.equal(contexts.get('lsdynaEntityReferences.scope'), 'project');
            assert.equal(webview.description, require('../../out/core/i18n').get('keywordIndexScopeProject'));
            await model.pin();
            provider.refreshUiLanguage();
            assert.equal(contexts.get('lsdynaEntityReferences.pinned'), true);
            assert.equal(contexts.get('lsdynaEntityReferences.following'), false);
            provider.toggleFollowCursor(); assert.equal(provider.following, true, 'a pinned session cannot toggle following');
            await model.unpin();
            provider.refreshUiLanguage();
            assert.equal(contexts.get('lsdynaEntityReferences.pinned'), false);
            assert.equal(contexts.get('lsdynaEntityReferences.following'), true);
            provider.toggleFollowCursor(); assert.equal(contexts.get('lsdynaEntityReferences.following'), false);
            const manifest = require('../../package.json');
            const menu = manifest.contributes.menus['view/title'];
            for (const name of ['search', 'toggleFollow', 'toggleFollowActive', 'pin', 'unpin']) {
                const command = `extension.entityReferences.${name}`;
                assert.ok(manifest.contributes.commands.some(item => item.command === command && item.icon && item.title));
                assert.ok(menu.some(item => item.command === command && item.when.includes('view == lsdynaEntityReferences')
                    && (name.startsWith('toggleFollow') ? item.group === '1_view' : item.group.startsWith('navigation@'))), `Missing title action: ${command}`);
            }
        } finally { provider.dispose(); model.dispose(); vscode.commands.executeCommand = original; }
    });
    it('uses one native picker, validates IDs, and queries only an accepted type', async () => {
        const original = vscode.window.createQuickPick;
        let change, accept, hide;
        const picker = {
            value: '', items: [], selectedItems: [],
            onDidChangeValue(fn) { change = fn; return { dispose() {} }; },
            onDidChangeActive() { return { dispose() {} }; },
            onDidAccept(fn) { accept = fn; return { dispose() {} }; },
            onDidHide(fn) { hide = fn; return { dispose() {} }; },
            show() {}, hide() { hide(); }, dispose() {},
        };
        vscode.window.createQuickPick = () => picker;
        const calls = [];
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model,
            () => ['curve', 'node-set'], actions(calls));
        const webview = view(); webview.visible = true;
        provider.resolveWebviewView(webview);
        provider.following = true;
        try {
            assert.equal(provider.isFollowingCursor(), true);
            const pending = provider.search();
            assert.equal(provider.isFollowingCursor(), false);
            picker.value = '-1'; change(); assert.equal(picker.items.length, 1); assert.equal(picker.items[0].id, undefined);
            picker.selectedItems = picker.items; accept(); assert.equal(calls.length, 0);
            picker.value = '9007199254740992'; change(); assert.equal(picker.items[0].id, undefined);
            picker.value = '1000003'; change(); assert.equal(picker.items.length, 2);
            assert.equal(calls.length, 0, 'typing must not query or scan');
            picker.value = 'SET_NODE 1000003'; change(); assert.equal(picker.items.length, 1);
            picker.selectedItems = [picker.items[0]]; accept();
            assert.equal(await pending, true);
            assert.deepEqual(calls, [['query', 'node-set', '1000003', 'file']]);
            assert.equal(provider.isFollowingCursor(), true);
            picker.value = ''; picker.selectedItems = [];
            const cancelled = provider.search(); hide();
            assert.equal(await cancelled, true);
            assert.equal(calls.length, 1);
        } finally {
            vscode.window.createQuickPick = original;
            provider.dispose(); model.dispose();
        }
    });

    it('keeps engineering order stable and remembers only confirmed workspace search choices', async () => {
        const original = vscode.window.createQuickPick;
        let change, active, accept, hide, picker;
        vscode.window.createQuickPick = () => (picker = {
            value: '', items: [], activeItems: [], selectedItems: [],
            onDidChangeValue(fn) { change = fn; return { dispose() {} }; },
            onDidChangeActive(fn) { active = fn; return { dispose() {} }; },
            onDidAccept(fn) { accept = fn; return { dispose() {} }; },
            onDidHide(fn) { hide = fn; return { dispose() {} }; },
            show() {}, hide() { hide(); }, dispose() {},
        });
        let saved = 'material';
        const writes = [];
        const state = { get() { return saved; }, update(key, value) {
            saved = value; writes.push(value); return Promise.resolve();
        } };
        const calls = [];
        const model = new LsdynaEntityReferenceProvider();
        let directoryError = false;
        const create = () => new EntityReferencesWebviewProvider(process.cwd(), model,
            () => {
                if (directoryError) throw Error('directory unavailable');
                return ['contact', 'part', 'hourglass', 'material', 'curve', 'node-set'];
            }, actions(calls), undefined, state);
        let provider = create();
        const type = value => { picker.value = value; change(); };
        try {
            provider.setInput('contact', '7', 'file');
            let pending = provider.search();
            type('1001');
            const order = ['curve', 'material', 'part', 'node-set', 'contact', 'hourglass'];
            assert.deepEqual(picker.items.map(item => item.targetKind), order);
            assert.ok(picker.items.every(item => item.label === '1001'), 'native label sorting must not reorder types');
            assert.ok(picker.items.find(item => item.targetKind === 'material').description.includes('*MAT'));
            assert.equal(picker.activeItems[0].targetKind, 'material');
            picker.activeItems = [picker.items.find(item => item.targetKind === 'part')];
            active(picker.activeItems);
            active([]);
            active([picker.items[0]]); // Native filter resets focus before delivering the value change.
            picker.value = '10012';
            active([picker.items[0]]); // Native filtering briefly focuses an item for the old ID.
            change();
            assert.equal(picker.activeItems[0].targetKind, 'part', 'typing must preserve manual choice');
            type('');
            assert.equal(picker.items.length, 1); assert.equal(picker.items[0].id, undefined);
            type('10012');
            assert.equal(picker.activeItems[0].targetKind, 'part', 'replacing the ID must preserve manual choice');
            type('SET_NODE 10012');
            assert.equal(picker.activeItems[0].targetKind, 'node-set');
            picker.selectedItems = picker.activeItems; accept();
            await pending;
            assert.deepEqual(writes, ['node-set']);
            assert.deepEqual(calls, [['query', 'node-set', '10012', 'file']]);
            provider.dispose(); provider = create();
            pending = provider.search(); type('2000');
            assert.deepEqual(picker.items.map(item => item.targetKind), order);
            assert.equal(picker.activeItems[0].targetKind, 'node-set');
            hide(); await pending;
            assert.deepEqual(writes, ['node-set'], 'cancellation must not save');
            provider.dispose(); saved = 'no-longer-supported'; provider = create();
            pending = provider.search(); type('3000');
            assert.equal(picker.activeItems[0].targetKind, 'curve');
            hide(); await pending;
            const warn = console.warn;
            const warnings = [];
            console.warn = (...args) => warnings.push(args);
            state.update = () => Promise.reject(new Error('storage unavailable'));
            try {
                pending = provider.search(); type('MAT 4000');
                picker.selectedItems = picker.activeItems; accept();
                assert.equal(await pending, true, 'storage failure must not block the query');
                assert.deepEqual(calls.at(-1), ['query', 'material', '4000', 'file']);
                assert.equal(warnings.length, 1);
            } finally { console.warn = warn; }
            directoryError = true;
            assert.equal(await provider.search(), false);
            directoryError = false;
            pending = provider.search(); type('5000');
            assert.equal(picker.items.length, 6, 'directory failure must release the search lock');
            hide(); await pending;
        } finally {
            provider.dispose(); model.dispose(); vscode.window.createQuickPick = original;
        }
    });

    it('pauses follow for pinned or hidden views and applies explicit scope changes', async () => {
        const calls = [];
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], actions(calls));
        const webview = view(); webview.visible = true;
        provider.resolveWebviewView(webview);
        const filePath = path.resolve('main.k');
        provider.setScopeContext({ filePath, projectRoot: filePath });
        model.publish({ targetKind: 'curve', id: 3, scope: { kind: 'single-file', filePath } }, { state: 'complete', locations: [] });
        const request = (method, extra = {}, revision = provider.viewState().revision) => webview.webview.receive({
            id: String(Math.random()), method: `entityReferences/${method}`, receiver: { type: 'extension' },
            params: { revision, ...extra },
        });
        try {
            await request('scope', { scopePreference: 'project' }, -1);
            assert.equal(calls.length, 0);
            await request('scope', { scopePreference: 'project' });
            assert.deepEqual(calls[0], ['query', 'curve', '3', 'project']);
            assert.equal(provider.isFollowingCursor(), false);
            await request('toggleFollow');
            assert.equal(provider.isFollowingCursor(), true);
            await request('toggleFollow'); assert.equal(provider.isFollowingCursor(), false);
            await request('toggleFollow'); assert.equal(provider.isFollowingCursor(), true);
            await model.pin(model.getActiveSession());
            assert.equal(provider.isFollowingCursor(), false);
            assert.equal(provider.viewState().following, false);
            await model.unpin(model.getActiveSession());
            assert.equal(provider.isFollowingCursor(), true);
            webview.visible = false;
            assert.equal(provider.isFollowingCursor(), false);
        } finally { provider.dispose(); model.dispose(); }
    });

    it('disambiguates files across roles and pages, reusing labels until results change', () => {
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['part'], actions([]));
        const file = relative => path.resolve('model', relative);
        const location = (filePath, role = 'reference', line = 1) => ({ role, filePath, line,
            startCharacter: 0, endCharacter: 1, keyword: '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE', fieldName: 'SSID' });
        const identity = { targetKind: 'part', id: 1, scope: { kind: 'single-file', filePath: file('main.key') } };
        const locations = [location(file('front/contact.key'), 'definition'),
            ...Array.from({ length: 100 }, (_, i) => location(file('left/rear/contact.key'), 'reference', i)),
            location(file('right/rear/contact.key')), location(file('unique.key'))];
        model.publish(identity, { state: 'complete', locations });
        const initial = provider.viewState();
        assert.equal(initial.activeSession.scopePath, file('main.key'));
        assert.ok(initial.activeSession.scopeLabel);
        assert.equal(initial.definitions[0].description, 'front/contact.key : 2');
        assert.equal(initial.references[0].description, 'left/rear/contact.key : 1');
        assert.equal(initial.references[0].keyword, '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE');
        assert.equal(initial.references[0].fieldName, 'SSID');
        const labels = provider.pathLabels;
        provider.visibleCounts.set(model.getActiveSession().key, { definition: 100, reference: 200 });
        const next = provider.viewState();
        assert.equal(next.definitions[0].locationId, initial.definitions[0].locationId);
        assert.equal(next.references[0].locationId, initial.references[0].locationId);
        assert.equal(provider.pathLabels, labels);
        assert.equal(next.references[100].description, 'right/rear/contact.key : 2');
        assert.equal(next.references[101].description, 'unique.key : 2');
        model.publish(identity, { state: 'complete', locations: [location(file('left/rear/contact.key'))] });
        assert.equal(provider.viewState().references[0].description, 'contact.key : 2');
        assert.notEqual(provider.pathLabels, labels);
        provider.dispose(); model.dispose();
    });

    it('distinguishes equal suffixes across filesystem roots without changing tokens', () => {
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], actions([]));
        const filePaths = process.platform === 'win32'
            ? ['C:/model/contact.key', 'D:/model/contact.key']
            : ['/model/contact.key', '/other/model/contact.key'];
        model.publish({ targetKind: 'curve', id: 1, scope: { kind: 'single-file', filePath: filePaths[0] } }, {
            state: 'complete', locations: filePaths.map(filePath => ({ role: 'definition', filePath, line: 0,
                startCharacter: 0, endCharacter: 1, keyword: '*DEFINE_CURVE', fieldName: 'LCID' })),
        });
        const items = provider.viewState().definitions;
        assert.notEqual(items[0].description, items[1].description);
        assert.ok(items.every(item => /^[0-9a-f-]{36}$/.test(item.locationId)));
        assert.deepEqual(items.map(item => item.detail), filePaths.map(filePath => `${filePath}:1`));
        provider.dispose(); model.dispose();
    });

    it('loads remote pages through the view with total counts distinct from loaded rows', async () => {
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => ['curve'], actions([]));
        const webview = view(); await provider.resolveWebviewView(webview);
        const filePath = path.resolve('model.key');
        const locations = start => Array.from({ length: 200 }, (_, index) => ({ role: 'reference',
            filePath, line: start + index, startCharacter: 0, endCharacter: 1 }));
        let calls = 0;
        model.publish({ targetKind: 'curve', id: 1, scope: { kind: 'single-file', filePath } }, {
            state: 'complete', revision: 'v1', locations: locations(0),
            page: { counts: { definition: 0, reference: 400 }, next: { reference: { offset: 200 } } },
            loadPage: async cursor => {
                calls++; assert.equal(cursor.offset, 200);
                return { status: 'ready', revision: 'v1', result: { locations: locations(200),
                    page: { appendRole: 'reference', next: {} } } };
            },
        });
        const state = provider.viewState();
        assert.equal(state.activeSession.referenceCount, 400);
        assert.equal(state.references.length, 200);
        assert.equal(state.hasMoreReferences, true);
        await webview.webview.receive({ id: 'more', method: 'entityReferences/loadMore',
            receiver: { type: 'extension' }, params: { revision: state.revision, role: 'reference' } });
        assert.equal(calls, 1);
        const next = provider.viewState({ baseRevision: state.revision, role: 'reference', start: 200 });
        assert.equal(next.references.length, 200);
        assert.equal(new Set([...state.references, ...next.references].map(row => row.line)).size, 400);
        assert.equal(model.getActiveSession().locations.length, 400);
        assert.equal(next.hasMoreReferences, false);
        provider.dispose(); model.dispose();
    });

    it('contributes a webview and projects only bounded result pages', () => {
        const manifest = require('../../package.json');
        const contribution = manifest.contributes.views['lsdyna-includes']
            .find(item => item.id === 'lsdynaEntityReferences');
        assert.equal(contribution.type, 'webview');
        assert.equal((manifest.contributes.viewsWelcome || [])
            .some(item => item.view === 'lsdynaEntityReferences'), false);

        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model,
            () => ['curve'], actions([]));
        const filePath = path.resolve('model.key');
        model.publish({ targetKind: 'curve', id: 1,
            scope: { kind: 'single-file', filePath } }, {
            state: 'complete',
            locations: Array.from({ length: 450 }, (_, line) => ({
                role: 'reference', filePath, line, startCharacter: 0, endCharacter: 1,
                keyword: '*LOAD_CURVE', fieldName: 'LCID',
            })),
        });
        const state = provider.viewState();
        assert.equal(state.references.length, 200);
        assert.equal(state.hasMoreReferences, true);
        assert.equal(state.references.every(item => !('filePath' in item)), true);
        provider.visibleCounts.set(model.getActiveSession().key, { definition: 200, reference: 400 });
        const next = provider.viewState({ baseRevision: state.revision, role: 'reference', start: 200 });
        assert.equal(next.references.length, 200);
        assert.equal(next.references[0].line, 201);
        assert.equal(next.definitions.length, 0);
        assert.equal(next.hasMoreReferences, true);
        assert.ok(provider.locationsByToken.has(state.references[0].locationId));
        provider.dispose();
        model.dispose();
    });

    it('rejects stale or forged locations and accepts current opaque tokens', async () => {
        const calls = [];
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model,
            () => ['curve'], actions(calls));
        const webview = view();
        provider.resolveWebviewView(webview);
        const filePath = path.resolve('model.key');
        model.publish({ targetKind: 'curve', id: 1,
            scope: { kind: 'single-file', filePath } }, {
            state: 'complete', locations: [{ role: 'definition', filePath, line: 2,
                startCharacter: 0, endCharacter: 1, keyword: '*DEFINE_CURVE', fieldName: 'ID' }],
        });
        const state = provider.viewState();
        const request = (id, locationId, revision = state.revision) => webview.webview.receive({
            id, method: 'entityReferences/open', receiver: { type: 'extension' },
            params: { revision, locationId, side: false },
        });
        await request('1', state.definitions[0].locationId);
        await request('2', 'forged-token');
        await request('3', state.definitions[0].locationId, state.revision - 1);
        assert.equal(calls.filter(call => call[0] === 'open').length, 1);
        assert.deepEqual(webview.webview.posted.slice(-3).map(message => message.result),
            [true, false, false]);
        provider.dispose();
        model.dispose();
    });

    it('projects a large-file offer without exposing its URI', () => {
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model,
            () => ['curve'], actions([]));
        provider.setLargeFileOffer(vscode.Uri.file(path.resolve('huge.key')), 'over limit');
        const state = provider.viewState();
        assert.equal(state.largeFileOffer.fileName, 'huge.key');
        assert.equal(state.largeFileOffer.reason, 'over limit');
        assert.equal('uri' in state.largeFileOffer, false);
        assert.match(state.largeFileOffer.token, /^[0-9a-f-]{36}$/);
        provider.dispose();
        model.dispose();
    });
});


describe('entity follow lifecycle', () => {
    it('starts disabled and stops automatic work on toggle, hide, and dispose', async () => {
        let follows = 0, stops = 0, prepares = 0, visibility;
        const model = new LsdynaEntityReferenceProvider();
        const provider = new EntityReferencesWebviewProvider(process.cwd(), model, () => { throw Error('cold lookup'); },
            { ...actions([]), follow: () => follows++, stopFollow: () => stops++ }, async () => { prepares++; });
        const webview = view(); webview.visible = true;
        webview.onDidChangeVisibility = fn => { visibility = fn; return { dispose() {} }; };
        await provider.resolveWebviewView(webview);
        const request = method => webview.webview.receive({ id: String(Math.random()), method: 'entityReferences/' + method,
            receiver: { type: 'extension' }, params: { revision: provider.viewState().revision } });
        await request('ready'); visibility();
        assert.equal(prepares, 0); assert.equal(follows, 0); assert.equal(provider.isFollowingCursor(), false);
        await request('toggleFollow'); assert.equal(follows, 1); assert.equal(provider.isFollowingCursor(), true);
        webview.visible = false; visibility(); assert.equal(provider.isFollowingCursor(), false);
        const hiddenStops = stops; assert.ok(hiddenStops > 0);
        webview.visible = true; visibility(); assert.equal(follows, 2);
        await request('toggleFollow'); assert.equal(stops, hiddenStops + 1);
        provider.dispose(); model.dispose(); assert.ok(stops > hiddenStops + 1);
        assert.equal(prepares, 0, 'only an actual query or search prepares the shared directory');
    });
});
