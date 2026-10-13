'use strict';

/**
 * Webview-backed manual table of contents.  The provider deliberately reads
 * only the runtime ManualIndexRepository so it can be refreshed whenever the
 * active manual pack changes.
 *
 * Titles are always English (source labels). Search reuses the same
 * ManualIndexRepository.search as the main reader.
 *
 * TOC layout: volume → chapter (chunks/<dir>) → section, with <details>
 * collapsed by default and the current reading path expanded.
 */

import * as vscode from 'vscode';
import path from 'node:path';
import {
    ManualDocument,
    ManualIndexRepository,
    ManualLocation,
    ManualSearchMode,
    ManualSearchResult,
    ManualSearchScope,
    SectionRecord,
} from './ManualIndexRepository';
import {
    buildChapterGroups,
    ChapterGroup,
    findChapterKeyForSection,
} from './manualSidebarTree';
const i18n = require('../core/i18n');

export type ManualLocationOpener = (location: ManualLocation) => void;

/** Escapes text and attribute values before embedding them in a webview. */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function uiLocale(): 'en' | 'zh' {
    return i18n.getLanguage() === 'zh-cn' ? 'zh' : 'en';
}

/**
 * Renders the four-volume manual hierarchy in an Activity Bar webview view.
 * The caller owns opening the main reader, allowing sidebar and command
 * navigation to share the same reader lifecycle.
 */
export class ManualSidebarProvider implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;
    private repo: ManualIndexRepository | undefined;
    private currentLocation: ManualLocation | undefined;
    private emptyMessage: string;
    private usesDefaultEmptyMessage: boolean;
    private loadFailed = false;
    private pageRevision = 0;
    /** True after a full HTML paint that includes the pack TOC (not the empty state). */
    private tocLive = false;

    constructor(
        private readonly openLocation: ManualLocationOpener,
        emptyMessage?: string,
        private readonly retryLoad?: () => void,
    ) {
        this.usesDefaultEmptyMessage = emptyMessage === undefined;
        this.emptyMessage = emptyMessage || i18n.get('manualSidebarNoPack');
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        this.tocLive = false;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.resolve(__dirname, '../webview/manual-reader/icons'))] };
        view.webview.onDidReceiveMessage(message => this.onMessage(message));
        this.render();
    }

    /**
     * Updates the displayed pack and highlighted location.
     * Same pack + live TOC: post an incremental active-location update so the
     * webview keeps scroll position (avoids jump-to-bottom on every click).
     * Pack change / first paint: full HTML re-render.
     */
    refresh(repo: ManualIndexRepository | undefined, currentLocation?: ManualLocation, loadFailed = false): void {
        const samePack = Boolean(repo && this.repo && repo === this.repo && this.tocLive && this.view);
        this.repo = repo;
        this.currentLocation = currentLocation;
        this.loadFailed = loadFailed;
        if (samePack) {
            this.postActiveLocation();
            return;
        }
        this.render();
    }

    /** Lets the extension provide a localized or context-specific empty state. */
    setEmptyMessage(message: string): void {
        this.usesDefaultEmptyMessage = !message;
        this.emptyMessage = message || i18n.get('manualSidebarNoPack');
        if (!this.repo) this.render();
    }

    /** Rebuilds localized webview chrome while preserving the current pack and location. */
    refreshUiLanguage(): void {
        if (this.usesDefaultEmptyMessage) this.emptyMessage = i18n.get('manualSidebarNoPack');
        this.render();
    }

    private postActiveLocation(): void {
        if (!this.view) return;
        const loc = this.currentLocation;
        let chapterKey: string | null = null;
        if (loc && this.repo) {
            try {
                const groups = buildChapterGroups(this.repo.listSections(loc.manualId));
                chapterKey = findChapterKeyForSection(groups, loc.sectionId);
            } catch {
                chapterKey = null;
            }
        }
        void this.view.webview.postMessage({
            type: 'setActiveLocation',
            revision: this.pageRevision,
            manualId: loc?.manualId ?? null,
            sectionId: loc?.sectionId ?? null,
            chapterKey,
        });
    }

    private searchScope(): ManualSearchScope {
        // Chinese UI: search both indexes (section titles are often English).
        // English UI: English index only.
        return uiLocale() === 'zh' ? 'both' : 'en';
    }

    private onMessage(message: unknown): void {
        if (!message || typeof message !== 'object') return;
        const data = message as {
            type?: unknown;
            manualId?: unknown;
            sectionId?: unknown;
            anchorId?: unknown;
            query?: unknown;
            requestId?: unknown;
            mode?: unknown;
            revision?: unknown;
        };

        // A replaced page must never search, open or copy against the new pack.
        if (data.revision !== this.pageRevision) return;

        if (data.type === 'retryLoad') {
            this.retryLoad?.();
            return;
        }

        if (data.type === 'search' && typeof data.query === 'string') {
            const mode: ManualSearchMode = data.mode === 'fulltext' ? 'fulltext' : 'keyword';
            this.replySearch(data.query, typeof data.requestId === 'number' ? data.requestId : 0, mode);
            return;
        }

        if (!['openLocation', 'copyKeyword'].includes(String(data.type)) || typeof data.manualId !== 'string' || typeof data.sectionId !== 'string') {
            return;
        }
        if (!this.repo) return;

        const section = this.repo.getSection(data.manualId, data.sectionId);
        if (!section) return;
        if (data.type === 'copyKeyword') {
            const keyword = this.copyableKeyword(section.titleEn);
            if (!keyword) return;
            const revision = this.pageRevision;
            void Promise.resolve().then(() => vscode.env.clipboard.writeText(keyword)).then(
                () => this.copyStatus(revision, true),
                () => this.copyStatus(revision, false),
            );
            return;
        }
        const anchorId = typeof data.anchorId === 'string' && section.anchors.includes(data.anchorId)
            ? data.anchorId
            : null;
        this.openLocation({
            manualId: section.manualId,
            sectionId: section.sectionId,
            anchorId,
            title: section.titleEn,
            pdfPage: section.pdfPage || null,
        });
    }

    private replySearch(query: string, requestId: number, mode: ManualSearchMode = 'keyword'): void {
        if (!this.view) return;
        try {
            // ponytail: display at most 100 results; add paging only when users need broader browsing.
            const found = this.repo ? this.repo.search(query, this.searchScope(), 101, mode) : [];
            const chapters = mode === 'fulltext' ? new Map<string, Map<string, string>>() : undefined;
            const results = found.slice(0, 100).map(result => this.serializeResult(result, chapters));
            void this.view.webview.postMessage({ type: 'searchResults', revision: this.pageRevision,
                requestId, query, mode, results, truncated: found.length > 100 });
        } catch {
            void this.view.webview.postMessage({ type: 'searchResults', revision: this.pageRevision,
                requestId, query, mode, results: [], failed: true });
        }
    }

    private copyableKeyword(title: string): string | null {
        const value = title.trim();
        return /^\*[A-Z][A-Z0-9_]*$/i.test(value) ? value : null;
    }

    private copyStatus(revision: number, copied: boolean): void {
        if (revision !== this.pageRevision) return;
        void this.view?.webview.postMessage({ type: 'copyStatus', revision, copied });
    }

    private serializeResult(result: ManualSearchResult, chapters?: Map<string, Map<string, string>>) {
        const manualId = result.location.manualId;
        if (chapters && !chapters.has(manualId)) {
            const labels = new Map<string, string>();
            for (const group of buildChapterGroups(this.repo!.listSections(manualId))) {
                for (const section of group.sections) labels.set(section.sectionId, group.label);
            }
            chapters.set(manualId, labels);
        }
        return {
            manualId: result.location.manualId,
            sectionId: result.location.sectionId,
            title: result.titleEn || result.location.sectionId,
            preview: result.preview || '',
            volumeTitle: result.volumeTitle || this.repo?.listDocuments()
                .find(document => document.manualId === result.location.manualId)?.title || i18n.get('manualSidebarUnknownVolume'),
            chapterTitle: chapters?.get(manualId)?.get(result.location.sectionId),
            keyword: this.copyableKeyword(result.titleEn),
        };
    }

    private render(): void {
        if (!this.view) return;
        this.pageRevision += 1;
        const painted = this.html();
        this.view.description = painted.tocLive
            ? `↑↓ ${i18n.get('manualSidebarNavigate')} · Enter ${i18n.get('manualSidebarOpen')} · Esc ${i18n.get('manualSidebarClear')}`
            : undefined;
        this.view.webview.html = painted.html;
        // Full HTML replacement resets webview scroll; only mark TOC live when pack tree painted.
        this.tocLive = painted.tocLive;
    }

    private html(): { html: string; tocLive: boolean } {
        if (!this.repo) {
            if (this.loadFailed) return this.loadError();
            return { html: this.page(`<p class="empty">${escapeHtml(this.emptyMessage)}</p>`, false), tocLive: false };
        }

        try {
            const documents = this.repo.listDocuments();
            const content = documents.map(document => this.renderDocument(document)).join('');
            if (!content) {
                return { html: this.page(`<p class="empty">${escapeHtml(i18n.get('manualSidebarEmpty'))}</p>`, false), tocLive: false };
            }
            return { html: this.page(content, true), tocLive: true };
        } catch {
            return this.loadError();
        }
    }

    private loadError(): { html: string; tocLive: boolean } {
        const retry = this.retryLoad ? `<button type="button" class="retry-load">${escapeHtml(i18n.get('manualSidebarRetry'))}</button>` : '';
        return { html: this.page(`<p class="empty load-error" role="status">${escapeHtml(i18n.get('manualSidebarLoadFailed'))}</p>${retry}`, false), tocLive: false };
    }

    private renderDocument(document: ManualDocument): string {
        const sections = this.repo!.listSections(document.manualId);
        const groups = buildChapterGroups(sections);
        const current = this.currentLocation;
        const volumeOpen = Boolean(current && current.manualId === document.manualId);
        const activeChapterKey = volumeOpen
            ? findChapterKeyForSection(groups, current!.sectionId)
            : null;

        const chaptersHtml = groups.map(group => this.renderChapter(document.manualId, group, activeChapterKey)).join('');
        const openAttr = volumeOpen ? ' open' : '';
        const title = document.title.replace(/^LS-DYNA\s+(?:dev\s+)?/i, '')
            .replace(/^Keyword Manual (Vol [IVX]+)(?:\s*[–—-]\s*(.+))?$/,
                (_, volume, subtitle) => `${volume} · ${subtitle || 'Keyword Manual'}`);
        return `<details class="volume" data-manual-id="${escapeHtml(document.manualId)}"${openAttr}>
<summary class="volume__summary" title="${escapeHtml(document.title)}">${escapeHtml(title)}</summary>
<div class="volume__body">${chaptersHtml}</div>
</details>`;
    }

    private renderChapter(
        manualId: string,
        group: ChapterGroup<SectionRecord>,
        activeChapterKey: string | null,
    ): string {
        const openAttr = activeChapterKey === group.key ? ' open' : '';
        const count = group.sections.length;
        const summaryLabel = `${group.label} (${count})`;
        const sectionsHtml = group.sections.map(section => this.renderSection(section)).join('');
        return `<details class="chapter" data-manual-id="${escapeHtml(manualId)}" data-chapter-key="${escapeHtml(group.key)}"${openAttr}>
<summary class="chapter__summary" title="${escapeHtml(summaryLabel)}">${escapeHtml(group.label)}<span class="chapter__count">${count}</span></summary>
<nav class="chapter__sections" aria-label="${escapeHtml(group.label)}">${sectionsHtml}</nav>
</details>`;
    }

    private renderSection(section: SectionRecord): string {
        const active = this.currentLocation
            && this.currentLocation.manualId === section.manualId
            && this.currentLocation.sectionId === section.sectionId;
        // English source titles only — no ZH secondary line.
        return `<button type="button" class="section${active ? ' active' : ''}" data-manual-id="${escapeHtml(section.manualId)}" data-section-id="${escapeHtml(section.sectionId)}" title="${escapeHtml(section.titleEn)}">${escapeHtml(section.titleEn)}</button>`;
    }

    private page(content: string, enableSearch: boolean): string {
        const nonce = String(Date.now());
        const iconUri = (name: string) => escapeHtml(String(this.view!.webview.asWebviewUri(
            vscode.Uri.file(path.resolve(__dirname, '../webview/manual-reader/icons', `${name}.svg`)))));
        const locale = uiLocale();
        const labels = Object.fromEntries([
            ['empty', 'manualSidebarSearchNoResults'], ['singular', 'manualSidebarSearchResultSingular'],
            ['plural', 'manualSidebarSearchResultPlural'], ['loading', 'manualSidebarSearchLoading'],
            ['failed', 'manualSidebarSearchFailed'], ['truncated', 'manualSidebarSearchTruncated'],
            ['open', 'manualSidebarOpenResult'], ['copy', 'manualSidebarCopyKeyword'],
            ['copied', 'manualSidebarCopied'], ['copyFailed', 'manualSidebarCopyFailed'],
            ['keywordHint', 'manualSidebarSearchModeKeywordTitle'], ['fulltextHint', 'manualSidebarSearchModeFulltextTitle'],
        ].map(([key, localeKey]) => [key, i18n.get(localeKey)]));
        const searchChrome = enableSearch ? `
<div class="search-bar">
  <div class="search-input-wrap">
    <span class="sidebar-icon search-icon" aria-hidden="true"></span>
    <input id="sidebar-search" type="text" placeholder="${escapeHtml(i18n.get('manualReaderSearchPlaceholder'))}" aria-label="${escapeHtml(i18n.get('manualReaderSearch'))}" autocomplete="off" spellcheck="false" />
    <button id="search-clear" type="button" title="${escapeHtml(i18n.get('manualSidebarSearchClear'))}" aria-label="${escapeHtml(i18n.get('manualSidebarSearchClear'))}" hidden><span class="sidebar-icon close-icon" aria-hidden="true"></span></button>
  </div>
  <div id="sidebar-search-mode" class="search-modes" role="group" aria-label="${escapeHtml(i18n.get('manualReaderSearchScope'))}">
    <button type="button" data-mode="keyword" aria-pressed="true">${escapeHtml(i18n.get('manualSidebarSearchModeKeyword'))}</button>
    <button type="button" data-mode="fulltext" aria-pressed="false">${escapeHtml(i18n.get('manualSidebarSearchModeFulltext'))}</button>
  </div>
  <p id="search-mode-hint" class="search-mode-hint"></p>
  <div id="copy-status" class="search-mode-hint" role="status" hidden></div>
</div>
<div id="search-panel" class="search-panel" hidden>
  <div id="search-status" class="search-status" role="status" aria-live="polite"></div>
  <button type="button" class="search-retry" hidden>${escapeHtml(i18n.get('manualSidebarSearchRetry'))}</button>
  <div id="search-results" class="search-results" aria-label="${escapeHtml(i18n.get('manualReaderSearch'))}"></div>
</div>` : '';
        // String.raw preserves regex escapes in the embedded webview script.
        return String.raw`<!DOCTYPE html>
<html lang="${locale === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.view!.webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html, body { height: 100%; box-sizing: border-box; }
* { box-sizing: border-box; }
body {
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background, transparent);
  display: flex;
  flex-direction: column;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  margin: 0;
  overflow: hidden;
  padding: 8px 0;
}
html { scrollbar-color: auto; scrollbar-width: auto; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { border-radius: 0; background: var(--vscode-scrollbarSlider-background); }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
body > :not(#toc):not(.search-panel) { margin-left: 8px; margin-right: 8px; }
#toc, .search-results { padding: 0 8px; }
.search-status { margin: 0 8px; }
button, input { font: inherit; color: inherit; }
button { cursor: pointer; }
[hidden] { display: none !important; }
button:focus-visible, input:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.volume, .chapter { margin: 0; }
.volume__summary, .chapter__summary {
  cursor: pointer; list-style: none; padding: 4px;
  line-height: 1.5; overflow-wrap: anywhere; user-select: none;
}
.volume__summary::-webkit-details-marker, .chapter__summary::-webkit-details-marker, .result-group__header::-webkit-details-marker { display: none; }
.volume__summary::before, .chapter__summary::before, .result-group__header::before { content: ''; background-color: var(--vscode-descriptionForeground); display: inline-block; margin-right: 6px; width: 16px; height: 16px; flex: 0 0 16px; vertical-align: middle; mask: url('${iconUri('chevron-right')}') center / contain no-repeat; }
.volume[open] > .volume__summary::before, .chapter[open] > .chapter__summary::before, .result-group[open] > .result-group__header::before { transform: rotate(90deg); }
.volume__summary:hover, .chapter__summary:hover, .result-group__header:hover { background: var(--vscode-list-hoverBackground); }
.volume__body { padding-bottom: 4px; }
.chapter__summary { padding-left: 12px; }
.chapter__count { color: var(--vscode-descriptionForeground); font-size: .9em; margin-left: 6px; }
.chapter__count::before { content: '('; }
.chapter__count::after { content: ')'; }
.chapter__sections { padding: 0 0 4px 8px; }
.section { background: transparent; border: 0; border-radius: 2px; display: block; line-height: 1.45; padding: 4px 4px 4px 22px; text-align: left; overflow-wrap: anywhere; width: 100%; }
.section:hover { background: var(--vscode-list-hoverBackground); }
.section.active, .result-row.active { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); }
body.has-focus .section.active, body.has-focus .result-row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.empty { color: var(--vscode-descriptionForeground); line-height: 1.6; padding: 8px; }
.load-error { margin: 0; padding: 4px 8px; }
.retry-load, .search-retry { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-contrastBorder, transparent); padding: 5px 8px; white-space: normal; }
.retry-load:hover, .search-retry:hover { background: var(--vscode-button-hoverBackground); }
.search-retry { align-self: flex-start; margin: 4px; }
.search-bar { flex: 0 0 auto; margin-bottom: 8px; }
.search-input-wrap { display: flex; align-items: center; gap: 6px; width: 100%; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius: 20px; background: var(--vscode-input-background); padding: 3px 8px; }
.search-input-wrap:focus-within { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
.sidebar-icon { display: inline-block; width: 16px; height: 16px; background-color: currentColor; flex: 0 0 auto; mask-position: center; mask-size: contain; mask-repeat: no-repeat; }
.search-icon { mask-image: url('${iconUri('search')}'); }
.close-icon { mask-image: url('${iconUri('close')}'); }
.search-icon { color: var(--vscode-descriptionForeground); }
.search-bar input { width: 0; flex: 1 1 auto; min-width: 0; background: transparent; border: 0; outline: 0; color: var(--vscode-input-foreground); min-height: 26px; padding: 2px 0; }
.search-bar input::placeholder { color: var(--vscode-input-placeholderForeground); }
#search-clear { display: flex; align-items: center; background: transparent; border: 0; border-radius: 4px; padding: 4px; }
#search-clear:hover { background: var(--vscode-toolbar-hoverBackground); }
.search-modes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.search-modes button { background: transparent; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-descriptionForeground))); border-radius: 18px; padding: 4px 9px; font-size: .9em; line-height: 1.4; }
.search-modes button:hover { background: var(--vscode-list-hoverBackground); }
.search-modes button[aria-pressed="true"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: var(--vscode-focusBorder); }
.search-mode-hint { color: var(--vscode-descriptionForeground); font-size: .85em; line-height: 1.5; margin: 7px 2px 0; overflow-wrap: anywhere; }
.search-panel { display: flex; flex: 1 1 auto; flex-direction: column; min-height: 0; }
.search-panel[hidden] { display: none !important; }
.search-status { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: .9em; line-height: 1.5; padding: 4px 4px 8px; overflow-wrap: anywhere; }
.search-results { flex: 1 1 auto; min-height: 0; overflow: auto; }
.result-group__header { position: sticky; top: 0; z-index: 1; display: flex; align-items: baseline; list-style: none; cursor: pointer; padding: 7px 5px; background: var(--vscode-sideBarSectionHeader-background, var(--vscode-sideBar-background)); border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent)); }
.result-group__title { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: .9em; font-weight: 600; }
.result-group__count { flex: 0 0 auto; margin-left: 6px; color: var(--vscode-descriptionForeground); font-size: .85em; }
.result-row { border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent)); }
.result-row:not(.active):hover, .result-row:not(.active):focus-within { background: var(--vscode-list-hoverBackground); color: var(--vscode-list-hoverForeground, var(--vscode-foreground)); }
.result-row:focus-within { box-shadow: inset 2px 0 var(--vscode-focusBorder); }
.search-result { background: transparent; border: 0; display: block; line-height: 1.5; padding: 9px 6px 7px; text-align: left; width: 100%; }
.search-result strong { display: block; font-family: var(--vscode-editor-font-family, monospace); font-size: .95em; font-weight: 500; overflow-wrap: anywhere; }
.search-result small { display: block; color: var(--vscode-descriptionForeground); font-size: .9em; line-height: 1.6; margin-top: 5px; overflow-wrap: anywhere; }
.search-result .result-source { font-size: .85em; margin: 0 0 5px; }
mark { background: transparent; color: var(--vscode-list-highlightForeground, var(--vscode-focusBorder)); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.result-row.active small, .result-row.active .result-copy { color: inherit; }
.result-row.active mark { color: inherit; }
.result-row.active { outline: 1px solid var(--vscode-contrastActiveBorder, transparent); outline-offset: -1px; }
.result-actions { display: flex; justify-content: flex-end; padding: 0 5px 6px; min-height: 28px; visibility: hidden; }
.result-row:hover .result-actions, .result-row:focus-within .result-actions, .result-row.active .result-actions { visibility: visible; }
.result-copy { background: transparent; border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent)); border-radius: 3px; padding: 2px 6px; font-size: .85em; line-height: 1.4; white-space: normal; }
.result-copy:hover { background: var(--vscode-toolbar-hoverBackground); }
#toc { flex: 1 1 auto; min-height: 0; overflow: auto; }
#toc.hidden { display: none !important; }
@media (max-height: 350px) {
  body { overflow: auto; }
  .search-panel, #toc { flex: 0 0 auto; overflow: visible; }
  .search-results { flex: 0 0 auto; overflow: visible; }
}
</style>
</head>
<body>
${searchChrome}
<div id="toc">${content}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const updateFocus = () => document.body.classList.toggle('has-focus', document.hasFocus());
window.addEventListener('focus', updateFocus);
window.addEventListener('blur', updateFocus);
document.addEventListener('focusin', updateFocus);
updateFocus();
const revision = ${this.pageRevision};
const labels = ${JSON.stringify(labels)};
const DEBOUNCE_MS = 250;
const toc = document.getElementById('toc');
const searchInput = document.getElementById('sidebar-search');
const modeButtons = Array.from(document.querySelectorAll('.search-modes button'));
const clearButton = document.getElementById('search-clear');
const modeHint = document.getElementById('search-mode-hint');
const copyStatus = document.getElementById('copy-status');
const searchPanel = document.getElementById('search-panel');
const searchStatus = document.getElementById('search-status');
const searchResults = document.getElementById('search-results');
const searchRetry = document.querySelector('.search-retry');
let requestId = 0, timer = 0, composing = false;
let searchMode = 'keyword';
let activeManualId = null, activeSectionId = null;

function post(message) { vscode.postMessage(Object.assign({ revision }, message)); }
function openLocation(manualId, sectionId) { post({ type: 'openLocation', manualId, sectionId }); }
function countText(count) { return count === 1 ? labels.singular : labels.plural.replace('{0}', String(count)); }
function syncSearchModeButton() {
  for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === searchMode));
  if (modeHint) modeHint.textContent = searchMode === 'keyword' ? labels.keywordHint : labels.fulltextHint;
}
function clearSearch() { searchInput.value = ''; scheduleSearch(false); searchInput.focus(); }
function scheduleSearch(immediate) {
  if (!searchInput) return;
  window.clearTimeout(timer);
  const id = ++requestId, q = searchInput.value, mode = searchMode;
  clearButton.hidden = !q.trim();
  copyStatus.hidden = true;
  searchRetry.hidden = true;
  searchResults.replaceChildren();
  if (!q.trim()) { searchPanel.hidden = true; toc.classList.remove('hidden'); return; }
  searchPanel.hidden = false;
  toc.classList.add('hidden');
  searchStatus.textContent = labels.loading;
  const run = () => post({ type: 'search', query: q, requestId: id, mode });
  if (immediate) run(); else timer = window.setTimeout(run, DEBOUNCE_MS);
}

// Highlight literal terms and separator-insensitive spans without inserting source HTML.
function appendHighlights(element, text, query) {
  const indices = new Set(), lower = text.toLocaleLowerCase();
  const terms = query.trim().toLocaleLowerCase().replace(/^\*+/, '').split(/[\s_\-./]+/).filter(Boolean);
  for (const term of terms) {
    let start = lower.indexOf(term);
    while (start >= 0) { for (let i = start; i < start + term.length; i++) indices.add(i); start = lower.indexOf(term, start + term.length); }
  }
  const positions = text.split('').map((ch, i) => ({ ch, i })).filter(value => !/[\s*_\-./]/.test(value.ch));
  const skeleton = positions.map(value => value.ch).join('').toLocaleLowerCase();
  const needle = query.toLocaleLowerCase().replace(/^\*+/, '').replace(/[\s_\-./]+/g, '');
  const offset = skeleton.indexOf(needle);
  if (needle && offset >= 0) for (const value of positions.slice(offset, offset + needle.length)) indices.add(value.i);
  for (let start = 0; start < text.length;) {
    let end = start + 1;
    while (end < text.length && indices.has(end) === indices.has(start)) end++;
    const part = text.slice(start, end);
    if (indices.has(start)) { const mark = document.createElement('mark'); mark.textContent = part; element.append(mark); }
    else element.append(document.createTextNode(part));
    start = end;
  }
}

function resultRow(result, query) {
  const row = document.createElement('div'), button = document.createElement('button');
  row.className = 'result-row';
  button.type = 'button'; button.className = 'search-result';
  button.dataset.manualId = result.manualId; button.dataset.sectionId = result.sectionId;
  const title = result.title || result.sectionId;
  button.title = title; button.setAttribute('aria-label', labels.open.replace('{0}', title));
  if (searchMode === 'fulltext') { const source = document.createElement('small'); source.className = 'result-source'; source.textContent = [result.volumeTitle, result.chapterTitle].filter(Boolean).join(' · '); button.append(source); }
  const strong = document.createElement('strong'); appendHighlights(strong, title, query); button.append(strong);
  if (result.preview) { const preview = document.createElement('small'); appendHighlights(preview, result.preview, query); button.append(preview); }
  row.append(button);
  if (result.keyword) {
    const actions = document.createElement('div'), copy = document.createElement('button');
    actions.className = 'result-actions'; copy.className = 'result-copy'; copy.type = 'button'; copy.textContent = labels.copy;
    copy.title = result.keyword; copy.setAttribute('aria-label', labels.copy + ': ' + result.keyword);
    copy.dataset.manualId = result.manualId; copy.dataset.sectionId = result.sectionId;
    actions.append(copy); row.append(actions);
  }
  return row;
}
function syncActiveResults() {
  for (const button of document.querySelectorAll('.search-result')) {
    const active = button.dataset.manualId === activeManualId && button.dataset.sectionId === activeSectionId;
    button.setAttribute('aria-current', String(active)); button.parentElement.classList.toggle('active', active);
  }
}
function renderResults(data) {
  searchResults.replaceChildren(); searchRetry.hidden = !data.failed;
  if (data.failed) { searchStatus.textContent = labels.failed; return; }
  const results = Array.isArray(data.results) ? data.results : [];
  searchStatus.textContent = data.truncated ? labels.truncated.replace('{0}', String(results.length)) : results.length ? countText(results.length) : labels.empty;
  if (searchMode === 'fulltext') for (const result of results) searchResults.append(resultRow(result, data.query));
  else {
    const groups = new Map();
    for (const result of results) {
      let entry = groups.get(result.manualId);
      if (!entry) {
        const group = document.createElement('details'), header = document.createElement('summary'), title = document.createElement('span'), count = document.createElement('span');
        group.className = 'result-group'; group.open = true; header.className = 'result-group__header'; title.className = 'result-group__title'; title.textContent = result.volumeTitle;
        count.className = 'result-group__count';
        header.append(title, count); const body = document.createElement('div'); group.append(header, body); searchResults.append(group);
        entry = { body, count, total: 0 }; groups.set(result.manualId, entry);
      }
      entry.count.textContent = countText(++entry.total); entry.body.append(resultRow(result, data.query));
    }
  }
  syncActiveResults();
}

document.addEventListener('click', event => {
  if (event.target.closest('button.retry-load')) { post({ type: 'retryLoad' }); return; }
  if (event.target.closest('button.search-retry')) { scheduleSearch(true); return; }
  const copy = event.target.closest('button.result-copy');
  if (copy) { post({ type: 'copyKeyword', manualId: copy.dataset.manualId, sectionId: copy.dataset.sectionId }); return; }
  const button = event.target.closest('button.section, button.search-result');
  if (button) openLocation(button.dataset.manualId, button.dataset.sectionId);
});
if (searchInput) {
  syncSearchModeButton();
  searchInput.addEventListener('input', event => { if (!composing && !event.isComposing) scheduleSearch(false); });
  searchInput.addEventListener('compositionstart', () => { composing = true; window.clearTimeout(timer); requestId++; searchResults.replaceChildren(); });
  searchInput.addEventListener('compositionend', () => { composing = false; scheduleSearch(false); });
  clearButton.addEventListener('click', clearSearch);
  for (const button of modeButtons) button.addEventListener('click', () => { searchMode = button.dataset.mode; syncSearchModeButton(); scheduleSearch(true); });
}
document.addEventListener('keydown', event => {
  if (composing || event.isComposing || !searchInput) return;
  if (event.key === 'Escape') { event.preventDefault(); clearSearch(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) || searchPanel.hidden) return;
  const fromInput = event.target === searchInput, fromResult = event.target.classList.contains('search-result');
  if (!fromInput && !fromResult) return;
  const buttons = Array.from(searchResults.querySelectorAll('.search-result')).filter(button => button.getClientRects().length);
  if (!buttons.length) return;
  if (event.key === 'Enter') { if (fromInput) { event.preventDefault(); buttons[0].click(); } return; }
  event.preventDefault();
  const index = buttons.indexOf(document.activeElement), delta = event.key === 'ArrowDown' ? 1 : -1;
  buttons[index < 0 ? delta > 0 ? 0 : buttons.length - 1 : (index + delta + buttons.length) % buttons.length].focus();
});
function isMostlyVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.top >= 12 && rect.bottom <= window.innerHeight - 12 && rect.height > 0;
}
function revealIfNeeded(element) {
  if (element.getClientRects().length && !isMostlyVisible(element)) element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function setActiveLocation(manualId, sectionId, chapterKey) {
  activeManualId = manualId; activeSectionId = sectionId; syncActiveResults();
  for (const button of toc.querySelectorAll('button.section.active')) button.classList.remove('active');
  if (!manualId || !sectionId) return;
  // Dataset matching avoids constructing selectors from source identifiers.
  for (const volume of toc.querySelectorAll('details.volume')) if (volume.dataset.manualId === manualId) volume.open = true;
  for (const chapter of toc.querySelectorAll('details.chapter')) if (chapter.dataset.manualId === manualId && chapter.dataset.chapterKey === chapterKey) chapter.open = true;
  const active = Array.from(toc.querySelectorAll('button.section')).find(button => button.dataset.manualId === manualId && button.dataset.sectionId === sectionId);
  if (active) { active.classList.add('active'); requestAnimationFrame(() => revealIfNeeded(active)); }
}
window.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'searchResults') {
    if (!searchInput || data.revision !== revision || data.requestId !== requestId || data.query !== searchInput.value || data.mode !== searchMode || composing || !searchInput.value.trim()) return;
    renderResults(data); return;
  }
  if (data.type === 'copyStatus' && data.revision === revision && copyStatus) { copyStatus.textContent = data.copied ? labels.copied : labels.copyFailed; copyStatus.hidden = false; return; }
  if (data.type === 'setActiveLocation' && data.revision === revision) setActiveLocation(data.manualId || null, data.sectionId || null, data.chapterKey || null);
});
const initialActive = document.querySelector('#toc button.section.active');
if (initialActive) { activeManualId = initialActive.dataset.manualId; activeSectionId = initialActive.dataset.sectionId; requestAnimationFrame(() => revealIfNeeded(initialActive)); }
</script>
</body>
</html>`;
    }
}
