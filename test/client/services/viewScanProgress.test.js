const assert = require('node:assert/strict');
const vscode = require('vscode');
const { withViewScanProgress, cancelViewScan, registerViewScanCancellation } = require('../../../out/client/services/viewScanProgress');
describe('module-local scan progress', () => {
    let progress, execute, contexts;
    beforeEach(() => {
        progress = vscode.window.withProgress; execute = vscode.commands.executeCommand; contexts = [];
        vscode.window.withProgress = async (options, task) => {
            assert.deepEqual(options.location, { viewId: 'testView' });
            assert.equal(options.cancellable, undefined);
            return task({ report() {} });
        };
        vscode.commands.executeCommand = async (...args) => contexts.push(args);
    });
    afterEach(() => { vscode.window.withProgress = progress; vscode.commands.executeCommand = execute; });
    it('returns results and clears the local cancel button without a notification', async () => {
        assert.equal(await withViewScanProgress('testView', 'scan', async () => 42), 42);
        assert.deepEqual(contexts.map(row => row[2]), [true, false]);
    });
    it('cancels through the module action and does not cancel other views', async () => {
        let token;
        const result = withViewScanProgress('testView', 'scan', async (_, current) => {
            token = current;
            return new Promise(resolve => current.onCancellationRequested(() => resolve('cancelled')));
        });
        cancelViewScan('anotherView'); assert.equal(token.isCancellationRequested, false);
        cancelViewScan('testView'); assert.equal(await result, 'cancelled');
        assert.equal(contexts.at(-1)[2], false);
    });
    it('does not let an older task hide a replacement task cancel button', async () => {
        let finishOld, finishNew, oldToken;
        const old = withViewScanProgress('testView', 'old', async (_, token) => {
            oldToken = token; return new Promise(resolve => finishOld = resolve);
        });
        const next = withViewScanProgress('testView', 'new', async () => new Promise(resolve => finishNew = resolve));
        assert.equal(oldToken.isCancellationRequested, true);
        finishOld(); await old; assert.deepEqual(contexts.map(row => row[2]), [true, true]);
        finishNew(); await next; assert.equal(contexts.at(-1)[2], false);
    });
    it('clears progress after failure and keeps the error available to the caller', async () => {
        await assert.rejects(withViewScanProgress('testView', 'scan', async () => { throw Error('failure'); }), /failure/);
        assert.equal(contexts.at(-1)[2], false);
    });
    it('registers all module cancel commands and cancels active work on disposal', async () => {
        const register = vscode.commands.registerCommand, commands = [], context = { subscriptions: [] };
        vscode.commands.registerCommand = (name, action) => { commands.push(name); return { dispose() {} }; };
        try {
            registerViewScanCancellation(context);
            assert.deepEqual(commands, ['extension.entityReferences.cancel', 'extension.cancelIncludeScan', 'extension.cancelKeywordScan']);
            const task = withViewScanProgress('testView', 'scan', async (_, token) =>
                new Promise(resolve => token.onCancellationRequested(() => resolve('cancelled'))));
            context.subscriptions.forEach(subscription => subscription.dispose());
            assert.equal(await task, 'cancelled');
        } finally { vscode.commands.registerCommand = register; }
    });
});
