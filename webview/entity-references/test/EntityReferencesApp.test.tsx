import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityReferencesApp } from '../src/EntityReferencesApp';
import type { EntityReferencesTransport } from '../src/transport';
import type { EntityReferencesViewState } from '../../../src/client/entityReferencesProtocol';

function state(overrides: Partial<EntityReferencesViewState> = {}): EntityReferencesViewState {
    return {
        locale: 'zh', revision: 3, following: true,
        input: { targetKind: 'curve', id: '', scopePreference: 'auto' },
        kindOptions: [
            { value: 'curve', label: '曲线 *DEFINE_CURVE' },
            { value: 'material', label: '材料 *MAT' },
        ],
        scope: { selected: 'file', fileAvailable: true, projectAvailable: true,
            fileLabel: 'part.k', projectLabel: 'main.k' },
        status: 'empty', activeSession: null, definitions: [], references: [],
        hasMoreDefinitions: false, hasMoreReferences: false, reasons: [], pinnedSessions: [], message: '',
        labels: {
            search: '查找对象', follow: '跟随光标', resumeFollow: '继续跟随', fixed: '已固定', unconfirmed: '待确认',
            zeroResults: '未找到匹配位置。', definitionsNotConfirmed: '暂未确认定义位置。', referencesNotConfirmed: '暂未确认引用位置。',
            id: 'ID', query: '查询', infer: '从光标获取', file: '当前文件', project: 'Include 工程',
            empty: '请输入对象', definitions: '定义', references: '引用', loadMore: '加载更多',
            pin: '固定查询', unpin: '取消固定', pinned: '已固定查询', remove: '移除', clear: '清除查询',
            openSide: '在侧边打开', details: '技术详情', partial: '部分结果', loading: '正在查询',
            missing: '没有结果', invalid: '请输入有效 ID',
            openLargeFile: '在大文件视图中打开', modify: '修改',
            objectType: 'Object type', scope: '查询范围', refresh: '刷新', retry: '重试',
            stale: '结果已失效，请刷新。', 'needs-refresh': '结果需要重新加载，请刷新。',
            incomplete: '查询未完成，可重试。', pageCount: '已显示 {0} / {1}',
            partialPageCount: '已显示 {0}，已找到 {1}',
        },
        ...overrides,
    };
}

function transport(initial: EntityReferencesViewState) {
    let stateHandler: ((value: EntityReferencesViewState) => void) | null = null;
    let focusHandler: (() => void) | null = null;
    const api: EntityReferencesTransport = {
        ready: async () => initial,
        search: vi.fn(async () => true), setScope: vi.fn(async () => true), toggleFollow: vi.fn(async () => true),
        query: vi.fn(async () => true), infer: vi.fn(async () => true), refresh: vi.fn(async () => true),
        loadMore: vi.fn(async () => true), togglePin: vi.fn(async () => true),
        selectSession: vi.fn(async () => true), removeSession: vi.fn(async () => true),
        clear: vi.fn(async () => true), open: vi.fn(async () => true),
        openLargeFile: vi.fn(async () => true),
        onStateChanged(handler) { stateHandler = handler; return () => { stateHandler = null; }; },
        onFocus(handler) { focusHandler = handler; return () => { focusHandler = null; }; },
    };
    return { api, publish: (next: EntityReferencesViewState) => stateHandler?.(next),
        focus: () => focusHandler?.() };
}

function resultState(status: EntityReferencesViewState['status'] = 'ready'): EntityReferencesViewState {
    return state({
        status,
        input: { targetKind: 'curve', id: '1000001', scopePreference: 'project' },
        scope: { selected: 'project', fileAvailable: true, projectAvailable: true,
            fileLabel: 'wall2.key', projectLabel: 'rogue-v3.key' },
        activeSession: { key: 'session', label: '曲线 *DEFINE_CURVE · 1000001', state: status,
            pinned: false, active: true, definitionCount: 1, referenceCount: 1 },
        definitions: [{ locationId: 'definition-token', role: 'definition', label: '*DEFINE_CURVE / ID',
            description: 'wall2.key:8', detail: 'D:/model/wall2.key:8' }],
        references: [{ locationId: 'reference-token', role: 'reference', label: '*LOAD_CURVE / LCID',
            description: 'main.key:20', detail: 'D:/model/main.key:20' }],
    });
}

test('offers search and cursor following without a permanent query form', async () => {
    const { api } = transport(state());
    render(<EntityReferencesApp transport={api} />);
    expect(await screen.findByRole('button', { name: '查找对象' })).toBeVisible();
    expect(screen.getByRole('button', { name: '跟随光标' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Object type' })).not.toBeInTheDocument();
});

test.each(['ready', 'partial', 'missing', 'incomplete'] as const)(
    'keeps search and scope available for %s results', async status => {
        const { api } = transport(resultState(status));
        render(<EntityReferencesApp transport={api} />);
        expect(await screen.findByRole('button', { name: '查找对象' })).toBeVisible();
        expect(screen.getByRole('combobox', { name: '查询范围' })).toHaveValue('project');
        expect(screen.queryByRole('button', { name: '修改' })).not.toBeInTheDocument();
    },
);

test('opens native search and keeps result navigation available', async () => {
    const { api } = transport(resultState());
    render(<EntityReferencesApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '查找对象' }));
    expect(api.search).toHaveBeenCalledWith(3);

    await userEvent.click(screen.getByRole('button', { name: /\*LOAD_CURVE/ }));
    expect(api.open).toHaveBeenCalledWith(3, 'reference-token', false);
    expect(screen.getByRole('button', { name: '查找对象' })).toBeVisible();
});

test.each(['ready', 'partial'] as const)('keeps %s results visually stable during navigation', async status => {
    const t = transport(resultState(status));
    let finish!: (value: boolean) => void;
    vi.mocked(t.api.open).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<EntityReferencesApp transport={t.api} />);
    const row = await screen.findByRole('button', { name: /\*LOAD_CURVE/ });
    const statusBefore = screen.queryByRole('status')?.textContent;
    await userEvent.click(row);
    expect(row).toBeEnabled();
    expect(row.closest('.results')).not.toHaveClass('unavailable');
    expect(screen.queryByRole('status')?.textContent).toBe(statusBefore);
    expect(screen.queryByText('正在处理…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '刷新' })).not.toBeInTheDocument();

    await userEvent.click(row);
    expect(t.api.open).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
    expect(screen.getByRole('button', { name: /\*LOAD_CURVE/ })).toBe(row);
});

test('collapses result groups independently and preserves the choice across state updates', async () => {
    const t = transport(resultState());
    render(<EntityReferencesApp transport={t.api} />);
    const definitions = await screen.findByRole('button', { name: '定义 1' });
    const definition = screen.getByRole('button', { name: /\*DEFINE_CURVE/ });
    await userEvent.click(definitions);
    expect(definitions).toHaveAttribute('aria-expanded', 'false');
    expect(definition).not.toBeVisible();
    expect(screen.getByRole('button', { name: /\*LOAD_CURVE/ })).toBeVisible();
    act(() => t.publish({ ...resultState(), revision: 4 }));
    expect(definition).not.toBeVisible();
    definitions.focus();
    await userEvent.keyboard('{Enter}');
    expect(definitions).toHaveAttribute('aria-expanded', 'true');
    expect(definition).toBeVisible();
});

test('keeps the pin action with the active result identity', async () => {
    const { api } = transport(resultState());
    render(<EntityReferencesApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '固定查询' }));
    expect(api.togglePin).toHaveBeenCalledWith(3, 'session');
    expect(screen.getByRole('button', { name: '固定查询' }).closest('header')).not.toBeNull();
});

test('allows pausing and resuming cursor following', async () => {
    const t = transport(state());
    render(<EntityReferencesApp transport={t.api} />);
    await userEvent.click(await screen.findByRole('button', { name: '跟随光标' }));
    expect(t.api.toggleFollow).toHaveBeenCalledWith(3);
    act(() => t.publish(state({ revision: 4, following: false })));
    await userEvent.click(screen.getByRole('button', { name: '跟随光标' }));
    expect(t.api.toggleFollow).toHaveBeenLastCalledWith(4);
});

test('applies a scope choice immediately without requiring a query button', async () => {
    const { api } = transport(state());
    render(<EntityReferencesApp transport={api} />);
    const project = await screen.findByRole('combobox', { name: '查询范围' });
    await userEvent.selectOptions(project, 'project');
    expect(api.setScope).toHaveBeenCalledWith(3, 'project');
});

test('does not allow unavailable project scope', async () => {
    const initial = state();
    initial.scope.projectAvailable = false;
    const { api } = transport(initial);
    render(<EntityReferencesApp transport={api} />);
    const scope = await screen.findByRole('combobox', { name: '查询范围' });
    await userEvent.selectOptions(scope, 'project');
    expect(api.setScope).not.toHaveBeenCalled();
});

test('renders verified partial locations, paging, and safe open actions', async () => {
    const partial = state({
        status: 'partial',
        input: { targetKind: 'curve', id: '1000001', scopePreference: 'project' },
        scope: { selected: 'project', fileAvailable: true, projectAvailable: true,
            fileLabel: 'wall2.key', projectLabel: 'rogue-v3.key' },
        activeSession: { key: 'session', label: '曲线 *DEFINE_CURVE 1000001', state: 'partial',
            pinned: false, active: true, definitionCount: 1, referenceCount: 101 },
        definitions: [{ locationId: 'definition-token', role: 'definition', label: '*DEFINE_CURVE / ID',
            description: 'wall2.key:8', detail: 'D:/model/wall2.key:8' }],
        references: [{ locationId: 'reference-token', role: 'reference', label: '*LOAD_CURVE / LCID',
            description: 'main.key:20', detail: 'D:/model/main.key:20' }],
        hasMoreReferences: true,
        reasons: ['main.key:registry-reference-preview-byte-limit'],
    });
    const { api } = transport(partial);
    render(<EntityReferencesApp transport={api} />);
    expect(await screen.findByText('部分结果')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '引用 101' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /\*LOAD_CURVE/ }));
    expect(api.open).toHaveBeenCalledWith(3, 'reference-token', false);
    await userEvent.click(screen.getAllByRole('button', { name: '在侧边打开' })[1]);
    expect(api.open).toHaveBeenCalledWith(3, 'reference-token', true);
    await userEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(api.loadMore).toHaveBeenCalledWith(3, 'reference');
});

test('offers the readonly viewer when VS Code cannot synchronize a large file', async () => {
    const offered = state({
        largeFileOffer: { token: 'large-token', fileName: 'rogue-v3.key', reason: '文件超过 50 MiB 限制' },
    });
    const { api } = transport(offered);
    render(<EntityReferencesApp transport={api} />);
    expect(await screen.findByText('文件超过 50 MiB 限制')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '在大文件视图中打开' }));
    expect(api.openLargeFile).toHaveBeenCalledWith(3, 'large-token');
});

test('renders structured keyword and field labels without parsing legacy labels', async () => {
    const initial = resultState();
    initial.references[0] = { ...initial.references[0], keyword: '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
        fieldName: 'SSID', label: '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE / SSID' };
    render(<EntityReferencesApp transport={transport(initial).api} />);
    const field = await screen.findByText('SSID');
    expect(field).toHaveClass('result-field');
    expect(screen.getByTitle('*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE')).toHaveClass('result-keyword');
    expect(screen.getByText('*DEFINE_CURVE / ID')).toBeVisible();
});

test.each(['stale', 'needs-refresh', 'incomplete'] as const)('explains %s and disables old locations', async status => {
    const initial = resultState(status);
    initial.reasons = ['internal-error-code'];
    const { api } = transport(initial);
    render(<EntityReferencesApp transport={api} />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(initial.labels[status]));
    expect(screen.getByRole('status')).not.toHaveTextContent('internal-error-code');
    expect(screen.queryByText('技术详情')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /\*LOAD_CURVE/ })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: '在侧边打开' })[0]).toBeDisabled();
    expect(screen.queryByRole('button', { name: /刷新|重试/ })).not.toBeInTheDocument();
});

test('exposes icon names and pin state to keyboard users', async () => {
    const initial = resultState();
    initial.activeSession!.pinned = true;
    const { api } = transport(initial);
    render(<EntityReferencesApp transport={api} />);
    const pin = await screen.findByRole('button', { name: '取消固定' });
    expect(pin).toHaveAttribute('aria-pressed', 'true');
    expect(pin.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    pin.focus();
    await userEvent.keyboard('{Enter}');
    expect(api.togglePin).toHaveBeenCalledWith(3, 'session');
    expect(pin.closest('header')).not.toBeNull();
    expect(screen.getByRole('button', { name: '已固定' })).toBeDisabled();
});

test.each(['ready', 'partial'] as const)('describes pagination accurately for %s', async status => {
    const initial = resultState(status);
    initial.activeSession!.referenceCount = 128;
    initial.hasMoreReferences = true;
    render(<EntityReferencesApp transport={transport(initial).api} />);
    expect(await screen.findByText(status === 'partial' ? '已显示 1，已找到 128' : '已显示 1 / 128')).toBeVisible();
    expect(screen.getByRole('button', { name: '加载更多' })).toBeEnabled();
});

test('shows the source basename and keeps the full path in a tooltip', async () => {
    const initial = resultState();
    initial.activeSession = { ...initial.activeSession!, scopeLabel: 'Include 工程', scopePath: 'D:/models/main.k' };
    const t = transport(initial);
    render(<EntityReferencesApp transport={t.api} />);
    expect(await screen.findByText('main.k')).toHaveAttribute('title', 'D:/models/main.k');
    expect(screen.queryByText('当前结果')).not.toBeInTheDocument();
    expect(screen.queryByText('Include 工程 · D:/models/main.k')).not.toBeInTheDocument();
});

test.each(['ready', 'partial', 'stale'] as const)('preserves zero groups without overstating completeness: %s', async status => {
    const initial = resultState(status);
    initial.definitions = [];
    initial.activeSession = { ...initial.activeSession!, definitionCount: 0 };
    render(<EntityReferencesApp transport={transport(initial).api} />);
    expect(await screen.findByRole('heading', { name: status === 'ready' ? '定义 0' : '定义' })).toBeVisible();
    expect(screen.getByText(status === 'ready' ? initial.labels.zeroResults : initial.labels.definitionsNotConfirmed)).toBeVisible();
});

test.each([false, 'reject'] as const)('shows failed query feedback and unlocks retry: %s', async result => {
    const t = transport(resultState()); let finish!: (value: boolean) => void;
    if (result === false) vi.mocked(t.api.search).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    else vi.mocked(t.api.search).mockRejectedValueOnce(new Error('offline'));
    render(<EntityReferencesApp transport={t.api} />);
    const query = await screen.findByRole('button', { name: '查找对象' });
    await userEvent.click(query);
    if (result === false) {
        expect(query).toBeDisabled();
        await userEvent.click(query); expect(t.api.search).toHaveBeenCalledTimes(1);
        act(() => finish(false));
    }
    expect(await screen.findByRole('alert')).toHaveTextContent('操作未完成，请重试。');
    expect(query).toBeEnabled();
    await userEvent.click(query); expect(t.api.search).toHaveBeenCalledTimes(2);
});

test('recovers initialization and ignores an older ready response after live state', async () => {
    const t = transport(resultState()); let finish!: (value: EntityReferencesViewState) => void;
    vi.mocked(t.api.ready = vi.fn()).mockRejectedValueOnce(new Error('offline'))
        .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<EntityReferencesApp transport={t.api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The operation did not complete');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    act(() => t.publish({ ...resultState(), revision: 5, activeSession: { ...resultState().activeSession!, label: '材料 42' } }));
    act(() => finish(resultState()));
    expect(await screen.findByText('材料 42')).toBeVisible();
    expect(screen.queryByText('曲线 *DEFINE_CURVE · 1000001')).not.toBeInTheDocument();
});

test('shows ambiguous definitions without preventing navigation', async () => {
    const initial = resultState();
    initial.ambiguous = true;
    initial.labels.ambiguous = '找到多个候选定义，尚不能唯一确定对象。请核对各定义位置。';
    const t = transport(initial);
    render(<EntityReferencesApp transport={t.api} />);
    expect(await screen.findByText(initial.labels.ambiguous)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '*DEFINE_CURVE / ID, wall2.key:8' }));
    expect(t.api.open).toHaveBeenCalledWith(3, 'definition-token', false);
});

test.each(['zh', 'en'] as const)('omits diagnostic details and duplicate refresh in %s', async locale => {
    const initial = resultState('partial');
    initial.locale = locale;
    initial.reasons = ['lspp-link-code-target-noncanonical', 'lspp-link-code-target-unresolved (4 occurrences)', 'LsPrePost-unknown-failure', 'unmapped-internal-code'];
    const { api } = transport(initial);
    const { container } = render(<EntityReferencesApp transport={api} />);
    await screen.findByRole('button', { name: '查找对象' });
    expect(screen.queryByText('技术详情')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/lspp|lsprepost|unmapped-internal-code/i);
    expect(container.querySelector('details.technical')).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新' })).not.toBeInTheDocument();
});
