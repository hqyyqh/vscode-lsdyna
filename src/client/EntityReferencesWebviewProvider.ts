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
import { ENTITY_KIND_LABELS, shortEntityKindLabel } from './entityKindLabels';

const PAGE_SIZE = 200;

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

// Engineering defaults, not measured usage frequencies; leave the remaining directory order intact.
const SEARCH_KIND_PRIORITY = ['curve', 'material', 'part', 'section', 'part-set', 'node-set',
    'segment-set', 'function', 'table', 'coordinate-system'];
const LAST_SEARCH_KIND_KEY = 'entityReferences.lastSearchKind';

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
    private visibleQueryRevision?: string;
    private visibleQueryKey?: string;
    private locationsByToken = new Map<string, { session: any; location: any }>();
    private tokensByLocation = new WeakMap<object, string>();
    private pathLabelSource: any[] | undefined;
    private pathLabels = new Map<string, string>();
    private pendingFocus = false;
    private message = '';
    private following = false;
    private searchPending = false;
    private searchSequence = 0;
    private kindsReady: boolean;
    private groupedLocations = new WeakMap<any[], { definitions: any[]; references: any[] }>();
    private searchPicker: vscode.QuickPick<any> | undefined;
    private lastSearchKind: string | undefined;
    private largeFileOffer: { token: string; uri: vscode.Uri; reason: string } | undefined;

    constructor(
        private readonly extensionRoot: string,
        private readonly model: any,
        private readonly targetKinds: () => string[],
        private readonly actions: EntityReferencesWebviewActions,
        private readonly prepareKinds?: () => Promise<unknown>,
        private readonly workspaceState?: vscode.Memento,
    ) {
        this.lastSearchKind = workspaceState?.get<string>(LAST_SEARCH_KIND_KEY);
        this.kindsReady = !prepareKinds;
        this.modelSubscription = this.model.onDidChangeTreeData?.(() => {
            if (!this.isFollowingCursor()) this.actions.stopFollow?.();
            this.publish();
        });
    }

    async resolveWebviewView(view: vscode.WebviewView, _context?: unknown, token?: vscode.CancellationToken): Promise<void> {
        this.view = view;
        if (this.disposed || token?.isCancellationRequested) return;
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
        this.publish();
        if (this.pendingFocus) this.focusForm();
    }

    setScopeContext(context: ScopeContext, selectProject = false): void {
        const next = {
            filePath: context.filePath ? path.resolve(context.filePath) : undefined,
            projectRoot: context.projectRoot ? path.resolve(context.projectRoot) : undefined,
        };
        if (selectProject && next.projectRoot) this.input.scopePreference = 'project';
        else if (JSON.stringify(next) === JSON.stringify(this.scopeContext)) return;
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


    toggleFollowCursor(): void {
        if (this.model.getActiveSession?.()?.pinned) return;
        this.following = !this.following;
        if (this.following && this.view?.visible) {
            this.actions.follow?.();
        } else {
            this.actions.stopFollow?.();
        }
        this.publish();
    }

    async setScopePreference(scope: 'file' | 'project'): Promise<boolean> {
        if (scope === 'file' ? !this.scopeContext.filePath : !this.scopeContext.projectRoot) {
            const message = i18n.get(!this.scopeContext.filePath ? 'entityReferencesFileScopeUnavailable' : 'entityReferencesProjectScopeUnavailable');
            this.setMessage(message);
            return false;
        }
        this.input.scopePreference = scope;
        this.setMessage('');
        const session = this.model.getActiveSession?.();
        if (session) {
            try {
                const query = this.actions.query(session.identity.targetKind, String(session.identity.id), scope);
                // Query initialization resets input feedback before its first await.
                this.setMessage(i18n.get('entityReferencesChangingScope'));
                const result = await query;
                this.setMessage(result ? '' : i18n.get('entityReferencesIncompleteHint'));
                return result;
            } catch {
                this.setMessage(i18n.get('entityReferencesIncompleteHint'));
                return false;
            }
        }
        this.publish();
        if (this.following) this.actions.follow?.();
        return true;
    }

    isFollowingCursor(): boolean {
        return !!this.participant && this.view?.visible === true && this.following && !this.searchPending &&
            !this.model.getActiveSession?.()?.pinned;
    }

    async search(): Promise<boolean> {
        if (this.searchPending) return true;
        const sequence = ++this.searchSequence;
        this.searchPending = true;
        this.actions.stopFollow?.();
        this.setMessage('');
        try { if (this.prepareKinds) await this.prepareKinds(); }
        catch { this.searchPending = false; this.setMessage(i18n.get('entityReferencesIncompleteHint')); return false; }
        this.kindsReady = true;
        if (this.disposed) { this.searchPending = false; return false; }
        const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { targetKind: string; id: string }>();
        this.searchPicker = picker;
        const zh = i18n.getLanguage() === 'zh-cn';
        picker.title = zh ? '查找对象' : 'Find Entity';
        picker.placeholder = zh ? '输入 ID，或“类型 ID”（例如：曲线 1001），选择后按 Enter' : 'Enter an ID or “type ID” (for example: curve 1001), then select and press Enter';
        picker.ignoreFocusOut = true;
        picker.matchOnDescription = true;
        let kinds: string[] = [];
        let activeKind: string | undefined;
        let filteringFocus = false;
        const update = () => {
            filteringFocus = false;
            const parts = picker.value.trim().split(/\s+/);
            const id = normalizeIndexedEntityId(parts.pop());
            const filter = parts.join(' ').toLowerCase().replace(/^\*/, '');
            picker.items = id ? kinds.filter(kind =>
                `${kind} ${this.kindLabel(kind)}`.toLowerCase().includes(filter),
            ).map(targetKind => ({
                // Quick Pick sorts matching labels. Equal ID labels preserve our type order.
                label: String(id),
                description: `${this.shortKindLabel(targetKind)} · ${ENTITY_KIND_LABELS[targetKind]?.[1] || targetKind}`
                    + (targetKind === this.lastSearchKind ? (zh ? ' · 上次使用' : ' · Last used') : ''),
                alwaysShow: true, targetKind, id: String(id),
            })) : [];
            const preferred = picker.items.find(item => item.targetKind === activeKind)
                ?? (!filter ? picker.items.find(item => item.targetKind === this.lastSearchKind) : undefined)
                ?? picker.items[0];
            picker.activeItems = preferred ? [preferred] : [];
            picker.title = picker.value.trim() && !picker.items.length
                ? (zh ? '未匹配类型或 ID 格式不正确，例如：曲线 1001' : 'No matching type or invalid ID. Example: curve 1001')
                : (zh ? '查找对象' : 'Find Entity');
        };
        const listeners: vscode.Disposable[] = [];
        try {
            const availableKinds = this.targetKinds();
            kinds = [...SEARCH_KIND_PRIORITY.filter(kind => availableKinds.includes(kind)),
                ...availableKinds.filter(kind => !SEARCH_KIND_PRIORITY.includes(kind))];
            const selected = await new Promise<{ targetKind: string; id: string } | undefined>(resolve => {
                listeners.push(picker.onDidChangeValue(update),
                    picker.onDidChangeActive(items => {
                        const item = items[0];
                        // Native filtering clears/refocuses the old list before delivering the new value.
                        if (!item) filteringFocus = true;
                        if (!filteringFocus && item && item.id === String(normalizeIndexedEntityId(picker.value.trim().split(/\s+/).pop())))
                            activeKind = item.targetKind;
                    }),
                    picker.onDidAccept(() => {
                        if (picker.selectedItems[0]) { resolve(picker.selectedItems[0]); picker.hide(); }
                    }),
                    picker.onDidHide(() => resolve(undefined)));
                update();
                picker.show();
            });
            if (!selected) return true; // Escape is a normal cancellation, not a query error.
            this.lastSearchKind = selected.targetKind;
            // A preference-storage failure must not prevent the requested query.
            void this.workspaceState?.update(LAST_SEARCH_KIND_KEY, selected.targetKind).then(undefined,
                error => console.warn('Unable to save entity search preference', error));
            const scope = this.input.scopePreference === 'auto' ? 'file' : this.input.scopePreference;
            // The picker owns this lock; a background query must not lock the next search.
            this.searchPicker = undefined;
            this.searchPending = false;
            const result = await this.actions.query(selected.targetKind, selected.id, scope);
            if (!result && sequence === this.searchSequence) this.setMessage(i18n.get('entityReferencesIncompleteHint'));
            return result;
        } catch {
            if (sequence === this.searchSequence) this.setMessage(i18n.get('entityReferencesIncompleteHint'));
            return false;
        } finally {
            listeners.forEach(listener => listener.dispose());
            picker.dispose();
            if (this.searchPicker === picker) {
                this.searchPicker = undefined;
                this.searchPending = false;
            }
        }
    }

    private shortKindLabel(kind: string): string {
        return shortEntityKindLabel(kind);
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
                this.visibleCounts.clear();
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
                return this.setScopePreference(request.scopePreference);
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
            this.messenger.onRequest(EntityReferencesLoadMoreRequestType, async request => {
                if (!this.accepts(request.revision)) return false;
                const session = this.model.getActiveSession?.();
                if (!session || !['ready', 'partial'].includes(session.state) ||
                    !['definition', 'reference'].includes(request.role)) return false;
                const counts = this.visibleCounts.get(session.key) || { definition: PAGE_SIZE, reference: PAGE_SIZE };
                const start = counts[request.role];
                const loaded = session.locations.filter(location => location.role === request.role).length;
                if (loaded <= start && session.page?.next?.[request.role]) {
                    if (!await this.model.loadNextPage(session, request.role)) return false;
                    if (!this.accepts(request.revision) || this.model.getActiveSession?.() !== session) return false;
                }
                counts[request.role] += PAGE_SIZE;
                this.visibleCounts.set(session.key, counts);
                this.publish({ baseRevision: request.revision, role: request.role, start });
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
        const definitions = session.page?.counts?.definition ?? groups.definitions.length;
        const references = session.page?.counts?.reference ?? groups.references.length;
        return {
            scopeLabel: i18n.get(session.identity.scope?.kind === 'project' ? 'entityReferencesIncludeProject' : 'entityReferencesCurrentFile'),
            scopePath: session.identity.scope?.rootFile || session.identity.scope?.filePath || '',
            key: session.key,
            label: `${this.shortKindLabel(session.identity.targetKind)} ${session.identity.id}`,
            entityId: String(session.identity.id),
            entityKindLabel: this.shortKindLabel(session.identity.targetKind),
            ...(definitions === 1 && groups.definitions[0] && !session.scanning ? { entityName: groups.definitions[0].entityName,
                keyword: groups.definitions[0].keyword } : {}),
            state: session.state === 'ready' ? 'ready' : session.state,
            pinned: !!session.pinned,
            active: this.model.activeKey === session.key,
            definitionCount: definitions,
            referenceCount: references,
        };
    }

    private kindLabel(kind: string): string {
        const mapped = ENTITY_KIND_LABELS[kind];
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
            entityId: location.entityId,
            entityName: location.entityName,
            entityKind: location.entityKind,
            entityKindLabel: location.entityKind ? this.shortKindLabel(location.entityKind) : undefined,
            description: `${this.pathLabels.get(location.filePath) || path.basename(location.filePath)} : ${location.line + 1}`,
            fileLabel: this.pathLabels.get(location.filePath) || path.basename(location.filePath),
            line: location.line + 1,
            detail: `${location.filePath}:${location.line + 1}`,
        };
    }

    private viewState(page?: { baseRevision: number; role: 'definition' | 'reference'; start: number }, retainBaseRevision?: number): EntityReferencesViewState {
        if (!page && retainBaseRevision === undefined) this.locationsByToken.clear();
        for (const key of this.visibleCounts.keys()) {
            if (!this.model.getSession(key)) this.visibleCounts.delete(key);
        }
        const active = this.model.getActiveSession?.();
        if (this.pathLabelSource !== active?.locations) {
            this.pathLabelSource = active?.locations;
            this.pathLabels = displayPathLabels((active?.locations || []).map((location: any) => location.filePath));
        }
        let counts = active
            ? this.visibleCounts.get(active.key) || { definition: PAGE_SIZE, reference: PAGE_SIZE }
            : { definition: PAGE_SIZE, reference: PAGE_SIZE };
        const previousCounts = { ...counts };
        if (retainBaseRevision !== undefined) counts = {
            definition: Math.max(PAGE_SIZE, counts.definition), reference: Math.max(PAGE_SIZE, counts.reference) };
        if (active && !this.visibleCounts.has(active.key)) this.visibleCounts.set(active.key, counts);
        const { definitions: allDefinitions, references: allReferences } = this.resultGroups(active);
        const selectedScope = active?.identity?.scope?.kind === 'project' ||
            (!active && this.input.scopePreference === 'project') ? 'project' : 'file';
        const status = !active ? 'empty' : active.state === 'ready' && active.locations.length === 0
            ? 'missing' : active.state;
        const state: EntityReferencesViewState = {
            locale: i18n.getLanguage() === 'zh-cn' ? 'zh' : 'en',
            following: this.following && !active?.pinned,
            revision: this.revision,
            ...(page ? { appendPage: { baseRevision: page.baseRevision, role: page.role } } : {}),
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
            scanning: active?.scanning === true,
            activeSession: active ? this.sessionSummary(active) : null,
            definitions: allDefinitions.slice(page ? page.role === 'definition' ? page.start : counts.definition : 0,
                counts.definition).map((location: any) =>
                this.locationItem(active, location)),
            references: allReferences.slice(page ? page.role === 'reference' ? page.start : counts.reference : 0,
                counts.reference).map((location: any) =>
                this.locationItem(active, location)),
            referenceGroupCounts: active?.page?.groupCounts || allReferences.reduce((groups: Record<string, number>, location: any) => {
                const key = location.entityKind || '';
                groups[key] = (groups[key] || 0) + 1;
                return groups;
            }, {}),
            hasMoreDefinitions: allDefinitions.length > counts.definition || !!active?.page?.next?.definition,
            hasMoreReferences: allReferences.length > counts.reference || !!active?.page?.next?.reference,
            reasons: [...(active?.reasons || [])],
            reasonDetails: [...(active?.reasons || [])]
                .filter(reason => ['entity-query-cancelled', 'entity-query-low-memory', 'entity-query-index-budget', 'entity-query-result-budget', 'entity-query-incomplete'].includes(reason))
                .map(reason => require('../core/references/fieldReferenceHover').uncertaintyReasonLabel(reason)),
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
                title: i18n.getLanguage() === 'zh-cn' ? '对象引用' : 'Entity references',
                name: i18n.getLanguage() === 'zh-cn' ? '名称' : 'Name',
                field: i18n.getLanguage() === 'zh-cn' ? '字段' : 'Field',
                referenceLocationsTitle: i18n.getLanguage() === 'zh-cn' ? '引用位置' : 'Reference locations',
                noReferences: i18n.getLanguage() === 'zh-cn' ? '在所选范围内未找到引用。' : 'No references found in the selected scope.',
                openLocation: i18n.getLanguage() === 'zh-cn' ? '跳转到位置' : 'Go to location',
                openDefinition: i18n.getLanguage() === 'zh-cn' ? '转到定义' : 'Go to definition',
                referenceLocations: i18n.getLanguage() === 'zh-cn' ? '{0} 个引用位置' : 'Reference locations: {0}',
                ambiguous: i18n.getLanguage() === 'zh-cn' ? '找到多个候选定义，尚不能唯一确定对象。请核对各定义位置。' : 'Multiple candidate definitions were found. Check their locations to identify the intended object.',
                queryInterrupted: i18n.getLanguage() === 'zh-cn' ? '查询已中断，可重新查询。' : 'The query was interrupted. You can run it again.',
                queryFailed: i18n.getLanguage() === 'zh-cn' ? '查询未完成，请重试。' : 'The query did not complete. Please try again.',
                resultsEvicted: i18n.getLanguage() === 'zh-cn' ? '结果已从缓存释放，请重新查询。' : 'Cached results were released. Run the query again.',
                locationChanged: i18n.getLanguage() === 'zh-cn' ? '结果位置已变化，请刷新后重新选择。' : 'Result locations changed. Refresh and select a location again.',
                pinHint: i18n.getLanguage() === 'zh-cn' ? '固定对象和查询范围；文件变化后仍需刷新结果。' : 'Pin the object and query scope. Results still need refreshing after file changes.',
                search: i18n.getLanguage() === 'zh-cn' ? '查找对象' : 'Find entity',
                follow: i18n.getLanguage() === 'zh-cn' ? '跟随光标' : 'Follow cursor',
                resumeFollow: i18n.getLanguage() === 'zh-cn' ? '继续跟随' : 'Resume Following',
                fixed: i18n.getLanguage() === 'zh-cn' ? '已固定' : 'Pinned',
                unconfirmed: i18n.getLanguage() === 'zh-cn' ? '待确认' : 'Unconfirmed',
                zeroResults: i18n.getLanguage() === 'zh-cn' ? '未找到匹配位置。' : 'No matching locations.',
                referencesNotConfirmed: i18n.getLanguage() === 'zh-cn' ? '尚不能确定引用位置。' : 'Reference locations are not confirmed.',
                definitionsNotConfirmed: i18n.getLanguage() === 'zh-cn' ? '尚不能确定定义位置。' : 'Definition locations are not confirmed.',
                id: 'ID', query: i18n.get('entityReferencesQuery'), infer: i18n.get('entityReferencesFromCursor'),
                file: i18n.get('entityReferencesCurrentFile'), project: i18n.get('entityReferencesIncludeProject'),
                empty: i18n.getLanguage() === 'zh-cn' ? '查找对象，或开启跟随光标。' : 'Find an object, or turn on cursor following.', definitions: i18n.get('entityReferencesDefinitionsPlain'),
                references: i18n.get('entityReferencesReferencesPlain'), loadMore: i18n.get('entityReferencesLoadMore'),
                pin: i18n.get('entityReferencesPin'), unpin: i18n.get('entityReferencesUnpin'),
                pinned: i18n.get('entityReferencesPinned'), remove: i18n.get('entityReferencesRemove'),
                clear: i18n.get('entityReferencesClear'), openSide: i18n.getLanguage() === 'zh-cn' ? '侧边打开' : 'Open to side',
                details: i18n.getLanguage() === 'zh-cn' ? '详情' : 'Details',
                loading: i18n.get('entityReferencesLoading'), missing: i18n.get('entityReferencesMissing'),
                partial: i18n.getLanguage() === 'zh-cn' ? '部分结果' : 'Partial results',
                finding: i18n.getLanguage() === 'zh-cn' ? '已找到 {0} 处，仍在查找…' : 'Locations found: {0}. Still searching…',
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
        const { boundedIndexPage, assertIndexPayload } = require('../shared/indexPages');
        const records: any[] = boundedIndexPage([...state.definitions, ...state.references],
            { ...state, definitions: [], references: [] });
        const definitions = records.filter(row => row.role === 'definition');
        const references = records.filter(row => row.role === 'reference');
        state.hasMoreDefinitions ||= definitions.length < state.definitions.length;
        state.hasMoreReferences ||= references.length < state.references.length;
        state.definitions = definitions; state.references = references;
        if (retainBaseRevision !== undefined) state.retainResults = { baseRevision: retainBaseRevision };
        if (active) this.visibleCounts.set(active.key, page ? { ...counts,
            [page.role]: page.start + (page.role === 'definition' ? definitions.length : references.length) }
            : retainBaseRevision !== undefined ? {
                definition: Math.max(previousCounts.definition, definitions.length),
                reference: Math.max(previousCounts.reference, references.length),
            } : { definition: definitions.length, reference: references.length });
        return assertIndexPayload(state);
    }

    private publish(page?: { baseRevision: number; role: 'definition' | 'reference'; start: number }): void {
        const active = this.model.getActiveSession?.();
        const retain = !page && active?.page?.revision && this.visibleQueryRevision === active.page.revision &&
            this.visibleQueryKey === active.key && ['ready', 'partial'].includes(active.state);
        const baseRevision = this.revision;
        if (!page && !retain) this.visibleCounts.clear();
        this.visibleQueryRevision = active?.page?.revision; this.visibleQueryKey = active?.key;
        this.revision++;
        if (this.view) {
            const project = active ? active.identity.scope.kind === 'project' : this.input.scopePreference === 'project';
            this.view.description = i18n.get(project ? 'keywordIndexScopeProject' : 'keywordIndexScopeCurrentFile');
        }
        void vscode.commands.executeCommand('setContext', 'lsdynaEntityReferences.pinned', !!active?.pinned);
        void vscode.commands.executeCommand('setContext', 'lsdynaEntityReferences.following', this.following && !active?.pinned);
        void vscode.commands.executeCommand('setContext', 'lsdynaEntityReferences.scope', active
            ? active.identity.scope.kind === 'project' ? 'project' : 'file'
            : this.input.scopePreference);
        if (this.participant) {
            this.messenger.sendNotification(EntityReferencesStateChangedNotification,
                this.participant, this.viewState(page, retain ? baseRevision : undefined));
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
        const csp = `default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}'`;
        return `<!doctype html><html lang="${i18n.getLanguage() === 'zh-cn' ? 'zh' : 'en'}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body><div id="root"></div><script nonce="${nonce}" type="module" src="${resource(entry.file)}"></script></body></html>`;
    }
}
