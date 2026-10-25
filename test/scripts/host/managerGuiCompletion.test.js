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

describe('manager apply readiness', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../scripts/host/run-keyword-manager-gui.cjs'), 'utf8');
    const start = source.indexOf('(async (acceptanceLayouts) => {');
    const body = source.slice(start, source.indexOf(').toString()', start) + 1);
    async function simulate(expression, neverReady = false) {
        let now = 0, blurred = false, applied = false, clicks = 0;
        const busy = () => blurred && (neverReady || now < 150);
        const preview = () => blurred && now >= 75 && !applied;
        const field = { readOnly: false, focus() {}, dispatchEvent() {}, blur() { blurred = true; } };
        class Input {}
        Object.defineProperty(Input.prototype, 'value', { set() {} });
        const button = { click() { if (!busy()) { applied = true; clicks++; } } };
        const result = await vm.runInNewContext(expression + '(false)', {
            performance: { now: () => now }, setTimeout: resolve => { now += 25; resolve(); },
            HTMLInputElement: Input, Event: class {}, FocusEvent: class {}, document: {
                body: { innerText: 'pending preview' }, querySelector(selector) {
                    if (selector === '.field span[title=ICURV]') return { closest: () => ({ querySelector: () => field }) };
                    if (selector === 'main') return { getAttribute: () => busy() ? 'true' : 'false' };
                    if (selector === '.changePreview') return preview() ? { innerText: 'ICURV: 0 → 12 BESIMF: 0 → 12' } : null;
                    if (selector === '.fieldEditor.changed') return applied ? null : {};
                    if (selector.endsWith(':not(:disabled)')) return !blurred || now < 50 || !busy() ? button : null;
                    return button;
                },
            },
        });
        assert.equal(clicks, 1);
        return result;
    }
    it('waits for the preview notification AND mutation completion before clicking Apply', async () => {
        const old = body.replace("await until(() => document.querySelector('main').getAttribute('aria-busy') !== 'true' && document.querySelector('.detailsActions button.primaryText:not(:disabled)'));", '');
        await assert.rejects(simulate(old), /UI did not reach expected state/);
        assert.equal((await simulate(body)).value, '12');
    });
    it('does not click or hide a mutation that never completes', async () => {
        await assert.rejects(simulate(body, true), /UI did not reach expected state/);
    });
});

describe('drag coordinates after document Undo', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../host/editor-safety/extension-host/index.js'), 'utf8');
    const offset = source.indexOf('const dragColumns = async');
    const coordinates = source.slice(offset, source.indexOf('await dispatchRendererMouseDrag', offset));
    for (const mode of ['stale-text', 'moving-layout', 'never-painted']) {
        it(`waits for rendered source text and stable coordinates: ${mode}`, async () => {
            let attempt = 0, calls = 0, dispatched = false;
            const run = vm.runInNewContext(`(async () => { ${coordinates} dispatched(); }; await dragColumns(20,26); })`, {
                assert, devTools: {}, originalLine: '1   0.0',
                dispatched() { dispatched = true; },
                async waitForAssertion(check) {
                    let last;
                    for (attempt = 0; attempt < 3; attempt++) {
                        calls = 0;
                        try { await check(); return; } catch (error) { last = error; }
                    }
                    throw last;
                },
                async getRendererEditorPositionPoint(_, line, column) {
                    assert.equal(line, 3); calls++;
                    return { x: column + (mode === 'moving-layout' && attempt === 0 && calls === 3 ? 10 : 0), y: 100,
                        lineText: mode === 'never-painted' || mode === 'stale-text' && attempt === 0 ? '1      ' : '1\u00a0\u00a0\u00a00.0' };
                },
            });
            if (mode === 'never-painted') { await assert.rejects(run()); assert.equal(dispatched, false); }
            else { await run(); assert.equal(attempt, 1); assert.equal(dispatched, true); }
        });
    }
});


describe('manager renderer waits for host readiness', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../scripts/host/run-keyword-manager-gui.cjs'), 'utf8');
    const start = source.indexOf('const findManagerContext = async');
    const end = source.indexOf('const context = await findManagerContext();', start);
    assert.ok(start > 0 && end > start);
    for (const instanceSelector of [false, true]) {
        it(`waits for ${instanceSelector ? 'selector' : 'GUI'} host metadata even when the renderer is ready`, async () => {
            let now = 0;
            const result = await vm.runInNewContext('(async () => {' + source.slice(start, end) + 'return findManagerContext();})()', {
                root: '/fixture', path, instanceSelector, hostError: null,
                Date: { now: () => now }, delay: async ms => { now += ms; },
                fs: { existsSync(file) {
                    assert.equal(path.basename(file), instanceSelector ? 'selector-ready.json' : 'gui-ready.json');
                    return now >= 200;
                } },
                attached: new Set(), contexts: new Map([[1, 'ready-renderer']]),
                call: async () => ({ targetInfos: [] }),
                evaluate: async () => { assert.ok(now >= 200, 'Do not use renderer before host metadata'); return true; },
                optionalCards: false, unverified: false, prefixHelp: false, standardRepeat: false, repeated: false, incomplete: false, comments: false,
            });
            assert.equal(result, 'ready-renderer');
            assert.equal(now, 200);
        });
    }
});
