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
        await assert.rejects(provider.search(), /directory unavailable/);
        await assert.rejects(provider.search(), /directory unavailable/);
        assert.equal(attempts, 2);
        provider.dispose(); model.dispose();
    });
    it('uses one native picker, validates IDs, and queries only an accepted type', async () => {
        const original = vscode.window.createQuickPick;
        let change, accept, hide;
        const picker = {
            value: '', items: [], selectedItems: [],
            onDidChangeValue(fn) { change = fn; return { dispose() {} }; },
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
            picker.value = '-1'; change(); assert.equal(picker.items.length, 0);
            picker.value = '9007199254740992'; change(); assert.equal(picker.items.length, 0);
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
            locations: Array.from({ length: 150 }, (_, line) => ({
                role: 'reference', filePath, line, startCharacter: 0, endCharacter: 1,
                keyword: '*LOAD_CURVE', fieldName: 'LCID',
            })),
        });
        const state = provider.viewState();
        assert.equal(state.references.length, 100);
        assert.equal(state.hasMoreReferences, true);
        assert.equal(state.references.every(item => !('filePath' in item)), true);
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
