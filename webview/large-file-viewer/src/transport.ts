import { HOST_EXTENSION } from 'vscode-messenger-common';
import { Messenger } from 'vscode-messenger-webview';
import type { VsCodeApi } from 'vscode-messenger-webview/lib/vscode-api';
import {
    LargeFileKeywordNavigateRequestType,
    LargeFileNavigateRequestType,
    LargeFileQueryFieldRequest,
    LargeFileReadyRequest,
    LargeFileReloadRequest,
    LargeFileSearchRequestType,
    LargeFileSearchStepRequestType,
    LargeFileSelectFieldRequest,
    LargeFileStateChangedNotification,
    type LargeFileViewerState,
} from '../../../src/client/largeFileViewerProtocol';

export type LargeFileViewerTransport = {
    ready(): Promise<LargeFileViewerState>;
    navigate(revision: number, line: number): Promise<boolean>;
    navigateKeyword(revision: number, direction: -1 | 1, filter: string): Promise<boolean>;
    search(revision: number, query: string): Promise<boolean>;
    searchStep(revision: number, direction: -1 | 1): Promise<boolean>;
    selectField(revision: number, token: string): Promise<boolean>;
    queryField(revision: number, token: string): Promise<boolean>;
    reload(revision: number): Promise<boolean>;
    onStateChanged(handler: (state: LargeFileViewerState) => void): () => void;
};

function acquireApi(): VsCodeApi {
    const acquire = (globalThis as typeof globalThis & { acquireVsCodeApi?: () => VsCodeApi }).acquireVsCodeApi;
    if (typeof acquire !== 'function') throw new Error('acquireVsCodeApi is unavailable');
    return acquire();
}

export function createLargeFileViewerTransport(api: VsCodeApi = acquireApi()): LargeFileViewerTransport {
    const messenger = new Messenger(api);
    messenger.start();
    const request = <P, R>(type: any, payload: P) =>
        messenger.sendRequest(type, HOST_EXTENSION, payload) as Promise<R>;
    return {
        ready: () => request(LargeFileReadyRequest, { revision: 0 }),
        navigate: (revision, line) => request(LargeFileNavigateRequestType, { revision, line }),
        navigateKeyword: (revision, direction, filter) =>
            request(LargeFileKeywordNavigateRequestType, { revision, direction, filter }),
        search: (revision, query) => request(LargeFileSearchRequestType, { revision, query }),
        searchStep: (revision, direction) =>
            request(LargeFileSearchStepRequestType, { revision, direction }),
        selectField: (revision, token) => request(LargeFileSelectFieldRequest, { revision, token }),
        queryField: (revision, token) => request(LargeFileQueryFieldRequest, { revision, token }),
        reload: revision => request(LargeFileReloadRequest, { revision }),
        onStateChanged(handler) {
            const disposable = messenger.onNotification(LargeFileStateChangedNotification, handler);
            return () => disposable.dispose();
        },
    };
}
