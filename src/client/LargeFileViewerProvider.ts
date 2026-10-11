'use strict';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { globalInputFormatFromKeywordLine, type KeywordInputFormatMode } from '../core/parser/inputFormat';
import { shortEntityKindLabel } from './entityKindLabels';
import { Messenger } from 'vscode-messenger';
import type { WebviewIdMessageParticipant } from 'vscode-messenger-common';
import {
    LargeFilePositionChanged,
    LargeFileKeywordNavigateRequestType,
    LargeFileNavigateRequestType,
    LargeFileQueryFieldRequest,
    LargeFileReadyRequest,
    LargeFileReloadRequest,
    LargeFileSearchRequestType,
    LargeFileSearchStepRequestType,
    LargeFileSelectFieldRequest,
    LargeFileStateChangedNotification,
    type LargeFileSelectedField,
    type LargeFileViewerLine,
    type LargeFileViewerState,
} from './largeFileViewerProtocol';
import {
    readLargeFileWindow,
    searchLargeFileLiteral,
    type LargeFileLineMap,
    type LargeFileSignature,
} from '../core/scanner/largeFileWindowReader';

const keywordSchema = require('../core/keywordSchema');
const cardCellModel = require('../core/edit/cardCellModel');
const { readBlockText } = require('../core/scanner/blockReader');
const { SCANNER_VERSION } = require('../core/scanner/scannerContracts');
const {
    getActionableFieldReferenceInfo,
    parseFieldReferenceValue,
} = require('../core/references/fieldReferenceClassifier');
const { getDefinitionRegistryCatalog } = require('../core/references/definitionRegistry');
const i18n = require('../core/i18n');

export const LARGE_FILE_VIEW_TYPE = 'lsdyna.largeFileViewer';
const WINDOW_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const FIELD_BLOCK_MAX_BYTES = 2 * 1024 * 1024;
const ANCHOR_STORAGE_KEY = 'lsdyna.largeFileViewer.anchors.v1';

type LargeFileViewerActions = {
    loadFileIndex: (filePath: string, cancellationToken: vscode.CancellationToken) => Promise<any>;
    queryObject: (target: { targetKind: string; id: string | number; filePath: string; line: number }) => Promise<boolean>;
};

type FieldBinding = {
    generation: number;
    field: any;
    keyword: string;
    cardIndex: number;
    rawValue: string;
    target: { targetKind: string; id: string | number; filePath: string; line: number } | null;
};

type CachedWindow = {
    value: Awaited<ReturnType<typeof readLargeFileWindow>>;
    bytes: number;
};

type ViewerSession = {
    document: LargeFileDocument;
    panel: vscode.WebviewPanel;
    participant: WebviewIdMessageParticipant;
    handlers: vscode.Disposable[];
    watcher: vscode.FileSystemWatcher;
    signature: LargeFileSignature;
    index: any | null;
    state: LargeFileViewerState;
    generation: number;
    requestGeneration: number;
    searchGeneration: number;
    searchMatches: Array<{ lineNumber: number; preview: string }>;
    fields: Map<string, FieldBinding>;
    windowCache: Map<number, CachedWindow>;
    windowCacheBytes: number;
    fieldInputFormat?: KeywordInputFormatMode | null;
    indexCancellation: vscode.CancellationTokenSource | null;
};

class LargeFileDocument implements vscode.CustomDocument {
    constructor(readonly uri: vscode.Uri) {}
    dispose(): void {}
}

function keyForUri(uri: vscode.Uri): string {
    const value = path.resolve(uri.fsPath);
    return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}

function signatureFromStat(stat: fs.Stats): LargeFileSignature {
    return { size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameSignature(left: LargeFileSignature, right: LargeFileSignature): boolean {
    return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function normalizeIdentity(value: unknown): string | number | null {
    const raw = String(value ?? '').trim();
    if (/^\+?[1-9]\d*$/.test(raw)) {
        const number = Number(raw);
        return Number.isSafeInteger(number) ? number : raw.replace(/^\+/, '');
    }
    return /^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(raw) ? raw : null;
}

function labels(): Record<string, string> {
    return {
        navigationTarget: i18n.get('largeFileNavigationTarget'),
        goto: i18n.get('largeFileGoto'),
        line: i18n.get('largeFileLine'),
        keyword: i18n.get('largeFileKeyword'),
        previous: i18n.get('largeFilePrevious'),
        next: i18n.get('largeFileNext'),
        textMode: i18n.get('largeFileTextMode'),
        keywordMode: i18n.get('largeFileKeywordMode'),
        keywordMatches: i18n.get('largeFileKeywordMatches'),
        noMatches: i18n.get('largeFileSearchNoResults'),
        search: i18n.get('largeFileSearch'),
        matchLines: i18n.get('largeFileMatchLines'),
        searching: i18n.get('largeFileSearching'),
        clearSearch: i18n.get('largeFileClearSearch'),
        gotoHint: i18n.get('largeFileGotoHint'),
        keywordHint: i18n.get('largeFileKeywordHint'),
        searchHint: i18n.get('largeFileSearchHint'),
        searchText: i18n.get('largeFileSearchText'),
        reload: i18n.get('largeFileReload'),
        indexing: i18n.get('largeFileIndexing'),
        indexFailed: i18n.get('largeFileIndexFailed'),
        stale: i18n.get('largeFileStale'),
        truncatedLine: i18n.get('largeFileTruncatedLine'),
        fieldHelp: i18n.get('largeFileFieldHelp'),
        english: i18n.get('fieldHelpEnglishOriginal'),
        queryObject: i18n.get('largeFileQueryObject'),
        noField: i18n.get('largeFileNoField'),
        searchTruncated: i18n.get('largeFileSearchTruncated'),
        searchNoResults: i18n.get('largeFileSearchNoResults'),
        searchFailed: i18n.get('largeFileSearchFailed'),
        failed: i18n.get('largeFileActionFailed'),
        retry: i18n.get('entityReferencesRetry'),
        card: i18n.get('keywordHoverCard'),
        defaultValue: i18n.get('largeFileDefaultValue'),
        readOnly: i18n.get('largeFileReadOnly'),
        readOnlyShort: i18n.get('largeFileReadOnlyShort'),
        previousKeyword: i18n.get('largeFilePreviousKeyword'),
        nextKeyword: i18n.get('largeFileNextKeyword'),
        previousMatch: i18n.get('largeFilePreviousMatch'),
        nextMatch: i18n.get('largeFileNextMatch'),
        closeSearch: i18n.get('largeFileCloseSearch'),
        details: i18n.get('largeFileFieldDetails'),
        objectName: i18n.get('largeFileObjectName'),
    };
}

export class LargeFileViewerProvider implements
vscode.CustomReadonlyEditorProvider<LargeFileDocument>, vscode.Disposable {
    private readonly messenger = new Messenger();
    private readonly sessions = new Map<string, ViewerSession>();
    private readonly pendingTargets = new Map<string, NonNullable<LargeFileViewerState['navigationTarget']>>();
    private readonly pendingLines = new Map<string, number>();

    constructor(
        private readonly extensionRoot: string,
        private readonly workspaceState: vscode.Memento,
        private readonly actions: LargeFileViewerActions,
    ) {}

    async openCustomDocument(uri: vscode.Uri): Promise<LargeFileDocument> {
        return new LargeFileDocument(uri);
    }

    async resolveCustomEditor(
        document: LargeFileDocument,
        panel: vscode.WebviewPanel,
    ): Promise<void> {
        const stat = await fs.promises.stat(document.uri.fsPath);
        const dist = path.join(this.extensionRoot, 'out', 'webview', 'large-file-viewer');
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(dist)],
        };
        const participant = this.messenger.registerWebviewPanel(panel);
        const initialLine = this.consumeInitialLine(document.uri);
        const state: LargeFileViewerState = {
            revision: 0,
            locale: i18n.getLanguage() === 'zh-cn' ? 'zh' : 'en',
            fileName: path.basename(document.uri.fsPath),
            fileSize: stat.size,
            anchorLine: initialLine,
            navigationTarget: this.pendingTargets.get(keyForUri(document.uri)),
            lines: [],
            currentKeyword: '',
            indexing: 'loading',
            indexingMessage: i18n.get('largeFileIndexing'),
            stale: false,
            selectedField: null,
            keywordSearch: undefined,
            search: { query: '', loading: false, count: 0, currentIndex: -1, truncated: false, message: '' },
            labels: labels(),
        };
        this.pendingTargets.delete(keyForUri(document.uri));
        const relative = new vscode.RelativePattern(
            vscode.Uri.file(path.dirname(document.uri.fsPath)),
            path.basename(document.uri.fsPath),
        );
        const watcher = vscode.workspace.createFileSystemWatcher(relative);
        const session: ViewerSession = {
            document,
            panel,
            participant,
            handlers: [],
            watcher,
            signature: signatureFromStat(stat),
            index: null,
            state,
            generation: 1,
            requestGeneration: 0,
            searchGeneration: 0,
            searchMatches: [],
            fields: new Map(),
            windowCache: new Map(),
            windowCacheBytes: 0,
            indexCancellation: null,
        };
        this.sessions.set(keyForUri(document.uri), session);
        session.handlers = this.registerHandlers(session);
        const stale = () => this.markStale(session);
        watcher.onDidChange(stale, undefined, session.handlers);
        watcher.onDidDelete(stale, undefined, session.handlers);
        panel.onDidDispose(() => this.disposeSession(session));
        panel.webview.html = this.html(panel.webview, dist);
        void this.initialize(session, initialLine);
    }

    async openAt(uri: vscode.Uri, line = 0, column: vscode.ViewColumn = vscode.ViewColumn.Active, startColumn = 0, endColumn = startColumn): Promise<boolean> {
        const key = keyForUri(uri);
        const coordinate = (value: number) => Number.isSafeInteger(value) ? Math.max(0, value) : 0;
        const target = { requestId: crypto.randomUUID(), line: coordinate(line), startColumn: coordinate(startColumn),
            endColumn: Math.max(coordinate(startColumn), coordinate(endColumn)) };
        const anchor = Math.max(0, target.line - 4);
        const existing = this.sessions.get(key);
        if (existing) {
            existing.panel.reveal(column, false);
            existing.state = { ...existing.state, navigationTarget: target };
            return this.navigate(existing, anchor);
        }
        this.pendingTargets.set(key, target);
        this.pendingLines.set(key, anchor);
        try {
            await vscode.commands.executeCommand('vscode.openWith', uri, LARGE_FILE_VIEW_TYPE, column);
        } catch (error) {
            this.pendingLines.delete(key);
            this.pendingTargets.delete(key);
            throw error;
        }
        return true;
    }

    dispose(): void {
        for (const session of [...this.sessions.values()]) this.disposeSession(session);
    }

    refreshUiLanguage(): void {
        const currentLabels = labels();
        for (const session of this.sessions.values()) {
            const messageKey = ['searchNoResults', 'searchTruncated', 'searchFailed']
                .find(key => session.state.search.message && session.state.search.message === session.state.labels[key]);
            session.state = {
                ...session.state,
                indexingMessage: session.state.indexing === 'loading' ? i18n.get('largeFileIndexing')
                    : session.state.indexing === 'error' ? i18n.get('largeFileIndexFailed') : '',
                search: { ...session.state.search, message: messageKey ? currentLabels[messageKey] : session.state.search.message },
            };
            this.publish(session);
        }
    }

    selectedQueryTarget(uri: vscode.Uri): FieldBinding['target'] {
        const session = this.sessions.get(keyForUri(uri));
        const token = session?.state.selectedField?.token;
        const binding = token ? session?.fields.get(token) : null;
        return binding && binding.generation === session?.generation && !session?.state.stale
            ? binding.target
            : null;
    }

    private consumeInitialLine(uri: vscode.Uri): number {
        const key = keyForUri(uri);
        const pending = this.pendingLines.get(key);
        this.pendingLines.delete(key);
        if (Number.isSafeInteger(pending)) return Number(pending);
        const anchors = this.workspaceState.get<Record<string, number>>(ANCHOR_STORAGE_KEY, {});
        return Math.max(0, Math.floor(Number(anchors[key]) || 0));
    }

    private rememberAnchor(session: ViewerSession): void {
        const key = keyForUri(session.document.uri);
        const anchors = { ...this.workspaceState.get<Record<string, number>>(ANCHOR_STORAGE_KEY, {}) };
        delete anchors[key];
        anchors[key] = session.state.anchorLine;
        const entries = Object.entries(anchors).slice(-100);
        void this.workspaceState.update(ANCHOR_STORAGE_KEY, Object.fromEntries(entries));
    }

    private async initialize(session: ViewerSession, initialLine: number): Promise<void> {
        const generation = session.generation;
        session.indexCancellation?.cancel();
        session.indexCancellation?.dispose();
        const indexCancellation = new vscode.CancellationTokenSource();
        session.indexCancellation = indexCancellation;
        try {
            await this.loadWindow(session, session.index ? initialLine : 0);
            if (!this.isLive(session, generation)) return;
            const index = await this.actions.loadFileIndex(
                session.document.uri.fsPath,
                indexCancellation.token,
            );
            if (!this.isLive(session, generation)) return;
            if (!index?.largeFileLineMap || index.scannerVersion !== SCANNER_VERSION ||
                index.size !== session.signature.size || index.mtimeMs !== session.signature.mtimeMs) {
                throw new Error('large-file-line-map-unavailable');
            }
            session.index = index;
            session.state = {
                ...session.state,
                indexing: 'ready',
                indexingMessage: '',
                lineCount: index.largeFileLineMap.lineCount,
            };
            await this.loadWindow(session, initialLine);
        } catch (error) {
            if (!this.isLive(session, generation)) return;
            console.error('[lsdyna] Large-file indexing failed:', error);
            session.state = {
                ...session.state,
                indexing: 'error',
                indexingMessage: i18n.get('largeFileIndexFailed'),
            };
            this.publish(session);
        } finally {
            if (session.indexCancellation === indexCancellation) {
                session.indexCancellation = null;
                indexCancellation.dispose();
            }
        }
    }

    private registerHandlers(session: ViewerSession): vscode.Disposable[] {
        const sender = { sender: session.participant };
        return [
            this.messenger.onNotification(LargeFilePositionChanged, request => {
                if (this.accepts(session, request.revision) && Number.isSafeInteger(request.line) &&
                    session.state.lines.some(line => line.lineNumber === request.line)) {
                    session.state = { ...session.state, anchorLine: request.line };
                }
            }, sender),
            this.messenger.onRequest(LargeFileReadyRequest, () => session.state, sender),
            this.messenger.onRequest(LargeFileNavigateRequestType, request =>
                this.accepts(session, request.revision) && this.navigate(session, request.line), sender),
            this.messenger.onRequest(LargeFileKeywordNavigateRequestType, request =>
                this.accepts(session, request.revision) &&
                this.navigateKeyword(session, request.direction, request.filter), sender),
            this.messenger.onRequest(LargeFileSearchRequestType, request =>
                this.accepts(session, request.revision) && this.search(session, request.query), sender),
            this.messenger.onRequest(LargeFileSearchStepRequestType, request =>
                this.accepts(session, request.revision) && this.searchStep(session, request.direction), sender),
            this.messenger.onRequest(LargeFileSelectFieldRequest, request =>
                this.accepts(session, request.revision) && this.selectField(session, request.token), sender),
            this.messenger.onRequest(LargeFileQueryFieldRequest, request =>
                this.queryField(session, request.token), sender),
            this.messenger.onRequest(LargeFileReloadRequest, request =>
                this.acceptsRevision(session, request.revision) && this.reload(session), sender),
        ];
    }

    private acceptsRevision(session: ViewerSession, revision: number): boolean {
        return this.isLive(session, session.generation) && Number.isFinite(revision) && revision === session.state.revision;
    }

    private accepts(session: ViewerSession, revision: number): boolean {
        return this.acceptsRevision(session, revision) && !session.state.stale;
    }

    private isLive(session: ViewerSession, generation: number): boolean {
        return this.sessions.get(keyForUri(session.document.uri)) === session && session.generation === generation;
    }

    private publish(session: ViewerSession): void {
        const object = session.state.selectedField?.object;
        if (object) session.state = { ...session.state, selectedField: {
            ...session.state.selectedField!, object: { ...object, kindLabel: shortEntityKindLabel(object.kind) },
        } };
        session.state = { ...session.state, revision: session.state.revision + 1,
            locale: i18n.getLanguage() === 'zh-cn' ? 'zh' : 'en', labels: labels() };
        this.messenger.sendNotification(LargeFileStateChangedNotification, session.participant, session.state);
    }

    private markStale(session: ViewerSession): void {
        if (session.state.stale) return;
        session.generation++;
        session.searchGeneration++;
        session.indexCancellation?.cancel();
        session.state = { ...session.state, stale: true, search: { ...session.state.search, loading: false } };
        this.publish(session);
    }

    private async reload(session: ViewerSession): Promise<boolean> {
        const generation = session.generation;
        const stat = await fs.promises.stat(session.document.uri.fsPath);
        if (!this.isLive(session, generation)) return false;
        session.generation++;
        session.searchGeneration++;
        session.indexCancellation?.cancel();
        session.signature = signatureFromStat(stat);
        session.index = null;
        session.fields.clear();
        session.windowCache.clear();
        session.fieldInputFormat = undefined;
        session.windowCacheBytes = 0;
        session.searchMatches = [];
        session.state = {
            ...session.state,
            fileSize: stat.size,
            stale: false,
            indexing: 'loading',
            indexingMessage: i18n.get('largeFileIndexing'),
            navigationTarget: undefined,
            lineCount: undefined,
            selectedField: null,
            keywordSearch: undefined,
            search: { query: '', loading: false, count: 0, currentIndex: -1, truncated: false, message: '' },
        };
        this.publish(session);
        void this.initialize(session, 0);
        return true;
    }

    private async navigate(session: ViewerSession, line: number): Promise<boolean> {
        if (session.state.stale) return false;
        if (!session.index && line > 0) return false;
        await this.loadWindow(session, line);
        return true;
    }

    private async loadWindow(session: ViewerSession, line: number): Promise<void> {
        const request = ++session.requestGeneration;
        const generation = session.generation;
        const isCurrent = () => this.isLive(session, generation) && request === session.requestGeneration && !session.state.stale;
        const map = session.index?.largeFileLineMap as LargeFileLineMap | undefined;
        const knownCount = map?.lineCount;
        const anchor = knownCount === undefined ? 0 : Math.min(
            Math.max(0, Math.floor(Number(line) || 0)),
            Math.max(0, knownCount - 1),
        );
        let raw: CachedWindow['value'];
        const windowStart = Math.max(0, anchor - 60);
        const cached = session.windowCache.get(windowStart);
        if (cached) {
            const stat = signatureFromStat(await fs.promises.stat(session.document.uri.fsPath));
            if (!isCurrent()) return;
            if (!sameSignature(stat, session.signature)) {
                this.markStale(session);
                return;
            }
            session.windowCache.delete(windowStart);
            session.windowCache.set(windowStart, cached);
            raw = cached.value;
        } else {
            raw = await readLargeFileWindow(
                session.document.uri.fsPath,
                map || null,
                windowStart,
                { expectedSignature: session.signature, maxLines: 300 },
            );
            if (!isCurrent()) return;
            if (raw.stale) {
                this.markStale(session);
                return;
            }
            this.cacheWindow(session, windowStart, raw);
        }
        if (!isCurrent()) return;
        // A byte-bounded window can end before the requested line when context lines are very long.
        if (!raw.lines.some(row => row.lineNumber === anchor)) {
            raw = await readLargeFileWindow(session.document.uri.fsPath, map || null, anchor,
                { expectedSignature: session.signature, maxLines: 300 });
            if (!isCurrent()) return;
            if (raw.stale) { this.markStale(session); return; }
        }
        const lines = await this.annotateLines(session, raw.lines, request);
        if (!isCurrent()) return;
        const after = signatureFromStat(await fs.promises.stat(session.document.uri.fsPath));
        if (!isCurrent()) return;
        if (!sameSignature(after, session.signature)) {
            this.markStale(session);
            return;
        }
        session.state = {
            ...session.state,
            anchorLine: anchor,
            lineCount: raw.lineCount ?? session.state.lineCount,
            lines,
            currentKeyword: this.keywordAt(session.index?.keywordBlocks || [], raw.anchorLine),
            selectedField: null,
        };
        this.rememberAnchor(session);
        this.publish(session);
    }

    private cacheWindow(session: ViewerSession, anchor: number, value: CachedWindow['value']): void {
        const bytes = value.lines.reduce((total, line) => total + Buffer.byteLength(line.text, 'utf8') + 32, 0);
        if (bytes > WINDOW_CACHE_MAX_BYTES) return;
        session.windowCacheBytes -= session.windowCache.get(anchor)?.bytes || 0;
        session.windowCache.set(anchor, { value, bytes });
        session.windowCacheBytes += bytes;
        while (session.windowCacheBytes > WINDOW_CACHE_MAX_BYTES) {
            const oldest = session.windowCache.entries().next().value as [number, CachedWindow];
            session.windowCache.delete(oldest[0]);
            session.windowCacheBytes -= oldest[1].bytes;
        }
    }

    private keywordAt(blocks: any[], line: number): string {
        let low = 0;
        let high = blocks.length - 1;
        let found = '';
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (blocks[middle].startLine <= line) {
                found = blocks[middle].keyword || '';
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        return found;
    }

    private async annotateLines(session: ViewerSession, rawLines: Array<{ lineNumber: number; text: string; truncated: boolean }>, request: number): Promise<LargeFileViewerLine[]> {
        const fields = new Map<string, FieldBinding>();
        const generation = session.generation;
        const isCurrent = () => this.isLive(session, generation) && request === session.requestGeneration && !session.state.stale;
        const lines: LargeFileViewerLine[] = rawLines.map(line => ({
            ...line,
            keyword: line.text.trimStart().startsWith('*'),
            fields: [],
        }));
        if (!session.index || lines.length === 0) { if (isCurrent()) session.fields = fields; return lines; }
        const byNumber = new Map(lines.map(line => [line.lineNumber, line]));
        const first = lines[0].lineNumber;
        const last = lines[lines.length - 1].lineNumber;
        const blocks = session.index.keywordBlocks || [];
        if (session.fieldInputFormat === undefined) {
            let mode: KeywordInputFormatMode | null = 'standard';
            if (/^\*?KEYWORD$/i.test(blocks[0]?.keyword || '')) {
                const header = String(await readBlockText(blocks[0], 'utf8', { maxBytes: 64 * 1024 }));
                if (!isCurrent()) return lines;
                const firstLine = header.split(/\r?\n/, 1)[0];
                mode = Buffer.byteLength(firstLine, 'utf8') >= 64 * 1024
                    ? null : globalInputFormatFromKeywordLine(firstLine);
            }
            session.fieldInputFormat = mode;
        }
        if (session.fieldInputFormat === null) { if (isCurrent()) session.fields = fields; return lines; }
        let low = 0, high = blocks.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (blocks[middle].endLine < first) low = middle + 1; else high = middle;
        }
        for (let blockIndex = low; blockIndex < blocks.length; blockIndex++) {
            const block = blocks[blockIndex];
            if (block.endLine < first) continue;
            if (block.startLine > last) break;
            if (block.flags?.isNodeBlock || block.flags?.isElementBlock ||
                block.endOffset - block.startOffset > FIELD_BLOCK_MAX_BYTES) continue;
            let truncated = false;
            const text = await readBlockText(block, 'utf8', {
                maxBytes: FIELD_BLOCK_MAX_BYTES,
                onTruncated: () => { truncated = true; },
            });
            if (!isCurrent()) return lines;
            if (truncated) continue;
            const blockLines = String(text).split(/\r?\n/);
            const fakeDocument = {
                lineCount: blockLines.length,
                lineAt: (line: number) => ({ text: blockLines[line] || '' }),
            };
            let dataOrdinal = 0;
            const ordinals: number[] = [];
            const observedDataLines: string[] = [];
            for (let index = 0; index < blockLines.length; index++) {
                const value = blockLines[index];
                const trimmed = value;
                if (index > 0 && !trimmed.startsWith('$') && !trimmed.startsWith('*')) {
                    dataOrdinal++;
                    if (observedDataLines.length < 32) observedDataLines.push(value);
                }
                ordinals[index] = dataOrdinal;
            }
            for (let globalLine = Math.max(first, block.startLine + 1);
                globalLine <= Math.min(last, block.endLine); globalLine++) {
                const target = byNumber.get(globalLine);
                if (!target || target.truncated) continue;
                const localLine = globalLine - block.startLine;
                const lineText = blockLines[localLine] || '';
                if (!lineText || lineText.includes(',') || lineText.startsWith('$')) continue;
                let cardInfo;
                try {
                    cardInfo = keywordSchema.getCardInfoForDocumentLine(
                        fakeDocument,
                        localLine,
                        keywordSchema.loadKeywordSchema(() => i18n.getLanguage()),
                        {
                            keywordLine: 0,
                            dataLineOrdinal: ordinals[localLine],


                            observedDataLines,
                            globalInputFormat: session.fieldInputFormat,
                        },
                    );
                } catch {
                    cardInfo = null;
                }
                if (!cardInfo || cardInfo.isTextCard ||
                    !cardCellModel.isSafeCardGeometry(cardInfo.card)) continue;
                target.fields = cardInfo.card.flatMap((field: any, fieldIndex: number) => {
                    if (!Number.isInteger(field?.p) || !Number.isInteger(field?.w) ||
                        field.w <= 0 || field.p >= lineText.length) return [];
                    const rawValue = lineText.slice(field.p, field.p + field.w);
                    const queryTarget = this.fieldQueryTarget(
                        session,
                        cardInfo,
                        field,
                        fieldIndex,
                        rawValue,
                        globalLine,
                    );
                    const token = crypto.randomUUID();
                    fields.set(token, {
                        generation: session.generation,
                        field,
                        keyword: cardInfo.keywordName,
                        cardIndex: cardInfo.cardIndex,
                        rawValue,
                        target: queryTarget,
                    });
                    return [{
                        token,
                        startColumn: field.p,
                        endColumn: Math.min(lineText.length, field.p + field.w),
                        label: String(field.n || ''),
                        queryable: !!queryTarget,
                    }];
                });
            }
        }
        if (isCurrent()) session.fields = fields;
        return lines;
    }

    private fieldQueryTarget(
        session: ViewerSession,
        cardInfo: any,
        field: any,
        fieldIndex: number,
        rawValue: string,
        line: number,
    ): FieldBinding['target'] {
        try {
            const info = getActionableFieldReferenceInfo({
                keyword: cardInfo.keywordName,
                cardIndex: cardInfo.cardIndex,
                field,
            });
            const value = info ? parseFieldReferenceValue(rawValue, info) : null;
            const targetKind = value?.targetKinds?.[0] || info?.targetKinds?.[0];
            if (targetKind && value?.id !== undefined) {
                return { targetKind, id: value.id, filePath: session.document.uri.fsPath, line };
            }
        } catch {
            // Definition lookup below remains available when reference semantics are absent.
        }
        const keyword = String(cardInfo.keywordName || '').replace(/^\*/, '').toUpperCase();
        const descriptor = getDefinitionRegistryCatalog().definitionDescriptorForKeyword(keyword);
        const expectedField = descriptor?.physicalSelector?.fieldIndex ?? descriptor?.fieldIndex;
        const expectedRecord = (descriptor?.titleCardCount || 0) +
            (descriptor?.physicalSelector?.dataRecordOrdinal ?? descriptor?.dataRecordOrdinal ?? 0) + 1;
        const identity = normalizeIdentity(rawValue);
        return descriptor?.targetKind && expectedField === fieldIndex &&
            expectedRecord === cardInfo.cardIndex && identity !== null
            ? { targetKind: descriptor.targetKind, id: identity, filePath: session.document.uri.fsPath, line }
            : null;
    }

    private objectName(session: ViewerSession, target: NonNullable<FieldBinding['target']>): string | undefined {
        // ponytail: verified summaries in this file only; use the existing object query for project scope or ambiguous IDs.
        const matches = (session.index?.keywordBlocks || []).filter((block: any) => {
            const display = block.displayIdentity;
            if (display?.confidence !== 'verified' || !display.identity) return false;
            const descriptor = getDefinitionRegistryCatalog().definitionDescriptorForKeyword(display.canonicalKeyword || block.keyword);
            return descriptor?.targetKind === target.targetKind && descriptor.recordMode !== 'repeat-all-data-records' &&
                display.identity.field === descriptor.fieldName && normalizeIdentity(display.identity.value) === target.id;
        });
        return matches.length === 1 ? matches[0].displayIdentity.title || undefined : undefined;
    }

    private selectField(session: ViewerSession, token: string): boolean {
        const binding = session.fields.get(token);
        if (!binding || binding.generation !== session.generation) return false;
        const field = binding.field;
        const choices = Array.isArray(field.e)
            ? field.e.slice(0, 20).map(value => typeof value === 'string' ? value : JSON.stringify(value))
            : [];
        const selected: LargeFileSelectedField = {
            token,
            label: String(field.n || ''),
            value: binding.rawValue.trim(),
            keyword: `*${String(binding.keyword || '').replace(/^\*/, '')}`,
            cardIndex: binding.cardIndex,
            localizedHelp: keywordSchema.getLocalizedFieldHelp(field) || '',
            englishHelp: keywordSchema.getEnglishFieldHelp(field) || '',
            type: String(field.t || ''),
            defaultValue: field.d === undefined ? '' : String(field.d),
            choices,
            queryable: !!binding.target,
            ...(binding.target ? { object: { kind: binding.target.targetKind,
                kindLabel: shortEntityKindLabel(binding.target.targetKind), id: String(binding.target.id),
                name: this.objectName(session, binding.target) } } : {}),
        };
        session.state = { ...session.state, selectedField: selected };
        this.publish(session);
        return true;
    }

    private async queryField(session: ViewerSession, token: string): Promise<boolean> {
        const binding = session.fields.get(token);
        if (!this.isLive(session, session.generation) || !binding || binding.generation !== session.generation || !binding.target || session.state.stale) {
            return false;
        }
        return this.actions.queryObject(binding.target);
    }

    private async navigateKeyword(session: ViewerSession, direction: -1 | 1, filter: string): Promise<boolean> {
        const query = String(filter || '').trim();
        const normalized = query.replace(/^\*/, '').toUpperCase();
        const matches = (session.index?.keywordBlocks || []).filter((block: any) =>
            !normalized || String(block.keyword || '').replace(/^\*/, '').toUpperCase().includes(normalized));
        const anchor = session.state.anchorLine;
        let currentIndex = direction > 0
            ? matches.findIndex((block: any) => block.startLine > anchor)
            : matches.findLastIndex((block: any) => block.startLine < anchor);
        if (currentIndex < 0 && matches.length) currentIndex = direction > 0 ? 0 : matches.length - 1;
        session.state = { ...session.state, keywordSearch: { query, count: matches.length, currentIndex } };
        if (!matches.length) {
            session.state = { ...session.state, navigationTarget: undefined };
            this.publish(session);
            return true;
        }
        const candidate = matches[currentIndex];
        session.state = { ...session.state, navigationTarget: { requestId: crypto.randomUUID(),
            line: candidate.startLine, startColumn: 0, endColumn: String(candidate.keyword).replace(/^\*/, '').length + 1 } };
        await this.loadWindow(session, candidate.startLine);
        return true;
    }

    private async search(session: ViewerSession, query: string): Promise<boolean> {
        const normalized = String(query || '').trim();
        const generation = ++session.searchGeneration;
        const sessionGeneration = session.generation;
        const isCurrent = () => this.isLive(session, sessionGeneration) &&
            generation === session.searchGeneration && !session.state.stale;
        session.searchMatches = [];
        session.state = {
            ...session.state,
            keywordSearch: undefined,
            ...(normalized ? { navigationTarget: undefined } : {}),
            search: { query: normalized, loading: !!normalized, count: 0, currentIndex: -1, truncated: false, message: '' },
        };
        this.publish(session);
        if (!normalized) return true;
        let result: Awaited<ReturnType<typeof searchLargeFileLiteral>>;
        try {
            result = await searchLargeFileLiteral(session.document.uri.fsPath, normalized, {
                expectedSignature: session.signature,
                isCurrent,
            });
        } catch (error) {
            if (!isCurrent()) return false;
            console.error('[lsdyna] Large-file search failed:', error);
            session.state = { ...session.state, search: { ...session.state.search,
                loading: false, message: i18n.get('largeFileSearchFailed') } };
            this.publish(session);
            return false;
        }
        if (!isCurrent()) return false;
        if (result.stale) {
            this.markStale(session);
            return false;
        }
        session.searchMatches = result.matches;
        session.state = {
            ...session.state,
            search: {
                query: normalized,
                loading: false,
                count: result.matches.length,
                currentIndex: result.matches.length > 0 ? 0 : -1,
                currentLine: result.matches[0]?.lineNumber,
                truncated: result.truncated,
                message: result.matches.length === 0 ? i18n.get('largeFileSearchNoResults')
                    : result.truncated ? i18n.get('largeFileSearchTruncated') : '',
            },
        };
        if (result.matches.length > 0) {
            await this.loadWindow(session, result.matches[0].lineNumber);
        } else {
            this.publish(session);
        }
        return true;
    }

    private async searchStep(session: ViewerSession, direction: -1 | 1): Promise<boolean> {
        if (session.searchMatches.length === 0) return false;
        const current = session.state.search.currentIndex;
        const next = (current + direction + session.searchMatches.length) % session.searchMatches.length;
        session.state = { ...session.state, search: { ...session.state.search, currentIndex: next, currentLine: session.searchMatches[next].lineNumber } };
        await this.loadWindow(session, session.searchMatches[next].lineNumber);
        return true;
    }

    private disposeSession(session: ViewerSession): void {
        const key = keyForUri(session.document.uri);
        if (this.sessions.get(key) !== session) return;
        this.rememberAnchor(session);
        session.generation++;
        session.searchGeneration++;
        session.indexCancellation?.cancel();
        session.indexCancellation?.dispose();
        session.indexCancellation = null;
        for (const handler of session.handlers.splice(0)) handler.dispose();
        session.watcher.dispose();
        this.sessions.delete(key);
    }

    private html(webview: vscode.Webview, dist: string): string {
        const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
        const entry = manifest['index.html'];
        if (!entry?.file) throw new Error(`Large-file viewer entry missing from ${dist}`);
        const resource = (file: string) => webview.asWebviewUri(vscode.Uri.file(path.join(dist, file)));
        const css = (entry.css || []).map((file: string) =>
            `<link rel="stylesheet" href="${resource(file)}">`).join('');
        const nonce = crypto.randomBytes(18).toString('base64');
        const csp = `default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'`;
        return `<!doctype html><html lang="${i18n.getLanguage() === 'zh-cn' ? 'zh-CN' : 'en'}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body><div id="root"></div><script nonce="${nonce}" type="module" src="${resource(entry.file)}"></script></body></html>`;
    }
}
