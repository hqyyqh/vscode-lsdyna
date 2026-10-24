'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testBatches, run } = require('../../../scripts/release/run-unit-tests.cjs');

describe('isolated unit test directories', () => {
    let root;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynasense-unit-runner-'));
        for (const file of ['test/a/one.test.js', 'test/a/two.test.js', 'test/b/three.test.js',
            'test/scripts/native/excluded.test.js', 'test/b/not-a-test.js']) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.writeFileSync(path.join(root, file), '');
        }
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
    it('runs every eligible file once, preserves filters and isolates directories', () => {
        const calls = [];
        assert.equal(run(root, ['--grep', 'example', '--invert'], (...args) => {
            calls.push(args); return { status: 0 };
        }), 0);
        assert.deepEqual(testBatches(root).map(files => files.length), [2, 1]);
        assert.equal(calls.length, 2);
        assert.equal(new Set(calls.flatMap(call => call[1].filter(arg => arg.endsWith('.test.js')))).size, 3);
        for (const call of calls) {
            assert.deepEqual(call[1].slice(1, 3), ['--timeout', '30000']);
            assert.deepEqual(call[1].slice(-3), ['--grep', 'example', '--invert']);
            assert.equal(call[2].cwd, root);
            assert.equal(call[2].windowsHide, true);
        }
    });
    it('lets explicit watchdog overrides take precedence over the cold-start default', () => {
        assert.equal(run(root, ['--timeout', '5000'], (_executable, args) => {
            assert.deepEqual(args.slice(1, 3), ['--timeout', '30000']);
            assert.deepEqual(args.slice(-2), ['--timeout', '5000']);
            return { status: 0 };
        }), 0);
    });
    it('stops and fails on a test failure, signal or spawn error', () => {
        let calls = 0;
        assert.equal(run(root, [], () => { calls++; return { status: 2 }; }), 2);
        assert.equal(calls, 1);
        assert.equal(run(root, [], () => ({ status: null, signal: 'SIGTERM' })), 1);
        assert.throws(() => run(root, [], () => ({ error: Error('spawn failed') })), /spawn failed/);
    });
    it('rejects an empty test inventory', () => {
        fs.rmSync(path.join(root, 'test'), { recursive: true });
        assert.throws(() => run(root, []), /No unit test files/);
    });
});
