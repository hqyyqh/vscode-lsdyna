'use strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { displayPathLabels } from './displayPathLabels';
import { Messenger } from 'vscode-messenger';
import type { WebviewIdMessageParticipant } from 'vscode-messenger-common';
import {
    KeywordOptionsApplyRequest,
    KeywordOptionsReadyRequest,
    KeywordOptionsResetRequest,
    KeywordOptionsSelectDimensionRequest,
    KeywordOptionsSelectPostCountRequest,
    KeywordOptionsSelectTargetRequest,
    KeywordManagerSelectFieldRequest,
    KeywordManagerSelectFormRequest,
    KeywordManagerUpdateControlRequest,
    KeywordManagerSelectScopeRequest,
    KeywordManagerLocateSourceRequest,
    KeywordManagerOpenManualRequest,
    KeywordManagerSelectInstanceRequest,
    KeywordManagerUpdateFieldRequest,
    KeywordOptionsStateChangedNotification,
    KeywordOptionsTogglePinRequest,
    type KeywordOptionsMutationResult,
    type KeywordOptionsViewState,
    type KeywordManagerHelpRequest,
    type KeywordManagerHelpState,
} from './keywordOptionsProtocol';

export type KeywordOptionsWebviewActions = {
    selectDimension: (dimensionId: string, values: string[]) => boolean | Promise<boolean>;
    selectTarget: (targetKeyword: string) => boolean | Promise<boolean>;
    selectPostCount: (targetPostCount: number) => boolean | Promise<boolean>;
    updateControl: (controlId: string, value: string | boolean) => boolean | Promise<boolean>;
    selectForm: (ruleId: string) => boolean | Promise<boolean>;
    selectInstance: (instanceId: string) => boolean | Promise<boolean>;
    selectField: (request: KeywordManagerHelpRequest) => KeywordManagerHelpState | null;
    updateField: (fieldId: string, value: string) => boolean | Promise<boolean>;
    selectScope: (scope: 'file' | 'project') => boolean | Promise<boolean>;
    locateSource: () => boolean | Promise<boolean>;
    openManual: (conditionId?: string, evidenceId?: string) => boolean | Promise<boolean>;
    panelDisposed?: () => void;
    apply: () => boolean | Promise<boolean>;
    reset: () => boolean | Promise<boolean>;
    togglePin: () => boolean | Promise<boolean>;
};

export class KeywordOptionsWebviewProvider implements vscode.Disposable {
    private readonly messenger = new Messenger();
    private participant: WebviewIdMessageParticipant | undefined;
    private panel: vscode.WebviewPanel | undefined;
    private handlers: vscode.Disposable[] = [];
    private state: KeywordOptionsViewState;
    private mutationPending = false;
    private pathSetKey = '';
    private pathLabels = new Map<string, string>();

    private withDisplayPaths<T extends Omit<KeywordOptionsViewState, 'revision'>>(state: T): T {
        const paths = [...new Set(state.instances.flatMap(instance => instance.filePath ? [instance.filePath] : []))].sort();
        const key = JSON.stringify(paths);
        if (key !== this.pathSetKey) {
            this.pathLabels = displayPathLabels(paths);
            this.pathSetKey = key;
        }
        return { ...state, instances: state.instances.map(instance => ({ ...instance,
            displayPath: instance.filePath ? this.pathLabels.get(instance.filePath) : undefined,
        })) };
    }

    constructor(
        private readonly extensionRoot: string,
        private readonly actions: KeywordOptionsWebviewActions,
        initialState: KeywordOptionsViewState,
    ) {
        this.state = this.withDisplayPaths(initialState);
    }

    showPanel(title: string): vscode.WebviewPanel {
        if (this.panel) {
            this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside);
            return this.panel;
        }
        const dist = path.join(this.extensionRoot, 'out', 'webview', 'keyword-options');
        const panel = vscode.window.createWebviewPanel(
            'lsdynaKeywordManager',
            title,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: false,
                localResourceRoots: [vscode.Uri.file(dist)],
            },
        );
        this.panel = panel;
        const participant = this.messenger.registerWebviewPanel(panel);
        this.participant = participant;
        this.registerHandlers(participant);
        panel.onDidDispose(() => {
            this.actions.panelDisposed?.();
            this.detach(participant);
            if (this.panel === panel) this.panel = undefined;
        });
        panel.webview.html = this.html(panel.webview, dist);
        return panel;
    }

    publish(next: Omit<KeywordOptionsViewState, 'revision'> | KeywordOptionsViewState): KeywordOptionsViewState {
        this.state = { ...this.withDisplayPaths(next), revision: this.state.revision + 1 };
        if (this.participant) {
            this.messenger.sendNotification(KeywordOptionsStateChangedNotification, this.participant, this.state);
        }
        return this.state;
    }

    getState(): KeywordOptionsViewState { return this.state; }

    publishInstances(instances: KeywordOptionsViewState['instances'], directoryStatus: KeywordOptionsViewState['directoryStatus']): void {
        // Directory completion does not change the edit plan or invalidate in-flight edits.
        this.state = this.withDisplayPaths({ ...this.state, instances, directoryStatus });
        if (this.participant) this.messenger.sendNotification(KeywordOptionsStateChangedNotification, this.participant, this.state);
    }

    isOpen(): boolean { return !!this.panel; }

    dispose(): void {
        this.detach(this.participant);
        this.panel?.dispose();
        this.panel = undefined;
    }

    private accepts(revision: number): boolean {
        return Number.isFinite(revision) && revision === this.state.revision;
    }

    private async mutate(
        revision: number,
        action: () => boolean | Promise<boolean>,
        applying = false,
    ): Promise<KeywordOptionsMutationResult> {
        if (this.mutationPending) {
            return { accepted: false, state: this.state, reason: 'mutation-in-progress' };
        }
        if (!this.accepts(revision)) {
            return { accepted: false, state: this.state, reason: 'stale-revision' };
        }
        const before = this.state;
        this.mutationPending = true;
        try {
            if (applying) this.publish({ ...before, status: 'applying', canApply: false });
            const accepted = !!(await action());
            if (applying && this.state.status === 'applying') this.publish({ ...before,
                instances: this.state.instances, directoryStatus: this.state.directoryStatus });
            return {
                accepted,
                state: this.state,
                ...(accepted ? {} : { reason: 'action-rejected' }),
            };
        } catch (error) {
            if (applying && this.state.status === 'applying') this.publish({ ...before,
                instances: this.state.instances, directoryStatus: this.state.directoryStatus });
            return {
                accepted: false,
                state: this.state,
                reason: error instanceof Error ? error.message : String(error),
            };
        } finally {
            this.mutationPending = false;
        }
    }

    private registerHandlers(participant: WebviewIdMessageParticipant): void {
        const sender = { sender: participant };
        this.handlers = [
            this.messenger.onRequest(KeywordOptionsReadyRequest, () => this.state, sender),
            this.messenger.onRequest(KeywordOptionsSelectDimensionRequest, request =>
                this.mutate(request.revision, () => this.actions.selectDimension(request.dimensionId, request.values)), sender),
            this.messenger.onRequest(KeywordOptionsSelectTargetRequest, request =>
                this.mutate(request.revision, () => this.actions.selectTarget(request.targetKeyword)), sender),
            this.messenger.onRequest(KeywordOptionsSelectPostCountRequest, request =>
                this.mutate(request.revision, () => this.actions.selectPostCount(request.targetPostCount)), sender),
            this.messenger.onRequest(KeywordManagerUpdateControlRequest, request =>
                this.mutate(request.revision, () => this.actions.updateControl(request.controlId, request.value)), sender),
            this.messenger.onRequest(KeywordManagerSelectFormRequest, request =>
                this.mutate(request.revision, () => this.actions.selectForm(request.ruleId)), sender),
            this.messenger.onRequest(KeywordManagerSelectInstanceRequest, request =>
                this.mutate(request.revision, () => this.actions.selectInstance(request.instanceId)), sender),
            this.messenger.onRequest(KeywordManagerSelectFieldRequest, request =>
                {
                    if (!this.accepts(request.revision)) return { ...request, accepted: false, reason: 'stale-revision' };
                    if (request.instanceId !== this.state.selectedInstanceId) return { ...request, accepted: false, reason: 'stale-instance' };
                    const help = this.actions.selectField(request);
                    return help ? { ...request, accepted: true, help }
                        : { ...request, accepted: false, reason: 'stale-context' };
                }, sender),
            this.messenger.onRequest(KeywordManagerUpdateFieldRequest, request =>
                this.mutate(request.revision, () => this.actions.updateField(request.fieldId, request.value)), sender),
            this.messenger.onRequest(KeywordManagerSelectScopeRequest, request =>
                this.mutate(request.revision, () => this.actions.selectScope(request.scope)), sender),
            this.messenger.onRequest(KeywordManagerLocateSourceRequest, request =>
                this.accepts(request.revision) && this.actions.locateSource(), sender),
            this.messenger.onRequest(KeywordManagerOpenManualRequest, request =>
                this.accepts(request.revision) &&
                (request.conditionId === undefined || typeof request.conditionId === 'string') &&
                (request.evidenceId === undefined || typeof request.evidenceId === 'string') &&
                this.actions.openManual(request.conditionId, request.evidenceId), sender),
            this.messenger.onRequest(KeywordOptionsApplyRequest, request =>
                this.mutate(request.revision, () => this.actions.apply(), true), sender),
            this.messenger.onRequest(KeywordOptionsResetRequest, request =>
                this.mutate(request.revision, () => this.actions.reset()), sender),
            this.messenger.onRequest(KeywordOptionsTogglePinRequest, request =>
                this.mutate(request.revision, () => this.actions.togglePin()), sender),
        ];
    }

    private detach(participant: WebviewIdMessageParticipant | undefined): void {
        if (!participant) return;
        for (const handler of this.handlers.splice(0)) handler.dispose();
        if (this.participant?.webviewId === participant.webviewId) this.participant = undefined;
    }

    private html(webview: vscode.Webview, dist: string): string {
        const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
        const entry = manifest['index.html'];
        const script = webview.asWebviewUri(vscode.Uri.file(path.join(dist, entry.file)));
        const css = (entry.css || []).map((file: string) =>
            `<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.file(path.join(dist, file)))}">`).join('');
        const nonce = Math.random().toString(36).slice(2);
        const csp = `default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'`;
        return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width,initial-scale=1">${css}</head><body><div id="root"></div><script nonce="${nonce}" type="module" src="${script}"></script></body></html>`;
    }
}
