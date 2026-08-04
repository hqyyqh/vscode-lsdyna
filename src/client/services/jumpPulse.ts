'use strict';

/**
 * Brief whole-line highlight after navigation jumps (keyword usage, etc.).
 *
 * VS Code decorations have no CSS opacity transition. We approximate ease-in /
 * ease-out by stepping through pre-created decoration types with different
 * rgba alphas (theme-aware base RGB).
 *
 * @module client/services/jumpPulse
 */

/** Total time budget target (fade-in + hold + fade-out), ms. */
export const DEFAULT_PULSE_MS = 1000;

/** Peak background alpha (0–1). */
export const DEFAULT_PEAK_ALPHA = 0.48;

/** Quantized alpha levels for decoration types (1..N). */
export const ALPHA_LEVELS = 12;

export type JumpPulseSchedule = (fn: () => void, ms: number) => any;
export type JumpPulseClearSchedule = (handle: any) => void;

export type CreateJumpPulseOptions = {
    /**
     * Approximate total pulse length in ms (fade-in + hold + fade-out).
     * Defaults to {@link DEFAULT_PULSE_MS}.
     */
    durationMs?: number;
    /** Peak alpha 0–1. Defaults to {@link DEFAULT_PEAK_ALPHA}. */
    peakAlpha?: number;
    schedule?: JumpPulseSchedule;
    clearSchedule?: JumpPulseClearSchedule;
    /**
     * Override base RGB triple `"r, g, b"`. When omitted, picks amber tones
     * from `window.activeColorTheme.kind` (light vs dark).
     */
    baseRgb?: string;
};

export type JumpPulseController = {
    pulseLine(editor: any, lineIndex: number, opts?: { durationMs?: number }): void;
    cancel(): void;
    dispose(): void;
};

export type PulseFrame = {
    /** Alpha 0 = clear decorations. */
    alpha: number;
    /** How long to keep this frame before the next, ms. */
    holdMs: number;
};

/**
 * Build fade-in → hold → ease-out fade frames for a total duration budget.
 * Exported for unit tests.
 */
export function buildPulseFrames(totalMs: number, peakAlpha: number): PulseFrame[] {
    const total = Math.max(200, Math.floor(totalMs));
    const peak = Math.min(0.9, Math.max(0.08, peakAlpha));

    // ~15% fade-in, ~35% hold, ~50% fade-out (ease-out spends more time near transparent)
    const fadeInMs = Math.max(60, Math.round(total * 0.15));
    const holdMs = Math.max(120, Math.round(total * 0.35));
    const fadeOutMs = Math.max(120, total - fadeInMs - holdMs);

    const fadeInSteps = Math.max(3, Math.min(6, Math.round(fadeInMs / 30)));
    const fadeOutSteps = Math.max(6, Math.min(14, Math.round(fadeOutMs / 40)));

    const frames: PulseFrame[] = [];

    // Ease-in: slow start, accelerate to peak (quadratic)
    for (let i = 1; i <= fadeInSteps; i++) {
        const t = i / fadeInSteps;
        const eased = t * t;
        frames.push({
            alpha: peak * eased,
            holdMs: Math.max(1, Math.round(fadeInMs / fadeInSteps)),
        });
    }
    // Extend last fade-in frame with hold, or add explicit peak hold
    if (frames.length > 0) {
        frames[frames.length - 1].alpha = peak;
        frames[frames.length - 1].holdMs += holdMs;
    } else {
        frames.push({ alpha: peak, holdMs });
    }

    // Ease-out: fast leave peak, linger near transparent (1 - (1-t)^2 inverted for alpha)
    for (let i = 1; i <= fadeOutSteps; i++) {
        const t = i / fadeOutSteps;
        // ease-out alpha: peak * (1 - t)^2  — drops quickly then softens
        const eased = (1 - t) * (1 - t);
        const alpha = i === fadeOutSteps ? 0 : peak * eased;
        frames.push({
            alpha,
            holdMs: Math.max(1, Math.round(fadeOutMs / fadeOutSteps)),
        });
    }

    return frames;
}

/**
 * Resolve `"r, g, b"` for pulse fill from theme kind or override.
 */
export function resolvePulseRgb(vscodeApi: any, override?: string): string {
    if (override && /^\s*\d+\s*,\s*\d+\s*,\s*\d+\s*$/.test(override)) {
        return override.replace(/\s+/g, ' ').trim();
    }
    let kind: number | undefined;
    try {
        kind = vscodeApi && vscodeApi.window && vscodeApi.window.activeColorTheme
            ? vscodeApi.window.activeColorTheme.kind
            : undefined;
    } catch {
        kind = undefined;
    }
    // ColorThemeKind: Light=1, Dark=2, HighContrast=3, HighContrastLight=4
    if (kind === 1 || kind === 4) {
        // Amber that reads on light editor backgrounds
        return '255, 152, 0';
    }
    // Soft gold / find-like on dark
    return '255, 213, 79';
}

function rgba(rgb: string, alpha: number): string {
    const a = Math.max(0, Math.min(1, alpha));
    // two decimal places is enough for decoration diffs
    return `rgba(${rgb}, ${a.toFixed(3)})`;
}

/**
 * Create a jump-pulse controller bound to a vscode-like API surface.
 *
 * @param {object} vscodeApi - Must provide window.createTextEditorDecorationType.
 * @param {CreateJumpPulseOptions} [options]
 * @returns {JumpPulseController}
 */
export function createJumpPulseController(vscodeApi: any, options: CreateJumpPulseOptions = {}): JumpPulseController {
    const durationDefault = options.durationMs == null ? DEFAULT_PULSE_MS : options.durationMs;
    const peakDefault = options.peakAlpha == null ? DEFAULT_PEAK_ALPHA : options.peakAlpha;
    const schedule: JumpPulseSchedule = options.schedule
        || ((fn, ms) => setTimeout(fn, ms));
    const clearSchedule: JumpPulseClearSchedule = options.clearSchedule
        || ((handle) => clearTimeout(handle));

    const baseRgb = resolvePulseRgb(vscodeApi, options.baseRgb);

    /** Index 1..ALPHA_LEVELS → decoration type; 0 unused. */
    const levelTypes: any[] = new Array(ALPHA_LEVELS + 1).fill(null);
    let canDecorate = false;
    if (vscodeApi && vscodeApi.window && typeof vscodeApi.window.createTextEditorDecorationType === 'function') {
        canDecorate = true;
        for (let level = 1; level <= ALPHA_LEVELS; level++) {
            const alpha = level / ALPHA_LEVELS;
            levelTypes[level] = vscodeApi.window.createTextEditorDecorationType({
                isWholeLine: true,
                backgroundColor: rgba(baseRgb, alpha),
            });
        }
    }

    let timer: any = null;
    let currentEditor: any = null;
    let activeType: any = null;
    let disposed = false;
    /** Monotonic token so late scheduled frames ignore stale sequences. */
    let pulseGen = 0;

    function clearDecorationsOn(editor: any) {
        if (!editor || typeof editor.setDecorations !== 'function') {
            return;
        }
        if (activeType) {
            try {
                editor.setDecorations(activeType, []);
            } catch {
                // editor may already be disposed
            }
            activeType = null;
        }
        // Also clear all level types in case of race / partial apply
        for (let level = 1; level <= ALPHA_LEVELS; level++) {
            const t = levelTypes[level];
            if (!t) continue;
            try {
                editor.setDecorations(t, []);
            } catch {
                // ignore
            }
        }
    }

    function cancel() {
        pulseGen += 1;
        if (timer != null) {
            clearSchedule(timer);
            timer = null;
        }
        if (currentEditor) {
            clearDecorationsOn(currentEditor);
            currentEditor = null;
        } else {
            activeType = null;
        }
    }

    function typeForAlpha(alpha: number): any {
        if (alpha <= 0.001) {
            return null;
        }
        const level = Math.max(1, Math.min(ALPHA_LEVELS, Math.round(alpha * ALPHA_LEVELS)));
        return levelTypes[level];
    }

    function applyFrame(editor: any, range: any, alpha: number) {
        if (!editor || typeof editor.setDecorations !== 'function') {
            return;
        }
        const nextType = typeForAlpha(alpha);
        if (activeType && activeType !== nextType) {
            try {
                editor.setDecorations(activeType, []);
            } catch {
                // ignore
            }
        }
        activeType = nextType;
        if (!nextType) {
            return;
        }
        try {
            editor.setDecorations(nextType, [range]);
        } catch {
            activeType = null;
        }
    }

    function runSequence(editor: any, range: any, frames: PulseFrame[], gen: number) {
        let index = 0;

        const step = () => {
            timer = null;
            if (disposed || gen !== pulseGen || currentEditor !== editor) {
                return;
            }
            if (index >= frames.length) {
                clearDecorationsOn(editor);
                if (currentEditor === editor) {
                    currentEditor = null;
                }
                return;
            }
            const frame = frames[index];
            index += 1;
            applyFrame(editor, range, frame.alpha);
            if (frame.alpha <= 0.001 && index >= frames.length) {
                clearDecorationsOn(editor);
                if (currentEditor === editor) {
                    currentEditor = null;
                }
                return;
            }
            const delay = Math.max(0, frame.holdMs);
            timer = schedule(step, delay);
        };

        step();
    }

    function pulseLine(editor: any, lineIndex: number, opts: { durationMs?: number } = {}) {
        if (disposed || !editor || !editor.document || !canDecorate) {
            return;
        }
        cancel();

        const lineCount = editor.document.lineCount || 0;
        if (lineCount <= 0) {
            return;
        }
        let line = Number(lineIndex);
        if (!Number.isFinite(line)) {
            line = 0;
        }
        line = Math.max(0, Math.min(Math.floor(line), lineCount - 1));

        let range: any;
        try {
            if (typeof editor.document.lineAt === 'function') {
                range = editor.document.lineAt(line).range;
            }
        } catch {
            range = null;
        }
        if (!range && vscodeApi && vscodeApi.Range && vscodeApi.Position) {
            range = new vscodeApi.Range(
                new vscodeApi.Position(line, 0),
                new vscodeApi.Position(line, 0),
            );
        }
        if (!range) {
            return;
        }

        currentEditor = editor;
        const ms = opts.durationMs == null ? durationDefault : opts.durationMs;
        const frames = buildPulseFrames(ms, peakDefault);
        const gen = pulseGen;
        runSequence(editor, range, frames, gen);
    }

    function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        cancel();
        for (let level = 1; level <= ALPHA_LEVELS; level++) {
            const t = levelTypes[level];
            if (t && typeof t.dispose === 'function') {
                try {
                    t.dispose();
                } catch {
                    // ignore
                }
            }
            levelTypes[level] = null;
        }
    }

    return {
        pulseLine,
        cancel,
        dispose,
    };
}

module.exports = {
    DEFAULT_PULSE_MS,
    DEFAULT_PEAK_ALPHA,
    ALPHA_LEVELS,
    buildPulseFrames,
    resolvePulseRgb,
    createJumpPulseController,
};
