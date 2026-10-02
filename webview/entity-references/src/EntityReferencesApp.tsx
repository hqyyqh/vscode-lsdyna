import { useEffect, useId, useRef, useState } from 'react';
import type {
    EntityReferenceLocationItem,
    EntityReferencesViewState,
} from '../../../src/client/entityReferencesProtocol';
import type { EntityReferencesTransport } from './transport';
import { ReferenceIcon } from './ReferenceIcon';

export function EntityReferencesApp({ transport }: { transport: EntityReferencesTransport }) {
    const [state, setState] = useState<EntityReferencesViewState | null>(null);
    const [error, setError] = useState('');
    const [refreshPending, setRefreshPending] = useState(false);
    const [pendingLabel, setPendingLabel] = useState('');
    const [initialError, setInitialError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const mounted = useRef(false);
    const refreshLock = useRef(false);
    const searchRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        let live = true;
        mounted.current = true;
        setInitialError(false);
        const accept = (next: EntityReferencesViewState) => {
            if (!live) return;
            setInitialError(false);
            setState(previous => previous && previous.revision > next.revision ? previous : next);
        };
        const timer = setTimeout(() => { if (live) setInitialError(true); }, 10000);
        Promise.resolve().then(() => transport.ready()).then(next => { clearTimeout(timer); accept(next); }, () => { clearTimeout(timer); if (live) setInitialError(true); });
        const stopState = transport.onStateChanged(next => { clearTimeout(timer); accept(next); });
        const stopFocus = transport.onFocus(() => requestAnimationFrame(() => searchRef.current?.focus()));
        return () => { live = false; mounted.current = false; clearTimeout(timer); stopState(); stopFocus(); };
    }, [transport, attempt]);

    const zh = state?.locale === 'zh' || (!state && document.documentElement.lang.startsWith('zh'));
    const failed = zh ? '操作未完成，请重试。' : 'The operation did not complete. Please try again.';
    if (!state) return <div className="loading" role={initialError ? 'alert' : 'status'}>
        {initialError ? failed : zh ? '正在加载…' : 'Loading…'}
        {initialError && <button onClick={() => setAttempt(value => value + 1)}>{zh ? '重试' : 'Retry'}</button>}
    </div>;

    const busy = refreshPending || state.status === 'loading';
    const run = async (action: () => Promise<boolean>, label = zh ? '正在处理…' : 'Working…', showProgress = true) => {
        if (refreshLock.current || state.status === 'loading') return;
        refreshLock.current = true;
        if (showProgress) { setRefreshPending(true); setPendingLabel(label); }
        setError('');
        try { if (!await action() && mounted.current) setError(failed); }
        catch { if (mounted.current) setError(failed); }
        finally { refreshLock.current = false; if (mounted.current) setRefreshPending(false); }
    };

    const chooseScope = (next: 'file' | 'project') => {
        if (next === 'file' && !state.scope.fileAvailable) return;
        if (next === 'project' && !state.scope.projectAvailable) return;
        void run(() => transport.setScope(state.revision, next), state.labels.loading);
    };
    const resolvedScope = state.scope.selected;
    const navigable = !busy && (state.status === 'ready' || state.status === 'partial');
    const recovery = ['stale', 'needs-refresh', 'incomplete'].includes(state.status);
    const statusMessage = state.status === 'loading' ? state.labels.loading : refreshPending ? pendingLabel : recovery ? state.labels[state.status] :
        state.status === 'partial' ? state.labels.partial : state.message ||
        (state.status === 'empty' ? state.labels.empty : state.status === 'missing' ? state.labels.missing : '');


    return <main>
        <section className="query-editor">
            <header className="object-heading">
                <strong title={state.activeSession?.label}>{state.activeSession?.label || state.labels.search}</strong>
                {state.activeSession && <button type="button" className="icon-button pin"
                    aria-label={state.activeSession.pinned ? state.labels.unpin : state.labels.pin}
                    title={state.activeSession.pinned ? state.labels.unpin : state.labels.pinHint || state.labels.pin}
                    aria-pressed={state.activeSession.pinned} disabled={busy}
                    onClick={() => void run(() => transport.togglePin(state.revision, state.activeSession!.key))}>
                    <ReferenceIcon name="pin" />
                </button>}
                <button ref={searchRef} type="button" className="icon-button search"
                    title={state.labels.search} aria-label={state.labels.search} disabled={busy}
                    onClick={() => void run(() => transport.search(state.revision), state.labels.search)}>
                    <ReferenceIcon name="search" />
                </button>
            </header>
            <div className="query-tools">
                <label className="scope">
                    <select aria-label={state.labels.scope} disabled={busy} value={resolvedScope} onChange={event => chooseScope(event.target.value as 'file' | 'project')}
                        title={resolvedScope === 'project' ? state.scope.projectLabel : state.scope.fileLabel}>
                        <option value="file" disabled={!state.scope.fileAvailable}>{state.labels.file}</option>
                        <option value="project" disabled={!state.scope.projectAvailable}>{state.labels.project}</option>
                    </select>
                </label>
                <div className="query-actions">
                    <button type="button" className="follow-button" aria-pressed={state.following}
                        disabled={busy || !!state.activeSession?.pinned || !!state.largeFileOffer}
                        onClick={() => void run(() => transport.toggleFollow(state.revision))}>
                        <span className="follow-dot" aria-hidden="true" />
                        {state.activeSession?.pinned ? state.labels.fixed : state.labels.follow}
                    </button>
                </div>
            </div>
            {error && <div className="input-error" role="alert">{error}</div>}
        </section>

        <div className="result-content">
            {state.activeSession?.scopePath && <div className="source-file" title={state.activeSession.scopePath}>
                {state.activeSession.scopePath.split(/[\\/]/).pop()}
            </div>}
            {state.largeFileOffer && <section className="large-file-offer" role="status">
                <strong>{state.largeFileOffer.fileName}</strong>
                <p>{state.largeFileOffer.reason}</p>
                <button type="button" className="primary"
                    disabled={busy} onClick={() => void run(() => transport.openLargeFile(state.revision, state.largeFileOffer!.token))}>
                    {state.labels.openLargeFile}
                </button>
            </section>}
            {!state.largeFileOffer && statusMessage && <div className={recovery || state.status === 'partial' ? 'status-row warning' : 'status-row status'} role="status">
                <span>{statusMessage}</span>
            </div>}

            {state.ambiguous && navigable && <div className="status-row warning" role="status">{state.labels.ambiguous}</div>}

            {state.activeSession && <>
                <ResultGroup title={state.labels.definitions} items={state.definitions}
                    navigable={navigable} partial={state.status === 'partial'} complete={state.status === 'ready' || state.status === 'missing'}
                    total={state.activeSession.definitionCount}
                    hasMore={state.hasMoreDefinitions} loadMore={() => run(() => transport.loadMore(state.revision, 'definition'))}
                    open={(locationId, side) => run(() => transport.open(state.revision, locationId, side), '', false)} labels={state.labels} />
                <ResultGroup title={state.labels.references} items={state.references}
                    navigable={navigable} partial={state.status === 'partial'} complete={state.status === 'ready' || state.status === 'missing'}
                    total={state.activeSession.referenceCount}
                    hasMore={state.hasMoreReferences} loadMore={() => run(() => transport.loadMore(state.revision, 'reference'))}
                    open={(locationId, side) => run(() => transport.open(state.revision, locationId, side), '', false)} labels={state.labels} />
            </>}

            {state.pinnedSessions.length > 0 && <details className="pinned">
                <summary>{state.labels.pinned} ({state.pinnedSessions.length})</summary>
                {state.pinnedSessions.map(session => <div className="pinned-row" key={session.key}>
                    <button type="button" className="pinned-select"
                        disabled={busy} onClick={() => void run(() => transport.selectSession(state.revision, session.key))} title={session.scopePath}>{session.label}
                        {session.scopePath && <small>{session.scopeLabel} · {session.scopePath}</small>}
                    </button>
                    <button type="button" className="icon-button" title={state.labels.remove}
                        aria-label={state.labels.remove}
                        disabled={busy} onClick={() => void run(() => transport.removeSession(state.revision, session.key))}><ReferenceIcon name="close" /></button>
                </div>)}
                <button type="button" className="clear"
                    disabled={busy} onClick={() => void run(() => transport.clear(state.revision))}>{state.labels.clear}</button>
            </details>}
        </div>
    </main>;
}

function ResultGroup({ title, items, total, hasMore, loadMore, open, labels, navigable, partial, complete }: {
    title: string;
    items: EntityReferenceLocationItem[];
    total: number;
    hasMore: boolean;
    loadMore: () => Promise<unknown>;
    open: (locationId: string, side: boolean) => Promise<unknown>;
    labels: Record<string, string>;
    navigable: boolean;
    partial: boolean;
    complete: boolean;
}) {
    const [expanded, setExpanded] = useState(true);
    const contentId = useId();
    const pageCount = (partial ? labels.partialPageCount : labels.pageCount)
        ?.replace('{0}', String(items.length)).replace('{1}', String(total));
    return <section className={navigable ? 'results' : 'results unavailable'}>
        <h2><button type="button" className="group-toggle" aria-expanded={expanded}
            aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
            <ReferenceIcon name="chevron" />
            {title} {(complete || total > 0) && <span>{total}</span>}
        </button></h2>
        <div id={contentId} className="group-content" hidden={!expanded}>
        {items.length === 0 && <p className="group-empty">{complete ? labels.zeroResults : title === labels.references ? labels.referencesNotConfirmed : labels.definitionsNotConfirmed}</p>}
        {items.map(item => <div className="result-row" key={item.locationId} title={`${item.label}\n${item.detail}`}>
            <button type="button" className="result-main" disabled={!navigable}
                aria-label={`${item.label}, ${item.description}`} onClick={() => void open(item.locationId, false)}>
                <strong className="result-identity">
                    <span className="result-keyword" title={item.keyword || item.label}>{item.keyword || item.label}</span>
                    {item.keyword && item.fieldName && <span className="result-field">{item.fieldName}</span>}
                </strong><small>{item.description}</small>
            </button>
            <button type="button" className="icon-button side" title={labels.openSide}
                disabled={!navigable} aria-label={labels.openSide}
                onClick={() => void open(item.locationId, true)}><ReferenceIcon name="side" /></button>
        </div>)}
        {hasMore && <div className="pagination">
            <span>{pageCount}</span>
            {hasMore && <button type="button" className="load-more" disabled={!navigable}
                onClick={() => void loadMore()}>{labels.loadMore}</button>}
        </div>}
        </div>
    </section>;
}
