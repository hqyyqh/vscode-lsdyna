import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeywordOptionsApp } from '../src/KeywordOptionsApp';
import { KeywordOptionsErrorBoundary } from '../src/KeywordOptionsErrorBoundary';
import type { KeywordOptionsTransport } from '../src/transport';
import type { KeywordOptionsViewState, KeywordOptionsMutationResult } from '../../../src/client/keywordOptionsProtocol';

function state(overrides: Partial<KeywordOptionsViewState> = {}): KeywordOptionsViewState {
    return {
        revision: 1, status: 'no-options', locale: 'zh', pinned: false, provisional: false,
        currentKeyword: '*DEFINE_CURVE', targetKeyword: '*DEFINE_CURVE', mode: 'none',
        currentPostCount: 0, targetPostCount: 0, dimensions: [], targets: [], postChoices: [], instances: [], selectedInstanceId: null,
        editLevel: 'recovery', capabilities: [],
        controls: [], formCandidates: [], selectedFormRuleId: null,
        cards: [], selectedFieldId: null, help: { status: 'none', fieldId: null },
        preview: null, hasDrafts: false, canApply: false, message: '当前关键字没有可切换选项',
        labels: { selectorReload: '重新读取', selectorAppliedReselect: '修改已应用，但未切换实例。请在更新后的列表中重新选择。', selectorTitle: '选择关键字实例', selectorSearch: '搜索 ID、标题或参数', selectorPrevious: '上一个实例', selectorNext: '下一个实例', selectorClear: '清空筛选', selectorClose: '关闭实例列表', selectorFileOrder: '按文件顺序', selectorIdOrder: '按对象 ID', selectorSort: '实例排序', selectorCurrent: '当前', selectorLine: '行 {0}', selectorRecord: '记录 {0}', selectorCount: '显示 {0} / {1} 个实例', selectorCountSingle: '显示 {0} / {1} 个实例', selectorSelected: '选择实例，当前第 {0} 个，共 {1} 个', selectorMissing: '选择实例，当前项不在列表中，共 {0} 个', selectorNoMatch: '没有匹配的实例。可清空筛选查看全部。', selectorOutside: '当前实例不在筛选结果中。', selectorLoading: '正在加载实例列表…', selectorError: '无法加载实例列表。当前表单仍可查看，请重新读取。', selectorEmpty: '当前文件没有同类型实例。', current: '当前关键字', result: '结果', search: '搜索', postCards: '连续可选卡片', apply: '应用', reset: '还原',
            pin: '锁定', unpin: '取消锁定', migrated: '保留', added: '新增', discarded: '丢弃', details: '详情', noOptions: '无选项',
            provisional: 'Provisional · 初版',
            keywordLine: '关键字行', cards: '卡片与布局', fields: '字段值', comments: '注释',
            currentFile: '当前文件',
            dirty: '未保存', readonly: '只读',
            reviewed: '已审查',
            capabilities: '能力与写入边界', available: '可用',
            locateSource: '定位源文件', openManual: '打开手册', resetField: '撤销本字段' },
        ...overrides,
    };
}
function transport(initial: KeywordOptionsViewState) {
    let handler: ((value: KeywordOptionsViewState) => void) | null = null;
    let latest = initial;
    const accepted = () => vi.fn(async () => ({ accepted: true, state: initial }));
    const api: KeywordOptionsTransport = {
        ready: async () => initial,
        selectDimension: accepted(), selectTarget: accepted(),
        selectPostCount: accepted(), updateControl: accepted(), selectForm: accepted(),
        selectInstance: accepted(),
        selectField: vi.fn(async request => ({ ...request, accepted: true, help: latest.help.fieldId === request.fieldId ? latest.help : { status: 'unavailable', fieldId: request.fieldId } })), updateField: accepted(),
        locateSource: vi.fn(async () => true), openManual: vi.fn(async () => true),
        apply: accepted(), reset: accepted(), togglePin: accepted(),
        onStateChanged(callback) { handler = callback; return () => { handler = null; }; },
    };
    return { api, publish: (value: KeywordOptionsViewState) => { latest = value; handler?.(value); } };
}

function linkedState(changed = false): KeywordOptionsViewState {
    return state({
        revision: changed ? 2 : 1, locale: 'zh', status: changed ? 'ready' : 'configuring',
        mode: 'fields', message: '', hasDrafts: changed, canApply: changed,
        cards: [{ cardIndex: 1, line: 1, editable: true, fields: ['TIMSTR', 'ICD7A'].map((name, index) => ({
            fieldId: name, name, cardIndex: 1, line: 1, type: '1', position: 30, width: 10,
            value: '0', ...(changed ? { draft: '1' } : {}), editable: true,
            linkedFields: [index ? 'TIMSTR' : 'ICD7A'],
        })) }],
        preview: changed ? {
            targetKeyword: '*SHARED', changedFields: 2, reviewLevel: 'field', migrated: 0, added: 0,
            discarded: 0, comments: 0, sharedByteChanges: ['TIMSTR: 0 → 1', 'ICD7A: 0 → 1'],
            details: { keyword: [], cards: [], fields: ['TIMSTR: 0 → 1', 'ICD7A: 0 → 1'], migrated: [], added: [], discarded: [], comments: [] },
        } : null,
    });
}

it('shows every field choice regardless of the current value and selects without applying the file', async () => {
    const initial = linkedState();
    initial.cards[0].fields[0].choices = ['MIRROR', 'TRANSL', 'ROTATE'];
    initial.cards[0].fields[0].value = 'TRANSL';
    const t = transport(initial);
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        left: 10, right: 170, top: 30, bottom: 58, width: 160, height: 28, x: 10, y: 30, toJSON() {},
    });
    try {
        render(<KeywordOptionsApp transport={t.api} />);
        const input = await screen.findByRole('combobox', { name: 'TIMSTR' });
        await userEvent.click(input);
        await userEvent.keyboard('{ArrowDown}');
        expect(await screen.findAllByRole('option')).toHaveLength(3);
        const list = screen.getByRole('listbox');
        Object.defineProperty(list, 'clientHeight', { value: 28 });
        for (const [index, option] of screen.getAllByRole('option').entries()) {
            Object.defineProperty(option, 'offsetTop', { value: index * 28 });
            Object.defineProperty(option, 'offsetHeight', { value: 28 });
        }
        await userEvent.keyboard('{ArrowDown}');
        expect(list.scrollTop).toBe(56);
        await userEvent.keyboard('{Escape}');
        expect(input).toHaveValue('TRANSL');
        await userEvent.keyboard('{ArrowDown}');
        await userEvent.click(screen.getByRole('option', { name: 'ROTATE' }));
        expect(input).toHaveValue('ROTATE');
        expect(t.api.apply).not.toHaveBeenCalled();
        expect(screen.queryByRole('listbox')).toBeNull();
    } finally { rect.mockRestore(); }
});

function selectorState(): KeywordOptionsViewState {
    const ids = ['9007199254740993', '2', '2', '&midA'];
    return { ...linkedState(), currentKeyword: '*MAT_ELASTIC', selectedInstanceId: 'i0', directoryStatus: 'ready',
        instances: ids.map((value, index) => ({ instanceId: `i${index}`, uri: 'file:///one.k', fileName: 'one.k', filePath: '/one.k',
            typeKey: 'MAT_001', keyword: '*MAT_ELASTIC', line: index * 3, endLine: index * 3 + 2, dataLineCount: 1,
            occurrenceCount: 4, category: 'MAT', selected: index === 0, editLevel: 'editable', displayName: '',
            identity: { field: 'MID', value }, title: index === 0 ? 'Large ID' : '', summary: [{ field: 'RO', value: String(index + 1) }] })) };
}

test('filter and integer-safe stable ordering leave the full navigation count intact', async () => {
    const initial = selectorState();
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '选择实例，当前第 1 个，共 4 个' }));
    const search = screen.getByRole('searchbox');
    expect(search).toHaveFocus();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '实例排序' }), 'id');
    const rows = within(screen.getByRole('dialog')).getAllByRole('button').filter(button => button.closest('.instanceList'));
    expect(rows.map(row => row.textContent)).toEqual([
        expect.stringContaining('MID 2'), expect.stringContaining('MID 2'), expect.stringContaining('9007199254740993'), expect.stringContaining('&midA')]);
    expect(screen.getByRole('button', { name: '选择实例，当前第 3 个，共 4 个' })).toBeVisible();
    await userEvent.type(search, 'no match');
    expect(screen.getByText('显示 0 / 4 个实例')).toBeVisible();
    expect(screen.getByText('当前实例不在筛选结果中。')).toBeVisible();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '下一个实例' }));
    expect(api.selectInstance).toHaveBeenCalledWith(1, 'i3');
    await userEvent.click(screen.getByRole('button', { name: '选择实例，当前第 3 个，共 4 个' }));
    expect(screen.getByRole('searchbox')).toHaveValue('no match');
});

test.each([1, 3])('hides ID ordering when %i instances contain only one numeric owning ID', async count => {
    const base = selectorState();
    const initial = { ...base, instances: base.instances.slice(0, count).map((item, index) => ({
        ...item, identity: index === count - 1 ? { field: 'MID', value: '2' } : undefined,
    })) };
    const { api } = transport(initial);
    api.getSelectorState = () => ({ context: 'file:///one.k\nMAT_001', order: 'id', query: '' });
    render(<KeywordOptionsApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: `选择实例，当前第 1 个，共 ${count} 个` }));
    expect(screen.queryByRole('combobox', { name: '实例排序' })).toBeNull();
    const rows = within(screen.getByRole('dialog')).getAllByRole('button').filter(button => button.closest('.instanceList'));
    expect(rows[0]).toHaveTextContent('当前');
});

test('current selection keeps unblurred drafts and IME/repeat keys do not switch', async () => {
    const { api } = transport(selectorState());
    render(<KeywordOptionsApp transport={api} />);
    const inputs = await screen.findAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: '选择实例，当前第 1 个，共 4 个' }));
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(search, { key: 'Enter', repeat: true });
    expect(screen.getByRole('dialog')).toBeVisible();
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.selectInstance).not.toHaveBeenCalled();
    expect(api.updateField).not.toHaveBeenCalled();
    expect(inputs[0]).toHaveValue('123');
});

test('cancelled selection keeps the panel/query and blocks rapid duplicate requests', async () => {
    const initial = selectorState();
    const { api } = transport(initial);
    let finish!: (result: KeywordOptionsMutationResult) => void;
    api.selectInstance = vi.fn(() => new Promise<KeywordOptionsMutationResult>(resolve => { finish = resolve; }));
    render(<KeywordOptionsApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '选择实例，当前第 1 个，共 4 个' }));
    await userEvent.type(screen.getByRole('searchbox'), 'MID 2');
    const row = within(screen.getByRole('dialog')).getAllByRole('button', { name: /MID 2/ })[0];
    fireEvent.click(row); fireEvent.click(row);
    await waitFor(() => expect(api.selectInstance).toHaveBeenCalledTimes(1));
    await act(async () => finish({ accepted: false, state: initial, reason: 'cancelled' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByRole('searchbox')).toHaveValue('MID 2');
    expect(screen.queryByText(/操作未完成/)).toBeNull();
});

test('missing current identity never becomes item one and context changes reset the filter', async () => {
    const initial = { ...selectorState(), selectedInstanceId: 'missing' };
    const { api, publish } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const trigger = await screen.findByRole('button', { name: '选择实例，当前项不在列表中，共 4 个' });
    expect(trigger).toHaveTextContent('–/4');
    expect(screen.getByRole('button', { name: '下一个实例' })).toBeDisabled();
    await userEvent.click(trigger);
    await userEvent.type(screen.getByRole('searchbox'), 'MID 2');
    const next = selectorState();
    act(() => publish({ ...next, revision: 2, instances: next.instances.map(item => ({ ...item, uri: 'file:///two.k' })) }));
    await userEvent.click(screen.getByRole('button', { name: '选择实例，当前第 1 个，共 4 个' }));
    expect(screen.getByRole('searchbox')).toHaveValue('');
});


test('an explicit English error locale overrides a Chinese document and keeps technical details collapsed', () => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = 'zh-CN';
    function Broken(): never { throw new Error('Diagnostic detail'); }
    try {
        render(<KeywordOptionsErrorBoundary locale="en"><Broken /></KeywordOptionsErrorBoundary>);
        expect(screen.getByRole('alert')).toHaveTextContent('Could not display Keyword Manager');
        expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
        expect(screen.getByText('Error details').closest('details')).not.toHaveAttribute('open');
    } finally { document.documentElement.lang = previous; }
});

test('shows explicit startup loading without exposing stale fields or write actions', async () => {
    const { api } = transport(state({ status: 'loading', currentKeyword: '*STALE' }));
    render(<KeywordOptionsApp transport={api} />);
    await waitFor(() => expect(document.querySelector('main')).toHaveAttribute('aria-busy', 'true'));
    expect(screen.queryByText('*STALE')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '应用' })).not.toBeInTheDocument();
});

test.each(['en', 'zh'] as const)('startup failure can retry in %s without granting write actions', async locale => {
    document.documentElement.lang = locale;
    const { api } = transport(state({ locale }));
    api.ready = vi.fn().mockRejectedValueOnce(new Error('Host unavailable')).mockResolvedValueOnce(state({ locale }));
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(locale === 'zh'
        ? '无法加载关键字管理器，请重试。' : 'Could not load Keyword Manager. Try again.');
    expect(screen.queryByRole('button', { name: '应用' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '重试' : 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(api.ready).toHaveBeenCalledTimes(2);
    expect(api.apply).not.toHaveBeenCalled();
});

test('a late startup rejection preserves a newer host state and its runtime locale', async () => {
    document.documentElement.lang = 'en';
    const { api, publish } = transport(state());
    let reject!: (reason: Error) => void;
    api.ready = () => new Promise((_resolve, fail) => { reject = fail; });
    render(<KeywordOptionsApp transport={api} />);
    act(() => publish(state()));
    await act(async () => reject(new Error('Late host failure')));
    expect(document.documentElement.lang).toBe('zh-CN');
    expect(screen.getByText('当前关键字没有可切换选项')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('unmount disposes the startup listener and ignores a late rejection', async () => {
    const { api } = transport(state());
    let reject!: (reason: Error) => void;
    const dispose = vi.fn();
    api.ready = () => new Promise((_resolve, fail) => { reject = fail; });
    api.onStateChanged = () => dispose;
    const view = render(<KeywordOptionsApp transport={api} />);
    view.unmount();
    await act(async () => reject(new Error('After unmount')));
    expect(dispose).toHaveBeenCalledOnce();
    expect(document.querySelector('main')).toBeNull();
});

test('directory completion preserves a local field draft and cannot be rolled back by an earlier ready response', async () => {
    const instance = { instanceId: 'one', keyword: '*SHARED', line: 0, endLine: 1, dataLineCount: 1,
        occurrenceCount: 1, category: 'other', displayName: '', selected: true, editLevel: 'editable' as const };
    const initial = { ...linkedState(), instances: [instance], selectedInstanceId: 'one', directoryStatus: 'loading' as const };
    const { api, publish } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const inputs = await screen.findAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: '123' } });
    expect(screen.getByRole('button', { name: '正在加载实例列表…' })).toBeDisabled();
    const complete = { ...initial, directoryStatus: 'ready' as const,
        instances: [instance, { ...instance, instanceId: 'two', selected: false }] };
    act(() => publish(complete));
    expect(inputs[0]).toHaveValue('123');
    expect(screen.getByRole('button', { name: '选择实例，当前第 1 个，共 2 个' })).toBeEnabled();
    act(() => publish(initial));
    expect(screen.getByRole('button', { name: '选择实例，当前第 1 个，共 2 个' })).toBeEnabled();
    expect(inputs[0]).toHaveValue('123');
});


test('retains a conflicting local input and blocks its stale shared-byte update', async () => {
    const { api, publish } = transport(linkedState());
    render(<KeywordOptionsApp transport={api} />);
    const inputs = await screen.findAllByRole('textbox');
    await userEvent.clear(inputs[1]);
    await userEvent.type(inputs[1], '99');
    act(() => publish(linkedState(true)));
    expect(inputs[1]).toHaveValue('99');
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(await screen.findByText(/关联字段已变化/)).toBeVisible();
    expect(api.updateField).not.toHaveBeenCalled();
    expect(api.apply).not.toHaveBeenCalled();
});

test.each(['zh', 'en'] as const)('shows every linked change before applying the displayed revision in %s', async locale => {
    const initial = { ...linkedState(true), locale, selectedFieldId: 'TIMSTR' };
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const preview = await screen.findByRole('region', { name: locale === 'zh' ? '修改预览' : 'Change preview' });
    expect(preview).toHaveTextContent('TIMSTR: 0 → 1');
    expect(preview).toHaveTextContent('ICD7A: 0 → 1');
    await userEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '应用' : 'Apply' }));
    expect(api.apply).toHaveBeenCalledWith(2);
});

test('stages a new linked preview without applying until the displayed revision is reviewed', async () => {
    const { api } = transport({ ...linkedState(), selectedFieldId: 'TIMSTR' });
    api.updateField = vi.fn(async () => ({ accepted: true, state: { ...linkedState(true), selectedFieldId: 'TIMSTR' } }));
    render(<KeywordOptionsApp transport={api} />);
    const inputs = await screen.findAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: '1' } });
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(await screen.findByText(/修改预览已更新/)).toBeVisible();
    expect(screen.getByRole('region', { name: '修改预览' })).toHaveTextContent('ICD7A: 0 → 1');
    expect(api.apply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(api.apply).toHaveBeenCalledWith(2);
});

test('shows a simple no-options state without internal diagnostics', async () => {
    const { api } = transport(state());
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText('当前关键字没有可切换选项')).toBeInTheDocument();
    expect(screen.queryByText(/compatibility|migration|evidence/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '应用' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '定位源文件' }));
    await userEvent.click(screen.getByRole('button', { name: '打开手册' }));
    expect(api.locateSource).toHaveBeenCalledWith(1);
    expect(api.openManual).toHaveBeenCalledWith(1);
});

test.each(['zh', 'en'] as const)('explains a remaining write restriction in %s', async locale => {
    const initial = { ...linkedState(), locale, selectedFieldId: 'TIMSTR' };
    initial.cards[0].fields[0].editable = false;
    initial.cards[0].fields[0].reason = 'native-file-write-unverified';
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText(locale === 'zh'
        ? /管理器暂不支持写入当前记录格式/ : /The manager cannot write this record format yet/)).toBeInTheDocument();
    expect(screen.queryByText(/部分信息尚未确认|Some information could not be confirmed/)).not.toBeInTheDocument();
});

test('replaces an empty read-only card shell with a concise source-edit message', async () => {
    const initial = state({
        cards: [{ cardIndex: 1, line: 1, editable: false,
            reason: 'layout-or-occurrence-unreviewed', fields: [] }],
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText('该结构暂不支持表单编辑，请在源文件中修改。')).toBeInTheDocument();
    expect(screen.queryByText('layout-or-occurrence-unreviewed')).not.toBeInTheDocument();
});

test('renders repeated native card records with stable row identities', async () => {
    const field = (fieldId: string, line: number, value: string) => ({
        fieldId, cardIndex: 2, line, name: 'O1', type: '2', position: 20, width: 20,
        value, editable: true,
    });
    const initial = state({
        status: 'configuring', mode: 'fields', message: '', editLevel: 'editable',
        cards: [
            { cardIndex: 2, occurrenceIndex: 1, line: 2, editable: true, fields: [field('o1:1', 2, '215')] },
            { cardIndex: 2, occurrenceIndex: 2, line: 3, editable: true, fields: [field('o1:2', 3, '216')] },
        ],
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText('Card 2 · 记录 1')).toBeInTheDocument();
    expect(screen.getByText('Card 2 · 记录 2')).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
});

test('clears two prefix cards sharing a physical line through three MPP2 cycles', async () => {
    const card = (cardId: string, cardIndex: number, name: string, title?: string) => ({
        cardId, cardIndex, line: 4, title, editable: true,
        fields: [{ fieldId: `${cardId}:field:0`, cardIndex, line: 4, name, type: '1',
            position: 0, width: 10, value: name === 'SURFA' ? '11' : '', editable: true }],
    });
    const baseCards = [card('base1', 1, 'SURFA'), card('base2', 2, 'FS'), card('base3', 3, 'SFSA')];
    const make = (revision: number, enabled: boolean) => state({ revision, status: 'configuring', mode: 'fields',
        currentKeyword: '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE', message: '', editLevel: 'editable',
        controls: [{ controlId: 'identity', kind: 'selector', label: 'ID 与标题', emptyLabel: '未启用',
            value: '', choices: [{ value: 'ID', label: '启用', enabled: true }], visible: true, enabled: true },
        { controlId: 'mpp', kind: 'selector', label: 'MPP1 / MPP2', value: enabled ? 'MPP2' : '',
            choices: ['MPP1', 'MPP2'].map(value => ({ value, label: value, enabled: true })), visible: true, enabled: true }],
        cards: enabled ? [card('mpp1', 0, 'IGNORE', 'MPP 卡片 1'), card('mpp2', 0, 'PENSF', 'MPP 卡片 2'), ...baseCards] : baseCards,
    });
    const { api, publish } = transport(make(1, false));
    const errors = vi.spyOn(console, 'error');
    render(<KeywordOptionsApp transport={api} />);
    await screen.findByLabelText('MPP1 / MPP2');
    expect(within(screen.getByLabelText('ID 与标题')).getAllByRole('option').map(option => option.textContent)).toEqual(['未启用', '启用']);
    for (let cycle = 0; cycle < 3; cycle++) {
        act(() => publish(make(cycle * 2 + 2, true)));
        expect(document.querySelectorAll('.cards .card')).toHaveLength(5);
        expect(screen.getByText('MPP 卡片 2')).toBeInTheDocument();
        act(() => publish(make(cycle * 2 + 3, false)));
        expect(document.querySelectorAll('.cards .card')).toHaveLength(3);
        expect(screen.queryByText('IGNORE')).not.toBeInTheDocument();
        expect(screen.queryByText('PENSF')).not.toBeInTheDocument();
        expect(screen.getAllByRole('textbox')[0]).toHaveValue('11');
    }
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/);
    errors.mockRestore();
});

test('does not grant layout authority through a multi-form choice', async () => {
    const initial = state({
        status: 'error', mode: 'fields', message: '请选择表单',
        formCandidates: [
            { ruleId: 'form-a', label: 'Card 1 [ID/VALUE]' },
            { ruleId: 'form-b', label: 'Card 1 [ID/TITLE]' },
        ],
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByLabelText('表单布局')).toBeDisabled();
    expect(api.selectForm).not.toHaveBeenCalled();
});


test('keeps uncertain layout details available without stacking source records above the form', async () => {
    const initial = linkedState();
    initial.message = 'Long parsing explanation';
    initial.layoutDiagnostics = [{ code: 'unresolved', source: 'original', severity: 'warning', blocksApply: true,
        message: initial.message, line: 2, controls: [], requiredCards: [{ condition: 'ICD7A = 1', fields: ['TIMSTR'] }] }];
    initial.unresolvedRecords = [{ line: 2, text: 'source record' }];
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText('请核对卡片结构。')).toBeVisible();
    expect(screen.getByText('Long parsing explanation')).not.toBeVisible();
    expect(screen.getByText('ICD7A = 1 → TIMSTR')).not.toBeVisible();
    await userEvent.click(document.querySelector('.layoutDetails summary')!);
    expect(screen.getByText('Long parsing explanation')).toBeVisible();
    expect(screen.getByText('source record', { exact: false })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^应用/ })).not.toBeInTheDocument();
});
