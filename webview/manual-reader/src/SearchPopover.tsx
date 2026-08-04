import React, { useEffect, useId, useRef, useState } from 'react';
import type {
    ManualLanguage,
    ManualLocation,
    ManualSearchMode,
    ManualSearchResult,
} from '../../../src/manual/readerProtocol';
import type { ReaderMessages } from './readerI18n';

function escaped(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function HighlightedText({ text, query }: { text: string; query: string }): React.JSX.Element {
    const needle = query.trim();
    if (!needle) return <>{text}</>;
    const pieces = text.split(new RegExp(`(${escaped(needle)})`, 'ig'));
    return <>{pieces.map((piece, index) => piece.toLocaleLowerCase() === needle.toLocaleLowerCase()
        ? <mark key={`${piece}-${index}`}>{piece}</mark>
        : <React.Fragment key={`${piece}-${index}`}>{piece}</React.Fragment>)}</>;
}

interface SearchPopoverProps {
    query: string;
    submittedQuery: string;
    mode: ManualSearchMode;
    language: ManualLanguage;
    results: ManualSearchResult[];
    pending: boolean;
    error: string | null;
    messages: ReaderMessages;
    searchButtonRef: React.RefObject<HTMLButtonElement | null>;
    onQueryChange: (value: string) => void;
    onModeChange: (mode: ManualSearchMode) => void;
    onSubmit: () => void;
    onNavigate: (target: ManualLocation) => void;
    onClose: () => void;
}

export function SearchPopover({
    query, submittedQuery, mode, language, results, pending, error, messages,
    searchButtonRef, onQueryChange, onModeChange, onSubmit, onNavigate, onClose,
}: SearchPopoverProps): React.JSX.Element {
    const rootRef = useRef<HTMLElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const listId = useId();
    const [activeIndex, setActiveIndex] = useState(0);
    const isKeyword = mode !== 'fulltext';
    useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
    useEffect(() => setActiveIndex(index => Math.min(index, Math.max(0, results.length - 1))), [results.length]);

    // Close when pressing outside the popover; ignore the toolbar search toggle (it owns open/close).
    useEffect(() => {
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (rootRef.current?.contains(target)) return;
            if (searchButtonRef.current?.contains(target)) return;
            onClose();
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
    }, [onClose, searchButtonRef]);

    const choose = (index: number) => {
        const result = results[index];
        if (!result) return;
        onNavigate(result.location);
        onClose();
    };
    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
        if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(index => results.length ? (index + 1) % results.length : 0); return; }
        if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(index => results.length ? (index - 1 + results.length) % results.length : 0); return; }
        if (event.key === 'Home') { event.preventDefault(); setActiveIndex(0); return; }
        if (event.key === 'End') { event.preventDefault(); setActiveIndex(Math.max(0, results.length - 1)); return; }
        if (event.key === 'Enter') {
            event.preventDefault();
            if (results.length > 0 && query.trim() === submittedQuery.trim()) choose(activeIndex);
            else onSubmit();
        }
    };

    const hint = !submittedQuery
        ? (isKeyword ? messages.searchHintKeyword : messages.searchHintFulltext)
        : null;

    // Keep last count visible while a follow-up search is in flight (avoids "N results" ↔ "Searching…" flicker).
    const showSearching = pending && results.length === 0 && !submittedQuery;
    const summary = error
        || (showSearching
            ? messages.searching
            : (submittedQuery
                ? (results.length ? messages.resultCount(results.length) : messages.noResults)
                : (hint || messages.searchHint)));

    return <section
        ref={rootRef}
        className="reader-search-popover"
        role="dialog"
        aria-label={messages.searchManuals}
        aria-busy={pending || undefined}
        onKeyDown={onKeyDown}
    >
        <div className="reader-search-controls">
            <div className="reader-search-input-wrap">
                <input
                    ref={inputRef}
                    type="search"
                    aria-label={messages.searchManuals}
                    aria-controls={listId}
                    aria-expanded={results.length > 0}
                    aria-activedescendant={results.length ? `${listId}-${activeIndex}` : undefined}
                    placeholder={messages.searchManuals}
                    value={query}
                    onChange={event => onQueryChange(event.currentTarget.value)}
                />
                <button
                    type="button"
                    className="reader-search-mode-toggle"
                    aria-pressed={isKeyword}
                    aria-label={isKeyword ? messages.searchModeKeywordTitle : messages.searchModeFulltextTitle}
                    title={isKeyword ? messages.searchModeKeywordTitle : messages.searchModeFulltextTitle}
                    onClick={() => onModeChange(isKeyword ? 'fulltext' : 'keyword')}
                >
                    {isKeyword ? messages.searchModeKeyword : messages.searchModeFulltext}
                </button>
            </div>
        </div>
        <div className="reader-search-summary" role={error ? 'alert' : 'status'}>
            {summary}
        </div>
        <div className="reader-search-results" id={listId} role="listbox" aria-label={messages.searchResults}>
            {results.map((result, index) => {
                const title = language === 'zh' && result.titleZh ? result.titleZh : result.titleEn;
                return <button
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    key={`${result.location.manualId}:${result.location.sectionId}`}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => choose(index)}
                >
                    <strong><HighlightedText text={title} query={query} /></strong>
                    {result.preview ? <small><HighlightedText text={result.preview} query={query} /></small> : null}
                </button>;
            })}
        </div>
    </section>;
}
