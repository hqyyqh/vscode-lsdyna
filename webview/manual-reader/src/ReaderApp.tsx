import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ManualLanguage, ManualLocation, ManualSearchMode, ManualSearchScope, ReaderViewModel } from '../../../src/manual/readerProtocol';
import { MarkdownDocument } from './MarkdownDocument';
import {
    FONT_SCALE_DEFAULT,
    applyFontScaleCssVar,
    canStepFontScale,
    formatFontScalePercent,
    loadFontScaleFromStorage,
    saveFontScaleToStorage,
    stepFontScale,
} from './readerFontScale';
import { readerMessages } from './readerI18n';
import { ReaderToolbar } from './ReaderToolbar';
import { RequestStatusBanner } from './RequestStatusBanner';
import { SearchPopover } from './SearchPopover';
import { IconArrowUp } from './ToolbarIcons';
import { useReadingPosition, useRestoreReadingPosition } from './useReadingPosition';

const SEARCH_DEBOUNCE_MS = 250;
const FONT_SCALE_PERSIST_MS = 150;

/** UI locale drives search scope: English UI → en only; Chinese UI → bilingual. */
function scopeForUiLocale(uiLocale: ReaderViewModel['uiLocale']): ManualSearchScope {
    return uiLocale === 'en' ? 'en' : 'both';
}

function searchKey(query: string, scope: ManualSearchScope, mode: ManualSearchMode): string {
    return `${query}\0${scope}\0${mode}`;
}

export interface ReaderTransport {
    request(name: string, payload: unknown): Promise<unknown>;
    notify(name: string, payload: unknown): void;
    onStateChanged(handler: (state: ReaderViewModel) => void): () => void;
}

export interface ReaderAppProps {
    initialState: ReaderViewModel | null;
    transport: ReaderTransport;
}

function isViewModel(value: unknown): value is ReaderViewModel {
    return Boolean(value && typeof value === 'object' && Number.isFinite((value as ReaderViewModel).revision));
}

function sameSentencePairs(left: ReaderViewModel['content'], right: ReaderViewModel['content']): boolean {
    if (left.kind !== 'document' || right.kind !== 'document') return left.kind === right.kind;
    return left.sentencePairs.length === right.sentencePairs.length
        && left.sentencePairs.every((pair, index) => pair.primary === right.sentencePairs[index]?.primary && pair.secondary === right.sentencePairs[index]?.secondary);
}

interface MarkdownViewportProps {
    content: Extract<ReaderViewModel['content'], { kind: 'document' }>;
    onOpenLink: (href: string) => void;
    tableLabel: string;
    translationHint: string;
    translationPreviewLabel: string;
    closeTranslationLabel: string;
    imageLabels: {
        open: string; preview: string; zoomIn: string; zoomOut: string; reset: string; close: string;
    };
}

const MarkdownViewport = React.memo(function MarkdownViewport({ content, onOpenLink, tableLabel, translationHint, translationPreviewLabel, closeTranslationLabel, imageLabels }: MarkdownViewportProps): React.JSX.Element {
    return <MarkdownDocument {...content} onOpenLink={onOpenLink} tableLabel={tableLabel} translationHint={translationHint} translationPreviewLabel={translationPreviewLabel} closeTranslationLabel={closeTranslationLabel} openImageLabel={imageLabels.open} imagePreviewLabel={imageLabels.preview} zoomInLabel={imageLabels.zoomIn} zoomOutLabel={imageLabels.zoomOut} resetImageLabel={imageLabels.reset} closeImageLabel={imageLabels.close} />;
}, (previous, next) => previous.content.markdown === next.content.markdown
    && previous.content.chunkBaseUri === next.content.chunkBaseUri
    && sameSentencePairs(previous.content, next.content)
    && previous.tableLabel === next.tableLabel
    && previous.translationHint === next.translationHint
    && previous.translationPreviewLabel === next.translationPreviewLabel
    && previous.closeTranslationLabel === next.closeTranslationLabel
    && previous.imageLabels.open === next.imageLabels.open
    && previous.imageLabels.preview === next.imageLabels.preview
    && previous.imageLabels.zoomIn === next.imageLabels.zoomIn
    && previous.imageLabels.zoomOut === next.imageLabels.zoomOut
    && previous.imageLabels.reset === next.imageLabels.reset
    && previous.imageLabels.close === next.imageLabels.close
    && previous.onOpenLink === next.onOpenLink);

function LoadingSkeleton({ label, onRetry, retryLabel, failed }: { label: string; onRetry: () => void; retryLabel: string; failed: boolean }): React.JSX.Element {
    return <main className="reader-content reader-loading">
        <div className="reader-skeleton" aria-hidden="true"><i /><i /><i /><i /></div>
        <div role="status">{label}</div>
        {failed ? <button type="button" onClick={onRetry}>{retryLabel}</button> : null}
    </main>;
}

export function ReaderApp({ initialState, transport }: ReaderAppProps): React.JSX.Element {
    const [view, setView] = useState<ReaderViewModel | null>(initialState);
    const [query, setQuery] = useState(initialState?.search.query || '');
    const [mode, setMode] = useState<ManualSearchMode>(initialState?.search.mode || 'keyword');
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchPending, setSearchPending] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const [requestError, setRequestError] = useState<string | null>(null);
    const [pendingCount, setPendingCount] = useState(0);
    const [readyAttempt, setReadyAttempt] = useState(0);
    const [readyFailed, setReadyFailed] = useState(false);
    const [optimisticLanguage, setOptimisticLanguage] = useState<ManualLanguage | null>(null);
    const [fontScale, setFontScale] = useState(() => loadFontScaleFromStorage());
    const viewRef = useRef(view);
    const searchButtonRef = useRef<HTMLButtonElement>(null);
    const searchSeq = useRef(0);
    const skipNextSearchSync = useRef(false);
    const lastSearchKeyRef = useRef<string | null>(null);
    const fontScalePersistTimer = useRef<number | null>(null);
    viewRef.current = view;
    const locale = view?.uiLocale || 'en';
    const messages = useMemo(() => readerMessages(locale), [locale]);
    const imageLabels = useMemo(() => ({ open: messages.openImage, preview: messages.imagePreview, zoomIn: messages.zoomIn, zoomOut: messages.zoomOut, reset: messages.resetImage, close: messages.closeImage }), [messages]);
    const fontScalePercentLabel = useMemo(() => formatFontScalePercent(fontScale), [fontScale]);
    useRestoreReadingPosition(view);
    const reading = useReadingPosition(view, transport);

    // Apply content font scale without re-rendering markdown (CSS variable only).
    useEffect(() => {
        applyFontScaleCssVar(fontScale);
        if (fontScalePersistTimer.current != null) {
            window.clearTimeout(fontScalePersistTimer.current);
        }
        fontScalePersistTimer.current = window.setTimeout(() => {
            fontScalePersistTimer.current = null;
            saveFontScaleToStorage(fontScale);
        }, FONT_SCALE_PERSIST_MS);
        return () => {
            if (fontScalePersistTimer.current != null) {
                window.clearTimeout(fontScalePersistTimer.current);
                fontScalePersistTimer.current = null;
            }
        };
    }, [fontScale]);

    const decreaseFontScale = useCallback(() => {
        setFontScale(current => stepFontScale(current, -1));
    }, []);
    const increaseFontScale = useCallback(() => {
        setFontScale(current => stepFontScale(current, 1));
    }, []);
    const resetFontScale = useCallback(() => {
        setFontScale(FONT_SCALE_DEFAULT);
    }, []);

    // Ctrl/Cmd + wheel adjusts content text size (not VS Code window zoom when preventable).
    useEffect(() => {
        const onWheel = (event: WheelEvent) => {
            if (!(event.ctrlKey || event.metaKey)) return;
            if (event.defaultPrevented) return;
            if (document.querySelector('[aria-modal="true"]')) return;
            event.preventDefault();
            const direction: 1 | -1 = event.deltaY < 0 ? 1 : -1;
            setFontScale(current => stepFontScale(current, direction));
        };
        window.addEventListener('wheel', onWheel, { passive: false, capture: true });
        return () => window.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
    }, []);

    const applyState = useCallback((next: ReaderViewModel) => {
        // Large document swaps (e.g. language toggle) are non-urgent vs input.
        startTransition(() => {
            setView(current => {
                if (current && next.revision <= current.revision) return current;
                viewRef.current = next;
                return next;
            });
        });
        setReadyFailed(false);
    }, []);

    useEffect(() => transport.onStateChanged(applyState), [applyState, transport]);
    useEffect(() => {
        let active = true;
        const revision = viewRef.current?.revision ?? -1;
        const showPending = !viewRef.current;
        if (showPending) setPendingCount(count => count + 1);
        void transport.request('reader/ready', { revision }).then(result => {
            if (!active) return;
            if (isViewModel(result)) applyState(result);
            else if (!viewRef.current) setReadyFailed(true);
        }, error => {
            if (!active) return;
            setReadyFailed(true);
            setRequestError(`${readerMessages(viewRef.current?.uiLocale || 'en').loadFailed} ${error instanceof Error ? error.message : ''}`.trim());
        }).finally(() => { if (active && showPending) setPendingCount(count => Math.max(0, count - 1)); });
        return () => { active = false; };
    }, [applyState, readyAttempt, transport]);

    // Sync mode/query from host on revision change, but do not clobber the local
    // search box while the user is typing (live search is local source of truth).
    // Scope is derived from uiLocale only — never restored from host search.scope.
    useEffect(() => {
        if (!view) return;
        if (skipNextSearchSync.current) {
            skipNextSearchSync.current = false;
        } else {
            setQuery(view.search.query);
            setMode(view.search.mode === 'fulltext' ? 'fulltext' : 'keyword');
        }
        setSearchError(null);
        document.documentElement.lang = view.uiLocale;
        document.title = messages.documentTitle;
    }, [messages.documentTitle, view?.revision, view?.uiLocale]);

    // Clear optimistic pill once host language matches (or drop if host never moves).
    useEffect(() => {
        if (optimisticLanguage == null || !view) return;
        if (view.language === optimisticLanguage) setOptimisticLanguage(null);
    }, [view?.language, view?.revision, optimisticLanguage]);

    useEffect(() => {
        const onShortcut = (event: KeyboardEvent) => {
            if (event.key !== '/' || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
            if (document.querySelector('[aria-modal="true"]')) return;
            event.preventDefault();
            setSearchOpen(true);
        };
        window.addEventListener('keydown', onShortcut);
        return () => window.removeEventListener('keydown', onShortcut);
    }, []);

    const request = useCallback((name: string, payload: Record<string, unknown> = {}, options?: { silent?: boolean }) => {
        const revision = viewRef.current?.revision;
        if (revision === undefined) return;
        // PDF open mirrors hover cards: no global "Working…" banner (layout thrash).
        const silent = options?.silent === true;
        if (!silent) setPendingCount(count => count + 1);
        setRequestError(null);
        void transport.request(name, { revision, ...payload }).then(result => {
            if (viewRef.current?.revision !== revision) return;
            if (result === false) setRequestError(readerMessages(viewRef.current.uiLocale).requestRejected);
        }, error => {
            if (viewRef.current?.revision !== revision) return;
            const base = readerMessages(viewRef.current.uiLocale).requestFailed;
            setRequestError(`${base} ${error instanceof Error ? error.message : ''}`.trim());
        }).finally(() => {
            if (!silent) setPendingCount(count => Math.max(0, count - 1));
        });
    }, [transport]);
    const navigate = useCallback((target: string | ManualLocation) => request('reader/navigate', { target }), [request]);
    const openLink = useCallback((href: string) => request('reader/openLink', { href }), [request]);
    const openPdf = useCallback(() => request('reader/openPdf', {}, { silent: true }), [request]);
    const toggleLanguage = useCallback(() => {
        const current = viewRef.current;
        // Pack capability only — English VS Code UI may still read bilingual packs.
        if (!current || current.canToggleLanguage === false) return;
        // Optimistic pill flip; host still toggles from its own language state.
        setOptimisticLanguage(prev => {
            const base = prev ?? current.language;
            return base === 'zh' ? 'en' : 'zh';
        });
        const revision = current.revision;
        // Silent: no Working… banner (same rationale as PDF). Roll back pill if host rejects.
        void transport.request('reader/toggleLanguage', { revision }).then(result => {
            if (result === false) setOptimisticLanguage(null);
        }, () => {
            setOptimisticLanguage(null);
        });
    }, [transport]);
    const closeSearch = useCallback(() => {
        setSearchOpen(false);
        searchButtonRef.current?.focus();
    }, []);
    const toggleSearch = useCallback(() => {
        setSearchOpen(open => {
            if (open) {
                // Closing via toolbar button: restore focus after unmount.
                queueMicrotask(() => searchButtonRef.current?.focus());
                return false;
            }
            setSearchError(null);
            return true;
        });
    }, []);

    const performSearch = useCallback((force = false) => {
        const current = viewRef.current;
        if (!current) return;
        const revision = current.revision;
        const effectiveScope = scopeForUiLocale(current.uiLocale);
        const effectiveMode: ManualSearchMode = mode === 'fulltext' ? 'fulltext' : 'keyword';
        const key = searchKey(query, effectiveScope, effectiveMode);
        // Skip duplicate live searches (e.g. re-open with unchanged query).
        if (!force && lastSearchKeyRef.current === key && current.search.query === query
            && current.search.mode === effectiveMode) {
            setSearchPending(false);
            return;
        }
        const seq = ++searchSeq.current;
        lastSearchKeyRef.current = key;
        setSearchPending(true);
        setSearchError(null);
        skipNextSearchSync.current = true;
        void transport.request('reader/search', {
            revision,
            query,
            scope: effectiveScope,
            mode: effectiveMode,
        }).then(result => {
            if (searchSeq.current !== seq) return;
            if (viewRef.current?.revision === revision && result === false) {
                setSearchError(readerMessages(current.uiLocale).searchFailed);
            }
        }, error => {
            if (searchSeq.current !== seq) return;
            if (viewRef.current?.revision !== revision) return;
            const detail = error instanceof Error ? error.message : '';
            setSearchError(`${readerMessages(current.uiLocale).searchFailed} ${detail}`.trim());
        }).finally(() => {
            if (searchSeq.current === seq) setSearchPending(false);
        });
    }, [query, mode, transport]);

    // Live search while the popover is open. Do not re-run on view.revision
    // (host publish after search would otherwise double-fetch and flicker status).
    useEffect(() => {
        if (!searchOpen || !viewRef.current) return;
        const handle = window.setTimeout(() => performSearch(false), SEARCH_DEBOUNCE_MS);
        return () => window.clearTimeout(handle);
    }, [query, mode, searchOpen, performSearch]);

    if (!view) return <>
        <RequestStatusBanner error={requestError} pending={false} messages={messages} onDismiss={() => setRequestError(null)} />
        <LoadingSkeleton label={messages.loading} retryLabel={messages.retry} failed={readyFailed} onRetry={() => { setRequestError(null); setReadyFailed(false); setReadyAttempt(attempt => attempt + 1); }} />
    </>;

    // Alt translation preview is available whenever the host sent sentence pairs
    // (bilingual pack with sentence-map), independent of VS Code UI locale.
    const translationEnabled = view.content.kind === 'document'
        && view.content.sentencePairs.length > 0;
    const displayLanguage = optimisticLanguage ?? view.language;

    return <>
        <ReaderToolbar
            view={view}
            messages={messages}
            searchButtonRef={searchButtonRef}
            onOpenSearch={toggleSearch}
            onNavigate={navigate}
            onRequest={request}
            onOpenPdf={openPdf}
            displayLanguage={displayLanguage}
            onToggleLanguage={toggleLanguage}
            progress={reading.progress}
            fontScalePercentLabel={fontScalePercentLabel}
            canDecreaseFontScale={canStepFontScale(fontScale, -1)}
            canIncreaseFontScale={canStepFontScale(fontScale, 1)}
            onDecreaseFontScale={decreaseFontScale}
            onIncreaseFontScale={increaseFontScale}
            onResetFontScale={resetFontScale}
        />
        <RequestStatusBanner error={requestError} pending={pendingCount > 0} messages={messages} onDismiss={() => setRequestError(null)} />
        {searchOpen ? <SearchPopover
            query={query}
            submittedQuery={view.search.query}
            mode={mode}
            language={view.language}
            results={view.search.results}
            pending={searchPending}
            error={searchError}
            messages={messages}
            searchButtonRef={searchButtonRef}
            onQueryChange={setQuery}
            onModeChange={setMode}
            onSubmit={() => performSearch(true)}
            onNavigate={navigate}
            onClose={closeSearch}
        /> : null}
        <main className="reader-content">
            {view.content.kind === 'error'
                ? <div className="reader-error" role="alert" title={view.content.message}>{messages.documentUnavailable}</div>
                : <MarkdownViewport
                    content={view.content}
                    onOpenLink={openLink}
                    tableLabel={messages.scrollableTable}
                    translationHint={translationEnabled ? messages.translationHint : ''}
                    translationPreviewLabel={messages.translationPreview}
                    closeTranslationLabel={messages.closeTranslation}
                    imageLabels={imageLabels}
                />}
        </main>
        <footer className="reader-footer">{messages.footer}</footer>
        {reading.showBackToTop ? (
            <button
                type="button"
                className="reader-back-to-top"
                aria-label={messages.backToTop}
                title={messages.backToTop}
                onClick={reading.backToTop}
            >
                <IconArrowUp />
            </button>
        ) : null}
    </>;
}
