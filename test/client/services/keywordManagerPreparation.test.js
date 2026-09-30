'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require('../../helpers');
const api = require('../../../src/extension')._internals;
const schema = require('../../../src/core/keywordSchema');
const text = '*KEYWORD\n*MAT_ELASTIC\n         7    7.8e-9    210000       0.3\n*END';
function document() {
    const result = fakeDoc(text, '/manager-preparation/model.k');
    result.version = 1; result.languageId = 'lsdyna'; result.isClosed = false;
    return result;
}
describe('asynchronous native manager directory preparation', () => {
    it('keeps repeated native record identity when opening on a later instance or its comment', async () => {
        const { documentFor, editorFor } = require('../../keyword-manager/conditional-fixtures.cjs')({
            vscode: require('vscode'), generateCommentLine: api.generateCommentLine });
        const lines = ['*DATABASE_BINARY_RUNRSF', '$ first', '101,1,1,1,1,,1', '$ misleading', '202,1,1,1,1,,1', '*END'];
        for (const line of [0, 3, 4]) {
            const doc = documentFor(lines);
            const first = api.buildKeywordOptionViewModel(editorFor(doc), line, { deferInstances: true });
            const full = api.buildKeywordOptionViewModel(editorFor(documentFor(lines)), line);
            assert.equal(first.selectedInstanceId, full.selectedInstanceId);
            assert.deepEqual(first.managerCards, full.managerCards);
            await api.prepareKeywordManagerInstances(doc, null);
            assert.equal(api.completeKeywordManagerInstances(first, doc, null), true);
            assert.deepEqual(first.managerInstances, full.managerInstances);
        }
    });
    it('makes the selected native instance available without reading unrelated blocks and merges only the directory', async () => {
        const { documentFor, editorFor } = require('../../keyword-manager/conditional-fixtures.cjs')({
            vscode: require('vscode'), generateCommentLine: api.generateCommentLine });
        const lines = ['*KEYWORD', '*DATABASE_BINARY_BLSTFOR', '7,1,1,1,1',
            ...Array.from({ length: 40 }, () => ['*MAT_ELASTIC', '         7    7.8e-9    210000       0.3']).flat(), '*END'];
        const doc = documentFor(lines), editor = editorFor(doc);
        const expected = api.buildKeywordOptionViewModel(editorFor(documentFor(lines)), 1);
        const catalog = api.getCatalogInputFormCatalogV4({ allowUnaudited: false });
        const original = catalog.resolveFormForKeyword;
        catalog.resolveFormForKeyword = function(keyword) {
            assert.notEqual(keyword.replace(/^\*/, ''), 'MAT_ELASTIC', 'First view must not load unrelated forms');
            return original.call(this, keyword);
        };
        let model;
        try { model = api.buildKeywordOptionViewModel(editor, 1, { deferInstances: true }); }
        finally { catalog.resolveFormForKeyword = original; }
        assert.equal(model.directoryStatus, 'loading');
        assert.deepEqual(model.managerCards, expected.managerCards);
        assert.deepEqual(model.plan, expected.plan);
        assert.equal(model.selectedInstanceId, expected.selectedInstanceId);
        assert.equal(api.keywordManagerInstanceDirectories.has(doc), false, 'Partial directory must not enter complete cache');
        model.fieldDrafts = { retained: 'user input' };
        const before = { ...model };
        await api.prepareKeywordManagerInstances(doc, null);
        assert.equal(api.completeKeywordManagerInstances(model, doc, null), true);
        assert.deepEqual(model.managerInstances, expected.managerInstances);
        for (const key of Object.keys(before).filter(key => !['managerInstances', 'directoryStatus'].includes(key))) {
            assert.strictEqual(model[key], before[key], `${key} changed during directory completion`);
        }
        doc.version++;
        assert.equal(api.completeKeywordManagerInstances(model, doc, null), false);
    });
    it('preserves the synchronous instance directory without rereading it after preparation', async () => {
        const first = document(), second = document();
        const expected = api.keywordManagerInstances(first, 1, null);
        assert.equal(await api.prepareKeywordManagerInstances(second, null), true);
        const read = second.lineAt;
        second.lineAt = () => { throw Error('Prepared directory was synchronously rebuilt'); };
        try { assert.deepEqual(api.keywordManagerInstances(second, 1, null), expected); }
        finally { second.lineAt = read; }
    });
    for (const change of ['version', 'closed', 'superseded']) it(`discards a ${change} document while catalog preparation is pending`, async () => {
        await schema.prepareKeywordSchema();
        const doc = document(), catalog = api.getCatalogInputFormCatalogV4({ allowUnaudited: false });
        const original = catalog.prepareKeyword;
        let entered, release, current = true;
        const started = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        catalog.prepareKeyword = async () => { entered(); await gate; };
        try {
            const pending = api.prepareKeywordManagerInstances(doc, null, () => current);
            await started;
            if (change === 'version') doc.version++;
            if (change === 'closed') doc.isClosed = true;
            if (change === 'superseded') current = false;
            release();
            assert.equal(await pending, false);
            assert.equal(api.keywordManagerInstanceDirectories.has(doc), false);
        } finally { release(); catalog.prepareKeyword = original; }
    });
});
