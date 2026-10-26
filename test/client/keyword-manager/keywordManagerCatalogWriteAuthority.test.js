const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { fakeDoc, vscodeMock: vscode } = require("../../support/helpers");
const api = require("../../../src/extension")._internals;
const { getCatalogInputFormCatalogV4 } = require("../../../src/core/semantics/catalogInputFormCatalogV4");

describe('manager catalog write authority', () => {
    const materialText = '*MAT_ELASTIC\n         7    7.8e-9    210000       0.3\n*END';
    function materialEditor() {
        return { document: Object.assign(fakeDoc(materialText), { languageId: 'lsdyna', version: 1 }) };
    }

    it('reuses model reads while preserving projections and isolating later models and drafts', () => {
        const editor = materialEditor();
        const expected = api.buildKeywordOptionViewModel(editor, 0, { deferInstances: true });
        const catalog = getCatalogInputFormCatalogV4({ allowUnaudited: false });
        const original = catalog.resolveFormForKeyword, calls = new Map();
        catalog.resolveFormForKeyword = function (keyword) {
            calls.set(keyword, (calls.get(keyword) || 0) + 1);
            return original.call(this, keyword);
        };
        try {
            const model = api.buildKeywordOptionViewModel(editor, 0, { deferInstances: true });
            assert.deepEqual(model.managerCards, expected.managerCards);
            assert.deepEqual(model.plan, expected.plan);
            assert.deepEqual(model.help, expected.help);
            assert.deepEqual(model.capabilities, expected.capabilities);
            assert.equal(calls.get('*MAT_ELASTIC'), 2, 'one model read and a fresh final write-authority check');
            assert.ok([...calls.values()].every(count => count <= 2));
            const field = model.managerCards.flatMap(card => card.fields).find(field => field.name === 'DA');
            const drafts = api.keywordManagerEditField(model, field.fieldId, '0.5');
            const staged = api.buildKeywordOptionViewModel(editor, 0, { ...drafts, deferInstances: true });
            assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true);
            assert.equal(staged.fieldDrafts[field.fieldId], '0.5');
            assert.equal(staged.managerCards.flatMap(card => card.fields).find(value => value.fieldId === field.fieldId).value, field.value);
            model.helpContext.nativeForm.cards[0].fields[0].name = 'changed model metadata';
            model.currentLayout.records[0].fields[0].name = 'changed model record';
            const reopened = api.buildKeywordOptionViewModel(editor, 0, { deferInstances: true });
            assert.deepEqual(reopened.managerCards, expected.managerCards);
            assert.deepEqual(reopened.plan, expected.plan);
            assert.notStrictEqual(reopened.helpContext.nativeForm, model.helpContext.nativeForm);
            assert.equal(editor.document.getText(), materialText);
        } finally { catalog.resolveFormForKeyword = original; }
    });

    it('releases successful, early-return and failed scopes and restores a reentrant model', () => {
        const editor = materialEditor(), nestedEditor = materialEditor();
        const catalog = getCatalogInputFormCatalogV4({ allowUnaudited: false });
        const original = catalog.resolveFormForKeyword;
        const calls = { outer: 0, nested: 0 };
        let phase = 'outer', enter = true, nested;
        catalog.resolveFormForKeyword = function (keyword) {
            if (keyword === '*MAT_ELASTIC') calls[phase]++;
            if (enter) {
                enter = false; phase = 'nested';
                try { nested = api.buildKeywordOptionViewModel(nestedEditor, 0, { deferInstances: true }); }
                finally { phase = 'outer'; }
            }
            return original.call(this, keyword);
        };
        try {
            const outer = api.buildKeywordOptionViewModel(editor, 0, { deferInstances: true });
            assert.deepEqual(outer.managerCards, nested.managerCards);
            assert.deepEqual(outer.plan, nested.plan);
            assert.equal(calls.outer, 2);
            assert.equal(calls.nested, 2);
            const assertFresh = () => assert.notStrictEqual(api.keywordManagerCatalogCatalogForm('*MAT_ELASTIC'),
                api.keywordManagerCatalogCatalogForm('*MAT_ELASTIC'));
            assertFresh();
            assert.equal(api.buildKeywordOptionViewModel(null), null);
            assertFresh();
            const failure = new Error('scope cleanup control');
            const drafts = Object.defineProperty({}, 'selection', { get() { throw failure; } });
            assert.throws(() => api.buildKeywordOptionViewModel(editor, 0, drafts), error => error === failure);
            assertFresh();
            assert.equal(api.buildKeywordOptionViewModel(editor, 0, { deferInstances: true }).readonly, false);
            assert.equal(editor.document.getText(), materialText);
        } finally { catalog.resolveFormForKeyword = original; }
    });

    it('retries missing and failed reads without granting editing permission', () => {
        const catalog = getCatalogInputFormCatalogV4({ allowUnaudited: false });
        const original = catalog.resolveFormForKeyword;
        try {
            for (const failure of [null, new Error('catalog retry control')]) {
                let calls = 0;
                catalog.resolveFormForKeyword = function (keyword) {
                    if (++calls === 1) {
                        if (failure) throw failure;
                        return null;
                    }
                    return original.call(this, keyword);
                };
                const editor = materialEditor();
                const model = api.buildKeywordOptionViewModel(editor, 0, { deferInstances: true });
                assert.ok(calls >= 2);
                assert.ok(model.managerCards.length, 'a later successful lookup still exposes fields');
                assert.equal(model.readonly, true);
                assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
                assert.equal(editor.document.getText(), materialText);
            }
        } finally { catalog.resolveFormForKeyword = original; }
    });

    it('keeps model reads separate when the actual catalog owner changes', () => {
        const previous = process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG;
        delete process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG;
        const editor = materialEditor();
        const catalog = getCatalogInputFormCatalogV4({ allowUnaudited: false });
        const prototype = Object.getPrototypeOf(catalog), original = prototype.resolveFormForKeyword;
        const originalOwn = catalog.resolveFormForKeyword;
        const owners = new Map();
        catalog.resolveFormForKeyword = prototype.resolveFormForKeyword = function (keyword) {
            if (keyword === '*MAT_ELASTIC') owners.set(this, (owners.get(this) || 0) + 1);
            const form = original.call(this, keyword);
            process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG = '1';
            return form;
        };
        try {
            const model = api.buildKeywordOptionViewModel(editor, 0, { deferInstances: true });
            assert.equal(model.readonly, false);
            assert.equal(owners.size, 2);
            assert.equal(owners.get(catalog), 1);
            assert.equal([...owners.entries()].find(([owner]) => owner !== catalog)[1], 2);
            assert.equal(editor.document.getText(), materialText);
        } finally {
            prototype.resolveFormForKeyword = original;
            catalog.resolveFormForKeyword = originalOwn;
            if (previous === undefined) delete process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG;
            else process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG = previous;
            getCatalogInputFormCatalogV4({ allowUnaudited: previous === '1' });
        }
    });

    it('rejects source permission revoked only at the final model check without hiding fields or writing', async () => {
        const editor = materialEditor();
        const catalog = getCatalogInputFormCatalogV4({ allowUnaudited: false });
        const original = catalog.resolveFormForKeyword, originalApply = vscode.workspace.applyEdit;
        let calls = 0, writes = 0;
        catalog.resolveFormForKeyword = function (keyword) {
            const form = original.call(this, keyword);
            return ++calls === 1 ? form : { ...form, source: { ...form.source, conservationSatisfied: false } };
        };
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        try {
            const model = api.buildKeywordOptionViewModel(editor, 0, { deferInstances: true });
            assert.ok(model.managerCards.length);
            assert.equal(model.readonly, true);
            assert.equal(model.inputFormSourceError, 'The catalog source is not verified for editing.');
            assert.ok(model.managerCards.flatMap(card => card.fields).every(field => !field.editable));
            assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
            assert.equal(await api.applyKeywordOptionViewModel({ getModel: () => model, markStale() {} }, editor), null);
            assert.equal(writes, 0);
            assert.equal(editor.document.getText(), materialText);
        } finally { catalog.resolveFormForKeyword = original; vscode.workspace.applyEdit = originalApply; }
    });

    for (const revokeAt of [1, 2]) it(`rechecks source permission after asynchronous permission boundary ${revokeAt}`, async () => {
        const editor = materialEditor();
        const base = api.buildKeywordOptionViewModel(editor, 0, { deferInstances: true });
        const field = base.managerCards.flatMap(card => card.fields).find(field => field.name === 'DA');
        const staged = api.buildKeywordOptionViewModel(editor, 0, api.keywordManagerEditField(base, field.fieldId, '0.5'));
        assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true);
        const catalog = getCatalogInputFormCatalogV4({ allowUnaudited: false });
        const original = catalog.resolveFormForKeyword, originalFs = vscode.workspace.fs;
        const originalApply = vscode.workspace.applyEdit;
        let revoked = false, permissionChecks = 0, writes = 0, stale = 0;
        catalog.resolveFormForKeyword = function (keyword) {
            const form = original.call(this, keyword);
            return revoked ? { ...form, source: { ...form.source, conservationSatisfied: false } } : form;
        };
        vscode.workspace.fs = { ...originalFs, stat: async () => {
            if (++permissionChecks === revokeAt) revoked = true;
            return { permissions: 0 };
        } };
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        try {
            assert.equal(await api.applyKeywordOptionViewModel({ getModel: () => staged, markStale() { stale++; } }, editor), null);
            assert.equal(permissionChecks, revokeAt);
            assert.ok(stale > 0);
            assert.equal(writes, 0);
            assert.equal(editor.document.getText(), materialText);
        } finally {
            catalog.resolveFormForKeyword = original;
            vscode.workspace.fs = originalFs;
            vscode.workspace.applyEdit = originalApply;
        }
    });

    it('reports alias-data failure, blocks existing drafts, and recovers without changing the deck', async () => {
        const text = '*NODES\n       1             0.0             0.0             0.0\n*END\n';
        const document = Object.assign(fakeDoc(text), { languageId: 'lsdyna', version: 1 });
        const editor = { document };
        const baseline = api.buildKeywordOptionViewModel(editor, 0, {});
        const field = baseline.managerCards.flatMap(card => card.fields).find(field => field.editable);
        assert.ok(field, 'the real NODES alias is editable before the failure');
        const drafts = api.keywordManagerEditField(baseline, field.fieldId, '2');
        const staged = api.buildKeywordOptionViewModel(editor, 0, drafts);
        assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true);
        const originalLoad = Module._load, originalApply = vscode.workspace.applyEdit;
        const originalMessage = vscode.window.showInformationMessage;
        let lastMessage;
        vscode.window.showInformationMessage = message => { lastMessage = message; };
        const catalogFile = require.resolve("../../../src/core/semantics/catalogInputFormCatalogV4");
        const i18n = require('../../../src/core/i18n');
        const originalConfiguration = vscode.workspace.getConfiguration;
        let writes = 0;
        Module._load = function (request, parent, isMain) {
            if (parent?.filename === catalogFile && request.endsWith('lspp-node-readers.json'))
                throw Object.assign(new Error('synthetic alias read failure'), { code: 'EACCES' });
            return originalLoad.call(this, request, parent, isMain);
        };
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        try {
            for (const [language, message] of [
                ['zh-cn', '字段信息加载失败，关键字管理器保持只读。请查看“LS-DYNA Debug”输出。'],
                ['en', 'Could not load field information. Keyword Manager is read-only. Check the LS-DYNA Debug output.'],
            ]) {
                vscode.workspace.getConfiguration = (...args) => {
                    const configuration = originalConfiguration(...args);
                    return { ...configuration, get: (key, ...args) => key === 'language'
                        ? language : configuration.get(key, ...args) };
                };
                i18n.updateLanguage();
                const model = api.buildKeywordOptionViewModel(editor, 0, {});
                const state = api.buildKeywordOptionsViewState(model);
                assert.equal(model.inputFormSourceError, 'synthetic alias read failure');
                assert.equal(model.readonly, true);
                assert.equal(state.status, 'error');
                assert.equal(state.message, message);
                assert.equal(state.canApply, false);
                assert.ok(model.managerCards.flatMap(card => card.fields).every(field => !field.editable));
                assert.equal(await api.prepareFieldInteraction(document, { line: 1, character: 20 }), true,
                    'the independently verified NODE reader does not need the NODES alias lookup');
                assert.equal(api.keywordManagerEditField(model, field.fieldId, '2'), null);
                assert.equal(await api.applyKeywordOptionViewModel({ getModel: () => staged, markStale() {} }, editor), null);
                assert.equal(lastMessage, language === 'zh-cn'
                    ? '当前无法应用修改，请刷新关键字管理器后重试。'
                    : 'Cannot apply changes. Refresh the Keyword Manager and try again.');
            }
            assert.equal(writes, 0);
            assert.equal(document.getText(), text);
        } finally {
            Module._load = originalLoad;
            vscode.workspace.applyEdit = originalApply;
            vscode.window.showInformationMessage = originalMessage;
            vscode.workspace.getConfiguration = originalConfiguration;
            i18n.updateLanguage();
        }
        assert.equal(api.buildKeywordOptionViewModel(editor, 0, {}).readonly, false);
        assert.equal(document.getText(), text);
    });

    for (const sourceChange of [{ isUnauditedDiagnostic: true }, { conservationSatisfied: false }, { datasetSha256: '0'.repeat(64) }]) {
        it(`keeps fields viewable but rejects editing and prior plans for ${JSON.stringify(sourceChange)}`, async () => {
            const text = fs.readFileSync(path.join(__dirname, "../../fixtures/public-behavior/native-formats/native-standard.k"), 'utf8');
            const document = Object.assign(fakeDoc(text), { languageId: 'lsdyna', version: 1 });
            const editor = { document };
            const line = text.split(/\r?\n/).indexOf('*MAT_ELASTIC');
            const base = api.buildKeywordOptionViewModel(editor, line, {});
            const field = base.managerCards.flatMap(c => c.fields).find(f => f.name === 'DA');
            const drafts = api.keywordManagerEditField(base, field.fieldId, '0.5');
            assert.ok(drafts);
            const staged = api.buildKeywordOptionViewModel(editor, line, drafts);
            assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true);
            const catalog = getCatalogInputFormCatalogV4({ allowUnaudited: false });
            const original = catalog.resolveFormForKeyword, originalApply = vscode.workspace.applyEdit;
            let writes = 0;
            catalog.resolveFormForKeyword = function (...args) {
                const form = original.apply(this, args);
                return form && { ...form, source: { ...form.source, ...sourceChange } };
            };
            vscode.workspace.applyEdit = async () => { writes++; return true; };
            try {
                const readonly = api.buildKeywordOptionViewModel(editor, line, {});
                assert.ok(readonly.managerCards.length, 'diagnostic fields remain visible');
                assert.equal(readonly.readonly, true);
                assert.equal(api.buildKeywordOptionsViewState(readonly).canApply, false);
                assert.equal(api.keywordManagerEditField(readonly, field.fieldId, '0.5'), null);
                assert.equal(await api.applyKeywordOptionViewModel({ getModel: () => staged, markStale() {} }, editor), null);
                assert.equal(writes, 0);
                assert.equal(document.getText(), text);
                assert.equal(Object.hasOwn(api.buildKeywordOptionsViewState(readonly), 'sourceDocument'), false);
            } finally {
                catalog.resolveFormForKeyword = original;
                vscode.workspace.applyEdit = originalApply;
            }
        });
    }
});
