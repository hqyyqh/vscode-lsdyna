import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type FormEvent,
    type KeyboardEvent,
    type ReactNode,
} from 'react';
import type {
    LargeFileFieldSpan,
    LargeFileViewerLine,
    LargeFileViewerState,
} from '../../../src/client/largeFileViewerProtocol';
import type { LargeFileViewerTransport } from './transport';

export function LargeFileViewerApp({ transport }: { transport: LargeFileViewerTransport }) {
    const [state, setState] = useState<LargeFileViewerState | null>(null);
    const [gotoLine, setGotoLine] = useState('1');
    const [keywordFilter, setKeywordFilter] = useState('');
    const [searchText, setSearchText] = useState('');
    const gotoFocused = useRef(false);
    const navigateTimer = useRef<number | undefined>(undefined);

    useEffect(() => {
        let live = true;
        transport.ready().then(next => {
            if (!live) return;
            setState(next);
            setGotoLine(String(next.anchorLine + 1));
            setSearchText(next.search.query);
        });
        const stop = transport.onStateChanged(next => {
            if (!live) return;
            setState(next);
            if (!gotoFocused.current) setGotoLine(String(next.anchorLine + 1));
        });
        return () => {
            live = false;
            stop();
            if (navigateTimer.current !== undefined) window.clearTimeout(navigateTimer.current);
        };
    }, [transport]);

    const digits = useMemo(() => String(Math.max(1, state?.lineCount || 1)).length, [state?.lineCount]);
    if (!state) return <div className="loading" role="status">{document.documentElement.lang.toLowerCase().startsWith('zh') ? '正在加载文件…' : 'Loading file…'}</div>;

    const navigate = (line: number, delayed = false) => {
        if (state.stale || state.indexing !== 'ready' && line > 0) return;
        if (navigateTimer.current !== undefined) window.clearTimeout(navigateTimer.current);
        const run = () => void transport.navigate(state.revision, Math.max(0, Math.floor(line)));
        if (delayed) navigateTimer.current = window.setTimeout(run, 70);
        else run();
    };
    const submitGoto = (event: FormEvent) => {
        event.preventDefault();
        const parsed = Number(gotoLine);
        if (Number.isSafeInteger(parsed) && parsed > 0) navigate(parsed - 1);
    };
    const submitSearch = (event: FormEvent) => {
        event.preventDefault();
        void transport.search(state.revision, searchText.trim());
    };
    const searchKey = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter' || state.search.loading ||
            searchText.trim() !== state.search.query || state.search.count === 0) return;
        event.preventDefault();
        void transport.searchStep(state.revision, event.shiftKey ? -1 : 1);
    };
    const onViewportKey = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'PageDown' || event.key === 'PageUp') {
            event.preventDefault();
            navigate(state.anchorLine + (event.key === 'PageDown' ? 40 : -40));
        } else if (event.key === 'Enter' && state.selectedField?.queryable) {
            event.preventDefault();
            void transport.queryField(state.revision, state.selectedField.token);
        }
    };

    return <main>
        <header className="titlebar">
            <strong title={state.fileName}>{state.fileName}</strong>
            <span>{formatBytes(state.fileSize)}</span>
        </header>
        <div className="toolbar">
            <form className="goto" onSubmit={submitGoto}>
                <label>{state.labels.line}</label>
                <input value={gotoLine} inputMode="numeric" onFocus={() => { gotoFocused.current = true; }}
                    onBlur={() => { gotoFocused.current = false; }} onChange={event => setGotoLine(event.target.value)} />
                <button type="submit" disabled={state.indexing !== 'ready' || state.stale}>{state.labels.goto}</button>
            </form>
            <div className="keyword-nav">
                <input value={keywordFilter} onChange={event => setKeywordFilter(event.target.value)}
                    placeholder={state.labels.keyword} spellCheck={false} />
                <button type="button" title={state.labels.previous} disabled={state.indexing !== 'ready' || state.stale}
                    onClick={() => void transport.navigateKeyword(state.revision, -1, keywordFilter)}>‹</button>
                <button type="button" title={state.labels.next} disabled={state.indexing !== 'ready' || state.stale}
                    onClick={() => void transport.navigateKeyword(state.revision, 1, keywordFilter)}>›</button>
            </div>
            <form className="search" onSubmit={submitSearch}>
                <input value={searchText} onChange={event => setSearchText(event.target.value)}
                    onKeyDown={searchKey} placeholder={state.labels.search} spellCheck={false} />
                <button type="submit" disabled={state.stale}>{state.labels.search}</button>
                <button type="button" disabled={state.search.count === 0 || state.stale}
                    title={state.labels.previous} onClick={() => void transport.searchStep(state.revision, -1)}>‹</button>
                <button type="button" disabled={state.search.count === 0 || state.stale}
                    title={state.labels.next} onClick={() => void transport.searchStep(state.revision, 1)}>›</button>
            </form>
        </div>
        <div className={`status ${state.stale ? 'warning' : ''}`} role="status">
            {state.stale ? <>{state.labels.stale} <button type="button"
                onClick={() => void transport.reload(state.revision)}>{state.labels.reload}</button></>
                : state.indexing === 'loading' ? state.labels.indexing
                    : state.indexing === 'error' ? state.indexingMessage
                        : <><span>{state.currentKeyword}</span><span>{state.anchorLine + 1} / {state.lineCount || '—'}</span>
                            {state.search.loading && <span>{state.labels.search}…</span>}
                            {!state.search.loading && state.search.count > 0 &&
                                <span>{state.search.currentIndex + 1} / {state.search.count}</span>}
                            {state.search.message && <span>{state.search.message}</span>}</>}
        </div>
        <div className="viewport" tabIndex={0} onKeyDown={onViewportKey}
            onWheel={event => {
                if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
                    state.stale || state.indexing !== 'ready') return;
                event.preventDefault();
                const delta = Math.sign(event.deltaY) * Math.max(1, Math.round(Math.abs(event.deltaY) / 24));
                navigate(state.anchorLine + delta, true);
            }}>
            <div className="deck" style={{ '--line-digits': digits } as CSSProperties}>
                {state.lines.map(line => <LineRow key={line.lineNumber} line={line} state={state}
                    select={token => void transport.selectField(state.revision, token)}
                    query={token => void transport.queryField(state.revision, token)} />)}
            </div>
        </div>
        {state.lineCount !== undefined && <input className="scroll-range" type="range" min={0}
            max={Math.max(0, state.lineCount - 1)} value={state.anchorLine}
            aria-label={state.labels.line} onChange={event => navigate(Number(event.target.value), true)} />}
        <FieldHelp state={state} query={() => state.selectedField &&
            transport.queryField(state.revision, state.selectedField.token)} />
    </main>;
}

function LineRow({ line, state, select, query }: {
    line: LargeFileViewerLine;
    state: LargeFileViewerState;
    select: (token: string) => void;
    query: (token: string) => void;
}) {
    const fields = [...line.fields].sort((left, right) => left.startColumn - right.startColumn);
    const content: ReactNode[] = [];
    let cursor = 0;
    fields.forEach((field, index) => {
        if (field.startColumn > cursor) content.push(line.text.slice(cursor, field.startColumn));
        content.push(<FieldSpan key={field.token} field={field} text={line.text.slice(field.startColumn, field.endColumn)}
            selected={state.selectedField?.token === field.token} select={select} query={query} />);
        cursor = Math.max(cursor, field.endColumn);
        if (index === fields.length - 1 && cursor < line.text.length) content.push(line.text.slice(cursor));
    });
    if (fields.length === 0) content.push(line.text);
    return <div className={`line ${line.keyword ? 'keyword-line' : ''}`}>
        <span className="line-number">{line.lineNumber + 1}</span>
        <span className="line-text">{content}{line.truncated && <span className="truncated" title={state.labels.truncatedLine}>…</span>}</span>
    </div>;
}

function FieldSpan({ field, text, selected, select, query }: {
    field: LargeFileFieldSpan;
    text: string;
    selected: boolean;
    select: (token: string) => void;
    query: (token: string) => void;
}) {
    return <button type="button" className={`field ${selected ? 'selected' : ''} ${field.queryable ? 'queryable' : ''}`}
        title={field.label} onClick={() => select(field.token)} onDoubleClick={() => field.queryable && query(field.token)}>{text}</button>;
}

function FieldHelp({ state, query }: { state: LargeFileViewerState; query: () => void }) {
    const field = state.selectedField;
    if (!field) return <footer className="field-help empty-help">{state.labels.noField}</footer>;
    return <footer className="field-help">
        <div className="field-heading"><strong>{field.label}</strong>
            <span>{field.keyword} · Card {field.cardIndex}{field.type ? ` · ${field.type}` : ''}</span>
            {field.queryable && <button type="button" onClick={query}>{state.labels.queryObject}</button>}</div>
        {field.value && <code>{field.value}</code>}
        {field.localizedHelp && <p>{field.localizedHelp}</p>}
        {(field.defaultValue || field.choices.length > 0) && <div className="field-meta">
            {field.defaultValue && <span>Default: {field.defaultValue}</span>}
            {field.choices.length > 0 && <span>{field.choices.join(' · ')}</span>}
        </div>}
        {field.englishHelp && field.englishHelp !== field.localizedHelp && <details><summary>{state.labels.english}</summary>
            <p>{field.englishHelp}</p></details>}
    </footer>;
}

function formatBytes(value: number): string {
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
