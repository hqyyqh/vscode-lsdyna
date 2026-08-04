import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReaderApp, type ReaderTransport } from '../src/ReaderApp';
import { ReaderErrorBoundary } from '../src/ReaderErrorBoundary';
import type { ReaderViewModel } from '../../../src/manual/readerProtocol';

const documentContent: Extract<ReaderViewModel['content'], { kind: 'document' }> = {
    kind: 'document', markdown: '# Control\n\n[Next](next.md)', chunkBaseUri: 'vscode-resource:/pack/chunks/', sentencePairs: [],
};

const state: ReaderViewModel = {
    revision: 4,
    location: { manualId: 'vol', sectionId: 'control', anchorId: null, title: 'Control', pdfPage: 12 },
    language: 'zh' as const,
    uiLocale: 'en' as const,
    canToggleLanguage: true,
    chrome: { volumeTitle: 'Volume I', chapterLabel: 'Control', chapterKey: '13_control' },
    content: documentContent,
    navigation: { canBack: true, canForward: false, canPreviousSection: true, canNextSection: true },
    search: { query: '', scope: 'zh' as const, mode: 'keyword' as const, results: [] },
    restore: { anchorId: null, scrollY: 180, scrollRatio: 0 },
};

function transport() {
    let stateHandler: ((next: ReaderViewModel) => void) | undefined;
    const request = vi.fn<ReaderTransport['request']>(async () => true);
    return {
        request,
        notify: vi.fn(),
        onStateChanged: vi.fn(handler => { stateHandler = handler; return () => { stateHandler = undefined; }; }),
        emit(next: ReaderViewModel) { stateHandler?.(next); },
    } satisfies ReaderTransport & { emit(next: ReaderViewModel): void };
}

describe('ReaderApp', () => {
    const searchResults: ReaderViewModel['search']['results'] = [
        { location: { manualId: 'vol', sectionId: 'material', anchorId: null }, titleEn: 'Material Model', titleZh: '材料模型', preview: 'Selected material model.', matchedLanguages: ['en'], score: 3500 },
        { location: { manualId: 'vol', sectionId: 'node', anchorId: null }, titleEn: 'Node Example', titleZh: '节点示例', preview: 'A material example.', matchedLanguages: ['en'], score: 1600 },
    ];

    it('renders a single-row crumb / title identity in the toolbar', () => {
        render(<ReaderApp initialState={state} transport={transport()} />);
        expect(screen.getByText('Volume I · Control')).toBeInTheDocument();
        const title = document.querySelector('.reader-toolbar__title');
        expect(title).toBeTruthy();
        expect(title).toHaveTextContent('Control');
        const identity = document.querySelector('.reader-toolbar__identity');
        expect(identity).toBeTruthy();
        // Crumb and title share one horizontal identity row (not stacked).
        expect(getComputedStyle(identity as Element).flexDirection).not.toBe('column');
        // Path crumb precedes title so free space fills under the path, not after a short title.
        const crumb = document.querySelector('.reader-toolbar__crumb');
        expect(crumb).toBeTruthy();
        expect(identity!.compareDocumentPosition(title as Node) & Node.DOCUMENT_POSITION_CONTAINED_BY).toBeTruthy();
        expect(crumb!.compareDocumentPosition(title as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(screen.getByRole('group', { name: 'History' })).toBeInTheDocument();
        expect(screen.getByRole('group', { name: 'Sections' })).toBeInTheDocument();
        expect(screen.getByRole('group', { name: 'Text size' })).toBeInTheDocument();
        expect(document.title).toBe('DynaSense Manuals');
    });

    it('adjusts content font scale from the toolbar and Ctrl+wheel', async () => {
        const user = userEvent.setup();
        render(<ReaderApp initialState={state} transport={transport()} />);

        expect(document.documentElement.style.getPropertyValue('--reader-font-scale')).toBe('1');
        expect(screen.getByText('100%')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Increase text size' }));
        expect(document.documentElement.style.getPropertyValue('--reader-font-scale')).toBe('1.1');
        expect(screen.getByText('110%')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /Reset text size/ }));
        expect(document.documentElement.style.getPropertyValue('--reader-font-scale')).toBe('1');
        expect(screen.getByText('100%')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Decrease text size' }));
        expect(document.documentElement.style.getPropertyValue('--reader-font-scale')).toBe('0.9');

        fireEvent.wheel(window, { deltaY: -100, ctrlKey: true, bubbles: true });
        expect(document.documentElement.style.getPropertyValue('--reader-font-scale')).toBe('1');
    });

    it('does not change font scale with Ctrl+wheel while a modal is open', async () => {
        render(<ReaderApp initialState={state} transport={transport()} />);
        const modal = document.createElement('div');
        modal.setAttribute('aria-modal', 'true');
        document.body.appendChild(modal);
        try {
            fireEvent.wheel(window, { deltaY: -100, ctrlKey: true, bubbles: true });
            expect(document.documentElement.style.getPropertyValue('--reader-font-scale')).toBe('1');
        } finally {
            modal.remove();
        }
    });

    it('shows volume alone when chapter label is empty', () => {
        render(<ReaderApp initialState={{
            ...state,
            chrome: { volumeTitle: 'Volume II', chapterLabel: '', chapterKey: null },
        }} transport={transport()} />);
        expect(screen.getByText('Volume II')).toBeInTheDocument();
        expect(screen.queryByText(/Volume II ·/)).not.toBeInTheDocument();
    });

    it('opens search with the trigger or slash and restores focus on Escape', async () => {
        const client = transport();
        const user = userEvent.setup();
        render(<ReaderApp initialState={state} transport={client} />);
        const trigger = screen.getByRole('button', { name: 'Search manuals' });
        expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();

        await user.click(trigger);
        expect(screen.getByRole('searchbox')).toHaveFocus();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();

        fireEvent.keyDown(window, { key: '/' });
        expect(screen.getByRole('searchbox')).toHaveFocus();
        await user.keyboard('{Escape}');
        const textarea = document.createElement('textarea');
        document.body.append(textarea);
        textarea.focus();
        fireEvent.keyDown(textarea, { key: '/' });
        expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
        textarea.remove();
    });

    it('toggles the search popover from the toolbar button and closes on outside click', async () => {
        const client = transport();
        const user = userEvent.setup();
        render(<ReaderApp initialState={state} transport={client} />);
        const trigger = screen.getByRole('button', { name: 'Search manuals' });

        await user.click(trigger);
        expect(screen.getByRole('searchbox')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Close search' })).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Search scope')).not.toBeInTheDocument();

        await user.click(trigger);
        expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();

        await user.click(trigger);
        fireEvent.pointerDown(document.body, { bubbles: true });
        expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    });

    it('remembers the query and selects it when reopening search', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const client = transport();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<ReaderApp initialState={state} transport={client} />);
        const trigger = screen.getByRole('button', { name: 'Search manuals' });

        await user.click(trigger);
        await user.type(screen.getByRole('searchbox'), 'control time');
        await act(async () => { vi.advanceTimersByTime(300); });
        await user.keyboard('{Escape}');

        await user.click(trigger);
        const input = screen.getByRole('searchbox') as HTMLInputElement;
        expect(input).toHaveValue('control time');
        expect(input.selectionStart).toBe(0);
        expect(input.selectionEnd).toBe('control time'.length);
        vi.useRealTimers();
    });

    it('keeps result count visible while a follow-up search is pending', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let resolveSearch!: (value: boolean) => void;
        const client = transport();
        client.request.mockImplementation((name: string) => name === 'reader/search'
            ? new Promise(resolve => { resolveSearch = resolve; })
            : Promise.resolve(true));
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<ReaderApp initialState={{
            ...state,
            search: { query: 'material', scope: 'en', mode: 'keyword' as const, results: searchResults },
        }} transport={client} />);

        await user.click(screen.getByRole('button', { name: 'Search manuals' }));
        expect(screen.getByRole('status')).toHaveTextContent('2 results');
        await user.type(screen.getByRole('searchbox'), 'x');
        await act(async () => { vi.advanceTimersByTime(300); });
        // Stale-while-revalidate: do not swap the summary to "Searching…" when results already exist.
        expect(screen.getByRole('status')).toHaveTextContent('2 results');
        expect(screen.getByRole('status')).not.toHaveTextContent('Searching');
        resolveSearch(true);
        vi.useRealTimers();
    });

    it('supports listbox navigation, result counts, and highlighted matches', async () => {
        const client = transport();
        const user = userEvent.setup();
        render(<ReaderApp initialState={{ ...state, search: { query: 'material', scope: 'en', mode: 'keyword' as const, results: searchResults } }} transport={client} />);
        await user.click(screen.getByRole('button', { name: 'Search manuals' }));

        expect(screen.getByRole('status')).toHaveTextContent('2 results');
        expect(screen.getAllByText(/material/i, { selector: 'mark' }).length).toBeGreaterThan(0);
        const input = screen.getByRole('searchbox');
        await user.type(input, '{ArrowDown}{ArrowUp}{End}{Home}{End}{Enter}');

        expect(client.request).toHaveBeenCalledWith('reader/navigate', { revision: 4, target: searchResults[1].location });
        expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    });

    it('announces pending, empty, and failed searches', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let rejectSearch!: (error: Error) => void;
        const client = transport();
        client.request.mockImplementation((name: string) => name === 'reader/search'
            ? new Promise((_resolve, reject) => { rejectSearch = reject; })
            : Promise.resolve(true));
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<ReaderApp initialState={state} transport={client} />);
        await user.click(screen.getByRole('button', { name: 'Search manuals' }));
        await user.type(screen.getByRole('searchbox'), 'missing');
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(screen.getByRole('status')).toHaveTextContent('Searching');
        rejectSearch(new Error('index unavailable'));
        expect(await screen.findByRole('alert')).toHaveTextContent('Search failed');

        act(() => client.emit({ ...state, revision: 5, search: { query: 'missing', scope: 'en', mode: 'keyword' as const, results: [] } }));
        expect(screen.getByText('No results found')).toBeInTheDocument();
        vi.useRealTimers();
    });

    it('live-searches while typing without requiring the Search button', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const client = transport();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<ReaderApp initialState={state} transport={client} />);
        await user.click(screen.getByRole('button', { name: 'Search manuals' }));
        await user.type(screen.getByRole('searchbox'), 'dt2ms');
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(client.request).toHaveBeenCalledWith('reader/search', { revision: 4, query: 'dt2ms', scope: 'en', mode: 'keyword' });
        vi.useRealTimers();
    });

    it('toggles keyword and fulltext search mode from the input control', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const client = transport();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<ReaderApp initialState={state} transport={client} />);
        await user.click(screen.getByRole('button', { name: 'Search manuals' }));
        await user.type(screen.getByRole('searchbox'), 'material');
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(client.request).toHaveBeenCalledWith('reader/search', {
            revision: 4, query: 'material', scope: 'en', mode: 'keyword',
        });
        await user.click(screen.getByRole('button', { name: /Search keywords and titles/i }));
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(client.request).toHaveBeenCalledWith('reader/search', {
            revision: 4, query: 'material', scope: 'en', mode: 'fulltext',
        });
        vi.useRealTimers();
    });

    it('tracks the wrapped toolbar height for anchor and overlay offsets', () => {
        let observerCallback: ResizeObserverCallback | undefined;
        const observe = vi.fn();
        const disconnect = vi.fn();
        class ResizeObserverMock {
            constructor(callback: ResizeObserverCallback) { observerCallback = callback; }
            observe = observe;
            disconnect = disconnect;
            unobserve = vi.fn();
        }
        vi.stubGlobal('ResizeObserver', ResizeObserverMock);
        const client = transport();
        const { unmount } = render(<ReaderApp initialState={state} transport={client} />);
        const toolbar = screen.getByRole('banner');
        Object.defineProperty(toolbar, 'getBoundingClientRect', { configurable: true, value: () => ({ height: 86 }) });

        act(() => observerCallback?.([], {} as ResizeObserver));

        expect(observe).toHaveBeenCalledWith(toolbar);
        expect(document.documentElement.style.getPropertyValue('--reader-toolbar-height')).toBe('86px');
        unmount();
        expect(disconnect).toHaveBeenCalled();
        expect(document.documentElement.style.getPropertyValue('--reader-toolbar-height')).toBe('');
        vi.unstubAllGlobals();
    });

    it('shows a real loading skeleton and retries a failed ready request', async () => {
        const client = transport();
        client.request
            .mockRejectedValueOnce(new Error('transport offline'))
            .mockResolvedValueOnce(state);
        const user = userEvent.setup();

        render(<ReaderApp initialState={null as never} transport={client} />);

        expect(screen.getByRole('status')).toHaveTextContent('Loading manual');
        expect(document.querySelector('.reader-skeleton')).toBeInTheDocument();
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the manual');
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByRole('heading', { name: 'Control' })).toBeInTheDocument();
        expect(client.request).toHaveBeenCalledTimes(2);
    });

    it('requests ready and dispatches navigation, language, search, link, and PDF actions with the active revision', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const client = transport();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        // Chinese UI exposes the language toggle and bilingual search scope.
        const zhState = { ...state, uiLocale: 'zh' as const, language: 'zh' as const, search: { query: '', scope: 'zh' as const, mode: 'keyword' as const, results: [] } };
        render(<ReaderApp initialState={zhState} transport={client} />);

        await waitFor(() => expect(client.request).toHaveBeenCalledWith('reader/ready', { revision: 4 }));
        await user.click(screen.getByRole('button', { name: '后退' }));
        await user.click(screen.getByRole('button', { name: '下一节' }));
        await user.click(screen.getByRole('button', { name: '切换语言' }));
        await user.click(screen.getByRole('button', { name: '打开 PDF' }));
        await user.click(screen.getByRole('button', { name: '搜索手册' }));
        await user.type(screen.getByRole('searchbox'), 'dt2ms');
        await act(async () => { vi.advanceTimersByTime(300); });
        await user.click(screen.getByRole('link', { name: 'Next' }));

        expect(client.request).toHaveBeenCalledWith('reader/navigate', { revision: 4, target: 'back' });
        expect(client.request).toHaveBeenCalledWith('reader/navigate', { revision: 4, target: 'nextSection' });
        expect(client.request).toHaveBeenCalledWith('reader/toggleLanguage', { revision: 4 });
        expect(client.request).toHaveBeenCalledWith('reader/openPdf', { revision: 4 });
        expect(client.request).toHaveBeenCalledWith('reader/search', { revision: 4, query: 'dt2ms', scope: 'both', mode: 'keyword' });
        expect(client.request).toHaveBeenCalledWith('reader/openLink', { revision: 4, href: 'next.md' });
        vi.useRealTimers();
    });

    it('shows language toggle and translation chrome under English UI when pack is bilingual', () => {
        const client = transport();
        render(<ReaderApp initialState={{
            ...state,
            uiLocale: 'en',
            canToggleLanguage: true,
            content: {
                ...documentContent,
                sentencePairs: [{ primary: 'Static friction', secondary: '静摩擦' }],
            },
        }} transport={client} />);

        expect(screen.getByRole('button', { name: 'Toggle language' })).toBeInTheDocument();
        expect(screen.getByText(/Hold Alt/)).toBeInTheDocument();
        expect(screen.getByText(/Unofficial documentation/)).toBeInTheDocument();
    });

    it('hides language toggle for English-only pack even under Chinese UI', () => {
        const client = transport();
        render(<ReaderApp initialState={{
            ...state,
            uiLocale: 'zh',
            language: 'en',
            canToggleLanguage: false,
        }} transport={client} />);

        expect(screen.queryByRole('button', { name: '切换语言' })).not.toBeInTheDocument();
    });

    it('rejects stale state notifications and applies a newer revision', () => {
        const client = transport();
        render(<ReaderApp initialState={state} transport={client} />);
        act(() => client.emit({ ...state, revision: 3, content: { ...documentContent, markdown: '# Stale' } }));
        expect(screen.getByRole('heading', { name: 'Control' })).toBeInTheDocument();

        act(() => client.emit({ ...state, revision: 5, content: { ...documentContent, markdown: '# Fresh' } }));
        expect(screen.getByRole('heading', { name: 'Fresh' })).toBeInTheDocument();
    });

    it('localizes reader chrome without depending on extension i18n', () => {
        const client = transport();
        render(<ReaderApp initialState={{ ...state, uiLocale: 'zh' } as never} transport={client} />);

        expect(screen.getByRole('banner', { name: '手册阅读器工具栏' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '后退' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '打开 PDF' })).toBeInTheDocument();
        expect(screen.getByText(/非官方文档/)).toBeInTheDocument();
        expect(document.documentElement).toHaveAttribute('lang', 'zh');
    });

    it('reports rejected actions, allows dismissal, and ignores stale failures', async () => {
        let rejectPending!: (error: Error) => void;
        const pending = new Promise((_resolve, reject) => { rejectPending = reject; });
        const client = transport();
        client.request.mockImplementation(async (name: string) => {
            if (name === 'reader/ready') return true;
            if (name === 'reader/openPdf') return false;
            if (name === 'reader/toggleLanguage') return pending;
            return true;
        });
        const user = userEvent.setup();
        // Need Chinese UI so the language toggle exists for the stale-failure path.
        render(<ReaderApp initialState={{ ...state, uiLocale: 'zh' }} transport={client} />);

        await user.click(screen.getByRole('button', { name: '打开 PDF' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('当前操作已不可用');
        await user.click(screen.getByRole('button', { name: '关闭' }));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: '切换语言' }));
        act(() => client.emit({ ...state, revision: 5, uiLocale: 'zh' }));
        rejectPending(new Error('late failure'));
        await waitFor(() => expect(screen.queryByText(/late failure/)).not.toBeInTheDocument());
    });

    it('opens PDF without the global Working banner (hover-like)', async () => {
        let resolvePdf!: (value: boolean) => void;
        const pdfPending = new Promise<boolean>(resolve => { resolvePdf = resolve; });
        const client = transport();
        client.request.mockImplementation(async (name: string) => {
            if (name === 'reader/ready') return true;
            if (name === 'reader/openPdf') return pdfPending;
            return true;
        });
        const user = userEvent.setup();
        render(<ReaderApp initialState={state} transport={client} />);

        await user.click(screen.getByRole('button', { name: 'Open PDF' }));
        expect(client.request).toHaveBeenCalledWith('reader/openPdf', { revision: 4 });
        expect(screen.queryByText(/Working/i)).not.toBeInTheDocument();
        await act(async () => { resolvePdf(true); });
        expect(screen.queryByText(/Working/i)).not.toBeInTheDocument();
    });

    it('toggles document language silently with an optimistic pill', async () => {
        let resolveToggle!: (value: boolean) => void;
        const togglePending = new Promise<boolean>(resolve => { resolveToggle = resolve; });
        const client = transport();
        client.request.mockImplementation(async (name: string) => {
            if (name === 'reader/ready') return true;
            if (name === 'reader/toggleLanguage') return togglePending;
            return true;
        });
        const user = userEvent.setup();
        const zhState = { ...state, uiLocale: 'zh' as const, language: 'zh' as const };
        render(<ReaderApp initialState={zhState} transport={client} />);

        const toggle = screen.getByRole('button', { name: '切换语言' });
        expect(toggle).toHaveTextContent('中文');
        await user.click(toggle);
        // Optimistic flip before host returns; no Working banner.
        expect(toggle).toHaveTextContent('EN');
        expect(screen.queryByText(/正在处理|Working/i)).not.toBeInTheDocument();
        expect(client.request).toHaveBeenCalledWith('reader/toggleLanguage', { revision: 4 });

        await act(async () => { resolveToggle(true); });
        act(() => client.emit({ ...zhState, revision: 5, language: 'en' }));
        expect(toggle).toHaveTextContent('EN');
    });

    it('rolls back the optimistic language pill when toggle is rejected', async () => {
        const client = transport();
        client.request.mockImplementation(async (name: string) => {
            if (name === 'reader/ready') return true;
            if (name === 'reader/toggleLanguage') return false;
            return true;
        });
        const user = userEvent.setup();
        render(<ReaderApp initialState={{ ...state, uiLocale: 'zh', language: 'zh' }} transport={client} />);
        const toggle = screen.getByRole('button', { name: '切换语言' });
        await user.click(toggle);
        await waitFor(() => expect(toggle).toHaveTextContent('中文'));
    });

    it('restores scroll and reports debounced scroll state', async () => {
        vi.useFakeTimers();
        const client = transport();
        render(<ReaderApp initialState={state} transport={client} />);
        expect(window.scrollTo).toHaveBeenCalledWith(0, 180);

        Object.defineProperty(window, 'scrollY', { configurable: true, value: 245 });
        fireEvent.scroll(window);
        await vi.advanceTimersByTimeAsync(250);
        expect(client.notify).toHaveBeenCalledWith('reader/scrollChanged', { revision: 4, scrollY: 245, scrollRatio: expect.any(Number), anchorId: null });
        vi.useRealTimers();
    });

    it('restores by anchor, then ratio, and finally absolute scroll', () => {
        const client = transport();
        const scrollTo = vi.mocked(window.scrollTo);
        scrollTo.mockClear();
        const anchored = render(<ReaderApp initialState={{
            ...state,
            content: { ...documentContent, markdown: '<a id="saved"></a>\n# Saved' },
            restore: { anchorId: 'saved', scrollY: 120, scrollRatio: .5 },
        }} transport={client} />);
        expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
        expect(scrollTo).not.toHaveBeenCalled();
        anchored.unmount();

        Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 1000 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 });
        scrollTo.mockClear();
        const ratio = render(<ReaderApp initialState={{ ...state, restore: { anchorId: 'missing', scrollY: 120, scrollRatio: .5 } }} transport={client} />);
        expect(scrollTo).toHaveBeenCalledWith(0, 400);
        ratio.unmount();

        scrollTo.mockClear();
        render(<ReaderApp initialState={{ ...state, restore: { anchorId: 'missing', scrollY: 120, scrollRatio: 0 } }} transport={client} />);
        expect(scrollTo).toHaveBeenCalledWith(0, 120);
    });

    it('tracks anchors and rAF progress, reports ratios, and offers reduced-motion back to top', async () => {
        vi.useFakeTimers();
        let intersectionCallback: IntersectionObserverCallback | undefined;
        const observe = vi.fn();
        class IntersectionObserverMock {
            constructor(callback: IntersectionObserverCallback) { intersectionCallback = callback; }
            observe = observe;
            disconnect = vi.fn();
            unobserve = vi.fn();
            takeRecords = vi.fn(() => []);
            root = null;
            rootMargin = '';
            thresholds = [];
        }
        vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
        vi.stubGlobal('cancelAnimationFrame', (handle: number) => window.clearTimeout(handle));
        vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
        Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 1000 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 });
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 400 });
        const client = transport();
        render(<ReaderApp initialState={{
            ...state,
            content: { ...documentContent, markdown: '<a id="control"></a>\n# Control' },
            restore: { anchorId: null, scrollY: 0, scrollRatio: 0 },
        }} transport={client} />);
        const anchor = document.getElementById('control')!;
        act(() => intersectionCallback?.([{ target: anchor, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
        fireEvent.scroll(window);
        await vi.advanceTimersByTimeAsync(250);

        expect(screen.getByRole('progressbar', { name: 'Reading progress' })).toHaveAttribute('aria-valuenow', '50');
        expect(client.notify).toHaveBeenCalledWith('reader/scrollChanged', { revision: 4, anchorId: 'control', scrollY: 400, scrollRatio: .5 });
        fireEvent.click(screen.getByRole('button', { name: 'Back to top' }));
        expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('renders host errors and catches unexpected render failures', () => {
        const client = transport();
        const errorView = render(<ReaderApp initialState={{ ...state, content: { kind: 'error', message: 'Chunk missing' } }} transport={client} />);
        expect(screen.getByRole('alert')).toHaveTextContent('Could not display this manual section');
        errorView.unmount();

        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const Broken = () => { throw new Error('boom'); };
        render(<ReaderErrorBoundary locale="zh"><Broken /></ReaderErrorBoundary>);
        expect(screen.getByRole('alert')).toHaveTextContent('阅读器无法显示此文档');
        consoleError.mockRestore();
    });
});
