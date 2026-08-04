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
    /** True after a full HTML paint that includes the pack TOC (not the empty state). */
    private tocLive = false;

    constructor(
        private readonly openLocation: ManualLocationOpener,
        emptyMessage?: string,
    ) {
        this.usesDefaultEmptyMessage = emptyMessage === undefined;
        this.emptyMessage = emptyMessage || i18n.get('manualSidebarNoPack');
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        this.tocLive = false;
        view.webview.options = { enableScripts: true };
        view.webview.onDidReceiveMessage(message => this.onMessage(message));
        this.render();
    }

    /**
     * Updates the displayed pack and highlighted location.
     * Same pack + live TOC: post an incremental active-location update so the
     * webview keeps scroll position (avoids jump-to-bottom on every click).
     * Pack change / first paint: full HTML re-render.
     */
    refresh(repo: ManualIndexRepository | undefined, currentLocation?: ManualLocation): void {
        const samePack = Boolean(repo && this.repo && repo === this.repo && this.tocLive && this.view);
        this.repo = repo;
        this.currentLocation = currentLocation;
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
        };

        if (data.type === 'search' && typeof data.query === 'string') {
            const mode: ManualSearchMode = data.mode === 'fulltext' ? 'fulltext' : 'keyword';
            this.replySearch(data.query, typeof data.requestId === 'number' ? data.requestId : 0, mode);
            return;
        }

        if (data.type !== 'openLocation' || typeof data.manualId !== 'string' || typeof data.sectionId !== 'string') {
            return;
        }
        if (!this.repo) return;

        const section = this.repo.getSection(data.manualId, data.sectionId);
        if (!section) return;
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
        const results = this.repo
            ? this.repo.search(query, this.searchScope(), 100, mode).map(result => this.serializeResult(result))
            : [];
        void this.view.webview.postMessage({ type: 'searchResults', requestId, query, mode, results });
    }

    private serializeResult(result: ManualSearchResult): {
        manualId: string;
        sectionId: string;
        title: string;
        preview: string;
    } {
        return {
            manualId: result.location.manualId,
            sectionId: result.location.sectionId,
            title: result.titleEn || result.location.sectionId,
            preview: result.preview || '',
        };
    }

    private render(): void {
        if (!this.view) return;
        const painted = this.html();
        this.view.webview.html = painted.html;
        // Full HTML replacement resets webview scroll; only mark TOC live when pack tree painted.
        this.tocLive = painted.tocLive;
    }

    private html(): { html: string; tocLive: boolean } {
        if (!this.repo) {
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
            return { html: this.page(`<p class="empty">${escapeHtml(this.emptyMessage)}</p>`, false), tocLive: false };
        }
    }

    private renderDocument(document: ManualDocument): string {
        const sections = this.repo!.listSections(document.manualId);
        const groups = buildChapterGroups(sections);
        const current = this.currentLocation;
        const volumeOpen = Boolean(current && current.manualId === document.manualId);
        const activeChapterKey = volumeOpen && current
            ? findChapterKeyForSection(groups, current.sectionId)
            : null;

        const chaptersHtml = groups.map(group => this.renderChapter(document.manualId, group, activeChapterKey)).join('');
        const openAttr = volumeOpen ? ' open' : '';
        return `<details class="volume" data-manual-id="${escapeHtml(document.manualId)}"${openAttr}>
<summary class="volume__summary" title="${escapeHtml(document.title)}">${escapeHtml(document.title)}</summary>
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
        const locale = uiLocale();
        const searchPlaceholder = escapeHtml(i18n.get('manualReaderSearchPlaceholder'));
        const searchLabel = escapeHtml(i18n.get('manualReaderSearch'));
        const modeKeywordLabel = escapeHtml(i18n.get('manualSidebarSearchModeKeyword'));
        const modeFulltextLabel = escapeHtml(i18n.get('manualSidebarSearchModeFulltext'));
        const modeKeywordTitle = escapeHtml(i18n.get('manualSidebarSearchModeKeywordTitle'));
        const modeFulltextTitle = escapeHtml(i18n.get('manualSidebarSearchModeFulltextTitle'));
        const noResultsText = i18n.get('manualSidebarSearchNoResults');
        const resultSingularText = i18n.get('manualSidebarSearchResultSingular');
        const resultPluralTemplate = i18n.get('manualSidebarSearchResultPlural');
        const searchChrome = enableSearch ? `
<div class="search-bar">
  <div class="search-input-wrap">
    <input id="sidebar-search" type="search" placeholder="${searchPlaceholder}" aria-label="${searchLabel}" autocomplete="off" />
    <button type="button" id="sidebar-search-mode" class="search-mode-toggle" aria-pressed="true" data-mode="keyword" title="${modeKeywordTitle}">${modeKeywordLabel}</button>
  </div>
</div>
<div id="search-panel" class="search-panel" hidden>
  <div id="search-status" class="search-status" role="status"></div>
  <div id="search-results" class="search-results" role="listbox" aria-label="${searchLabel}"></div>
</div>` : '';
        return `<!DOCTYPE html>
<html lang="${locale === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
html, body {
  height: 100%;
  box-sizing: border-box;
}
body {
  color: var(--vscode-foreground);
  display: flex;
  flex-direction: column;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  margin: 0;
  overflow: hidden;
  padding: 8px;
}
.volume { border-bottom: 1px solid var(--vscode-panel-border); margin: 0 0 2px; }
.volume:last-child { border-bottom: 0; }
.volume__summary, .chapter__summary {
  cursor: pointer;
  list-style: none;
  overflow: hidden;
  padding: 5px 4px;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: none;
}
.volume__summary::-webkit-details-marker, .chapter__summary::-webkit-details-marker { display: none; }
.volume__summary::before, .chapter__summary::before {
  content: '▸';
  color: var(--vscode-descriptionForeground);
  display: inline-block;
  margin-right: 6px;
  width: 0.8em;
}
.volume[open] > .volume__summary::before, .chapter[open] > .chapter__summary::before { content: '▾'; }
.volume__summary { font-weight: 600; }
.volume__summary:hover, .chapter__summary:hover { background: var(--vscode-list-hoverBackground); }
.volume__body { padding: 0 0 4px; }
.chapter { margin: 0; }
.chapter__summary { color: var(--vscode-foreground); padding-left: 12px; }
.chapter__count {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  font-weight: normal;
  margin-left: 6px;
}
.chapter__count::before { content: '('; }
.chapter__count::after { content: ')'; }
.chapter__sections { display: block; padding: 0 0 4px 8px; }
.section {
  background: transparent;
  border: 0;
  border-radius: 2px;
  color: inherit;
  cursor: pointer;
  display: block;
  font: inherit;
  line-height: 1.35;
  overflow: hidden;
  padding: 3px 4px 3px 22px;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  width: 100%;
}
.section:hover { background: var(--vscode-list-hoverBackground); }
.section.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.empty { color: var(--vscode-descriptionForeground); line-height: 1.5; padding: 8px; }
.search-bar {
  background: var(--vscode-sideBar-background, transparent);
  flex: 0 0 auto;
  margin: 0 0 8px;
  padding-bottom: 4px;
}
.search-input-wrap { position: relative; width: 100%; }
.search-bar input {
  box-sizing: border-box;
  width: 100%;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  color: var(--vscode-input-foreground);
  font: inherit;
  padding: 4px 84px 4px 8px;
}
.search-mode-toggle {
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1;
  box-sizing: border-box;
  width: 76px;
  padding: 1px 4px;
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font: inherit;
  font-size: 0.85em;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}
.search-mode-toggle:hover {
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-foreground);
}
/* Weak selected: badge/list tokens — avoid primary button blue in dark themes */
.search-mode-toggle[aria-pressed="true"] {
  background: var(--vscode-badge-background, var(--vscode-list-inactiveSelectionBackground));
  color: var(--vscode-badge-foreground, var(--vscode-foreground));
  border-color: var(--vscode-list-inactiveSelectionBackground, transparent);
}
.search-panel {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  margin-bottom: 0;
  min-height: 0;
}
.search-panel[hidden] {
  display: none !important;
}
.search-status {
  color: var(--vscode-descriptionForeground);
  flex: 0 0 auto;
  font-size: .9em;
  padding: 2px 4px 6px;
}
.search-results {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow: auto;
}
.search-result { background: transparent; border: 0; border-radius: 2px; color: inherit; cursor: pointer; display: block; font: inherit; line-height: 1.3; padding: 4px 6px; text-align: left; width: 100%; }
.search-result:hover, .search-result:focus { background: var(--vscode-list-hoverBackground); outline: none; }
.search-result strong { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-result small { color: var(--vscode-descriptionForeground); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#toc {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}
#toc.hidden {
  display: none !important;
}
</style>
</head>
<body>
${searchChrome}
<div id="toc">${content}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const DEBOUNCE_MS = 250;
const noResultsText = ${JSON.stringify(noResultsText)};
const resultSingularText = ${JSON.stringify(resultSingularText)};
const resultPluralTemplate = ${JSON.stringify(resultPluralTemplate)};
const modeKeywordLabel = ${JSON.stringify(i18n.get('manualSidebarSearchModeKeyword'))};
const modeFulltextLabel = ${JSON.stringify(i18n.get('manualSidebarSearchModeFulltext'))};
const modeKeywordTitle = ${JSON.stringify(i18n.get('manualSidebarSearchModeKeywordTitle'))};
const modeFulltextTitle = ${JSON.stringify(i18n.get('manualSidebarSearchModeFulltextTitle'))};
const toc = document.getElementById('toc');
const searchInput = document.getElementById('sidebar-search');
const searchModeBtn = document.getElementById('sidebar-search-mode');
const searchPanel = document.getElementById('search-panel');
const searchStatus = document.getElementById('search-status');
const searchResults = document.getElementById('search-results');
let requestId = 0;
let timer = 0;
let searchMode = 'keyword';

function openLocation(manualId, sectionId) {
  vscode.postMessage({ type: 'openLocation', manualId, sectionId });
}

function currentSearchMode() {
  return searchMode === 'fulltext' ? 'fulltext' : 'keyword';
}

function syncSearchModeButton() {
  if (!searchModeBtn) return;
  const isKeyword = currentSearchMode() === 'keyword';
  searchModeBtn.dataset.mode = currentSearchMode();
  searchModeBtn.setAttribute('aria-pressed', isKeyword ? 'true' : 'false');
  searchModeBtn.textContent = isKeyword ? modeKeywordLabel : modeFulltextLabel;
  searchModeBtn.title = isKeyword ? modeKeywordTitle : modeFulltextTitle;
}

function scheduleSearch(immediate) {
  if (!searchInput) return;
  window.clearTimeout(timer);
  const q = searchInput.value;
  if (!q.trim()) {
    requestId += 1;
    renderResults('', []);
    return;
  }
  const run = () => {
    const id = ++requestId;
    vscode.postMessage({ type: 'search', query: q, requestId: id, mode: currentSearchMode() });
  };
  if (immediate) run();
  else timer = window.setTimeout(run, DEBOUNCE_MS);
}

document.addEventListener('click', event => {
  const section = event.target.closest('button.section[data-manual-id][data-section-id]');
  if (section) {
    openLocation(section.dataset.manualId, section.dataset.sectionId);
    return;
  }
  const hit = event.target.closest('button.search-result[data-manual-id][data-section-id]');
  if (hit) openLocation(hit.dataset.manualId, hit.dataset.sectionId);
});

function renderResults(query, results) {
  if (!searchPanel || !searchResults || !searchStatus || !toc) return;
  const q = (query || '').trim();
  if (!q) {
    searchPanel.hidden = true;
    toc.classList.remove('hidden');
    searchResults.innerHTML = '';
    searchStatus.textContent = '';
    return;
  }
  searchPanel.hidden = false;
  toc.classList.add('hidden');
  searchResults.replaceChildren();
  if (!results.length) {
    searchStatus.textContent = noResultsText;
    return;
  }
  searchStatus.textContent = results.length === 1
    ? resultSingularText
    : resultPluralTemplate.replace('{0}', String(results.length));
  for (const r of results) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-result';
    btn.setAttribute('role', 'option');
    btn.dataset.manualId = r.manualId;
    btn.dataset.sectionId = r.sectionId;
    const strong = document.createElement('strong');
    strong.textContent = r.title || r.sectionId;
    const small = document.createElement('small');
    small.textContent = r.preview || '';
    btn.append(strong, small);
    searchResults.append(btn);
  }
}

if (searchInput) {
  searchInput.addEventListener('input', () => scheduleSearch(false));
}
if (searchModeBtn) {
  syncSearchModeButton();
  searchModeBtn.addEventListener('click', () => {
    searchMode = currentSearchMode() === 'keyword' ? 'fulltext' : 'keyword';
    syncSearchModeButton();
    scheduleSearch(true);
  });
}

function isMostlyVisible(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const rect = el.getBoundingClientRect();
  const margin = 12;
  const viewTop = margin;
  const viewBottom = (window.innerHeight || 0) - margin;
  return rect.top >= viewTop && rect.bottom <= viewBottom && rect.height > 0;
}

/** Reveal only when the active row is outside the viewport — never jump a visible click target. */
function revealIfNeeded(el) {
  if (!el || typeof el.scrollIntoView !== 'function') return;
  if (isMostlyVisible(el)) return;
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Match via dataset — never build CSS attribute selectors from values.
// (Embedding regex escapes inside this TS template string previously produced
// invalid webview JS, so the whole script failed to parse and clicks died.)
function setActiveLocation(manualId, sectionId, chapterKey) {
  if (!toc) return;
  for (const btn of toc.querySelectorAll('button.section.active')) {
    btn.classList.remove('active');
  }
  if (!manualId || !sectionId) return;

  for (const volume of toc.querySelectorAll('details.volume')) {
    if (volume.dataset.manualId === manualId) volume.open = true;
  }

  if (chapterKey) {
    for (const chapter of toc.querySelectorAll('details.chapter')) {
      if (chapter.dataset.manualId === manualId && chapter.dataset.chapterKey === chapterKey) {
        chapter.open = true;
      }
    }
  }

  let active = null;
  for (const btn of toc.querySelectorAll('button.section')) {
    if (btn.dataset.manualId === manualId && btn.dataset.sectionId === sectionId) {
      active = btn;
      break;
    }
  }
  if (active) {
    active.classList.add('active');
    // After opening ancestors, layout may change; wait a frame then reveal only if needed.
    requestAnimationFrame(() => revealIfNeeded(active));
  }
}

window.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'searchResults') {
    if (data.requestId !== requestId) return;
    renderResults(data.query || '', Array.isArray(data.results) ? data.results : []);
    return;
  }
  if (data.type === 'setActiveLocation') {
    setActiveLocation(data.manualId || null, data.sectionId || null, data.chapterKey || null);
  }
});

// Initial paint only: reveal active section if the reading path left it off-screen.
const initialActive = document.querySelector('#toc button.section.active');
if (initialActive) {
  requestAnimationFrame(() => revealIfNeeded(initialActive));
}
</script>
</body>
</html>`;
    }
}
