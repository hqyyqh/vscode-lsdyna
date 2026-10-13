import { useEffect, useRef, useState } from 'react';
import type {
    EntityReferenceLocationItem,
    EntityReferencesViewState,
} from '../../../src/client/entityReferencesProtocol';
import type { EntityReferencesTransport } from './transport';
import { ReferenceIcon } from './ReferenceIcon';
import { mergeEntityReferencePage } from './mergeEntityReferencePage';

export function EntityReferencesApp({ transport }: { transport: EntityReferencesTransport }) {
    const [state, setState] = useState<EntityReferencesViewState | null>(null);
    const [actionError, setActionError] = useState<{ revision: number; message: string } | null>(null);
    const [refreshPending, setRefreshPending] = useState(false);
    const [pendingLabel, setPendingLabel] = useState('');
    const [initialError, setInitialError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const mounted = useRef(false);
    const refreshLock = useRef(false);
    const mainRef = useRef<HTMLElement>(null);

    useEffect(() => {
        let live = true;
        mounted.current = true;
        setInitialError(false);
        const accept = (next: EntityReferencesViewState) => {
            if (!live) return;
            setInitialError(false);
            setState(previous => mergeEntityReferencePage(previous, next));
        };
        const timer = setTimeout(() => { if (live) setInitialError(true); }, 10000);
        Promise.resolve().then(() => transport.ready()).then(next => { clearTimeout(timer); accept(next); }, () => { clearTimeout(timer); if (live) setInitialError(true); });
        const stopState = transport.onStateChanged(next => { clearTimeout(timer); accept(next); });
        const stopFocus = transport.onFocus(() => requestAnimationFrame(() => mainRef.current?.focus()));
        return () => { live = false; mounted.current = false; clearTimeout(timer); stopState(); stopFocus(); };
    }, [transport, attempt]);

    const error = actionError?.revision === state?.revision ? actionError?.message : '';
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
        setActionError(null);
        try { if (!await action() && mounted.current) setActionError({ revision: state.revision, message: failed }); }
        catch { if (mounted.current) setActionError({ revision: state.revision, message: failed }); }
        finally { refreshLock.current = false; if (mounted.current) setRefreshPending(false); }
    };

    const resolvedScope = state.scope.selected;
    const navigable = !busy && (state.status === 'ready' || state.status === 'partial');
    const statusMessage = state.scanning ? (state.labels.finding || state.labels.loading)
        .replace('{0}', String((state.activeSession?.definitionCount || 0) + (state.activeSession?.referenceCount || 0)))
        : state.status === 'loading' ? state.labels.loading : refreshPending ? pendingLabel :
        ['partial', 'stale', 'needs-refresh', 'incomplete', 'missing'].includes(state.status) ? state.labels[state.status] :
        !state.activeSession && state.status === 'empty' ? state.labels.empty : '';
    const target = state.activeSession;
    const targetDefinition = !state.scanning && !state.ambiguous && target?.entityKindLabel && target.definitionCount === 1 && state.definitions.length === 1
        ? state.definitions[0] : undefined;

    return <main ref={mainRef} tabIndex={-1} lang={state.locale} aria-label={state.labels.title}>
        <section className="query-editor">

            {error && <div className="input-error" role="alert">{error}</div>}
            {target && <div className="target-compact" aria-label={target.label}>
                <div className="target-compact-row">
                    {target.entityKindLabel && <span className="entity-type">{target.entityKindLabel}</span>}
                    <strong className="entity-id">{target.entityId || target.label}</strong>
                </div>
                {targetDefinition && <div className="target-actions">
                    <button type="button" className="icon-button" disabled={!navigable} aria-label={state.labels.openDefinition} title={`${state.labels.openDefinition}\n${targetDefinition.detail}`} onClick={() => void run(() => transport.open(state.revision, targetDefinition.locationId, false), '', false)}>
                        <ReferenceIcon name="definition" />
                    </button>
                    <button type="button" className="icon-button" disabled={!navigable} aria-label={state.labels.openSide} title={`${state.labels.openSide}\n${targetDefinition.detail}`} onClick={() => void run(() => transport.open(state.revision, targetDefinition.locationId, true), '', false)}>
                        <ReferenceIcon name="side" />
                    </button>
                </div>}
                {target.keyword && <span className="target-keyword" title={target.keyword}>{target.keyword}</span>}
            </div>}
            {target?.entityName && <div className="target-name" title={target.entityName}>{target.entityName}</div>}
            {target?.scopePath && resolvedScope === 'project' && <div className="source-file" title={target.scopePath}>
                    {target.scopePath.split(/[\\/]/).pop()}
            </div>}
        </section>

        <div className="result-content">
            {!error && statusMessage && <div className="status-row" role="status">
                <span>{statusMessage}</span>
            </div>}
            {!state.scanning && !!state.reasonDetails?.length && <details className="coverage-details">
                <summary>{state.labels.details}</summary>
                <ul>{state.reasonDetails.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
            </details>}
            {state.largeFileOffer && <section className="large-file-offer" role="status">
                <strong>{state.largeFileOffer.fileName}</strong>
                <button type="button" className="primary"
                    title={state.largeFileOffer.reason} disabled={busy} onClick={() => void run(() => transport.openLargeFile(state.revision, state.largeFileOffer!.token))}>
                    {state.labels.openLargeFile}
                </button>
            </section>}




            {state.activeSession && state.status !== 'missing' && <>
                {!targetDefinition && <ResultGroup title={state.ambiguous ? `${state.labels.definitions} · ${zh ? '候选' : 'Candidates'}` : state.labels.definitions} items={state.definitions}
                    navigable={navigable} partial={state.status === 'partial'} complete={state.status === 'ready'}
                    total={state.activeSession.definitionCount}
                    hasMore={state.hasMoreDefinitions} loadMore={() => run(() => transport.loadMore(state.revision, 'definition'))}
                    open={(locationId, side) => run(() => transport.open(state.revision, locationId, side), '', false)} labels={state.labels} />}
                <ResultGroup title={state.labels.references} items={state.references}
                    grouped groupCounts={state.referenceGroupCounts}
                    navigable={navigable} partial={state.status === 'partial'} complete={state.status === 'ready'}
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

function ResultGroup({ title, items, total, hasMore, loadMore, open, labels, navigable, partial, complete, grouped = false, groupCounts }: {
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
    grouped?: boolean;
    groupCounts?: Record<string, number>;
}) {
    if (items.length === 0 && !hasMore) return null;
    const pageCount = (partial ? labels.partialPageCount : labels.pageCount)
        ?.replace('{0}', String(items.length)).replace('{1}', String(total));
    const groups = new Map<string, EntityReferenceLocationItem[]>();
    for (const item of items) {
        const key = grouped ? item.entityKind || '' : '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(item);
    }
    return <section className={navigable ? 'results' : 'results unavailable'}>
        {(!grouped || items.length === 0) && <h3 className="entity-group-heading">
            <span>{title}</span>{' '}
            {complete && <span className="count">{total}</span>}
        </h3>}


        {[...groups].map(([kind, entries]) => <div className="entity-group" key={kind}>
        {grouped && <h3 className="entity-group-heading">

            <span>{entries[0].entityKindLabel || labels.referenceLocationsTitle}</span>
            <span className="count" title={labels.referenceLocations?.replace('{0}', String(groupCounts?.[kind] ?? entries.length))}>
                {groupCounts?.[kind] ?? entries.length}{partial || (!groupCounts && hasMore) ? '+' : ''}
            </span>
        </h3>}

        {entries.map(item => <div className="result-row" key={item.locationId}>
            <button type="button" className="result-main" disabled={!navigable}
                title={`${labels.openLocation}\n${item.entityName || item.keyword || item.label}\n${item.detail}`}
                aria-label={`${labels.openLocation}: ${item.entityId ? `${item.entityKindLabel || ''} ${item.entityId}, ${item.entityName || ''}, ` : ''}${item.label}, ${item.description}`}
                onClick={() => void open(item.locationId, false)}>
                <span className="result-primary">
                    <ReferenceIcon name={item.entityKind === 'curve' ? 'curve' : item.entityId ? 'entity' : 'keyword'} />
                    {item.entityId && <span className="result-id">{item.entityId}</span>}
                    <span className={item.entityName ? 'result-name entity-name' : 'result-name result-keyword'} title={item.entityName || item.keyword || item.label}>
                        {item.entityName || item.keyword || item.label}
                    </span>
                    {item.fieldName && <span className="result-badge">{item.fieldName}</span>}
                </span>
                <span className="result-location" title={item.detail}>
                    <ReferenceIcon name="file" />
                    <span className="result-file">{item.fileLabel || item.description}</span>
                    {item.line !== undefined && <span className="result-line">:{item.line}</span>}
                </span>
            </button>
                <button type="button" className="icon-button side" title={`${labels.openSide}\n${item.detail}`}
                    disabled={!navigable} aria-label={labels.openSide}
                    onClick={() => void open(item.locationId, true)}>
                    <ReferenceIcon name="side" />
                </button>
        </div>)}
        </div>)}
        {hasMore && <div className="pagination">
            <span>{pageCount}</span>
            <button type="button" className="load-more" disabled={!navigable}
                onClick={() => void loadMore()}>{labels.loadMore}</button>
        </div>}
    </section>;
}
