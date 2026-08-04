'use strict';

const assert = require('assert');
const {
    DEFAULT_PULSE_MS,
    DEFAULT_PEAK_ALPHA,
    ALPHA_LEVELS,
    buildPulseFrames,
    resolvePulseRgb,
    createJumpPulseController,
} = require('../../../src/client/services/jumpPulse');

function createMockEditor(lineCount = 10) {
    const calls = [];
    const editor = {
        document: {
            lineCount,
            lineAt(line) {
                return {
                    range: { line, start: { line, character: 0 }, end: { line, character: 5 } },
                };
            },
        },
        setDecorations(type, ranges) {
            calls.push({ type, ranges: Array.isArray(ranges) ? ranges.slice() : ranges });
        },
        _calls: calls,
    };
    return editor;
}

function createMockVscode(themeKind) {
    const created = [];
    const disposed = [];
    return {
        ThemeColor: function ThemeColor(id) { this.id = id; },
        Position: function Position(line, character) { this.line = line; this.character = character; },
        Range: function Range(a, b) { this.start = a; this.end = b; },
        window: {
            activeColorTheme: themeKind == null ? undefined : { kind: themeKind },
            createTextEditorDecorationType(opts) {
                const t = {
                    opts,
                    dispose() { disposed.push(t); },
                };
                created.push(t);
                return t;
            },
        },
        _created: created,
        _disposed: disposed,
    };
}

/** Drain all scheduled callbacks in order (supports re-entrant schedule). */
function drain(scheduled, maxSteps = 200) {
    let steps = 0;
    while (scheduled.length > 0 && steps < maxSteps) {
        const job = scheduled.shift();
        job.fn();
        steps += 1;
    }
    return steps;
}

describe('jumpPulse', () => {
    it('exports a default duration of 1000ms and peak alpha', () => {
        assert.equal(DEFAULT_PULSE_MS, 1000);
        assert.ok(DEFAULT_PEAK_ALPHA > 0.3 && DEFAULT_PEAK_ALPHA < 0.7);
        assert.equal(ALPHA_LEVELS, 12);
    });

    it('buildPulseFrames rises then falls and ends near clear', () => {
        const frames = buildPulseFrames(1000, 0.5);
        assert.ok(frames.length >= 8);
        const alphas = frames.map(f => f.alpha);
        const peak = Math.max(...alphas);
        assert.ok(peak >= 0.49 && peak <= 0.51);
        const peakIdx = alphas.indexOf(peak);
        assert.ok(peakIdx > 0, 'should fade in before peak');
        assert.ok(peakIdx < alphas.length - 1, 'should fade out after peak');
        // Monotonic-ish fade-in to peak
        for (let i = 1; i <= peakIdx; i++) {
            assert.ok(alphas[i] + 1e-9 >= alphas[i - 1], `fade-in at ${i}`);
        }
        // Last frame clears
        assert.ok(alphas[alphas.length - 1] <= 0.001);
        const sumHold = frames.reduce((s, f) => s + f.holdMs, 0);
        assert.ok(sumHold >= 800 && sumHold <= 1400, `total hold ${sumHold}`);
    });

    it('resolvePulseRgb picks distinct colors for all four VS Code theme kinds', () => {
        assert.equal(resolvePulseRgb({ window: { activeColorTheme: { kind: 1 } } }), '214, 113, 0');
        assert.equal(resolvePulseRgb({ window: { activeColorTheme: { kind: 2 } } }), '255, 213, 79');
        assert.equal(resolvePulseRgb({ window: { activeColorTheme: { kind: 3 } } }), '255, 255, 0');
        assert.equal(resolvePulseRgb({ window: { activeColorTheme: { kind: 4 } } }), '138, 79, 0');
        assert.equal(resolvePulseRgb({}, '10, 20, 30'), '10, 20, 30');
    });

    it('animates through multiple alpha decoration levels then clears', () => {
        const vscodeApi = createMockVscode(2);
        const scheduled = [];
        const controller = createJumpPulseController(vscodeApi, {
            baseRgb: '255, 213, 79',
            schedule: (fn, ms) => {
                scheduled.push({ fn, ms });
                return scheduled.length;
            },
            clearSchedule: () => {},
        });
        assert.equal(vscodeApi._created.length, ALPHA_LEVELS);

        const editor = createMockEditor(5);
        controller.pulseLine(editor, 2);

        // First frame applied synchronously
        assert.ok(editor._calls.length >= 1);
        assert.equal(editor._calls[0].ranges.length, 1);
        assert.equal(editor._calls[0].ranges[0].line, 2);

        drain(scheduled);
        // Ended with empty decorations
        const last = editor._calls[editor._calls.length - 1];
        assert.ok(Array.isArray(last.ranges));
        assert.equal(last.ranges.length, 0);
        // Multiple non-empty frames during animation
        const nonEmpty = editor._calls.filter(c => c.ranges && c.ranges.length > 0);
        assert.ok(nonEmpty.length >= 3, `expected multi-step fade, got ${nonEmpty.length}`);
        controller.dispose();
    });

    it('cancels previous pulse when pulsing again', () => {
        const vscodeApi = createMockVscode(2);
        let cleared = 0;
        const scheduled = [];
        const controller = createJumpPulseController(vscodeApi, {
            baseRgb: '255, 213, 79',
            schedule: (fn, ms) => {
                const id = scheduled.length + 1;
                scheduled.push({ fn, ms, id });
                return id;
            },
            clearSchedule: () => { cleared += 1; },
        });
        const a = createMockEditor(5);
        const b = createMockEditor(5);
        controller.pulseLine(a, 0);
        controller.pulseLine(b, 1);
        assert.ok(cleared >= 1);
        // First editor should have been cleared when second pulse started
        assert.ok(a._calls.some(c => Array.isArray(c.ranges) && c.ranges.length === 0));
        assert.equal(b._calls.filter(c => c.ranges.length === 1).length >= 1, true);
        // Stale frames from first pulse must not repaint editor a
        const aCountAfter = a._calls.length;
        drain(scheduled);
        assert.equal(a._calls.length, aCountAfter);
        controller.dispose();
    });

    it('clamps out-of-range line index', () => {
        const vscodeApi = createMockVscode(2);
        const controller = createJumpPulseController(vscodeApi, {
            baseRgb: '255, 0, 0',
            schedule: () => 1,
            clearSchedule: () => {},
        });
        const editor = createMockEditor(3);
        controller.pulseLine(editor, 99);
        assert.equal(editor._calls[0].ranges[0].line, 2);
        controller.pulseLine(editor, -5);
        assert.equal(editor._calls[editor._calls.length - 1].ranges[0].line, 0);
        controller.dispose();
    });

    it('dispose clears timer and all decoration types', () => {
        const vscodeApi = createMockVscode(2);
        let cleared = 0;
        const controller = createJumpPulseController(vscodeApi, {
            baseRgb: '1, 2, 3',
            schedule: (fn) => { return 1; },
            clearSchedule: () => { cleared += 1; },
        });
        const editor = createMockEditor(2);
        controller.pulseLine(editor, 0);
        controller.dispose();
        assert.ok(cleared >= 1);
        assert.equal(vscodeApi._disposed.length, ALPHA_LEVELS);
        const before = editor._calls.length;
        controller.pulseLine(editor, 0);
        assert.equal(editor._calls.length, before);
    });

    it('decoration types use rgba with whole-line background', () => {
        const vscodeApi = createMockVscode(1);
        const controller = createJumpPulseController(vscodeApi, {
            baseRgb: '255, 152, 0',
            schedule: () => 1,
            clearSchedule: () => {},
        });
        const opts = vscodeApi._created.map(t => t.opts);
        assert.ok(opts.every(o => o.isWholeLine === true));
        assert.ok(opts.every(o => typeof o.backgroundColor === 'string' && o.backgroundColor.startsWith('rgba(255, 152, 0')));
        // Highest level near peak bucket
        const last = opts[opts.length - 1].backgroundColor;
        assert.ok(last.includes('1.000') || last.includes('0.9'));
        controller.dispose();
    });

    it('rebuilds concrete animation colors when the active theme changes', () => {
        const vscodeApi = createMockVscode(1);
        let listener = null;
        let listenerDisposed = false;
        vscodeApi.window.onDidChangeActiveColorTheme = callback => {
            listener = callback;
            return { dispose() { listenerDisposed = true; } };
        };
        const controller = createJumpPulseController(vscodeApi, {
            schedule: () => 1,
            clearSchedule: () => {},
        });
        assert.equal(vscodeApi._created.length, ALPHA_LEVELS);
        assert.ok(vscodeApi._created[0].opts.backgroundColor.startsWith('rgba(214, 113, 0'));

        vscodeApi.window.activeColorTheme.kind = 4;
        listener();

        assert.equal(vscodeApi._created.length, ALPHA_LEVELS * 2);
        assert.equal(vscodeApi._disposed.length, ALPHA_LEVELS);
        assert.ok(vscodeApi._created[ALPHA_LEVELS].opts.backgroundColor.startsWith('rgba(138, 79, 0'));
        controller.dispose();
        assert.equal(listenerDisposed, true);
    });
});
