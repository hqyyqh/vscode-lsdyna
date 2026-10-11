import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeywordManagerInstanceState, KeywordOptionsViewState } from '../../../src/client/keywordOptionsProtocol';
import type { KeywordOptionsTransport } from './transport';
import { ManagerIcon } from './ManagerIcon';

const format = (text: string, ...values: (number | string)[]) =>
    text.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)]));
const numericId = (item: KeywordManagerInstanceState) => {
    const value = item.identity?.value.trim();
    return value && /^[+-]?\d+$/.test(value) ? BigInt(value) : null;
};

export function InstanceSelector({ state, transport, busy, onSelect, onReload }: {
    state: KeywordOptionsViewState;
    transport: KeywordOptionsTransport;
    busy: boolean;
    onSelect: (id: string) => Promise<boolean>;
    onReload: () => Promise<void>;
}) {
    const labels = state.labels;
    const current = state.instances.find(item => item.instanceId === state.selectedInstanceId);
    const source = current || state.instances[0];
    const file = state.instanceContext || source;
    const context = `${file?.uri || ''}\n${file?.typeKey || state.currentKeyword}`;
    const [preferences, setPreferences] = useState(() => {
        const saved = transport.getSelectorState?.() as { context?: string; query?: string; order?: string } | undefined;
        return { context: saved?.context || '', query: typeof saved?.query === 'string' ? saved.query : '',
            order: saved?.order === 'id' ? 'id' : 'file' };
    });
    const query = preferences.context === context ? preferences.query : '';
    const canSortId = state.instances.filter(item => numericId(item) !== null).length >= 2;
    const order = preferences.context === context && canSortId ? preferences.order : 'file';
    useEffect(() => {
        if (preferences.context !== context) setPreferences({ context, query: '', order: 'file' });
        else transport.setSelectorState?.(preferences);
    }, [context, preferences, transport]);
    const [open, setOpen] = useState(false);
    const openRef = useRef(false);
    const restoreFocus = useRef(false);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const search = useRef<HTMLInputElement>(null);
    const rows = useRef(new Map<string, HTMLButtonElement>());
    const [position, setPosition] = useState({ left: 8, top: 8, width: 336, maxHeight: 400 });
    const ordered = useMemo(() => {
        if (order !== 'id') return state.instances;
        return state.instances.map((item, index) => ({ item, index, id: numericId(item) }))
            .sort((a, b) => a.id === null ? (b.id === null ? a.index - b.index : 1) :
                b.id === null ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : a.index - b.index)
            .map(entry => entry.item);
    }, [order, state.instances]);
    const lineLabel = (item: KeywordManagerInstanceState) => format(labels.selectorLine, item.line + 1);
    const details = (item: KeywordManagerInstanceState) => [lineLabel(item),
        item.recordStartIndex !== undefined ? format(labels.selectorRecord, item.recordStartIndex + 1) : '',
        ...(item.summary || []).map(field => `${field.field} ${field.value}`),
        item.readonly ? labels.readonly : ''].filter(Boolean).join(' · ');
    const primary = (item: KeywordManagerInstanceState) => [item.identity ? `${item.identity.field} ${item.identity.value}` : '',
        item.title || ''].filter(Boolean).join(' · ') || lineLabel(item);
    const visible = ordered.filter(item => !query.trim() || `${primary(item)} ${details(item)}`.toLocaleUpperCase()
        .includes(query.trim().toLocaleUpperCase()));
    const index = ordered.findIndex(item => item.instanceId === state.selectedInstanceId);
    const unavailable = busy || state.status === 'stale' || state.directoryStatus === 'loading' || state.directoryStatus === 'error';
    const close = (restore = false) => { openRef.current = false; restoreFocus.current = restore; setOpen(false); };
    useLayoutEffect(() => {
        openRef.current = open;
        if (!open && !busy && restoreFocus.current) {
            restoreFocus.current = false;
            trigger.current?.focus();
        }
    }, [open, busy]);
    useEffect(() => { setOpen(false); }, [context]);
    useLayoutEffect(() => {
        if (!open) return;
        const place = () => {
            const rect = trigger.current!.getBoundingClientRect();
            const width = Math.min(336, window.innerWidth - 16);
            const below = window.innerHeight - rect.bottom - 12;
            const above = rect.top - 12;
            const flip = below < 260 && above > below;
            const maxHeight = Math.max(40, Math.min(480, flip ? above : below));
            const height = Math.min(panel.current?.scrollHeight || 400, maxHeight);
            setPosition({ left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
                top: flip ? Math.max(8, rect.top - height - 4) : rect.bottom + 4, width, maxHeight });
        };
        place(); search.current?.focus();
        window.addEventListener('resize', place);
        return () => window.removeEventListener('resize', place);
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const outside = (event: Event) => {
            if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
        };
        document.addEventListener('pointerdown', outside);
        document.addEventListener('focusin', outside);
        return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); };
    }, [open]);
    const choose = async (item: KeywordManagerInstanceState) => {
        if (await onSelect(item.instanceId)) { if (openRef.current) close(true); }
        else search.current?.focus();
    };
    const focusRow = (item: KeywordManagerInstanceState | undefined) => {
        if (!item) return;
        const row = rows.current.get(item.instanceId);
        row?.focus(); row?.scrollIntoView?.({ block: 'nearest' });
    };
    const ignoreRepeat = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
    };
    const status = state.directoryStatus === 'loading' ? labels.selectorLoading :
        state.directoryStatus === 'error' ? labels.selectorError : '';
    return <div className="instanceNavigation">
        <button className="iconButton" aria-label={labels.selectorPrevious} title={labels.selectorPrevious}
            disabled={unavailable || index <= 0} onKeyDown={ignoreRepeat} onClick={() => void onSelect(ordered[index - 1].instanceId)}><ManagerIcon name="previous" /></button>
        <button ref={trigger} className="instanceTrigger" aria-haspopup="dialog" aria-expanded={open} aria-controls="instance-selector"
            aria-label={status || (!ordered.length ? labels.selectorEmpty : index < 0 ? format(labels.selectorMissing, ordered.length) :
                format(labels.selectorSelected, index + 1, ordered.length))}
            disabled={busy || state.status === 'stale' || state.directoryStatus === 'loading' || !ordered.length}
            title={status || labels.selectorTitle} onClick={() => setOpen(value => !value)}
            onKeyDown={event => { if (event.key === 'ArrowDown' && !event.nativeEvent.isComposing) { event.preventDefault(); setOpen(true); } }}>
            {state.directoryStatus === 'loading' ? '…' : state.directoryStatus === 'error' ? '!' : !ordered.length ? '0/0' : `${index < 0 ? '–' : index + 1}/${ordered.length}`}
            <ManagerIcon name="expand" />
        </button>
        <button className="iconButton" aria-label={labels.selectorNext} title={labels.selectorNext}
            disabled={unavailable || index < 0 || index >= ordered.length - 1} onKeyDown={ignoreRepeat} onClick={() => void onSelect(ordered[index + 1].instanceId)}><ManagerIcon name="next" /></button>
        {open && createPortal(<div ref={panel} id="instance-selector" className="instancePopover" role="dialog" aria-modal="false"
            aria-label={labels.selectorTitle} style={position} onKeyDown={event => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
            }}>
            <div className="dialogHeader"><strong>{labels.selectorTitle}</strong>
                <button className="iconButton" aria-label={labels.selectorClose} onClick={() => close(true)}><ManagerIcon name="close" /></button></div>
            <details className="instanceFile"><summary>{labels.currentFile}: {file?.fileName || file?.uri}{file?.dirty ? ` · ${labels.dirty}` : ''}</summary>
                <div tabIndex={0}>{file?.filePath || file?.uri}</div></details>
            <div className="instanceSearch"><ManagerIcon name="search" /><input ref={search} type="search" aria-label={labels.selectorSearch}
                placeholder={labels.selectorSearch} value={query} onChange={event => setPreferences({ context, order, query: event.target.value })}
                onKeyDown={event => {
                    if (event.nativeEvent.isComposing || event.repeat) return;
                    if (event.key === 'ArrowDown') { event.preventDefault(); focusRow(!query.trim() ? current || visible[0] : visible[0]); }
                    if (event.key === 'Enter') { event.preventDefault(); const item = query.trim() ? visible[0] : current; if (item) void choose(item); }
                }} />
                {query && <button className="iconButton" aria-label={labels.selectorClear} onClick={() => {
                    setPreferences({ context, query: '', order }); search.current?.focus();
                }}><ManagerIcon name="close" /></button>}</div>
            <div className="instanceMeta">
                {canSortId && <select aria-label={labels.selectorSort} value={order}
                    onChange={event => setPreferences({ context, query, order: event.target.value })}>
                    <option value="file">{labels.selectorFileOrder}</option><option value="id">{labels.selectorIdOrder}</option></select>}
                {!status && <span role="status">{format(ordered.length === 1 ? labels.selectorCountSingle : labels.selectorCount, visible.length, ordered.length)}</span>}
            </div>
            {status && <p role="status">{status}{state.directoryStatus === 'error' && <button onClick={() => void onReload()}>{labels.selectorReload}</button>}</p>}
            {current && !visible.includes(current) && <p className="instanceNotice">{labels.selectorOutside}</p>}
            <div className="instanceList">
                {visible.map((item, rowIndex) => <button key={item.instanceId} ref={node => { if (node) rows.current.set(item.instanceId, node); else rows.current.delete(item.instanceId); }}
                    disabled={unavailable} aria-current={item.instanceId === state.selectedInstanceId ? 'true' : undefined}
                    className={item.instanceId === state.selectedInstanceId ? 'selected' : ''} onClick={() => void choose(item)}
                    onKeyDown={event => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                            event.preventDefault(); const next = rowIndex + (event.key === 'ArrowDown' ? 1 : -1);
                            if (next < 0) search.current?.focus(); else focusRow(visible[next]);
                        }
                        if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
                    }}>
                    <span>{item.instanceId === state.selectedInstanceId && <b className="instanceCurrent"><ManagerIcon name="check" /> {labels.selectorCurrent} </b>}{primary(item)}</span>
                    <small>{details(item)}</small>
                </button>)}
                {!visible.length && <p className="emptyList">{ordered.length ? labels.selectorNoMatch : labels.selectorEmpty}</p>}
            </div>
        </div>, document.body)}
    </div>;
}
