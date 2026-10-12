'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

describe('manager GUI completion when file notifications are missing', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../host/keyword-manager/extension-host.cjs'), 'utf8');
    const start = source.indexOf('await new Promise((resolve, reject) => {', source.indexOf('ready for renderer'));
    const end = source.indexOf('const expected = JSON.parse', start);
    assert.ok(start > 0 && end > start);
    async function run(mode) {
        let exists = mode === 'already-finished', closed = false, clock = 0;
        const timers = new Set();
        const result = vm.runInNewContext('(async () => {' + source.slice(start, end) + '})()', {
            root: '/fixture', path, Date: { now: () => clock },
            fs: { existsSync: () => exists, watch: () => ({ close: () => { closed = true; } }) },
            setInterval(callback, delay) {
                assert.equal(delay, 100);
                const timer = setInterval(() => {
                    if (mode === 'missed-event') exists = true;
                    if (mode === 'timeout') clock = 600_001;
                    callback();
                }, 1);
                timers.add(timer); return timer;
            },
            clearInterval(timer) { timers.delete(timer); clearInterval(timer); },
        });
        try {
            if (mode === 'timeout') await assert.rejects(result, /ten-minute bound/);
            else await result;
            assert.equal(timers.size, 0);
            assert.equal(closed, mode !== 'already-finished');
        } finally { for (const timer of timers) clearInterval(timer); }
    }
    for (const mode of ['missed-event', 'already-finished', 'timeout']) it(mode, () => run(mode));
});
