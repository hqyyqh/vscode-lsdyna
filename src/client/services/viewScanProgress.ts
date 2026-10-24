import * as vscode from 'vscode';

const scans = new Map<string, vscode.CancellationTokenSource>();

export function cancelViewScan(viewId: string) { scans.get(viewId)?.cancel(); }

/** Keep cancellation owned by the scan when its view is hidden or collapsed. */
export async function withViewScanProgress<T>(viewId: string, title: string,
    task: (progress: vscode.Progress<{ message?: string; increment?: number }>, token: vscode.CancellationToken) => Promise<T>): Promise<T> {
    cancelViewScan(viewId);
    const source = new vscode.CancellationTokenSource();
    scans.set(viewId, source);
    void vscode.commands.executeCommand('setContext', `${viewId}.scanRunning`, true);
    try {
        return await vscode.window.withProgress({ location: { viewId }, title }, progress => task(progress, source.token));
    } finally {
        if (scans.get(viewId) === source) {
            scans.delete(viewId);
            void vscode.commands.executeCommand('setContext', `${viewId}.scanRunning`, false);
        }
        source.dispose();
    }
}

export function registerViewScanCancellation(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.entityReferences.cancel', () => cancelViewScan('lsdynaEntityReferences')),
        vscode.commands.registerCommand('extension.cancelIncludeScan', () => cancelViewScan('lsdynaIncludeTree')),
        vscode.commands.registerCommand('extension.cancelKeywordScan', () => cancelViewScan('lsdynaKeywordIndex')),
    );
    context.subscriptions.push({ dispose() { for (const source of scans.values()) source.cancel(); } });
}
