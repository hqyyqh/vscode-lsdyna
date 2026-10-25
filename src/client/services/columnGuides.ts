import * as vscode from 'vscode';

/** Visible-column guides; never scan or pad the document itself. */
export function createColumnGuideController(boundaries: (document: vscode.TextDocument, line: number) => number[],
    prepare: (document: vscode.TextDocument) => Promise<boolean> = async () => true): vscode.Disposable & { scheduleRefresh(): void } {
    const ordinary = new vscode.ThemeColor('lsdyna.columnGuide');
    const edge = new vscode.ThemeColor('lsdyna.columnGuide80');
    const guides = vscode.window.createTextEditorDecorationType({});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let generation = 0;
    const refresh = async () => {
        timer = undefined;
        const current = generation;
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.languageId !== 'lsdyna') continue;
            const options: vscode.DecorationOptions[] = [];
            if (!vscode.workspace.getConfiguration('lsdyna', editor.document.uri).get('columnGuides.enabled', true)) {
                editor.setDecorations(guides, options); continue;
            }
            const version = editor.document.version;
            let prepared = false;
            try { prepared = await prepare(editor.document); } catch { /* Unverified layout: clear old guides. */ }
            if (disposed || current !== generation || editor.document.isClosed || editor.document.version !== version) continue;
            if (!prepared) { editor.setDecorations(guides, options); continue; }
            const seen = new Set<number>();
            for (const visible of editor.visibleRanges) {
                for (let line = visible.start.line; line <= Math.min(visible.end.line, editor.document.lineCount - 1); line++) {
                    if (seen.has(line)) continue;
                    seen.add(line);
                    const text = editor.document.lineAt(line).text;
                    // Tabs and non-ASCII cells do not have a reliable character-to-column mapping.
                    if (/^\s*[$*]/.test(text) || /[^\x20-\x7e]/.test(text)) continue;
                    for (const column of boundaries(editor.document, line)) {
                        if (!Number.isInteger(column) || column <= 0 || column > text.length) continue;
                        options.push({ range: new vscode.Range(line, column, line, column), renderOptions: {
                            // The glyph's stroke is centred in its cell; align it with the ruler at the cell boundary.
                            before: { contentText: '│', width: '0px', margin: '0 0.5ch 0 -0.5ch',
                                color: column === 80 ? edge : ordinary },
                        } });
                    }
                }
            }
            editor.setDecorations(guides, options);
        }
    };
    const schedule = () => { generation++; if (timer === undefined) timer = setTimeout(refresh, 50); };
    const subscriptions = [
        vscode.window.onDidChangeVisibleTextEditors(schedule),
        vscode.window.onDidChangeTextEditorVisibleRanges(schedule),
        vscode.workspace.onDidChangeTextDocument(schedule),
        vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('lsdyna.columnGuides.enabled')) schedule(); }),
    ];
    schedule();
    return { scheduleRefresh: schedule, dispose() { disposed = true; if (timer !== undefined) clearTimeout(timer); subscriptions.forEach(s => s.dispose()); guides.dispose(); } };
}
