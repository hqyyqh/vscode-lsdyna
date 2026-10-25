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
            openNative: '在文本编辑器中打开',
            goto: '跳转', line: '行', keyword: '关键字', previous: '上一个', next: '下一个',
            textMode: '全文查找模式；切换关键字', keywordMode: '关键字模式；切换全文查找', searchHint: '全文查找提示', clearSearch: '清除查找', searchText: '全文查找', searching: '查找中…', matchLines: '匹配行', keywordHint: '关键字跳转提示', gotoHint: '行号跳转提示', search: '搜索', reload: '重新加载', indexing: '索引中', stale: '已失效',
            truncatedLine: '截断', fieldHelp: '字段说明', english: '原文', queryObject: '对象引用', noField: '选择字段',
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
        openNative: vi.fn(async () => true),
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
    expect(api.queryField).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
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

test.each(['submitted', 'superseded', 'stale', 'unmounted', 'keyword-keyboard'])('handles a %s text search when the mode reset notification arrives late', async outcome => {
    const api = transport(viewState());
    let notify!: (value: LargeFileViewerState) => void;
    let finishReset!: () => void;
    let hostRevision = 4;
    const acceptedQueries: string[] = [];
    api.onStateChanged = handler => { notify = handler; return () => undefined; };
    api.search = vi.fn(async (revision, query) => {
        if (revision !== hostRevision) return false;
        if (!query) {
            hostRevision++;
            await new Promise<void>(resolve => { finishReset = resolve; });
        } else acceptedQueries.push(query);
        return true;
    });
    const view = render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    fireEvent.click(document.querySelector('.search-mode')!);
    fireEvent.change(document.querySelector('.search-float input')!, { target: { value: 'B07_TARGET_MARKER' } });
    fireEvent.submit(document.querySelector('.search-float')!);
    if (outcome === 'superseded') {
        fireEvent.change(document.querySelector('.search-float input')!, { target: { value: 'LATEST_QUERY' } });
        fireEvent.submit(document.querySelector('.search-float')!);
    }
    if (outcome === 'unmounted') view.unmount();
    if (outcome === 'keyword-keyboard') {
        fireEvent.click(document.querySelector('.search-mode')!);
        fireEvent.change(document.querySelector('.search-float input')!, { target: { value: '*MAT' } });
        fireEvent.keyDown(document.querySelector('.search-float input')!, { key: 'Enter', shiftKey: true });
        expect(api.navigateKeyword).not.toHaveBeenCalled();
    }
    await act(async () => {
        notify(viewState({ revision: 5, stale: outcome === 'stale' }));
        finishReset();
    });
    expect(acceptedQueries).toEqual(outcome === 'submitted' ? ['B07_TARGET_MARKER'] : outcome === 'superseded' ? ['LATEST_QUERY'] : []);
    if (outcome === 'keyword-keyboard') expect(api.navigateKeyword).toHaveBeenCalledWith(5, -1, '*MAT');
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

test('shows field help immediately with the manager language and collapse controls', async () => {
    const api = transport(viewState({ selectedField: { token: 'mid-token', label: 'MID', value: '7',
        keyword: '*PART', cardIndex: 1, localizedHelp: '材料编号', englishHelp: 'Material identifier', type: 'integer',
        defaultValue: '', choices: [], queryable: true, object: { kind: 'material', kindLabel: '材料', id: '7', name: 'Steel' } } }));
    render(<LargeFileViewerApp transport={api} />);
    expect(await screen.findByText('材料 7')).toBeInTheDocument();
    expect(screen.getByText('Steel')).toHaveAttribute('title', '当前文件中的对象名称');
    expect(screen.getByText('材料编号')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '切换至英文' }));
    expect(screen.getByText('Material identifier')).toBeVisible();
    expect(screen.queryByText('材料编号')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '切换至中文' }));
    expect(screen.getByText('材料编号')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '收起字段说明' }));
    expect(screen.getByText('材料编号')).not.toBeVisible();
    expect(screen.getByRole('button', { name: '展开字段说明' })).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(screen.getByRole('button', { name: '字段说明' }));
    expect(screen.getByRole('button', { name: '收起字段说明' })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: '对象引用' }));
    expect(api.queryField).toHaveBeenCalledWith(4, 'mid-token');
});

test('keeps language preference across field selection while falling back to the available help', async () => {
    const selectedField = { token: 'mid-token', label: 'MID', value: '7', keyword: '*PART', cardIndex: 1,
        localizedHelp: '材料编号', englishHelp: 'Material identifier', type: 'integer', defaultValue: '', choices: [], queryable: true };
    const initial = viewState({ selectedField });
    const api = transport(initial);
    let notify!: (state: LargeFileViewerState) => void;
    api.onStateChanged = handler => { notify = handler; return () => undefined; };
    render(<LargeFileViewerApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '切换至英文' }));
    const body = document.querySelector('.field-help .detailViewport')!;
    body.scrollTop = 100;
    await act(async () => notify({ ...initial, revision: 5, selectedField: { ...selectedField,
        token: 'ro-token', label: 'RO', localizedHelp: '质量密度', englishHelp: '' } }));
    expect(screen.getByText('质量密度')).toBeVisible();
    expect(screen.queryByRole('button', { name: /切换至/ })).not.toBeInTheDocument();
    expect(body.scrollTop).toBe(0);
    await act(async () => notify({ ...initial, revision: 6 }));
    expect(screen.getByText('Material identifier')).toBeVisible();
});

test.each([
    ['en', 'Chinese description', 'Material identifier\nEQ.0: Unassigned', 'Material identifier', 'Collapse field help'],
    ['zh', '', 'Material identifier\nEQ.0: Unassigned', 'Material identifier', '收起字段说明'],
    ['zh', '', '', '暂无字段说明。', '收起字段说明'],
    ['en', '', '', 'No field description is available.', 'Collapse field help'],
] as const)('renders %s help, metadata and empty help without an unnecessary language toggle', async (locale, localizedHelp, englishHelp, description, collapse) => {
    const state = viewState({ locale, selectedField: { token: 'mid-token', label: 'MID', value: '-7',
        keyword: '*PART', cardIndex: 1, localizedHelp, englishHelp, type: 'integer',
        defaultValue: '0', choices: ['0', '-7'], queryable: false } });
    state.labels.fieldHelp = locale === 'zh' ? '字段说明' : 'Field help';
    render(<LargeFileViewerApp transport={transport(state)} />);
    expect(await screen.findByText(description)).toBeVisible();
    expect(screen.getByText('0, -7', { selector: 'code' })).toBeVisible();
    expect(document.querySelector('.helpMeta')).toHaveTextContent(locale === 'zh' ? '默认值0' : 'Default0');
    expect(screen.queryByRole('button', { name: /切换至/ })).not.toBeInTheDocument();
    if (englishHelp) expect(screen.getByText('EQ.0: Unassigned')).toBeVisible();
    const button = screen.getByRole('button', { name: collapse });
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText(description)).not.toBeVisible();
    expect(button).toHaveFocus();
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
    expect(screen.queryByLabelText('只读查看；不能在此修改文件。')).not.toBeInTheDocument();
    expect(document.querySelector('main')).toHaveAttribute('lang', 'zh');
    expect(screen.getByText(/卡片 1/)).toBeInTheDocument();
    expect(document.querySelector('.helpMeta')).toHaveTextContent('默认值0');
});

test('renders a bounded no-wrap window and sends opaque field tokens', async () => {
    const api = transport(viewState());
    render(<LargeFileViewerApp transport={api} />);
    const field = await screen.findByRole('button', { name: '2000101' });
    await userEvent.click(field);
    expect(api.selectField).toHaveBeenCalledWith(4, 'mid-token');
    await userEvent.dblClick(field);
    expect(api.queryField).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
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
    expect(container.querySelector('.read-only')).toBeNull();
    expect(container.querySelector('.record-edit')).toBeNull();
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


test('opens the current field through a single icon and supplies native context targets', async () => {
    const api = transport(viewState({ viewer: 'session' }));
    render(<LargeFileViewerApp transport={api} />);
    const button = await screen.findByRole('button', { name: '在文本编辑器中打开' });
    expect(button.textContent).toBe('');
    expect(document.querySelector('.record-edit,textarea')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /2000101/ }));
    await userEvent.click(button);
    expect(api.openNative).toHaveBeenLastCalledWith(4, 100, 'mid-token');
    const field = document.querySelector('.field')!;
    expect(JSON.parse(field.getAttribute('data-vscode-context')!)).toMatchObject({ viewer: 'session', revision: 4, line: 100, token: 'mid-token', webviewSection: 'largeFileRecord' });
    fireEvent.click(document.querySelector('.line-number')!);
    await userEvent.click(button);
    expect(api.openNative).toHaveBeenLastCalledWith(4, 100, undefined);
});

test('disables native navigation for stale content', async () => {
    render(<LargeFileViewerApp transport={transport(viewState({ stale: true }))} />);
    expect(await screen.findByRole('button', { name: '在文本编辑器中打开' })).toBeDisabled();
});

test('copies visible source text across fields and rows without gutters or truncation markers', async () => {
    const state = viewState({ lines: [
        viewState().lines[0],
        { lineNumber: 101, text: '', fields: [], keyword: false, truncated: false },
        { lineNumber: 102, text: '  &density', fields: [], keyword: false, truncated: true },
    ] });
    render(<LargeFileViewerApp transport={transport(state)} />);
    await screen.findByDisplayValue('101');
    const rows = document.querySelectorAll('.line-text');
    const range = document.createRange();
    range.setStart(rows[0].firstChild!, 2);
    range.setEndAfter(rows[2]);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const setData = vi.fn();
    fireEvent.copy(document.querySelector('.viewport')!, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', state.lines[0].text.slice(2) + '\n\n  &density');
    selection.removeAllRanges();
});

test.each([false, true])('offers copy targets only for complete current rows (stale=%s)', async stale => {
    render(<LargeFileViewerApp transport={transport(viewState({ stale, lines: [
        viewState().lines[0], { lineNumber: 101, text: 'prefix', fields: [], keyword: false, truncated: true },
    ] }))} />);
    await screen.findByDisplayValue('101');
    const context = (selector: string) => JSON.parse(document.querySelector(selector)!.getAttribute('data-vscode-context')!);
    expect(context('.field')).toMatchObject({ largeFileCanCopy: !stale, largeFileField: true, token: 'mid-token' });
    expect(context('.line')).toMatchObject({ largeFileCanCopy: !stale, largeFileField: false });
    expect(context('.line:last-child').largeFileCanCopy).toBe(false);
    expect(context('.line').preventDefaultContextMenuItems).toBe(true);
    expect(context('.field').preventDefaultContextMenuItems).toBe(true);
});

test('copies a partial field text selection and leaves an empty selection alone', async () => {
    render(<LargeFileViewerApp transport={transport(viewState())} />);
    await screen.findByDisplayValue('101');
    const text = document.querySelector('.field .syntax-number')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const setData = vi.fn();
    fireEvent.copy(document.querySelector('.viewport')!, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', '0001');
    selection.removeAllRanges();
    setData.mockClear();
    fireEvent.copy(document.querySelector('.viewport')!, { clipboardData: { setData } });
    expect(setData).not.toHaveBeenCalled();
});

test('copies the highlighted field on Ctrl+C and gives a text selection priority', async () => {
    const initial = viewState();
    const api = transport(initial);
    let notify!: (state: LargeFileViewerState) => void;
    api.onStateChanged = handler => { notify = handler; return () => undefined; };
    render(<LargeFileViewerApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '2000101' }));
    await act(async () => notify({ ...initial, revision: 5, selectedField: {
        token: 'mid-token', label: 'MID', value: '2000101', keyword: '*PART', cardIndex: 1,
        localizedHelp: '', englishHelp: '', type: '', defaultValue: '', choices: [], queryable: true,
    } }));
    const field = document.querySelector('.field.selected')!;
    const setData = vi.fn();
    window.getSelection()!.removeAllRanges();
    fireEvent.copy(field, { clipboardData: { setData } });
    expect(setData).toHaveBeenLastCalledWith('text/plain', '2000101');
    const text = field.querySelector('.syntax-number')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 1); range.setEnd(text, 5);
    window.getSelection()!.addRange(range);
    fireEvent.copy(field, { clipboardData: { setData } });
    expect(setData).toHaveBeenLastCalledWith('text/plain', '0001');
    window.getSelection()!.removeAllRanges();
    for (const next of [
        { ...initial, revision: 6, stale: true },
        { ...initial, revision: 7, lines: [{ ...initial.lines[0], truncated: true }] },
        { ...initial, revision: 8, anchorLine: 101, lines: [initial.lines[0], { lineNumber: 101, text: '*END', fields: [], keyword: true, truncated: false }] },
    ]) {
        await act(async () => notify({ ...next, selectedField: {
            token: 'mid-token', label: 'MID', value: '2000101', keyword: '*PART', cardIndex: 1,
            localizedHelp: '', englishHelp: '', type: '', defaultValue: '', choices: [], queryable: true,
        } }));
        setData.mockClear();
        fireEvent.copy(document.querySelector('.viewport')!, { clipboardData: { setData } });
        expect(setData).not.toHaveBeenCalled();
    }
});

test('a new line jump supersedes a previously clicked field', async () => {
    const api = transport(viewState({ lines: [viewState().lines[0], { lineNumber: 101, text: '*END', fields: [], keyword: true, truncated: false }] }));
    render(<LargeFileViewerApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: /2000101/ }));
    fireEvent.change(document.querySelector('.goto input')!, { target: { value: '102' } });
    fireEvent.submit(document.querySelector('.goto')!);
    await userEvent.click(screen.getByRole('button', { name: '在文本编辑器中打开' }));
    expect(api.openNative).toHaveBeenLastCalledWith(4, 101, undefined);
});


test('scrolls and pages during indexing, reports byte progress and keeps full search unavailable', async () => {
    const initial = viewState({ indexing: 'loading', lineCount: undefined, availableLineCount: 500,
        fileSize: 10000, scannedBytes: 3700 });
    const api = transport(initial);
    let notify!: (state: LargeFileViewerState) => void;
    api.onStateChanged = handler => { notify = handler; return () => undefined; };
    render(<LargeFileViewerApp transport={api} />);
    await screen.findByDisplayValue('101');
    expect(screen.getByRole('status')).toHaveTextContent('37%');
    expect(screen.getByRole('button', { name: '跳转' })).toBeDisabled();
    const viewport = document.querySelector('.viewport') as HTMLElement;
    vi.useFakeTimers();
    try {
        fireEvent.wheel(viewport, { deltaY: 40, cancelable: true });
        await act(async () => { await vi.advanceTimersByTimeAsync(70); });
        expect(api.navigate).toHaveBeenLastCalledWith(4, 102);
        await act(async () => { fireEvent.keyDown(viewport, { key: 'PageDown' }); await vi.advanceTimersByTimeAsync(16); });
        expect(api.navigate).toHaveBeenLastCalledWith(4, 116);
        await act(async () => notify({ ...initial, revision: 5, scannedBytes: 4800, availableLineCount: 900 }));
        expect(screen.getByRole('status')).toHaveTextContent('48%');
        fireEvent.submit(document.querySelector('.goto')!);
        fireEvent.submit(document.querySelector('.search-float')!);
        expect(api.search).not.toHaveBeenCalled();
        expect(api.navigateKeyword).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
});


test.each([[0, '索引中 0%'], [1, '索引中 <1%'], [10000, '正在完成索引…']])('shows honest progress for %i scanned bytes', async (scannedBytes, text) => {
    const state = viewState({ indexing:'loading',fileSize:10000,scannedBytes });
    state.labels.indexingFinishing='正在完成索引…';
    render(<LargeFileViewerApp transport={transport(state)} />);
    await screen.findByDisplayValue('101');
    expect(screen.getByRole('status')).toHaveTextContent(text);
});


test('merges same-window progress without replacing row actions, focus or position', async () => {
    const initial=viewState({indexing:'loading',scannedBytes:3700,fileSize:10000});
    const api=transport(initial);
    let notify!: (state:LargeFileViewerState)=>void;
    api.onStateChanged=handler=>{notify=handler;return()=>undefined;};
    render(<LargeFileViewerApp transport={api} />);
    const input=await screen.findByDisplayValue('101');
    input.focus();
    await act(async()=>notify({...initial,scannedBytes:4800,anchorLine:0,lines:[]}));
    expect(screen.getByRole('status')).toHaveTextContent('48%');
    expect(input).toHaveValue('101');
    expect(input).toHaveFocus();
    expect(document.querySelector('.field')).toBeInTheDocument();
    await act(async()=>notify({...initial,scannedBytes:4000}));
    expect(screen.getByRole('status')).toHaveTextContent('48%');
});
