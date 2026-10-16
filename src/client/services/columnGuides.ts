import * as vscode from 'vscode';

/** Visible-column guides; never scan or pad the document itself. */
export function createColumnGuideController(): vscode.Disposable {
    const ordinary = new vscode.ThemeColor('lsdyna.columnGuide');
    const edge = new vscode.ThemeColor('lsdyna.columnGuide80');
    const guides = vscode.window.createTextEditorDecorationType({});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
        timer = undefined;
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.languageId !== 'lsdyna') continue;
            const options: vscode.DecorationOptions[] = [];
            const seen = new Set<number>();
            for (const visible of editor.visibleRanges) {
                for (let line = visible.start.line; line <= Math.min(visible.end.line, editor.document.lineCount - 1); line++) {
                    if (seen.has(line)) continue;
                    seen.add(line);
                    const text = editor.document.lineAt(line).text;
                    // Tabs and non-ASCII cells do not have a reliable character-to-column mapping.
                    if (/[^\x20-\x7e]/.test(text.slice(0, 80))) continue;
                    for (let column = 10; column <= Math.min(80, text.length); column += 10) {
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
    const schedule = () => { if (timer === undefined) timer = setTimeout(refresh, 50); };
    const subscriptions = [
        vscode.window.onDidChangeVisibleTextEditors(schedule),
        vscode.window.onDidChangeTextEditorVisibleRanges(schedule),
        vscode.workspace.onDidChangeTextDocument(schedule),
    ];
    schedule();
    return { dispose() { if (timer !== undefined) clearTimeout(timer); subscriptions.forEach(s => s.dispose()); guides.dispose(); } };
}
