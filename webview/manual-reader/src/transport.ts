import { HOST_EXTENSION } from 'vscode-messenger-common';
import { Messenger } from 'vscode-messenger-webview';
import type { VsCodeApi } from 'vscode-messenger-webview/lib/vscode-api';
import {
    ReaderNavigateRequestType,
    ReaderOpenLinkRequestType,
    ReaderOpenPdfRequest,
    ReaderReadyRequest,
    ReaderScrollChangedNotification,
    ReaderSearchRequestType,
    ReaderStateChangedNotification,
    ReaderToggleLanguageRequest,
    type ReaderViewModel,
} from '../../../src/manual/readerProtocol';
import type { ReaderTransport } from './ReaderApp';

const requests = {
    'reader/ready': ReaderReadyRequest,
    'reader/navigate': ReaderNavigateRequestType,
    'reader/toggleLanguage': ReaderToggleLanguageRequest,
    'reader/search': ReaderSearchRequestType,
    'reader/openLink': ReaderOpenLinkRequestType,
    'reader/openPdf': ReaderOpenPdfRequest,
} as const;

/**
 * VS Code injects `acquireVsCodeApi` on the webview global. Do not import it from
 * `vscode-messenger-webview`: that package only declares the symbol, so the compiled
 * module exports nothing and Vite would call `undefined()`.
 */
export function acquireWebviewVsCodeApi(): VsCodeApi {
    const acquire = (globalThis as typeof globalThis & {
        acquireVsCodeApi?: () => VsCodeApi;
    }).acquireVsCodeApi;
    if (typeof acquire !== 'function') {
        throw new Error('acquireVsCodeApi is unavailable in this webview');
    }
    return acquire();
}

export function createReaderTransport(vscodeApi: VsCodeApi = acquireWebviewVsCodeApi()): ReaderTransport {
    // Pass the API explicitly; a no-arg Messenger constructor hits the empty package export.
    const messenger = new Messenger(vscodeApi);
    messenger.start();
    return {
        request(name, payload) {
            const request = requests[name as keyof typeof requests];
            if (!request) return Promise.reject(new Error(`Unknown reader request: ${name}`));
            return messenger.sendRequest(request as any, HOST_EXTENSION, payload as any);
        },
        notify(name, payload) {
            if (name !== 'reader/scrollChanged') throw new Error(`Unknown reader notification: ${name}`);
            messenger.sendNotification(ReaderScrollChangedNotification, HOST_EXTENSION, payload as any);
        },
        onStateChanged(handler: (state: ReaderViewModel) => void) {
            const disposable = messenger.onNotification(ReaderStateChangedNotification, handler);
            return () => disposable.dispose();
        },
    };
}
