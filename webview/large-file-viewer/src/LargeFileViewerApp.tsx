import {
    Fragment,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type ClipboardEvent,
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
import { FieldHelpContent } from '../../shared/FieldHelpContent';

type ViewerAction = (current: LargeFileViewerState) => Promise<boolean>;
// ponytail: cap native scroll coordinates; windowed reads and exact line jumps cover files beyond browser pixel limits.
const MAX_SCROLL_HEIGHT = 4_000_000;

function copyVisibleSelection(event: ClipboardEvent<HTMLDivElement>, state: LargeFileViewerState) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) {
        if (state.stale || !state.selectedField || !event.currentTarget.querySelector('.field.selected')) return;
        const row = state.lines.find(line => line.fields.some(field => field.token === state.selectedField!.token));
        const field = row?.fields.find(field => field.token === state.selectedField!.token);
        if (!row || row.truncated || !field) return;
        event.preventDefault();
        event.clipboardData.setData('text/plain', row.text.slice(field.startColumn, field.endColumn).trim());
        return;
    }
    const selected = selection.getRangeAt(0);
    if (!event.currentTarget.contains(selected.startContainer) || !event.currentTarget.contains(selected.endContainer)) return;
    // ponytail: copy only mounted text; add file-coordinate selection only if cross-screen copying is requested.
    const parts: string[] = [];
    for (const text of event.currentTarget.querySelectorAll('.line-text')) {
        if (!selected.intersectsNode(text)) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        if (selected.compareBoundaryPoints(Range.START_TO_START, range) > 0) range.setStart(selected.startContainer, selected.startOffset);
        if (selected.compareBoundaryPoints(Range.END_TO_END, range) < 0) range.setEnd(selected.endContainer, selected.endOffset);
        parts.push(range.toString());
    }
    event.preventDefault();
    event.clipboardData.setData('text/plain', parts.join('\n'));
}

export function LargeFileViewerApp({ transport }: { transport: LargeFileViewerTransport }) {
    const [cursor, setCursor] = useState<{ line: number; token?: string } | null>(null);
    const [state, setState] = useState<LargeFileViewerState | null>(null);
    const [displayLine, setDisplayLine] = useState(0);
    const [lineTarget, setLineTarget] = useState<number | null>(null);
    const displayLineRef = useRef(0);
    const [gotoLine, setGotoLine] = useState('1');
    const [searchMode, setSearchMode] = useState<'text' | 'keyword'>('keyword');
    const [searchText, setSearchText] = useState('');
    const [viewportSize, setViewportSize] = useState({ height: 300, lineHeight: 20 });
    const viewport = useRef<HTMLDivElement>(null);
    const searchInput = useRef<HTMLInputElement>(null);
    const desiredLine = useRef<number | null>(null);
    const assignedScrollTop = useRef<number | null>(null);
    const wheelPixels = useRef(0);
    const [pixelOffset, setPixelOffset] = useState(0);
    const [initialError, setInitialError] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [retryAction, setRetryAction] = useState<ViewerAction | null>(null);
    const currentState = useRef<LargeFileViewerState | null>(null);
    const mounted = useRef(false);
    const actionSequence = useRef(0);
    const modeReset = useRef<Promise<void> | null>(null);
    const gotoFocused = useRef(false);
    const navigationInFlight = useRef(false);
    const navigateTimer = useRef<number | undefined>(undefined);

    useEffect(() => {
        let live = true;
        mounted.current = true;
        setInitialError(false);
        const accept = (next: LargeFileViewerState) => {
            if (!live) return;
            setInitialError(false);
            const previous = currentState.current;
            if (previous && next.revision < previous.revision) return;
            if (previous && next.revision === previous.revision) {
                if (next.indexing !== 'loading' || previous.indexing !== 'loading' ||
                    (next.scannedBytes || 0) <= (previous.scannedBytes || 0)) return;
                const progress = { ...previous, scannedBytes: next.scannedBytes,
                    availableLineCount: Math.max(previous.availableLineCount || 0, next.availableLineCount || 0) };
                currentState.current = progress;
                if (next.anchorLine === desiredLine.current) desiredLine.current = null;
                setState(progress);
                return;
            }
            currentState.current = next;
            const targetChanged = previous !== null &&
                JSON.stringify(previous.navigationTarget) !== JSON.stringify(next.navigationTarget);
            if (targetChanged || next.search.currentLine !== previous?.search.currentLine || next.search.query !== previous?.search.query || next.stale) {
                desiredLine.current = null;
                setLineTarget(null);
                setCursor(null);
                wheelPixels.current = 0;
                setPixelOffset(0);
                if (navigateTimer.current !== undefined) window.clearTimeout(navigateTimer.current);
                navigateTimer.current = undefined;
            }
            const requested = desiredLine.current;
            const position = !next.stale && requested !== null && next.lines.some(row => row.lineNumber === requested)
                ? requested : next.anchorLine;
            if (position !== next.anchorLine) transport.updatePosition(next.revision, position);
            displayLineRef.current = position;
            setDisplayLine(position);
            if (next.stale || next.anchorLine === desiredLine.current) desiredLine.current = null;
            setState(next);
            if (!gotoFocused.current) setGotoLine(String(position + 1));
            if (!previous) setSearchText(next.keywordSearch?.query ?? next.search.query);
        };
        const timer = window.setTimeout(() => { if (live && !currentState.current) setInitialError(true); }, 10000);
        const received = (next: LargeFileViewerState) => { window.clearTimeout(timer); accept(next); };
        Promise.resolve().then(() => transport.ready()).then(received, () => {
            window.clearTimeout(timer);
            if (live && !currentState.current) setInitialError(true);
        });
        const stop = transport.onStateChanged(received);
        return () => {
            live = false;
            mounted.current = false;
            actionSequence.current++;
            window.clearTimeout(timer);
            stop();
            if (navigateTimer.current !== undefined) window.clearTimeout(navigateTimer.current);
        };
    }, [transport, attempt]);

    useLayoutEffect(() => {
        const element = viewport.current;
        if (!element) return;
        const row = element.querySelector('.line');
        const measure = () => {
            const height = element.clientHeight || 300;
            const lineHeight = element.querySelector('.line')?.getBoundingClientRect().height || 20;
            setViewportSize(previous => previous.height === height && previous.lineHeight === lineHeight
                ? previous : { height, lineHeight });
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        if (row) observer.observe(row);
        return () => observer.disconnect();
    }, [!!state, state?.lines[0]?.lineNumber]);

    const lastLine = Math.max(0, (state?.lineCount ?? Math.max(state?.availableLineCount || 0, (state?.lines.at(-1)?.lineNumber ?? -1) + 1) + 240) - 1);
    const scrollHeight = Math.min(MAX_SCROLL_HEIGHT, lastLine * viewportSize.lineHeight);
    const visibleRows = Math.max(1, Math.floor(viewportSize.height / viewportSize.lineHeight));
    const scrollPosition = (line: number) => lastLine ? line / lastLine * scrollHeight : 0;
    const setScrollLine = (line: number) => {
        const element = viewport.current;
        if (!element) return;
        element.scrollTop = scrollPosition(line);
        // Native scroll coordinates can be rounded; that rounding must not change an exact line jump.
        assignedScrollTop.current = element.scrollTop;
    };

    useLayoutEffect(() => {
        if (viewport.current && state && desiredLine.current === null) {
            setScrollLine(displayLineRef.current);
        }
    }, [state?.anchorLine, state?.lines, scrollHeight, viewportSize.height]);

    useEffect(() => {
        const element = viewport.current;
        if (!element) return;
        const wheel = (event: WheelEvent) => {
            if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
            event.preventDefault();
            const current = currentState.current;
            if (!current || current.stale) return;
            wheelPixels.current += event.deltaY * (event.deltaMode === 1 ? viewportSize.lineHeight
                : event.deltaMode === 2 ? viewportSize.height : 1);
            const rows = Math.trunc(wheelPixels.current / viewportSize.lineHeight);
            wheelPixels.current -= rows * viewportSize.lineHeight;
            if (rows) navigate((desiredLine.current ?? displayLineRef.current) + rows, true);
            const position = desiredLine.current ?? displayLineRef.current;
            setPixelOffset(position > 0 && position < (current.lineCount || 1) - 1 ? wheelPixels.current : 0);
        };
        element.addEventListener('wheel', wheel, { passive: false });
        return () => element.removeEventListener('wheel', wheel);
    }, [!!state, scrollHeight, lastLine, viewportSize.height, viewportSize.lineHeight]);

    const digits = useMemo(() => String(Math.max(1, state?.lineCount || 1)).length, [state?.lineCount]);
    const zh = state?.locale === 'zh' || (!state?.locale && document.documentElement.lang.toLowerCase().startsWith('zh'));
    const failed = zh ? '\u64CD\u4F5C\u672A\u5B8C\u6210\uFF0C\u8BF7\u91CD\u8BD5\u3002' : 'The operation did not complete. Please try again.';
    if (!state) return <div className="loading" role={initialError ? 'alert' : 'status'}>
        {initialError ? failed : zh ? '\u6B63\u5728\u52A0\u8F7D\u6587\u4EF6\u2026' : 'Loading file\u2026'}
        {initialError && <button type="button" onClick={() => setAttempt(value => value + 1)}>{zh ? '\u91CD\u8BD5' : 'Retry'}</button>}
    </div>;

    const run = async (action: ViewerAction, reportFalse = true) => {
        const current = currentState.current;
        if (!current) return;
        const sequence = ++actionSequence.current;
        setRetryAction(null);
        try {
            const accepted = await action(current);
            if (!accepted && reportFalse && mounted.current && sequence === actionSequence.current &&
                currentState.current?.revision === current.revision) setRetryAction(() => action);
        } catch {
            if (mounted.current && sequence === actionSequence.current) setRetryAction(() => action);
        }
    };

    const navigate = (line: number, delayed = false) => {
        const current = currentState.current;
        if (!current || current.stale) return;
        const target = Math.max(0, Math.min(lastLine, Math.floor(line)));
        if (!delayed) { wheelPixels.current = 0; setPixelOffset(0); }
        desiredLine.current = target;
        setScrollLine(target);
        const first = current.lines[0]?.lineNumber ?? 0;
        const last = current.lines.at(-1)?.lineNumber ?? 0;
        const covered = target >= first && Math.min(lastLine, target + visibleRows) <= last;
        if (covered) {
            displayLineRef.current = target;
            setDisplayLine(target);
            transport.updatePosition(current.revision, target);
            if (!gotoFocused.current) setGotoLine(String(target + 1));
            if ((first === 0 || target - first >= 20) && (last === lastLine || last - target >= visibleRows + 40)) return;
        }
        if (delayed && navigateTimer.current !== undefined) return;
        if (navigateTimer.current !== undefined) window.clearTimeout(navigateTimer.current);
        const request = () => {
            navigateTimer.current = undefined;
            if (navigationInFlight.current) return;
            const current = currentState.current;
            if (!current || current.stale) return;
            const requestedLine = desiredLine.current ?? target;
            navigationInFlight.current = true;
            void run(async next => {
                let accepted = false;
                try {
                    accepted = await transport.navigate(next.revision, requestedLine);
                    return accepted;
                } finally {
                    navigationInFlight.current = false;
                    if (!accepted && desiredLine.current === requestedLine) {
                        desiredLine.current = null;
                        setScrollLine(displayLineRef.current);
                    } else if (mounted.current && desiredLine.current !== null && desiredLine.current !== requestedLine) {
                        navigate(desiredLine.current, true);
                    }
                }
            });
        };
        if (delayed) navigateTimer.current = window.setTimeout(request, 16);
        else request();
    };
    const jump = (action: ViewerAction, reportFalse = true) => {
        setCursor(null);
        setLineTarget(null);
        if (navigateTimer.current !== undefined) window.clearTimeout(navigateTimer.current);
        navigateTimer.current = undefined;
        desiredLine.current = null;
        wheelPixels.current = 0;
        setPixelOffset(0);
        return run(action, reportFalse);
    };
    const submitGoto = (event: FormEvent) => {
        event.preventDefault();
        const parsed = Number(gotoLine);
        if (Number.isSafeInteger(parsed) && parsed > 0 && !state.stale && state.indexing === 'ready') {
            setCursor(null);
            setLineTarget(Math.min(lastLine, parsed - 1));
            navigate(parsed - 1);
        }
    };
    const submitSearch = async (event: FormEvent, direction: -1 | 1 = 1) => {
        event.preventDefault();
        if (state.stale || state.indexing !== 'ready') return;
        if (modeReset.current) {
            const sequence = ++actionSequence.current;
            await modeReset.current;
            if (!mounted.current || currentState.current?.stale || sequence !== actionSequence.current) return;
        }
        if (searchMode === 'keyword') jump(next => transport.navigateKeyword(next.revision, direction, searchText.trim()));
        else jump(next => searchText.trim() === next.search.query && next.search.count > 0
            ? transport.searchStep(next.revision, 1) : transport.search(next.revision, searchText.trim()));
    };
    const searchKey = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter' && searchMode === 'keyword' && !state.stale) {
            void submitSearch(event, event.shiftKey ? -1 : 1);
            return;
        }
        if (event.key !== 'Enter' || state.stale || state.search.loading ||
            searchText.trim() !== state.search.query || state.search.count === 0) return;
        event.preventDefault();
        jump(next => transport.searchStep(next.revision, event.shiftKey ? -1 : 1));
    };
    const onViewportKey = (event: KeyboardEvent<HTMLDivElement>) => {
        const steps: Record<string, number> = { PageDown: visibleRows - 1 || 1, PageUp: -(visibleRows - 1 || 1), ArrowDown: 1, ArrowUp: -1 };
        if (event.key in steps || event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            if (event.key === 'End' && state.lineCount === undefined) return;
            navigate(event.key === 'Home' ? 0 : event.key === 'End' ? lastLine
                : (desiredLine.current ?? displayLineRef.current) + steps[event.key]);
        } else if (event.key === 'Enter' && !state.stale && state.selectedField?.queryable) {
            event.preventDefault();
            void run(next => transport.queryField(next.revision, state.selectedField!.token));
        }
    };

    const includePrevious = pixelOffset < 0 && state.lines.some(line => line.lineNumber === displayLine - 1);
    const shownLines = state.lines.filter(line => line.lineNumber >= displayLine - (includePrevious ? 1 : 0)).slice(0, visibleRows + 2);
    const translation = pixelOffset < 0 ? includePrevious ? viewportSize.lineHeight + pixelOffset : 0 : pixelOffset;
    const precedingKeyword = state.lines.filter(line => line.lineNumber <= displayLine && line.keyword).at(-1)?.text.trim() || state.currentKeyword;
    const targetText = state.navigationTarget && state.lines.find(line => line.lineNumber === state.navigationTarget?.line)?.text
        .slice(state.navigationTarget.startColumn, state.navigationTarget.endColumn).trim();
    return <main lang={state.locale} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault(); event.stopPropagation();
            setSearchMode('text'); searchInput.current?.focus(); searchInput.current?.select();
        } else if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation(); viewport.current?.focus();
        }
    }}>
        <div className={`status ${state.stale || state.indexing === 'error' || retryAction ? 'warning' : ''}`} role="status">
            {state.editError && <span role="alert">{state.editError}</span>}
            {retryAction && <div className="action-error" role="alert">{state.labels.failed || failed} <button type="button"
                onClick={() => void run(retryAction)}>{state.labels.retry}</button></div>}
            {precedingKeyword && <span className="sticky-header" title={precedingKeyword}>{precedingKeyword}</span>}
            {state.stale || state.indexing === 'error' ? <>{state.stale ? state.labels.stale : state.indexingMessage} <button type="button"
                onClick={() => jump(next => transport.reload(next.revision))}>{state.labels.reload}</button></>
                : state.indexing === 'loading' ? <span className="index-progress" title={`${state.labels.indexingHint} · ${formatBytes(state.scannedBytes || 0)} / ${formatBytes(state.fileSize)}`}>
                    <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />{' '}
                    {state.scannedBytes === state.fileSize ? state.labels.indexingFinishing
                        : `${state.labels.indexing} ${(state.scannedBytes || 0) > 0 && (state.scannedBytes || 0) < state.fileSize / 100 ? '<1' : Math.floor((state.scannedBytes || 0) / Math.max(1, state.fileSize) * 100)}%`}
                </span>
                    : <><span className="position" title={`${state.labels.line} ${displayLine + 1} / ${state.lineCount || '\u2014'}`} aria-label={`${state.labels.line} ${displayLine + 1} / ${state.lineCount || '\u2014'}`}>{state.labels.line} {displayLine + 1}<span className="line-total"> / {state.lineCount || '\u2014'}</span></span>
                            {state.search.loading && <span>{state.labels.search}{'\u2026'}</span>}
                            {state.search.message && <span>{state.search.message}</span>}</>}
            {lineTarget === null && state.navigationTarget && !state.stale && targetText && !targetText.startsWith('*') && <span className="navigation-position" title={`${state.labels.navigationTarget} · ${state.labels.line} ${state.navigationTarget.line + 1}${targetText ? ` · ID ${targetText}` : ''}`}>
                {targetText ? `ID ${targetText}` : `${state.labels.line} ${state.navigationTarget.line + 1}`}
            </span>}
            <span title={formatBytes(state.fileSize)}>{state.dirty ? state.labels.recovery : formatBytes(state.fileSize)}</span>
        </div>
        <header className="titlebar">
            <button type="button" className="open-native" title={state.labels.openNative} aria-label={state.labels.openNative}
                disabled={state.stale || !shownLines.length} onClick={() => void run(next => {
                    const target = cursor && shownLines.some(row => row.lineNumber === cursor.line && (!cursor.token || row.fields.some(field => field.token === cursor.token))) ? cursor
                        : { line: (shownLines.some(row => row.lineNumber === lineTarget) ? lineTarget! : undefined) ?? (shownLines.some(row => row.lineNumber === next.navigationTarget?.line) ? next.navigationTarget!.line : displayLineRef.current) };
                    return transport.openNative(next.revision, next.lines.some(row => row.lineNumber === target.line) ? target.line : displayLineRef.current, target.token);
                }, false)}><span className="codicon codicon-edit" aria-hidden="true" /></button>
            <form className="goto" onSubmit={submitGoto}>
                <label htmlFor="goto-line">{state.labels.line}</label>
                <input id="goto-line" title={state.labels.gotoHint} value={gotoLine} inputMode="numeric" onFocus={() => { gotoFocused.current = true; }}
                    onBlur={event => {
                        gotoFocused.current = false;
                        if (!event.currentTarget.form?.contains(event.relatedTarget as Node | null))
                            setGotoLine(String(displayLineRef.current + 1));
                    }}
                    onChange={event => setGotoLine(event.target.value)} />
                <button type="submit" title={state.labels.gotoHint} disabled={state.indexing !== 'ready' || state.stale} aria-label={state.labels.goto}><span className="codicon codicon-go-to-file" aria-hidden="true" /></button>
            </form>
            <form className="search-float" onSubmit={submitSearch}>
            <button type="button" className="search-mode" aria-pressed={searchMode === 'keyword'}
                title={searchMode === 'text' ? state.labels.textMode : state.labels.keywordMode}
                aria-label={searchMode === 'text' ? state.labels.textMode : state.labels.keywordMode}
                onClick={() => {
                    setSearchMode(mode => mode === 'text' ? 'keyword' : 'text');
                    ++actionSequence.current;
                    if (!modeReset.current) {
                        const pending = jump(next => transport.search(next.revision, ''));
                        modeReset.current = pending;
                        void pending.finally(() => { if (modeReset.current === pending) modeReset.current = null; });
                    }
                    searchInput.current?.focus();
                }}>
                <span className={`codicon codicon-${searchMode === 'text' ? 'search' : 'symbol-keyword'}`} aria-hidden="true" />
            </button>
            <div className="search-input">
            <input ref={searchInput} value={searchText} onChange={event => setSearchText(event.target.value)}
                onKeyDown={searchKey} placeholder={searchMode === 'text' ? state.labels.searchText : state.labels.keyword} title={searchMode === 'text' ? state.labels.searchHint : state.labels.keywordHint} aria-label={searchMode === 'text' ? state.labels.search : state.labels.keyword} spellCheck={false} />
            {searchMode === 'keyword' && state.keywordSearch?.query === searchText.trim() && !state.stale
                ? <span className="search-count" aria-live="polite" title={state.keywordSearch.count ? state.labels.keywordMatches : state.labels.noMatches}>{state.keywordSearch.currentIndex + 1} / {state.keywordSearch.count}</span>
                : searchMode === 'text' && state.search.query && state.search.query === searchText.trim() && !state.search.loading && !state.stale
                    ? <span className="search-count" aria-live="polite" title={state.search.count ? state.labels.matchLines : state.labels.noMatches}>{state.search.currentIndex + 1} / {state.search.count}{state.search.truncated ? '+' : ''}</span> : null}
            </div>
            <button type="button" disabled={state.stale || state.indexing !== 'ready' || searchMode === 'text' && (state.search.loading || state.search.count === 0 || searchText.trim() !== state.search.query)}
                title={searchMode === 'text' ? state.labels.previousMatch : state.labels.previousKeyword} aria-label={searchMode === 'text' ? state.labels.previousMatch : state.labels.previousKeyword}
                onClick={() => jump(next => searchMode === 'text' ? transport.searchStep(next.revision, -1) : transport.navigateKeyword(next.revision, -1, searchText.trim()))}>
                <span className="codicon codicon-arrow-up" aria-hidden="true" /></button>
            <button type="submit" title={searchMode === 'text' ? state.labels.searchHint : state.labels.keywordHint}
                aria-label={searchMode === 'text' ? state.labels.search : state.labels.nextKeyword} disabled={state.stale || state.indexing !== 'ready' || state.search.loading}>
                <span className={`codicon codicon-${state.search.loading ? 'loading codicon-modifier-spin' : 'arrow-down'}`} aria-hidden="true" /></button>
            <button type="button" disabled={!searchText && !state.search.query} title={state.labels.clearSearch} aria-label={state.labels.clearSearch}
                onClick={() => { setSearchText(''); jump(next => transport.search(next.revision, '')); searchInput.current?.focus(); }}>
                <span className="codicon codicon-close" aria-hidden="true" /></button>
        </form>
        </header>
        <div className="viewport" aria-describedby={!state.selectedField ? "viewer-hint" : undefined} data-vscode-context='{"preventDefaultContextMenuItems":true}' ref={viewport} tabIndex={0} onCopy={event => copyVisibleSelection(event, state)} onKeyDown={onViewportKey} onScroll={event => {
            if (event.currentTarget.scrollTop === assignedScrollTop.current) { assignedScrollTop.current = null; return; }
            assignedScrollTop.current = null;
            if (state.stale) {
                setScrollLine(state.anchorLine); return;
            }
            const line = scrollHeight ? Math.round(event.currentTarget.scrollTop / scrollHeight * lastLine) : 0;
            if (line !== (desiredLine.current ?? state.anchorLine)) navigate(line, true);
        }}>
            <div className="scroll-space" style={{ height: scrollHeight + viewportSize.height }}>
            <div className="deck" style={{ '--line-digits': digits, transform: `translateY(${-translation}px)` } as CSSProperties}>
                {shownLines.map(line => <LineRow key={line.lineNumber} line={line} state={lineTarget === null ? state : { ...state, search: { ...state.search, currentLine: undefined }, navigationTarget: { line: lineTarget, startColumn: 0, endColumn: 0 } }}
                    point={target => { setCursor(target); setLineTarget(target.line); }}
                    select={token => { setCursor({ line: line.lineNumber, token }); if (!state.stale) void run(next => transport.selectField(next.revision, token)); }}
                    query={token => { if (!state.stale) void run(next => transport.queryField(next.revision, token)); }} />)}
            </div>
            </div>
        </div>
        <FieldHelp state={state} query={() => { if (!state.stale && state.selectedField)
            void run(next => transport.queryField(next.revision, state.selectedField!.token)); }} />
    </main>;
}

function LineRow({ line, state, select, query, point }: {
    point: (target: { line: number; token?: string }) => void;
    line: LargeFileViewerLine;
    state: LargeFileViewerState;
    select: (token: string) => void;
    query: (token: string) => void;
}) {
    const fields = [...line.fields].sort((left, right) => left.startColumn - right.startColumn);
    const content: ReactNode[] = [];
    const matchStart = !state.stale && !state.search.loading && state.search.currentLine === line.lineNumber && state.search.query
        ? line.text.toLocaleLowerCase().indexOf(state.search.query.toLocaleLowerCase()) : -1;
    const renderText = (text: string, offset: number) => {
        const start = Math.max(0, matchStart - offset), end = Math.min(text.length, matchStart + state.search.query.length - offset);
        const render = (value: string) => line.keyword || line.text.trimStart().startsWith('$') ? value : syntaxText(value);
        return matchStart >= 0 && start < end ? <Fragment key={`match-${offset}`}>{render(text.slice(0, start))}<mark className="search-match">{render(text.slice(start, end))}</mark>{render(text.slice(end))}</Fragment> : render(text);
    };
    let cursor = 0;
    fields.forEach((field, index) => {
        if (field.startColumn > cursor) content.push(renderText(line.text.slice(cursor, field.startColumn), cursor));
        content.push(<FieldSpan key={field.token} field={field} text={renderText(line.text.slice(field.startColumn, field.endColumn), field.startColumn)}
            context={JSON.stringify({ webviewSection: "largeFileRecord", viewer: state.viewer, revision: state.revision, line: line.lineNumber, token: field.token, largeFileCanCopy: !state.stale && !line.truncated, largeFileField: true, preventDefaultContextMenuItems: true })}
            selected={state.selectedField?.token === field.token}
            target={!state.stale && state.navigationTarget?.line === line.lineNumber && field.endColumn > state.navigationTarget.startColumn && field.startColumn < state.navigationTarget.endColumn}
            select={select} query={query} />);
        cursor = Math.max(cursor, field.endColumn);
        if (index === fields.length - 1 && cursor < line.text.length) content.push(renderText(line.text.slice(cursor), cursor));
    });
    if (fields.length === 0) {
        const target = !state.stale && state.navigationTarget?.line === line.lineNumber ? state.navigationTarget : undefined;
        if (target && target.endColumn > target.startColumn) content.push(
            syntaxText(line.text.slice(0, target.startColumn)),
            <mark className="navigation-field" key="target">{syntaxText(line.text.slice(target.startColumn, target.endColumn))}</mark>,
            syntaxText(line.text.slice(target.endColumn)));
        else content.push(renderText(line.text, 0));
    }
    return <div data-vscode-context={JSON.stringify({ webviewSection: "largeFileRecord", viewer: state.viewer, revision: state.revision, line: line.lineNumber, largeFileCanCopy: !state.stale && !line.truncated, largeFileField: false, preventDefaultContextMenuItems: true })}
        onClick={event => { if (!(event.target as HTMLElement).closest('.field')) point({ line: line.lineNumber }); }} className={`line ${line.keyword ? 'keyword-line' : line.text.trimStart().startsWith('$') ? 'comment-line' : ''} ${!state.stale && state.navigationTarget?.line === line.lineNumber || matchStart >= 0 ? 'navigation-line' : ''}`}>
        <span className="line-number">{line.lineNumber + 1}</span>
        <span className="line-text">{content}</span>{line.truncated && <span className="truncated" title={state.labels.truncatedLine}>{'\u2026'}</span>}
    </div>;
}

function FieldSpan({ field, text, selected, target, select, query, context }: {
    context: string;
    field: LargeFileFieldSpan;
    text: ReactNode;
    selected: boolean;
    target: boolean;
    select: (token: string) => void;
    query: (token: string) => void;
}) {
    return <button data-vscode-context={context} type="button" className={`field ${selected ? 'selected' : ''} ${field.queryable ? 'queryable' : ''} ${target ? 'navigation-field' : ''}`}
        title={field.label} onClick={() => select(field.token)}
        onKeyDown={event => {
            if (event.key !== 'Enter') return;
            event.stopPropagation();
            if (field.queryable) { event.preventDefault(); query(field.token); }
        }}>{text}</button>;
}

function FieldHelp({ state, query }: { state: LargeFileViewerState; query: () => void }) {
    const [collapsed, setCollapsed] = useState(false);
    const [showEnglish, setShowEnglish] = useState(false);
    const body = useRef<HTMLDivElement>(null);
    const field = state.selectedField;
    useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [field?.token, showEnglish]);
    if (!field) return <footer className="viewer-hint" id="viewer-hint">{state.labels.noField}</footer>;
    const zh = state.locale === 'zh';
    const hasEnglish = zh && !!field.localizedHelp && !!field.englishHelp && field.localizedHelp !== field.englishHelp;
    const help = zh && !(showEnglish && hasEnglish) ? field.localizedHelp || field.englishHelp : field.englishHelp;
    const toggleLabel = zh ? (collapsed ? '展开字段说明' : '收起字段说明') : (collapsed ? 'Expand field help' : 'Collapse field help');
    const type = ({ integer: ['\u6574\u6570', 'Integer'], float: ['\u5B9E\u6570', 'Real'], real: ['\u5B9E\u6570', 'Real'], double: ['\u5B9E\u6570', 'Real'],
        string: ['\u6587\u672C', 'Text'], bool: ['\u5E03\u5C14\u503C', 'Boolean'], '1': ['\u6574\u6570', 'Integer'], '-1': ['\u6574\u6570', 'Integer'],
        '2': ['\u5B9E\u6570', 'Real'], '0': ['\u6587\u672C', 'Text'], '-2': ['\u6587\u672C', 'Text'] } as Record<string, string[]>)[field.type.toLowerCase()]?.[zh ? 0 : 1] || field.type;
    return <footer className="field-help detailsDock" aria-label={state.labels.fieldHelp}>
        <div className="detailsToolbar">
            <div className="detailTopics">
                <button type="button" className="selected" aria-controls="large-field-help-body"
                    onClick={() => setCollapsed(false)}>{state.labels.fieldHelp}</button>
            </div>
            <div className="detailsActions">
                {hasEnglish && <>
                    <button type="button" className="fieldHelpLangToggle"
                        title={showEnglish ? '查看中文说明' : '查看英文原文'}
                        aria-label={showEnglish ? '切换至中文' : '切换至英文'}
                        onClick={() => setShowEnglish(value => !value)}>{showEnglish ? '[中] 译文' : '[EN] 原文'}</button>
                    <span className="toolbarDivider" aria-hidden="true">|</span>
                </>}
                <button type="button" className="fieldHelpLangToggle" title={toggleLabel} aria-label={toggleLabel}
                    aria-expanded={!collapsed} aria-controls="large-field-help-body" onClick={() => setCollapsed(value => !value)}>
                    {zh ? (collapsed ? '展开' : '收起') : (collapsed ? 'Expand' : 'Collapse')}
                </button>
            </div>
        </div>
        <div ref={body} id="large-field-help-body" className="detailViewport" hidden={collapsed}>
            <div className="fieldHelp fieldHelpBody" tabIndex={0} aria-label={zh ? '字段说明' : 'Field description'}>
                <div className="field-heading">
                    <span>{field.keyword} {'\u00B7'} {state.labels.card} {field.cardIndex}</span>
                    {field.value && field.value !== field.object?.id && <code title={zh ? '当前值' : 'Current value'}>{field.value}</code>}
                    {field.object && <span className="field-object"><strong>{field.object.kindLabel} {field.object.id}</strong>
                        {field.object.name && <span title={state.labels.objectName}>{field.object.name}</span>}</span>}
                    {field.queryable && <button type="button" disabled={state.stale} onClick={query}>{state.labels.queryObject}</button>}
                </div>
                <FieldHelpContent name={field.label} typeLabel={type} isZh={zh}
                    description={help?.trim() || (zh ? '暂无字段说明。' : 'No field description is available.')}
                    defaultValue={field.defaultValue || undefined} choices={field.choices} />
            </div>
        </div>
    </footer>;
}

function formatBytes(value: number): string {
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

// Tokenize only bounded visible text; field slicing keeps fixed-width source columns intact.
function syntaxText(text: string): ReactNode {
    return text.split(/(&[A-Za-z_][\w]*|[+-]?(?:\d+\.?\d*|\.\d+)(?:[EeDd][+-]?\d+)?)/g).map((part, index) =>
        /^(?:&|[+\-.]?\d)/.test(part)
            ? <span key={index} className={part.startsWith('&') ? 'syntax-parameter' : 'syntax-number'}>{part}</span> : part);
}
