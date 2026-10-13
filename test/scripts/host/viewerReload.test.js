'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../scripts/host/run-large-file-viewer-host.cjs'), 'utf8');
const start = source.indexOf('const reload = await evaluate(context,');
const body = source.slice(source.indexOf('(async () => {', start), source.indexOf(').toString()', start) + 1);
async function simulate({ readyAt = 21000, acknowledgedAt = 25, becomesStale = false, oldBudget = false } = {}) {
    let now = 0, clicked = false;
    const status = () => !clicked || now < acknowledgedAt || becomesStale && now > 50;
    const context = { window: { reloadTrace: [] }, performance: { now: () => now },
        setTimeout: resolve => { now += 25; resolve(); },
        document: { querySelector(selector) {
            if (selector === '.status.warning button') return status() ? { click() { clicked = true; } } : null;
            if (selector === '.status.warning') return status() ? {} : null;
            if (selector === '.goto button') return { disabled: !clicked || now < readyAt };
            return { innerText: now < readyAt ? 'Indexing' : 'Ready' };
        } },
    };
    return vm.runInNewContext((oldBudget ? body.replace('},120000)', '},20000)') : body) + '()', context);
}
describe('viewer reload readiness phases', () => {
    it('separates acknowledged reload from background indexing without enabling navigation early', async () => {
        await assert.rejects(simulate({ oldBudget: true }), /Stale\/reload timeout/);
        assert.equal((await simulate()).reloaded, true);
    });
    it('still rejects unacknowledged requests, renewed invalidation and stalled indexing', async () => {
        await assert.rejects(simulate({ acknowledgedAt: 21000 }), /Stale\/reload timeout/);
        await assert.rejects(simulate({ becomesStale: true }), /Reload became stale/);
        await assert.rejects(simulate({ readyAt: 121000 }), /Stale\/reload timeout/);
    });
});
