import { userFacingReason } from '../../../src/core/userFacingReason';
import { createPortal } from 'react-dom';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type {
    KeywordManagerFieldState,
    KeywordManagerHelpState,
    KeywordOptionsViewState,
} from '../../../src/client/keywordOptionsProtocol';
import type { KeywordOptionsTransport } from './transport';
import { InstanceSelector } from './InstanceSelector';
import { ManagerIcon } from './ManagerIcon';
import { ManagerDialog } from './ManagerDialog';
import './styles.css';
import { useFieldHelp } from './useFieldHelp';
import { FieldHelpContent } from '../../shared/FieldHelpContent';

function KeywordFieldEditor({ field, busy, resetVersion, cancelBlurVersion, retainedValue, onSelect, onCommit, onLocalChange, isZh }: {
    isZh: boolean;
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
    const listId = useId();
    const [choicesOpen, setChoicesOpen] = useState(false);
    const [activeChoice, setActiveChoice] = useState(0);
    const [choicePosition, setChoicePosition] = useState<{ left: number; top: number; width: number; maxHeight: number }>();
    const choices = field.choices || [];
    const canChoose = field.editable && !busy && choices.length > 0;
    const choose = (index: number) => {
        const selected = choices[index];
        if (selected === undefined || !canChoose) return;
        setValue(selected); setTyping(true); setChoicesOpen(false);
        onLocalChange(field, selected);
        inputRef.current?.focus();
    };
    const openChoices = () => {
        if (!canChoose) return;
        setTip(null); setActiveChoice(Math.max(0, choices.indexOf(value))); setChoicesOpen(true);
    };
    useLayoutEffect(() => {
        if (!choicesOpen) return;
        const list = document.getElementById(listId);
        const option = document.getElementById(`${listId}-${activeChoice}`);
        if (!list || !option) return;
        if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
        else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight)
            list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }, [choicesOpen, activeChoice, choicePosition, listId]);
    useLayoutEffect(() => {
        if (!choicesOpen || !canChoose) { setChoicesOpen(false); return; }
        const position = () => {
            const rect = inputRef.current?.getBoundingClientRect();
            if (!rect || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) {
                setChoicesOpen(false); return;
            }
            const below = innerHeight - rect.bottom - 4;
            const above = rect.top - 4;
            const height = Math.min(240, Math.max(below, above), choices.length * 28 + 2);
            const width = Math.min(Math.max(rect.width, 160), innerWidth - 8);
            setChoicePosition({ left: Math.max(4, Math.min(rect.left, innerWidth - width - 4)),
                top: below >= height ? rect.bottom : Math.max(4, rect.top - height), width, maxHeight: height });
        };
        position();
        window.addEventListener('resize', position);
        window.addEventListener('scroll', position, true);
        const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position);
        if (inputRef.current) observer?.observe(inputRef.current);
        return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); observer?.disconnect(); };
    }, [choicesOpen, canChoose, choices.length]);
    useEffect(() => { setChoicesOpen(false); }, [field.fieldId, resetVersion]);
    useEffect(() => {
        if (choicesOpen) document.getElementById(`${listId}-${activeChoice}`)?.scrollIntoView?.({ block: 'nearest' });
    }, [choicesOpen, activeChoice, listId]);
    const diagnosticId = `diagnostic-${field.fieldId}`;
    const diagnostic = !typing && value === hostValue ? field.diagnostic : undefined;
    const showTip = () => {
        const rect = inputRef.current?.getBoundingClientRect();
        if (rect) setTip({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: rect.top });
    };
    return <div className={`fieldEditor${value !== field.value ? ' changed' : ''}${diagnostic ? ' hasHint' : ''}`}>
        <input ref={inputRef} value={value} readOnly={!field.editable || busy}
            role={choices.length ? 'combobox' : undefined} aria-label={field.name}
            aria-expanded={choices.length ? choicesOpen : undefined} aria-autocomplete={choices.length ? 'none' : undefined}
            aria-controls={choicesOpen ? listId : undefined}
            aria-activedescendant={choicesOpen ? `${listId}-${activeChoice}` : undefined}
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
                setChoicesOpen(false);
                setTyping(false); setTip(null);
                if (field.editable && value !== hostValue) {
                    clearTimeout(blurCommit.current);
                    blurCommit.current = setTimeout(() => { void onCommit(field, value, true); }, 0);
                }
            }}
            onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (canChoose && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                    event.preventDefault();
                    if (!choicesOpen) openChoices();
                    else setActiveChoice(index => Math.max(0, Math.min(choices.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
                    return;
                }
                if (choicesOpen && event.key === 'Enter') { event.preventDefault(); choose(activeChoice); return; }
                if (choicesOpen && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setChoicesOpen(false); return; }
                if (event.key === 'Escape') setTip(null);
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
            }} />
        {choices.length > 0 && <button type="button" className="fieldChoicesToggle" tabIndex={-1} disabled={!canChoose}
            aria-label={isZh ? `显示 ${field.name} 的全部选项` : `Show all choices for ${field.name}`}
            aria-expanded={choicesOpen} onMouseDown={event => event.preventDefault()}
            onClick={() => { inputRef.current?.focus(); if (choicesOpen) setChoicesOpen(false); else openChoices(); }}>⌄</button>}
        {choicesOpen && choicePosition && createPortal(<div id={listId} className="fieldChoices" role="listbox"
            aria-label={field.name} style={choicePosition} onMouseDown={event => event.preventDefault()}>
            {choices.map((choice, index) => <div key={`${choice}-${index}`} id={`${listId}-${index}`} role="option"
                aria-selected={activeChoice === index} onMouseEnter={() => setActiveChoice(index)}
                onClick={() => choose(index)}>{choice}</div>)}
        </div>, document.body)}
        {diagnostic && <span id={diagnosticId} className="srOnly">{diagnostic.message}</span>}
        {diagnostic && tip && createPortal(<div className="fieldHint" role="tooltip" style={{
            left: tip.left, top: tip.top, transform: 'translateY(calc(-100% - 6px))',
        }}>{diagnostic.message}</div>, document.body)}
    </div>;
}

function FieldHelp({ help, field, locale, collapsed, showEnglish }: {
    help: KeywordManagerHelpState;
    field: KeywordManagerFieldState;
    locale: 'en' | 'zh';
    collapsed: boolean;
    showEnglish: boolean;
}) {
    const matches = help.fieldId === field.fieldId;
    const status = matches ? help.status : 'loading';
    const defaultValue = status === 'ready' ? help.defaultValue ?? field.defaultValue : field.defaultValue;
    const isZh = locale === 'zh';
    const typeLabel = ({ integer: ['整数', 'Integer'], float: ['实数', 'Real'], real: ['实数', 'Real'],
        double: ['实数', 'Real'], string: ['文本', 'Text'], bool: ['布尔值', 'Boolean'],
        '1': ['整数', 'Integer'], '-1': ['整数', 'Integer'], '2': ['实数', 'Real'], '0': ['文本', 'Text'], '-2': ['文本', 'Text'],
    } as Record<string, string[]>)[field.type.toLowerCase()]?.[isZh ? 0 : 1];
    const messages: Record<string, string> = {
        'form-unresolved': isZh ? '实际记录尚不能唯一确定字段布局。' : 'The source records do not determine a unique field layout.',
        'branch-unverified': isZh ? '当前分支尚未确认。' : 'The current branch has not been verified.',
        'branch-help-missing': isZh ? '当前分支尚无对应说明。' : 'Help is unavailable for the current branch.',
        'field-unmatched': isZh ? '尚未关联到该字段的帮助。' : 'Help has not been matched to this field.',
        'description-missing': isZh ? '暂无字段说明。' : 'No field description is available.',
    };
    const unavailable = (matches && help.reason && messages[help.reason]) || (isZh ? '暂无字段帮助。' : 'Help unavailable.');
    const hasEnglish = isZh && matches && status === 'ready' && !!help.localized && !!help.english && help.english !== help.localized;
    const description = (showEnglish && hasEnglish) ? help.english : (isZh ? help.localized || help.english : help.english);

    return <aside className="fieldHelp" aria-label={isZh ? '字段帮助' : 'Field help'}>
        <div id="field-help-body" className="fieldHelpBody" tabIndex={0} hidden={collapsed}
            aria-label={isZh ? '字段说明' : 'Field description'}>
            {!field.editable && <p className="fieldNotice">{field.reason === 'document-readonly'
                ? (isZh ? '该文件只读，无法应用修改。' : 'This file is read-only. Changes cannot be applied.')
                : <>{isZh ? '该字段只读，请在源文件中修改。' : 'This field is read-only. Edit it in the source file.'}{field.reason ? ` (${userFacingReason(field.reason, locale)})` : ''}</>}</p>}
            <FieldHelpContent name={field.name + (matches && help.schemaName && help.schemaName !== field.name
                ? (isZh ? `（${help.schemaName}）` : ` (${help.schemaName})`) : '')}
                typeLabel={typeLabel} isZh={isZh} loading={status === 'loading'}
                description={status === 'ready' ? description?.trim() || unavailable : unavailable}
                defaultValue={status === 'ready' ? defaultValue : undefined}
                choices={status === 'ready' ? help.choices : undefined} />
        </div>
    </aside>;
}

export function KeywordOptionsApp({ transport }: { transport: KeywordOptionsTransport }) {
    const [state, setState] = useState<KeywordOptionsViewState | null>(null);
    const [startupFailed, setStartupFailed] = useState(false);
    const [startupAttempt, setStartupAttempt] = useState(0);
    const [helpCollapsed, setHelpCollapsed] = useState(false);
    const [detailTopic, setDetailTopic] = useState<'field' | 'conditions'>('field');
    const detailBody = useRef<HTMLDivElement>(null);
    const applicationPending = useRef(false);
    const [pendingMutations, setPendingMutations] = useState(0);
    const [localDraftCount, setLocalDraftCount] = useState(0);
    const [localResetVersion, setLocalResetVersion] = useState(0);
    const [cancelBlurVersion, setCancelBlurVersion] = useState(0);
    const resetPending = useRef(false);
    const [interactionMessage, setInteractionMessage] = useState('');
    const [showEnglish, setShowEnglish] = useState(false);
    const { selectedFieldId, help, message: helpSelectionMessage, selectField } = useFieldHelp(state, transport);
    useLayoutEffect(() => {
        setShowEnglish(false);
    }, [selectedFieldId, help.contextKey, state?.selectedInstanceId]);
    useLayoutEffect(() => {
        if (detailTopic === 'field' && detailBody.current) detailBody.current.scrollTop = 0;
    }, [selectedFieldId, detailTopic, help.contextKey]);
    useLayoutEffect(() => {
        if (detailBody.current) detailBody.current.scrollTop = 0;
    }, [state?.selectedInstanceId]);
    const switchPending = useRef(false);
    const stateRef = useRef<KeywordOptionsViewState | null>(null);
    const localFieldDrafts = useRef(new Map<string, { value: string; hostValue: string; instanceId: string | null }>());
    const fieldSubmissions = useRef(new Map<string, { value: string; result: Promise<boolean> }>());
    const update = useCallback((next: KeywordOptionsViewState) => {
        if (stateRef.current && next.revision < stateRef.current.revision) return;
        if (stateRef.current?.revision === next.revision && stateRef.current.directoryStatus &&
            stateRef.current.directoryStatus !== 'loading' && next.directoryStatus === 'loading') {
            next = { ...next, instances: stateRef.current.instances, directoryStatus: stateRef.current.directoryStatus };
        }
        stateRef.current = next;
        document.documentElement.lang = next.locale === 'zh' ? 'zh-CN' : 'en';
        setStartupFailed(false);
        setState(next);
    }, []);
    const mutate = useCallback(async (operation: () => ReturnType<KeywordOptionsTransport['apply']>) => {
        setPendingMutations(count => count + 1);
        try {
            const result = await operation();
            update(result.state);
            setInteractionMessage(result.accepted || result.reason === 'cancelled' ? '' : result.reason === 'applied-reselect' ?
                result.state.labels.selectorAppliedReselect : result.state.message ||
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
        void transport.ready().then(next => { if (live) update(next); }, () => {
            if (live && (!stateRef.current || stateRef.current.status === 'loading')) setStartupFailed(true);
        });
        return () => { live = false; dispose(); };
    }, [transport, update, startupAttempt]);
    if (!state || state.status === 'loading') {
        const isZh = typeof document !== 'undefined' &&
            document.documentElement.lang.toLowerCase().startsWith('zh');
        if (startupFailed) return <main className="empty" role="alert">
            <p className="emptyMessage">{isZh ? '无法加载关键字管理器，请重试。' : 'Could not load Keyword Manager. Try again.'}</p>
            <button className="primary" type="button" onClick={() => {
                setStartupFailed(false);
                setStartupAttempt(attempt => attempt + 1);
            }}>{isZh ? '重试' : 'Retry'}</button>
        </main>;
        return (
            <main className="empty" aria-busy="true">
                <p className="emptyMessage" role="status">
                    {isZh ? '正在加载关键字管理器…' : 'Loading Keyword Manager…'}
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
    const apply = async () => {
        if (applicationPending.current || busy || ['stale', 'error', 'applying'].includes(stateRef.current!.status)) return;
        applicationPending.current = true;
        try {
            if (!await flushLocalFields()) return;
            const current = stateRef.current!;
            if (current.preview?.sharedByteChanges?.length && (current.revision !== state.revision
                || current.selectedInstanceId !== state.selectedInstanceId)) {
                setInteractionMessage(current.locale === 'zh'
                    ? '修改预览已更新。请核对后再次点击“应用”。'
                    : 'The preview has changed. Review it, then select Apply again.');
                return;
            }
            if (current.canApply) await mutate(() => transport.apply(current.revision));
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

    const selectInstance = async (id: string) => {
        if (switchPending.current || busy) return false;
        if (id === stateRef.current?.selectedInstanceId) return true;
        switchPending.current = true;
        setCancelBlurVersion(version => version + 1);
        try {
            if (!await flushLocalFields()) return false;
            return await mutate(() => transport.selectInstance(stateRef.current!.revision, id));
        } finally { switchPending.current = false; }
    };
    const sendDimension = (dimensionId: string, values: string[]) =>
        run(revision => transport.selectDimension(revision, dimensionId, values));
    const cards = state.cards || [];
    const fields = cards.flatMap(card => card.fields || []);
    const selectedField = fields.find(field => field.fieldId === selectedFieldId);
    const instancesList = state.instances || [];
    const selectedInstance = instancesList.find(instance => instance.instanceId === state.selectedInstanceId);
    const visibleCards = cards.filter(card => (card.fields || []).length > 0);
    const isZh = state.locale === 'zh';
    const hasEnglish = isZh && !!selectedField && help.fieldId === selectedField.fieldId && help.status === 'ready' && !!help.localized && !!help.english && help.english !== help.localized;
    const conditions = state.manualConditions || [];
    const conditionsHasEnglish = isZh && conditions.some(group => group.summaries.some((item: any) => typeof item !== 'string' && item.localized && item.english && item.english !== item.localized));
    const conditionSummary = isZh
        ? `${conditions.length} 个说明`
        : `${conditions.length} conditions`;
    const showingConditions = detailTopic === 'conditions' && conditions.length > 0;
    const toggleDetailLabel = showingConditions
        ? (isZh ? (helpCollapsed ? '展开卡片条件' : '折叠卡片条件') : (helpCollapsed ? 'Expand card conditions' : 'Collapse card conditions'))
        : (isZh ? (helpCollapsed ? '展开字段帮助' : '折叠字段帮助') : (helpCollapsed ? 'Expand field help' : 'Collapse field help'));

    return <main aria-busy={busy}>
        <header>
            <div className="headerIdentity">
                <span className="keyword" title={state.currentKeyword}>{state.currentKeyword
                    ? state.currentKeyword.split('_').map((part, index) => <Fragment key={index}>{index > 0 && <>_<wbr /></>}{part}</Fragment>) : '-'}</span>
                {selectedInstance?.displayName && <span className="instanceIdentity" title={selectedInstance.displayName}>{selectedInstance.displayName}</span>}
            </div>
            
            <div className="headerActions">
                <button className="iconButton" title={selectedInstance?.filePath || state.labels.locateSource} aria-label={state.labels.locateSource} disabled={busy} onClick={() => void transport.locateSource(state.revision)}>
                    <ManagerIcon name="locate" />
                </button>
                <div className="toolbarDivider" aria-hidden="true" style={{ margin: '0 2px' }}>|</div>
                
                <InstanceSelector state={state} transport={transport} busy={busy} onSelect={selectInstance} onReload={async () => { if (await flushLocalFields()) await reset(); }} />
                <button className="iconButton" title={isZh ? '重新读取当前实例' : 'Reload this instance'}
                    disabled={busy || state.hasDrafts || localDraftCount > 0} onClick={() => void reset()}>
                    <ManagerIcon name="reset" />
                </button>
                <button className="iconButton" title={state.labels.openManual} aria-label={state.labels.openManual} disabled={busy} onClick={() => void transport.openManual(state.revision)}>
                    <ManagerIcon name="manual" />
                </button>
            </div>
        </header>

        <div className="formScroll">

        {(state.directoryStatus === 'error' || state.directoryStatus === 'loading' || !state.instances.length) && <p className="instanceDirectoryNotice" role="status">
            {state.directoryStatus === 'error' ? state.labels.selectorError : state.directoryStatus === 'loading' ? state.labels.selectorLoading : state.labels.selectorEmpty}
            {state.directoryStatus === 'error' && <button className="headerButton" disabled={busy} onClick={async () => {
                if (await flushLocalFields()) await reset();
            }}>{state.labels.selectorReload}</button>}
        </p>}

        {state.mode === 'dimensions' && (state.dimensions || []).length > 0 && <section className="options" aria-label="options">
            <div className="controlsGrid">
                {(state.dimensions || []).map(dimension => {
                    const isSingle = dimension.selectionMode === 'single';
                    const selectedValue = dimension.values.find(value => value.selected);
                    const isActive = isSingle && selectedValue && selectedValue.valueId !== '';
                    const showLabel = !(dimension.selectionMode === 'multiple' && dimension.values.length === 1);

                    return <div className={`dimension ${isSingle ? 'tagSelect' : 'checkGroup'} ${isActive ? 'active' : 'inactive'}`} key={dimension.dimensionId}>
                        {isSingle ? <>
                            {showLabel && <span className="dimensionName">{dimension.label}</span>}
                            <select value={selectedValue?.valueId || ''} disabled={busy || state.status === 'stale'}
                                title={`${dimension.label}: ${selectedValue?.label || '-'}`}
                                aria-label={dimension.label}
                                onChange={event => sendDimension(dimension.dimensionId, event.target.value ? [event.target.value] : [])}>
                                {!dimension.required && <option value="">-</option>}
                                {dimension.values.map(value => <option key={value.valueId} value={value.valueId}
                                    disabled={!value.enabled}>{value.label}</option>)}
                            </select>
                        </> : <>
                            {showLabel && <span className="dimensionLabel" title={dimension.label}>{dimension.label}</span>}
                            <div className="checks">{dimension.values.map(value => <label key={value.valueId}
                                className={value.enabled ? '' : 'disabled'} title={value.label}>
                                <input type="checkbox" checked={value.selected} disabled={busy || state.status === 'stale' || !value.enabled}
                                    onChange={event => {
                                        const selected = new Set(dimension.values.filter(item => item.selected).map(item => item.valueId));
                                        if (event.target.checked) selected.add(value.valueId); else selected.delete(value.valueId);
                                        sendDimension(dimension.dimensionId, [...selected]);
                                    }} /> {value.label}
                            </label>)}</div>
                        </>}
                    </div>;
                })}
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
                {(state.controls || []).filter(control => control.visible && control.kind !== 'field').map(control => {
                    const isSelector = control.kind === 'selector';
                    const isActive = isSelector && control.value != null && control.value !== '';
                    return <div className={`dimension ${isSelector ? 'tagSelect' : ''} ${isSelector ? (isActive ? 'active' : 'inactive') : ''}`} key={control.controlId} title={control.reason}>
                        {control.kind === 'boolean' ?
                                <label className="dynamicToggle" title={control.label}>
                                    <input type="checkbox" checked={control.value === true} disabled={busy || state.status === 'stale' || !control.enabled}
                                        onChange={event => {
                                            const value = event.target.checked;
                                            run(revision => transport.updateControl(revision, control.controlId, value));
                                        }} />
                                    <span>{control.label}</span>
                                </label> : <>
                                    <span className="dimensionName">{control.label}</span>
                                    <select id={`inputForm-${control.controlId}`} value={String(control.value ?? '')}
                                        disabled={busy || state.status === 'stale' || !control.enabled}
                                        title={control.reason || `${control.label}: ${control.choices?.find(choice => choice.value === control.value)?.label || control.emptyLabel || String(control.value ?? '-')}`}
                                        aria-label={control.label}
                                        onChange={event => {
                                            const value = event.target.value;
                                            run(revision => transport.updateControl(revision, control.controlId, value));
                                        }}>
                                        <option value="" disabled={control.emptyEnabled === false}>{control.emptyLabel || '-'}</option>
                                        {(control.choices || []).map(value => <option key={value.value} value={value.value}
                                            disabled={!value.enabled}>{value.label}</option>)}
                                    </select>
                                </>}
                    </div>;
                })}
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
        {(interactionMessage || state.message) && state.status !== 'no-options'  && state.status !== 'empty' &&
            <p className={`message ${state.status}`} role="status">{interactionMessage || ((state.layoutDiagnostics || []).length > 0 && !['stale', 'error'].includes(state.status) ? (isZh ? '请核对卡片结构。' : 'Check the card layout.') : state.message)}</p>}
        {((state.layoutDiagnostics || []).length > 0 || (state.unresolvedRecords || []).length > 0) &&
        <details className="layoutDetails">
            <summary title={isZh ? '查看解析详情与原文' : 'View parsing details and source'}>{isZh ? '详情' : 'Details'}</summary>
            {state.message && <p>{state.message}</p>}
        {(state.layoutDiagnostics || []).length > 0 && <button className="layoutDiagnosticLocation"
            onClick={() => void transport.locateSource(state.revision)} disabled={busy || state.status === 'stale'}>
            {state.labels.locateSource}{state.layoutDiagnostics?.[0]?.line !== undefined ? ` · L${state.layoutDiagnostics[0].line + 1}` : ''}
        </button>}
        {(state.layoutDiagnostics || []).flatMap(diagnostic => diagnostic.controls || []).map(control =>
            <button className="layoutControl" key={control.fieldId} disabled={busy || state.status === 'stale'}
                onClick={() => void selectField(control.fieldId)}>
                {control.name} = {control.value || '∅'} · L{control.line + 1}</button>)}
        {(state.layoutDiagnostics || []).flatMap(diagnostic => diagnostic.requiredCards || []).map((card, index) =>
            <p className="requiredCard" key={index}>{card.condition} → {card.fields.join(' / ')}</p>)}
        {(state.unresolvedRecords || []).length > 0 && <section className="unresolvedRecords"
            aria-label={state.locale === 'zh' ? '字段归属未确定的原文（只读）' : 'Unresolved source records (read-only)'}>
            <p>{state.locale === 'zh' ? '字段归属未确定的原文（只读）' : 'Unresolved source records (read-only)'}</p>
            {state.unresolvedRecords!.map(record => <pre key={record.line}><span>L{record.line + 1} </span>{record.text}</pre>)}
        </section>}
        </details>}
        {visibleCards.length > 0 && <div className="editorLayout">
            <section className="cards" aria-label={isZh ? '卡片与字段' : 'Cards and fields'}>
                {visibleCards.map(card => {
                    const visibleFields = card.fields.filter(field => field.visible !== false);
                    const cardTitleFull = card.title || `Card ${card.cardIndex}${card.occurrenceIndex
                        ? ` · ${state.locale === 'zh' ? '记录' : 'Row'} ${card.occurrenceIndex}` : ''}`;
                    const gutterShort = card.cardIndex === 0 ? 'C0' : `C${card.cardIndex}${card.occurrenceIndex ? `.${card.occurrenceIndex}` : ''}`;
                    return <div className="card" key={card.cardId || card.fields[0]?.fieldId || `source:${card.line}:${card.cardIndex}:${card.occurrenceIndex || 0}:${card.fields[0]?.name || ''}`}>
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
                                        <KeywordFieldEditor field={field} isZh={isZh} busy={busy || state.status === 'stale'} resetVersion={localResetVersion} cancelBlurVersion={cancelBlurVersion} onSelect={selectField}
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
        {!!state.preview?.sharedByteChanges?.length && <section className="changePreview" aria-label={isZh ? '修改预览' : 'Change preview'}>
            <h3>{isZh ? '核对修改' : 'Review changes'}</h3>
            <ul>{state.preview!.sharedByteChanges!.map((change, index) => <li key={index}>{change}</li>)}</ul>
        </section>}
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
                    <span className="conditionCount">
                        {conditions.length}
                    </span></button>}
            </div>
            <div className="detailsActions">
                {(state.hasDrafts || localDraftCount > 0) &&
                    <button className="iconButton toolbarTextAction" disabled={busy}
                        title={isZh ? '还原' : 'Reset'} aria-label={isZh ? '还原所有修改' : 'Reset all changes'}
                        onMouseDown={event => event.preventDefault()} onClick={() => void reset()}>{isZh ? '还原' : 'Reset'}</button>}
                {(state.hasDrafts || localDraftCount > 0 || state.canApply) &&
                    <button className="iconButton toolbarTextAction primaryText" disabled={busy || ['stale', 'error'].includes(state.status) || (!state.canApply && localDraftCount === 0)}
                        onMouseDown={event => event.preventDefault()} onClick={() => void apply()}>{state.status === 'applying'
                            ? (isZh ? '应用中…' : 'Applying…') : (isZh ? '应用' : 'Apply')}</button>}
                {(showingConditions ? conditionsHasEnglish : hasEnglish) && <button type="button" className="fieldHelpLangToggle"
                    title={showEnglish ? (isZh ? '查看中文说明' : 'Show Chinese') : (isZh ? '查看英文原文' : 'Show English')}
                    aria-label={showEnglish ? (isZh ? '切换至中文' : 'Switch to Chinese') : (isZh ? '切换至英文' : 'Switch to English')}
                    onClick={() => setShowEnglish(v => !v)}>
                    {showEnglish ? '[中] 译文' : '[EN] 原文'}
                </button>}
                {(showingConditions ? conditionsHasEnglish : hasEnglish) && <span className="toolbarDivider" aria-hidden="true">|</span>}
                <button type="button" className="fieldHelpLangToggle" title={toggleDetailLabel} aria-label={toggleDetailLabel}
                    aria-expanded={!helpCollapsed} aria-controls="manager-detail-body"
                    onClick={() => setHelpCollapsed(value => !value)}>
                    {helpCollapsed ? (isZh ? '展开' : 'Expand') : (isZh ? '收起' : 'Collapse')}
                </button>
            </div>
        </div>
        <div className="detailViewport" id="manager-detail-body" ref={detailBody}>
        <div hidden={showingConditions}>
        {selectedField ? <FieldHelp key={JSON.stringify([state.selectedInstanceId, selectedField.fieldId, help.contextKey])}
            help={help} field={selectedField} locale={state.locale}
            collapsed={helpCollapsed} showEnglish={showEnglish} />
            : <p className="detailEmpty" hidden={helpCollapsed}>{isZh ? '选择字段，查看说明。' : 'Select a field to see its description.'}</p>}
        </div>
        <section className="manualConditions" hidden={!showingConditions || helpCollapsed} aria-label={isZh ? '卡片适用条件' : 'Card applicability'}>
            {conditions.map((group, index) => <div className="fieldHelpContent" key={group.id}>
                <div className="conditionHeader">
                    <span className="conditionTitle">{group.condition || (isZh ? '手册条件' : 'Manual condition')}</span>
                    {group.cards.length > 0 && <div className="conditionCards">
                        {group.cards.map(c => <span key={c} className="cardBadge">{isZh ? c.replace(/^Cards?\s+(?=[0-9A-Za-z])/i, '卡片 ') : c}</span>)}
                    </div>}
                </div>
                
                <div className="fieldHelpText">
                    {group.summaries.map((item: any) => {
                        const english = typeof item === 'string' ? item : item.english;
                        const localized = typeof item === 'string' ? null : item.localized;
                        const hasLocalized = !!localized && localized !== english;
                        
                        const text = (isZh && hasLocalized && !showEnglish) ? localized : english;

                        return <p key={english} style={{ margin: '6px 0 0' }}>{text}</p>;
                    })}
                </div>

            </div>)}
        </section>
        </div>
        </section>}
    </main>;
}
