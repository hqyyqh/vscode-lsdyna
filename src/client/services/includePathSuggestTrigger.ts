'use strict';

/**
 * @fileoverview On-type triggerSuggest for *INCLUDE bare filename search (Mode A cold start).
 * @module client/services/includePathSuggestTrigger
 *
 * lsdyna keeps editor.quickSuggestions.other=false, so typing letters does not open
 * the suggest widget. On include filename cards only, debounce and fire
 * editor.action.triggerSuggest without requiring Ctrl+Space.
 */

export type IncludePathSuggestTriggerDeps = {
    /** Return true when cursor is on an *INCLUDE filename card. */
    isIncludeFilenameContext: (document: any, position: any) => boolean;
    /** Optional: skip when suggest already visible (if host can report it). */
    isSuggestVisible?: () => boolean;
    executeCommand: (command: string, ...args: any[]) => Thenable<any> | any;
    getActiveEditor: () => { document: any; selection: { active: any } } | undefined | null;
    isLsdynaDocument?: (document: any) => boolean;
    schedule?: (fn: () => void, ms: number) => any;
    cancel?: (handle: any) => void;
    debounceMs?: number;
};

/**
 * True only for one ordinary path/name character typed at one cursor. Paste,
 * multi-cursor batches and replacements stay quiet.
 */
export function changeLooksLikeIncludePathTyping(contentChanges: Array<{ text?: string; rangeLength?: number }>): boolean {
    if (!contentChanges || contentChanges.length !== 1) return false;
    if (
        Number.isFinite(contentChanges[0]?.rangeLength) &&
        Number(contentChanges[0].rangeLength) !== 0
    ) return false;
    const text = contentChanges[0]?.text != null ? String(contentChanges[0].text) : '';
    return /^[A-Za-z0-9._\-\\/]$/.test(text);
}

export function effectiveIncludePathPrefixLength(document: any, position: any): number {
    try {
        const lineText = String(document.lineAt(position.line).text || '');
        const beforeCursor = lineText.slice(0, Math.max(0, position.character));
        const currentToken = beforeCursor.match(/[A-Za-z0-9._\-\\/]+$/)?.[0] || '';
        return (currentToken.match(/[A-Za-z0-9._-]/g) || []).length;
    } catch (_error) {
        return 0;
    }
}

/**
 * Create a document-change handler that triggers include path suggest on type.
 */
export function createIncludePathSuggestTrigger(deps: IncludePathSuggestTriggerDeps) {
    const schedule = deps.schedule || setTimeout;
    const cancel = deps.cancel || clearTimeout;
    const debounceMs = deps.debounceMs != null ? deps.debounceMs : 100;
    let timer: any = null;

    function dispose() {
        if (timer != null) {
            cancel(timer);
            timer = null;
        }
    }

    function onDidChangeTextDocument(event: {
        document: any;
        contentChanges?: Array<{ text?: string; rangeLength?: number }>;
    }) {
        if (!event || !event.document) return;
        if (deps.isLsdynaDocument && !deps.isLsdynaDocument(event.document)) return;
        if (!changeLooksLikeIncludePathTyping(event.contentChanges || [])) return;

        const editor = deps.getActiveEditor();
        if (!editor || editor.document !== event.document) return;

        const position = editor.selection && editor.selection.active;
        if (!position) return;
        if (!deps.isIncludeFilenameContext(event.document, position)) return;
        if (effectiveIncludePathPrefixLength(event.document, position) < 2) return;
        if (deps.isSuggestVisible && deps.isSuggestVisible()) return;

        dispose();
        timer = schedule(() => {
            timer = null;
            const active = deps.getActiveEditor();
            if (!active || active.document !== event.document) return;
            const pos = active.selection && active.selection.active;
            if (!pos || !deps.isIncludeFilenameContext(active.document, pos)) return;
            if (effectiveIncludePathPrefixLength(active.document, pos) < 2) return;
            if (deps.isSuggestVisible && deps.isSuggestVisible()) return;
            try {
                deps.executeCommand('editor.action.triggerSuggest');
            } catch (_e) {
                // ignore command failures in tests / missing host
            }
        }, debounceMs);
    }

    return { onDidChangeTextDocument, dispose };
}

module.exports = {
    changeLooksLikeIncludePathTyping,
    effectiveIncludePathPrefixLength,
    createIncludePathSuggestTrigger,
};

export {};
