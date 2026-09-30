'use strict';
const assert = require('node:assert/strict');
const path = require('node:path').posix;
const { resolveManualsRoot } = require('../../src/manual/manualsDirResolve');
describe('manual root lookup hot path', () => {
    it('stops at the first usable pack and observes subsequent directory changes', () => {
        const entries = new Set(['/exe/pack', '/exe/pack/indexes', '/ws/pack', '/ws/pack/indexes']);
        const calls = [];
        const options = { manualsDir: 'pack', execPath: '/exe/Code', workspaceFolders: [{ uri: { fsPath: '/ws' } }], pathModule: path,
            fs: { existsSync(file) { calls.push(file); return entries.has(file); } } };
        assert.equal(resolveManualsRoot(options), '/exe/pack');
        assert.deepEqual(calls, ['/exe/pack', '/exe/pack/indexes']);
        entries.delete('/exe/pack/indexes');
        calls.length = 0;
        assert.equal(resolveManualsRoot(options), '/ws/pack');
        assert.ok(calls.includes('/exe/pack/manifest.json'));
        entries.delete('/ws/pack/indexes');
        assert.equal(resolveManualsRoot(options), '/exe/pack');
        entries.delete('/exe/pack');
        assert.equal(resolveManualsRoot(options), '/ws/pack');
    });
    it('continues after an inaccessible root without caching the failure', () => {
        let inaccessible = true;
        const options = { manualsDir: 'pack', execPath: '/exe/Code', workspaceFolders: [{ uri: { fsPath: '/ws' } }], pathModule: path,
            fs: { existsSync(file) { if (inaccessible && file.startsWith('/exe')) throw Error('unavailable'); return true; } } };
        assert.equal(resolveManualsRoot(options), '/ws/pack');
        inaccessible = false;
        assert.equal(resolveManualsRoot(options), '/exe/pack');
    });
});
