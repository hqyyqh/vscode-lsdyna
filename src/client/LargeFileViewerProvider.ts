'use strict';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { LargeFileEditDocument } from '../core/edit/largeFileEditDocument';
import * as vscode from 'vscode';
import { globalInputFormatFromKeywordLine, type KeywordInputFormatMode } from '../core/parser/inputFormat';
import { shortEntityKindLabel } from './entityKindLabels';
import { Messenger } from 'vscode-messenger';
import type { WebviewIdMessageParticipant } from 'vscode-messenger-common';
import {
    LargeFileOpenNative,
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
    loadFileIndex: (filePath: string, cancellationToken: vscode.CancellationToken, onProgress?: (index: any) => Promise<void>) => Promise<any>;
    readFileIndex?: (index: any, request: any) => Promise<any>;
    releaseFileIndex?: (index: any) => void;
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
    readCursors?: Map<number, number>;
    navigationEpoch?: number;
    pendingLine?: number;
    windowLoading?: boolean;
    helpThroughLine?: number;
    fieldInputFormat?: KeywordInputFormatMode | null;
    indexCancellation: vscode.CancellationTokenSource | null;
};

class LargeFileDocument implements vscode.CustomDocument {
    readonly edits: LargeFileEditDocument;
    constructor(readonly uri: vscode.Uri, storage: string) { this.edits = new LargeFileEditDocument(uri.fsPath, storage); }
    dispose(): void { void this.edits.dispose().catch(console.error); }
}

function keyForUri(uri: vscode.Uri): string {
    const value = path.resolve(uri.fsPath);
    return process.platform === 'win32' ? value.toLocaleLowerCase() : value;
}

function hasDirtyText(uri: vscode.Uri): boolean {
    return vscode.workspace.textDocuments.some(doc => doc.isDirty && keyForUri(doc.uri) === keyForUri(uri)) ||
        !!vscode.window.tabGroups?.all?.some(group => group.tabs.some(tab => tab.isDirty &&
            typeof vscode.TabInputText === 'function' && tab.input instanceof vscode.TabInputText &&
            keyForUri(tab.input.uri) === keyForUri(uri)));
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
        indexingHint: i18n.get('largeFileIndexingHint'),
        indexingFinishing: i18n.get('largeFileIndexingFinishing'),
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
        openNative: i18n.get('largeFileOpenNative'),
        recovery: i18n.get('largeFileRecovery'),
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
vscode.CustomEditorProvider<LargeFileDocument>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<LargeFileDocument>>();
    readonly onDidChangeCustomDocument = this.changed.event;
    private readonly messenger = new Messenger();
    private readonly sessions = new Map<string, ViewerSession>();
    private readonly pendingTargets = new Map<string, NonNullable<LargeFileViewerState['navigationTarget']>>();
    private readonly pendingLines = new Map<string, number>();

    constructor(
        private readonly extensionRoot: string,
        private readonly workspaceState: vscode.Memento,
        private readonly actions: LargeFileViewerActions,
        private readonly editStorage = path.join(os.tmpdir(), 'dynasense-record-edits'),
    ) {}

    async openCustomDocument(uri: vscode.Uri, context?: vscode.CustomDocumentOpenContext): Promise<LargeFileDocument> {
        const document = new LargeFileDocument(uri, this.editStorage);
        try {
            if (context?.backupId) {
                const pending = await document.edits.restore(context.backupId);
                if (pending !== undefined) {
                    if (!pending || !Number.isSafeInteger(pending.firstLine) || !Number.isSafeInteger(pending.lastLine) || typeof pending.text !== 'string')
                        throw new Error(i18n.get('largeFileEditConflict'));
                    const record = await document.edits.prepare(pending.firstLine, pending.lastLine);
                    await document.edits.apply(record, pending.text);
                }
            }
            return document;
        } catch (error) { await document.edits.dispose(); throw error; }
    }

    private assertWritableDocument(document: LargeFileDocument) {
        if (hasDirtyText(document.uri))
            throw new Error(i18n.get('largeFileUnsavedText'));
    }
    async saveCustomDocument(document: LargeFileDocument): Promise<void> {
        // Restored unapplied drafts must not overwrite the source through auto-save.
        if (document.edits.dirty) throw new Error(i18n.get('largeFileRecoverySaveAs'));
    }
    async saveCustomDocumentAs(document: LargeFileDocument, destination: vscode.Uri, token: vscode.CancellationToken): Promise<void> {
        try {
            if (keyForUri(destination) === keyForUri(document.uri)) {
                if (document.edits.dirty) throw new Error('largeFileRecoverySaveAs');
                this.assertWritableDocument(document);
            }
            if (destination.scheme !== 'file' || hasDirtyText(destination)) throw new Error('largeFileEditConflict');
            await document.edits.save(destination.fsPath, () => token.isCancellationRequested);
        } catch (error) { throw this.editError(error); }
    }
    async revertCustomDocument(document: LargeFileDocument): Promise<void> {
        try { await document.edits.revert(); await this.refreshEdited(document); }
        catch (error) { throw this.editError(error); }
    }
    async backupCustomDocument(document: LargeFileDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
        return document.edits.backup(context.destination.fsPath);
    }

    private editError(error: unknown): Error {
        const key = error instanceof Error ? error.message : '';
        if (!/^largeFile(?:Edit[A-Za-z]+|RecoverySaveAs)$/.test(key)) console.error('[lsdyna] Large-file edit operation failed:', error);
        return new Error(/^largeFile(?:Edit[A-Za-z]+|RecoverySaveAs)$/.test(key) ? i18n.get(key) : i18n.get('largeFileEditFailed'));
    }
    async openNative(request: { viewer?: string; revision?: number; line?: number; token?: string }): Promise<boolean> {
        const session = [...this.sessions.values()].find(value => value.state.viewer === request?.viewer);
        if (!session || !this.accepts(session, request.revision!)) return false;
        const row = session.state.lines.find(value => value.lineNumber === request.line);
        if (!row) return false;
        const field = request.token ? row.fields.find(value => value.token === request.token) : undefined;
        if (request.token && !field) return false;
        let uri = session.document.uri;
        try {
            if (session.document.edits.dirty) {
                const save = i18n.get('largeFileRecoverAs');
                if (await vscode.window.showWarningMessage(i18n.get('largeFileRecoveryPrompt'), { modal: true }, save) !== save) return true;
                const parsed = path.parse(uri.fsPath);
                const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(parsed.dir, `${parsed.name}.recovered${parsed.ext}`)) });
                if (!destination) return true;
                // Keep the recovery document and its backup until the user explicitly saves or discards it.
                if (keyForUri(destination) === keyForUri(uri)) throw new Error('largeFileEditConflict');
                await this.saveCustomDocumentAs(session.document, destination, { isCancellationRequested: false } as vscode.CancellationToken);
                uri = destination;
            }
            if (hasDirtyText(uri))
                void vscode.window.showWarningMessage(i18n.get('largeFileNativeDirty'));
            const selection = new vscode.Range(row.lineNumber, field?.startColumn || 0, row.lineNumber, field?.endColumn || 0);
            const nativeGroup = vscode.window.tabGroups?.all?.find(group => group.tabs.some(tab =>
                typeof vscode.TabInputText === 'function' && tab.input instanceof vscode.TabInputText && keyForUri(tab.input.uri) === keyForUri(uri)));
            await vscode.commands.executeCommand('vscode.openWith', uri, 'default', {
                viewColumn: nativeGroup?.viewColumn ?? session.panel.viewColumn, preview: false, selection,
            });
            return true;
        } catch (error) {
            console.error('[lsdyna] Open native editor failed:', error);
            await vscode.window.showErrorMessage(i18n.get('largeFileNativeFailed'));
            return false;
        }
    }

    private async refreshEdited(document: LargeFileDocument): Promise<void> {
        const session = this.sessions.get(keyForUri(document.uri));
        if (session) await this.reload(session, true);
    }


    async resolveCustomEditor(
        document: LargeFileDocument,
        panel: vscode.WebviewPanel,
    ): Promise<void> {
        const stat = await fs.promises.stat(document.edits.contentPath);
        const dist = path.join(this.extensionRoot, 'out', 'webview', 'large-file-viewer');
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(dist)],
        };
        const participant = this.messenger.registerWebviewPanel(panel);
        const initialLine = this.consumeInitialLine(document.uri);
        const state: LargeFileViewerState = {
            revision: 0,
            viewer: crypto.randomUUID(),
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
        const stale = () => {
            void fs.promises.stat(document.uri.fsPath).then(stat => {
                if (!document.edits.matchesSource(stat)) this.markStale(session);
                else if (!document.edits.checkpoint && !sameSignature(signatureFromStat(stat), session.signature)) this.markStale(session);
            }, () => this.markStale(session));
        };
        watcher.onDidChange(stale, undefined, session.handlers);
        watcher.onDidDelete(stale, undefined, session.handlers);
        panel.onDidDispose(() => this.disposeSession(session));
        panel.webview.html = this.html(panel.webview, dist);
        void this.initialize(session, initialLine);
    }

    async openAt(uri: vscode.Uri, line = 0, column: vscode.ViewColumn = vscode.ViewColumn.Active, startColumn = 0, endColumn = startColumn): Promise<boolean> {
        if (hasDirtyText(uri)) {
            await vscode.window.showWarningMessage(i18n.get('largeFileUnsavedText'));
            return false;
        }
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
        return binding && binding.generation === session?.generation && !session?.state.stale && !session?.document.edits?.dirty
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
        const navigationEpoch = session.navigationEpoch || 0;
        session.indexCancellation?.cancel();
        session.indexCancellation?.dispose();
        const indexCancellation = new vscode.CancellationTokenSource();
        session.indexCancellation = indexCancellation;
        try {
            await this.loadWindow(session, session.index ? initialLine : 0);
            if (!this.isLive(session, generation)) return;
            const index = await this.actions.loadFileIndex(
                session.document.edits?.contentPath || session.document.uri.fsPath,
                indexCancellation.token,
                async progress => {
                    if (!this.isLive(session, generation) || session.state.stale) return;
                    if (progress.size !== session.signature.size || progress.mtimeMs !== session.signature.mtimeMs ||
                        progress.scannerVersion !== SCANNER_VERSION) { this.markStale(session); return; }
                    session.index = progress;
                    session.state = { ...session.state, scannedBytes: progress.scannedBytes,
                        availableLineCount: Math.max(session.state.availableLineCount || 0, progress.largeFileLineMap.lineCount || 0) };
                    this.publish(session, false);
                    // Closed blocks can supply help before the remaining file is scanned.
                    const confirmed = progress.confirmedThroughLine ?? progress.keywordBlocks?.at(-1)?.endLine ?? -1;
                    if (!session.windowLoading && !session.state.selectedField && confirmed > (session.helpThroughLine ?? -1) &&
                        confirmed >= (session.state.lines[0]?.lineNumber ?? 0) && !session.state.lines.some(row => row.fields.length)) {
                        await this.loadWindow(session, session.state.anchorLine);
                        session.helpThroughLine = confirmed;
                    }
                },
            );
            if (!this.isLive(session, generation)) { this.actions.releaseFileIndex?.(index); return; }
            if (!index?.largeFileLineMap || index.scannerVersion !== SCANNER_VERSION ||
                index.size !== session.signature.size || index.mtimeMs !== session.signature.mtimeMs) {
                this.actions.releaseFileIndex?.(index);
                throw new Error('large-file-line-map-unavailable');
            }
            if (session.index?.lease !== index.lease) this.actions.releaseFileIndex?.(session.index);
            session.index = index;
            session.state = {
                ...session.state,
                indexing: 'ready',
                indexingMessage: '',
                lineCount: index.largeFileLineMap.lineCount,
            };
            const selected = session.state.selectedField;
            const selectedRow = session.state.lines?.find(row => row.fields.some(field => field.token === selected?.token));
            const selectedColumn = selectedRow?.fields.find(field => field.token === selected?.token)?.startColumn;
            await this.loadWindow(session, (session.navigationEpoch || 0) === navigationEpoch ? initialLine : (session.pendingLine ?? session.state.anchorLine));
            const restored = session.state.lines?.find(row => row.lineNumber === selectedRow?.lineNumber)?.fields
                .find(field => field.startColumn === selectedColumn);
            if (restored && this.isLive(session, generation)) await this.selectField(session, restored.token);
        } catch (error) {
            if (!this.isLive(session, generation)) return;
            this.actions.releaseFileIndex?.(session.index);
            session.index = null;
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
            this.messenger.onRequest(LargeFileOpenNative, request => this.openNative({ ...request, viewer: session.state.viewer }), sender),
            this.messenger.onNotification(LargeFilePositionChanged, request => {
                if (this.accepts(session, request.revision) && Number.isSafeInteger(request.line) &&
                    session.state.lines.some(line => line.lineNumber === request.line)) {
                    session.navigationEpoch = (session.navigationEpoch || 0) + 1;
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

    private publish(session: ViewerSession, advanceRevision = true): void {
        session.state.dirty = session.document.edits?.dirty || false;
        const object = session.state.selectedField?.object;
        if (object) session.state = { ...session.state, selectedField: {
            ...session.state.selectedField!, object: { ...object, kindLabel: shortEntityKindLabel(object.kind) },
        } };
        session.state = { ...session.state, revision: session.state.revision + (advanceRevision ? 1 : 0),
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

    private async reload(session: ViewerSession, edited = false): Promise<boolean> {
        if (!edited && session.document.edits?.dirty) {
            session.state.editError = i18n.get('largeFileEditReloadBlocked'); this.publish(session); return false;
        }
        if (!edited && session.document.edits?.checkpoint) {
            await session.document.edits.revert();
        }
        const generation = session.generation;
        const stat = await fs.promises.stat(session.document.edits?.contentPath || session.document.uri.fsPath);
        if (!this.isLive(session, generation)) return false;
        session.generation++;
        session.searchGeneration++;
        session.indexCancellation?.cancel();
        session.signature = signatureFromStat(stat);
        this.actions.releaseFileIndex?.(session.index);
        session.index = null;
        session.readCursors?.clear();
        session.fields.clear();
        session.windowCache.clear();
        session.fieldInputFormat = undefined;
        session.helpThroughLine = undefined;
        session.windowCacheBytes = 0;
        session.searchMatches = [];
        session.state = {
            ...session.state,
            fileSize: stat.size,
            stale: false,
            indexing: 'loading',
            indexingMessage: i18n.get('largeFileIndexing'),
            navigationTarget: undefined,
            lines: [],
            currentKeyword: '',
            lineCount: undefined,
            availableLineCount: undefined,
            scannedBytes: undefined,
            selectedField: null,
            keywordSearch: undefined,
            search: { query: '', loading: false, count: 0, currentIndex: -1, truncated: false, message: '' },
        };
        this.publish(session);
        void this.initialize(session, session.state.anchorLine);
        return true;
    }

    private async navigate(session: ViewerSession, line: number): Promise<boolean> {
        if (session.state.stale) return false;
        session.navigationEpoch = (session.navigationEpoch || 0) + 1;
        session.pendingLine = line;
        try { await this.loadWindow(session, line); return true; }
        finally { if (session.pendingLine === line) session.pendingLine = undefined; }
    }

    private async loadWindow(session: ViewerSession, line: number): Promise<void> {
        const request = ++session.requestGeneration;
        session.windowLoading = true;
        try {
            const generation = session.generation;
            const isCurrent = () => this.isLive(session, generation) && request === session.requestGeneration && !session.state.stale;
            if (session.index?.remote) {
                const metadata = await this.actions.readFileIndex(session.index, { mode: 'window', line });
                if (!isCurrent()) return;
                if (metadata.state !== 'complete' && metadata.state !== 'scanning') { this.markStale(session); return; }
                let next = metadata.next;
                while (next !== undefined) {
                    const page = await this.actions.readFileIndex(session.index, { mode: 'window', line: metadata.windowLine ?? line, blockOffset: next });
                    if (!isCurrent()) return;
                    if (!['complete', 'scanning'].includes(page.state) || page.next !== undefined && page.next <= next) { this.markStale(session); return; }
                    metadata.keywordBlocks.push(...page.keywordBlocks); next = page.next;
                }
                session.index = { ...session.index, ...metadata };
                session.fieldInputFormat = metadata.inputFormat;
            }
            const map = session.index?.largeFileLineMap as LargeFileLineMap | undefined;
            const knownCount = map?.complete === false ? undefined : map?.lineCount;
            const requested = Math.max(0, Math.floor(Number(line) || 0));
            const anchor = knownCount === undefined ? Math.min(requested, (session.state.availableLineCount || 0) + 240) : Math.min(
                Math.max(0, Math.floor(Number(line) || 0)),
                Math.max(0, knownCount - 1),
            );
            let raw: CachedWindow['value'];
            const windowStart = Math.max(0, anchor - 60);
            let cursor: { line: number; offset: number } | undefined;
            for (const [cursorLine, offset] of session.readCursors || []) {
                if (cursorLine <= windowStart && (!cursor || cursorLine > cursor.line)) cursor = { line: cursorLine, offset };
            }
            const cached = session.windowCache.get(windowStart);
            if (cached) {
                const stat = signatureFromStat(await fs.promises.stat(session.document.edits?.contentPath || session.document.uri.fsPath));
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
                    session.document.edits?.contentPath || session.document.uri.fsPath,
                    map || null,
                    windowStart,
                    { expectedSignature: session.signature, maxLines: 300, cursor, isCurrent },
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
                raw = await readLargeFileWindow(session.document.edits?.contentPath || session.document.uri.fsPath, map || null, anchor,
                    { expectedSignature: session.signature, maxLines: 300, cursor, isCurrent });
                if (!isCurrent()) return;
                if (raw.stale) { this.markStale(session); return; }
            }
            if (!raw.lines.length && raw.lineCount) {
                raw = await readLargeFileWindow(session.document.edits?.contentPath || session.document.uri.fsPath,
                    map || null, raw.lineCount - 1, { expectedSignature: session.signature, maxLines: 300, cursor, isCurrent });
                if (!isCurrent()) return;
                if (raw.stale) { this.markStale(session); return; }
            }
            if (raw.cursor) {
                session.readCursors ||= new Map();
                session.readCursors.set(raw.cursor.line, raw.cursor.offset);
                // ponytail: cap browsing checkpoints at 4096; raise only if measured backward navigation needs more history.
                if (session.readCursors.size > 4096) session.readCursors.delete(session.readCursors.keys().next().value);
            }
            const lines = await this.annotateLines(session, raw.lines, request);
            if (!isCurrent()) return;
            const after = signatureFromStat(await fs.promises.stat(session.document.edits?.contentPath || session.document.uri.fsPath));
            if (!isCurrent()) return;
            if (!sameSignature(after, session.signature)) {
                this.markStale(session);
                return;
            }
            session.state = {
                ...session.state,
                anchorLine: Math.min(anchor, raw.lineCount === undefined ? anchor : Math.max(0, raw.lineCount - 1)),
                availableLineCount: Math.max(session.state.availableLineCount || 0, (raw.lines.at(-1)?.lineNumber ?? -1) + 1),
                lineCount: raw.lineCount ?? session.state.lineCount,
                lines,
                currentKeyword: this.keywordAt(session.index?.keywordBlocks || [], raw.anchorLine),
                selectedField: null,
            };
            this.rememberAnchor(session);
            this.publish(session);
        } finally { if (request === session.requestGeneration) session.windowLoading = false; }
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
                found = blocks[middle].endLine === undefined || line <= blocks[middle].endLine
                    ? blocks[middle].keyword || '' : '';
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
        if (!session.index?.keywordBlocks || lines.length === 0) { if (isCurrent()) session.fields = fields; return lines; }
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
                        lineText,
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
                        queryable: !!queryTarget && session.state.indexing === 'ready' && !session.document.edits?.dirty,
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
        lineText: string,
    ): FieldBinding['target'] {
        try {
            let info = getActionableFieldReferenceInfo({
                keyword: cardInfo.keywordName,
                cardIndex: cardInfo.cardIndex,
                field,
            });
            if (info?.source === "keyword-catalog") {
                const sibling = require('../core/references/registryReferenceScanner')
                    .resolveSiblingTargetBinding(info, lineText, session.fieldInputFormat || 'standard', undefined,
                        field.nativeIdentity?.cardIndex ?? cardInfo.cardIndex, undefined, line);
                if (sibling.state === 'indeterminate') return null;
                info = sibling.info;
            }
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

    private async selectField(session: ViewerSession, token: string): Promise<boolean> {
        const binding = session.fields.get(token);
        if (!binding || binding.generation !== session.generation) return false;
        session.navigationEpoch = (session.navigationEpoch || 0) + 1;
        const field = binding.field;
        const choices = Array.isArray(field.e)
            ? field.e.slice(0, 20).map(value => typeof value === 'string' ? value : JSON.stringify(value))
            : [];
        let name = binding.target && session.state.indexing === 'ready' ? this.objectName(session, binding.target) : undefined;
        if (binding.target && session.index?.remote && session.state.indexing === 'ready') {
            const result = await this.actions.readFileIndex(session.index, { mode: 'name',
                targetKind: binding.target.targetKind, id: binding.target.id });
            if (!this.isLive(session, binding.generation) || session.fields.get(token) !== binding || session.state.stale) return false;
            name = result.state === 'complete' ? result.name : undefined;
        }
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
            queryable: !!binding.target && session.state.indexing === 'ready' && !session.document.edits?.dirty,
            ...(binding.target ? { object: { kind: binding.target.targetKind,
                kindLabel: shortEntityKindLabel(binding.target.targetKind), id: String(binding.target.id),
                name } } : {}),
        };
        session.state = { ...session.state, selectedField: selected };
        this.publish(session);
        return true;
    }

    private async queryField(session: ViewerSession, token: string): Promise<boolean> {
        if (session.state.indexing !== 'ready') return false;
        if (session.document.edits?.dirty) return false;
        const binding = session.fields.get(token);
        if (!this.isLive(session, session.generation) || !binding || binding.generation !== session.generation || !binding.target || session.state.stale) {
            return false;
        }
        return this.actions.queryObject(binding.target);
    }

    private async navigateKeyword(session: ViewerSession, direction: -1 | 1, filter: string): Promise<boolean> {
        if (session.state.indexing !== 'ready') return false;
        const query = String(filter || '').trim();
        if (session.index?.remote) {
            const generation = session.generation;
            const response = await this.actions.readFileIndex(session.index, { mode: 'keyword',
                direction, filter: query, line: session.state.anchorLine });
            if (!this.isLive(session, generation) || session.state.stale) return false;
            if (response.state !== 'complete') { this.markStale(session); return false; }
            session.state = { ...session.state, keywordSearch: { query, count: response.count, currentIndex: response.currentIndex },
                navigationTarget: response.block ? { requestId: crypto.randomUUID(), line: response.block.startLine,
                    startColumn: 0, endColumn: String(response.block.keyword).replace(/^\*/, '').length + 1 } : undefined };
            if (response.block) await this.loadWindow(session, response.block.startLine); else this.publish(session);
            return true;
        }
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
        if (normalized && session.state.indexing !== 'ready') return false;
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
            result = await searchLargeFileLiteral(session.document.edits?.contentPath || session.document.uri.fsPath, normalized, {
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
        this.actions.releaseFileIndex?.(session.index);
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
