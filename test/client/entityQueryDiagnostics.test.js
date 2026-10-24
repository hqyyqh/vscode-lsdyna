const assert = require('node:assert/strict');
const vscode = require('vscode');
const diagnostics = require('../../out/client/services/entityQueryDiagnostics');
describe('temporary entity diagnostic recording', () => {
    let restore, commands, context;
    beforeEach(() => {
        const old = { register: vscode.commands.registerCommand, output: vscode.window.createOutputChannel,
            open: vscode.workspace.openTextDocument, show: vscode.window.showTextDocument };
        commands = new Map(); context = { extension: { packageJSON: { version: '3.2.1' } }, subscriptions: [] };
        vscode.commands.registerCommand = (id, action) => { commands.set(id, action); return { dispose() {} }; };
        vscode.window.createOutputChannel = () => ({ clear() {}, appendLine() {}, show() {}, dispose() {} });
        vscode.workspace.openTextDocument = async options => options;
        vscode.window.showTextDocument = async () => {};
        diagnostics.registerEntityQueryDiagnostics(context, { mode: 'auto', memoryBytes: 512 * 1024 ** 2 });
        restore = () => { context.subscriptions.forEach(item => item.dispose());
            vscode.commands.registerCommand = old.register; vscode.window.createOutputChannel = old.output;
            vscode.workspace.openTextDocument = old.open; vscode.window.showTextDocument = old.show; };
    });
    afterEach(() => restore());
    const command = action => commands.get('extension.entityDiagnostics.' + action)();
    it('is opt-in, records reasons, and excludes source paths and location payloads', async () => {
        const query = { rootFile: 'C:/private/model.k', scope: 'project', targetKind: 'curve', id: 4 };
        await diagnostics.traceEntityQuery(query, async input => { assert.equal(input, query); });
        assert.equal(JSON.parse(await command('openReport')).records.length, 0);
        command('start');
        await diagnostics.traceEntityQuery(query, async (input, progress) => {
            assert.equal(input.diagnostics, true);
            const response = { status: 'ready', result: { state: 'partial', reasons: ['nested-transform-unsupported'],
                locations: [{ filePath: query.rootFile, raw: 'secret text' }], page: { counts: { reference: 0 } } } };
            progress(response); return response;
        });
        command('stop');
        const report = await command('openReport');
        assert(report.includes('nested-transform-unsupported')); assert(!/private|secret text|filePath/.test(report));
        assert(JSON.parse(report).records.some(row => row.event === 'query-finish'));
    });
    it('bounds the report and retains errors without arbitrary exception text', async () => {
        command('start');
        for (let i = 0; i < 300; i++) diagnostics.recordEntityQueryState({ id: i }, { state: 'loading' });
        await assert.rejects(diagnostics.traceEntityQuery({}, async () => { throw Error('C:/private/model.k secret'); }));
        const report = JSON.parse(await command('openReport'));
        assert.deepEqual(report.budget, { mode: 'auto', memoryBytes: 512 * 1024 ** 2 });
        assert(report.dropped > 0); assert(report.records.length <= 256);
        assert.equal(report.records.at(-1).event, 'query-error');
        assert(!JSON.stringify(report).includes('private'));
    });
});
