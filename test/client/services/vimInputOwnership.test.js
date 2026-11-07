'use strict';
const assert = require('node:assert/strict');
const vscode = require('../../support/vscode-mock');
const extension = require('../../../src/extension');

describe('window input ownership', () => {
    it('yields to enabled but not yet active Vim, then follows workspace enablement changes', async () => {
        const originalCommands = vscode.commands, originalExtensions = vscode.extensions;
        const config = vscode.workspace.getConfiguration, onConfig = vscode.workspace.onDidChangeConfiguration;
        const context = { subscriptions: [] };
        const configListeners = [];
        let enabled = true, foreign = false, registered = 0, disposed = 0, changed, keysEnabled;
        try {
            vscode.workspace.getConfiguration = (section,...args) => section === 'vim' ?
                { inspect: () => ({ globalValue:true, defaultValue:foreign ? false : undefined }) } : config(section,...args);
            vscode.workspace.onDidChangeConfiguration = cb => { configListeners.push(cb); return { dispose() {} }; };
            vscode.extensions = {
                getExtension: id => id === 'vscodevim.vim' && enabled ? { isActive: false } : undefined,
                onDidChange: cb => { changed = cb; return { dispose() {} }; },
            };
            vscode.commands = { ...originalCommands,
                registerCommand(id, callback) {
                    if (id !== 'type') return originalCommands.registerCommand(id,callback);
                    registered++;
                    return { dispose() { disposed++; } };
                },
                executeCommand(id, ...args) {
                    if (id === 'setContext' && args[0] === 'lsdyna.editorKeysEnabled') keysEnabled = args[1];
                    return originalCommands.executeCommand(id,...args);
                },
            };
            await extension.activate(context);
            assert.deepEqual([keysEnabled,registered,disposed],[false,0,0]);
            enabled = false; await changed(); await changed();
            assert.deepEqual([keysEnabled,registered,disposed],[true,1,0]);
            enabled = true; await changed();
            assert.deepEqual([keysEnabled,registered,disposed],[false,1,1]);
            enabled = false; await changed();
            assert.deepEqual([keysEnabled,registered,disposed],[true,2,1]);
            const configChanged = () => Promise.all(configListeners.map(cb => cb({
                affectsConfiguration: id => id === 'vim.useSystemClipboard',
            })));
            foreign = true; await configChanged();
            assert.deepEqual([keysEnabled,registered,disposed],[false,2,2]);
            foreign = false; await configChanged();
            assert.deepEqual([keysEnabled,registered,disposed],[true,3,2]);
            for (const item of context.subscriptions) item.dispose?.();
            assert.equal(disposed,3);
        } finally {
            vscode.commands=originalCommands; vscode.extensions=originalExtensions;
            vscode.workspace.getConfiguration=config; vscode.workspace.onDidChangeConfiguration=onConfig;
        }
    });
});
