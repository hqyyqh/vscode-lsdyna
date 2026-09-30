import * as vscode from 'vscode';
const { collectBlocksFromLineReaderAsync } = require('../../core/parser/blockScanner');

/** Automatic checks are bounded; manual checks can target a block in a larger file. */
export function createKeywordStructureDiagnostics({ collection, analyze, describe, isSupported,
    debounceMs = 350, maximumLines = 20000, maximumBlocks = 200,
}: { collection: vscode.DiagnosticCollection; analyze: (...args: any[]) => any;
    describe: (analysis: any) => string; isSupported: (document: any) => boolean;
    debounceMs?: number; maximumLines?: number; maximumBlocks?: number }) {
    const pending = new Map<any, { timer?: ReturnType<typeof setTimeout>; generation: number }>();
    const published = new Map<string, Map<number, vscode.Diagnostic>>();
    let disposed = false;

    function diagnostic(document, line, analysis) {
        if (analysis?.status !== 'definite-error' || analysis.mappingAmbiguous === true) return null;
        const item = new vscode.Diagnostic(new vscode.Range(line, 0, line, document.lineAt(line).text.length),
            describe(analysis), vscode.DiagnosticSeverity.Error);
        item.source = 'DynaSense structure';
        item.code = 'keyword-structure';
        return item;
    }
    function clear(document) {
        const old = pending.get(document);
        if (old?.timer) clearTimeout(old.timer);
        pending.delete(document);
        published.delete(document.uri.toString());
        collection.delete(document.uri);
    }
    async function run(document, state) {
        const version = state.generation;
        const current = () => !disposed && !document.isClosed && document.version === version && pending.get(document) === state;
        if (!current() || !isSupported(document) || document.lineCount > maximumLines) return;
        let characters = 0, oversized = false;
        const blocks = await collectBlocksFromLineReaderAsync(document.lineCount, line => {
            if (oversized) return '';
            const text = document.lineAt(line).text;
            characters += text.length;
            oversized = text.length > 65536 || characters > 2 * 1024 * 1024;
            return oversized ? '' : text;
        }, { shouldCancel: () => !current() || oversized, yieldInterval: 256 });
        if (!blocks || !current() || oversized || blocks.length > maximumBlocks) return;
        const results = new Map<number, vscode.Diagnostic>();
        for (const block of blocks) {
            if (!current()) return;
            if (block.opaqueKind) continue;
            const analysis = analyze(document, block.startLine, { expectedDocumentVersion: version, maximumPhysicalLines: 256 });
            if (!current()) return;
            const item = diagnostic(document, block.startLine, analysis);
            if (item) results.set(block.startLine, item);
            await new Promise(resolve => setImmediate(resolve));
        }
        if (current()) {
            published.set(document.uri.toString(), results);
            collection.set(document.uri, [...results.values()]);
        }
    }
    function schedule(document) {
        clear(document); // A changed document must not retain old coordinates/errors.
        if (disposed || document.isClosed || !isSupported(document) || document.lineCount > maximumLines) return;
        const state = { generation: document.version, timer: undefined as ReturnType<typeof setTimeout> | undefined };
        pending.set(document, state);
        state.timer = setTimeout(() => {
            state.timer = undefined;
            void run(document, state).catch(() => { if (pending.get(document) === state) clear(document); });
        }, debounceMs);
    }
    function publishManual(document, keywordLine, analysis, version) {
        if (disposed || document.isClosed || document.version !== version) return;
        const state = pending.get(document);
        if (state?.timer) clearTimeout(state.timer);
        pending.delete(document); // Cancel an automatic run that could overwrite this result.
        const key = document.uri.toString(), results = published.get(key) || new Map();
        const item = diagnostic(document, keywordLine, analysis);
        if (item) results.set(keywordLine, item); else results.delete(keywordLine);
        published.set(key, results);
        collection.set(document.uri, [...results.values()]);
    }
    return { schedule, clear, publishManual, dispose() {
        disposed = true;
        for (const state of pending.values()) if (state.timer) clearTimeout(state.timer);
        pending.clear(); published.clear(); collection.clear();
    } };
}
