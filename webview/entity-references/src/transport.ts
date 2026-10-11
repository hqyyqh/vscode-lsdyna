import { HOST_EXTENSION } from 'vscode-messenger-common';
import { Messenger } from 'vscode-messenger-webview';
import type { VsCodeApi } from 'vscode-messenger-webview/lib/vscode-api';
import {
    EntityReferencesClearRequest,
    EntityReferencesFocusNotification,
    EntityReferencesInferRequest,
    EntityReferencesSearchRequest,
    EntityReferencesScopeRequest,
    EntityReferencesToggleFollowRequest,
    EntityReferencesLoadMoreRequestType,
    EntityReferencesOpenRequestType,
    EntityReferencesOpenLargeFileRequestType,
    EntityReferencesQueryRequestType,
    EntityReferencesReadyRequest,
    EntityReferencesRefreshRequest,
    EntityReferencesRemoveSessionRequest,
    EntityReferencesSelectSessionRequest,
    EntityReferencesStateChangedNotification,
    EntityReferencesTogglePinRequest,
    type EntityReferenceScopePreference,
    type EntityReferencesViewState,
} from '../../../src/client/entityReferencesProtocol';

export type EntityReferencesTransport = {
    ready(): Promise<EntityReferencesViewState>;
    query(revision: number, targetKind: string, id: string,
        scopePreference: EntityReferenceScopePreference): Promise<boolean>;
    infer(revision: number): Promise<boolean>;
    search(revision: number): Promise<boolean>;
    setScope(revision: number, scopePreference: 'file' | 'project'): Promise<boolean>;
    toggleFollow(revision: number): Promise<boolean>;
    refresh(revision: number): Promise<boolean>;
    loadMore(revision: number, role: 'definition' | 'reference'): Promise<boolean>;
    togglePin(revision: number, sessionKey: string): Promise<boolean>;
    selectSession(revision: number, sessionKey: string): Promise<boolean>;
    removeSession(revision: number, sessionKey: string): Promise<boolean>;
    clear(revision: number): Promise<boolean>;
    open(revision: number, locationId: string, side: boolean): Promise<boolean>;
    openLargeFile(revision: number, token: string): Promise<boolean>;
    onStateChanged(handler: (state: EntityReferencesViewState) => void): () => void;
    onFocus(handler: () => void): () => void;
};

function acquireApi(): VsCodeApi {
    const acquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi;
    if (typeof acquire !== 'function') throw new Error('acquireVsCodeApi is unavailable');
    return acquire();
}

export function createEntityReferencesTransport(api: VsCodeApi = acquireApi()): EntityReferencesTransport {
    const messenger = new Messenger(api);
    messenger.start();
    const request = <P, R>(type: any, payload: P) =>
        messenger.sendRequest(type, HOST_EXTENSION, payload) as Promise<R>;
    return {
        ready: () => request(EntityReferencesReadyRequest, { revision: 0 }),
        query: (revision, targetKind, id, scopePreference) =>
            request(EntityReferencesQueryRequestType, { revision, targetKind, id, scopePreference }),
        infer: revision => request(EntityReferencesInferRequest, { revision }),
        search: revision => request(EntityReferencesSearchRequest, { revision }),
        setScope: (revision, scopePreference) => request(EntityReferencesScopeRequest, { revision, scopePreference }),
        toggleFollow: revision => request(EntityReferencesToggleFollowRequest, { revision }),
        refresh: revision => request(EntityReferencesRefreshRequest, { revision }),
        loadMore: (revision, role) => request(EntityReferencesLoadMoreRequestType, { revision, role }),
        togglePin: (revision, sessionKey) =>
            request(EntityReferencesTogglePinRequest, { revision, sessionKey }),
        selectSession: (revision, sessionKey) =>
            request(EntityReferencesSelectSessionRequest, { revision, sessionKey }),
        removeSession: (revision, sessionKey) =>
            request(EntityReferencesRemoveSessionRequest, { revision, sessionKey }),
        clear: revision => request(EntityReferencesClearRequest, { revision }),
        open: (revision, locationId, side) =>
            request(EntityReferencesOpenRequestType, { revision, locationId, side }),
        openLargeFile: (revision, token) =>
            request(EntityReferencesOpenLargeFileRequestType, { revision, token }),
        onStateChanged(handler) {
            const disposable = messenger.onNotification(EntityReferencesStateChangedNotification, handler);
            return () => disposable.dispose();
        },
        onFocus(handler) {
            const disposable = messenger.onNotification(EntityReferencesFocusNotification, handler);
            return () => disposable.dispose();
        },
    };
}
