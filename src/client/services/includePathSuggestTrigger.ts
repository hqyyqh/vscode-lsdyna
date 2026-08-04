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
 * True when a text change looks like typing path/name characters (not pure delete).
 */
export function changeLooksLikeIncludePathTyping(contentChanges: Array<{ text?: string }>): boolean {
    if (!contentChanges || !contentChanges.length) return false;
    for (const ch of contentChanges) {
        const t = ch && ch.text != null ? String(ch.text) : '';
        if (!t) continue;
        // Allow path-ish inserts; ignore pure newlines-only (new card line still ok if user types later)
        if (/[A-Za-z0-9._\-\\/]/.test(t)) return true;
    }
    return false;
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
        contentChanges?: Array<{ text?: string }>;
    }) {
        if (!event || !event.document) return;
        if (deps.isLsdynaDocument && !deps.isLsdynaDocument(event.document)) return;
        if (!changeLooksLikeIncludePathTyping(event.contentChanges || [])) return;

        const editor = deps.getActiveEditor();
        if (!editor || editor.document !== event.document) return;

        const position = editor.selection && editor.selection.active;
        if (!position) return;
        if (!deps.isIncludeFilenameContext(event.document, position)) return;
        if (deps.isSuggestVisible && deps.isSuggestVisible()) return;

        dispose();
        timer = schedule(() => {
            timer = null;
            const active = deps.getActiveEditor();
            if (!active || active.document !== event.document) return;
            const pos = active.selection && active.selection.active;
            if (!pos || !deps.isIncludeFilenameContext(active.document, pos)) return;
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
    createIncludePathSuggestTrigger,
};

export {};
