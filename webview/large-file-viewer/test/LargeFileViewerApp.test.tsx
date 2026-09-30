import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LargeFileViewerApp } from '../src/LargeFileViewerApp';
import type { LargeFileViewerState } from '../../../src/client/largeFileViewerProtocol';
import type { LargeFileViewerTransport } from '../src/transport';

function viewState(overrides: Partial<LargeFileViewerState> = {}): LargeFileViewerState {
    return {
        revision: 4,
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
            search: '搜索', reload: '重新加载', indexing: '索引中', stale: '已失效',
            truncatedLine: '截断', english: '原文', queryObject: '对象引用', noField: '选择字段',
        },
        ...overrides,
    };
}

function transport(initial: LargeFileViewerState): LargeFileViewerTransport {
    return {
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
    expect(document.querySelector('[style*="5385293"]')).not.toBeInTheDocument();
});
