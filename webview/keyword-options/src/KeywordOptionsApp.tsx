import { userFacingReason } from '../../../src/core/userFacingReason';
import { createPortal } from 'react-dom';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
    KeywordManagerFieldState,
    KeywordManagerHelpState,
    KeywordOptionsViewState,
} from '../../../src/client/keywordOptionsProtocol';
import type { KeywordOptionsTransport } from './transport';
import { ManagerIcon } from './ManagerIcon';
import { ManagerDialog } from './ManagerDialog';
import './styles.css';
import { useFieldHelp } from './useFieldHelp';

function KeywordFieldEditor({ field, busy, resetVersion, cancelBlurVersion, retainedValue, onSelect, onCommit, onLocalChange }: {
    field: KeywordManagerFieldState;
    busy: boolean;
    resetVersion: number;
    cancelBlurVersion: number;
    retainedValue?: string;
    onSelect: (fieldId: string) => void;
    onCommit: (field: KeywordManagerFieldState, value: string, localOnly?: boolean) => Promise<boolean>;
    onLocalChange: (field: KeywordManagerFieldState, value: string) => void;
}) {
    const hostValue = field.draft ?? field.value;
    const [value, setValue] = useState(retainedValue ?? hostValue);
    const previousHost = useRef(hostValue);
    const blurCommit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(blurCommit.current), []);
    useLayoutEffect(() => { clearTimeout(blurCommit.current); }, [cancelBlurVersion]);
    useEffect(() => {
        const previous = previousHost.current;
        setValue(current => current === previous ? hostValue : current);
        previousHost.current = hostValue;
    }, [hostValue]);
    useEffect(() => setValue(retainedValue ?? hostValue), [field.fieldId, resetVersion]);
    const select = (event: React.FocusEvent<HTMLElement>) => {
        event.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        onSelect(field.fieldId);
    };
    const [typing, setTyping] = useState(false);
    const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const diagnosticId = `diagnostic-${field.fieldId}`;
    const diagnostic = !typing && value === hostValue ? field.diagnostic : undefined;
    const showTip = () => {
        const rect = inputRef.current?.getBoundingClientRect();
        if (rect) setTip({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: rect.top });
    };
    return <div className={`fieldEditor${value !== field.value ? ' changed' : ''}${diagnostic ? ' hasHint' : ''}`}>
        <input ref={inputRef} value={value} readOnly={!field.editable || busy}
            list={field.choices?.length ? `choices-${field.fieldId}` : undefined}
            aria-invalid={diagnostic?.blocksApply || undefined}
            aria-describedby={diagnostic ? diagnosticId : undefined}
            onMouseEnter={showTip} onMouseLeave={() => setTip(null)}
            onFocus={event => { select(event); showTip(); }}
            onChange={event => {
                setTyping(true); setTip(null);
                setValue(event.target.value);
                onLocalChange(field, event.target.value);
            }}
            onBlur={() => {
                setTyping(false); setTip(null);
                if (field.editable && value !== hostValue) {
                    clearTimeout(blurCommit.current);
                    blurCommit.current = setTimeout(() => { void onCommit(field, value, true); }, 0);
                }
            }}
            onKeyDown={event => {
                if (event.key === 'Escape') setTip(null);
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
            }} />
        {!!field.choices?.length && <datalist id={`choices-${field.fieldId}`}>
            {field.choices.map(choice => <option key={choice} value={choice} />)}
        </datalist>}
        {diagnostic && <span id={diagnosticId} className="srOnly">{diagnostic.message}</span>}
        {diagnostic && tip && createPortal(<div className="fieldHint" role="tooltip" style={{
            left: tip.left, top: tip.top, transform: 'translateY(calc(-100% - 6px))',
        }}>{diagnostic.message}</div>, document.body)}
    </div>;
}

function FieldHelp({ help, field, locale, value, collapsed, onReset, busy, resetLabel }: {
    help: KeywordManagerHelpState;
    field: KeywordManagerFieldState;
    locale: 'en' | 'zh';
    value: string; collapsed: boolean; onReset: () => void;
    busy: boolean; resetLabel: string;
}) {
    const matches = help.fieldId === field.fieldId;
    const status = matches ? help.status : 'loading';
    const description = locale === 'zh' ? help.localized || help.english : help.english;
    const defaultValue = matches && status === 'ready' ? help.defaultValue ?? field.defaultValue : field.defaultValue;
    const isZh = locale === 'zh';
    const typeLabel = ({ integer: ['整数', 'Integer'], float: ['实数', 'Real'], real: ['实数', 'Real'],
        double: ['实数', 'Real'], string: ['文本', 'Text'], bool: ['布尔值', 'Boolean'],
        '1': ['整数', 'Integer'], '-1': ['整数', 'Integer'], '0': ['文本', 'Text'], '-2': ['文本', 'Text'],
    } as Record<string, string[]>)[field.type.toLowerCase()]?.[isZh ? 0 : 1];
    const messages = {
        'form-unresolved': ['实际记录尚不能唯一确定字段布局。', 'The source records do not determine a unique field layout.'],
        'branch-unverified': ['当前分支尚未确认。', 'The current branch has not been verified.'],
        'branch-help-missing': ['当前分支尚无对应说明。', 'Help is unavailable for the current branch.'],
        'field-unmatched': ['尚未关联到该字段的帮助。', 'Help has not been matched to this field.'],
        'description-missing': ['暂无字段说明。', 'No field description is available.'],
    };
    const unavailable = matches && help.reason
        ? messages[help.reason]?.[locale === 'zh' ? 0 : 1]
        : (locale === 'zh' ? '暂无字段帮助。' : 'Help unavailable.');
    return <aside className="fieldHelp" aria-label={locale === 'zh' ? '字段帮助' : 'Field help'}>
        <div className="fieldHelpHeader">
            <div className="fieldHelpTitle">
                <strong>{field.name}{matches && help.schemaName && help.schemaName !== field.name
                    ? `（${help.schemaName}）` : ''}</strong>
                {typeLabel && <span className="fieldHelpBadge">{typeLabel}</span>}
                {!field.editable && <span className="fieldHelpBadge">{isZh ? '只读' : 'Read-only'}</span>}
                {value !== field.value && <span className="draftBadge">{isZh ? '未应用' : 'Unapplied'}</span>}
                <span className="fieldContext">{isZh ? '卡片' : 'Card'} C{field.cardIndex} · {isZh ? '第 ' : 'Line '}{field.line + 1}{isZh ? ' 行' : ''}</span>
            </div>
            <div className="helpActions">
                {value !== field.value && <button className="iconButton resetField" disabled={busy || !field.editable}
                    title={resetLabel} aria-label={`${resetLabel} ${field.name}`}
                    onMouseDown={event => event.preventDefault()} onClick={onReset}>{resetLabel}</button>}
            </div>
        </div>
        <div id="field-help-body" className="fieldHelpBody" tabIndex={0} hidden={collapsed}
            aria-label={locale === 'zh' ? '字段说明' : 'Field description'}>
            <dl className="fieldValues">
                {value !== field.value && <div><dt>{isZh ? '原值' : 'Original value'}</dt><dd><code>{field.value || (isZh ? '（空）' : '(empty)')}</code></dd></div>}
                <div className="fullValue"><dt>{value !== field.value ? (isZh ? '修改值' : 'Edited value') : (isZh ? '文件值' : 'File value')}</dt><dd><code>{value || (isZh ? '（空）' : '(empty)')}</code></dd></div>
                {defaultValue !== undefined && <div className="helpMeta"><dt>{isZh ? '默认值' : 'Default'}</dt><dd><code>{defaultValue || (isZh ? '（空）' : '(empty)')}</code></dd></div>}
            </dl>
            {!field.editable && <p>{locale === 'zh' ? '该字段当前不可编辑，请在源文件中查看或修改。' : 'This field is not editable here. Inspect or edit it in the source file.'}</p>}
            {!field.editable && field.reason && <details><summary>{locale === 'zh' ? '技术详情' : 'Technical details'}</summary><p>{userFacingReason(field.reason, locale)}</p></details>}
            {status === 'loading' && <p>{locale === 'zh' ? '正在加载…' : 'Loading…'}</p>}
            {(status === 'none' || status === 'unavailable') && <p>{unavailable}</p>}
            {status === 'ready' && <>
                {locale === 'zh' && !help.localized && help.english &&
                    <p className="fieldHelpFallbackNotice">暂无已核对中文说明，显示英文原文：</p>}
                <p className="fieldHelpLocalized">{description || unavailable}</p>
                {locale === 'zh' && help.localized && help.english && help.english !== help.localized &&
                    <details><summary>English</summary><p>{help.english}</p></details>}
                {!!help.choices?.length && <details>
                    <summary>{locale === 'zh' ? '可选值' : 'Choices'} ({help.choices.length})</summary>
                    <p>{help.choices.join(', ')}</p>
                </details>}
            </>}
        </div>
    </aside>;
}

export function KeywordOptionsApp({ transport }: { transport: KeywordOptionsTransport }) {
    const [state, setState] = useState<KeywordOptionsViewState | null>(null);
    const [instanceQuery, setInstanceQuery] = useState('');
    const [instanceDialogOpen, setInstanceDialogOpen] = useState(false);
    const [review, setReview] = useState<{ instanceId: string | null; revision: number } | null>(null);
    const [helpCollapsed, setHelpCollapsed] = useState(false);
    const [detailTopic, setDetailTopic] = useState<'field' | 'conditions'>('field');
    const detailBody = useRef<HTMLDivElement>(null);
    const applicationPending = useRef(false);
    const reviewTrigger = useRef<HTMLButtonElement | null>(null);
    const [pendingMutations, setPendingMutations] = useState(0);
    const [localDraftCount, setLocalDraftCount] = useState(0);
    const [localResetVersion, setLocalResetVersion] = useState(0);
    const [cancelBlurVersion, setCancelBlurVersion] = useState(0);
    const resetPending = useRef(false);
    const [interactionMessage, setInteractionMessage] = useState('');
    const { selectedFieldId, help, message: helpSelectionMessage, selectField } = useFieldHelp(state, transport);
    useLayoutEffect(() => {
        if (detailTopic === 'field' && detailBody.current) detailBody.current.scrollTop = 0;
    }, [selectedFieldId, detailTopic, help.contextKey]);
    useLayoutEffect(() => {
        if (detailBody.current) detailBody.current.scrollTop = 0;
    }, [state?.selectedInstanceId]);
    const instanceTrigger = useRef<HTMLButtonElement>(null);
    const stateRef = useRef<KeywordOptionsViewState | null>(null);
    const localFieldDrafts = useRef(new Map<string, { value: string; hostValue: string; instanceId: string | null }>());
    const fieldSubmissions = useRef(new Map<string, { value: string; result: Promise<boolean> }>());
    const update = useCallback((next: KeywordOptionsViewState) => {
        if (stateRef.current && next.revision < stateRef.current.revision) return;
        if (stateRef.current?.revision === next.revision && stateRef.current.directoryStatus &&
            stateRef.current.directoryStatus !== 'loading' && next.directoryStatus === 'loading') {
            next = { ...next, instances: stateRef.current.instances, directoryStatus: stateRef.current.directoryStatus };
        }
        if (stateRef.current?.selectedInstanceId !== next.selectedInstanceId) {
            setReview(null);
        }
        if (next.selectedInstanceId && !next.instances.some(instance => instance.instanceId === next.selectedInstanceId)) setReview(null);
        stateRef.current = next;
        setState(next);
    }, []);
    const mutate = useCallback(async (operation: () => ReturnType<KeywordOptionsTransport['apply']>) => {
        setPendingMutations(count => count + 1);
        try {
            const result = await operation();
            update(result.state);
            setInteractionMessage(result.accepted ? '' : result.state.message ||
                (result.state.locale === 'zh' ? '操作未完成，请重试。' : 'The operation was not completed. Please retry.'));
            return result.accepted;
        } catch (_error) {
            const locale = stateRef.current?.locale || 'en';
            setInteractionMessage(locale === 'zh' ? '操作未完成，请重试。' : 'The operation was not completed. Please retry.');
            return false;
        } finally {
            setPendingMutations(count => Math.max(0, count - 1));
        }
    }, [update]);
    useEffect(() => {
        let live = true;
        const dispose = transport.onStateChanged(update);
        void transport.ready().then(next => { if (live) update(next); });
        return () => { live = false; dispose(); };
    }, [transport, update]);
    const instances = useMemo(() => {
        const normalized = instanceQuery.trim().toUpperCase();
        return (state?.instances || []).filter(instance => !normalized ||
            `${instance.keyword} ${instance.displayName} ${instance.fileName || ''} ${instance.filePath || ''}`
                .toUpperCase().includes(normalized));
    }, [instanceQuery, state?.instances]);
    if (!state || state.status === 'loading') {
        const isZh = typeof document !== 'undefined' &&
            document.documentElement.lang.toLowerCase().startsWith('zh');
        return (
            <main className="empty" aria-busy="true">
                <p className="emptyMessage" role="status">
                    {isZh ? '正在加载关键字选项…' : 'Loading keyword options…'}
                </p>
            </main>
        );
    }

    const busy = pendingMutations > 0 || state.status === 'applying';
    const instanceIsCurrent = (instanceId: string | null) => {
        if (stateRef.current?.selectedInstanceId === instanceId) return true;
        setInteractionMessage(state.locale === 'zh'
            ? '实例已变化，保留的输入尚未写入。请核对后重新编辑，或取消修改。'
            : 'The instance changed. Your input has been retained but not applied. Review it and edit again, or discard the changes.');
        return false;
    };
    const localDraftIsCurrent = (fieldId: string, hostValue: string, instanceId: string | null) => {
        if (!instanceIsCurrent(instanceId)) return false;
        const current = stateRef.current?.cards.flatMap(card => card.fields).find(field => field.fieldId === fieldId);
        if (current && (current.draft ?? current.value) === hostValue) return true;
        setInteractionMessage(state.locale === 'zh'
            ? '关联字段已变化，请核对保留的输入后重新编辑，或取消修改。'
            : 'A linked field changed. Review your retained input and edit again, or discard the changes.');
        return false;
    };
    const submitField = (fieldId: string, value: string): Promise<boolean> => {
        const active = fieldSubmissions.current.get(fieldId);
        if (active) return active.value === value ? active.result : Promise.resolve(false);
        const instanceId = stateRef.current?.selectedInstanceId ?? null;
        const result = mutate(() => transport.updateField(stateRef.current?.revision ?? state.revision, fieldId, value))
            .then(accepted => {
                if (!accepted || !instanceIsCurrent(instanceId)) return false;
                if (localFieldDrafts.current.get(fieldId)?.value === value) {
                    localFieldDrafts.current.delete(fieldId);
                    setLocalDraftCount(localFieldDrafts.current.size);
                }
                return true;
            }).finally(() => fieldSubmissions.current.delete(fieldId));
        fieldSubmissions.current.set(fieldId, { value, result });
        return result;
    };
    const commitField = async (field: KeywordManagerFieldState, value: string, localOnly = false) => {
        if (localOnly && resetPending.current) return true;
        const pending = localFieldDrafts.current.get(field.fieldId);
        if (localOnly && pending?.value !== value) return true;
        if (pending && !localDraftIsCurrent(field.fieldId, pending.hostValue, pending.instanceId)) return false;
        if (!field.choices?.length && field.draft === undefined && pending?.value !== value) return true;
        const accepted = await submitField(field.fieldId, value);
        if (accepted && !localOnly && value === field.value && pending &&
            localFieldDrafts.current.get(field.fieldId) === pending) {
            localFieldDrafts.current.delete(field.fieldId);
            setLocalDraftCount(localFieldDrafts.current.size);
        }
        return accepted;
    };
    const recordLocalFieldDraft = (field: KeywordManagerFieldState, value: string) => {
        const hostValue = field.draft ?? field.value;
        if (value === hostValue) localFieldDrafts.current.delete(field.fieldId);
        else localFieldDrafts.current.set(field.fieldId, { value, hostValue, instanceId: state.selectedInstanceId });
        setLocalDraftCount(localFieldDrafts.current.size);
    };
    const flushLocalFields = async () => {
        for (const [fieldId, draft] of [...localFieldDrafts.current]) {
            if (!localDraftIsCurrent(fieldId, draft.hostValue, draft.instanceId)) return false;
            if (!await submitField(fieldId, draft.value)) return false;
        }
        return localFieldDrafts.current.size === 0;
    };
    const run = async (operation: (revision: number) => ReturnType<KeywordOptionsTransport['apply']>) => {
        if (!await flushLocalFields()) return false;
        return mutate(() => operation(stateRef.current?.revision ?? state.revision));
    };
    const needsReview = (current: KeywordOptionsViewState) =>
        current.preview?.reviewLevel === 'destructive' || !!current.preview?.sharedByteChanges?.length;
    const canSubmit = (current: KeywordOptionsViewState) =>
        current.canApply && !['stale', 'error', 'applying'].includes(current.status);
    const apply = async (inspect = false) => {
        if (applicationPending.current || busy || ['stale', 'error', 'applying'].includes(stateRef.current!.status)) return;
        applicationPending.current = true;
        try {
            if (!await flushLocalFields()) return;
            const current = stateRef.current!;
            if (inspect || needsReview(current)) {
                setInstanceDialogOpen(false);
                setReview({ instanceId: current.selectedInstanceId, revision: current.revision });
                return;
            }
            if (canSubmit(current)) await mutate(() => transport.apply(current.revision));
        } finally { applicationPending.current = false; }
    };
    const confirmReview = async () => {
        const current = stateRef.current!;
        if (!review || busy || applicationPending.current || !canSubmit(current)) return;
        if (review.instanceId !== current.selectedInstanceId) { setReview(null); return; }
        if (review.revision !== current.revision) {
            setReview({ instanceId: current.selectedInstanceId, revision: current.revision });
            setInteractionMessage(state.locale === 'zh' ? '修改内容已更新，请重新核对后应用。' : 'The proposed changes have been updated. Review them again before applying.');
            return;
        }
        applicationPending.current = true;
        try {
            if (await mutate(() => transport.apply(review.revision))) setReview(null);
        } finally { applicationPending.current = false; }
    };
    const reset = async () => {
        if (resetPending.current) return;
        resetPending.current = true;
        setCancelBlurVersion(version => version + 1);
        try {
            // A late blur response must finish before reset, never resurrect the cancelled draft.
            await Promise.all([...fieldSubmissions.current.values()].map(submission => submission.result));
            if (!await mutate(() => transport.reset(stateRef.current?.revision || state.revision))) return;
            localFieldDrafts.current.clear();
            setLocalDraftCount(0);
            setLocalResetVersion(version => version + 1);
        } finally { resetPending.current = false; }
    };

    const closeInstanceDialog = () => {
        setInstanceDialogOpen(false);
        setTimeout(() => instanceTrigger.current?.focus(), 0);
    };
    const sendDimension = (dimensionId: string, values: string[]) =>
        run(revision => transport.selectDimension(revision, dimensionId, values));
    const cards = state.cards || [];
    const fields = cards.flatMap(card => card.fields || []);
    const selectedField = fields.find(field => field.fieldId === selectedFieldId);
    const selectedValue = selectedField ? localFieldDrafts.current.get(selectedField.fieldId)?.value ?? selectedField.draft ?? selectedField.value : '';
    const resetSelectedField = async () => {
        if (!selectedField || busy) return;
        setCancelBlurVersion(version => version + 1);
        const pending = localFieldDrafts.current.get(selectedField.fieldId);
        if (pending && !localDraftIsCurrent(selectedField.fieldId, pending.hostValue, pending.instanceId)) return;
        if (selectedField.draft !== undefined && !await submitField(selectedField.fieldId, selectedField.value)) return;
        if (localFieldDrafts.current.get(selectedField.fieldId) === pending) localFieldDrafts.current.delete(selectedField.fieldId);
        setLocalDraftCount(localFieldDrafts.current.size);
        setLocalResetVersion(version => version + 1);
    };
    const instancesList = state.instances || [];
    const selectedInstance = instancesList.find(instance => instance.instanceId === state.selectedInstanceId);
    const instanceIndex = Math.max(0, instancesList.findIndex(instance => instance.instanceId === state.selectedInstanceId));
    const visibleCards = cards.filter(card => (card.fields || []).length > 0);
    const previewDetailLabels = {
        keyword: state.labels.keywordLine,
        cards: state.labels.cards,
        fields: state.labels.fields,
        migrated: state.labels.migrated,
        added: state.labels.added,
        discarded: state.labels.discarded,
        comments: state.labels.comments,
    };
    const preview = state.preview;
    const reviewLevel = preview?.reviewLevel || 'none';
    const reviewSummary = localDraftCount > 0
        ? (state.locale === 'zh' ? `正在编辑 ${localDraftCount} 个字段` : `${localDraftCount} ${localDraftCount === 1 ? 'field' : 'fields'} being edited`)
        : !preview || reviewLevel === 'none'
        ? (state.locale === 'zh' ? '没有修改' : 'No changes')
        : reviewLevel === 'field'
            ? (state.locale === 'zh' ? `已修改 ${preview.changedFields} 个字段` : `${preview.changedFields} ${preview.changedFields === 1 ? 'field' : 'fields'} changed`)
            : reviewLevel === 'destructive'
                ? (state.locale === 'zh' ? `将丢弃 ${preview.discarded} 个非空字段` : `${preview.discarded} non-empty ${preview.discarded === 1 ? 'field' : 'fields'} will be discarded`)
                : preview.targetKeyword !== state.currentKeyword
                    ? (state.locale === 'zh' ? `关键字将改为 ${preview.targetKeyword}` : `Keyword will change to ${preview.targetKeyword}`)
                    : (state.locale === 'zh' ? '卡片结构将调整' : 'Card structure will change');
    const seenDetails = new Set<string>();
    const details = preview ? [
        ['linked', preview.sharedByteChanges || []] as const,
        ...Object.entries(preview.details),
    ].map(([kind, values]) => [kind, values.filter(value => {
        if (seenDetails.has(value)) return false;
        seenDetails.add(value); return true;
    })] as const).filter(([, values]) => values.length > 0) : [];
    const isZh = state.locale === 'zh';
    const conditions = state.manualConditions || [];
    const pendingConditions = conditions.filter(group => !['applicable', 'not-applicable'].includes(group.applicability)).length;
    const applicableConditions = conditions.filter(group => group.applicability === 'applicable').length;
    const conditionSummary = isZh
        ? `待确认 ${pendingConditions} · 适用 ${applicableConditions} · 不适用 ${conditions.length - pendingConditions - applicableConditions}`
        : `Unresolved ${pendingConditions} · Applicable ${applicableConditions} · Not applicable ${conditions.length - pendingConditions - applicableConditions}`;
    const showingConditions = detailTopic === 'conditions' && conditions.length > 0;
    const toggleDetailLabel = showingConditions
        ? (isZh ? (helpCollapsed ? '展开卡片条件' : '折叠卡片条件') : (helpCollapsed ? 'Expand card conditions' : 'Collapse card conditions'))
        : (isZh ? (helpCollapsed ? '展开字段帮助' : '折叠字段帮助') : (helpCollapsed ? 'Expand field help' : 'Collapse field help'));


    const showFooter = localDraftCount > 0 || state.hasDrafts || reviewLevel !== 'none' || state.status === 'applying';

    return <main aria-busy={busy}>
        <header>
            <div className="headerIdentity">
                <div className="keyword" title={state.currentKeyword}>{state.currentKeyword
                    ? state.currentKeyword.split('_').map((part, index) => <Fragment key={index}>{index > 0 && <>_<wbr /></>}{part}</Fragment>) : '-'}</div>
                {selectedInstance?.displayName && <div className="instanceIdentity" title={selectedInstance.displayName}>{selectedInstance.displayName}</div>}
            </div>
                {state.instances.length > 0 && <button ref={instanceTrigger} className="headerButton instanceTrigger"
                    aria-haspopup="dialog" aria-expanded={instanceDialogOpen}
                    disabled={busy || state.status === 'stale' || state.directoryStatus === 'loading' || state.directoryStatus === 'error'}
                    onClick={() => { setReview(null); setInstanceDialogOpen(true); }}>
                    {state.directoryStatus === 'loading' ? (isZh ? '正在加载实例…' : 'Loading instances…') :
                        state.directoryStatus === 'error' ? (isZh ? '实例加载失败' : 'Instance loading failed') :
                        `${isZh ? '实例' : 'Instance'} ${instanceIndex + 1}/${state.instances.length}`}
                    <ManagerIcon name="expand" />
                </button>}
            <div className="headerContext">
                <button className="sourceLocation" title={selectedInstance?.filePath || state.labels.locateSource} aria-label={state.labels.locateSource} disabled={busy} onClick={() => void transport.locateSource(state.revision)}>
                    {selectedInstance ? <><span>{selectedInstance.displayPath || selectedInstance.fileName || selectedInstance.filePath || ''}</span><span>:{selectedInstance.line + 1}</span></> : state.labels.locateSource}
                </button>
            <div className="headerActions">
                <button className="headerButton" title={isZh ? '重新读取当前实例；有草稿时请先取消修改' : 'Reload this instance; cancel drafts first'}
                    disabled={busy || state.hasDrafts || localDraftCount > 0} onClick={() => void reset()}>
                    <span>{isZh ? '刷新' : 'Refresh'}</span>
                </button>
                <button className="headerButton manualButton" title={state.labels.openManual} aria-label={state.labels.openManual} disabled={busy} onClick={() => void transport.openManual(state.revision)}>
                    <ManagerIcon name="manual" /><span>{isZh ? '手册' : 'Manual'}</span>
                </button>

            </div>
            </div>
        </header>

        <div className="formScroll">

        {instanceDialogOpen && <ManagerDialog className="instanceDialog" onClose={closeInstanceDialog}
                label={state.locale === 'zh' ? '选择关键字实例' : 'Select keyword instance'}>
                <div className="dialogHeader">
                    <strong>{state.locale === 'zh' ? '选择关键字实例' : 'Select keyword instance'}</strong>
                    <button className="closeButton" aria-label={state.locale === 'zh' ? '关闭' : 'Close'}
                        onClick={closeInstanceDialog}><ManagerIcon name="close" /></button>
                </div>
                <div className="scopeSegments" role="group" aria-label={state.labels.scope}>
                    <button className={state.scope === 'file' ? 'selected' : ''}
                        disabled={busy || state.status === 'stale'}
                        onClick={() => run(revision => transport.selectScope(revision, 'file'))}>{state.labels.currentFile}</button>
                    <button className={state.scope === 'project' ? 'selected' : ''}
                        disabled={busy || state.scopeStatus === 'loading' || state.scopeStatus === 'partial'}
                        title={isZh ? '主文件及其引用文件' : 'Main deck and its include files'}
                        onClick={() => run(revision => transport.selectScope(revision, 'project'))}>{state.labels.currentProject}</button>
                </div>
                {state.scopeStatus !== 'ready' && <p className="scopeMessage" role="status">
                    {state.scopeMessage || (state.scopeStatus === 'loading' ? state.labels.scopeLoading : '')}
                </p>}
                <input data-initial-focus type="search" value={instanceQuery} aria-label={state.labels.search}
                    placeholder={state.labels.search} onChange={event => setInstanceQuery(event.target.value)} />
                <nav className="instanceList" aria-label={state.locale === 'zh' ? '关键字实例' : 'Keyword instances'}>
                    {instances.map(instance => <button key={instance.instanceId} title={instance.filePath}
                        disabled={busy || (state.scope === 'project' && state.scopeStatus !== 'ready')}
                        aria-current={instance.selected ? 'true' : undefined} className={instance.selected ? 'selected' : ''}
                        onClick={async () => {
                            if (await run(revision => transport.selectInstance(revision, instance.instanceId))) closeInstanceDialog();
                        }}>
                        <span>{instance.keyword}</span>
                        <small>{[instance.displayName, instance.displayPath || instance.fileName || instance.filePath,
                            `${state.locale === 'zh' ? '行' : 'Line'} ${instance.line + 1}`,
                            instance.dirty ? state.labels.dirty : '', instance.readonly ? state.labels.readonly : '']
                            .filter(Boolean).join(' · ')}</small>
                    </button>)}
                    {instances.length === 0 && <p className="emptyList">
                        {state.locale === 'zh' ? '没有匹配的实例。' : 'No matching instances.'}
                    </p>}
                </nav>
        </ManagerDialog>}

        {state.mode === 'dimensions' && (state.dimensions || []).length > 0 && <section className="options" aria-label="options">
            <div className="controlsGrid">
                {(state.dimensions || []).map(dimension => <div className="dimension" key={dimension.dimensionId}>
                    {!(dimension.selectionMode === 'multiple' && dimension.values.length === 1) &&
                        <label className="dimensionLabel" title={dimension.label}>{dimension.label}</label>}
                    {dimension.selectionMode === 'single' ?
                        <select value={dimension.values.find(value => value.selected)?.valueId || ''} disabled={busy || state.status === 'stale'}
                            title={`${dimension.label}: ${dimension.values.find(value => value.selected)?.label || '-'}`}
                            onChange={event => sendDimension(dimension.dimensionId, event.target.value ? [event.target.value] : [])}>
                            {!dimension.required && <option value="">-</option>}
                            {dimension.values.map(value => <option key={value.valueId} value={value.valueId}
                                disabled={!value.enabled}>{value.label}</option>)}
                        </select> :
                        <div className="checks">{dimension.values.map(value => <label key={value.valueId}
                            className={value.enabled ? '' : 'disabled'} title={value.label}>
                            <input type="checkbox" checked={value.selected} disabled={busy || state.status === 'stale' || !value.enabled}
                                onChange={event => {
                                    const selected = new Set(dimension.values.filter(item => item.selected).map(item => item.valueId));
                                    if (event.target.checked) selected.add(value.valueId); else selected.delete(value.valueId);
                                    sendDimension(dimension.dimensionId, [...selected]);
                                }} /> {value.label}
                        </label>)}</div>}
                </div>)}
            </div>
        </section>}
        {state.mode === 'search' && (state.targets || []).length > 1 && <section className="options">
            <label className="dimensionLabel" htmlFor="targetKeyword">{state.labels.result}</label>
            <select id="targetKeyword" disabled={busy || state.status === 'stale'}
                value={(state.targets || []).find(target => target.selected)?.targetKeyword || state.targetKeyword}
                onChange={event => {
                    const value = event.target.value;
                    run(revision => transport.selectTarget(revision, value));
                }}>
                {(state.targets || []).map(target => <option key={target.targetKeyword} value={target.targetKeyword}>
                    {target.targetKeyword}
                </option>)}
            </select>
        </section>}
        {(state.formCandidates?.length ?? 0) > 0 && <section className="options" aria-label={isZh ? "表单选择" : "Form selection"}>
            <label className="dimensionLabel" htmlFor="inputFormRule">
                {state.locale === 'zh' ? '表单布局' : 'Form layout'}
            </label>
            <select id="inputFormRule" disabled value="">
                <option value="">{state.locale === 'zh' ? '实际记录无法唯一确定布局' : 'The source records do not determine a unique layout'}</option>
                {(state.formCandidates || []).map(candidate => <option key={candidate.ruleId} value={candidate.ruleId}>
                    {candidate.label}
                </option>)}
            </select>
        </section>}
        {(state.controls || []).some(control => control.visible && control.kind !== 'field') &&
        <section className="options" aria-label={isZh ? "表单选项" : "Form controls"}>
            <div className="controlsGrid">
                {(state.controls || []).filter(control => control.visible && control.kind !== 'field').map(control =>
                    <div className="dimension" key={control.controlId}>
                        {control.kind === 'boolean' ?
                                <label className="dynamicToggle" title={control.label}>
                                    <input type="checkbox" checked={control.value === true} disabled={busy || state.status === 'stale' || !control.enabled}
                                        onChange={event => {
                                            const value = event.target.checked;
                                            run(revision => transport.updateControl(revision, control.controlId, value));
                                        }} />
                                    <span>{control.label}</span>
                                </label> : <>
                                    <label className="dimensionLabel" htmlFor={`inputForm-${control.controlId}`} title={control.label}>
                                        {control.label}
                                    </label>
                                    <select id={`inputForm-${control.controlId}`} value={String(control.value ?? '')}
                                        disabled={busy || state.status === 'stale' || !control.enabled}
                                        title={`${control.label}: ${String(control.value ?? '-')}`}
                                        onChange={event => {
                                            const value = event.target.value;
                                            run(revision => transport.updateControl(revision, control.controlId, value));
                                        }}>
                                        <option value="">-</option>
                                        {(control.choices || []).map(value => <option key={value.value} value={value.value}
                                            disabled={!value.enabled}>{value.label}</option>)}
                                    </select>
                                </>}
                    </div>)}
            </div>
        </section>}
        {(state.postChoices || []).length > 1 && !(state.controls || []).some(control => control.kind === 'selector') &&
        <section className="options">
            <label className="dimensionLabel" htmlFor="postCardCount">{state.labels.postCards}</label>
            <select id="postCardCount" value={String(state.targetPostCount)} disabled={busy || state.status === 'stale'}
                onChange={event => {
                    const value = Number(event.target.value);
                    run(revision => transport.selectPostCount(revision, value));
                }}>
                {(state.postChoices || []).map(choice => <option key={choice.targetPostCount}
                    value={choice.targetPostCount} disabled={!choice.enabled} title={choice.reason}>{choice.label}</option>)}
            </select>
        </section>}
        {(state.layoutDiagnostics || []).length > 0 && <button className="layoutDiagnosticLocation"
            onClick={() => void transport.locateSource(state.revision)} disabled={busy || state.status === 'stale'}>
            {state.labels.locateSource}{state.layoutDiagnostics?.[0]?.line !== undefined ? ` · L${state.layoutDiagnostics[0].line + 1}` : ''}
        </button>}
        {(interactionMessage || state.message) && state.status !== 'no-options'  && state.status !== 'empty' &&
            <p className={`message ${state.status}`} role="status">{interactionMessage || state.message}</p>}
        {(state.layoutDiagnostics || []).flatMap(diagnostic => diagnostic.controls || []).map(control =>
            <button className="layoutControl" key={control.fieldId} disabled={busy || state.status === 'stale'}
                onClick={() => void selectField(control.fieldId)}>
                {control.name} = {control.value || '∅'} · L{control.line + 1}</button>)}
        {(state.layoutDiagnostics || []).flatMap(diagnostic => diagnostic.requiredCards || []).map((card, index) =>
            <p className="requiredCard" key={index}>{card.condition} → {card.fields.join(' / ')}</p>)}
        {(state.unresolvedRecords || []).length > 0 && <section className="unresolvedRecords"
            aria-label={state.locale === 'zh' ? '字段归属未确定的原文（只读）' : 'Unresolved source records (read-only)'}>
            <h3>{state.locale === 'zh' ? '字段归属未确定的原文（只读）' : 'Unresolved source records (read-only)'}</h3>
            {state.unresolvedRecords!.map(record => <pre key={record.line}><span>L{record.line + 1} </span>{record.text}</pre>)}
        </section>}
        {visibleCards.length > 0 && <div className="editorLayout">
            <section className="cards" aria-label={isZh ? '卡片与字段' : 'Cards and fields'}>
                {visibleCards.map(card => {
                    const visibleFields = card.fields.filter(field => field.visible !== false);
                    const cardTitleFull = `Card ${card.cardIndex}${card.cardIndex === 0 ? ' · ID / TITLE' : ''}${card.occurrenceIndex
                        ? ` · ${state.locale === 'zh' ? '记录' : 'Row'} ${card.occurrenceIndex}` : ''}`;
                    const gutterShort = card.cardIndex === 0 ? 'C0' : `C${card.cardIndex}${card.occurrenceIndex ? `.${card.occurrenceIndex}` : ''}`;
                    return <div className="card" key={`${card.cardIndex}:${card.occurrenceIndex || 0}:${card.line}`}>
                        <div className="cardRow">
                            <div className="cardGutter" title={cardTitleFull}>
                                <span className="gutterShort">{gutterShort}</span>
                                <span className="cardTitle srOnly">{cardTitleFull}</span>
                            </div>
                            <div className="cardScroller">
                                <div className="fieldGrid">
                                    {visibleFields.map(field => <label
                                        className={`field${!field.editable ? ' disabled' : ''}${field.fieldId === selectedFieldId ? ' helpSelected' : ''}`}
                                        data-field-id={field.fieldId}
                                        style={{
                                            gridColumn: `${field.position + 1} / span ${field.width}`,
                                        }}
                                        key={field.fieldId}>
                                        <span title={field.name || `Field ${field.position}`}>{field.name || `Field ${field.position}`}</span>
                                        {!!field.linkedFields?.length && <small title={field.linkedFields.join(', ')}>
                                            {state.locale === 'zh' ? '联动：' : 'Linked: '}{field.linkedFields.join(', ')}
                                        </small>}
                                        <KeywordFieldEditor field={field} busy={busy || state.status === 'stale'} resetVersion={localResetVersion} cancelBlurVersion={cancelBlurVersion} onSelect={selectField}
                                            retainedValue={localFieldDrafts.current.get(field.fieldId)?.value}
                                            onCommit={commitField} onLocalChange={recordLocalFieldDraft} />
                                    </label>)}
                                </div>
                            </div>
                        </div>
                    </div>;
                })}
            </section>
        </div>}
        {visibleCards.length === 0 && (state.cards || []).length > 0 && <p className="emptyMessage">
            {state.locale === 'zh' ? '该结构暂不支持表单编辑，请在源文件中修改。' :
                'This structure is not available for form editing; edit it in the source file.'}
        </p>}
        {(state.status === 'empty' || (state.status === 'no-options' && (state.cards || []).length === 0)) &&
            <p className="emptyMessage">{state.message || state.labels.noOptions}</p>}
        </div>
        <span className="srOnly" aria-live="polite" aria-atomic="true">{selectedField
            ? `${state.locale === 'zh' ? '字段帮助：' : 'Field help: '}${selectedField.name}` : ''}</span>
        {helpSelectionMessage && <p className="message" role="status">{helpSelectionMessage}</p>}
        {(selectedField || conditions.length > 0) && <section className="detailsDock" aria-label={isZh ? '字段与卡片详情' : 'Field and card details'}>
        <div className="detailsToolbar">
            <div className="detailTopics" role="group" aria-label={isZh ? '详情内容' : 'Detail content'}>
                <button className={!showingConditions ? 'selected' : ''} aria-pressed={!showingConditions}
                    aria-controls="manager-detail-body" onClick={() => { setDetailTopic('field'); setHelpCollapsed(false); }}>
                    {isZh ? '字段说明' : 'Field help'}</button>
                {conditions.length > 0 && <button className={showingConditions ? 'selected' : ''}
                    aria-pressed={showingConditions} aria-controls="manager-detail-body" title={conditionSummary}
                    onClick={() => { setDetailTopic('conditions'); setHelpCollapsed(false); if (detailBody.current) detailBody.current.scrollTop = 0; }}>
                    {isZh ? '卡片条件' : 'Card conditions'}{' '}
                    <span className={pendingConditions ? 'conditionCount pending' : 'conditionCount'}>
                        {pendingConditions ? (isZh ? `待确认 ${pendingConditions}` : `Unresolved ${pendingConditions}`) : conditions.length}
                    </span></button>}
            </div>
            <button className="iconButton" title={toggleDetailLabel} aria-label={toggleDetailLabel}
                aria-expanded={!helpCollapsed} aria-controls="manager-detail-body"
                onClick={() => setHelpCollapsed(value => !value)}><ManagerIcon name={helpCollapsed ? 'expand' : 'collapse'} /></button>
        </div>
        <div className="detailViewport" id="manager-detail-body" ref={detailBody}>
        <div hidden={showingConditions}>
        {selectedField ? <FieldHelp key={JSON.stringify([state.selectedInstanceId, selectedField.fieldId, help.contextKey])}
            help={help} field={selectedField} locale={state.locale} value={selectedValue}
            collapsed={helpCollapsed}
            onReset={() => void resetSelectedField()} busy={busy} resetLabel={state.labels.resetField} />
            : <p className="detailEmpty" hidden={helpCollapsed}>{isZh ? '选择字段，查看说明和文件值。' : 'Select a field to see its description and file value.'}</p>}
        </div>
        <section className="manualConditions" hidden={!showingConditions || helpCollapsed} aria-label={isZh ? '卡片适用条件' : 'Card applicability'}>
            <p className="conditionContext">{state.hasDrafts || localDraftCount > 0
                ? (isZh ? '有未应用的修改；条件仍按文件值判断。' : 'Based on file values; unapplied changes are not included.')
                : (isZh ? '以下条件按文件值判断。' : 'Conditions below use the file values.')}</p>
            {conditions.map(group => <section className="conditionItem" key={group.id}>
                <div className="conditionHeading"><strong>{group.condition || (isZh ? '手册条件' : 'Manual condition')}</strong>
                <span className={`conditionStatus ${['applicable', 'not-applicable'].includes(group.applicability) ? group.applicability : 'pending'}`}>
                    {group.applicability === 'applicable' ? (isZh ? '适用' : 'Applicable') :
                    group.applicability === 'not-applicable' ? (isZh ? '不适用' : 'Not applicable') : (isZh ? '待确认' : 'Unresolved')}</span></div>
                {group.cards.length > 0 && <p className="conditionCards"><span>{isZh ? '相关卡片' : 'Related cards'}: </span>{group.cards.map(c => isZh ? c.replace(/^Cards?\s+(?=[0-9A-Za-z])/i, '卡片 ') : c).join(' · ')}</p>}
                {group.applicability === 'indeterminate' && <p>{group.reason === 'unsupported-format'
                    ? (isZh ? '此输入格式尚未验证条件读取。' : 'Condition reading is not verified for this input format.')
                    : group.reason === 'scan-truncated' ? (isZh ? '读取达到上限，条件上下文不完整。' : 'Reading limit reached; condition context is incomplete.')
                    : (isZh ? '控制值、参数或关键字选项尚不能可靠求值。' : 'Control values, parameters or keyword options cannot be evaluated reliably.')}
                    {' '}{group.unresolvedFields.filter(field => group.fields.includes(field)).join(', ')}</p>}
                {group.summaries.length > 0 && <details className="conditionExplanation"><summary>{isZh ? '查看说明' : 'Show explanation'}</summary>
                    {group.summaries.map((item: any) => {
                        const english = typeof item === 'string' ? item : item.english;
                        const localized = typeof item === 'string' ? null : item.localized;
                        if (isZh) {
                            if (localized) {
                                return <div key={english} className="conditionExplanationItem">
                                    <p>{localized}</p>
                                    <details className="conditionOriginalEnglish"><summary>English</summary><p>{english}</p></details>
                                </div>;
                            }
                            return <div key={english} className="conditionExplanationItem">
                                <p>{english}</p>
                                <p className="conditionUntranslatedHint">（暂无已核对中文说明）</p>
                            </div>;
                        }
                        return <p key={english}>{english}</p>;
                    })}</details>}
                <div className="conditionActions">
                {group.evidence.map(evidence => <button key={evidence.evidenceId} disabled={busy || state.status === 'stale'}
                    onClick={() => void transport.openManual(state.revision, group.id, evidence.evidenceId)}>
                    {isZh ? '手册第 ' : 'Manual p. '}{evidence.page}{isZh ? ' 页' : ''}
                </button>)}
                </div>
            </section>)}
            <div className="conditionOverview">{conditionSummary}</div>
            <details className="conditionExplanation"><summary>{isZh ? '关于卡片编号' : 'About card numbers'}</summary>
                <p>{isZh ? '手册与编辑表格的卡片编号可能不同。条件适用不代表相关卡片已完整填写。' : 'Card numbers may differ between the manual and the editing table. An applicable condition does not mean the related cards are complete.'}</p></details>
        </section>
        </div>
        </section>}
        {showFooter && <footer>
            <div className={reviewLevel === 'destructive' ? 'reviewSummary danger' : 'reviewSummary'}>
                <span>{reviewSummary}</span>
            </div>
            <div className="footerActions">
                <button disabled={busy || ['stale', 'error'].includes(state.status)} onMouseDown={event => event.preventDefault()}
                    onClick={event => { reviewTrigger.current = event.currentTarget; void apply(true); }}>{isZh ? '查看修改' : 'View changes'}</button>
                <button disabled={busy || (reviewLevel === 'none' && !state.hasDrafts && localDraftCount === 0)}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => void reset()}>
                    {state.labels.reset}
                </button>
                <button className="primary" disabled={busy || ['stale', 'error'].includes(state.status) || (!state.canApply && localDraftCount === 0)}
                    onMouseDown={event => event.preventDefault()}
                    onClick={event => { reviewTrigger.current = event.currentTarget; void apply(); }}>{state.status === 'applying'
                        ? (state.locale === 'zh' ? '正在应用…' : 'Applying…') : needsReview(state) ? (isZh ? '核对并应用' : 'Review and apply') : state.labels.apply}</button>
            </div>
        </footer>}
        {review && <ManagerDialog className="reviewDialog" label={isZh ? '核对修改' : 'Review changes'}
            busy={busy} restoreFocus={reviewTrigger.current} onClose={() => setReview(null)}>
            <div className="dialogHeader">
                <strong tabIndex={-1} data-initial-focus>{isZh ? '核对修改' : 'Review changes'}</strong>
                <button className="iconButton" disabled={busy} title={isZh ? '关闭' : 'Close'} aria-label={isZh ? '关闭' : 'Close'}
                    onClick={() => setReview(null)}><ManagerIcon name="close" /></button>
            </div>
            <div className="reviewBody">
                <p className={reviewLevel === 'destructive' ? 'danger' : ''}>{reviewSummary}</p>
                {reviewLevel === 'destructive' && <p>{isZh ? '继续后还需确认丢弃非空数据。' : 'Continuing requires a final confirmation before discarding non-empty data.'}</p>}
                {review.revision !== state.revision && <p role="status">{isZh ? '修改内容已更新，请重新核对。' : 'The proposed changes have been updated. Review them again.'}</p>}
                {(interactionMessage || state.message) && <p role="status">{interactionMessage || state.message}</p>}
                {details.map(([kind, values]) => <section className="detailGroup" key={kind}
                    aria-label={kind === 'linked' ? (isZh ? '联动修改' : 'Linked changes') : undefined}>
                    <strong>{kind === 'linked' ? (isZh ? '联动修改' : 'Linked changes') : previewDetailLabels[kind as keyof typeof previewDetailLabels]}</strong>
                    <ul>{values.map((value, index) => <li key={index}>{value}</li>)}</ul>
                </section>)}
            </div>
            <div className="dialogActions">
                <button disabled={busy} onClick={() => setReview(null)}>{isZh ? '返回编辑' : 'Back to editing'}</button>
                <button className="primary" disabled={busy || !canSubmit(state)} onClick={() => void confirmReview()}>
                    {busy ? (isZh ? '正在应用…' : 'Applying…') : (isZh ? '应用修改' : 'Apply changes')}</button>
            </div>
        </ManagerDialog>}
    </main>;
}
