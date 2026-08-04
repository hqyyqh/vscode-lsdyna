import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireWebviewVsCodeApi, createReaderTransport } from '../src/transport';

describe('createReaderTransport', () => {
    const originalAcquire = (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;

    afterEach(() => {
        if (originalAcquire === undefined) {
            delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
        } else {
            (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = originalAcquire;
        }
        vi.restoreAllMocks();
    });

    it('uses the injected webview API instead of the empty messenger package export', () => {
        const postMessage = vi.fn();
        const api = {
            postMessage,
            getState: () => ({}),
            setState: () => undefined,
        };
        (globalThis as { acquireVsCodeApi?: () => typeof api }).acquireVsCodeApi = () => api;

        const transport = createReaderTransport();
        expect(typeof transport.request).toBe('function');
        expect(typeof transport.notify).toBe('function');
        expect(typeof transport.onStateChanged).toBe('function');

        // Messenger.start() registers the message listener; constructing without the
        // empty-module acquireVsCodeApi must not throw.
        expect(() => acquireWebviewVsCodeApi()).not.toThrow();
        expect(acquireWebviewVsCodeApi()).toBe(api);
    });

    it('fails clearly when acquireVsCodeApi is missing', () => {
        delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
        expect(() => acquireWebviewVsCodeApi()).toThrow(/acquireVsCodeApi is unavailable/);
    });

    it('accepts an explicit API so callers never depend on package re-exports', () => {
        const api = {
            postMessage: vi.fn(),
            getState: () => ({}),
            setState: () => undefined,
        };
        expect(() => createReaderTransport(api)).not.toThrow();
    });
});
