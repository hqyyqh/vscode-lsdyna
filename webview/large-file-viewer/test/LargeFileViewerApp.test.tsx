import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LargeFileViewerApp } from '../src/LargeFileViewerApp';
import type { LargeFileViewerState } from '../../../src/client/largeFileViewerProtocol';
import type { LargeFileViewerTransport } from '../src/transport';

function viewState(overrides: Partial<LargeFileViewerState> = {}): LargeFileViewerState {
    return {
        revision: 4,
        locale: 'zh',
        fileName: 'rogue-v3.key',
        fileSize: 417811575,
        anchorLine: 100,
        lineCount: 5385293,
        currentKeyword: '*PART',
        indexing: 'ready',
        indexingMessage: '',
        stale: false,
        selectedField: null,
        lines: [{
            lineNumber: 100,
            text: '   2000101   2000101',
            truncated: false,
            keyword: false,
            fields: [{ token: 'mid-token', startColumn: 10, endColumn: 20, label: 'MID', queryable: true }],
        }],
        search: { query: '', loading: false, count: 0, currentIndex: -1, truncated: false, message: '' },
        labels: {
            goto: '跳转', line: '行', keyword: '关键字', previous: '上一个', next: '下一个',
            textMode: '全文查找模式；切换关键字', keywordMode: '关键字模式；切换全文查找', searchHint: '全文查找提示', clearSearch: '清除查找', searchText: '全文查找', searching: '查找中…', matchLines: '匹配行', keywordHint: '关键字跳转提示', gotoHint: '行号跳转提示', search: '搜索', reload: '重新加载', indexing: '索引中', stale: '已失效',
            truncatedLine: '截断', english: '原文', queryObject: '对象引用', noField: '选择字段',
            failed: '操作未完成，请重试。', retry: '重试', card: '卡片', defaultValue: '默认值',
            readOnlyShort: '只读', navigationTarget: '跳转目标', readOnly: '只读查看；不能在此修改文件。', previousKeyword: '上一个匹配的关键字', nextKeyword: '下一个匹配的关键字',
            previousMatch: '上一个搜索匹配项', nextMatch: '下一个搜索匹配项',
            closeSearch: '关闭搜索', details: '字段详情', objectName: '当前文件中的对象名称',
        },
        ...overrides,
    };
}

function transport(initial: LargeFileViewerState): LargeFileViewerTransport {
    return {
        updatePosition: vi.fn(),
        ready: async () => initial,
        navigate: vi.fn(async () => true),
        navigateKeyword: vi.fn(async () => true),
        search: vi.fn(async () => true),
        searchStep: vi.fn(async () => true),
        selectField: vi.fn(async () => true),
        queryField: vi.fn(async () => true),
        reload: vi.fn(async () => true),
        onStateChanged: () => () => undefined,
    };
}

test.each([['zh-CN', '正在加载文件…'], ['en', 'Loading file…']])('uses the host document locale %s before the first response', (locale, message) => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = locale;
    try {
        const api = transport(viewState());
        api.ready = () => new Promise(() => undefined);
        render(<LargeFileViewerApp transport={api} />);
        expect(screen.getByRole('status')).toHaveTextContent(message);
    } finally { document.documentElement.lang = previous; }
});

test('keeps newer notifications and focused input when ready arrives late', async () => {
    const api = transport(viewState());
    let resolve!: (value: LargeFileViewerState) => void;
    let notify!: (value: LargeFileViewerState) => void;
    api.ready = () => new Promise(done => { resolve = done; });
    api.onStateChanged = handler => { notify = handler; return () => undefined; };
    render(<LargeFileViewerApp transport={api} />);
    await act(async () => notify(viewState({ revision: 8, anchorLine: 300, fileName: 'newer.k' })));
    const input = screen.getByDisplayValue('301');
    await userEvent.clear(input);
    await userEvent.type(input, '4098');
    await act(async () => resolve(viewState({ revision: 4, fileName: 'older.k' })));
    expect(screen.getByRole('status')).toHaveTextContent('行 301 /');
    expect(input).toHaveValue('4098');
    await act(async () => notify(viewState({ revision: 7, fileName: 'obsolete.k' })));
    expect(screen.getByRole('status')).toHaveTextContent('行 301 /');
});

test('recovers from a rejected initial request using the document locale', async () => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = 'en';
    try {
        const api = transport(viewState());
        api.ready = vi.fn().mockRejectedValueOnce(Error('private transport details')).mockResolvedValue(viewState());
        render(<LargeFileViewerApp transport={api} />);
        expect(await screen.findByRole('alert')).toHaveTextContent('The operation did not complete. Please try again.');
        expect(document.body).not.toHaveTextContent('private transport details');
        await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByDisplayValue('101')).toBeInTheDocument();
    } finally { document.documentElement.lang = previous; }
});

test('offers initialization retry after a timeout and ignores an obsolete attempt', async () => {
    vi.useFakeTimers();
    try {
        const api = transport(viewState());
        let resolve!: (value: LargeFileViewerState) => void;
        api.ready = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(viewState({ revision: 9 }));
        render(<LargeFileViewerApp transport={api} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
        fireEvent.click(screen.getByRole('button', { name: /Retry|重试/ }));
        await act(async () => {});
        await act(async () => resolve(viewState({ anchorLine: 999, fileName: 'obsolete.k' })));
        expect(screen.getByRole('status')).toHaveTextContent('行 101 /');
    } finally { vi.useRealTimers(); }
});

test('shows failed actions and retries with the latest revision without blocking double-click queries', async () => {
    const api = transport(viewState());
    let notify!: (value: LargeFileViewerState) => void;
    api.onStateChanged = handler => { notify = handler; return () => undefined; };
    api.reload = vi.fn().mockRejectedValueOnce(Error('private read error')).mockResolvedValue(true);
    render(<LargeFileViewerApp transport={api} />);
    await act(async () => notify(viewState({ indexing: 'error', indexingMessage: 'Index failed' })));
    await userEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('操作未完成，请重试。');
    await act(async () => notify(viewState({ revision: 8, indexing: 'error', indexingMessage: 'Index failed' })));
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(api.reload).toHaveBeenLastCalledWith(8);
    await act(async () => notify(viewState({ revision: 9 })));
    api.selectField = vi.fn(() => new Promise<boolean>(() => undefined));
    await userEvent.dblClick(screen.getByRole('button', { name: '2000101' }));
    expect(api.queryField).toHaveBeenCalledWith(9, 'mid-token');
});

test('uses current revision for delayed navigation and cancels it on stale state', async () => {
    const api = transport(viewState());
    let notify!: (value: LargeFileViewerState) => void;
    api.onStateChanged = handler => { notify = handler; return () => undefined; };
    render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    const viewport = document.querySelector('.viewport') as HTMLElement;
    const scrollTo = (line: number) => fireEvent.scroll(viewport, { target: { scrollTop: line / 5385292 * 4_000_000 } });
    vi.useFakeTimers();
    try {
        scrollTo(200);
        await act(async () => notify(viewState({ revision: 8 })));
        await act(async () => { await vi.advanceTimersByTimeAsync(70); });
        expect(api.navigate).toHaveBeenLastCalledWith(8, 200);
        scrollTo(300);
        await act(async () => notify(viewState({ revision: 9, stale: true })));
        await act(async () => { await vi.advanceTimersByTimeAsync(70); });
        expect(api.navigate).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
});

test('keeps one inline search with keyboard focus, clear action and literal search tooltips', async () => {
    const api = transport(viewState());
    render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    await userEvent.click(screen.getByRole('button', {name:'关键字模式；切换全文查找'}));
    expect(screen.getAllByRole('button', { name: '搜索' })).toHaveLength(1);
    const input = screen.getByRole('textbox', { name: '搜索' });
    expect(input.closest('.titlebar')).not.toBeNull();
    expect(input).toHaveAttribute('title', '全文查找提示');
    (document.querySelector('.viewport') as HTMLElement).focus();
    await userEvent.keyboard('{Control>}f{/Control}');
    expect(input).toHaveFocus();
    await userEvent.type(input, '*PART{Enter}');
    expect(api.search).toHaveBeenCalledWith(4, '*PART');
    await userEvent.click(screen.getByRole('button', { name: '清除查找' }));
    expect(input).toHaveValue('');
    expect(api.search).toHaveBeenLastCalledWith(4, '');
});

test('highlights the current search line without changing source text and disables old-query arrows', async () => {
    const api = transport(viewState({search: {query:'2000101',loading:false,count:23,currentIndex:0,currentLine:100,truncated:false,message:''}}));
    render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    expect(document.querySelector('.search-match')).toHaveTextContent('2000101');
    expect(document.querySelector('.line-text')).toHaveTextContent('2000101 2000101');
    (document.querySelector('.viewport') as HTMLElement).focus();
    await userEvent.keyboard('{Control>}f{/Control}');
    const next = screen.getByRole('button', {name:'上一个搜索匹配项'});
    expect(next).toBeEnabled();
    await userEvent.keyboard('{Control>}f{/Control}');
    await userEvent.type(screen.getByRole('textbox', {name:'搜索'}), 'new');
    expect(next).toBeDisabled();
});

test('uses one bounded native scroll position and displays keyword context only off the source line', async () => {
    const api = transport(viewState());
    let notify!: (value: LargeFileViewerState) => void;
    api.onStateChanged = handler => { notify = handler; return () => undefined; };
    render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    const viewport = document.querySelector('.viewport') as HTMLElement;
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(viewport.scrollTop).toBeCloseTo(100 / 5385292 * 4_000_000);
    expect(document.querySelector('.status .sticky-header')).toHaveTextContent('*PART');
    expect(document.querySelector('.sticky-header')).toHaveTextContent('*PART');
    await act(async () => notify(viewState({ revision: 5, anchorLine: 200, currentKeyword: '*MAT_ELASTIC',
        lines: [{ lineNumber: 200, text: '*MAT_ELASTIC', keyword: true, truncated: false, fields: [] }] })));
    expect(viewport.scrollTop).toBeCloseTo(200 / 5385292 * 4_000_000);
    expect(screen.getByDisplayValue('201')).toBeInTheDocument();
    expect(document.querySelector('.sticky-header')).toHaveTextContent('*MAT_ELASTIC');
    expect(screen.getAllByText('*MAT_ELASTIC')).toHaveLength(2);
});

test('does not reinterpret rounded programmatic scroll coordinates as user navigation', async () => {
    const api = transport(viewState());
    let notify!: (value: LargeFileViewerState) => void;
    api.onStateChanged = handler => { notify = handler; return () => undefined; };
    render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    const viewport = document.querySelector('.viewport') as HTMLElement;
    let top = viewport.scrollTop;
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => top, set: value => { top = Math.round(value); } });
    await act(async () => notify(viewState({ revision: 5, anchorLine: 5000000,
        lines: [{ lineNumber: 5000000, text: 'node', keyword: false, truncated: false, fields: [] }] })));
    fireEvent.scroll(viewport);
    expect(api.navigate).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('5000001')).toBeInTheDocument();
});

test('accumulates wheel movement and sizes keyboard paging to the viewport', async () => {
    const api = transport(viewState());
    render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    const viewport = document.querySelector('.viewport') as HTMLElement;
    vi.useFakeTimers();
    try {
        fireEvent.wheel(viewport, { deltaY: 40, cancelable: true });
        fireEvent.wheel(viewport, { deltaY: 40, cancelable: true });
        await act(async () => { await vi.advanceTimersByTimeAsync(70); });
        expect(api.navigate).toHaveBeenLastCalledWith(4, 104);
        await act(async () => { fireEvent.keyDown(viewport, { key: 'PageDown' }); await vi.advanceTimersByTimeAsync(16); });
        expect(api.navigate).toHaveBeenLastCalledWith(4, 118);
        await act(async () => { fireEvent.keyDown(viewport, { key: 'End' }); await vi.advanceTimersByTimeAsync(16); });
        expect(api.navigate).toHaveBeenLastCalledWith(4, 5385292);
        await act(async () => { fireEvent.keyDown(viewport, { key: 'Home' }); await vi.advanceTimersByTimeAsync(16); });
        expect(api.navigate).toHaveBeenLastCalledWith(4, 0);
    } finally { vi.useRealTimers(); }
});

test('shows the object identity beside field actions and keeps detailed help expandable', async () => {
    const api = transport(viewState({ selectedField: { token: 'mid-token', label: 'MID', value: '7',
        keyword: '*PART', cardIndex: 1, localizedHelp: '材料编号', englishHelp: 'Material identifier', type: 'integer',
        defaultValue: '', choices: [], queryable: true, object: { kind: 'material', kindLabel: '材料', id: '7', name: 'Steel' } } }));
    render(<LargeFileViewerApp transport={api} />);
    expect(await screen.findByText('材料 7')).toBeInTheDocument();
    expect(screen.getByText('Steel')).toHaveAttribute('title', '当前文件中的对象名称');
    const details = screen.getByText('字段详情').closest('details');
    expect(details).not.toHaveAttribute('open');
    await userEvent.click(screen.getByText('字段详情'));
    expect(details).toHaveAttribute('open');
    await userEvent.click(screen.getByRole('button', { name: '对象引用' }));
    expect(api.queryField).toHaveBeenCalledWith(4, 'mid-token');
});

test('keeps a signed source value distinct from the referenced object ID', async () => {
    const api = transport(viewState({ selectedField: { token: 'mid-token', label: 'MID', value: '-7',
        keyword: '*PART', cardIndex: 1, localizedHelp: '', englishHelp: '', type: 'integer',
        defaultValue: '', choices: [], queryable: true, object: { kind: 'material', kindLabel: '材料', id: '7' } } }));
    render(<LargeFileViewerApp transport={api} />);
    expect(await screen.findByText('材料 7')).toBeInTheDocument();
    expect(screen.getByText('-7', { selector: 'code' })).toBeInTheDocument();
});

test('blocks stale field selection, double-click and Enter and names controls by their action', async () => {
    const selectedField = { token: 'mid-token', label: 'MID', value: '7', keyword: '*PART', cardIndex: 1,
        localizedHelp: '材料编号', englishHelp: 'Material identifier', type: 'integer', defaultValue: '0', choices: [], queryable: true };
    const api = transport(viewState({ stale: true, selectedField, locale: 'zh' }));
    render(<LargeFileViewerApp transport={api} />);
    const field = await screen.findByRole('button', { name: '2000101' });
    await userEvent.dblClick(field);
    (document.querySelector('.viewport') as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    expect(api.selectField).not.toHaveBeenCalled();
    expect(api.queryField).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '对象引用' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '行' })).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'关键字模式；切换全文查找'})).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '上一个匹配的关键字' })).toBeDisabled();
    expect(screen.getByLabelText('只读查看；不能在此修改文件。')).toBeInTheDocument();
    expect(document.querySelector('main')).toHaveAttribute('lang', 'zh');
    expect(screen.getByText(/卡片 1/)).toBeInTheDocument();
    expect(screen.getByText('默认值: 0')).toBeInTheDocument();
});

test('renders a bounded no-wrap window and sends opaque field tokens', async () => {
    const api = transport(viewState());
    render(<LargeFileViewerApp transport={api} />);
    const field = await screen.findByRole('button', { name: '2000101' });
    await userEvent.click(field);
    expect(api.selectField).toHaveBeenCalledWith(4, 'mid-token');
    await userEvent.dblClick(field);
    expect(api.queryField).toHaveBeenCalledWith(4, 'mid-token');
    expect(document.querySelectorAll('.line')).toHaveLength(1);
});

test('offers reload after an index failure and keeps indexed navigation disabled', async () => {
    const api = transport(viewState({ indexing: 'error', indexingMessage: 'Could not build the file index. Reload to try again.' }));
    render(<LargeFileViewerApp transport={api} />);
    const reload = await screen.findByRole('button', { name: '重新加载' });
    expect(screen.getByRole('status')).toHaveTextContent('Could not build the file index. Reload to try again.');
    expect(screen.getByRole('button', { name: '跳转' })).toBeDisabled();
    await userEvent.click(reload);
    expect(api.reload).toHaveBeenCalledWith(4);
});

test('shows compact field help and queries on Enter', async () => {
    const api = transport(viewState({
        selectedField: {
            token: 'mid-token', label: 'MID', value: '2000101', keyword: '*PART', cardIndex: 1,
            localizedHelp: '材料编号', englishHelp: 'Material identifier', type: 'integer',
            defaultValue: '', choices: [], queryable: true,
        },
    }));
    render(<LargeFileViewerApp transport={api} />);
    expect(await screen.findByText('材料编号')).toBeInTheDocument();
    (document.querySelector('.viewport') as HTMLElement).focus();
    await userEvent.keyboard('{Enter}');
    expect(api.queryField).toHaveBeenCalledWith(4, 'mid-token');
});

test('supports exact line navigation without rendering a full-file spacer', async () => {
    const api = transport(viewState());
    render(<LargeFileViewerApp transport={api} />);
    const input = await screen.findByDisplayValue('101');
    await userEvent.clear(input);
    await userEvent.type(input, '4098{enter}');
    expect(api.navigate).toHaveBeenCalledWith(4, 4097);
    await userEvent.clear(input);
    await userEvent.type(input, '3000');
    await userEvent.click(screen.getByRole('button', { name: '跳转' }));
    expect(api.navigate).toHaveBeenLastCalledWith(4, 2999);
    expect(document.querySelector('[style*="5385293"]')).not.toBeInTheDocument();
});

test('queries the focused field on Enter without querying a different selected field', async () => {
    const api = transport(viewState({ selectedField: {
        token: 'other-token', label: 'OTHER', value: '8', keyword: '*PART', cardIndex: 1,
        localizedHelp: '', englishHelp: '', type: '', defaultValue: '', choices: [], queryable: true,
    } }));
    render(<LargeFileViewerApp transport={api} />);
    const field = await screen.findByRole('button', { name: '2000101' });
    field.focus();
    await userEvent.keyboard('{Enter}');
    expect(api.queryField).toHaveBeenCalledWith(4, 'mid-token');
    expect(api.queryField).not.toHaveBeenCalledWith(4, 'other-token');
});


test('scrolls within buffered lines immediately without a host request', async () => {
    const api = transport(viewState({ lines: Array.from({ length: 240 }, (_, lineNumber) => ({
        lineNumber, text: String(lineNumber), fields: [], keyword: false, truncated: false,
    })) }));
    const { container } = render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    const viewport = container.querySelector('.viewport')!;
    fireEvent.wheel(viewport, { deltaY: 40, cancelable: true });
    expect(container.querySelector('.line-number')).toHaveTextContent('103');
    expect(screen.getByRole('status')).toHaveTextContent('行 103 /');
    expect(api.navigate).not.toHaveBeenCalled();
    fireEvent.wheel(viewport, { deltaY: -40, cancelable: true });
    expect(container.querySelector('.line-number')).toHaveTextContent('101');
    expect(api.navigate).not.toHaveBeenCalled();
});

test('marks the navigation range independently from selected fields and preserves source text', async () => {
    const initial = viewState({ navigationTarget: { line: 100, startColumn: 10, endColumn: 20 } });
    const api = transport(initial);
    const { container } = render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    expect(container.querySelector('.navigation-line')).not.toBeNull();
    expect(container.querySelector('.navigation-field')).toHaveTextContent('2000101');
    expect(container.querySelector('.line-text')?.textContent).toBe(initial.lines[0].text);
    expect(container.querySelector('.field.selected')).toBeNull();
});

test('colors visible comments, numbers and parameters without changing fixed columns', async () => {
    const texts = ['$#       mid        ro', '         1   -1.2D-9 &density'];
    const api = transport(viewState({ lines: texts.map((text, i) => ({ lineNumber: 100 + i, text,
        fields: [], keyword: false, truncated: false })) }));
    const { container } = render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    expect(container.querySelector('.comment-line')).not.toBeNull();
    expect([...container.querySelectorAll('.line-text')].map(row => row.textContent)).toEqual(texts);
    expect(container.querySelector('.syntax-parameter')).toHaveTextContent('&density');
    expect([...container.querySelectorAll('.syntax-number')].map(node => node.textContent)).toContain('-1.2D-9');
});


test('external target navigation supersedes a queued scroll request', async () => {
    const api = transport(viewState());
    let notify!: (value: LargeFileViewerState) => void;
    api.onStateChanged = handler => { notify = handler; return () => undefined; };
    const { container } = render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    vi.useFakeTimers();
    try {
        fireEvent.wheel(container.querySelector('.viewport')!, { deltaY: 40, cancelable: true });
        await act(async () => notify(viewState({ revision: 5, anchorLine: 300,
            navigationTarget: { line: 304, startColumn: 0, endColumn: 10 },
            lines: [{ lineNumber: 300, text: '*PART', fields: [], keyword: true, truncated: false }] })));
        await act(async () => { await vi.advanceTimersByTimeAsync(70); });
        expect(api.navigate).not.toHaveBeenCalled();
        expect(screen.getByRole('status')).toHaveTextContent('行 301 /');
    } finally { vi.useRealTimers(); }
});

test('coalesces wheel requests while a window is being fetched', async () => {
    const api = transport(viewState());
    let finish!: (accepted: boolean) => void;
    api.navigate = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const { container } = render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    vi.useFakeTimers();
    try {
        fireEvent.wheel(container.querySelector('.viewport')!, { deltaY: 40, cancelable: true });
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        fireEvent.wheel(container.querySelector('.viewport')!, { deltaY: 40, cancelable: true });
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        expect(api.navigate).toHaveBeenCalledTimes(1);
        await act(async () => { finish(true); });
        await act(async () => { await vi.advanceTimersByTimeAsync(20); });
        expect(api.navigate).toHaveBeenLastCalledWith(4, 104);
    } finally { vi.useRealTimers(); }
});


test('keeps keyword context inside the status strip and hides the unused help panel', async () => {
    const { container } = render(<LargeFileViewerApp transport={transport(viewState())} />);
    await screen.findByDisplayValue('101');
    expect(container.querySelector('.field-help')).toBeNull();
    expect(container.querySelector('.status .sticky-header')).toHaveTextContent('*PART');
    expect(container.querySelector('.read-only')).toHaveTextContent('只读');
    expect(container.querySelector('.read-only')).toHaveAttribute('aria-label', '只读查看；不能在此修改文件。');
});


test('shares the input between keyword and text modes with Enter and Shift+Enter navigation', async () => {
    const api = transport(viewState());
    render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    expect(screen.getByRole('button', {name:'关键字模式；切换全文查找'})).toHaveAttribute('aria-pressed', 'true');
    const input = screen.getByRole('textbox', {name:'关键字'});
    await userEvent.type(input, '*MAT{Enter}');
    expect(api.navigateKeyword).toHaveBeenLastCalledWith(4, 1, '*MAT');
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(api.navigateKeyword).toHaveBeenLastCalledWith(4, -1, '*MAT');
    expect(api.search).not.toHaveBeenCalledWith(4, '*MAT');
    expect(document.querySelector('.search-mode .codicon')).toHaveClass('codicon-symbol-keyword');
    await userEvent.keyboard('{Control>}f{/Control}');
    expect(screen.getByRole('textbox', {name:'搜索'})).toHaveValue('*MAT');
    expect(document.querySelector('.search-mode .codicon')).toHaveClass('codicon-search');
});


test('marks a buffered line jump and retains its input after focus leaves the form', async () => {
    const api = transport(viewState({lineCount:500, lines:Array.from({length:300},(_,i)=>({lineNumber:i,text:'record '+i,fields:[],keyword:false,truncated:false}))}));
    render(<LargeFileViewerApp transport={api} />);
    const input = await screen.findByDisplayValue('101');
    await userEvent.clear(input);
    await userEvent.type(input,'151{Enter}');
    expect(document.querySelector('.navigation-line .line-number')).toHaveTextContent('151');
    await userEvent.click(screen.getByRole('textbox',{name:'关键字'}));
    expect(input).toHaveValue('151');
    expect(api.navigate).not.toHaveBeenCalled();
});


test('shows keyword progress inside the input and removes it when the query changes', async () => {
    const api = transport(viewState({keywordSearch:{query:'',count:23,currentIndex:22}}));
    render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    expect(document.querySelector('.search-input .search-count')).toHaveTextContent('23 / 23');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox',{name:'关键字'}),'missing');
    expect(document.querySelector('.search-count')).not.toBeInTheDocument();
});


test('updates wheel bounds after a larger file reload with the same capped scroll height', async () => {
    const rows = (start: number) => Array.from({length:300},(_,i)=>({lineNumber:start+i,text:'record',fields:[],keyword:false,truncated:false}));
    const api = transport(viewState({lineCount:600000,anchorLine:500000,lines:rows(499950)}));
    let notify!: (value: LargeFileViewerState) => void;
    api.onStateChanged = handler => { notify=handler; return ()=>{}; };
    render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('500001');
    await act(async()=>notify(viewState({revision:5,lineCount:700000,anchorLine:650000,lines:rows(649950)})));
    fireEvent.wheel(document.querySelector('.viewport')!,{deltaY:20});
    expect(document.querySelector('.line-number')).toHaveTextContent('650002');
});

test('treats no matches as neutral feedback while retaining the stale-file recovery warning', async () => {
    const initial = viewState();
    initial.search.message = '没有匹配项';
    const { unmount } = render(<LargeFileViewerApp transport={transport(initial)} />);
    expect(await screen.findByText('没有匹配项')).toBeVisible();
    expect(document.querySelector('.status')).not.toHaveClass('warning');
    unmount();
    render(<LargeFileViewerApp transport={transport({ ...initial, stale: true })} />);
    expect(await screen.findByRole('button', { name: '重新加载' })).toBeEnabled();
    expect(document.querySelector('.status')).toHaveClass('warning');
});
