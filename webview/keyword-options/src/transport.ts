import { HOST_EXTENSION } from 'vscode-messenger-common';
import { Messenger } from 'vscode-messenger-webview';
import type { VsCodeApi } from 'vscode-messenger-webview/lib/vscode-api';
import {
    KeywordOptionsApplyRequest,
    KeywordOptionsReadyRequest,
    KeywordOptionsResetRequest,
    KeywordOptionsSelectDimensionRequest,
    KeywordOptionsSelectPostCountRequest,
    KeywordOptionsSelectTargetRequest,
    KeywordManagerSelectFieldRequest,
    KeywordManagerSelectFormRequest,
    KeywordManagerUpdateControlRequest,
    KeywordManagerSelectScopeRequest,
    KeywordManagerLocateSourceRequest,
    KeywordManagerOpenManualRequest,
    KeywordManagerSelectInstanceRequest,
    KeywordManagerUpdateFieldRequest,
    KeywordOptionsStateChangedNotification,
    KeywordOptionsTogglePinRequest,
    type KeywordOptionsMutationResult,
    type KeywordOptionsViewState,
    type KeywordManagerHelpRequest,
    type KeywordManagerHelpResult,
} from '../../../src/client/keywordOptionsProtocol';

export type KeywordOptionsTransport = {
    ready(): Promise<KeywordOptionsViewState>;
    selectDimension(revision: number, dimensionId: string, values: string[]): Promise<KeywordOptionsMutationResult>;
    selectTarget(revision: number, targetKeyword: string): Promise<KeywordOptionsMutationResult>;
    selectPostCount(revision: number, targetPostCount: number): Promise<KeywordOptionsMutationResult>;
    updateControl(revision: number, controlId: string, value: string | boolean): Promise<KeywordOptionsMutationResult>;
    selectForm(revision: number, ruleId: string): Promise<KeywordOptionsMutationResult>;
    selectInstance(revision: number, instanceId: string): Promise<KeywordOptionsMutationResult>;
    selectField(payload: KeywordManagerHelpRequest): Promise<KeywordManagerHelpResult>;
    updateField(revision: number, fieldId: string, value: string): Promise<KeywordOptionsMutationResult>;
    selectScope(revision: number, scope: 'file' | 'project'): Promise<KeywordOptionsMutationResult>;
    locateSource(revision: number): Promise<boolean>;
    openManual(revision: number, conditionId?: string, evidenceId?: string): Promise<boolean>;
    apply(revision: number): Promise<KeywordOptionsMutationResult>;
    reset(revision: number): Promise<KeywordOptionsMutationResult>;
    togglePin(revision: number): Promise<KeywordOptionsMutationResult>;
    onStateChanged(handler: (state: KeywordOptionsViewState) => void): () => void;
};

function acquireApi(): VsCodeApi {
    const acquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi;
    if (typeof acquire !== 'function') throw new Error('acquireVsCodeApi is unavailable');
    return acquire();
}

export function createKeywordOptionsTransport(api: VsCodeApi = acquireApi()): KeywordOptionsTransport {
    const messenger = new Messenger(api);
    messenger.start();
    const request = <P, R>(type: any, payload: P) => messenger.sendRequest(type, HOST_EXTENSION, payload) as Promise<R>;
    let latestRevision = 0;
    let mutationQueue: Promise<void> = Promise.resolve();
    const remember = (state: KeywordOptionsViewState) => {
        latestRevision = Math.max(latestRevision, state.revision);
        return state;
    };
    const mutate = <P extends { revision: number }>(type: any, payload: P): Promise<KeywordOptionsMutationResult> => {
        const run = async () => {
            const result = await request<P, KeywordOptionsMutationResult>(type, {
                ...payload,
                // Applying must use the exact preview the user reviewed.
                revision: type.method === KeywordOptionsApplyRequest.method ? payload.revision : latestRevision || payload.revision,
            });
            remember(result.state);
            return result;
        };
        const result = mutationQueue.then(run, run);
        mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    };
    return {
        ready: async () => remember(await request(KeywordOptionsReadyRequest, { revision: 0 })),
        selectDimension: (revision, dimensionId, values) =>
            mutate(KeywordOptionsSelectDimensionRequest, { revision, dimensionId, values }),
        selectTarget: (revision, targetKeyword) =>
            mutate(KeywordOptionsSelectTargetRequest, { revision, targetKeyword }),
        selectPostCount: (revision, targetPostCount) =>
            mutate(KeywordOptionsSelectPostCountRequest, { revision, targetPostCount }),
        updateControl: (revision, controlId, value) =>
            mutate(KeywordManagerUpdateControlRequest, { revision, controlId, value }),
        selectForm: (revision, ruleId) =>
            mutate(KeywordManagerSelectFormRequest, { revision, ruleId }),
        selectInstance: (revision, instanceId) =>
            mutate(KeywordManagerSelectInstanceRequest, { revision, instanceId }),
        selectField: payload => request(KeywordManagerSelectFieldRequest, payload),
        updateField: (revision, fieldId, value) =>
            mutate(KeywordManagerUpdateFieldRequest, { revision, fieldId, value }),
        selectScope: (revision, scope) => mutate(KeywordManagerSelectScopeRequest, { revision, scope }),
        locateSource: revision => request(KeywordManagerLocateSourceRequest, { revision }),
        openManual: (revision, conditionId, evidenceId) => request(KeywordManagerOpenManualRequest,
            conditionId === undefined && evidenceId === undefined ? { revision } : { revision, conditionId, evidenceId }),
        apply: revision => mutate(KeywordOptionsApplyRequest, { revision }),
        reset: revision => mutate(KeywordOptionsResetRequest, { revision }),
        togglePin: revision => mutate(KeywordOptionsTogglePinRequest, { revision }),
        onStateChanged(handler) {
            const disposable = messenger.onNotification(KeywordOptionsStateChangedNotification, state => {
                remember(state);
                handler(state);
            });
            return () => disposable.dispose();
        },
    };
}
