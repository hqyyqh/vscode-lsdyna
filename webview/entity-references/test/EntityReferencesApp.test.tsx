import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityReferencesApp } from '../src/EntityReferencesApp';
import type { EntityReferencesTransport } from '../src/transport';
import type { EntityReferencesViewState } from '../../../src/client/entityReferencesProtocol';
import { mergeEntityReferencePage } from '../src/mergeEntityReferencePage';

it('appends only to the matching revision and never replays or mixes an old page', () => {
    const location = (id: string) => ({ locationId: id, role: 'reference' as const,
        label: id, description: '', detail: '' });
    const initial = state({ references: [location('first')] });
    const page = state({ revision: 4, appendPage: { baseRevision: 3, role: 'reference' }, references: [location('second')] });
    const merged = mergeEntityReferencePage(initial, page)!;
    expect(merged.references.map(item => item.locationId)).toEqual(['first', 'second']);
    expect(mergeEntityReferencePage(merged, page)).toBe(merged);
    const changed = state({ revision: 5, references: [location('new query')] });
    expect(mergeEntityReferencePage(changed, page)).toBe(changed);
    expect(mergeEntityReferencePage(initial, { ...page, appendPage: { baseRevision: 2, role: 'reference' } })).toBe(initial);
});

function state(overrides: Partial<EntityReferencesViewState> = {}): EntityReferencesViewState {
    return {
        locale: 'zh', revision: 3, following: true,
        scope: { selected: 'file', fileAvailable: true, projectAvailable: true,
            fileLabel: 'part.k', projectLabel: 'main.k' },
        status: 'empty', activeSession: null, definitions: [], references: [],
        hasMoreDefinitions: false, hasMoreReferences: false, reasons: [], pinnedSessions: [], message: '',
        labels: {
            title: '对象引用', name: '名称', field: '字段', referenceLocationsTitle: '引用位置',
            noReferences: '在所选范围内未找到引用。', openLocation: '跳转到位置', openDefinition: '跳转到定义', referenceLocations: '{0} 个引用位置',
            search: '查找对象', follow: '跟随光标', resumeFollow: '继续跟随', fixed: '已固定', unconfirmed: '待确认',
            zeroResults: '未找到匹配位置。', definitionsNotConfirmed: '暂未确认定义位置。', referencesNotConfirmed: '暂未确认引用位置。',
            id: 'ID', query: '查询', infer: '从光标获取', file: '当前文件', project: '主文件及其引用文件',
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

test('keeps empty-view controls in the native title bar and preserves follow status', async () => {
    const { api } = transport(state());
    render(<EntityReferencesApp transport={api} />);
    expect(await screen.findByText('正在跟随光标')).toBeVisible();
    expect(screen.queryByRole('button', { name: '查找对象' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name:/选择主文件/})).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开启跟随光标' })).not.toBeInTheDocument();
    expect(screen.getByText('正在跟随光标')).toBeVisible();
});

test('shows the host failure instead of the empty hint and clears it on the next state', async () => {
    const t = transport(state({ following: false, message: '没有可用的查询来源。' }));
    render(<EntityReferencesApp transport={t.api} />);
    expect(await screen.findByText('没有可用的查询来源。')).toBeVisible();
    expect(screen.queryByText('请输入对象')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开启跟随光标' })).not.toBeInTheDocument();
    act(() => t.publish(state({ revision: 4 })));
    expect(screen.queryByText('没有可用的查询来源。')).not.toBeInTheDocument();
});

test.each(['ready', 'partial', 'missing', 'incomplete'] as const)(
    'keeps the active identity visible for %s results', async status => {
        const { api } = transport(resultState(status));
        render(<EntityReferencesApp transport={api} />);
        expect(await screen.findByText('曲线 *DEFINE_CURVE · 1000001', { exact: false })).toBeVisible();
        expect(screen.queryByRole('button', { name: '修改' })).not.toBeInTheDocument();
    },
);

test('opens result locations with the current revision', async () => {
    const { api } = transport(resultState());
    render(<EntityReferencesApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: /\*LOAD_CURVE/ }));
    expect(api.open).toHaveBeenCalledWith(3, 'reference-token', false);
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

test('keeps static result groups and keyboard navigation across state updates', async () => {
    const t = transport(resultState());
    render(<EntityReferencesApp transport={t.api} />);
    await screen.findByRole('heading', { name: '定义 1' });
    const definition = screen.getByRole('button', { name: /\*DEFINE_CURVE/ });
    expect(definition).toBeVisible();
    expect(screen.getByRole('button', { name: /\*LOAD_CURVE/ })).toBeVisible();
    act(() => t.publish({ ...resultState(), revision: 4 }));
    expect(screen.getByRole('button', { name: /\*DEFINE_CURVE/ })).toBe(definition);
    definition.focus();
    await userEvent.keyboard('{Enter}');
    expect(t.api.open).toHaveBeenCalledWith(4, 'definition-token', false);
});

test('focuses the results when the host asks to focus the view', async () => {
    const t = transport(state());
    render(<EntityReferencesApp transport={t.api} />);
    const main = await screen.findByRole('main');
    act(() => t.focus());
    await waitFor(() => expect(main).toHaveFocus());
});

test('renders verified partial locations, paging, and safe open actions', async () => {
    const partial = state({
        status: 'partial',
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
    expect(await screen.findByRole('heading', { name: /引用位置\s*1\+/ })).toBeInTheDocument();
    expect(screen.getByText('部分结果')).toBeVisible();
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
    expect(await screen.findByTitle('文件超过 50 MiB 限制')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '在大文件视图中打开' }));
    expect(api.openLargeFile).toHaveBeenCalledWith(3, 'large-token');
});

test('renders structured keyword and field labels without parsing legacy labels', async () => {
    const initial = resultState();
    initial.references[0] = { ...initial.references[0], keyword: '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
        fieldName: 'SSID', label: '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE / SSID' };
    render(<EntityReferencesApp transport={transport(initial).api} />);
    const field = await screen.findByText('SSID');
    expect(field).toHaveClass('result-badge');
    expect(screen.getByTitle('*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE')).toHaveClass('result-keyword');
    expect(screen.getByText('*DEFINE_CURVE / ID')).toBeVisible();
});

test.each(['stale', 'needs-refresh', 'incomplete'] as const)('explains %s and disables old locations', async status => {
    const initial = resultState(status);
    initial.reasonDetails = ['部分信息尚未确认，请核对相关文件内容。'];
    const { api } = transport(initial);
    render(<EntityReferencesApp transport={api} />);
    await screen.findByRole('main');
    expect(screen.getByRole('status')).toHaveTextContent(initial.labels[status]);
    expect(screen.queryByText('internal-error-code')).not.toBeInTheDocument();
    expect(screen.getByText('技术详情')).toBeVisible();
    expect(screen.getByRole('button', { name: /\*LOAD_CURVE/ })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: '在侧边打开' })[0]).toBeDisabled();
    expect(screen.queryByRole('button', { name: /刷新|重试/ })).not.toBeInTheDocument();
});

test('allows selecting and removing pinned sessions with the keyboard', async () => {
    const initial = resultState();
    initial.activeSession!.pinned = true;
    initial.pinnedSessions = [initial.activeSession!];
    const { api } = transport(initial);
    render(<EntityReferencesApp transport={api} />);
    const summary = await screen.findByText('已固定查询 (1)');
    expect(screen.getByText('已固定')).toHaveClass('result-badge');
    await userEvent.click(summary);
    const select = screen.getByRole('button', { name: initial.activeSession!.label });
    select.focus();
    await userEvent.keyboard('{Enter}');
    expect(api.selectSession).toHaveBeenCalledWith(3, 'session');
    const remove = screen.getByRole('button', { name: '移除' });
    expect(remove.querySelector('.codicon-close')).toBeInTheDocument();
    expect(remove.querySelector('.reference-icon')).toHaveAttribute('aria-hidden', 'true');
    remove.focus();
    await userEvent.keyboard('{Enter}');
    expect(api.removeSession).toHaveBeenCalledWith(3, 'session');
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
    initial.activeSession = { ...initial.activeSession!, scopeLabel: '主文件及其引用文件', scopePath: 'D:/models/main.k' };
    const t = transport(initial);
    render(<EntityReferencesApp transport={t.api} />);
    expect(await screen.findByText('main.k')).toHaveAttribute('title', 'D:/models/main.k');
    expect(screen.queryByText('当前结果')).not.toBeInTheDocument();
    expect(screen.queryByText('主文件及其引用文件 · D:/models/main.k')).not.toBeInTheDocument();
});

test.each(['ready', 'partial', 'stale', 'incomplete', 'missing'] as const)('distinguishes empty results from unfinished analysis: %s', async status => {
    const initial = resultState(status);
    initial.definitions = []; initial.references = [];
    initial.message = '';
    initial.activeSession = { ...initial.activeSession!, definitionCount: 0, referenceCount: 0 };
    render(<EntityReferencesApp transport={transport(initial).api} />);
    await screen.findByRole('main');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    if (status === 'ready') expect(screen.queryByRole('status')).not.toBeInTheDocument();
    else expect(screen.getByRole('status')).toHaveTextContent(initial.labels[status]);
    if (status !== 'missing') expect(screen.queryByText(initial.labels.missing)).not.toBeInTheDocument();
});

test('keeps the line number separate from a long file label in partial results', async () => {
    const initial = resultState('partial');
    initial.references[0] = { ...initial.references[0], fileLabel: 'vehicle_assembly_load_definitions.key', line: 242 };
    const { container } = render(<EntityReferencesApp transport={transport(initial).api} />);
    expect(await screen.findByText('vehicle_assembly_load_definitions.key')).toHaveClass('result-file');
    expect(screen.getByText(':242')).toHaveClass('result-line');
    expect(container.querySelector('.entity-group .count')).toHaveTextContent('1+');
    for (const button of screen.getAllByRole('button', { name: '在侧边打开' })) expect(button).toBeEnabled();
});

test('explains partial coverage while retaining confirmed positions', async () => {
    const initial = resultState('partial');
    initial.message = '查询未完成，可重试。';
    render(<EntityReferencesApp transport={transport(initial).api} />);
    await screen.findByRole('main');
    expect(screen.getByText(initial.message)).toBeVisible();
    expect(screen.getByText(initial.labels.partial)).toBeVisible();
    expect(screen.getByRole('heading', { name: /引用位置/ })).toBeVisible();
    expect(screen.queryByRole('heading', { name: /其他引用位置/ })).not.toBeInTheDocument();
});

test.each(['zh', 'en'] as const)('localizes complete target action names and side-action destinations in %s', async locale => {
    const initial = resultState();
    initial.locale = locale;
    initial.labels.openDefinition = locale === 'zh' ? '跳转到定义' : 'Go to definition';
    initial.labels.openSide = locale === 'zh' ? '在侧边打开' : 'Open to the Side';
    initial.activeSession = { ...initial.activeSession!, entityKindLabel: locale === 'zh' ? '曲线' : 'Curve', entityId: '3' };
    const t = transport(initial);
    render(<EntityReferencesApp transport={t.api} />);
    const definition = await screen.findByRole('button', { name: initial.labels.openDefinition });
    expect(screen.getByRole('main')).toHaveAttribute('lang', locale);
    expect(definition).toHaveAttribute('title', `${initial.labels.openDefinition}\n${initial.definitions[0].detail}`);
    await userEvent.click(definition);
    expect(t.api.open).toHaveBeenCalledWith(3, 'definition-token', false);
    const sides = screen.getAllByRole('button', { name: initial.labels.openSide });
    expect(sides[0]).toHaveAttribute('title', `${initial.labels.openSide}\n${initial.definitions[0].detail}`);
    expect(sides[1]).toHaveAttribute('title', `${initial.labels.openSide}\nD:/model/main.key:20`);
    expect(sides[1].querySelector('.codicon-split-horizontal')).toBeInTheDocument();
    expect(sides[1].querySelector('.reference-icon')).toHaveAttribute('aria-hidden', 'true');
    sides[1].focus(); await userEvent.keyboard('{Enter}');
    expect(t.api.open).toHaveBeenCalledWith(3, 'reference-token', true);
});

test.each([false, 'reject'] as const)('shows failed paging feedback and unlocks retry: %s', async result => {
    const t = transport(resultState()); let finish!: (value: boolean) => void;
    t.api.ready = async () => ({ ...resultState(), hasMoreReferences: true });
    if (result === false) vi.mocked(t.api.loadMore).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    else vi.mocked(t.api.loadMore).mockRejectedValueOnce(new Error('offline'));
    render(<EntityReferencesApp transport={t.api} />);
    const query = await screen.findByRole('button', { name: '加载更多' });
    await userEvent.click(query);
    if (result === false) {
        expect(query).toBeDisabled();
        await userEvent.click(query); expect(t.api.loadMore).toHaveBeenCalledTimes(1);
        act(() => finish(false));
    }
    expect(await screen.findByRole('alert')).toHaveTextContent('操作未完成，请重试。');
    expect(query).toBeEnabled();
    await userEvent.click(query); expect(t.api.loadMore).toHaveBeenCalledTimes(2);
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
    expect(await screen.findByText('材料 42', { exact: false })).toBeVisible();
    expect(screen.queryByText('曲线 *DEFINE_CURVE · 1000001', { exact: false })).not.toBeInTheDocument();
});

test('shows ambiguous definitions without preventing navigation', async () => {
    const initial = resultState();
    initial.ambiguous = true;
    initial.labels.ambiguous = '找到多个候选定义，尚不能唯一确定对象。请核对各定义位置。';
    const t = transport(initial);
    render(<EntityReferencesApp transport={t.api} />);
    expect(await screen.findByText('定义 · 候选')).toBeVisible();
    expect(screen.queryByText(initial.labels.ambiguous)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '跳转到位置: *DEFINE_CURVE / ID, wall2.key:8' }));
    expect(t.api.open).toHaveBeenCalledWith(3, 'definition-token', false);
});

test('shows semantic identities and grouped location counts without duplicate summaries', async () => {
    const initial = resultState();
    initial.activeSession = { ...initial.activeSession!, entityId: '3', entityKindLabel: '材料',
        entityName: 'High Strength Steel', keyword: '*MAT_ELASTIC', referenceCount: 102 };
    initial.references = [{ ...initial.references[0], entityId: '12', entityName: 'Front Bumper Inner',
        entityKind: 'part', entityKindLabel: '部件', keyword: '*PART', fieldName: 'MID' }];
    initial.referenceGroupCounts = { part: 102 };
    initial.hasMoreReferences = true;
    const t = transport(initial);
    const { container } = render(<EntityReferencesApp transport={t.api} />);
    expect(await screen.findByText('3', { selector: '.entity-id' })).toBeVisible();
    expect(screen.getByRole('heading', { name: /部件\s*102/ })).toBeVisible();
    expect(screen.getByTitle('102 个引用位置')).toHaveTextContent('102');
    expect(container.querySelector('.target-name')).toHaveTextContent('High Strength Steel');
    expect(container.querySelector('.target-name')).toHaveAttribute('title', 'High Strength Steel');
    expect(container.querySelector('.target-compact')).not.toHaveTextContent('102');
    expect(container.querySelector('.target-keyword')).toHaveTextContent('*MAT_ELASTIC · wall2.key:8');
    const row = screen.getByRole('button', { name: /跳转到位置: 部件 12, Front Bumper Inner/ });
    expect(row.querySelector('.result-primary')).toHaveTextContent('12');
    expect(row.querySelector('.result-primary')).toHaveTextContent('MID');
    expect(row.querySelector('.result-location')).toHaveTextContent(initial.references[0].description);
    row.focus(); await userEvent.keyboard('{Enter}');
    expect(t.api.open).toHaveBeenCalledWith(3, 'reference-token', false);
    expect(screen.queryByRole('heading', { name: '定义 1' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /跳转到定义/ }));
    expect(t.api.open).toHaveBeenCalledWith(3, 'definition-token', false);
});
test.each(['zh', 'en'] as const)('omits diagnostic details and duplicate refresh in %s', async locale => {
    const initial = resultState('partial');
    initial.locale = locale;
    initial.reasons = ['lspp-link-code-target-noncanonical', 'lspp-link-code-target-unresolved (4 occurrences)', 'LsPrePost-unknown-failure', 'unmapped-internal-code'];
    const { api } = transport(initial);
    const { container } = render(<EntityReferencesApp transport={api} />);
    await screen.findByRole('main');
    expect(screen.queryByText('技术详情')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/lspp|lsprepost|unmapped-internal-code/i);
    expect(container.querySelector('details.technical')).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新' })).not.toBeInTheDocument();
});

test('clears an old action error when fresh results arrive', async () => {
    const initial = resultState();
    const t = transport(initial);
    vi.mocked(t.api.open).mockResolvedValue(false);
    render(<EntityReferencesApp transport={t.api} />);
    await userEvent.click(await screen.findByRole('button', { name: '跳转到位置: *DEFINE_CURVE / ID, wall2.key:8' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    act(() => t.publish({ ...initial, revision: 4 }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

test.each(['false', 'reject'])('ignores a late %s from a previous result revision', async outcome => {
    const initial = resultState();
    const t = transport(initial);
    let finish!: () => void;
    vi.mocked(t.api.open).mockImplementationOnce(() => new Promise((resolve, reject) => {
        finish = () => outcome === 'false' ? resolve(false) : reject(new Error('late failure'));
    }));
    render(<EntityReferencesApp transport={t.api} />);
    await userEvent.click(await screen.findByRole('button', { name: '跳转到位置: *DEFINE_CURVE / ID, wall2.key:8' }));
    act(() => t.publish({ ...initial, revision: 4 }));
    await act(async () => finish());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '跳转到位置: *DEFINE_CURVE / ID, wall2.key:8' }));
    expect(t.api.open).toHaveBeenLastCalledWith(4, 'definition-token', false);
});
