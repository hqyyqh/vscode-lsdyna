'use strict';

const assert = require('node:assert/strict');
const vscode = require('vscode');
const { KeywordOptionsWebviewProvider } = require('../../out/client/KeywordOptionsWebviewProvider');

function state() {
    return {
        revision: 0, status: 'empty', locale: 'en', pinned: false,
        currentKeyword: '', targetKeyword: '', currentPostCount: 0, targetPostCount: 0,
        mode: 'none', dimensions: [], targets: [], postChoices: [],
        instances: [], selectedInstanceId: null,
        editLevel: 'view-only', capabilities: [],
        controls: [], formCandidates: [], selectedFormRuleId: null, cards: [], selectedFieldId: null, help: { status: 'none', fieldId: null }, preview: null,
        hasDrafts: false, canApply: false, message: '',
        labels: {
            current: 'Current', result: 'Result', search: 'Search', postCards: 'Post cards',
            apply: 'Apply', reset: 'Reset', pin: 'Pin', unpin: 'Unpin',
            migrated: 'Kept', added: 'Added', discarded: 'Discarded', details: 'Details', noOptions: 'None',
            keywordLine: 'Keyword line', cards: 'Cards and layout', fields: 'Field values', comments: 'Comments',
            currentFile: 'Current file',
            dirty: 'Unsaved', readonly: 'Read only',
            reviewed: 'Reviewed',
            capabilities: 'Capabilities', available: 'Available',
            locateSource: 'Locate source', openManual: 'Open manual', resetField: 'Reset field',
        },
    };
}

describe('KeywordOptionsWebviewProvider panel host', () => {
    it('exposes only the active panel current source, not a hidden or disposed source', () => {
        const provider = new KeywordOptionsWebviewProvider(process.cwd(), {}, {
            ...state(), instanceContext: { uri: 'file:///model/a.k' },
        });
        assert.equal(provider.getActiveSourceUri(), null);
        const panel = provider.showPanel('Keyword Manager');
        panel.active = true;
        assert.equal(provider.getActiveSourceUri().toString(), 'file:///model/a.k');
        provider.publish({ ...state(), instanceContext: { uri: 'file:///model/b.k' } });
        assert.equal(provider.getActiveSourceUri().toString(), 'file:///model/b.k');
        panel.active = false;
        assert.equal(provider.getActiveSourceUri(), null);
        panel.active = true;
        provider.publish(state());
        assert.equal(provider.getActiveSourceUri(), null);
        provider.dispose();
        assert.equal(provider.getActiveSourceUri(), null);
    });
    it('directory completion preserves the edit revision and current draft state', async () => {
        const initial = { ...state(), directoryStatus: 'loading', hasDrafts: true };
        const provider = new KeywordOptionsWebviewProvider(process.cwd(), {}, initial);
        provider.publishInstances([], 'ready');
        assert.equal(provider.getState().revision, initial.revision);
        assert.equal(provider.getState().hasDrafts, true);
        assert.equal(provider.getState().directoryStatus, 'ready');
        let applied = false;
        assert.equal((await provider.mutate(initial.revision, () => { applied = true; return true; })).accepted, true);
        assert.equal(applied, true);
        provider.dispose();
    });
    it('a rejected apply cannot restore a pending directory after background completion', async () => {
        const provider = new KeywordOptionsWebviewProvider(process.cwd(), {}, { ...state(), directoryStatus: 'loading' });
        const result = await provider.mutate(0, async () => {
            provider.publishInstances([], 'ready');
            return false;
        }, true);
        assert.equal(result.accepted, false);
        assert.equal(result.state.directoryStatus, 'ready');
        provider.dispose();
    });
    let originalCreatePanel;
    let panels;

    beforeEach(() => {
        originalCreatePanel = vscode.window.createWebviewPanel;
        panels = [];
        vscode.window.createWebviewPanel = (viewType, title, column, options) => {
            const panel = {
                viewType, title, viewColumn: column, visible: true, options,
                webview: {
                    cspSource: 'vscode-resource:',
                    asWebviewUri: uri => uri,
                    posted: [],
                    postMessage(message) { this.posted.push(message); return Promise.resolve(true); },
                    onDidReceiveMessage(callback) { this.receive = callback; return { dispose() {} }; },
                },
                revealCount: 0,
                reveal() { this.revealCount++; },
                onDidDispose(callback) { this.disposeCallback = callback; return { dispose() {} }; },
                dispose() { this.disposeCallback?.(); },
            };
            panels.push(panel);
            return panel;
        };
    });

    afterEach(() => { vscode.window.createWebviewPanel = originalCreatePanel; });

    it('uses one reusable panel and publishes the same state to it', () => {
        let disposed = 0;
        const actions = {
            selectDimension: () => true, selectTarget: () => true, selectPostCount: () => true,
            updateControl: () => true, selectForm: () => true,
            selectInstance: () => true, selectField: () => true, updateField: () => true,
            locateSource: () => true, openManual: () => true,
            apply: () => true, reset: () => true, togglePin: () => true,
            panelDisposed: () => { disposed++; },
        };
        const provider = new KeywordOptionsWebviewProvider(process.cwd(), actions, state());
        assert.equal(provider.isOpen(), false);
        const first = provider.showPanel('Keyword Manager');
        assert.equal(provider.isOpen(), true);
        assert.equal(panels.length, 1);
        assert.equal(first.viewType, 'lsdynaKeywordManager');
        assert.equal(first.viewColumn, vscode.ViewColumn.Beside);
        assert.match(first.webview.html, /default-src 'none'/);
        assert.match(first.webview.html, /<html lang="en">/);
        const second = provider.showPanel('Keyword Manager');
        assert.equal(second, first);
        assert.equal(first.revealCount, 1);
        const next = provider.publish({ ...state(), status: 'ready', message: 'ready' });
        assert.equal(next.revision, 1);
        first.dispose();
        assert.equal(provider.isOpen(), false);
        assert.equal(disposed, 1);
        provider.dispose();
    });

    it('uses the current Chinese runtime locale when opening or reopening the panel', () => {
        const provider = new KeywordOptionsWebviewProvider(process.cwd(), {}, state());
        provider.publish({ ...state(), locale: 'zh' });
        const chinese = provider.showPanel('关键字管理器');
        assert.match(chinese.webview.html, /<html lang="zh-CN">/);
        chinese.dispose();
        provider.publish({ ...state(), locale: 'en' });
        assert.match(provider.showPanel('Keyword Manager').webview.html, /<html lang="en">/);
        provider.dispose();
    });

    it('does not contribute the retired sidebar webview', () => {
        const manifest = require('../../package.json');
        const views = manifest.contributes.views['lsdyna-includes'];
        assert.equal(views.some(view => view.id === 'lsdynaKeywordOptions'), false);
        assert.equal((manifest.contributes.viewsWelcome || [])
            .some(item => item.view === 'lsdynaKeywordOptions'), false);
    });

    it('routes manager requests with revision checks', async () => {
        const calls = [];
        const called = (name, ...args) => { calls.push([name, ...args]); return true; };
        const actions = {
            selectDimension: (id, values) => called('dimension', id, values),
            selectTarget: keyword => called('target', keyword),
            selectPostCount: count => called('post', count),
            updateControl: (id, value) => called('control', id, value),
            selectForm: id => called('form', id),
            selectInstance: id => called('instance', id),
            selectField: request => { called('field', request.fieldId); return { status: 'ready', fieldId: request.fieldId }; },
            updateField: (id, value) => called('update', id, value),
            locateSource: () => called('source'),
            openManual: () => called('manual'),
            apply: () => called('apply'), reset: () => called('reset'),
            togglePin: () => called('pin'),
        };
        const provider = new KeywordOptionsWebviewProvider(process.cwd(), actions, state());
        const panel = provider.showPanel('Keyword Manager');
        const request = (id, method, params = {}) => panel.webview.receive({
            id, method, receiver: { type: 'extension' }, params: { revision: 0, ...params },
        });

        await request('1', 'keywordOptions/selectPostCount', { targetPostCount: 6 });
        await request('2', 'keywordManager/selectInstance', { instanceId: 'file:12' });
        await request('10', 'keywordManager/updateControl', { controlId: 'selector:mpp', value: 'MPP1' });
        await request('12', 'keywordManager/selectForm', { ruleId: 'input-form-12' });
        await request('3', 'keywordManager/selectField', { fieldId: 'card:field', instanceId: null, requestId: 1 });
        await request('4', 'keywordManager/updateField', { fieldId: 'card:field', value: '42' });
        assert.equal(provider.handlers.length, 14); // Retired project scope has no request handler.
        await request('7', 'keywordManager/locateSource');
        await request('8', 'keywordManager/openManual');
        await request('9', 'keywordManager/openManual', { revision: 99 });
        await request('11', 'keywordManager/updateControl', { revision: 99, controlId: 'selector:mpp', value: 'MPP2' });

        assert.deepEqual(calls, [
            ['post', 6], ['instance', 'file:12'], ['control', 'selector:mpp', 'MPP1'],
            ['form', 'input-form-12'], ['field', 'card:field'],
            ['update', 'card:field', '42'], ['source'], ['manual'],
        ]);
        const results = panel.webview.posted.filter(message => message.id).map(message => message.result);
        assert.deepEqual(results.slice(0, 6).map(result => result.accepted), [true, true, true, true, true, true]);
        assert.deepEqual(results.slice(6, 9), [true, true, false]);
        assert.equal(results[9].accepted, false);
        assert.equal(results[9].reason, 'stale-revision');
        provider.dispose();
    });

    it('serves help without publishing, advancing revisions or taking the edit lock', async () => {
        let calls = 0;
        const provider = new KeywordOptionsWebviewProvider(process.cwd(), {
            selectField: request => { calls++; return { status: 'ready', fieldId: request.fieldId }; },
        }, state());
        const panel = provider.showPanel('Keyword Manager');
        provider.publish = () => { throw new Error('Help must not publish full state'); };
        let release;
        const edit = provider.mutate(0, () => new Promise(resolve => { release = resolve; }));
        const payload = { revision: 0, instanceId: null, fieldId: 'f', requestId: 7 };
        const request = async (id, params) => {
            await panel.webview.receive({ id, method: 'keywordManager/selectField', receiver: { type: 'extension' }, params });
            return panel.webview.posted.find(message => message.id === id).result;
        };
        const result = await request('help', payload);
        assert.equal(result.accepted, true);
        assert.equal(result.requestId, 7);
        assert.equal('state' in result, false);
        assert.equal(provider.getState().revision, 0);
        assert.equal((await request('old', { ...payload, revision: 1 })).accepted, false);
        assert.equal((await request('instance', { ...payload, instanceId: 'other' })).accepted, false);
        assert.equal(calls, 1);
        release(true);
        await edit;
        provider.dispose();
    });

    it('rejects reentrant mutations until a pending transition settles and keeps its latest state', async () => {
        const provider = new KeywordOptionsWebviewProvider(process.cwd(), {}, state());
        let settle;
        let competingCalls = 0;
        const pending = provider.mutate(0, () => new Promise(resolve => { settle = resolve; }));
        const reentrant = await provider.mutate(0, () => { competingCalls++; return true; });
        assert.equal(reentrant.accepted, false);
        assert.equal(reentrant.reason, 'mutation-in-progress');
        assert.equal(competingCalls, 0);
        const newest = provider.publish({ ...state(), selectedInstanceId: 'b', status: 'ready' });
        settle(true);
        const result = await pending;
        assert.equal(result.state, newest);
        assert.equal(result.state.selectedInstanceId, 'b');
        assert.equal((await provider.mutate(newest.revision, () => false)).accepted, false);
        assert.equal((await provider.mutate(newest.revision, () => true)).accepted, true);
        provider.dispose();
    });
});
