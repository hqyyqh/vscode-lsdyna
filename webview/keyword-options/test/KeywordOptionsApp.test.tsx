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
        scope: 'file', scopeStatus: 'ready', scopeMessage: '',
        editLevel: 'recovery', capabilities: [],
        controls: [], formCandidates: [], selectedFormRuleId: null,
        cards: [], selectedFieldId: null, help: { status: 'none', fieldId: null },
        preview: null, hasDrafts: false, canApply: false, message: '当前关键字没有可切换选项',
        labels: { current: '当前关键字', result: '结果', search: '搜索', postCards: '连续可选卡片', apply: '应用', reset: '重置',
            pin: '锁定', unpin: '取消锁定', migrated: '保留', added: '新增', discarded: '丢弃', details: '详情', noOptions: '无选项',
            provisional: 'Provisional · 初版',
            keywordLine: '关键字行', cards: '卡片与布局', fields: '字段值', comments: '注释',
            scope: '范围', currentFile: '当前文件', currentProject: 'Include 工程', scopeLoading: '正在扫描工程',
            projectInstance: '工程实例', dirty: '未保存', readonly: '只读',
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
        selectScope: accepted(),
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

test.each([0, 1, 2])('uses English count grammar for %i changed or discarded fields', async count => {
    const initial = linkedState(true);
    initial.locale = 'en';
    initial.preview!.changedFields = count;
    const harness = transport(initial);
    render(<KeywordOptionsApp transport={harness.api} />);
    expect(await screen.findByText(`${count} ${count === 1 ? 'field' : 'fields'} changed`)).toBeVisible();
    act(() => harness.publish({ ...initial, revision: 3, preview: {
        ...initial.preview!, reviewLevel: 'destructive', discarded: count,
    } }));
    expect(screen.getByText(`${count} non-empty ${count === 1 ? 'field' : 'fields'} will be discarded`)).toBeVisible();
});

test('uses singular and plural English while local field edits are still unapplied', async () => {
    const { api } = transport({ ...linkedState(), locale: 'en' });
    render(<KeywordOptionsApp transport={api} />);
    const inputs = await screen.findAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: '12' } });
    expect(screen.getByText('1 field being edited')).toBeVisible();
    fireEvent.change(inputs[1], { target: { value: '34' } });
    expect(screen.getByText('2 fields being edited')).toBeVisible();
    expect(api.apply).not.toHaveBeenCalled();
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

test('directory completion preserves a local field draft and cannot be rolled back by an earlier ready response', async () => {
    const instance = { instanceId: 'one', keyword: '*SHARED', line: 0, endLine: 1, dataLineCount: 1,
        occurrenceCount: 1, category: 'other', displayName: '', selected: true, editLevel: 'editable' as const };
    const initial = { ...linkedState(), instances: [instance], selectedInstanceId: 'one', directoryStatus: 'loading' as const };
    const { api, publish } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const inputs = await screen.findAllByRole('textbox');
    fireEvent.change(inputs[0], { target: { value: '123' } });
    expect(screen.getByRole('button', { name: '正在加载实例…' })).toBeDisabled();
    const complete = { ...initial, directoryStatus: 'ready' as const,
        instances: [instance, { ...instance, instanceId: 'two', selected: false }] };
    act(() => publish(complete));
    expect(inputs[0]).toHaveValue('123');
    expect(screen.getByRole('button', { name: '实例 1/2' })).toBeEnabled();
    act(() => publish(initial));
    expect(screen.getByRole('button', { name: '实例 1/2' })).toBeEnabled();
    expect(inputs[0]).toHaveValue('123');
});

test('shows every linked change before allowing a freshly flushed edit to apply', async () => {
    const { api } = transport(linkedState());
    vi.mocked(api.updateField).mockResolvedValue({ accepted: true, state: linkedState(true) });
    vi.mocked(api.apply).mockResolvedValue({ accepted: true, state: linkedState(true) });
    render(<KeywordOptionsApp transport={api} />);
    const inputs = await screen.findAllByRole('textbox');
    await userEvent.clear(inputs[0]);
    await userEvent.type(inputs[0], '1');
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(await screen.findByRole('region', { name: '联动修改' })).toBeVisible();
    expect(screen.getByText('ICD7A: 0 → 1')).toBeVisible();
    expect(inputs[1]).toHaveValue('1');
    expect(api.apply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '应用修改' }));
    expect(api.apply).toHaveBeenCalledWith(2);
});

test('retains a conflicting local input and blocks its stale shared-byte update', async () => {
    const { api, publish } = transport(linkedState());
    render(<KeywordOptionsApp transport={api} />);
    const inputs = await screen.findAllByRole('textbox');
    await userEvent.clear(inputs[1]);
    await userEvent.type(inputs[1], '99');
    act(() => publish(linkedState(true)));
    expect(inputs[1]).toHaveValue('99');
    await userEvent.click(screen.getByRole('button', { name: '核对并应用' }));
    expect(await screen.findByText(/关联字段已变化/)).toBeVisible();
    expect(api.updateField).not.toHaveBeenCalled();
    expect(api.apply).not.toHaveBeenCalled();
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

test('renders product dimensions and a structural footer summary', async () => {
    const initial = state({
        status: 'ready', mode: 'dimensions', currentKeyword: '*CONSTRAINED_JOINT_REVOLUTE',
        targetKeyword: '*CONSTRAINED_JOINT_REVOLUTE_ID', message: '', canApply: true, provisional: true,
        dimensions: [{ dimensionId: 'primary-type', label: '类型', selectionMode: 'single', required: true,
            values: [{ valueId: 'REVOLUTE', label: 'REVOLUTE', selected: true, enabled: true }] },
        { dimensionId: 'modifiers', label: '附加选项', selectionMode: 'multiple', required: false,
            values: [{ valueId: 'ID', label: 'ID', selected: true, enabled: true }] }],
        preview: { targetKeyword: '*CONSTRAINED_JOINT_REVOLUTE_ID', changedFields: 0, reviewLevel: 'structural',
            migrated: 8, added: 1, discarded: 0, comments: 0,
            details: { keyword: ['L1: *MAT_001 → *MAT_024'], cards: ['layout: old → new'],
                fields: ['RO: 1 → 2'], migrated: [], added: [], discarded: [], comments: ['old header → new header'] } },
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByRole('combobox')).toHaveValue('REVOLUTE');
    expect(screen.getByRole('checkbox', { name: 'ID' })).toBeChecked();
    expect(screen.getByText('关键字将改为 *CONSTRAINED_JOINT_REVOLUTE_ID')).toBeInTheDocument();
    expect(screen.queryByText('Provisional · 初版')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '查看修改' }));
    expect(screen.getByText('关键字行')).toBeInTheDocument();
    expect(screen.getByText('卡片与布局')).toBeInTheDocument();
    expect(screen.getByText('字段值')).toBeInTheDocument();
    expect(screen.getByText('注释')).toBeInTheDocument();
    expect(screen.getByText('RO: 1 → 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '应用修改' }));
    expect(api.apply).toHaveBeenCalledWith(1);
});

test('renders TITLE and HEADING as one heading checkbox without a generic blocker', async () => {
    const initial = state({
        status: 'ready', mode: 'dimensions', currentKeyword: '*MAT_001', targetKeyword: '*MAT_001_TITLE',
        dimensions: [{ dimensionId: 'heading', label: '标题', selectionMode: 'multiple', required: false,
            values: [{ valueId: 'ENABLED', label: '标题', selected: true, enabled: true }] }],
        preview: { targetKeyword: '*MAT_001_TITLE', changedFields: 0, reviewLevel: 'structural',
            migrated: 2, added: 1, discarded: 0, comments: 0,
            details: { keyword: [], cards: [], fields: [], migrated: [], added: [], discarded: [], comments: [] } },
        canApply: true, message: '',
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByRole('checkbox', { name: '标题' })).toBeChecked();
    expect(screen.getAllByText('标题')).toHaveLength(1);
    expect(screen.queryByText(/安全|批准|证据/)).not.toBeInTheDocument();
});

test('stages a consecutive optional-card count through the host transport', async () => {
    const initial = state({
        status: 'configuring', mode: 'search', currentKeyword: '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
        targetKeyword: '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE', currentPostCount: 3, targetPostCount: 3,
        targets: [{ targetKeyword: '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE', selected: true }],
        postChoices: [
            { targetPostCount: 3, label: '连续可选卡片：3', selected: true, enabled: true },
            { targetPostCount: 6, label: '连续可选卡片：6', selected: false, enabled: true },
        ],
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const select = await screen.findByRole('combobox', { name: '连续可选卡片' });
    expect(select).toHaveValue('3');
    await userEvent.selectOptions(select, '6');
    expect(api.selectPostCount).toHaveBeenCalledWith(1, 6);
});

test('renders LS-PrePost input-form selectors and sends their native values', async () => {
    const initial = state({
        status: 'configuring', mode: 'fields', currentKeyword: '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
        targetKeyword: '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
        controls: [
            { controlId: 'selector:mpp', kind: 'selector', label: 'MPP', value: '', visible: true, enabled: true, choices: [
                { value: 'MPP1', label: 'MPP1', enabled: true },
                { value: 'MPP2', label: 'MPP2', enabled: true },
            ] },
            { controlId: 'selector:thermal', kind: 'selector', label: 'Thermal / T_Friction', value: 'Thermal', visible: true, enabled: true, choices: [
                { value: 'Thermal', label: 'Thermal', enabled: true },
                { value: 'T_Friction', label: 'T_Friction', enabled: true },
            ] },
        ],
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const mpp = await screen.findByRole('combobox', { name: 'MPP' });
    await userEvent.selectOptions(mpp, 'MPP1');
    expect(api.updateControl).toHaveBeenCalledWith(1, 'selector:mpp', 'MPP1');
    expect(screen.getByRole('combobox', { name: 'Thermal / T_Friction' })).toHaveValue('Thermal');
});

test('ignores an out-of-order state notification', async () => {
    const initial = state({ revision: 2, currentKeyword: '*MAT_001' });
    const { api, publish } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText('*MAT_001')).toBeInTheDocument();
    publish(state({ revision: 4, currentKeyword: '*MAT_024' }));
    expect(await screen.findByText('*MAT_024')).toBeInTheDocument();
    publish(state({ revision: 3, currentKeyword: '*MAT_003' }));
    expect(screen.queryByText('*MAT_003')).not.toBeInTheDocument();
    expect(screen.getByText('*MAT_024')).toBeInTheDocument();
});

test('keeps a Card on one horizontal row and loads help from field focus', async () => {
    const initial = state({
        status: 'configuring', mode: 'fields', message: '', canApply: true,
        currentKeyword: '*SET_NODE', targetKeyword: '*SET_NODE',
        cards: [{ cardIndex: 1, line: 1, editable: true, fields: [
            { fieldId: 'sid', cardIndex: 1, line: 1, name: 'SID', type: 'integer', position: 0, width: 10, value: '', editable: true },
            { fieldId: 'solver', cardIndex: 1, line: 1, name: 'SOLVER', type: 'string', position: 50, width: 10, value: 'MECH', choices: ['MECH', 'CESE'], defaultValue: 'MECH', editable: true },
        ] }],
        selectedFieldId: 'solver',
        help: { status: 'ready', fieldId: 'solver', name: 'SOLVER', localized: '求解器', english: 'Solver', defaultValue: 'MECH', choices: ['MECH', 'CESE'] },
    });
    const { api } = transport(initial);
    const { container } = render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByDisplayValue('MECH')).toBeInTheDocument();
    await userEvent.clear(screen.getByDisplayValue('MECH'));
    await userEvent.type(screen.getByRole('combobox'), 'CESE');
    await userEvent.tab();
    expect(api.updateField).toHaveBeenCalledWith(1, 'solver', 'CESE');
    expect(screen.getByText('求解器')).toBeInTheDocument();
    expect(screen.getByText('Solver')).toBeInTheDocument();
    expect(container.querySelector('.cardScroller .fieldGrid')).toBeInTheDocument();
    expect(container.querySelectorAll('.fieldGrid > .field')).toHaveLength(2);
    expect(container.querySelector('.fieldGrid > .field')).toHaveStyle({ gridColumn: '1 / span 10' });
    expect(container.querySelectorAll('.fieldGrid > .field')[1]).toHaveStyle({ gridColumn: '51 / span 10' });
    const cards = container.querySelector('.editorLayout');
    const help = container.querySelector('.fieldHelp');
    expect(cards).not.toBeNull();
    expect(help).not.toBeNull();
    expect(cards!.compareDocumentPosition(help!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    vi.mocked(api.selectField).mockClear();
    await userEvent.click(screen.getByRole('textbox'));
    expect(api.selectField).toHaveBeenCalledWith(expect.objectContaining({ revision: 1, fieldId: 'sid' }));
});

test('keeps capability evidence in state without rendering an audit matrix', async () => {
    const initial = state({
        status: 'configuring', mode: 'fields', message: '', editLevel: 'editable',
        currentKeyword: '*SET_NODE', targetKeyword: '*SET_NODE',
        capabilities: [
            { capabilityId: 'fixed-field-edit', label: '固定字段编辑', availability: 'available', write: true,
                reason: 'ready', message: '当前实例已通过写入门禁。', evidenceIds: ['option-layout:reviewed'] },
            { capabilityId: 'field-choice', label: '字段离散选项', availability: 'available', write: true,
                reason: 'ready', message: '当前实例已通过写入门禁。', evidenceIds: ['field:solver'] },
            { capabilityId: 'repeat-card-edit', label: '重复卡片编辑', availability: 'recovery', write: true,
                reason: 'source-changed', message: '源文件已变化，等待重新合并。', evidenceIds: [] },
        ],
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText('*SET_NODE')).toBeInTheDocument();
    expect(screen.queryByText(/能力与写入边界|固定字段编辑|重复卡片编辑/)).not.toBeInTheDocument();
});

test('resets only the staged field through the existing update transport', async () => {
    const initial = state({ selectedFieldId: 'sid',
        status: 'ready', mode: 'fields', message: '', canApply: true,
        currentKeyword: '*SET_NODE', targetKeyword: '*SET_NODE',
        cards: [{ cardIndex: 1, line: 1, editable: true, fields: [
            { fieldId: 'sid', cardIndex: 1, line: 1, name: 'SID', type: 'integer', position: 0,
                width: 10, value: '42', draft: '99', editable: true },
        ] }],
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByDisplayValue('99')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '撤销本字段 SID' }));
    expect(api.updateField).toHaveBeenCalledWith(1, 'sid', '42');
});

test.each([true, false])('field reset clears local input only when accepted=%s', async accepted => {
    const initial = instanceDraftState();
    initial.cards[0].fields[0].draft = '78';
    initial.selectedFieldId = 'sid';
    const { api } = transport(initial);
    const cleared = { ...initial, revision: 2, cards: initial.cards.map(card => ({ ...card,
        fields: card.fields.map(field => ({ ...field, draft: undefined })) })) };
    api.updateField = vi.fn(async () => ({ accepted, state: accepted ? cleared : initial }));
    render(<KeywordOptionsApp transport={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '实例 1/2' }));
    const input = await screen.findByDisplayValue('78');
    fireEvent.change(input, { target: { value: '111' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: '撤销本字段 SID' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(input).toHaveValue(accepted ? '42' : '111');
    expect(api.updateField).toHaveBeenCalledTimes(1);
    if (accepted) {
        fireEvent.click(screen.getByRole('button', { name: '当前文件' }));
        await waitFor(() => expect(api.selectScope).toHaveBeenCalledWith(2, 'file'));
        expect(api.updateField).toHaveBeenCalledTimes(1);
    }
});

test('flushes focused text before applying and offers manual refresh without following', async () => {
    const initial = state({
        status: 'configuring', mode: 'fields', message: '', editLevel: 'editable',
        currentKeyword: '*SET_NODE', targetKeyword: '*SET_NODE',
        cards: [{ cardIndex: 1, line: 1, editable: true, fields: [
            { fieldId: 'sid', cardIndex: 1, line: 1, name: 'SID', type: 'integer', position: 0,
                width: 10, value: '42', editable: true },
        ] }],
    });
    const { api } = transport(initial);
    api.updateField = vi.fn(async () => ({ accepted: true, state: { ...initial, canApply: true, status: 'ready' as const } }));
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByRole('button', { name: '刷新' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '固定当前实例' })).not.toBeInTheDocument();
    const input = await screen.findByDisplayValue('42');
    await userEvent.clear(input);
    await userEvent.type(input, '99');
    expect(screen.getByText('正在编辑 1 个字段')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    await waitFor(() => expect(api.updateField).toHaveBeenCalledWith(1, 'sid', '99'));
    await waitFor(() => expect(api.apply).toHaveBeenCalledWith(1));
    expect(vi.mocked(api.updateField).mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(api.apply).mock.invocationCallOrder[0]);

});

test('opens, filters, and selects instances in the on-demand dialog', async () => {
    const initial = state({
        status: 'configuring', mode: 'fields', message: '',
        instances: [
            { instanceId: 'a', keyword: '*SET_NODE', line: 0, endLine: 2, dataLineCount: 2, occurrenceCount: 2, category: 'SET', displayName: 'Front nodes', selected: true, editLevel: 'editable' },
            { instanceId: 'b', keyword: '*MAT_001', line: 3, endLine: 5, dataLineCount: 2, occurrenceCount: 1, category: 'MAT', displayName: 'Steel', selected: false, editLevel: 'editable' },
        ],
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const trigger = await screen.findByRole('button', { name: '实例 1/2' });
    expect(screen.queryByRole('searchbox', { name: '搜索' })).not.toBeInTheDocument();
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '选择关键字实例' })).toBeInTheDocument();
    expect(screen.getByText('*SET_NODE')).toBeInTheDocument();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: false, cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('button', { name: 'Include 工程' }));
    expect(api.selectScope).toHaveBeenCalledWith(1, 'project');
    await userEvent.type(screen.getByRole('searchbox', { name: '搜索' }), 'steel');
    expect(screen.queryByText('*SET_NODE ×2')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /MAT_001/ }));
    expect(api.selectInstance).toHaveBeenCalledWith(1, 'b');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
});

function instanceDraftState(): KeywordOptionsViewState {
    return state({ status: 'configuring', mode: 'fields', message: '', selectedInstanceId: 'a',
        instances: ['a', 'b'].map((id, index) => ({ instanceId: id, keyword: '*SET_NODE',
            line: index * 3, endLine: index * 3 + 2, dataLineCount: 2, occurrenceCount: 1,
            category: 'SET', displayName: id === 'a' ? 'First' : 'Second', selected: id === 'a', editLevel: 'editable' })),
        cards: [{ cardIndex: 1, line: 1, editable: true, fields: [{ fieldId: 'sid', cardIndex: 1,
            line: 1, name: 'SID', type: 'integer', position: 0, width: 10, value: '42', editable: true }] }],
    });
}

test('uses the post-flush revision for both instance switching and other queued actions', async () => {
    const initial = instanceDraftState();
    const { api } = transport(initial);
    let host = initial;
    api.updateField = vi.fn(async () => ({ accepted: true, state: host = { ...host, revision: 2,
        cards: host.cards.map(card => ({ ...card, fields: card.fields.map(field => ({ ...field, draft: '99' })) })) } }));
    api.selectScope = vi.fn(async revision => ({ accepted: revision === host.revision, state: host }));
    api.selectInstance = vi.fn(async (revision, instanceId) => ({ accepted: revision === host.revision,
        state: host = { ...host, revision: 3, selectedInstanceId: instanceId,
            instances: host.instances.map(instance => ({ ...instance, selected: instance.instanceId === instanceId })),
            cards: [{ ...host.cards[0], fields: [{ ...host.cards[0].fields[0], fieldId: 'second-sid', value: '7', draft: undefined }] }] } }));
    render(<KeywordOptionsApp transport={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '实例 1/2' }));
    fireEvent.change(await screen.findByDisplayValue('42'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: '当前文件' }));
    await waitFor(() => expect(api.selectScope).toHaveBeenCalledWith(2, 'file'));
    fireEvent.click(screen.getByRole('button', { name: '实例 1/2' }));
    fireEvent.click(screen.getByRole('button', { name: /Second/ }));
    await waitFor(() => expect(api.selectInstance).toHaveBeenCalledWith(2, 'b'));
    expect(await screen.findByDisplayValue('7')).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('retains local input and selection when draft submission vetoes instance switching', async () => {
    const initial = instanceDraftState();
    const { api } = transport(initial);
    api.updateField = vi.fn(async () => ({ accepted: false, state: { ...initial, message: 'Invalid draft' } }));
    render(<KeywordOptionsApp transport={api} />);
    fireEvent.change(await screen.findByDisplayValue('42'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: '实例 1/2' }));
    fireEvent.click(screen.getByRole('button', { name: /Second/ }));
    await waitFor(() => expect(api.updateField).toHaveBeenCalled());
    expect(api.selectInstance).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('99')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
});

test('does not apply a retained field draft to another instance with the same field ID and value', async () => {
    const initial = instanceDraftState();
    const { api, publish } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '实例 1/2' }));
    fireEvent.change(await screen.findByDisplayValue('42'), { target: { value: '99' } });
    act(() => publish({ ...initial, selectedInstanceId: 'b', revision: 2 }));
    fireEvent.click(screen.getByRole('button', { name: '当前文件' }));
    await act(async () => { await Promise.resolve(); });
    expect(api.updateField).not.toHaveBeenCalled();
    expect(api.selectScope).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('99')).toBeInTheDocument();
    // A physical-line change remounts the keyed card. Retained input must come
    // from its existing draft owner, not be reset to the new instance's value.
    act(() => publish({ ...initial, selectedInstanceId: 'b', revision: 3,
        cards: initial.cards.map(card => ({ ...card, line: card.line + 1 })) }));
    fireEvent.click(screen.getByRole('button', { name: '当前文件' }));
    await act(async () => { await Promise.resolve(); });
    expect(api.updateField).not.toHaveBeenCalled();
    expect(api.selectScope).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('99')).toBeInTheDocument();
});

test('keeps the draft and stops a queued action when the instance changes during submission', async () => {
    const initial = instanceDraftState();
    const { api, publish } = transport(initial);
    let finish!: (value: Awaited<ReturnType<KeywordOptionsTransport['updateField']>>) => void;
    api.updateField = vi.fn(() => new Promise<Awaited<ReturnType<KeywordOptionsTransport['updateField']>>>(resolve => { finish = resolve; }));
    render(<KeywordOptionsApp transport={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '实例 1/2' }));
    fireEvent.change(await screen.findByDisplayValue('42'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: '当前文件' }));
    await waitFor(() => expect(api.updateField).toHaveBeenCalledTimes(1));
    const other = { ...initial, selectedInstanceId: 'b', revision: 3 };
    act(() => publish(other));
    await act(async () => finish({ accepted: true, state: other }));
    expect(api.selectScope).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('99')).toBeInTheDocument();
});

test('coalesces a delayed blur commit with the draft flush preceding a selection action', async () => {
    const initial = instanceDraftState();
    const { api } = transport(initial);
    let finish!: (value: Awaited<ReturnType<KeywordOptionsTransport['updateField']>>) => void;
    const pending = new Promise<Awaited<ReturnType<KeywordOptionsTransport['updateField']>>>(resolve => { finish = resolve; });
    api.updateField = vi.fn(() => pending);
    render(<KeywordOptionsApp transport={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '实例 1/2' }));
    const input = await screen.findByDisplayValue('42');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: '当前文件' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(api.updateField).toHaveBeenCalledTimes(1);
    await act(async () => finish({ accepted: true, state: { ...initial, revision: 2,
        cards: initial.cards.map(card => ({ ...card, fields: card.fields.map(field => ({ ...field, draft: '99' })) })) } }));
    await waitFor(() => expect(api.selectScope).toHaveBeenCalledWith(2, 'file'));
});

test('ignores a delayed blur from an already flushed host draft', async () => {
    const initial = instanceDraftState();
    initial.cards[0].fields[0].draft = '78';
    initial.selectedFieldId = 'sid';
    const { api } = transport(initial);
    api.updateField = vi.fn(async () => ({ accepted: true, state: { ...initial, revision: 2,
        cards: initial.cards.map(card => ({ ...card, fields: card.fields.map(field => ({ ...field, draft: '99' })) })) } }));
    render(<KeywordOptionsApp transport={api} />);
    fireEvent.click(await screen.findByRole('button', { name: '实例 1/2' }));
    const input = await screen.findByDisplayValue('78');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: '当前文件' }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(api.updateField).toHaveBeenCalledTimes(1);
    expect(api.selectScope).toHaveBeenCalledWith(2, 'file');
});

test('shows only a field count for ordinary edits and keeps reset available', async () => {
    const initial = state({
        status: 'ready', mode: 'fields', message: '', canApply: true,
        currentKeyword: '*SET_NODE', targetKeyword: '*SET_NODE',
        cards: [{ cardIndex: 1, line: 1, editable: true, fields: [
            { fieldId: 'sid', cardIndex: 1, line: 1, name: 'SID', type: 'integer', position: 0,
                width: 10, value: '42', draft: '99', editable: true },
        ] }],
        preview: { targetKeyword: '*SET_NODE', changedFields: 1, reviewLevel: 'field',
            migrated: 0, added: 0, discarded: 0, comments: 0,
            details: { keyword: [], cards: [], fields: ['SID: 42 → 99'],
                migrated: [], added: [], discarded: [], comments: [] } },
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText('已修改 1 个字段')).toBeInTheDocument();
    expect(screen.queryByText('SID: 42 → 99')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重置' }));
    expect(api.reset).toHaveBeenCalledWith(1);
});

test('keeps an uncommitted text draft when reset is rejected', async () => {
    const initial = state({
        status: 'configuring', mode: 'fields', message: '',
        currentKeyword: '*SET_NODE', targetKeyword: '*SET_NODE',
        cards: [{ cardIndex: 1, line: 1, editable: true, fields: [
            { fieldId: 'sid', cardIndex: 1, line: 1, name: 'SID', type: 'integer', position: 0,
                width: 10, value: '42', editable: true },
        ] }],
    });
    const { api } = transport(initial);
    api.reset = vi.fn(async () => ({ accepted: false, state: initial, reason: 'stale-revision' }));
    render(<KeywordOptionsApp transport={api} />);
    const input = await screen.findByDisplayValue('42');
    await userEvent.clear(input);
    await userEvent.type(input, '99');
    await userEvent.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith(1));
    expect(input).toHaveValue('99');
});

test('requires a separate destructive review before applying', async () => {
    const initial = state({
        status: 'ready', mode: 'dimensions', message: '', canApply: true,
        currentKeyword: '*MAT_001_TITLE', targetKeyword: '*MAT_001',
        preview: { targetKeyword: '*MAT_001', changedFields: 0, reviewLevel: 'destructive',
            migrated: 1, added: 0, discarded: 1, comments: 0,
            details: { keyword: ['*MAT_001_TITLE → *MAT_001'], cards: [], fields: [],
                migrated: [], added: [], discarded: ['TITLE = Steel'], comments: [] } },
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText('将丢弃 1 个非空字段')).toBeInTheDocument();
    expect(screen.queryByText('TITLE = Steel')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '核对并应用' }));
    expect(screen.getByText('TITLE = Steel')).toBeVisible();
    expect(api.apply).not.toHaveBeenCalled();
});

test('shows project filenames and scan state inside the instance dialog', async () => {
    const initial = state({
        status: 'configuring', mode: 'fields', message: '', scope: 'project',
        scopeStatus: 'loading', scopeMessage: '正在扫描工程',
        instances: [{
            instanceId: 'include:3', uri: 'file:///model/include-a.k', filePath: 'D:/model/include-a.k',
            fileName: 'include-a.k', keyword: '*MAT_001', line: 3, endLine: 5, dataLineCount: 2,
            occurrenceCount: 1, category: 'MAT', displayName: 'Steel', selected: false,
            editLevel: 'recovery', scope: 'project', dirty: true, readonly: true, includeOrder: 2,
        }],
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '实例 1/1' }));
    expect(screen.getByRole('button', { name: 'Include 工程' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('正在扫描工程');
    expect(screen.getByText(/Steel · include-a.k · 行 4 · 未保存 · 只读/)).toBeInTheDocument();
});

test('renders a generic boolean control', async () => {
    const initial = state({
        status: 'configuring', mode: 'fields', message: '',
        controls: [
            { controlId: 'control:enabled', kind: 'boolean', label: 'Enabled', value: false,
                visible: true, enabled: true },
        ],
    });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const toggle = await screen.findByRole('checkbox', { name: 'Enabled' });
    await userEvent.click(toggle);
    expect(api.updateControl).toHaveBeenCalledWith(1, 'control:enabled', true);
});

test('does not crash when host state omits formCandidates', async () => {
    const broken = state();
    delete (broken as any).formCandidates;
    delete (broken as any).selectedFormRuleId;
    const { api } = transport(broken);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText('*DEFINE_CURVE')).toBeInTheDocument();
});

test('renders a loading message when state is pending', async () => {
    const api: KeywordOptionsTransport = {
        ...transport(state()).api,
        ready: () => new Promise(() => {}),
    };
    render(<KeywordOptionsApp transport={api} />);
    expect(screen.getByRole('status')).toHaveTextContent(/正在加载关键字选项|Loading keyword options/);
});

test('catches child render error in KeywordOptionsErrorBoundary and allows retry', async () => {
    let shouldThrow = true;
    function ProblematicChild() {
        if (shouldThrow) throw new Error('Simulated render explosion');
        return <div>Recovered content</div>;
    }
    const { rerender } = render(
        <KeywordOptionsErrorBoundary locale="zh">
            <ProblematicChild />
        </KeywordOptionsErrorBoundary>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Simulated render explosion');
    shouldThrow = false;
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    rerender(
        <KeywordOptionsErrorBoundary locale="zh">
            <ProblematicChild />
        </KeywordOptionsErrorBoundary>
    );
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
});

test('GUI scenario 1: renders all 7 cards with non-standard dollar-pipe comments without layout error and displays correct selectors', async () => {
    const contactState = state({
        status: 'ready',
        mode: 'fields',
        currentKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
        targetKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
        message: '',
        controls: [
            { controlId: 'mpp', kind: 'selector', label: 'MPP1 / MPP2', value: '', visible: true, enabled: true, choices: [{ label: 'MPP1', value: 'MPP1', enabled: true }, { label: 'MPP2', value: 'MPP2', enabled: true }] },
            { controlId: 'thermal', kind: 'selector', label: 'Thermal / T_Friction', value: '', visible: true, enabled: true, choices: [{ label: 'Thermal', value: 'Thermal', enabled: true }, { label: 'T_Friction', value: 'T_Friction', enabled: true }] },
            { controlId: 'optional', kind: 'selector', label: 'A / ABCDEFG', value: 'ABC', visible: true, enabled: true, choices: [{ label: 'A', value: 'A', enabled: true }, { label: 'AB', value: 'AB', enabled: true }, { label: 'ABC', value: 'ABC', enabled: true }] },
            { controlId: 'spelling', kind: 'selector', label: 'ID / TITLE', value: 'ID', visible: true, enabled: true, choices: [{ label: 'ID', value: 'ID', enabled: true }, { label: 'TITLE', value: 'TITLE', enabled: true }] },
        ],
        cards: [
            { cardIndex: 0, line: 1, editable: true, fields: [
                { fieldId: 'CID', name: 'CID', cardIndex: 0, line: 1, type: '1', position: 0, width: 10, value: '8000001', editable: true },
                { fieldId: 'TITLE', name: 'TITLE', cardIndex: 0, line: 1, type: 'string', position: 10, width: 70, value: 'SingleSurface', editable: true },
            ] },
            { cardIndex: 1, line: 2, editable: true, fields: [
                { fieldId: 'SURFA', name: 'SURFA', cardIndex: 1, line: 2, type: '1', position: 0, width: 10, value: '8000001', editable: true },
                { fieldId: 'SURFB', name: 'SURFB', cardIndex: 1, line: 2, type: '1', position: 10, width: 10, value: '2', editable: true },
            ] },
            { cardIndex: 2, line: 3, editable: true, fields: [
                { fieldId: 'FS', name: 'FS', cardIndex: 2, line: 3, type: '2', position: 0, width: 10, value: '10', editable: true },
            ] },
            { cardIndex: 3, line: 4, editable: true, fields: [
                { fieldId: 'SFSA', name: 'SFSA', cardIndex: 3, line: 4, type: '2', position: 0, width: 10, value: '1.', editable: true },
            ] },
            { cardIndex: 4, line: 5, editable: true, fields: [
                { fieldId: 'SOFT', name: 'SOFT', cardIndex: 4, line: 5, type: '1', position: 0, width: 10, value: '2', editable: true },
            ] },
            { cardIndex: 5, line: 6, editable: true, fields: [
                { fieldId: 'PENMAX', name: 'PENMAX', cardIndex: 5, line: 6, type: '2', position: 0, width: 10, value: '0.', editable: true },
            ] },
            { cardIndex: 6, line: 7, editable: true, fields: [
                { fieldId: 'IGAP', name: 'IGAP', cardIndex: 6, line: 7, type: '1', position: 0, width: 10, value: '2', editable: true },
            ] },
        ],
    });
    const { api } = transport(contactState);
    const { container } = render(<KeywordOptionsApp transport={api} />);

    // Assert: Selectors show ID and ABC in controlsGrid
    expect(await screen.findByLabelText('A / ABCDEFG')).toHaveValue('ABC');
    expect(screen.getByLabelText('ID / TITLE')).toHaveValue('ID');
    expect(container.querySelector('.options .controlsGrid')).toBeInTheDocument();
    expect(container.querySelectorAll('.controlsGrid .dimension')).toHaveLength(4);
    expect(screen.getByText('Thermal / T_Friction')).toHaveAttribute('title', 'Thermal / T_Friction');
    expect(screen.getByText('MPP1 / MPP2')).toHaveAttribute('title', 'MPP1 / MPP2');
    expect(screen.getByLabelText('ID / TITLE')).toHaveAttribute('title', 'ID / TITLE: ID');

    // Assert: Card 0 labeled properly with ID / TITLE and no duplicate Card 1
    expect(screen.getByText('Card 0 · ID / TITLE')).toBeInTheDocument();
    expect(screen.getByText('Card 1')).toBeInTheDocument();

    // Assert: Card 0 CID spans 10 slots and TITLE spans 70 slots
    const card0Fields = container.querySelectorAll('.card:first-child .fieldGrid > .field');
    expect(card0Fields[0]).toHaveStyle({ gridColumn: '1 / span 10' });
    expect(card0Fields[1]).toHaveStyle({ gridColumn: '11 / span 70' });

    // Assert: No error banner
    expect(screen.queryByText(/无法与.*匹配/)).not.toBeInTheDocument();
    expect(screen.queryByText(/只读/)).not.toBeInTheDocument();

    // Assert: All 7 card fields rendered and editable
    expect(screen.getAllByDisplayValue('8000001')).toHaveLength(2);
    expect(screen.getByDisplayValue('SingleSurface')).toBeVisible();
    expect(screen.getByDisplayValue('10')).toBeVisible();
    expect(screen.getByDisplayValue('1.')).toBeVisible();
    expect(screen.getByDisplayValue('0.')).toBeVisible();
    expect(screen.getAllByDisplayValue('2').length).toBeGreaterThanOrEqual(3);

    const inputs = screen.getAllByRole('textbox');
    expect(inputs.length).toBeGreaterThanOrEqual(7);
    inputs.forEach(input => expect(input).toBeEnabled());
});

test('GUI scenario 2: user edits SOFT field in Card 4, enables Apply button, and applies successfully', async () => {
    const contactState = state({
        status: 'ready',
        mode: 'fields',
        currentKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
        targetKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
        message: '',
        cards: [
            { cardIndex: 4, line: 5, editable: true, fields: [
                { fieldId: 'SOFT-field', name: 'SOFT', cardIndex: 4, line: 5, type: '1', position: 0, width: 10, value: '2', editable: true },
            ] },
        ],
    });
    const { api } = transport(contactState);
    const updatedState = {
        ...contactState,
        hasDrafts: true,
        canApply: true,
        cards: [
            { cardIndex: 4, line: 5, editable: true, fields: [
                { fieldId: 'SOFT-field', name: 'SOFT', cardIndex: 4, line: 5, type: '1', position: 0, width: 10, value: '2', draft: '1', editable: true },
            ] },
        ],
        preview: {
            targetKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
            changedFields: 1,
            reviewLevel: 'field' as const,
            migrated: 0, added: 0, discarded: 0, comments: 0,
            details: { keyword: [], cards: [], fields: ['SOFT: 2 → 1'], migrated: [], added: [], discarded: [], comments: [] },
        },
    };

    vi.mocked(api.updateField).mockResolvedValue({ accepted: true, state: updatedState });
    vi.mocked(api.apply).mockResolvedValue({ accepted: true, state: updatedState });

    render(<KeywordOptionsApp transport={api} />);
    const softInput = await screen.findByDisplayValue('2');
    await userEvent.clear(softInput);
    await userEvent.type(softInput, '1');

    const applyButton = screen.getByRole('button', { name: '应用' });
    expect(applyButton).toBeEnabled();
    await userEvent.click(applyButton);

    expect(api.apply).toHaveBeenCalled();
});

test('GUI scenario 3: ambiguous source layouts stay read-only', async () => {
    const ambiguousState = state({
        status: 'error',
        mode: 'fields',
        currentKeyword: '*MAT_230',
        targetKeyword: '*MAT_230',
        message: '当前记录无法与 LS-PrePost 表单布局唯一匹配，请选择表单',
        formCandidates: [
            { ruleId: 'input-form-252', label: 'Card 1 [MID/RO/E/PR]' },
            { ruleId: 'input-form-254', label: 'Card 1 [MID/RO/E/PR/SIGY/ETAN]' },
        ],
    });
    const { api } = transport(ambiguousState);
    render(<KeywordOptionsApp transport={api} />);

    const formSelect = await screen.findByLabelText('表单布局');
    expect(formSelect).toBeInTheDocument();

    expect(formSelect).toBeDisabled();
    expect(api.selectForm).not.toHaveBeenCalled();
});

test('GUI scenario 4: 0-comment 7-line Contact renders cleanly with active controls and supports live field draft apply', async () => {
    const zeroCommentContactState = state({
        status: 'ready',
        mode: 'fields',
        currentKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
        targetKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
        message: '',
        controls: [
            {
                controlId: 'ctrl-ag',
                kind: 'selector',
                label: 'A / ABCDEFG',
                value: 'ABC',
                visible: true,
                enabled: true,
                choices: [
                    { value: '', label: '-', enabled: true },
                    { value: 'A', label: 'A', enabled: true },
                    { value: 'AB', label: 'AB', enabled: true },
                    { value: 'ABC', label: 'ABC', enabled: true },
                    { value: 'ABCD', label: 'ABCD', enabled: true },
                    { value: 'ABCDEFG', label: 'ABCDEFG', enabled: true },
                ],
            },
            {
                controlId: 'ctrl-thermal',
                kind: 'selector',
                label: 'Thermal / T_Friction',
                value: '',
                visible: true,
                enabled: true,
                choices: [
                    { value: '', label: '-', enabled: true },
                    { value: 'Thermal', label: 'Thermal', enabled: true },
                    { value: 'T_Friction', label: 'T_Friction', enabled: true },
                ],
            },
        ],
        cards: [
            { cardIndex: 0, line: 1, editable: true, fields: [
                { fieldId: 'CID-field', name: 'CID', cardIndex: 0, line: 1, type: '1', position: 0, width: 10, value: '8000001', editable: true },
            ] },
            { cardIndex: 1, line: 2, editable: true, fields: [
                { fieldId: 'SSID-field', name: 'SSID', cardIndex: 1, line: 2, type: '1', position: 0, width: 10, value: '8000001', editable: true },
            ] },
            { cardIndex: 2, line: 3, editable: true, fields: [
                { fieldId: 'FS-field', name: 'FS', cardIndex: 2, line: 3, type: '2', position: 0, width: 10, value: '10', editable: true },
            ] },
            { cardIndex: 3, line: 4, editable: true, fields: [
                { fieldId: 'SFS-field', name: 'SFS', cardIndex: 3, line: 4, type: '2', position: 0, width: 10, value: '1.', editable: true },
            ] },
            { cardIndex: 4, line: 5, editable: true, fields: [
                { fieldId: 'SOFT-field', name: 'SOFT', cardIndex: 4, line: 5, type: '1', position: 0, width: 10, value: '2', editable: true },
            ] },
            { cardIndex: 5, line: 6, editable: true, fields: [
                { fieldId: 'PENMAX-field', name: 'PENMAX', cardIndex: 5, line: 6, type: '2', position: 0, width: 10, value: '0.', editable: true },
            ] },
            { cardIndex: 6, line: 7, editable: true, fields: [
                { fieldId: 'IGAP-field', name: 'IGAP', cardIndex: 6, line: 7, type: '1', position: 0, width: 10, value: '2', editable: true },
            ] },
        ],
    });

    const { api } = transport(zeroCommentContactState);
    const updatedState = {
        ...zeroCommentContactState,
        hasDrafts: true,
        canApply: true,
        cards: zeroCommentContactState.cards.map(c => c.cardIndex === 4 ? {
            ...c,
            fields: [{ ...c.fields[0], value: '2', draft: '1' }],
        } : c),
        preview: {
            targetKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
            changedFields: 1,
            reviewLevel: 'field' as const,
            migrated: 0, added: 0, discarded: 0, comments: 0,
            details: { keyword: [], cards: [], fields: ['SOFT: 2 → 1'], migrated: [], added: [], discarded: [], comments: [] },
        },
    };

    vi.mocked(api.updateField).mockResolvedValue({ accepted: true, state: updatedState });
    vi.mocked(api.apply).mockResolvedValue({ accepted: true, state: updatedState });

    render(<KeywordOptionsApp transport={api} />);

    // Check control selection
    const agSelect = await screen.findByLabelText('A / ABCDEFG') as HTMLSelectElement;
    expect(agSelect).toBeInTheDocument();
    expect(agSelect.value).toBe('ABC');

    // Check card fields
    const softInput = await screen.findByLabelText('SOFT');
    await userEvent.clear(softInput);
    await userEvent.type(softInput, '1');

    const applyButton = screen.getByRole('button', { name: '应用' });
    expect(applyButton).toBeEnabled();
    await userEvent.click(applyButton);

    expect(api.apply).toHaveBeenCalled();
});

test('GUI scenario 5: dynamic optional card cascade expansion from ABC to ABCD triggers updateControl and renders Card D', async () => {
    const baseState = state({
        status: 'ready',
        mode: 'fields',
        currentKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
        targetKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
        controls: [
            {
                controlId: 'ctrl-ag',
                kind: 'selector',
                label: 'A / ABCDEFG',
                value: 'ABC',
                visible: true,
                enabled: true,
                choices: [
                    { value: '', label: '-', enabled: true },
                    { value: 'ABC', label: 'ABC', enabled: true },
                    { value: 'ABCD', label: 'ABCD', enabled: true },
                ],
            },
        ],
        cards: [
            { cardIndex: 4, line: 5, editable: true, fields: [
                { fieldId: 'SOFT-field', name: 'SOFT', cardIndex: 4, line: 5, type: '1', position: 0, width: 10, value: '2', editable: true },
            ] },
        ],
    });

    const expandedState = {
        ...baseState,
        controls: [
            {
                ...baseState.controls[0],
                value: 'ABCD',
            },
        ],
        cards: [
            ...baseState.cards,
            { cardIndex: 7, line: 8, editable: true, fields: [
                { fieldId: 'Q2TRI-field', name: 'Q2TRI', cardIndex: 7, line: 8, type: '1', position: 0, width: 10, value: '1', editable: true },
            ] },
        ],
    };

    const { api, publish } = transport(baseState);
    vi.mocked(api.updateControl).mockResolvedValue({ accepted: true, state: expandedState });

    render(<KeywordOptionsApp transport={api} />);

    const agSelect = await screen.findByLabelText('A / ABCDEFG');
    await userEvent.selectOptions(agSelect, 'ABCD');
    expect(api.updateControl).toHaveBeenCalledWith(1, 'ctrl-ag', 'ABCD');

    // Simulate backend response updating state
    act(() => publish(expandedState));

    // Card D field Q2TRI should now be present
    expect(await screen.findByDisplayValue('1')).toBeInTheDocument();
    expect(screen.getByText('Q2TRI')).toBeInTheDocument();
});


function helpState(overrides: Partial<KeywordOptionsViewState> = {}) {
    return state({ status: 'configuring', mode: 'fields', message: '', selectedInstanceId: 'first',
        selectedFieldId: 'a', cards: [{ cardIndex: 1, line: 1, editable: true, fields: [
            { fieldId: 'a', name: 'Alpha', cardIndex: 1, line: 1, type: 'integer', position: 0, width: 10, value: '1', editable: true },
            { fieldId: 'b', name: 'Beta', cardIndex: 1, line: 1, type: 'integer', position: 10, width: 10, value: '2', editable: true, choices: ['2', '3'] },
        ] }], help: { status: 'ready', fieldId: 'a', localized: '中文说明', english: 'English description', defaultValue: '0', choices: ['1', '2'] },
        ...overrides });
}

test('bottom help follows focus, ignores hover, deduplicates selection and survives blur and Escape', async () => {
    const initial = helpState();
    const { api, publish } = transport(initial);
    vi.mocked(api.selectField).mockImplementation(async request => ({ ...request, accepted: true,
        help: { status: 'ready', fieldId: request.fieldId, localized: '第二字段' } }));
    const { container } = render(<KeywordOptionsApp transport={api} />);
    const input = await screen.findByDisplayValue('1');
    const select = screen.getByDisplayValue('2');
    await userEvent.hover(select);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(api.selectField).not.toHaveBeenCalled();
    await userEvent.click(input);
    expect(api.selectField).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(select).toHaveFocus();
    await waitFor(() => expect(screen.getByText('第二字段')).toBeVisible());
    expect(api.selectField).toHaveBeenCalledTimes(1);
    fireEvent.blur(select);
    fireEvent.focus(select);
    expect(api.selectField).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('complementary', { name: '字段帮助' })).toBeVisible();
    expect(container.querySelector('[data-field-id="b"]')).toHaveClass('helpSelected');
    expect(container.querySelector('.fieldHelp')).not.toHaveAttribute('style');
    act(() => publish({ ...initial, revision: 1 }));
    expect(screen.getByText('第二字段')).toBeVisible();
});

test.each(['rejected', 'exception'])('field help selection can retry after %s', async failure => {
    const initial = helpState();
    const { api } = transport(initial);
    const mock = vi.mocked(api.selectField);
    if (failure === 'exception') mock.mockRejectedValueOnce(new Error('offline'));
    else mock.mockImplementationOnce(async request => ({ ...request, accepted: false }));
    mock.mockImplementationOnce(async request => ({ ...request, accepted: true,
        help: { status: 'ready', fieldId: 'b', localized: '恢复成功' } }));
    render(<KeywordOptionsApp transport={api} />);
    const select = await screen.findByDisplayValue('2');
    fireEvent.focus(select);
    await screen.findByText('字段帮助切换失败，请重新聚焦该字段重试。');
    fireEvent.blur(select);
    fireEvent.focus(select);
    await screen.findByText('恢复成功');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('字段帮助切换失败，请重新聚焦该字段重试。')).not.toBeInTheDocument();
});

test('help resets reading state on field and instance changes and hides when fields disappear', async () => {
    const initial = helpState();
    const { api, publish } = transport(initial);
    const { container } = render(<KeywordOptionsApp transport={api} />);
    await screen.findByText('中文说明');
    await userEvent.click(screen.getByText('English'));
    await userEvent.click(screen.getByText('可选值 (2)'));
    const body = container.querySelector('.detailViewport')!;
    body.scrollTop = 70;
    const next = { ...initial, revision: 2, selectedInstanceId: 'second' };
    act(() => publish(next));
    expect(container.querySelector('.detailViewport')!.scrollTop).toBe(0);
    expect(container.querySelector('details[open]')).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByDisplayValue('1'));
    act(() => publish({ ...next, revision: 3, selectedFieldId: 'b',
        cards: [{ ...initial.cards[0], fields: [initial.cards[0].fields[1]] }],
        help: { status: 'ready', fieldId: 'b', localized: '新字段' } }));
    expect(screen.getByText('新字段')).toBeVisible();
    expect(container.querySelector('.detailViewport')!.scrollTop).toBe(0);
    act(() => publish({ ...next, revision: 4, cards: [], selectedFieldId: null }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
});

test('help renders localized status without stale text and handles none to ready transitions', async () => {
    const initial = helpState({ help: { status: 'none', fieldId: 'a' } });
    const { api, publish } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    await screen.findByText('暂无字段帮助。');
    act(() => publish({ ...initial, revision: 2, help: { status: 'ready', fieldId: 'b', localized: '不应显示' } }));
    expect(screen.getByText('正在加载…')).toBeVisible();
    expect(screen.queryByText('不应显示')).not.toBeInTheDocument();
    act(() => publish({ ...initial, revision: 3, help: { status: 'unavailable', fieldId: 'a', message: 'No field help is provided.' } }));
    expect(screen.getByText('暂无字段帮助。')).toBeVisible();
    act(() => publish({ ...initial, revision: 4, help: { status: 'ready', fieldId: 'a', english: 'Fallback English' } }));
    expect(screen.getByText('Fallback English')).toBeVisible();
    expect(screen.queryByText('English')).not.toBeInTheDocument();
    act(() => publish({ ...helpState(), revision: 5, locale: 'en' }));
    expect(screen.getByText('English description')).toBeVisible();
    expect(screen.queryByText('中文说明')).not.toBeInTheDocument();
    expect(screen.getByRole('complementary')).not.toHaveAttribute('aria-live');
    expect(screen.getByText('Default').closest('div')).toHaveTextContent('Default0');
});


test('deduplicates in-flight focus requests while allowing a return to the previous field', async () => {
    const initial = helpState();
    const { api } = transport(initial);
    let resolveFirst!: (result: Awaited<ReturnType<KeywordOptionsTransport['selectField']>>) => void;
    vi.mocked(api.selectField).mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
        ;
    render(<KeywordOptionsApp transport={api} />);
    const select = await screen.findByDisplayValue('2');
    fireEvent.focus(select);
    fireEvent.blur(select);
    fireEvent.focus(select);
    expect(api.selectField).toHaveBeenCalledTimes(1);
    fireEvent.focus(screen.getByDisplayValue('1'));
    expect(api.selectField).toHaveBeenCalledTimes(1);
    await act(async () => resolveFirst({ ...vi.mocked(api.selectField).mock.calls[0][0], accepted: true,
        help: { status: 'ready', fieldId: 'b', localized: '旧响应' } }));
    expect(screen.getByText('中文说明')).toBeVisible();
    expect(screen.queryByText('旧响应')).not.toBeInTheDocument();
});


test('help shows schema aliases and distinguishes unmatched fields without hiding native choices', async () => {
    const initial = helpState({help:{status:'ready',fieldId:'a',schemaName:'SSID',localized:'字段内容'}});
    const {api,publish}=transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText('Alpha（SSID）')).toBeVisible();
    act(()=>publish({...initial,revision:2,help:{status:'ready',fieldId:'a',reason:'field-unmatched',choices:['1','2'],defaultValue:'0'}}));
    expect(screen.getByText('尚未关联到该字段的帮助。')).toBeVisible();
    expect(screen.getByText('可选值 (2)')).toBeVisible();
    expect(screen.getByText('默认值').closest('div')).toHaveTextContent('默认值0');
    expect(screen.queryByText('Alpha（SSID）')).not.toBeInTheDocument();
    act(()=>publish({...initial,revision:3,locale:'en',help:{status:'unavailable',fieldId:'a',reason:'field-unmatched'}}));
    expect(screen.getByText('Help has not been matched to this field.')).toBeVisible();
});


test('resets help reading state for a same-field branch change without replacing the editor', async () => {
    const initial = helpState({help:{...helpState().help,contextKey:'branch-a'}});
    const {api,publish}=transport(initial);
    const {container}=render(<KeywordOptionsApp transport={api} />);
    const input = await screen.findByDisplayValue('1');
    await userEvent.click(screen.getByText('English'));
    container.querySelector('.detailViewport')!.scrollTop = 50;
    await userEvent.click(input);
    act(()=>publish({...initial,revision:2,help:{...initial.help,contextKey:'branch-b',localized:'另一分支说明'}}));
    expect(screen.getByText('另一分支说明')).toBeVisible();
    expect(container.querySelector('details[open]')).toBeNull();
    expect(container.querySelector('.detailViewport')!.scrollTop).toBe(0);
    expect(screen.getByDisplayValue('1')).toBe(input);
    expect(input).toHaveFocus();
});

test('focusing help does not change the revision used to apply a draft', async () => {
    const initial = helpState({ status: 'ready', canApply: true, hasDrafts: true });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    await userEvent.click(await screen.findByDisplayValue('2'));
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(api.apply).toHaveBeenCalledWith(initial.revision);
    expect(api.updateField).not.toHaveBeenCalled();
});

test.each([
    ['form-unresolved','实际记录尚不能唯一确定字段布局。'],
    ['branch-unverified','当前分支尚未确认。'],
    ['branch-help-missing','当前分支尚无对应说明。'],
    ['description-missing','暂无字段说明。'],
] as const)('renders typed help reason %s', async (reason,message) => {
    const {api}=transport(helpState({help:{status:'unavailable',fieldId:'a',reason}}));
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText(message)).toBeVisible();
});

function reviewState(): KeywordOptionsViewState {
    const initial = instanceDraftState();
    initial.selectedFieldId = 'sid';
    initial.status = 'ready';
    initial.canApply = true;
    initial.hasDrafts = true;
    initial.cards[0].fields[0].draft = '99';
    initial.preview = { targetKeyword: initial.targetKeyword, changedFields: 1, reviewLevel: 'field',
        migrated: 0, added: 0, discarded: 0, comments: 0,
        details: { keyword: [], cards: [], fields: ['SID: 42 → 99'], migrated: [], added: [], discarded: [], comments: [] } };
    return initial;
}

test('ordinary edits can be reviewed without applying and the native cancel returns focus', async () => {
    const { api } = transport(reviewState());
    render(<KeywordOptionsApp transport={api} />);
    const trigger = await screen.findByRole('button', { name: '查看修改' });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '核对修改' });
    expect(within(dialog).getByText('SID: 42 → 99')).toBeVisible();
    expect(dialog.querySelector('[data-initial-focus]')).toHaveFocus();
    expect(api.apply).not.toHaveBeenCalled();
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(api.apply).toHaveBeenCalledWith(1);
});

test('local modifications and full values appear immediately and reset without a host write', async () => {
    const initial = instanceDraftState(); initial.selectedFieldId = 'sid';
    const { api } = transport(initial);
    const { container } = render(<KeywordOptionsApp transport={api} />);
    const input = await screen.findByDisplayValue('42');
    fireEvent.change(input, { target: { value: '1234567890' } });
    expect(container.querySelector('.fieldEditor')).toHaveClass('changed');
    expect(container.querySelector('.fullValue code')).toHaveTextContent('1234567890');
    await userEvent.click(screen.getByRole('button', { name: '折叠字段帮助' }));
    expect(container.querySelector('.fieldHelpBody')).not.toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '撤销本字段 SID' }));
    expect(input).toHaveValue('42');
    expect(container.querySelector('.fieldEditor')).not.toHaveClass('changed');
    expect(api.updateField).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '展开字段帮助' })).toBeVisible();
});

test('a reviewed revision change refreshes the confirmation before any apply', async () => {
    const initial = reviewState();
    const { api, publish } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '查看修改' }));
    act(() => publish({ ...initial, revision: 2, preview: { ...initial.preview!, details: {
        ...initial.preview!.details, fields: ['SID: 42 → 100'] } } }));
    expect(screen.getByText('SID: 42 → 100')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '应用修改' }));
    expect(api.apply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '应用修改' }));
    expect(api.apply).toHaveBeenCalledWith(2);
});

test.each(['stale', 'error'] as const)('a %s preview cannot be applied', async status => {
    const initial = reviewState(); const { api, publish } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '查看修改' }));
    act(() => publish({ ...initial, revision: 2, status }));
    expect(screen.getByRole('button', { name: '应用修改' })).toBeDisabled();
    expect(api.apply).not.toHaveBeenCalled();
});

test('an instance switch closes its old review', async () => {
    const initial = reviewState(); const { api, publish } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '查看修改' }));
    act(() => publish({ ...initial, revision: 2, selectedInstanceId: 'b' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.apply).not.toHaveBeenCalled();
});

test('review prevents duplicate application and closing during a pending write, retaining rejected drafts', async () => {
    const initial = reviewState();
    initial.preview!.sharedByteChanges = ['SID: 42 → 99'];
    const { api } = transport(initial);
    let finish!: (value: { accepted: boolean; state: KeywordOptionsViewState }) => void;
    api.apply = vi.fn(() => new Promise<{ accepted: boolean; state: KeywordOptionsViewState }>(resolve => { finish = resolve; }));
    render(<KeywordOptionsApp transport={api} />);
    await userEvent.click(await screen.findByRole('button', { name: '核对并应用' }));
    expect(screen.getAllByText('SID: 42 → 99')).toHaveLength(1);
    const confirm = screen.getByRole('button', { name: '应用修改' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    const dialog = screen.getByRole('dialog');
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(dialog).toBeInTheDocument();
    expect(api.apply).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ accepted: false, state: initial }); });
    expect(screen.getByRole('button', { name: '返回编辑' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '返回编辑' }));
    expect(screen.getByDisplayValue('99')).toBeInTheDocument();
});

test('instance search preserves paths without rendering legacy provenance fields', async () => {
    const initial = instanceDraftState();
    initial.instances = initial.instances.map((instance, i) => ({ ...instance, fileName: 'contact.key',
        filePath: `D:/model/${i ? 'rear' : 'front'}/contact.key`, displayPath: `${i ? 'rear' : 'front'}/contact.key` }));
    Object.assign(initial, { inputFormSource: { schemaVersion: 4, lsPrePostVersion: '4.12', executableSha256: 'abc123fullhash', keyword: '*SET_NODE' } });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByText('First')).toBeVisible();
    expect(screen.queryByText('abc123fullhash')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('更多操作')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '表单来源' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/LS-PrePost|abc123fullhash/);
    await userEvent.click(screen.getByRole('button', { name: '实例 1/2' }));
    await userEvent.type(screen.getByRole('searchbox'), 'rear');
    expect(screen.getByRole('button', { name: /Second · rear\/contact.key/ })).toHaveAttribute('title', 'D:/model/rear/contact.key');
});

test('switches condition explanations between Chinese, original English and explicit fallback', async () => {
    const english = 'Card 3. Include this card if WEARC < 0.';
    const localized = '卡片 3：当 WEARC < 0 时，应包含此卡片。';
    const initial = state({ manualConditions: [{ id: 'wear', condition: 'WEARC < 0', fields: ['WEARC'],
        applicability: 'applicable', cards: ['Card 3'], summaries: [{ english, localized }],
        evidence: [], unresolvedFields: [], reason: null }] });
    const harness = transport(initial);
    render(<KeywordOptionsApp transport={harness.api} />);
    fireEvent.click(await screen.findByRole('button', { name: /卡片条件/ }));
    fireEvent.click(screen.getByText('查看说明'));
    expect(screen.getByText(localized)).toBeVisible();
    expect(screen.getByText(english)).not.toBeVisible();
    fireEvent.click(screen.getByText('English'));
    expect(screen.getByText(english)).toBeVisible();
    act(() => harness.publish({ ...initial, revision: 2, locale: 'en' }));
    expect(screen.queryByText(localized)).not.toBeInTheDocument();
    expect(screen.getByText(english)).toBeVisible();
    act(() => harness.publish({ ...initial, revision: 3, manualConditions: initial.manualConditions!.map(group => ({
        ...group, summaries: [{ english, localized: null }],
    })) }));
    expect(screen.getByText('（暂无已核对中文说明）')).toBeVisible();
    expect(screen.getByText(english)).toBeVisible();
});

test('keeps source conditions separate from native draft cards and opens selected evidence', async () => {
    const initial = state({ status: 'configuring', manualConditions: [{ id: 'fit', condition: 'FIT = 1', fields: ['FIT'],
        applicability: 'not-applicable', cards: ['Card 3b.1', 'Card 3b.2'], summaries: ['Official FIT condition'],
        evidence: [{ ruleId: 'fit', evidenceId: 'e1', page: 42 }], unresolvedFields: [], reason: null }],
        branchSummary: { current: [1, 2, 3], draft: [1, 2, 4, 5] } });
    const harness = transport(initial);
    render(<KeywordOptionsApp transport={harness.api} />);
    const conditionsButton = await screen.findByRole('button', { name: /卡片条件/ });
    expect(screen.queryByText(/源文件 · 原生表单卡片/)).not.toBeInTheDocument();
    expect(screen.queryByText('草稿（尚未应用）：1 → 2 → 4 → 5')).not.toBeInTheDocument();
    expect(conditionsButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('region', { name: '卡片适用条件' })).not.toBeInTheDocument();
    fireEvent.click(conditionsButton);
    expect(screen.getByRole('region', { name: '卡片适用条件' })).toBeVisible();
    expect(screen.getByText('卡片 3b.1 · 卡片 3b.2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '手册第 42 页' }));
    expect(harness.api.openManual).toHaveBeenCalledWith(1, 'fit', 'e1');
    act(() => harness.publish({ ...initial, revision: 2, status: 'stale' }));
    expect(screen.getByRole('button', { name: '手册第 42 页' })).toBeDisabled();
});

test.each(['zh', 'en'] as const)('keeps %s conditions selected while editing and separates unapplied values from source conditions', async locale => {
    const initial = helpState({ locale, manualConditions: [{ id: 'branch', condition: 'A < 0', fields: ['A'],
        applicability: 'indeterminate', cards: ['CRC / CRA'], summaries: ['Long explanation'],
        evidence: [{ ruleId: 'branch', evidenceId: 'e1', page: 42 }], unresolvedFields: ['A'], reason: null }] });
    initial.cards[0].fields.forEach(field => { field.name = 'A'; });
    const { api } = transport(initial);
    const { container } = render(<KeywordOptionsApp transport={api} />);
    const conditions = await screen.findByRole('button', { name: locale === 'zh' ? /卡片条件.*待确认 1/ : /Card conditions.*Unresolved 1/ });
    await userEvent.click(conditions);
    const input = screen.getByDisplayValue('1');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '-1' } });
    expect(conditions).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(locale === 'zh' ? '有未应用的修改；条件仍按文件值判断。' : 'Based on file values; unapplied changes are not included.')).toBeVisible();
    expect(screen.getByText('A < 0')).toBeVisible();
    expect(screen.queryByRole('button', { name: /定位控制字段|Locate control field/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: locale === 'zh' ? '字段说明' : 'Field help' }));
    expect(input).toHaveValue('-1');
    expect(container.querySelector('.fieldValues')).toHaveTextContent(locale === 'zh' ? '原值1修改值-1' : 'Original value1Edited value-1');
    expect(screen.getByText(locale === 'zh' ? '未应用' : 'Unapplied')).toBeVisible();
    expect(api.apply).not.toHaveBeenCalled();
    expect(api.locateSource).not.toHaveBeenCalled();
});

test.each([0, 1, 3])('summarizes %i unresolved conditions without changing edit permission', async count => {
    const initial = helpState({ locale: 'en', canApply: true, hasDrafts: true, manualConditions: Array.from({ length: count }, (_, index) => ({
        id: String(index), condition: 'A < 0', fields: ['A'], applicability: 'indeterminate', cards: [],
        summaries: [], evidence: [], unresolvedFields: ['A'], reason: null,
    })) });
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    await screen.findByRole('button', { name: 'Field help' });
    if (count) {
        const button = screen.getByRole('button', { name: `Card conditions Unresolved ${count}` });
        expect(button).toHaveAttribute('title', `Unresolved ${count} · Applicable 0 · Not applicable 0`);
        await userEvent.click(button);
        await userEvent.click(screen.getByRole('button', { name: 'Collapse card conditions' }));
        expect(screen.queryByRole('region', { name: 'Card applicability' })).not.toBeInTheDocument();
    } else expect(screen.queryByRole('button', { name: /Card conditions/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '应用' })).toBeEnabled();
});


test('shows original value diagnostics without disabling a valid incremental apply', async () => {
    const initial = linkedState(true);
    initial.preview = null;
    initial.cards[0].fields[1].diagnostic = { code: 'number', source: 'original', severity: 'error', blocksApply: false, message: '需要数值' };
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const inputs = await screen.findAllByRole('textbox');
    expect(inputs[1]).not.toHaveAttribute('aria-invalid');
    expect(inputs[1]).toHaveAccessibleDescription('需要数值');
    expect(inputs[1]).not.toHaveAttribute('readonly');
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(api.apply).toHaveBeenCalled();
});

test('keeps an invalid draft editable while preventing application', async () => {
    const initial = linkedState(true);
    initial.status = 'error'; initial.canApply = false; initial.preview = null;
    initial.cards[0].fields[0].diagnostic = { code: 'integer', source: 'draft', severity: 'error', blocksApply: true, message: '需要整数' };
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const inputs = await screen.findAllByRole('textbox');
    expect(inputs[0]).not.toHaveAttribute('readonly');
    expect(inputs[0]).toHaveAccessibleDescription('需要整数');
    expect(screen.getByRole('button', { name: '应用' })).toBeDisabled();
    expect(api.apply).not.toHaveBeenCalled();
});

test('preserves an unknown enum draft and locates unresolved layout evidence', async () => {
    const initial = linkedState();
    initial.cards[0].fields[0] = { ...initial.cards[0].fields[0], value: 'UNKNOWN', draft: 'OTHER', choices: ['0','1'] };
    initial.layoutDiagnostics = [{ code: 'extra', source: 'original', severity: 'warning', blocksApply: true, message: '额外记录', line: 12 }];
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByDisplayValue('OTHER')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '定位源文件 · L13' }));
    expect(api.locateSource).toHaveBeenCalledWith(initial.revision);
});

test.each([true, false])('global reset cancels delayed blur without losing rejected drafts: accepted=%s', async accepted => {
    const initial = instanceDraftState();
    const { api } = transport(initial);
    let finish!: (value: any) => void;
    api.reset = vi.fn(() => new Promise<KeywordOptionsMutationResult>(resolve => { finish = resolve; }));
    render(<KeywordOptionsApp transport={api} />);
    const input = await screen.findByDisplayValue('42');
    fireEvent.change(input, { target: { value: '111' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => expect(api.reset).toHaveBeenCalledTimes(1));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(api.updateField).not.toHaveBeenCalled();
    await act(async () => finish({ accepted, state: { ...initial, revision: 2 } }));
    expect(input).toHaveValue(accepted ? '42' : '111');
    expect(api.updateField).not.toHaveBeenCalled();
});

test('shows missing-record counts and read-only raw records without invented fields', async () => {
    const initial = linkedState();
    initial.canApply = false;
    initial.message = '当前条件要求 11 条数据记录，实际 10 条';
    initial.cards = [];
    initial.layoutDiagnostics = [{ code: 'missing', source: 'original', severity: 'warning', blocksApply: true,
        message: initial.message, actualRecords: 10, expectedRecords: 11, line: 4,
        requiredCards: [{ condition: 'A<0', fields: ['CRC1', 'CRA1'] }] }];
    initial.unresolvedRecords = [{ line: 6, text: '    1.0   2.0' }];
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByRole('region', { name: '字段归属未确定的原文（只读）' })).toHaveTextContent('1.0   2.0', { normalizeWhitespace: false });
    expect(screen.getByText('A<0 → CRC1 / CRA1')).toBeVisible();
    expect(screen.queryByRole('button', { name: '应用' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: '定位源文件 · L5' }));
    expect(api.locateSource).toHaveBeenCalledWith(initial.revision);
    expect(api.apply).not.toHaveBeenCalled();
});


test('shows quiet hints on focus, dismisses with Escape, and hides them while typing', async () => {
    const initial = linkedState();
    initial.cards[0].fields[0].diagnostic = {code:'number',source:'original',severity:'warning',blocksApply:false,message:'Please check'};
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const inputs = await screen.findAllByRole('textbox');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    await userEvent.click(inputs[0]);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Please check');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    fireEvent.change(inputs[0], {target:{value:'1e'}});
    expect(inputs[0].parentElement).not.toHaveClass('hasHint');
    expect(inputs[0]).not.toHaveAttribute('aria-describedby');
    fireEvent.keyDown(inputs[0], {key:'Enter',isComposing:true});
    expect(inputs[0]).toHaveFocus();
});

test('allows parameter text in a suggested-choice field', async () => {
    const initial = linkedState();
    initial.cards[0].fields[0].choices = ['0','1'];
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    const input = await screen.findByRole('combobox');
    await userEvent.clear(input);
    await userEvent.type(input, '&flag');
    expect(input).toHaveValue('&flag');
    expect(input.tagName).toBe('INPUT');
});


test('stale source stays visible and readonly until explicit refresh', async () => {
    const initial = { ...instanceDraftState(), status: 'stale' as const, message: '源内容已更改，请刷新。' };
    const { api } = transport(initial);
    render(<KeywordOptionsApp transport={api} />);
    expect(await screen.findByDisplayValue('42')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '实例 1/2' })).toBeDisabled();
    const refresh = screen.getByRole('button', { name: '刷新' });
    expect(refresh).toBeEnabled();
    await userEvent.click(refresh);
    await waitFor(() => expect(api.reset).toHaveBeenCalledWith(1));
    expect(api.updateField).not.toHaveBeenCalled();
    expect(api.togglePin).not.toHaveBeenCalled();
});
