'use strict';

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Messenger } from 'vscode-messenger';
import type { WebviewIdMessageParticipant } from 'vscode-messenger-common';
import {
    EntityReferencesClearRequest,
    EntityReferencesFocusNotification,
    EntityReferencesInferRequest,
    EntityReferencesSearchRequest,
    EntityReferencesScopeRequest,
    EntityReferencesToggleFollowRequest,
    EntityReferencesLoadMoreRequestType,
    EntityReferencesOpenRequestType,
    EntityReferencesOpenLargeFileRequestType,
    EntityReferencesQueryRequestType,
    EntityReferencesReadyRequest,
    EntityReferencesRefreshRequest,
    EntityReferencesRemoveSessionRequest,
    EntityReferencesSelectSessionRequest,
    EntityReferencesStateChangedNotification,
    EntityReferencesTogglePinRequest,
    type EntityReferenceScopePreference,
    type EntityReferencesViewState,
} from './entityReferencesProtocol';
const i18n = require('../core/i18n');
const { normalizeIndexedEntityId } = require('../core/references/indexedEntityQuery');

import { displayPathLabels } from './displayPathLabels';

const PAGE_SIZE = 100;

export type EntityReferencesWebviewActions = {
    follow?: () => void;
    stopFollow?: () => void;
    query: (targetKind: string, id: string, scope: EntityReferenceScopePreference) => boolean | Promise<boolean>;
    infer: () => boolean | Promise<boolean>;
    refresh: () => boolean | Promise<boolean>;
    togglePin: (sessionKey: string) => boolean | Promise<boolean>;
    selectSession: (sessionKey: string) => boolean | Promise<boolean>;
    removeSession: (sessionKey: string) => boolean | Promise<boolean>;
    clear: () => boolean | Promise<boolean>;
    open: (session: any, location: any, side: boolean) => boolean | Promise<boolean>;
    openLargeFile: (uri: vscode.Uri) => boolean | Promise<boolean>;
};

type ScopeContext = {
    filePath?: string;
    projectRoot?: string;
};

const KIND_LABELS: Record<string, [string, string]> = {
    'ale-multi-material-set': ['ALE 多材料集合', '*SET_MULTI-MATERIAL_GROUP'],
    'coordinate-system': ['坐标系', '*DEFINE_COORDINATE'],
    curve: ['曲线', '*DEFINE_CURVE'],
    element: ['单元', '*ELEMENT'],
    'equation-of-state': ['状态方程', '*EOS'],
    function: ['函数', '*DEFINE_FUNCTION'],
    hourglass: ['沙漏控制', '*HOURGLASS'],
    material: ['材料', '*MAT'],
    node: ['节点', '*NODE'],
    'node-set': ['节点集合', '*SET_NODE'],
    part: ['部件', '*PART'],
    'part-set': ['部件集合', '*SET_PART'],
    'pblast-air-geometry': ['爆炸空气几何', '*DEFINE_PBLAST_AIRBLAST'],
    section: ['截面', '*SECTION'],
    set: ['集合', '*SET'],
    table: ['表格', '*DEFINE_TABLE'],
    'thermal-material': ['热材料', '*MAT_THERMAL'],
    transformation: ['变换', '*DEFINE_TRANSFORMATION'],
};

export class EntityReferencesWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private readonly messenger = new Messenger();
    private disposed = false;
    private participant: WebviewIdMessageParticipant | undefined;
    private view: vscode.WebviewView | undefined;
    private handlers: vscode.Disposable[] = [];
    private modelSubscription: vscode.Disposable | undefined;
    private revision = 0;
    private input = { targetKind: 'curve', id: '', scopePreference: 'auto' as EntityReferenceScopePreference };
    private scopeContext: ScopeContext = {};
    private visibleCounts = new Map<string, { definition: number; reference: number }>();
    private locationsByToken = new Map<string, { session: any; location: any }>();
    private tokensByLocation = new WeakMap<object, string>();
    private pathLabelSource: any[] | undefined;
    private pathLabels = new Map<string, string>();
    private pendingFocus = false;
    private message = '';
    private following = false;
    private searchPending = false;
    private kindsReady: boolean;
    private groupedLocations = new WeakMap<any[], { definitions: any[]; references: any[] }>();
    private searchPicker: vscode.QuickPick<any> | undefined;
    private largeFileOffer: { token: string; uri: vscode.Uri; reason: string } | undefined;

    constructor(
        private readonly extensionRoot: string,
        private readonly model: any,
        private readonly targetKinds: () => string[],
        private readonly actions: EntityReferencesWebviewActions,
        private readonly prepareKinds?: () => Promise<unknown>,
    ) {
        this.kindsReady = !prepareKinds;
        this.modelSubscription = this.model.onDidChangeTreeData?.(() => {
            if (!this.isFollowingCursor()) this.actions.stopFollow?.();
            this.publish();
        });
    }

    async resolveWebviewView(view: vscode.WebviewView, _context?: unknown, token?: vscode.CancellationToken): Promise<void> {
        this.view = view;
        if (this.disposed || this.view !== view || token?.isCancellationRequested) return;
        const dist = path.join(this.extensionRoot, 'out', 'webview', 'entity-references');
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(dist)],
        };
        const participant = this.messenger.registerWebviewView(view);
        this.participant = participant;
        this.registerHandlers(participant, token);
        const visibility = view.onDidChangeVisibility?.(() => {
            if (view.visible && this.following) this.actions.follow?.();
            else this.actions.stopFollow?.();
        });
        if (visibility) this.handlers.push(visibility);
        view.onDidDispose(() => this.detach(participant));
        view.webview.html = this.html(view.webview, dist);
        if (this.pendingFocus) this.focusForm();
    }

    setScopeContext(context: ScopeContext): void {
        const next = {
            filePath: context.filePath ? path.resolve(context.filePath) : undefined,
            projectRoot: context.projectRoot ? path.resolve(context.projectRoot) : undefined,
        };
        if (JSON.stringify(next) === JSON.stringify(this.scopeContext)) return;
        this.scopeContext = next;
        this.publish();
    }

    setInput(targetKind: string, id: string | number, scopePreference?: EntityReferenceScopePreference): void {
        this.input = {
            targetKind: targetKind || this.input.targetKind,
            id: String(id ?? ''),
            scopePreference: scopePreference || this.input.scopePreference,
        };
        this.message = '';
        this.publish();
    }

    setMessage(message: string): void {
        this.message = message;
        this.publish();
    }

    setLargeFileOffer(uri?: vscode.Uri, reason = ''): void {
        const current = this.largeFileOffer;
        if (!uri) {
            if (!current) return;
            this.largeFileOffer = undefined;
            this.publish();
            return;
        }
        if (current?.uri.toString() === uri.toString() && current.reason === reason) return;
        this.largeFileOffer = { token: crypto.randomUUID(), uri, reason };
        this.publish();
    }

    focusForm(): void {
        this.pendingFocus = true;
        void vscode.commands.executeCommand('lsdynaEntityReferences.focus');
        if (this.participant) {
            this.pendingFocus = false;
            this.messenger.sendNotification(EntityReferencesFocusNotification, this.participant, { target: 'id' });
        }
    }

    refreshUiLanguage(): void { this.publish(); }

    getScopePreference(): EntityReferenceScopePreference { return this.input.scopePreference; }

    isFollowingCursor(): boolean {
        return !!this.participant && this.view?.visible === true && this.following && !this.searchPending &&
            !this.model.getActiveSession?.()?.pinned;
    }

    async search(): Promise<boolean> {
        if (this.searchPending) return true;
        this.searchPending = true;
        this.actions.stopFollow?.();
        try { if (this.prepareKinds) await this.prepareKinds(); }
        catch (error) { this.searchPending = false; throw error; }
        this.kindsReady = true;
        if (this.disposed) { this.searchPending = false; return false; }
        const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { targetKind: string; id: string }>();
        this.searchPicker = picker;
        const zh = i18n.getLanguage() === 'zh-cn';
        picker.title = zh ? '查找对象' : 'Find Object';
        picker.placeholder = zh ? '输入 ID，或“类型 ID”（例如：曲线 1001），选择后按 Enter' : 'Enter an ID or “type ID” (for example: curve 1001), then select and press Enter';
        picker.ignoreFocusOut = true;
        picker.matchOnDescription = true;
        const update = () => {
            const parts = picker.value.trim().split(/\s+/);
            const id = normalizeIndexedEntityId(parts.pop());
            const filter = parts.join(' ').toLowerCase().replace(/^\*/, '');
            picker.items = id ? this.targetKinds().filter(kind =>
                `${kind} ${this.kindLabel(kind)}`.toLowerCase().includes(filter),
            ).map(targetKind => ({
                label: `${this.shortKindLabel(targetKind)} ${id}`,
                description: KIND_LABELS[targetKind]?.[1] || targetKind,
                alwaysShow: true, targetKind, id: String(id),
            })) : [];
            picker.title = picker.value.trim() && !picker.items.length
                ? (zh ? '未匹配类型或 ID 格式不正确，例如：曲线 1001' : 'No matching type or invalid ID. Example: curve 1001')
                : (zh ? '查找对象' : 'Find Object');
        };
        const listeners: vscode.Disposable[] = [];
        try {
            const selected = await new Promise<{ targetKind: string; id: string } | undefined>(resolve => {
                listeners.push(picker.onDidChangeValue(update),
                    picker.onDidAccept(() => {
                        if (picker.selectedItems[0]) { resolve(picker.selectedItems[0]); picker.hide(); }
                    }),
                    picker.onDidHide(() => resolve(undefined)));
                update();
                picker.show();
            });
            if (!selected) return true; // Escape is a normal cancellation, not a query error.
            const scope = this.input.scopePreference === 'auto' ? 'file' : this.input.scopePreference;
            return await this.actions.query(selected.targetKind, selected.id, scope);
        } finally {
            listeners.forEach(listener => listener.dispose());
            picker.dispose();
            this.searchPicker = undefined;
            this.searchPending = false;
        }
    }

    private shortKindLabel(kind: string): string {
        return i18n.getLanguage() === 'zh-cn' ? KIND_LABELS[kind]?.[0] || kind : kind;
    }

    dispose(): void {
        this.disposed = true;
        this.searchPicker?.hide();
        this.detach(this.participant);
        this.view = undefined;
        this.modelSubscription?.dispose();
        this.modelSubscription = undefined;
        this.pathLabelSource = undefined;
        this.pathLabels.clear();
        this.visibleCounts.clear();
    }

    private accepts(revision: number): boolean {
        return Number.isFinite(revision) && revision === this.revision;
    }

    private registerHandlers(participant: WebviewIdMessageParticipant, token?: vscode.CancellationToken): void {
        const sender = { sender: participant };
        this.handlers = [
            this.messenger.onRequest(EntityReferencesReadyRequest, async () => {
                if (this.disposed || this.participant !== participant || token?.isCancellationRequested)
                    throw new Error('Entity references view closed');
                if (this.following) this.actions.follow?.();
                return this.viewState();
            }, sender),
            this.messenger.onRequest(EntityReferencesSearchRequest, request =>
                this.accepts(request.revision) && this.search(), sender),
            this.messenger.onRequest(EntityReferencesToggleFollowRequest, request => {
                if (!this.accepts(request.revision) || this.model.getActiveSession?.()?.pinned) return false;
                this.following = !this.following;
                this.publish();
                if (this.following) this.actions.follow?.();
                else this.actions.stopFollow?.();
                return true;
            }, sender),
            this.messenger.onRequest(EntityReferencesScopeRequest, request => {
                if (!this.accepts(request.revision) || !['file', 'project'].includes(request.scopePreference)) return false;
                if (request.scopePreference === 'file' ? !this.scopeContext.filePath : !this.scopeContext.projectRoot) return false;
                this.input.scopePreference = request.scopePreference;
                const session = this.model.getActiveSession?.();
                if (session) return this.actions.query(session.identity.targetKind, String(session.identity.id), request.scopePreference);
                this.publish();
                if (this.following) this.actions.follow?.();
                return true;
            }, sender),
            this.messenger.onRequest(EntityReferencesQueryRequestType, async request => {
                if (!this.accepts(request.revision)) return false;
                this.input = { targetKind: request.targetKind, id: request.id,
                    scopePreference: request.scopePreference };
                this.message = '';
                return this.actions.query(request.targetKind, request.id, request.scopePreference);
            }, sender),
            this.messenger.onRequest(EntityReferencesInferRequest, request =>
                this.accepts(request.revision) && this.actions.infer(), sender),
            this.messenger.onRequest(EntityReferencesRefreshRequest, request =>
                this.accepts(request.revision) && this.actions.refresh(), sender),
            this.messenger.onRequest(EntityReferencesLoadMoreRequestType, request => {
                if (!this.accepts(request.revision)) return false;
                const session = this.model.getActiveSession?.();
                if (!session) return false;
                const counts = this.visibleCounts.get(session.key) || { definition: PAGE_SIZE, reference: PAGE_SIZE };
                counts[request.role] += PAGE_SIZE;
                this.visibleCounts.set(session.key, counts);
                this.publish();
                return true;
            }, sender),
            this.messenger.onRequest(EntityReferencesTogglePinRequest, request =>
                this.accepts(request.revision) && this.actions.togglePin(request.sessionKey), sender),
            this.messenger.onRequest(EntityReferencesSelectSessionRequest, request =>
                this.accepts(request.revision) && this.actions.selectSession(request.sessionKey), sender),
            this.messenger.onRequest(EntityReferencesRemoveSessionRequest, request =>
                this.accepts(request.revision) && this.actions.removeSession(request.sessionKey), sender),
            this.messenger.onRequest(EntityReferencesClearRequest, request =>
                this.accepts(request.revision) && this.actions.clear(), sender),
            this.messenger.onRequest(EntityReferencesOpenRequestType, request => {
                if (!this.accepts(request.revision)) return false;
                const resolved = this.locationsByToken.get(request.locationId);
                return resolved ? this.actions.open(resolved.session, resolved.location, request.side) : false;
            }, sender),
            this.messenger.onRequest(EntityReferencesOpenLargeFileRequestType, request => {
                if (!this.accepts(request.revision) || request.token !== this.largeFileOffer?.token) return false;
                return this.actions.openLargeFile(this.largeFileOffer.uri);
            }, sender),
        ];
    }

    private detach(participant: WebviewIdMessageParticipant | undefined): void {
        if (!participant) return;
        this.actions.stopFollow?.();
        for (const handler of this.handlers.splice(0)) handler.dispose();
        if (this.participant?.webviewId === participant.webviewId) this.participant = undefined;
        if (this.view) this.view = undefined;
    }

    private resultGroups(session: any) {
        const locations = session?.locations;
        if (!locations) return { definitions: [], references: [] };
        let groups = this.groupedLocations.get(locations);
        if (!groups) {
            groups = { definitions: [], references: [] };
            for (const item of locations) {
                if (item.role === 'definition') groups.definitions.push(item);
                else if (item.role === 'reference') groups.references.push(item);
            }
            this.groupedLocations.set(locations, groups);
        }
        return groups;
    }

    private sessionSummary(session: any) {
        const groups = this.resultGroups(session);
        const definitions = groups.definitions.length;
        const references = groups.references.length;
        return {
            scopeLabel: i18n.get(session.identity.scope?.kind === 'project' ? 'entityReferencesIncludeProject' : 'entityReferencesCurrentFile'),
            scopePath: session.identity.scope?.rootFile || session.identity.scope?.filePath || '',
            key: session.key,
            label: `${this.shortKindLabel(session.identity.targetKind)} ${session.identity.id}`,
            state: session.state === 'ready' ? 'ready' : session.state,
            pinned: !!session.pinned,
            active: this.model.activeKey === session.key,
            definitionCount: definitions,
            referenceCount: references,
        };
    }

    private kindLabel(kind: string): string {
        const mapped = KIND_LABELS[kind];
        if (!mapped) return kind;
        return i18n.getLanguage() === 'zh-cn' ? `${mapped[0]} ${mapped[1]}` : `${mapped[1]} (${kind})`;
    }

    private locationItem(session: any, location: any) {
        let token = this.tokensByLocation.get(location);
        if (!token) {
            token = crypto.randomUUID();
            this.tokensByLocation.set(location, token);
        }
        this.locationsByToken.set(token, { session, location });
        const roleLabel = i18n.get(location.role === 'definition'
            ? 'entityIdQueryDefinition'
            : 'entityIdQueryReference');
        return {
            locationId: token,
            role: location.role,
            label: [location.keyword, location.fieldName].filter(Boolean).join(' / ') || roleLabel,
            keyword: location.keyword || undefined,
            fieldName: location.fieldName || undefined,
            description: `${this.pathLabels.get(location.filePath) || path.basename(location.filePath)} : ${location.line + 1}`,
            detail: `${location.filePath}:${location.line + 1}`,
        };
    }

    private viewState(): EntityReferencesViewState {
        this.locationsByToken.clear();
        for (const key of this.visibleCounts.keys()) {
            if (!this.model.getSession(key)) this.visibleCounts.delete(key);
        }
        const active = this.model.getActiveSession?.();
        if (this.pathLabelSource !== active?.locations) {
            this.pathLabelSource = active?.locations;
            this.pathLabels = displayPathLabels((active?.locations || []).map((location: any) => location.filePath));
        }
        const counts = active
            ? this.visibleCounts.get(active.key) || { definition: PAGE_SIZE, reference: PAGE_SIZE }
            : { definition: PAGE_SIZE, reference: PAGE_SIZE };
        if (active && !this.visibleCounts.has(active.key)) this.visibleCounts.set(active.key, counts);
        const { definitions: allDefinitions, references: allReferences } = this.resultGroups(active);
        const selectedScope = active?.identity?.scope?.kind === 'project' ||
            (!active && this.input.scopePreference === 'project') ? 'project' : 'file';
        const status = !active ? 'empty' : active.state === 'ready' && active.locations.length === 0
            ? 'missing' : active.state;
        return {
            locale: i18n.getLanguage() === 'zh-cn' ? 'zh' : 'en',
            following: this.following && !active?.pinned,
            revision: this.revision,
            input: this.input,
            kindOptions: this.kindsReady ? this.targetKinds().map(value => ({ value, label: this.kindLabel(value) })) : [],
            scope: {
                selected: selectedScope,
                fileAvailable: !!this.scopeContext.filePath,
                projectAvailable: !!this.scopeContext.projectRoot,
                fileLabel: this.scopeContext.filePath ? path.basename(this.scopeContext.filePath) : '',
                projectLabel: this.scopeContext.projectRoot ? path.basename(this.scopeContext.projectRoot) : '',
            },
            status,
            ambiguous: active?.resolution === 'ambiguous',
            activeSession: active ? this.sessionSummary(active) : null,
            definitions: allDefinitions.slice(0, counts.definition).map((location: any) =>
                this.locationItem(active, location)),
            references: allReferences.slice(0, counts.reference).map((location: any) =>
                this.locationItem(active, location)),
            hasMoreDefinitions: allDefinitions.length > counts.definition,
            hasMoreReferences: allReferences.length > counts.reference,
            reasons: [...(active?.reasons || [])],
            pinnedSessions: (this.model.pinnedKeys || [])
                .map((key: string) => this.model.getSession(key))
                .filter(Boolean)
                .map((session: any) => this.sessionSummary(session)),
            message: this.message,
            ...(this.largeFileOffer ? {
                largeFileOffer: {
                    token: this.largeFileOffer.token,
                    fileName: path.basename(this.largeFileOffer.uri.fsPath),
                    reason: this.largeFileOffer.reason,
                },
            } : {}),
            labels: {
                ambiguous: i18n.getLanguage() === 'zh-cn' ? '找到多个候选定义，尚不能唯一确定对象。请核对各定义位置。' : 'Multiple candidate definitions were found. Check their locations to identify the intended object.',
                queryInterrupted: i18n.getLanguage() === 'zh-cn' ? '查询已中断，可重新查询。' : 'The query was interrupted. You can run it again.',
                queryFailed: i18n.getLanguage() === 'zh-cn' ? '查询未完成，请重试。' : 'The query did not complete. Please try again.',
                resultsEvicted: i18n.getLanguage() === 'zh-cn' ? '结果已从缓存释放，请重新查询。' : 'Cached results were released. Run the query again.',
                locationChanged: i18n.getLanguage() === 'zh-cn' ? '结果位置已变化，请刷新后重新选择。' : 'Result locations changed. Refresh and select a location again.',
                pinHint: i18n.getLanguage() === 'zh-cn' ? '固定对象和查询范围；文件变化后仍需刷新结果。' : 'Pin the object and query scope. Results still need refreshing after file changes.',
                search: i18n.getLanguage() === 'zh-cn' ? '查找对象' : 'Find Object',
                follow: i18n.getLanguage() === 'zh-cn' ? '跟随光标' : 'Follow Cursor',
                resumeFollow: i18n.getLanguage() === 'zh-cn' ? '继续跟随' : 'Resume Following',
                fixed: i18n.getLanguage() === 'zh-cn' ? '已固定' : 'Pinned',
                unconfirmed: i18n.getLanguage() === 'zh-cn' ? '待确认' : 'Unconfirmed',
                zeroResults: i18n.getLanguage() === 'zh-cn' ? '未找到匹配位置。' : 'No matching locations.',
                referencesNotConfirmed: i18n.getLanguage() === 'zh-cn' ? '暂未确认引用位置。' : 'No reference locations confirmed yet.',
                definitionsNotConfirmed: i18n.getLanguage() === 'zh-cn' ? '暂未确认定义位置。' : 'No definition locations confirmed yet.',
                id: 'ID', query: i18n.get('entityReferencesQuery'), infer: i18n.get('entityReferencesFromCursor'),
                file: i18n.get('entityReferencesCurrentFile'), project: i18n.get('entityReferencesIncludeProject'),
                empty: i18n.getLanguage() === 'zh-cn' ? '查找对象，或开启跟随光标。' : 'Find an object, or turn on cursor following.', definitions: i18n.get('entityReferencesDefinitionsPlain'),
                references: i18n.get('entityReferencesReferencesPlain'), loadMore: i18n.get('entityReferencesLoadMore'),
                pin: i18n.get('entityReferencesPin'), unpin: i18n.get('entityReferencesUnpin'),
                pinned: i18n.get('entityReferencesPinned'), remove: i18n.get('entityReferencesRemove'),
                clear: i18n.get('entityReferencesClear'), openSide: i18n.get('entityReferencesOpenSide'),
                details: i18n.getLanguage() === 'zh-cn' ? '详情' : 'Details', partial: i18n.getLanguage() === 'zh-cn' ? '部分引用尚未确认' : 'Some references are not yet confirmed',
                loading: i18n.get('entityReferencesLoading'), missing: i18n.get('entityReferencesMissing'),
                invalid: i18n.get('entityReferencesInvalidId'),
                openLargeFile: i18n.get('entityReferencesOpenLargeFile'),
                modify: i18n.get('entityReferencesModify'),
                objectType: i18n.get('entityReferencesObjectType'), scope: i18n.get('entityReferencesScope'),
                refresh: i18n.get('entityReferencesRefresh'), retry: i18n.get('entityReferencesRetry'),
                stale: i18n.get('entityReferencesStaleHint'),
                'needs-refresh': i18n.get('entityReferencesNeedsRefreshHint'),
                incomplete: i18n.get('entityReferencesIncompleteHint'),
                pageCount: i18n.get('entityReferencesPageCount'),
                partialPageCount: i18n.get('entityReferencesPartialPageCount'),
            },
        };
    }

    private publish(): void {
        this.revision++;
        if (this.participant) {
            this.messenger.sendNotification(EntityReferencesStateChangedNotification,
                this.participant, this.viewState());
        }
    }

    private html(webview: vscode.Webview, dist: string): string {
        const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
        const entry = manifest['index.html'];
        if (!entry?.file) throw new Error(`Entity references webview entry missing from ${dist}`);
        const resource = (file: string) => webview.asWebviewUri(vscode.Uri.file(path.join(dist, file)));
        const css = (entry.css || []).map((file: string) =>
            `<link rel="stylesheet" href="${resource(file)}">`).join('');
        const nonce = crypto.randomBytes(18).toString('base64');
        const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`;
        return `<!doctype html><html lang="${i18n.getLanguage() === 'zh-cn' ? 'zh' : 'en'}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body><div id="root"></div><script nonce="${nonce}" type="module" src="${resource(entry.file)}"></script></body></html>`;
    }
}
