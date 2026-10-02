'use strict';

/**
 * VS Code wiring for session change marks (no-Git).
 * @module client/changeMarks/changeMarksController
 */

const { createChangeMarksSessionStore } = require('./changeMarksSession');
const { createChangeMarksRenderer } = require('./changeMarksRenderer');
const { orderedMarkLines } = require('./changeMarksDiff');
const { emptyChangeMarks } = require('./types');
const { DEFAULT_CHANGE_MARKS_CUSTOM_COLORS } = require('../../core/theme/extensionTheme');
import type {
    ChangeMarksConfig,
    ChangeMarksDiffResult,
    ChangeMarksSessionSnapshot,
    ChangeMarkVisualKind,
} from './types';

export type ChangeMarksControllerDeps = {
    vscode: any;
    isLsdynaDocument: (document: any) => boolean;
    getConfig: (resource?: any) => ChangeMarksConfig;
    /** Optional toast / i18n messages */
    showMessage?: (message: string) => void;
    getMessage?: (key: string, ...args: any[]) => string;
    /** Injectable clock for deterministic lifecycle tests. */
    now?: () => number;
};

const SCHEME = 'lsdyna-change-marks';
const SAVE_AS_CANDIDATE_TTL_MS = 10_000;

type SaveAsSource = {
    key: string;
    currentText: string;
    snapshot: ChangeMarksSessionSnapshot;
    capturedAt: number;
};

type SaveAsCandidate = {
    source: SaveAsSource;
    targetTextAtAssociation: string;
    createdAt: number;
};

/**
 * Keep the session-store URI key opaque while it travels through a VS Code
 * virtual-document URI. Query strings and Uri.parse both perform escaping, so
 * passing the key with encodeURIComponent changes Windows drive letters,
 * spaces, and literal plus signs before the content provider sees it.
 */
function encodeDiffDocumentKey(uriString: string): string {
    return Buffer.from(uriString, 'utf8').toString('base64url');
}

function decodeDiffDocumentKey(encoded: string): string | null {
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    try {
        const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
        return encodeDiffDocumentKey(decoded) === encoded ? decoded : null;
    } catch {
        return null;
    }
}

const HOVER_I18N_KEYS: Record<ChangeMarkVisualKind, string> = {
    unsavedModified: 'changeMarksHoverUnsavedModified',
    unsavedInserted: 'changeMarksHoverUnsavedInserted',
    unsavedDeleted: 'changeMarksHoverUnsavedDeleted',
    savedModified: 'changeMarksHoverSavedModified',
    savedInserted: 'changeMarksHoverSavedInserted',
    savedDeleted: 'changeMarksHoverSavedDeleted',
};

function defaultConfig(): ChangeMarksConfig {
    return {
        enabled: true,
        colorScheme: 'adaptive',
        customUnsavedColor: DEFAULT_CHANGE_MARKS_CUSTOM_COLORS.unsaved,
        customSavedColor: DEFAULT_CHANGE_MARKS_CUSTOM_COLORS.saved,
        maxLineCount: 100000,
        debounceMs: 250,
        showOverviewRuler: true,
        showLineBackground: true,
        showMinimap: true,
    };
}

export function createChangeMarksController(deps: ChangeMarksControllerDeps) {
    const vscode = deps.vscode;
    const store = createChangeMarksSessionStore();
    let renderer = buildRenderer();
    const timers = new Map(); // uri -> timeout
    const disposables: { dispose: () => void }[] = [];
    const recentlyCreated = new Map<string, number>();
    const saveAsCandidates = new Map<string, SaveAsCandidate>();
    let activeDocument: any = vscode.window.activeTextEditor?.document || null;
    let recentlyClosedSource: SaveAsSource | null = null;

    function buildRenderer() {
        const c = cfg();
        return createChangeMarksRenderer(vscode, {
            colorScheme: c.colorScheme,
            customUnsavedColor: c.customUnsavedColor,
            customSavedColor: c.customSavedColor,
            showOverviewRuler: c.showOverviewRuler,
            showLineBackground: c.showLineBackground,
            showMinimap: c.showMinimap,
            getHoverMessage: (kind: ChangeMarkVisualKind) => {
                const key = HOVER_I18N_KEYS[kind];
                return deps.getMessage?.(key) || '';
            },
        });
    }

    function cfg(resource?: any): ChangeMarksConfig {
        try {
            return { ...defaultConfig(), ...deps.getConfig(resource) };
        } catch {
            return defaultConfig();
        }
    }

    function uriKey(document: any): string {
        const uri = document?.uri;
        if (!uri) return '';
        if (typeof uri.toString === 'function') {
            try {
                return String(uri.toString());
            } catch {
                // fall through
            }
        }
        if (uri.fsPath != null) return String(uri.fsPath);
        return String(uri);
    }

    function keyFromUri(uri: any): string {
        return uriKey(uri ? { uri } : null);
    }

    function now(): number {
        try {
            return Number(deps.now?.()) || Date.now();
        } catch {
            return Date.now();
        }
    }

    function isFresh(timestamp: number): boolean {
        return timestamp > 0 && now() - timestamp <= SAVE_AS_CANDIDATE_TTL_MS;
    }

    function pruneSaveAsState() {
        for (const [key, candidate] of saveAsCandidates) {
            if (!isFresh(candidate.createdAt)) saveAsCandidates.delete(key);
        }
        for (const [key, timestamp] of recentlyCreated) {
            if (!isFresh(timestamp)) recentlyCreated.delete(key);
        }
        if (recentlyClosedSource && !isFresh(recentlyClosedSource.capturedAt)) {
            recentlyClosedSource = null;
        }
    }

    /** Safe document text; incomplete stubs must not crash activation. */
    function safeGetText(document: any): string | null {
        if (!document || typeof document.getText !== 'function') return null;
        try {
            const text = document.getText();
            return text == null ? '' : String(text);
        } catch {
            return null;
        }
    }

    function isEligible(document: any): boolean {
        if (!document) return false;
        if (typeof document.getText !== 'function') return false;
        if (!deps.isLsdynaDocument(document)) return false;
        const c = cfg(document.uri);
        if (!c.enabled) return false;
        const lineCount = Number(document.lineCount);
        if (Number.isFinite(lineCount) && lineCount > c.maxLineCount) return false;
        return true;
    }

    function captureSource(document: any): SaveAsSource | null {
        if (!document || !isEligible(document)) return null;
        const key = uriKey(document);
        const currentText = safeGetText(document);
        if (!key || currentText == null) return null;
        ensureSession(document);
        store.applyCurrent(key, currentText);
        const snapshot = store.snapshot(key);
        if (!snapshot) {
            if (recentlyClosedSource?.key === key && isFresh(recentlyClosedSource.capturedAt)) {
                return recentlyClosedSource;
            }
            return null;
        }
        return { key, currentText, snapshot, capturedAt: now() };
    }

    function considerSaveAsTarget(targetDocument: any, sourceDocument?: any) {
        pruneSaveAsState();
        if (!targetDocument || !isEligible(targetDocument)) return;
        const targetKey = uriKey(targetDocument);
        if (!targetKey) return;
        if (store.get(targetKey) && !saveAsCandidates.has(targetKey)) return;

        let source = captureSource(sourceDocument);
        if (!source && recentlyClosedSource && isFresh(recentlyClosedSource.capturedAt)) {
            source = recentlyClosedSource;
        }
        if (!source || source.key === targetKey) return;

        const targetText = safeGetText(targetDocument);
        const existing = saveAsCandidates.get(targetKey);
        if (
            existing
            && isFresh(existing.createdAt)
            && existing.source.key === source.key
        ) {
            return;
        }
        saveAsCandidates.set(targetKey, {
            source,
            targetTextAtAssociation: targetText == null ? '' : targetText,
            createdAt: now(),
        });
    }

    function onDidChangeActiveEditor(editor: any) {
        const nextDocument = editor?.document || null;
        if (nextDocument && uriKey(nextDocument) !== uriKey(activeDocument)) {
            considerSaveAsTarget(nextDocument, activeDocument);
        }
        activeDocument = nextDocument;
    }

    function ensureSession(document: any) {
        if (!isEligible(document)) return null;
        const key = uriKey(document);
        if (!key) return null;
        let rec = store.get(key);
        if (!rec) {
            const text = safeGetText(document);
            if (text == null) return null;
            rec = store.open(key, text);
        }
        return rec;
    }

    function paintDocument(document: any, marks: ChangeMarksDiffResult | null) {
        if (!document) return;
        const m = marks || emptyChangeMarks();
        const key = uriKey(document);
        for (const editor of vscode.window.visibleTextEditors || []) {
            if (uriKey(editor?.document) !== key || !key) continue;
            if (!isEligible(document)) {
                renderer.clear(editor);
            } else {
                renderer.apply(editor, m);
            }
        }
    }

    function recomputeNow(document: any) {
        if (!document) return;
        if (!isEligible(document)) {
            const key = uriKey(document);
            if (key) store.close(key);
            paintDocument(document, emptyChangeMarks());
            return;
        }
        ensureSession(document);
        const text = safeGetText(document);
        if (text == null) return;
        const marks = store.applyCurrent(uriKey(document), text);
        paintDocument(document, marks);
    }

    function scheduleRecompute(document: any) {
        if (!document) return;
        const key = uriKey(document);
        if (!key) return;
        const c = cfg(document.uri);
        const prev = timers.get(key);
        if (prev) clearTimeout(prev);
        const handle = setTimeout(() => {
            timers.delete(key);
            recomputeNow(document);
        }, Math.max(0, c.debounceMs || 0));
        timers.set(key, handle);
    }

    function onDidOpen(document: any) {
        if (!isEligible(document)) return;
        const text = safeGetText(document);
        if (text == null) return;
        const key = uriKey(document);
        if (activeDocument && uriKey(activeDocument) !== key) {
            considerSaveAsTarget(document, activeDocument);
        } else if (!activeDocument && recentlyClosedSource) {
            considerSaveAsTarget(document, null);
        }
        store.open(key, text);
        paintDocument(document, emptyChangeMarks());
    }

    function onDidChange(document: any) {
        if (!document) return;
        if (!isEligible(document)) {
            const key = uriKey(document);
            if (key) store.close(key);
            paintDocument(document, emptyChangeMarks());
            return;
        }
        if (!store.get(uriKey(document))) {
            const text = safeGetText(document);
            if (text != null) store.open(uriKey(document), text);
        }
        scheduleRecompute(document);
    }

    function onDidSave(document: any) {
        if (!document || !isEligible(document)) return;
        const text = safeGetText(document);
        if (text == null) return;
        const key = uriKey(document);
        const observedCandidate = saveAsCandidates.get(key);
        pruneSaveAsState();
        const candidate = saveAsCandidates.get(key);
        const createdTimestamp = recentlyCreated.get(key) || 0;
        const targetWasPopulated = !!candidate && candidate.targetTextAtAssociation !== text;
        const hasSaveAsEvidence = isFresh(createdTimestamp) || targetWasPopulated;

        let marks: ChangeMarksDiffResult | null = null;
        if (
            candidate
            && isFresh(candidate.createdAt)
            && candidate.source.currentText === text
            && hasSaveAsEvidence
        ) {
            const branched = store.branch(candidate.source.snapshot, key, text);
            marks = branched?.marks || null;
        }
        if (!marks) {
            ensureSession(document);
            if (observedCandidate && observedCandidate.source.currentText === text) {
                // We saw a plausible lineage but could not prove it strongly enough
                // (for example, the lifecycle signal expired). Prefer a clean target
                // baseline over falsely presenting the whole copied file as inserted.
                marks = store.resetOrigin(key, text);
            } else {
                marks = store.save(key, text);
            }
        }
        saveAsCandidates.delete(key);
        recentlyCreated.delete(key);
        paintDocument(document, marks);
    }

    function onDidClose(document: any) {
        if (!document) return;
        const key = uriKey(document);
        const currentText = safeGetText(document);
        if (key && currentText != null && store.get(key)) {
            store.applyCurrent(key, currentText);
            const snapshot = store.snapshot(key);
            if (snapshot) {
                recentlyClosedSource = { key, currentText, snapshot, capturedAt: now() };
            }
        }
        const t = timers.get(key);
        if (t) {
            clearTimeout(t);
            timers.delete(key);
        }
        store.close(key);
        saveAsCandidates.delete(key);
        for (const editor of vscode.window.visibleTextEditors || []) {
            if (uriKey(editor?.document) === key && key) {
                renderer.clear(editor);
            }
        }
    }

    function refreshVisible() {
        for (const editor of vscode.window.visibleTextEditors || []) {
            const doc = editor.document;
            if (!doc || !deps.isLsdynaDocument(doc)) continue;
            if (!isEligible(doc)) {
                renderer.clear(editor);
                continue;
            }
            ensureSession(doc);
            const text = safeGetText(doc);
            if (text == null) {
                renderer.clear(editor);
                continue;
            }
            const marks = store.applyCurrent(uriKey(doc), text);
            renderer.apply(editor, marks || emptyChangeMarks());
        }
    }

    function getMarksForDocument(document: any): ChangeMarksDiffResult {
        if (!document || !isEligible(document)) return emptyChangeMarks();
        const rec = store.get(uriKey(document));
        if (!rec) return emptyChangeMarks();
        return rec.marks;
    }

    function jump(editor: any, direction: 1 | -1): boolean {
        if (!editor?.document) return false;
        const marks = getMarksForDocument(editor.document);
        const lines = orderedMarkLines(marks);
        if (lines.length === 0) return false;
        const cur = editor.selection?.active?.line ?? 0;
        let target: number | null = null;
        if (direction === 1) {
            target = lines.find(l => l > cur) ?? lines[0];
        } else {
            const before = lines.filter(l => l < cur);
            target = before.length ? before[before.length - 1] : lines[lines.length - 1];
        }
        if (target == null) return false;
        const pos = new vscode.Position(target, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType?.InCenterIfOutsideViewport);
        return true;
    }

    async function resetOrigin(editor: any): Promise<boolean> {
        const document = editor?.document;
        if (!document || !isEligible(document)) return false;
        ensureSession(document);
        const text = safeGetText(document);
        if (text == null) return false;
        const marks = store.resetOrigin(uriKey(document), text);
        paintDocument(document, marks);
        return true;
    }

    function getOriginText(uriString: string): string | null {
        const rec = store.get(uriString);
        return rec ? rec.originText : null;
    }

    function getSavePointText(uriString: string): string | null {
        const rec = store.get(uriString);
        return rec ? rec.savePointText : null;
    }

    const contentProvider = {
        provideTextDocumentContent(uri: any): string {
            try {
                const q = new URLSearchParams(uri.query || '');
                const kind = q.get('kind') || String(uri.path || '').replace(/^\//, '');
                const docUri = decodeDiffDocumentKey(q.get('doc64') || '');
                if (!docUri) return '';
                if (kind === 'origin' || String(uri.path || '').includes('origin')) {
                    return getOriginText(docUri) ?? '';
                }
                if (kind === 'savepoint' || String(uri.path || '').includes('savepoint')) {
                    return getSavePointText(docUri) ?? '';
                }
                return '';
            } catch {
                return '';
            }
        },
    };

    function rebuildRenderer() {
        try {
            renderer.dispose();
        } catch { /* ignore */ }
        renderer = buildRenderer();
        refreshVisible();
    }

    function register(context: { subscriptions: { dispose: () => void }[] }) {
        const sub = (d: { dispose: () => void }) => {
            disposables.push(d);
            context.subscriptions.push(d);
        };

        sub(vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider));

        sub(vscode.workspace.onDidOpenTextDocument((doc: any) => onDidOpen(doc)));
        sub(vscode.workspace.onDidChangeTextDocument((e: any) => {
            if (e?.document) onDidChange(e.document);
        }));
        sub(vscode.workspace.onDidSaveTextDocument((doc: any) => onDidSave(doc)));
        sub(vscode.workspace.onDidCloseTextDocument((doc: any) => onDidClose(doc)));
        if (typeof vscode.workspace.onDidCreateFiles === 'function') {
            sub(vscode.workspace.onDidCreateFiles((e: any) => {
                const timestamp = now();
                for (const uri of e?.files || []) {
                    const key = keyFromUri(uri);
                    if (key) recentlyCreated.set(key, timestamp);
                }
            }));
        }
        sub(vscode.window.onDidChangeVisibleTextEditors(() => refreshVisible()));
        if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
            sub(vscode.window.onDidChangeActiveTextEditor((editor: any) => onDidChangeActiveEditor(editor)));
        }
        // Gutter SVG fills are concrete hex from the active theme palette — rebuild on theme switch.
        if (typeof vscode.window.onDidChangeActiveColorTheme === 'function') {
            sub(vscode.window.onDidChangeActiveColorTheme(() => rebuildRenderer()));
        }
        sub(vscode.workspace.onDidChangeConfiguration((e: any) => {
            if (!e || typeof e.affectsConfiguration !== 'function') {
                refreshVisible();
                return;
            }
            if (
                e.affectsConfiguration('lsdyna.changeMarks')
                || e.affectsConfiguration('lsdyna.changeMarks.enabled')
                || e.affectsConfiguration('lsdyna.changeMarks.colorScheme')
                || e.affectsConfiguration('lsdyna.changeMarks.customUnsavedColor')
                || e.affectsConfiguration('lsdyna.changeMarks.customSavedColor')
                || e.affectsConfiguration('lsdyna.changeMarks.maxLineCount')
                || e.affectsConfiguration('lsdyna.changeMarks.showOverviewRuler')
                || e.affectsConfiguration('lsdyna.changeMarks.showLineBackground')
                || e.affectsConfiguration('lsdyna.changeMarks.showMinimap')
                || e.affectsConfiguration('workbench.colorCustomizations')
            ) {
                rebuildRenderer();
            }
        }));

        sub({
            dispose: () => {
                for (const t of timers.values()) clearTimeout(t);
                timers.clear();
                store.clearAll();
                recentlyCreated.clear();
                saveAsCandidates.clear();
                recentlyClosedSource = null;
                try {
                    renderer.dispose();
                } catch { /* ignore */ }
            },
        });

        for (const doc of vscode.workspace.textDocuments || []) {
            try {
                if (!isEligible(doc)) continue;
                const text = safeGetText(doc);
                const key = uriKey(doc);
                if (text == null || !key) continue;
                store.open(key, text);
            } catch {
                // ignore individual document seed failures
            }
        }
        try {
            refreshVisible();
        } catch {
            // ignore paint failures during activate
        }
    }

    async function showDiff(editor: any, kind: 'origin' | 'savepoint'): Promise<void> {
        const document = editor?.document;
        if (!document || !isEligible(document)) return;
        ensureSession(document);
        const text = safeGetText(document);
        if (text == null) return;
        store.applyCurrent(uriKey(document), text);
        const docUriStr = uriKey(document);
        if (!docUriStr) return;
        const title = kind === 'origin'
            ? (deps.getMessage?.('changeMarksDiffSinceOpened') || 'Since opened')
            : (deps.getMessage?.('changeMarksDiffUnsaved') || 'Unsaved changes');
        const encodedDocKey = encodeDiffDocumentKey(docUriStr);
        const left = vscode.Uri.parse(
            `${SCHEME}:${kind}?kind=${kind}&doc64=${encodedDocKey}`,
        );
        await vscode.commands.executeCommand(
            'vscode.diff',
            left,
            document.uri,
            title,
        );
    }

    return {
        register,
        recomputeNow,
        scheduleRecompute,
        jumpNext: (editor: any) => jump(editor, 1),
        jumpPrevious: (editor: any) => jump(editor, -1),
        resetOrigin,
        showDiffSinceOpened: (editor: any) => showDiff(editor, 'origin'),
        showDiffUnsaved: (editor: any) => showDiff(editor, 'savepoint'),
        getMarksForDocument,
        getStore: () => store,
        SCHEME,
        dispose: () => {
            for (const d of disposables) {
                try {
                    d.dispose();
                } catch { /* ignore */ }
            }
            disposables.length = 0;
        },
    };
}

module.exports = {
    createChangeMarksController,
    SCHEME,
};

export {};
