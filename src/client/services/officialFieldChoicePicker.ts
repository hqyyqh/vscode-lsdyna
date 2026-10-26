import type {
    OfficialFieldChoice,
    OfficialFieldChoicePlan,
} from '../../core/semantics/officialFieldChoicePlanner';
import { createDocumentEditGuard, isDocumentReadonlyForAutomaticEdit } from './documentEditGuard';

export type OfficialFieldChoiceCommandRequest = {
    uri: string;
    line: number;
    character: number;
    documentVersion: number;
};

export type OfficialFieldChoicePickerDeps = {
    vscode: any;
    getActiveEditor: () => any;
    isLsdynaDocument: (document: any) => boolean;
    documentIdentity: (document: any) => string;
    plan: (
        document: any,
        position: { line: number; character: number },
        options: { expectedDocumentVersion: number; maximumKeywordLookback: number },
    ) => OfficialFieldChoicePlan | null | Promise<OfficialFieldChoicePlan | null>;
    translate: (key: string, ...args: any[]) => string;
    presentEvidence?: (
        evidence: { evidenceId: string; manualId: string; page: number; sourceProfileId?: string },
        plan: OfficialFieldChoicePlan,
    ) => { label: string; tooltip?: string } | null;
    showStatus?: (key: string, ...args: any[]) => void;
    applyEdit?: (edit: any) => Promise<boolean>;
    openEvidence?: (request: {
        keyword: string;
        ruleId: string;
        evidenceId: string;
    }) => Promise<unknown> | unknown;
    pickChoice?: (
        plan: OfficialFieldChoicePlan,
        items: OfficialFieldChoiceQuickPickItem[],
    ) => Promise<string | null | undefined>;
    getLanguage?: () => string;
    isZh?: boolean | (() => boolean);
};

export type OfficialFieldChoiceQuickPickItem = {
    label: string;
    description: string;
    detail: string;
    alwaysShow: boolean;
    choiceId: string;
    buttons?: any[];
};

const REQUEST_KEYS = new Set(['uri', 'line', 'character', 'documentVersion']);

function isExactIdentityRequest(value: any): value is OfficialFieldChoiceCommandRequest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === REQUEST_KEYS.size && keys.every(key => REQUEST_KEYS.has(key)) &&
        typeof value.uri === 'string' && value.uri.length > 0 &&
        Number.isInteger(value.line) && value.line >= 0 &&
        Number.isInteger(value.character) && value.character >= 0 &&
        Number.isInteger(value.documentVersion) && value.documentVersion >= 0;
}

function uniqueEvidence(plan: OfficialFieldChoicePlan): Array<{
    evidenceId: string;
    manualId: string;
    page: number;
    sourceProfileId?: string;
}> {
    const seen = new Set<string>();
    const result = [];
    for (const evidence of plan.evidence || []) {
        if (!evidence.evidenceId || !evidence.manualId || !Number.isInteger(evidence.page)) continue;
        const key = `${evidence.sourceProfileId || ''}\u0000${evidence.manualId}\u0000${evidence.page}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({
            evidenceId: evidence.evidenceId,
            manualId: evidence.manualId,
            page: Number(evidence.page),
            ...(evidence.sourceProfileId ? { sourceProfileId: evidence.sourceProfileId } : {}),
        });
    }
    return result;
}

export function buildOfficialFieldChoiceQuickPickItems(
    plan: OfficialFieldChoicePlan,
    deps: Pick<OfficialFieldChoicePickerDeps, 'vscode' | 'translate' | 'presentEvidence' | 'isZh' | 'getLanguage'>,
): OfficialFieldChoiceQuickPickItem[] {
    const evidence = uniqueEvidence(plan).map(item => ({
        item,
        presentation: deps.presentEvidence?.(item, plan) || (
            deps.presentEvidence ? null : { label: `${item.manualId} P${item.page}` }
        ),
    })).filter(entry => entry.presentation !== null);
    const evidenceDetail = evidence.map(entry => entry.presentation?.label || '').filter(Boolean).join(' · ');

    const isZh = (typeof deps.getLanguage === 'function')
        ? deps.getLanguage().toLowerCase().startsWith('zh')
        : (typeof deps.isZh === 'function'
            ? Boolean(deps.isZh())
            : (deps.isZh !== undefined ? Boolean(deps.isZh) : false));
    let summaryText = plan.summary;
    if (isZh) {
        if (plan.localizedSummary) {
            summaryText = plan.localizedSummary;
        } else if (plan.summary) {
            summaryText = `${plan.summary} （${deps.translate('fieldHelpUntranslatedInline')}）`;
        }
    }

    return (plan.choices || []).map(choice => {
        const current = choice.valueText === plan.currentRawValue;
        const buttons: any[] = evidence.map(({ item, presentation }) => ({
            iconPath: deps.vscode?.ThemeIcon ? new deps.vscode.ThemeIcon('book') : undefined,
            tooltip: presentation?.tooltip ||
                deps.translate('officialFieldChoiceOpenEvidence', item.manualId, item.page),
            evidence: item,
        }));
        return {
            label: choice.valueText,
            description: [
                deps.translate(`officialChoiceRole${choice.role === 'sentinel'
                    ? 'Sentinel'
                    : choice.role === 'reference'
                        ? 'Reference'
                        : choice.role === 'literal'
                            ? 'Literal'
                            : 'Enum'}`),
                current ? deps.translate('officialFieldChoiceCurrentValue') : '',
            ].filter(Boolean).join(' · '),
            detail: [summaryText, evidenceDetail].filter(Boolean).join(' · '),
            alwaysShow: true,
            choiceId: choice.id,
            ...(buttons.length > 0 ? { buttons } : {}),
        };
    });
}

async function showNativeOfficialFieldChoiceQuickPick(
    plan: OfficialFieldChoicePlan,
    items: OfficialFieldChoiceQuickPickItem[],
    deps: OfficialFieldChoicePickerDeps,
): Promise<string | null> {
    const window = deps.vscode?.window;
    if (!window) return null;
    if (typeof window.createQuickPick !== 'function') {
        if (typeof window.showQuickPick !== 'function') return null;
        const picked = await window.showQuickPick(items, {
            title: plan.domainKind === 'closed'
                ? deps.translate('officialFieldChoiceClosedTitle', plan.fieldName)
                : deps.translate('officialFieldChoiceMixedTitle', plan.fieldName),
            placeHolder: plan.domainKind === 'closed'
                ? deps.translate('officialFieldChoiceClosedPlaceholder')
                : deps.translate('officialFieldChoiceMixedPlaceholder'),
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: false,
        });
        return picked?.choiceId || null;
    }

    const quickPick = window.createQuickPick();
    return new Promise((resolve, reject) => {
        let settled = false;
        const disposables: any[] = [];
        const dispose = () => {
            while (disposables.length > 0) {
                try { disposables.pop()?.dispose?.(); } catch (_error) { /* best effort */ }
            }
            try { quickPick.dispose(); } catch (_error) { /* best effort */ }
        };
        const settle = (choiceId: string | null, hide = true) => {
            if (settled) return;
            settled = true;
            if (hide) {
                try { quickPick.hide(); } catch (_error) { /* best effort */ }
            }
            dispose();
            resolve(choiceId);
        };
        try {
            quickPick.title = plan.domainKind === 'closed'
                ? deps.translate('officialFieldChoiceClosedTitle', plan.fieldName)
                : deps.translate('officialFieldChoiceMixedTitle', plan.fieldName);
            quickPick.placeholder = plan.domainKind === 'closed'
                ? deps.translate('officialFieldChoiceClosedPlaceholder')
                : deps.translate('officialFieldChoiceMixedPlaceholder');
            quickPick.items = items;
            quickPick.matchOnDescription = true;
            quickPick.matchOnDetail = true;
            quickPick.ignoreFocusOut = false;
            quickPick.canSelectMany = false;
            const currentItem = items.find(item =>
                plan.choices.find(choice => choice.id === item.choiceId)?.valueText === plan.currentRawValue
            );
            if (currentItem) quickPick.activeItems = [currentItem];
            disposables.push(
                quickPick.onDidAccept(() => {
                    const item = quickPick.selectedItems?.[0] || quickPick.activeItems?.[0];
                    settle(item?.choiceId || null);
                }),
            );
            disposables.push(quickPick.onDidHide(() => settle(null, false)));
            if (typeof quickPick.onDidTriggerItemButton === 'function') {
                disposables.push(quickPick.onDidTriggerItemButton(async (event: any) => {
                    try {
                        const evidence = event?.button?.evidence;
                        if (!evidence?.evidenceId || !deps.openEvidence) return;
                        await deps.openEvidence({
                            keyword: plan.catalogKeyword,
                            ruleId: plan.ruleId,
                            evidenceId: evidence.evidenceId,
                        });
                    } catch (_error) {
                        // Help requests do not change the selected value or apply an edit.
                    }
                }));
            }
            quickPick.show();
        } catch (error) {
            dispose();
            reject(error);
        }
    });
}

function sameWritableField(
    before: OfficialFieldChoicePlan,
    after: OfficialFieldChoicePlan,
): boolean {
    const left = before.fieldRange;
    const right = after.fieldRange;
    return before.status === 'ready' && after.status === 'ready' &&
        before.documentVersion === after.documentVersion &&
        before.ruleId === after.ruleId &&
        before.catalogKeyword === after.catalogKeyword &&
        before.keywordLine === after.keywordLine &&
        before.physicalCardIndex === after.physicalCardIndex &&
        before.fieldIndex === after.fieldIndex &&
        before.fieldName === after.fieldName &&
        before.fieldWidth === after.fieldWidth &&
        Boolean(left) && Boolean(right) &&
        left?.line === right?.line &&
        left?.startCharacter === right?.startCharacter &&
        left?.endCharacter === right?.endCharacter;
}

function editorPosition(editor: any): { line: number; character: number } | null {
    if (Array.isArray(editor?.selections) && editor.selections.length > 1) return null;
    const selection = editor?.selection;
    const position = selection && selection.isEmpty === false
        ? selection.start
        : selection?.active || selection?.start;
    if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)) return null;
    return { line: position.line, character: position.character };
}

/** Creates the identity-only, re-plan-before-and-after official choice command. */
export function createOfficialFieldChoicePicker(deps: OfficialFieldChoicePickerDeps) {
    const status = (key: string, ...args: any[]) => {
        try { deps.showStatus?.(key, ...args); } catch (_error) { /* best effort */ }
    };

    async function pick(request?: OfficialFieldChoiceCommandRequest | null) {
        const editor = deps.getActiveEditor();
        const document = editor?.document;
        const invokingPosition = editorPosition(editor);
        const positionUnchanged = () => {
            const current = editorPosition(editor);
            return current?.line === invokingPosition?.line && current?.character === invokingPosition?.character;
        };
        const isCurrent = createDocumentEditGuard(document, editor);
        if (!isCurrent() || !deps.isLsdynaDocument(document)) {
            status('officialFieldChoiceSourceInactive');
            return null;
        }

        let position: { line: number; character: number } | null;
        let expectedVersion: number;
        if (request !== undefined && request !== null) {
            if (!isExactIdentityRequest(request) ||
                request.uri !== deps.documentIdentity(document) ||
                request.documentVersion !== document.version) {
                status('officialFieldChoiceSourceInactive');
                return null;
            }
            position = { line: request.line, character: request.character };
            expectedVersion = request.documentVersion;
        } else {
            position = editorPosition(editor);
            expectedVersion = document.version;
        }
        if (!position || position.line < 0 || position.line >= document.lineCount ||
            position.character < 0 || position.character > String(document.lineAt(position.line).text || '').length) {
            status('officialFieldChoiceUnavailable');
            return null;
        }

        const initialPlan = await deps.plan(document, position, {
            expectedDocumentVersion: expectedVersion,
            maximumKeywordLookback: 256,
        });
        if (!isCurrent() || deps.getActiveEditor() !== editor || !positionUnchanged()) {
            status(positionUnchanged() ? 'officialFieldChoiceSourceInactive' : 'officialFieldChoiceUnavailable');
            return null;
        }
        if (!initialPlan || initialPlan.status !== 'ready' ||
            initialPlan.documentVersion !== expectedVersion || !initialPlan.fieldRange ||
            initialPlan.choices.length === 0) {
            status('officialFieldChoiceUnavailable');
            return null;
        }

        const items = buildOfficialFieldChoiceQuickPickItems(initialPlan, deps);
        const selectedChoiceId = deps.pickChoice
            ? await deps.pickChoice(initialPlan, items)
            : await showNativeOfficialFieldChoiceQuickPick(initialPlan, items, deps);
        if (!selectedChoiceId) return null;

        const currentEditor = deps.getActiveEditor();
        const currentDocument = currentEditor?.document;
        if (!currentEditor || currentEditor !== editor || !currentDocument ||
            currentDocument !== document || !isCurrent() || !positionUnchanged() ||
            !deps.isLsdynaDocument(currentDocument) ||
            deps.documentIdentity(currentDocument) !== deps.documentIdentity(document) ||
            currentDocument.version !== expectedVersion) {
            status(positionUnchanged() ? 'officialFieldChoiceSourceInactive' : 'officialFieldChoiceUnavailable');
            return null;
        }

        const readonly = await isDocumentReadonlyForAutomaticEdit(document, deps.vscode);
        if (!isCurrent() || deps.getActiveEditor() !== editor || !positionUnchanged()) {
            status(positionUnchanged() ? 'officialFieldChoiceSourceInactive' : 'officialFieldChoiceUnavailable');
            return null;
        }
        if (readonly) {
            status('editReadonly');
            return null;
        }

        const finalPlan = await deps.plan(currentDocument, position, {
            expectedDocumentVersion: expectedVersion,
            maximumKeywordLookback: 256,
        });
        if (!isCurrent() || deps.getActiveEditor() !== editor || !positionUnchanged()) {
            status(positionUnchanged() ? 'officialFieldChoiceSourceInactive' : 'officialFieldChoiceUnavailable');
            return null;
        }
        if (!finalPlan || !sameWritableField(initialPlan, finalPlan)) {
            status('officialFieldChoiceUnavailable');
            return null;
        }
        const choice: OfficialFieldChoice | undefined = finalPlan.choices.find(item =>
            item.id === selectedChoiceId
        );
        const range = finalPlan.fieldRange;
        if (!choice || !range || choice.replacementText.length !== finalPlan.fieldWidth ||
            range.line < 0 || range.line >= currentDocument.lineCount ||
            range.startCharacter < 0 || range.endCharacter < range.startCharacter) {
            status('officialFieldChoiceUnavailable');
            return null;
        }
        const lineText = String(currentDocument.lineAt(range.line).text || '');
        if (range.endCharacter > lineText.length) {
            status('officialFieldChoiceUnavailable');
            return null;
        }
        if (lineText.slice(range.startCharacter, range.endCharacter) === choice.replacementText) {
            return { plan: finalPlan, choice, edit: null, unchanged: true };
        }

        if (!isCurrent() || deps.getActiveEditor() !== editor) {
            status('officialFieldChoiceSourceInactive');
            return null;
        }
        const edit = new deps.vscode.WorkspaceEdit();
        const vscodeRange = new deps.vscode.Range(
            range.line,
            range.startCharacter,
            range.line,
            range.endCharacter,
        );
        edit.replace(currentDocument.uri, vscodeRange, choice.replacementText);
        try {
            const applyEdit = deps.applyEdit || ((workspaceEdit: any) =>
                deps.vscode.workspace.applyEdit(workspaceEdit));
            const applied = await applyEdit(edit);
            if (!applied) {
                status('officialFieldChoiceApplyFailed');
                return null;
            }
        } catch (_error) {
            status('officialFieldChoiceApplyFailed');
            return null;
        }

        status('officialFieldChoiceApplied', finalPlan.fieldName, choice.valueText);
        return { plan: finalPlan, choice, edit, unchanged: false };
    }

    return { pick };
}
