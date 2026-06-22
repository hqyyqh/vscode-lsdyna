'use strict';

const assert = require('assert');

describe('createWorkspaceWatcherManager', () => {
    it('normalizes extensions and swaps watcher sets without lifecycle gaps', () => {
        const { createWorkspaceWatcherManager } = require('../../../out/client/services/workspaceWatcherManager');
        const events = [];
        const created = [];
        const disposed = [];
        const createWatcher = glob => {
            events.push(`create:${glob}`);
            created.push(glob);
            return {
                onDidChange(handler) { this.change = handler; },
                onDidCreate(handler) { this.create = handler; },
                onDidDelete(handler) { this.delete = handler; },
                dispose() {
                    events.push(`dispose:${glob}`);
                    disposed.push(glob);
                },
            };
        };
        const fileEvents = [];
        const manager = createWorkspaceWatcherManager({
            createWatcher,
            onFileEvent: uri => fileEvents.push(uri),
        });

        const first = manager.rebuild(['dat', '.DAT', '../bad', '.x*y']);
        assert.deepStrictEqual(first, ['.asc', '.dat', '.dyna', '.k', '.key']);
        assert.deepStrictEqual(created, first.map(extension => `**/*${extension}`));

        created.length = 0;
        events.length = 0;
        const second = manager.rebuild(['.foo']);
        assert.deepStrictEqual(second, ['.asc', '.dyna', '.foo', '.k', '.key']);
        const lastCreate = events.reduce((index, event, current) => event.startsWith('create:') ? current : index, -1);
        const firstDispose = events.findIndex(event => event.startsWith('dispose:'));
        assert.ok(firstDispose > lastCreate, 'new watchers must exist before old watchers are disposed');

        manager.dispose();
        assert.equal(disposed.length, first.length + second.length);
    });
});
