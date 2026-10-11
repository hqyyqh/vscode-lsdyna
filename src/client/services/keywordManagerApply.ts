/** Keyword Manager commit service. VS Code lifecycle stays in the entry point. */
const vscode = require('vscode');
const i18n = require('../../core/i18n');
const { createDocumentEditGuard } = require('./documentEditGuard');

export function createKeywordManagerApply(host: {
    keywordOptionsEditorForModel: (...args: any[]) => any;
    documentUriIdentity: (...args: any[]) => any;
    isDocumentReadonlyForAutomaticEdit: (...args: any[]) => any;
    buildKeywordManagerCatalogPlan: (...args: any[]) => any;
    keywordManagerPrepareCatalogInputFormLayout: (...args: any[]) => any;
    keywordManagerPrepareCatalogSelectorLayout: (...args: any[]) => any;
    keywordManagerStageFieldDrafts: (...args: any[]) => any;
    keywordOptionBlockSha256: (...args: any[]) => any;
    optionSwitchReplacement: (...args: any[]) => any;
    keywordManagerReplacementMatchesTarget: (...args: any[]) => boolean;
    keywordManagerCatalogAllowsWrite: (...args: any[]) => boolean;
}) {
    const {
        keywordOptionsEditorForModel,
        documentUriIdentity,
        isDocumentReadonlyForAutomaticEdit,
        buildKeywordManagerCatalogPlan,
        keywordManagerPrepareCatalogInputFormLayout,
        keywordManagerPrepareCatalogSelectorLayout,
        keywordManagerStageFieldDrafts,
        keywordOptionBlockSha256,
        optionSwitchReplacement,
        keywordManagerReplacementMatchesTarget,
        keywordManagerCatalogAllowsWrite,
    } = host;

    async function applyKeywordOptionViewModel(provider, editor = vscode.window.activeTextEditor) {
        let model = provider?.getModel?.();
        editor = keywordOptionsEditorForModel(model, editor);
        let document = editor?.document;
        if (!model || !document || document.isClosed || documentUriIdentity(document) !== model.uri) {
            vscode.window.showInformationMessage(i18n.get('keywordOptionsEditorUnavailable'));
            return null;
        }
        if (model.stale || document.version !== model.documentVersion) {
            provider.markStale(model.uri);
            return null;
        }
        const documentIsCurrent = createDocumentEditGuard(document, editor);
        const isCurrent = () => documentIsCurrent() && !model.stale && provider.getModel() === model;
        if (model.recordDrafts && Object.keys(model.recordDrafts).length > 0) {
            const targetRecords = model.targetLayout?.records || [];
            for (let i = 0; i < targetRecords.length; i++) {
                const rec = targetRecords[i];
                const draft = model.recordDrafts[rec.recordMigrationId];
                if (draft !== undefined) {
                    if (model.plan?.replacementRecords?.[i]?.text !== draft) {
                        provider.markStale(model.uri);
                        return null;
                    }
                }
            }
        }
        if (model.readonly || model.plan?.status === 'blocked' || !keywordManagerCatalogAllowsWrite(model.currentKeyword)) {
            const draftLayoutUnavailable = !model.readonly && model.plan?.status === 'blocked' &&
                model.plan.reason === 'lspp-input-form-field-draft-invalid' && keywordManagerCatalogAllowsWrite(model.currentKeyword);
            vscode.window.showInformationMessage(i18n.get(draftLayoutUnavailable
                ? 'keywordManagerDraftLayoutUnavailable' : 'keywordManagerApplyUnavailable'));
            return null;
        }
        const provisional = model.provisional === true || model.plan?.provisional === true;
        if (await isDocumentReadonlyForAutomaticEdit(document)) {
            vscode.window.showInformationMessage(i18n.get('keywordOptionsDocumentReadonly'));
            return null;
        }
        if (!isCurrent() || !keywordManagerCatalogAllowsWrite(model.currentKeyword)) { provider.markStale(model.uri); return null; }
        const result = buildKeywordManagerCatalogPlan(
            document,
            model.keywordLine,
            model.targetKeyword,
            { provisional },
        );
        keywordManagerPrepareCatalogInputFormLayout(
            document,
            model.keywordLine,
            result,
            model.fieldDrafts || {},
            model.recordDrafts || {},
            model.selectedFormRuleId || null,
        );
        keywordManagerPrepareCatalogSelectorLayout(document, model.keywordLine, result, model.resolvedTargetState || {}, false, model.fieldDrafts || {});
        const unavailableMessage = () => i18n.get(
            result.plan?.reason === 'lspp-input-form-field-draft-invalid' ? 'keywordManagerDraftLayoutUnavailable'
                : ['unmodeled-source-text', 'source-record-coverage-unproven'].includes(result.plan?.reason)
                    ? 'keywordManagerRecordContentUnverified' : 'keywordOptionsTargetUnavailable');
        const session = model.session;
        const hasFieldDrafts = model.fieldDrafts && Object.keys(model.fieldDrafts).length > 0;
        const hasRecordDrafts = model.recordDrafts && Object.keys(model.recordDrafts).length > 0;
        if ((hasFieldDrafts || hasRecordDrafts) &&
            !keywordManagerStageFieldDrafts(result, model.fieldDrafts || {}, model.recordDrafts || {})) {
            provider.markStale(model.uri);
            vscode.window.showInformationMessage(unavailableMessage());
            return null;
        }
        const plan = result.plan;
        const sessionMatches = !session || (
            session.uri === documentUriIdentity(document) &&
            session.documentVersion === document.version &&
            session.keywordLine === model.keywordLine &&
            session.blockEnd === result.block?.blockEnd &&
            session.blockSha256 === keywordOptionBlockSha256(document, model.keywordLine, result.block?.blockEnd) &&
            session.grammarId === model.grammarId &&
            session.sourceLockIdentity === (plan.sourceLockIdentity || null) &&
            session.currentLayoutProfileId === (result.currentLayout?.profileId || null) &&
            session.targetLayoutProfileId === (result.targetLayout?.profileId || null)
        );
        if (plan.status === 'no-change' &&
            plan.documentVersion === document.version && sessionMatches) {
            try {
                await vscode.window.showTextDocument(document, editor.viewColumn, false);
                await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            } catch (_error) {
                // There is nothing to apply; focus restoration is best effort.
            }
            return null;
        }
        if (plan.status !== 'ready' || plan.documentVersion !== document.version || !sessionMatches) {
            provider.markStale(model.uri);
            vscode.window.showInformationMessage(unavailableMessage());
            return null;
        }
        if (plan.requiresLossConfirmation && plan.discardedFields?.length) {
            const details = plan.discardedFields.slice(0, 8)
                .map(field => `${field.name || field.fieldMigrationId}=${field.value}`).join(', ');
            const choice = await vscode.window.showWarningMessage(
                i18n.get(plan.discardedFields.length === 1 ? 'keywordOptionsTreeDiscardWarningSingle' : 'keywordOptionsTreeDiscardWarning', plan.discardedFields.length, details),
                { modal: true },
                i18n.get('keywordOptionsTreeDiscardConfirm'),
            );
            if (choice !== i18n.get('keywordOptionsTreeDiscardConfirm')) return null;
            if (!isCurrent() ||
                session?.blockSha256 !== keywordOptionBlockSha256(document, model.keywordLine, session?.blockEnd)) {
                provider.markStale(model.uri);
                return null;
            }
        }
        const replacement = optionSwitchReplacement(document, model, result);
        if (!keywordManagerReplacementMatchesTarget(document, model, result, replacement)) {
            vscode.window.showInformationMessage(i18n.get('keywordManagerReplacementMismatch'));
            return null;
        }
        // Permission changes and panel/model transitions can occur during a dialog.
        if (!isCurrent() || await isDocumentReadonlyForAutomaticEdit(document) || !isCurrent() ||
            !keywordManagerCatalogAllowsWrite(model.currentKeyword)) {
            provider.markStale(model.uri);
            return null;
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, replacement.range, replacement.text);
        try {
            if (!await vscode.workspace.applyEdit(edit)) {
                vscode.window.showInformationMessage(i18n.get('keywordOptionsTreeApplyFailed'));
                return null;
            }
        } catch (_error) {
            vscode.window.showInformationMessage(i18n.get('keywordOptionsTreeApplyFailed'));
            return null;
        }
        vscode.window.setStatusBarMessage(i18n.get('keywordOptionsTreeApplied'), 5000);
        provider.markStale(model.uri);
        try {
            await vscode.window.showTextDocument(document, editor.viewColumn, false);
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        } catch (_error) {
            // The edit is already complete; focus restoration is best effort.
        }
        return { plan, edit };
    }

    return {
        applyKeywordOptionViewModel,
    };
}
