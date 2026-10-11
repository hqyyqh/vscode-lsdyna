'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { trackTempDirectories } = require('./tempDirectories');

describe('test fixture directory cleanup', () => {
    it('rejects other roots and keeps cleaning after one removal fails', () => {
        let cleanup;
        const afterEachHook = global.afterEach;
        let makeTemp;
        try {
            global.afterEach = hook => { cleanup = hook; };
            makeTemp = trackTempDirectories();
        } finally { global.afterEach = afterEachHook; }
        assert.throws(() => makeTemp(path.join(process.cwd(), 'outside-temp-')));
        let first, second;
        const remove = fs.rmSync;
        try {
            first = makeTemp(path.join(os.tmpdir(), 'fixture-cleanup-failure-'));
            second = makeTemp(path.join(os.tmpdir(), 'fixture-cleanup-next-'));
            fs.rmSync = (target, options) => {
                if (target === first) throw new Error('Injected cleanup failure');
                return remove(target, options);
            };
            assert.throws(cleanup, error => error instanceof AggregateError &&
                error.errors.some(item => item.message === 'Injected cleanup failure'));
            assert.equal(fs.existsSync(first), true);
            assert.equal(fs.existsSync(second), false);
        } finally {
            fs.rmSync = remove;
            cleanup();
        }
        assert.equal(fs.existsSync(first), false);
    });
});
