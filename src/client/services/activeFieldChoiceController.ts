import type {
    OfficialFieldChoicePlan,
} from '../../core/semantics/officialFieldChoicePlanner';
import type {
    OfficialFieldChoiceCommandRequest,
} from './officialFieldChoicePicker';

type StatusBarLevel = 'off' | 'simple' | 'detail';

export type ActiveFieldChoiceControllerDeps = {
    statusBarItem: any;
    getActiveEditor: () => any;
    isLsdynaDocument: (document: any) => boolean;
    documentIdentity: (document: any) => string;
    getStatusBarLevel: (document: any) => StatusBarLevel | string;
    plan: (
        document: any,
        position: { line: number; character: number },
        options: { expectedDocumentVersion: number; maximumKeywordLookback: number },
    ) => OfficialFieldChoicePlan | null | Promise<OfficialFieldChoicePlan | null>;
    translate: (key: string, ...args: any[]) => string;
    presentEvidence?: (evidence: any, plan: OfficialFieldChoicePlan) => string | null;
    setContext: (key: string, value: boolean) => Promise<unknown> | unknown;
    globalState?: {
        get?: (key: string, defaultValue?: any) => any;
        update?: (key: string, value: any) => Promise<unknown> | unknown;
    };
    showInformationMessage?: (...args: any[]) => Promise<string | undefined> | undefined;
    executeCommand?: (command: string, ...args: any[]) => Promise<unknown> | unknown;
    debounceMs?: number;
    schedule?: (callback: () => void, delayMs: number) => any;
    cancel?: (timer: any) => void;
    getLanguage?: () => string;
    isZh?: boolean | (() => boolean);
};

const CONTEXT_KEY = 'lsdyna.hasOfficialFieldChoices';
const COMMAND_ID = 'extension.pickOfficialFieldValue';
const DISCOVERY_STATE_KEY = 'officialFieldChoiceDiscovery.v1';

function normalizeLevel(value: unknown): StatusBarLevel {
    return value === 'off' || value === 'detail' || value === 'simple' ? value : 'simple';
}

function selectionPosition(editor: any): { line: number; character: number } | null {
    if (Array.isArray(editor?.selections) && editor.selections.length !== 1) return null;
    const selection = editor?.selection;
    if (!selection) return null;
    if (selection.isEmpty === false) {
        if (!selection.start || !selection.end || selection.start.line !== selection.end.line) return null;
        if (!Number.isInteger(selection.start.line) || !Number.isInteger(selection.start.character)) return null;
        return { line: selection.start.line, character: selection.start.character };
    }
    const position = selection.active || selection.start;
    if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)) return null;
    return { line: position.line, character: position.character };
}

export function officialFieldChoiceCommandRequest(
    document: any,
    position: { line: number; character: number },
    documentIdentity: (document: any) => string,
): OfficialFieldChoiceCommandRequest | null {
    const uri = documentIdentity(document);
    if (!uri || !Number.isInteger(document?.version) || document.version < 0 ||
        !Number.isInteger(position?.line) || position.line < 0 ||
        !Number.isInteger(position?.character) || position.character < 0) {
        return null;
    }
    return {
        uri,
        line: position.line,
        character: position.character,
        documentVersion: document.version,
    };
}

/** Lightweight active-cell status; it never builds an index or opens the picker itself. */
export function createActiveFieldChoiceController(deps: ActiveFieldChoiceControllerDeps) {
    if (!deps.statusBarItem) throw new TypeError('statusBarItem is required');
    const debounceMs = Number.isFinite(deps.debounceMs)
        ? Math.max(0, Math.floor(Number(deps.debounceMs)))
        : 100;
    const schedule = deps.schedule || setTimeout;
    const cancel = deps.cancel || clearTimeout;
    let timer: any = null;
    let generation = 0;
    let disposed = false;
    let contextValue: boolean | null = null;
    let activePlan: OfficialFieldChoicePlan | null = null;
    let discoveryConsumed = Boolean(deps.globalState?.get?.(DISCOVERY_STATE_KEY, false));
    let discoveryPending = false;

    function updateContext(value: boolean) {
        if (contextValue === value) return;
        contextValue = value;
        try {
            void Promise.resolve(deps.setContext(CONTEXT_KEY, value)).catch(() => undefined);
        } catch (_error) {
            // Context keys are discoverability only; never block editing.
        }
    }

    function hide() {
        activePlan = null;
        try { deps.statusBarItem.hide(); } catch (_error) { /* best effort */ }
        updateContext(false);
    }

    function summaryLabel(plan: OfficialFieldChoicePlan): string {
        return plan.domainKind === 'closed'
            ? deps.translate('officialFieldChoiceStatusClosedLabel', plan.fieldName, plan.choices.length)
            : deps.translate('officialFieldChoiceStatusMixedLabel', plan.fieldName, plan.choices.length);
    }

    function statusText(plan: OfficialFieldChoicePlan): string {
        return plan.domainKind === 'closed'
            ? `$(list-selection) ${summaryLabel(plan)}`
            : `$(info) ${summaryLabel(plan)}`;
    }

    function resolveIsZh(): boolean {
        if (typeof deps.getLanguage === 'function') {
            return deps.getLanguage().toLowerCase().startsWith('zh');
        }
        if (typeof deps.isZh === 'function') {
            return Boolean(deps.isZh());
        }
        if (typeof deps.isZh === 'boolean') {
            return deps.isZh;
        }
        return false;
    }

    function tooltip(plan: OfficialFieldChoicePlan, level: StatusBarLevel): string {
        const base = plan.domainKind === 'closed'
            ? deps.translate('officialFieldChoiceStatusClosedTooltip', plan.fieldName, plan.choices.length)
            : deps.translate('officialFieldChoiceStatusMixedTooltip', plan.fieldName, plan.choices.length);
        if (level !== 'detail') return base;
        const isZh = resolveIsZh();
        let summaryText = plan.summary;
        if (isZh) {
            if (plan.localizedSummary) {
                summaryText = `${plan.localizedSummary}\n\n${deps.translate('fieldHelpEnglishOriginal')}: ${plan.summary}`;
            } else if (plan.summary) {
                summaryText = `${plan.summary} （${deps.translate('fieldHelpUntranslatedInline')}）`;
            }
        }
        const evidence = (plan.evidence || [])
            .filter(item => item.manualId && Number.isInteger(item.page))
            .map(item => deps.presentEvidence
                ? deps.presentEvidence(item, plan)
                : `${item.manualId} P${item.page}`)
            .filter((item): item is string => Boolean(item));
        return [base, summaryText, ...new Set(evidence)].filter(Boolean).join('\n');
    }

    function consumeDiscovery() {
        if (discoveryConsumed) return;
        discoveryConsumed = true;
        try {
            void Promise.resolve(deps.globalState?.update?.(DISCOVERY_STATE_KEY, true)).catch(() => undefined);
        } catch (_error) {
            // Session state still prevents repeated prompts if persistence is unavailable.
        }
    }

    function maybeShowDiscovery(
        plan: OfficialFieldChoicePlan,
        request: OfficialFieldChoiceCommandRequest,
    ) {
        if (discoveryConsumed || discoveryPending || !deps.showInformationMessage) return;
        discoveryPending = true;
        consumeDiscovery();
        const view = deps.translate('officialFieldChoiceDiscoveryView');
        const dismiss = deps.translate('officialFieldChoiceDiscoveryDismiss');
        const message = plan.domainKind === 'closed'
            ? deps.translate(
                'officialFieldChoiceDiscoveryClosed',
                plan.fieldName,
                plan.choices.length,
                summaryLabel(plan),
            )
            : deps.translate(
                'officialFieldChoiceDiscoveryMixed',
                plan.fieldName,
                plan.choices.length,
                summaryLabel(plan),
            );
        let shown;
        try {
            shown = deps.showInformationMessage(message, view, dismiss);
        } catch (_error) {
            discoveryPending = false;
            return;
        }
        void Promise.resolve(shown).then(choice => {
            discoveryPending = false;
            if (choice === view && deps.executeCommand) {
                return deps.executeCommand(COMMAND_ID, request);
            }
            return undefined;
        }, () => {
            discoveryPending = false;
        });
    }

    function refreshGeneration(expectedGeneration: number): OfficialFieldChoicePlan | null {
        if (disposed || expectedGeneration !== generation) return null;
        const editor = deps.getActiveEditor();
        const document = editor?.document;
        if (!document || !deps.isLsdynaDocument(document)) {
            hide();
            return null;
        }
        const level = normalizeLevel(deps.getStatusBarLevel(document));
        const statusVisible = level !== 'off';
        const position = selectionPosition(editor);
        if (!position || position.line < 0 || position.line >= document.lineCount ||
            position.character < 0 ||
            position.character > String(document.lineAt(position.line).text || '').length) {
            hide();
            return null;
        }

        const version = document.version;
        const accept = (plan: OfficialFieldChoicePlan | null) => {
            if (disposed || expectedGeneration !== generation) return null;
            const currentPosition = selectionPosition(editor);
            if (deps.getActiveEditor() !== editor || editor.document !== document || document.isClosed ||
                document.version !== version || currentPosition?.line !== position.line || currentPosition?.character !== position.character ||
                plan?.status !== 'ready' || plan.documentVersion !== document.version ||
                !plan.fieldRange || plan.fieldRange.line !== position.line || plan.choices.length === 0) {
                hide();
                return null;
            }
            const request = officialFieldChoiceCommandRequest(document, position, deps.documentIdentity);
            if (!request) {
                hide();
                return null;
            }

            activePlan = plan;
            updateContext(true);
            if (statusVisible) {
                deps.statusBarItem.text = statusText(plan);
                deps.statusBarItem.tooltip = tooltip(plan, level);
                deps.statusBarItem.command = {
                    command: COMMAND_ID,
                    title: deps.translate('officialFieldChoiceStatusCommandTitle'),
                    arguments: [request],
                };
                try { deps.statusBarItem.show(); } catch (_error) { /* best effort */ }
                maybeShowDiscovery(plan, request);
            } else {
                try { deps.statusBarItem.hide(); } catch (_error) { /* best effort */ }
            }
            return plan;
        };
        try {
            const plan = deps.plan(document, position, { expectedDocumentVersion: version, maximumKeywordLookback: 0 });
            if (plan && typeof (plan as Promise<any>).then === 'function') {
                void Promise.resolve(plan).then(accept, () => accept(null));
                return null;
            }
            return accept(plan as OfficialFieldChoicePlan | null);
        } catch (_) { return accept(null); }

    }

    function refreshNow(): OfficialFieldChoicePlan | null {
        if (timer) {
            cancel(timer);
            timer = null;
        }
        generation++;
        hide();
        return refreshGeneration(generation);
    }

    function scheduleRefresh() {
        if (disposed) return;
        generation++;
        const expectedGeneration = generation;
        if (timer) cancel(timer);
        hide();
        timer = schedule(() => {
            timer = null;
            refreshGeneration(expectedGeneration);
        }, debounceMs);
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        generation++;
        if (timer) {
            cancel(timer);
            timer = null;
        }
        hide();
        try { deps.statusBarItem.dispose?.(); } catch (_error) { /* best effort */ }
    }

    return {
        refreshNow,
        scheduleRefresh,
        dispose,
        getActivePlan: () => activePlan,
    };
}

export const ACTIVE_FIELD_CHOICE_CONTEXT_KEY = CONTEXT_KEY;
export const ACTIVE_FIELD_CHOICE_DISCOVERY_STATE_KEY = DISCOVERY_STATE_KEY;
