'use strict';
const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock: vscode } = require('../support/helpers');
const i18n = require('../../out/core/i18n');
const api = require('../../out/extension')._internals;
const { keywordCardMaintenanceAction: action, planKeywordCardMaintenance: plan,
    LsdynaKeywordCardsCodeActionProvider: Provider, handleUpdateKeywordCardsCommand: apply } = api;
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
async function updateComments(lines, expectedCount, eol = 1) {
    const document = doc(lines, eol), available = action(document, 0);
    assert.equal(available?.request.kind, 'comments', lines[0]);
    assert.equal(available.plan.edits.length, expectedCount, lines[0]);
    let result;
    assert.equal(await apply(available.request, { editor: { document }, applyEdit: async edit => {
        assert.ok(edit.edits.every(item => !item.metadata));
        result = edited(document, edit); return true;
    } }), true);
    const updated = result.split(eol === 2 ? '\r\n' : '\n');
    const data = rows => rows.filter(line => !line.trimStart().startsWith('$'));
    assert.deepEqual(data(updated), data(lines), 'data bytes and record order must be preserved');
    assert.equal(action(doc(updated, eol), 0), null, 'a second update must be a no-op');
    return updated;
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
            lineAt: line => { reads++; assert.ok(line <= 257); return { text: line ? row : '*MAT_024' }; } };
        assert.equal(plan(large, 0), null); assert.ok(reads <= 259);
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

    it('updates the reported MAT 240 deck and keeps short, empty and punctuation titles complete', async () => {
        const rows = ['  46000014   1.94E-9                  1.      1.54      1.46',
            '      16.4                         17.38', '      19.4                          12.2'];
        for (const title of ['CKE_mat_240_Thermal_Structural_Adhesive_2210_failure_scale_2',
            'Steel', 'A', '', '   ', 'Steel, test', 'R&D adhesive']) {
            const result = await updateComments(['*MAT_COHESIVE_MIXED_MODE_ELASTOPLASTIC_RATE_TITLE', title, ...rows, '*END'], 4, 2);
            assert.equal(result[1].trimEnd(), '$# title');
        }
        for (const suffix of ['TITLE', '3MODES_TITLE', 'FUNCTIONS_TITLE', 'FUNCTIONS_3MODES_TITLE', 'THERMAL_TITLE', 'THERMAL_3MODES_TITLE']) {
            await updateComments(['*MAT_COHESIVE_MIXED_MODE_ELASTOPLASTIC_RATE_' + suffix, 'Adhesive', ...rows, '*END'], 4);
        }
        for (const title of ['Steel, test', 'R&D adhesive']) await updateComments(['*MAT_024_TITLE', title, row, '*END'], 2);
    });

    it('uses intrinsic PART names, complete native layouts and explicit zero-field records', async () => {
        await updateComments(['*PART', '$# title', 'A', '         1         1         1', '*END'], 1);
        await updateComments(['*SECTION_SPRING-DAMPER',
            '     11117         0       0.0       0.0       0.0       0.0', '         0         0', '*END'], 2);
        const result = await updateComments(['*BATTERY_ECHEM_CONTROL_THERMAL', '         0'.repeat(8), '$ keep empty record', '', '*END'], 1);
        assert.ok(result.includes('$ keep empty record'));
        assert.equal(action(doc(['*CONTROL_TERMINATION', '1.0', '', '*END']), 0), null, 'an arbitrary blank is still a data record');
    });

    it('supports native-only single instances without enabling repeated instances', async () => {
        const fixture = require('../fixtures/public-behavior/single-card-prefix-scope-display.json');
        for (const keyword of ['BOUNDARY_CYCLIC_ID', 'CONSTRAINED_JOINT_REVOLUTE_ID']) {
            const task = fixture.identities.find(item => item.keyword === keyword).cases.find(item => item.format === 'standard');
            await updateComments([...task.lines.slice(0, 3), '*END'], 2);
            assert.equal(action(doc([...task.lines, '*END']), 0), null);
        }
    });

    it('covers both contact suffix orders using independent captured record counts', async function () {
        this.timeout(30000);
        const fixtures = ['contact-id-mpp', 'contact-mpp-tail'].flatMap(name => require('../fixtures/public-behavior/' + name + '.json').specimens.tasks);
        const bindings = ['lspp-contact-id-mpp-fixed-readers', 'lspp-contact-mpp-tail-readers']
            .flatMap(name => Object.keys(require('../../keywords/runtime/native-readers/' + name + '.json').bindings));
        let complete = 0, incomplete = 0;
        for (const keyword of bindings) {
            const source = fixtures.find(task => task.keyword === keyword && task.format === 'standard')
                || fixtures.find(task => task.keyword === keyword.replace(/_MPP_ID$/, '_ID_MPP') && task.format === 'standard');
            assert.ok(source, keyword);
            const lines = ['*' + keyword, ...source.lines.slice(1), '*END'];
            const observed = source.expectedRecords || source.records;
            if (observed.length !== source.lines.length - 1) {
                assert.equal(action(doc(lines), 0), null, keyword + ': capture did not resolve the complete input');
                incomplete++;
            } else {
                await updateComments(lines, observed.length);
                complete++;
            }
        }
        assert.deepEqual({ complete, incomplete }, { complete: 104, incomplete: 22 });
    });

    it('uses current remote parameter controls on the first Quick Fix request', async function () {
        this.timeout(30000);
        const document = doc(['*PARAMETER', 'Iform              2', '*SECTION_BEAM',
            '         1     &form         0         0         0         0         0         0',
            '         1         2         3         4         5', '*END']);
        document.uri = vscode.Uri.file(require('node:path').resolve('out/comment-parameters.k'));
        const { index } = await require('../support/parameter-project.cjs').parameterProject(document.uri.fsPath,
            new Map([[document.uri.fsPath, document.getText()]]));
        const { analyzeIntegerParameterValueAtLocation } = require('../../out/core/references/projectReferenceIndex');
        let queries = 0;
        api.setReferenceQueryClientForTesting({ sourceAnalysis: async request => {
            queries++;
            assert.equal(request.mode, 'parameters');
            return { status: 'ready', results: request.fields.map(field => analyzeIntegerParameterValueAtLocation(index,
                field.raw, { documentPath: request.filePath, lineIndex: field.line })) };
        } });
        try {
            const actions = await new Provider().provideCodeActions(document, new vscode.Range(2, 0, 2, 4), {}, {});
            assert.equal(actions.length, 1);
            assert.ok(queries > 0);
            const result = api.planCardCommentRewriteForDocument(document, 2);
            assert.equal(result.status, 'ready');
            assert.match(result.edits[1].replacementText, /iss\s+itt\s+j\s+sas/);
        } finally { api.setReferenceQueryClientForTesting(null); }
    });

    it('does not publish a comment action after a parameter request becomes stale', async () => {
        const document = doc(['*SECTION_BEAM', '         1     &form', '         1         2', '*END']);
        document.uri = vscode.Uri.file(require('node:path').resolve('out/stale-comment-parameters.k'));
        api.setReferenceQueryClientForTesting({ sourceAnalysis: async () => {
            document.version++; return { status: 'ready', results: [{ resolved: true, value: 2 }] };
        } });
        try {
            assert.deepEqual(await new Provider().provideCodeActions(document, new vscode.Range(0, 0, 0, 4), {}, {}), []);
        } finally { api.setReferenceQueryClientForTesting(null); }
    });

    it('agrees at the physical line limit with and without a ready block index', () => {
        for (const bodyLines of [256, 257]) {
            const document = doc(['*MAT_024', row, ...Array(bodyLines - 1).fill('$ note'), '*END']);
            for (const blockIndex of [null, { lineCount: document.lineCount, findBlockAtLine: () => ({ startLine: 0, endLine: bodyLines }) }]) {
                const result = api.planCardCommentRewriteForDocument(document, 0, { blockIndex });
                assert.equal(result.status === 'ready', bodyLines === 256);
            }
        }
    });

    it('publishes the same action in compact and detailed Hover, including native-only spellings', async () => {
        const provider = new api.LsdynaFieldHoverProvider();
        const inputs = [['*MAT_024', row, '*END'], ['*MAT_ELASTIC_TITLE', 'A', row, '*END'],
            ['*BOUNDARY_CYCLIC_ID', '   1000001Heading', '         0'.repeat(8), '*END']];
        for (const lines of inputs) {
            const document = doc(lines);
            for (const detailed of [false, true]) {
                const hover = await provider.provideHover(document, new vscode.Position(0, 5), undefined, detailed);
                const link = hover.contents[0].value.match(/command:extension\.updateKeywordCards\?([^ )"]+)/);
                assert.ok(link, lines[0] + ': detailed=' + detailed);
                assert.deepEqual(JSON.parse(decodeURIComponent(link[1])), [action(document, 0).request]);
            }
        }
    });

    it('completes title and native-only comments without granting formatting permission', async () => {
        const provider = new api.LsdynaFieldCompletionProvider(), original = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = (...args) => {
            const config = original(...args);
            return { ...config, get: (key, fallback) => key === 'ignoreFormattingKeywords' ? ['*MAT', '*BOUNDARY'] : config.get(key, fallback) };
        };
        try {
            for (const [keyword, title] of [['*MAT_ELASTIC_TITLE', 'A'], ['*MAT_024_TITLE', 'R&D, adhesive']]) {
                const document = doc([keyword, '$#', title, row, '*END']);
                const items = await provider.provideCompletionItems(document, new vscode.Position(1, 2), {}, {});
                assert.equal(items.length, 1);
                assert.equal(items[0].insertText.trimEnd(), '$# title');
                assert.equal(api.getCardFieldsForLine(document, 2), null, 'formatting stays excluded');
            }
            const document = doc(['*BOUNDARY_CYCLIC_ID', '   1000001Heading', '$#', '         0'.repeat(8), '*END']);
            assert.equal(api.getCardFieldsForLine(document, 3), null);
            const items = await provider.provideCompletionItems(document, new vscode.Position(2, 2), {}, {});
            assert.equal(items.length, 1);
            assert.match(items[0].insertText, /xc\s+yc\s+zc\s+nsid1/);
            for (const lines of [['*MAT_024 +', '$#', row, '*END'], ['*MAT_024', '$#', '1,2,3', '*END']]) {
                assert.deepEqual(await provider.provideCompletionItems(doc(lines), new vscode.Position(1, 2), {}, {}), []);
            }
        } finally { vscode.workspace.getConfiguration = original; }
    });

    it('keeps a mismatch notice but omits its repair link when the block cannot be updated', () => {
        const document = doc(['*NODE', '       1             0.0             0.0             0.0',
            '       2             0.0             0.0             0.0', '*END']);
        const info = { cardCommentNotice: { kind: 'definition-mismatch', differences: [] } };
        const markdown = api.buildCardCommentNoticeMarkdown(info, document, 0, 1);
        assert.ok(markdown.includes(i18n.get('cardCommentVersionHint')));
        assert.ok(!markdown.includes('command:extension.rebuildCardComments'));
    });
});
