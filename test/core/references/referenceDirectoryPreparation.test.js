'use strict';
const assert = require('node:assert/strict');
require('../../support/helpers');
const { prepareReferenceDirectory } = require('../../../out/extension')._internals;
const { getDefinitionRegistryCatalog } = require('../../../out/core/references/definitionRegistry');

describe('shared reference directory preparation', function () {
    this.timeout(15000);
    it('releases a cancelled waiter without cancelling peers or losing preparation errors', async () => {
        await prepareReferenceDirectory();
        const registry = getDefinitionRegistryCatalog(), original = registry.prepare;
        let release, calls = 0, listener, disposed = false, peerFinished = false;
        const pending = new Promise(resolve => { release = resolve; });
        registry.prepare = () => { calls++; return pending; };
        const token = { isCancellationRequested: false, onCancellationRequested(callback) {
            listener = callback;
            return { dispose() { disposed = true; listener = undefined; } };
        } };
        try {
            await prepareReferenceDirectory({ isCancellationRequested: true });
            assert.equal(calls, 0, 'An already-cancelled request must not start loading');
            const cancelled = prepareReferenceDirectory(token);
            const peer = prepareReferenceDirectory().then(() => { peerFinished = true; });
            token.isCancellationRequested = true;
            listener();
            await cancelled;
            assert.equal(disposed, true);
            assert.equal(peerFinished, false, 'Cancellation must not resolve the other request');
            release(true);
            await peer;
            assert.equal(calls, 2);
            registry.prepare = async () => { throw new Error('damaged rule catalog'); };
            await assert.rejects(prepareReferenceDirectory(), /damaged rule catalog/);
        } finally { release(true); registry.prepare = original; }
    });
});
