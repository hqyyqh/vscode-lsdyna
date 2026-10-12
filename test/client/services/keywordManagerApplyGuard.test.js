const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock: vscode } = require("../../support/helpers");
const { createKeywordManagerApply } = require('../../../src/client/services/keywordManagerApply');
const { keywordOptionsEditorForModel, keywordManagerHasStaging, keywordSpellingFromLine } = require('../../../src/extension')._internals;
const i18n = require('../../../src/core/i18n');

// Supply a valid proposal to isolate asynchronous commit safety from layout tests.
describe('manager commit document and preview identity', () => {
    for (const scenario of ['unchanged', 'stale-before-apply', 'close', 'version', 'replacement-document', 'replacement-model', 'permission-changed-at-apply', 'closed-during-confirmation', 'replacement-mismatch']) {
        it(`handles ${scenario} without applying an obsolete preview`, async () => {
            const document = { ...fakeDoc('*NODE\n       1\n*END'), version: 1, languageId: 'lsdyna' };
            const editor = { document };
            const model = { sourceDocument: document, uri: '/test/file.k', documentVersion: 1,
                keywordLine: 0, targetKeyword: '*NODE', plan: { status: 'ready' },
                stale: scenario === 'stale-before-apply' };
            let currentModel = model, permissionChecks = 0, writes = 0, stale = 0, refreshes = 0;
            const originalApply = vscode.workspace.applyEdit, originalWarning = vscode.window.showWarningMessage;
            vscode.workspace.applyEdit = async () => { writes++; return true; };
            vscode.window.showWarningMessage = async () => {
                if (scenario === 'closed-during-confirmation') document.isClosed = true;
                return i18n.get('keywordOptionsTreeDiscardConfirm');
            };
            const service = createKeywordManagerApply({
                keywordOptionsEditorForModel,
                keywordManagerCatalogAllowsWrite: () => true,
                documentUriIdentity: doc => doc?.uri?.fsPath,
                isDocumentReadonlyForAutomaticEdit: async () => {
                    permissionChecks++;
                    if (permissionChecks === 1) {
                        if (scenario === 'close') document.isClosed = true;
                        if (scenario === 'version') document.version++;
                        if (scenario === 'replacement-document') editor.document = { ...document };
                        if (scenario === 'replacement-model') currentModel = { ...model };
                    }
                    return scenario === 'permission-changed-at-apply' && permissionChecks === 2;
                },
                buildKeywordManagerCatalogPlan: () => ({ plan: { status: 'ready', documentVersion: 1,
                    requiresLossConfirmation: scenario === 'closed-during-confirmation',
                    discardedFields: [{ name: 'X', value: '2' }] } }),
                keywordManagerPrepareCatalogInputFormLayout() {}, keywordManagerPrepareCatalogSelectorLayout() {},
                keywordManagerStageFieldDrafts: () => true, keywordOptionBlockSha256: () => 'fixed-evidence',
                optionSwitchReplacement: () => ({ range: new vscode.Range(1, 0, 1, 8), text: '       2' }),
                keywordManagerReplacementMatchesTarget: () => scenario !== 'replacement-mismatch',
            });
            try {
                const result = await service.applyKeywordOptionViewModel({ getModel: () => currentModel,
                    markStale() { stale++; }, refreshModel() { refreshes++; return model; } }, editor);
                assert.equal(writes, scenario === 'unchanged' ? 1 : 0);
                assert.equal(Boolean(result), scenario === 'unchanged');
                assert.equal(refreshes, 0, 'Apply must never silently regenerate a stale preview');
                assert.equal(document.getText(), '*NODE\n       1\n*END');
                if (!['unchanged', 'replacement-mismatch'].includes(scenario)) assert.ok(stale > 0);
            } finally { vscode.workspace.applyEdit = originalApply; vscode.window.showWarningMessage = originalWarning; }
        });
    }

    it('rejects same-URI reopened documents and excludes closed documents from lookup', () => {
        const sourceDocument = { ...fakeDoc('*NODE'), version: 1 };
        const model = { uri: '/test/file.k', sourceDocument };
        assert.equal(keywordOptionsEditorForModel(model, { document: { ...sourceDocument } }), null);
        sourceDocument.isClosed = true;
        assert.equal(keywordOptionsEditorForModel(model, { document: sourceDocument }), null);
    });
});

describe('manager transition answers stay with the prompted proposal', () => {
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
    const filename = path.resolve(__dirname, '../../../src/extension.ts');
    const parsed = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const names = ['refreshKeywordOptionsView', 'refreshSelectedKeywordOptions', 'confirmKeywordManagerTransition'];
    const closures = new Map();
    let refreshCommand;
    const visit = node => {
        if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(parsed))) {
            assert.ok(!closures.has(node.name.getText(parsed)));
            closures.set(node.name.getText(parsed), node.getText(parsed));
        }
        if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'vscode.commands.registerCommand' &&
            ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'extension.keywordOptions.refresh') {
            assert.equal(refreshCommand, undefined);
            refreshCommand = node.arguments[1].getText(parsed);
        }
        ts.forEachChild(node, visit);
    };
    visit(parsed);
    assert.equal(closures.size, names.length);
    assert.ok(refreshCommand);
    const code = ts.transpileModule(names.map(name => `const ${closures.get(name)};`).join('\n') +
        `\nmodule.exports = { refreshKeywordOptionsView, refreshCommand: ${refreshCommand} };`,
        { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;

    async function run(boundary, answer, stale = false) {
        const source = '*NODE\n       1\n*NODE\n       2\n*END';
        const document = { ...fakeDoc(source), version: 1, languageId: 'lsdyna' };
        const editor = { document, selection: { active: new vscode.Position(0, 0) } };
        const modelFor = (line, drafts) => ({ sourceDocument: document, uri: document.uri.fsPath,
            documentVersion: 1, keywordLine: line, currentKeyword: '*NODE', targetKeyword: '*NODE',
            selectedInstanceId: `node:${line}`, fieldDrafts: drafts, plan: { status: 'ready' }, directoryStatus: 'ready' });
        const initial = modelFor(0, { NID: '11' });
        initial.stale = stale;
        const writes = [], published = [];
        let releasePreparation, preparationStarted, answerModal, modalShown;
        const preparing = new Promise(resolve => { releasePreparation = resolve; });
        const started = new Promise(resolve => { preparationStarted = resolve; });
        const modal = new Promise(resolve => { answerModal = resolve; });
        const shown = new Promise(resolve => { modalShown = resolve; });
        const prepare = async stage => { if (boundary === stage) { preparationStarted(); await preparing; } };
        const context = { module: { exports: {} }, vscode, i18n, keywordOptionsModel: initial,
            setTimeout: callback => { void prepare('yield').then(callback); },
            keywordStructureCatalog: { prepare: () => prepare('structure') },
            keywordOptionsPinned: true, keywordOptionsRefreshGeneration: 0, activeProjectCacheEpoch: 0,
            isLsdynaFile: doc => doc.languageId === 'lsdyna', readyCardEditBlockIndex: () => ({}),
            findKeywordLineForLine: (doc, line) => { assert.equal(doc.lineAt(line).text, '*NODE'); return line; },
            keywordSpellingFromLine, isKeywordManagerUnauditedCatalogAllowed: () => false,
            getCatalogInputFormCatalogV4: () => ({ prepareKeyword: () => prepare('catalog') }),
            lookupKeywordInfo: () => ({ canonicalName: 'NODE' }),
            getManualSemanticCatalog: () => ({ prepareKeyword: keyword => {
                assert.equal(keyword, '*NODE'); return prepare('semantic');
            } }),
            require: request => {
                if (request === './core/keywordSchema') return { prepareKeywordSchema: () => prepare('schema'),
                    prepareFieldHelpTextIndex: () => prepare('help') };
                assert.equal(request, "./core/semantics/catalogNativeFileLayout");
                return require("../../../src/core/semantics/catalogNativeFileLayout");
            },
            buildKeywordOptionViewModel: (_editor, line, staged) => modelFor(line, staged.fieldDrafts || {}),
            buildKeywordOptionsViewState: model => model,
            keywordOptionsWebviewProvider: { publish: model => published.push(model) }, logDebug() {},
            keywordOptionsEditorForModel, keywordManagerRefreshLine: model => model.keywordLine,
            keywordManagerHasStaging,
        };
        context.keywordOptionsModelAdapter = { getModel: () => context.keywordOptionsModel,
            markStale: () => { context.keywordOptionsModel.stale = true; } };
        // The actual Apply service consumes a valid planner proposal. Preparation,
        // planner and WorkspaceEdit boundaries remain explicit unit-test seams.
        context.applyKeywordOptionViewModel = createKeywordManagerApply({
            keywordOptionsEditorForModel, keywordManagerCatalogAllowsWrite: () => true,
            documentUriIdentity: doc => doc.uri.fsPath, isDocumentReadonlyForAutomaticEdit: async () => false,
            buildKeywordManagerCatalogPlan: () => ({ plan: { status: 'ready', documentVersion: 1 } }),
            keywordManagerPrepareCatalogInputFormLayout() {}, keywordManagerPrepareCatalogSelectorLayout() {},
            keywordManagerStageFieldDrafts: () => true, keywordOptionBlockSha256: () => 'fixed-evidence',
            optionSwitchReplacement: (_doc, model) => ({ range: new vscode.Range(model.keywordLine + 1, 0, model.keywordLine + 1, 8),
                text: model.fieldDrafts.NID.padStart(8) }), keywordManagerReplacementMatchesTarget: () => true,
        }).applyKeywordOptionViewModel;
        vm.runInNewContext(code, context, { filename });
        const originalApply = vscode.workspace.applyEdit, originalWarning = vscode.window.showWarningMessage;
        const originalEditor = vscode.window.activeTextEditor;
        vscode.window.activeTextEditor = editor;
        vscode.workspace.applyEdit = async edit => { writes.push(...edit.edits); return true; };
        vscode.window.showWarningMessage = async () => { modalShown(); return modal; };
        try {
            let replacement;
            const earlyRefresh = boundary && context.module.exports.refreshKeywordOptionsView(editor, 2, { fieldDrafts: { NID: '22' } });
            if (boundary) {
                await started;
                assert.equal(context.keywordOptionsModel, initial, 'earlier refresh must still await real preparation');
            }
            const pending = context.module.exports.refreshCommand();
            await shown;
            if (boundary) {
                releasePreparation();
                replacement = await earlyRefresh;
                assert.equal(context.keywordOptionsModel, replacement);
                assert.equal(replacement.keywordLine, 2);
                assert.equal(replacement.fieldDrafts.NID, '22');
                assert.equal(published.length, 1, 'generation-current refresh must actually publish before the modal answer');
            }
            answerModal(answer === 'apply' ? i18n.get('keywordOptionsApply')
                : answer === 'discard' ? i18n.get('keywordManagerDiscardDraftConfirm') : undefined);
            const result = await pending;
            if (boundary) {
                assert.deepEqual(writes, [], 'an old modal must not write the replacement proposal');
                assert.equal(context.keywordOptionsModel.fieldDrafts.NID, '22', 'an old Discard must preserve replacement drafts');
                assert.equal(context.keywordOptionsModel, replacement);
                assert.equal(published.length, 1);
                assert.equal(result, null);
            } else if (answer === 'cancel') {
                assert.equal(result, null);
                assert.equal(context.keywordOptionsModel, initial);
                assert.equal(initial.fieldDrafts.NID, '11');
                assert.deepEqual(writes, []);
            } else {
                assert.ok(result);
                assert.equal(result.keywordLine, 0);
                assert.deepEqual(Object.keys(result.fieldDrafts), []);
                assert.equal(writes.length, answer === 'apply' ? 1 : 0);
                if (writes.length) {
                    assert.equal(writes[0].uri, document.uri);
                    assert.equal(writes[0].range.start.line, 1);
                    assert.equal(writes[0].text, '      11');
                }
            }
            assert.equal(document.getText(), source, 'these unit boundaries never mutate physical source bytes');
        } finally {
            vscode.workspace.applyEdit = originalApply;
            vscode.window.showWarningMessage = originalWarning;
            vscode.window.activeTextEditor = originalEditor;
        }
    }
    for (const boundary of ['schema', 'structure', 'catalog', 'semantic', 'help', 'yield']) for (const answer of ['apply', 'discard'])
        it(`rejects old ${answer} after an earlier ${boundary} refresh publishes`, () => run(boundary, answer));
    for (const answer of ['apply', 'discard', 'cancel'])
        it(`preserves same-proposal ${answer}`, () => run(null, answer));
    it('preserves same-proposal stale Discard recovery', () => run(null, 'discard', true));
});
