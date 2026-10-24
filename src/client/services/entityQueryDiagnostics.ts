const vscode = require('vscode');
const i18n = require('../../core/i18n');
let enabled = false, channel: any, sequence = 0, session = 0;
let records: any[] = [], dropped = 0, bytes = 0, identity: any;
const LIMIT = 2 * 1024 * 1024;
const reasonCodes = values => (Array.isArray(values) ? values : [])
    .filter(value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,100}$/.test(value)).slice(0, 64);

export function recordEntityQueryState(identity: any, result: any) {
    if (enabled) record('view-state', { scope: identity?.scope?.kind, targetKind: identity?.targetKind,
        id: identity?.id, state: result?.state, scanning: result?.scanning,
        reasons: reasonCodes(result?.reasons), counts: result?.page?.counts });
}

function record(event: string, data: any) {
    const row = { time: new Date().toISOString(), event, ...data };
    const size = Buffer.byteLength(JSON.stringify(row));
    if (size > LIMIT) { dropped++; return; }
    records.push(row); bytes += size;
    while (records.length > 256 || bytes > LIMIT) {
        bytes -= Buffer.byteLength(JSON.stringify(records.shift())); dropped++;
    }
    channel?.clear();
    channel?.appendLine(JSON.stringify({ ...identity, dropped }));
    for (const item of records) channel?.appendLine(JSON.stringify(item));
}

export function registerEntityQueryDiagnostics(context: any, budget?: any) {
    identity = { format: 'dynasense-entity-diagnostics-v1', build: 'include-transform-diag-20261023',
        extensionVersion: context.extension?.packageJSON?.version, vscodeVersion: vscode.version,
        platform: process.platform, arch: process.arch, budget };
    channel = vscode.window.createOutputChannel('DynaSense Entity Diagnostics');
    context.subscriptions.push(channel,
        vscode.commands.registerCommand('extension.entityDiagnostics.start', () => {
            enabled = true; session++; records = []; bytes = 0; dropped = 0;
            record('capture-start', {}); channel.show(true);
            void vscode.window.showInformationMessage(i18n.get('entityDiagnosticsStarted'));
        }),
        vscode.commands.registerCommand('extension.entityDiagnostics.stop', () => {
            if (enabled) record('capture-stop', {});
            enabled = false;
            void vscode.window.showInformationMessage(i18n.get('entityDiagnosticsStopped'));
        }),
        vscode.commands.registerCommand('extension.entityDiagnostics.openReport', async () => {
            const text = JSON.stringify({ ...identity, enabled, dropped, records }, null, 2);
            const document = await vscode.workspace.openTextDocument({ language: 'json', content: text });
            await vscode.window.showTextDocument(document, { preview: false });
            return text;
        }), { dispose() { enabled = false; session++; channel = undefined; records = []; bytes = 0; } });
}

export async function traceEntityQuery(query: any, run: (query: any, progress: any) => Promise<any>, onProgress?: any) {
    if (!enabled) return run(query, onProgress);
    const capture = session, queryId = ++sequence, started = Date.now();
    const write = (event, data) => { if (enabled && capture === session) record(event, { queryId, ...data }); };
    write('query-start', { scope: query.scope, targetKind: query.targetKind, id: query.id,
        excludeMeshEntities: query.excludeMeshEntities, openDocuments: vscode.workspace.textDocuments?.length,
        dirtyDocuments: vscode.workspace.textDocuments?.filter(document => document.isDirty).length });
    const summary = response => ({ elapsedMs: Date.now() - started, status: response?.status,
        state: response?.state, resolution: response?.result?.state, reasons: reasonCodes(response?.result?.reasons),
        counts: response?.result?.page?.counts, epoch: response?.result?.page?.epoch,
        diagnostics: response?.diagnostics });
    const timer = setInterval(() => write('query-waiting', { elapsedMs: Date.now() - started }), 5000);
    try {
        const response = await run({ ...query, diagnostics: true }, response => {
            write('query-progress', summary(response)); onProgress?.(response);
        });
        write('query-finish', summary(response)); return response;
    } catch (error) {
        write('query-error', { elapsedMs: Date.now() - started,
            errorName: ['Error', 'RangeError', 'TypeError', 'CancellationError', 'ScanChangedError'].includes(error?.name)
                ? error.name : 'OtherError', code: typeof error?.code === 'number' ? error.code : undefined });
        throw error;
    } finally { clearInterval(timer); }
}
