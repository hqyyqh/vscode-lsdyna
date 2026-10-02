'use strict';

/** Extension-host controller for the React bilingual manual reader. */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Messenger } from 'vscode-messenger';
import type { WebviewIdMessageParticipant } from 'vscode-messenger-common';
import {
    ManualIndexRepository,
    ManualLanguage,
    ManualLocation,
    ManualSearchMode,
    ManualSearchResult,
    ManualSearchScope,
} from './ManualIndexRepository';
import { ManualPackManager, PersistedReaderState } from './ManualPackManager';
import {
    ReaderNavigateRequestType,
    ReaderOpenLinkRequestType,
    ReaderOpenPdfRequest,
    ReaderReadyRequest,
    ReaderScrollChangedNotification,
    ReaderSearchRequestType,
    ReaderStateChangedNotification,
    ReaderToggleLanguageRequest,
    ReaderViewModel,
} from './readerProtocol';
import { readerChromeIdentity } from './readerChrome';
const i18n = require('../core/i18n');

const WEBVIEW_DIST_DIR = path.resolve(__dirname, '..', 'webview', 'manual-reader');

interface ViteManifestEntry {
    file: string;
    css?: string[];
    isEntry?: boolean;
}

function locationKey(location: ManualLocation): string {
    return `${location.manualId}\u0000${location.sectionId}\u0000${location.anchorId || ''}`;
}

function isLocation(value: unknown): value is ManualLocation {
    const location = value as ManualLocation | undefined;
    return Boolean(location && typeof location.manualId === 'string' && typeof location.sectionId === 'string');
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Extension UI language -> reader chrome locale (not document language). */
function readerUiLocale(): 'en' | 'zh' {
    return i18n.getLanguage() === 'zh-cn' ? 'zh' : 'en';
}

/** A single reusable reader panel with host-owned navigation and persistence. */
export class ManualReaderPanel {
    private static current: ManualReaderPanel | undefined;

    private readonly panel: vscode.WebviewPanel;
    private readonly messenger = new Messenger();
    private readonly participant: WebviewIdMessageParticipant;
    private readonly history: ManualLocation[] = [];
    private historyIndex = -1;
    private revision = 0;
    private language: ManualLanguage = 'zh';
    private location: ManualLocation | undefined;
    private scrollY = 0;
    private scrollRatio = 0;
    private searchQuery = '';
    private searchScope: ManualSearchScope = 'zh';
    private searchMode: ManualSearchMode = 'keyword';
    private searchResults: ManualSearchResult[] = [];
    private scrollSaveTimer: NodeJS.Timeout | undefined;
    private persistTimer: NodeJS.Timeout | undefined;
    private sentencesWarmScheduled = false;
    /** Per-manual PDF absolute paths; avoid re-reading manifest on every PDF click. */
    private readonly pdfPathByManualId = new Map<string, string | null>();
    /** Section markdown cache: manualId\0sectionId\0language → chunk. */
    private readonly chunkCache = new Map<string, { markdown: string; chunkDirectory: string }>();
    private static readonly CHUNK_CACHE_MAX = 16;

    private constructor(
        private readonly packRoot: string,
        private readonly repository: ManualIndexRepository,
        private readonly manager: ManualPackManager,
        private readonly onLocationChanged?: (location: ManualLocation) => void,
    ) {
        this.panel = vscode.window.createWebviewPanel(
            'lsdynaManualReader',
            i18n.get('manualReaderPanelTitle'),
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: false,
                localResourceRoots: [vscode.Uri.file(packRoot), vscode.Uri.file(WEBVIEW_DIST_DIR)],
            },
        );
        this.panel.onDidDispose(() => {
            if (this.scrollSaveTimer) clearTimeout(this.scrollSaveTimer);
            if (this.persistTimer) {
                clearTimeout(this.persistTimer);
                this.persistTimer = undefined;
            }
            this.persistState();
            this.chunkCache.clear();
            if (ManualReaderPanel.current === this) ManualReaderPanel.current = undefined;
        });
        this.participant = this.messenger.registerWebviewPanel(this.panel);
        this.registerMessageHandlers();
        // The shell is immutable for this panel's lifetime. All content and UI
        // changes after this assignment are complete state notifications.
        this.panel.webview.html = this.staticHtml();
        // Warm large sentence map off the first language-toggle click path.
        this.scheduleSentencesWarm();
    }

    static show(
        packRoot: string,
        repository: ManualIndexRepository,
        manager: ManualPackManager,
        location: ManualLocation,
        restored?: PersistedReaderState,
        onLocationChanged?: (location: ManualLocation) => void,
    ): ManualReaderPanel {
        if (ManualReaderPanel.current && path.resolve(ManualReaderPanel.current.packRoot) !== path.resolve(packRoot)) {
            ManualReaderPanel.current.panel.dispose();
        }
        let preserveRestoredScroll = false;
        if (!ManualReaderPanel.current) {
            ManualReaderPanel.current = new ManualReaderPanel(packRoot, repository, manager, onLocationChanged);
            const caps = repository.getCapabilities();
            // Document language follows pack capability + user restore, NOT VS Code UI locale.
            // English-only packs stay EN; bilingual packs default to manifest defaultLanguage.
            if (!caps.canToggleLanguage) {
                ManualReaderPanel.current.language = 'en';
                ManualReaderPanel.current.searchScope = 'en';
            } else if (restored && (restored.language === 'en' || restored.language === 'zh')) {
                ManualReaderPanel.current.language = restored.language;
                ManualReaderPanel.current.searchScope = restored.language;
            } else if (caps.defaultLanguage === 'zh') {
                ManualReaderPanel.current.language = 'zh';
                ManualReaderPanel.current.searchScope = 'zh';
            } else {
                ManualReaderPanel.current.language = 'en';
                ManualReaderPanel.current.searchScope = 'en';
            }
            if (restored) {
                ManualReaderPanel.current.scrollY = restored.scrollY;
                ManualReaderPanel.current.scrollRatio = Number.isFinite(restored.scrollRatio) ? Math.min(1, Math.max(0, Number(restored.scrollRatio))) : 0;
                preserveRestoredScroll = true;
            }
        }
        const current = ManualReaderPanel.current;
        current.open(location, true, !preserveRestoredScroll);
        // Stay in the existing editor group. reveal(ViewColumn.Beside) is relative
        // to the *active* group, so every TOC click re-ran split layout and the
        // reader column width kept jumping.
        const column = current.panel.viewColumn ?? vscode.ViewColumn.Beside;
        current.panel.reveal(column);
        return current;
    }

    /** Publishes new chrome strings after the extension UI language changes. */
    static refreshUiLanguage(): void {
        ManualReaderPanel.current?.publishState();
    }

    private registerMessageHandlers(): void {
        const sender = { sender: this.participant };
        this.messenger.onRequest(ReaderReadyRequest, () => this.viewModel(), sender);
        this.messenger.onRequest(ReaderNavigateRequestType, request => {
            if (!this.accepts(request.revision)) return false;
            const target = request.target;
            if (target === 'back') return this.moveHistory(-1);
            if (target === 'forward') return this.moveHistory(1);
            if (target === 'previousSection') return this.openAdjacentSection(-1);
            if (target === 'nextSection') return this.openAdjacentSection(1);
            return isLocation(target) ? this.open(target, true) : false;
        }, sender);
        this.messenger.onRequest(ReaderToggleLanguageRequest, request => {
            if (!this.accepts(request.revision)) return false;
            // English-only packs cannot toggle; bilingual packs always can (independent of VS Code UI locale).
            if (!this.repository.getCapabilities().canToggleLanguage) return false;
            this.language = this.language === 'zh' ? 'en' : 'zh';
            this.searchScope = this.language;
            if (this.location) {
                const section = this.repository.getSection(this.location.manualId, this.location.sectionId);
                if (section) {
                    this.location = {
                        ...this.location,
                        title: this.language === 'zh' && section.titleZh ? section.titleZh : section.titleEn,
                    };
                    if (this.historyIndex >= 0) this.history[this.historyIndex] = this.location;
                }
            }
            this.publishState();
            return true;
        }, sender);
        this.messenger.onRequest(ReaderSearchRequestType, request => {
            if (!this.accepts(request.revision)) return false;
            this.searchQuery = typeof request.query === 'string' ? request.query : '';
            let scope: ManualSearchScope = request.scope === 'en' || request.scope === 'zh' || request.scope === 'both'
                ? request.scope : this.language;
            // English-only packs cannot search Chinese indexes.
            if (!this.repository.getCapabilities().features.searchZh && scope !== 'en') {
                scope = 'en';
            }
            this.searchScope = scope;
            this.searchMode = request.mode === 'fulltext' ? 'fulltext' : 'keyword';
            this.searchResults = this.repository.search(
                this.searchQuery,
                this.searchScope,
                100,
                this.searchMode,
            );
            this.publishState();
            return true;
        }, sender);
        this.messenger.onRequest(ReaderOpenLinkRequestType, request => {
            if (!this.accepts(request.revision) || typeof request.href !== 'string') return false;
            return this.openLink(request.href);
        }, sender);
        this.messenger.onRequest(ReaderOpenPdfRequest, request => {
            if (!this.accepts(request.revision)) return false;
            return this.openPdf();
        }, sender);
        this.messenger.onNotification(ReaderScrollChangedNotification, message => {
            if (!this.accepts(message.revision) || !this.location || !Number.isFinite(message.scrollY)) return;
            this.scrollY = Math.max(0, Number(message.scrollY));
            this.scrollRatio = Number.isFinite(message.scrollRatio) ? Math.min(1, Math.max(0, Number(message.scrollRatio))) : 0;
            this.location = { ...this.location, anchorId: typeof message.anchorId === 'string' && message.anchorId ? message.anchorId : null };
            if (this.historyIndex >= 0) this.history[this.historyIndex] = this.location;
            if (this.scrollSaveTimer) clearTimeout(this.scrollSaveTimer);
            this.scrollSaveTimer = setTimeout(() => this.persistState(), 350);
        }, sender);
    }

    private accepts(revision: number): boolean {
        return Number.isFinite(revision) && revision === this.revision;
    }

    private open(location: ManualLocation, pushHistory: boolean, resetScroll = true): boolean {
        const section = this.repository.getSection(location.manualId, location.sectionId);
        if (!section) return false;
        this.location = {
            ...location,
            title: location.title || (this.language === 'zh' && section.titleZh ? section.titleZh : section.titleEn),
            pdfPage: location.pdfPage ?? section.pdfPage ?? null,
        };
        if (pushHistory && (this.historyIndex < 0 || locationKey(this.history[this.historyIndex]) !== locationKey(this.location))) {
            this.history.splice(this.historyIndex + 1);
            this.history.push(this.location);
            this.historyIndex = this.history.length - 1;
        } else if (!pushHistory && this.historyIndex >= 0) {
            this.history[this.historyIndex] = this.location;
        }
        if (resetScroll) {
            this.scrollY = 0;
            this.scrollRatio = 0;
        }
        this.searchResults = [];
        this.publishState();
        this.onLocationChanged?.(this.location);
        // Warm PDF path while the user reads so toolbar PDF is a cache hit (hover-like).
        this.warmPdfPath(this.location.manualId);
        this.warmSectionChunks(this.location.manualId, this.location.sectionId);
        this.scheduleSentencesWarm();
        return true;
    }

    private moveHistory(offset: -1 | 1): boolean {
        const nextIndex = this.historyIndex + offset;
        if (nextIndex < 0 || nextIndex >= this.history.length) return false;
        this.historyIndex = nextIndex;
        this.location = this.history[this.historyIndex];
        this.scrollY = 0;
        this.scrollRatio = 0;
        this.searchResults = [];
        this.publishState();
        if (this.location) this.onLocationChanged?.(this.location);
        this.warmPdfPath(this.location.manualId);
        this.warmSectionChunks(this.location.manualId, this.location.sectionId);
        this.scheduleSentencesWarm();
        return true;
    }

    private openAdjacentSection(offset: -1 | 1): boolean {
        if (!this.location) return false;
        const sections = this.repository.listSections(this.location.manualId);
        const index = sections.findIndex(section => section.sectionId === this.location!.sectionId);
        const target = index >= 0 ? sections[index + offset] : undefined;
        if (!target) return false;
        return this.open({
            manualId: target.manualId,
            sectionId: target.sectionId,
            anchorId: target.anchors[0] || null,
            title: this.language === 'zh' && target.titleZh ? target.titleZh : target.titleEn,
            pdfPage: target.pdfPage || null,
        }, true);
    }

    private openLink(href: string): boolean {
        if (/^(?:https?|mailto):/i.test(href)) {
            void vscode.env.openExternal(vscode.Uri.parse(href));
            return true;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || !this.location) return false;
        const hash = href.indexOf('#');
        const target = hash >= 0 ? href.slice(0, hash) : href;
        const fragment = hash >= 0 ? href.slice(hash + 1) : '';
        let location: ManualLocation | null = null;
        if (target) {
            const currentPath = this.repository.sectionPath(this.location.manualId, this.location.sectionId, this.language);
            if (currentPath) {
                const relative = path.posix.normalize(path.posix.join(
                    path.posix.dirname(currentPath.replace(/\\/g, '/')),
                    target.replace(/\\/g, '/'),
                ));
                location = this.repository.resolveSectionPath(relative);
            }
        } else if (fragment) {
            location = this.repository.resolveAnchor(fragment);
        }
        if (!location) return false;
        location.anchorId = fragment || location.anchorId;
        return this.open(location, true);
    }

    private openPdf(): boolean {
        if (!this.location) return false;
        const pdfPath = this.resolvePdfPath(this.location.manualId);
        if (!pdfPath) {
            void vscode.window.showInformationMessage(i18n.get('manualReaderPdfNotFound'));
            return false;
        }
        // Pack indexes.pdfPage is authoritative for the PDF shipped in this pack
        // (merge remaps bilingual dual-text PDFs from their outline). Hover still
        // uses live bookmarks; reader open uses the document index only.
        const page = this.location.pdfPage && this.location.pdfPage > 0 ? this.location.pdfPage : 1;
        void vscode.commands.executeCommand('extension.openManual', pdfPath, page);
        return true;
    }

    /** Prefetch into the path cache without blocking navigation. */
    private warmPdfPath(manualId: string): void {
        if (!manualId || this.pdfPathByManualId.has(manualId)) return;
        try {
            this.resolvePdfPath(manualId);
        } catch {
            // ignore warm failures; openPdf will surface missing PDF
        }
    }

    private resolvePdfPath(manualId: string): string | null {
        if (this.pdfPathByManualId.has(manualId)) {
            return this.pdfPathByManualId.get(manualId) ?? null;
        }
        let resolved: string | null = null;
        try {
            resolved = this.repository.resolveDocumentPdfPath(manualId);
        } catch {
            resolved = null;
        }
        this.pdfPathByManualId.set(manualId, resolved);
        return resolved;
    }

    private chunkCacheKey(manualId: string, sectionId: string, language: ManualLanguage): string {
        return `${manualId}\u0000${sectionId}\u0000${language}`;
    }

    private readChunkFor(manualId: string, sectionId: string, language: ManualLanguage): { markdown: string; chunkDirectory: string } | null {
        const key = this.chunkCacheKey(manualId, sectionId, language);
        const cached = this.chunkCache.get(key);
        if (cached) return cached;
        const relative = this.repository.sectionPath(manualId, sectionId, language);
        if (!relative) return null;
        const absolute = path.resolve(this.packRoot, relative);
        if (!isInside(this.packRoot, absolute) || !fs.existsSync(absolute)) return null;
        const entry = { markdown: fs.readFileSync(absolute, 'utf-8'), chunkDirectory: path.dirname(absolute) };
        this.chunkCache.set(key, entry);
        // Simple FIFO trim so long sessions do not retain every visited section × language.
        while (this.chunkCache.size > ManualReaderPanel.CHUNK_CACHE_MAX) {
            const oldest = this.chunkCache.keys().next().value;
            if (oldest === undefined) break;
            this.chunkCache.delete(oldest);
        }
        return entry;
    }

    private loadChunk(): { markdown: string; chunkDirectory: string } | null {
        if (!this.location) return null;
        return this.readChunkFor(this.location.manualId, this.location.sectionId, this.language);
    }

    /** Prefetch both language variants for the current section (language-toggle cache hits). */
    private warmSectionChunks(manualId: string, sectionId: string): void {
        for (const language of ['en', 'zh'] as ManualLanguage[]) {
            try {
                this.readChunkFor(manualId, sectionId, language);
            } catch {
                // Missing opposite-language path is fine.
            }
        }
    }

    private scheduleSentencesWarm(): void {
        if (this.sentencesWarmScheduled || this.repository.isSentencesLoaded()) return;
        // English-only packs have no sentence map; skip the warm path entirely.
        if (!this.repository.getCapabilities().features.sentenceMap) {
            this.sentencesWarmScheduled = true;
            return;
        }
        this.sentencesWarmScheduled = true;
        // Defer so first paint / publish is not blocked on the large map.
        setImmediate(() => {
            try {
                this.repository.ensureSentencesLoaded();
            } catch {
                // Leave unloaded; next bilingualPairs will retry via getSectionSentences.
                this.sentencesWarmScheduled = false;
            }
        });
    }

    /**
     * Meaningful display text for Alt matching: keep short CJK labels
     * (`默认`/`可选`) and short Latin option tags, drop pure punctuation.
     */
    private static isMeaningfulPrimary(text: string): boolean {
        const value = text.trim();
        if (!value) return false;
        const cjk = (value.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) || []).length;
        const latin = (value.match(/[A-Za-z0-9]/g) || []).length;
        if (cjk >= 1) return true;
        if (latin >= 4) return true;
        // e.g. `EQ.0` / `FS` with digits/symbols — need a little substance
        if (latin >= 2 && value.length >= 3) return true;
        return false;
    }

    private bilingualPairs(): Array<{ primary: string; secondary: string; unitId?: string }> {
        if (!this.location) return [];
        // Alt translation preview needs a sentence-map-capable bilingual pack (not VS Code UI locale).
        if (!this.repository.getCapabilities().features.sentenceMap) return [];
        const pairs: Array<{ primary: string; secondary: string; unitId?: string }> = [];
        for (const sentence of this.repository.getSectionSentences(this.location.manualId, this.location.sectionId)) {
            const en = (sentence.en || '').trim();
            const zhText = (sentence.zh || '').trim();
            if (!en || !zhText || en === zhText) continue;
            // Prefer pack-supplied display keys when present (matchZh/matchEn).
            const matchZh = (sentence.matchZh || '').trim();
            const matchEn = (sentence.matchEn || '').trim();
            const primary = this.language === 'zh'
                ? (matchZh || zhText)
                : (matchEn || en);
            const secondary = this.language === 'zh' ? en : zhText;
            if (!ManualReaderPanel.isMeaningfulPrimary(primary)) continue;
            pairs.push({ primary, secondary, unitId: sentence.unitId });
        }
        return pairs.sort((left, right) => right.primary.length - left.primary.length);
    }

    private viewModel(): ReaderViewModel {
        if (!this.location) throw new Error('Manual reader has no location');
        const chunk = this.loadChunk();
        const sections = this.repository.listSections(this.location.manualId);
        const sectionIndex = sections.findIndex(section => section.sectionId === this.location!.sectionId);
        const chunkBaseUri = chunk
            ? `${this.panel.webview.asWebviewUri(vscode.Uri.file(chunk.chunkDirectory)).toString(true).replace(/\/$/, '')}/`
            : '';
        const caps = this.repository.getCapabilities();
        return {
            revision: this.revision,
            location: this.location,
            language: this.language,
            // uiLocale only drives chrome strings (toolbar labels); document language is independent.
            uiLocale: readerUiLocale(),
            canToggleLanguage: caps.canToggleLanguage,
            chrome: readerChromeIdentity(this.repository.listDocuments(), sections, this.location),
            content: chunk ? {
                kind: 'document',
                markdown: chunk.markdown,
                chunkBaseUri,
                sentencePairs: this.bilingualPairs(),
            } : { kind: 'error', message: i18n.get('manualReaderMissingChunk') },
            navigation: {
                canBack: this.historyIndex > 0,
                canForward: this.historyIndex >= 0 && this.historyIndex < this.history.length - 1,
                canPreviousSection: sectionIndex > 0,
                canNextSection: sectionIndex >= 0 && sectionIndex < sections.length - 1,
            },
            search: {
                query: this.searchQuery,
                scope: this.searchScope,
                mode: this.searchMode,
                results: this.searchResults,
            },
            restore: {
                anchorId: this.location.anchorId || null,
                scrollY: this.scrollY,
                scrollRatio: this.scrollRatio,
            },
        };
    }

    private publishState(): void {
        if (!this.location) return;
        this.revision++;
        this.panel.title = this.location.title
            ? i18n.get('manualReaderPanelSectionTitle', this.location.title)
            : i18n.get('manualReaderPanelTitle');
        this.messenger.sendNotification(ReaderStateChangedNotification, this.participant, this.viewModel());
        this.schedulePersist();
    }

    private schedulePersist(): void {
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined;
            this.persistState();
        }, 200);
    }

    private persistState(): void {
        if (!this.location) return;
        this.manager.saveState(this.packRoot, {
            manifestIdentity: this.repository.getManifestIdentity(),
            location: this.location,
            language: this.language,
            scrollY: this.scrollY,
            scrollRatio: this.scrollRatio,
        });
    }

    private staticHtml(): string {
        const manifestFile = path.join(WEBVIEW_DIST_DIR, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as Record<string, ViteManifestEntry>;
        const entry = manifest['index.html'];
        if (!entry?.file) throw new Error(`Manual reader webview entry missing from ${manifestFile}`);
        const resource = (relative: string) => this.panel.webview
            .asWebviewUri(vscode.Uri.file(path.join(WEBVIEW_DIST_DIR, relative)))
            .toString(true);
        const scriptUri = resource(entry.file);
        const styles = (entry.css || []).map(file => `<link rel="stylesheet" href="${resource(file)}">`).join('\n');
        const nonce = crypto.randomBytes(18).toString('base64');
        const source = this.panel.webview.cspSource;
        return `<!doctype html>
<html lang="${readerUiLocale()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${source} data:; font-src ${source}; style-src ${source}; script-src ${source} 'nonce-${nonce}';">
${styles}<title>${i18n.get('manualReaderPanelTitle')}</title></head><body><div id="root"></div>
<script type="module" nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
    }
}
