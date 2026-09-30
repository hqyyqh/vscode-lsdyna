const assert = require('node:assert/strict');
const { fakeDoc, vscodeMock: vscode } = require('../../helpers');
const { createKeywordManagerApply } = require('../../../src/client/services/keywordManagerApply');
const { keywordOptionsEditorForModel } = require('../../../src/extension')._internals;
const i18n = require('../../../src/core/i18n');

// Supply a valid proposal to isolate asynchronous commit safety from layout tests.
describe('manager commit document and preview identity', () => {
    for (const scenario of ['unchanged', 'stale-before-apply', 'close', 'version', 'replacement-document', 'replacement-model', 'permission-changed-at-apply', 'closed-during-confirmation']) {
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
            });
            try {
                const result = await service.applyKeywordOptionViewModel({ getModel: () => currentModel,
                    markStale() { stale++; }, refreshModel() { refreshes++; return model; } }, editor);
                assert.equal(writes, scenario === 'unchanged' ? 1 : 0);
                assert.equal(Boolean(result), scenario === 'unchanged');
                assert.equal(refreshes, 0, 'Apply must never silently regenerate a stale preview');
                assert.equal(document.getText(), '*NODE\n       1\n*END');
                if (scenario !== 'unchanged') assert.ok(stale > 0);
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
