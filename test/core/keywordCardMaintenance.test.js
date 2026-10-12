'use strict';
const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock: vscode } = require('../support/helpers');
const i18n = require('../../out/core/i18n');
const { keywordCardMaintenanceAction: action, planKeywordCardMaintenance: plan,
    LsdynaKeywordCardsCodeActionProvider: Provider, handleUpdateKeywordCardsCommand: apply } = require('../../out/extension')._internals;
const row = '         1       7.8       210       0.3       400         0         0         0';
const header = '$#     mid        ro         e        pr      sigy      etan      fail      tdel';
function doc(lines, eol = 1) {
    const document = fakeDoc(lines.join(eol === 2 ? '\r\n' : '\n'));
    Object.assign(document, { version: 1, languageId: 'lsdyna', eol,
        uri: { scheme: 'untitled', fsPath: 'maintenance.k', toString: () => 'untitled:maintenance.k' } });
    return document;
}
function edited(document, edit) {
    const text = document.getText();
    const eol = document.eol === 2 ? '\r\n' : '\n';
    const offset = position => Array.from({ length: position.line }, (_, line) => document.lineAt(line).text.length + eol.length)
        .reduce((a, b) => a + b, 0) + position.character;
    return edit.edits.map(item => ({ ...item, start: offset(item.range.start), end: offset(item.range.end) }))
        .sort((a, b) => b.start - a.start || b.end - a.end).reduce((value, item) => value.slice(0, item.start) + item.text + value.slice(item.end), text);
}
describe('keyword card maintenance', () => {
    for (const outcome of ['edited', 'closed', 'cancelled']) it(`rejects ${outcome} documents while preparing code actions`, async () => {
        const schema = require('../../out/core/keywordSchema');
        const originalPrepare = schema.prepareKeywordSchema;
        let resume;
        schema.prepareKeywordSchema = () => new Promise(resolve => { resume = resolve; });
        try {
            const document = doc(['*MAT_024', row, '*END']);
            const token = { isCancellationRequested: false };
            const pending = new Provider().provideCodeActions(document, new vscode.Range(0, 0, 0, 3), {}, token);
            assert.equal(typeof resume, 'function');
            if (outcome === 'edited') document.version++;
            if (outcome === 'closed') document.isClosed = true;
            if (outcome === 'cancelled') token.isCancellationRequested = true;
            resume();
            assert.deepEqual(await pending, []);
        } finally { schema.prepareKeywordSchema = originalPrepare; }
    });
    it('offers one native action at the keyword and inside its bounded block', async () => {
        const document = doc(['*MAT_024', row, '*END']);
        for (const line of [0, 1]) {
            const actions = await new Provider().provideCodeActions(document, new vscode.Range(line, 0, line, 3), {}, {});
            assert.equal(actions.length, 1);
            assert.equal(actions[0].command.command, 'extension.updateKeywordCards');
            assert.equal(actions[0].command.arguments[0].kind, 'comments');
        }
        assert.equal(action(doc(['*MAT_024', header, row, '*END']), 0), null);
    });
    it('preserves user comments, metadata and data; only adds missing field headers', async () => {
        const document = doc(['*MAT_024', '$ material note', '$HMNAME MAT 1 Steel', row, '*END'], 2);
        const request = action(document, 0).request;
        let result;
        assert.equal(await apply(request, { editor: { document }, applyEdit: async edit => {
            assert.ok(edit.edits.every(item => !item.metadata)); result = edited(document, edit); return true;
        } }), true);
        assert.equal(result, ['*MAT_024', '$ material note', '$HMNAME MAT 1 Steel', header, row, '*END'].join('\r\n'));
        assert.equal(action(doc(result.split('\r\n'), 2), 0), null);
    });
    it('inserts a supplied title with preview metadata without shifting or rewriting material values', async () => {
        const document = doc(['*MAT_024_TITLE', '$ custom note', header, row, '*END']);
        const available = action(document, 0);
        assert.equal(available.request.kind, 'title');
        let result;
        assert.equal(await apply(available.request, { editor: { document }, input: async () => 'Door steel', applyEdit: async (edit, metadata) => {
            assert.equal(metadata.isRefactoring, true);
            assert.ok(edit.edits.every(item => item.metadata.needsConfirmation));
            result = edited(document, edit); return true;
        } }), true);
        assert.match(result, /\$# title[^\n]*\nDoor steel\n\$ custom note/);
        assert.ok(result.includes(header + '\n' + row));
        assert.equal(action(doc(result.split('\n')), 0), null);
    });
    it('updates comments for an existing title without adding another title', () => {
        const available = action(doc(['*MAT_024_TITLE', 'Steel', header, row, '*END']), 0);
        assert.equal(available.request.kind, 'comments');
        assert.equal(available.plan.edits.length, 1);
        assert.match(available.plan.edits[0].replacementText, /title/);
        assert.equal(action(doc(['*MAT_024_TITLE', row, '*END']), 0), null, 'ambiguous numeric title is not rewritten');
        assert.equal(action(doc(['*MAT_024_TITLE', header, row.replace('         1', '      &mid'), '*END']), 0), null);
        const numericTitle = action(doc(['*MAT_024_TITLE', '$# title', header, '123', header, row, '*END']), 0);
        assert.equal(numericTitle.request.kind, 'comments', 'a title header prevents another title insertion');
    });
    it('preserves every data record when a full material block gains TITLE', async () => {
        const rows = [row, '         0'.repeat(5), '         0'.repeat(8), '         0'.repeat(8)];
        const document = doc(['*MAT_024_TITLE', header, ...rows, '*END'], 2);
        let result;
        assert.equal(await apply(action(document, 0).request, { editor: { document }, input: async () => 'Steel',
            applyEdit: async edit => { result = edited(document, edit); return true; } }), true);
        assert.deepEqual(result.split('\r\n').filter(line => !/^[$*]/.test(line)), ['Steel', ...rows]);
        assert.equal(action(doc(result.split('\r\n'), 2), 0), null);
    });
    it('does not relabel data with trailing comments or unresolved tokens as an existing title', async () => {
        for (const first of [row + ' $ material note', row.replace('       7.8', '       NaN'), row.replace('       7.8', '     &rho')]) {
            const document = doc(['*MAT_024_TITLE', header, first, row, '*END']);
            assert.equal(action(document, 0), null);
            assert.deepEqual(await new Provider().provideCodeActions(document, new vscode.Range(0, 0, 0, 3), {}, {}), []);
        }
    });
    for (const outcome of ['cancel', 'stale', 'closed', 'invalid']) it(`does not edit after ${outcome} during title entry`, async () => {
        const document = doc(['*MAT_024_TITLE', header, row, '*END']);
        let applied = false;
        const result = await apply(action(document, 0).request, { editor: { document }, input: async () => {
            if (outcome === 'cancel') return undefined;
            if (outcome === 'stale') document.version++;
            if (outcome === 'closed') document.isClosed = true;
            return outcome === 'invalid' ? '*END\n1' : 'Steel';
        }, applyEdit: async () => { applied = true; return true; } });
        assert.equal(result, false); assert.equal(applied, false);
    });
    it('rejects requests from a previous version and rejects the wrong operation', async () => {
        const document = doc(['*MAT_024', row, '*END']);
        const request = action(document, 0).request;
        assert.equal(await apply({ ...request, kind: 'title' }, { editor: { document } }), false);
        document.version++;
        assert.equal(await apply(request, { editor: { document } }), false);
    });
    it('does not rewrite keywords inside opaque COMMENT blocks', () => {
        assert.equal(action(doc(['*COMMENT', '  *MAT_024', row, '*END']), 1), null);
        assert.equal(action(doc(['*COMMENT *MAT_024', row, '*END']), 0), null);
    });
    it('does not relabel a retained title as material data after removing TITLE', () => {
        assert.equal(action(doc(['*MAT_024', '$# title', 'Steel', header, row, '*END']), 0), null);
    });
    it('honors readonly resources and preview cancellation', async () => {
        const original = vscode.workspace.fs;
        const document = doc(['*MAT_024', row, '*END']);
        const request = action(document, 0).request;
        document.uri.scheme = 'readonly';
        vscode.workspace.fs = { isWritableFileSystem: () => false };
        try { assert.equal(await apply(request, { editor: { document }, applyEdit: () => { throw Error('must not apply'); } }), false); }
        finally { vscode.workspace.fs = original; }
        document.uri.scheme = 'untitled';
        assert.equal(await apply(request, { editor: { document }, applyEdit: async () => false }), false);
    });
    it('stays bounded and skips cancellation, repeated or unsupported layouts', async () => {
        let reads = 0;
        const large = { ...doc(['*MAT_024']), lineCount: 2_000_000,
            lineAt: line => { reads++; assert.ok(line <= 256); return { text: line ? row : '*MAT_024' }; } };
        assert.equal(plan(large, 0), null); assert.ok(reads <= 257);
        reads = 0;
        assert.deepEqual(await new Provider().provideCodeActions(large, new vscode.Range(0, 0, 0, 1), {}, { isCancellationRequested: true }), []);
        assert.equal(reads, 0);
        assert.deepEqual(await new Provider().provideCodeActions(large, new vscode.Range(0, 0, 0, 1), { only: { contains: () => false } }, {}), []);
        assert.equal(reads, 0);
        assert.equal(action(doc(['*MAT_024', '1,2,3', '*END']), 0), null);
        assert.equal(action(doc(['*NODE', '       1             0.0             0.0             0.0', '       2             0.0             0.0             0.0', '*END']), 0), null);
    });
    it('offers the existing verified conditional-card insertion with preview', async () => {
        const schema = require('../../keywords/runtime/schema/field_data.json');
        const cards = schema.MAT_WINFRITH_CONCRETE.c.slice(0, 2).map((card, index) => {
            const text = Array(80).fill(' '); const name = index ? 'RATE' : 'MID';
            const field = card.find(field => field.n === name); text[field.p + field.w - 1] = index ? '8' : '1'; return text.join('');
        });
        const document = doc(['*MAT_WINFRITH_CONCRETE', ...cards, '*END']);
        const available = action(document, 0); assert.equal(available.request.kind, 'conditional');
        assert.equal(await apply(available.request, { editor: { document }, applyEdit: async edit => {
            assert.ok(edit.edits.every(item => item.metadata.needsConfirmation));
            assert.ok(edited(document, edit).includes(cards.join('\n'))); return true;
        } }), true);
    });
    it('uses action-specific labels in both languages', () => {
        const original = vscode.workspace.getConfiguration;
        try {
            for (const [locale, comments, title] of [['en', 'Update field comments', 'Insert title and update comments…'],
                ['zh-cn', '更新字段注释', '补充标题行并更新注释…']]) {
                vscode.workspace.getConfiguration = () => ({ get: key => key === 'language' ? locale : undefined }); i18n.updateLanguage();
                assert.equal(action(doc(['*MAT_024', row, '*END']), 0).title, comments);
                assert.equal(action(doc(['*MAT_024_TITLE', header, row, '*END']), 0).title, title);
            }
        } finally { vscode.workspace.getConfiguration = original; i18n.updateLanguage(); }
    });
});
