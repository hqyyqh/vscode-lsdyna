'use strict';

/**
 * Manual reader content font-scale helpers (independent of VS Code window zoom).
 * @module webview/manual-reader/readerFontScale
 */

export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.8;
export const FONT_SCALE_STEP = 0.1;
export const FONT_SCALE_DEFAULT = 1;
export const FONT_SCALE_STORAGE_KEY = 'lsdyna.manualReader.fontScale';
export const FONT_SCALE_CSS_VAR = '--reader-font-scale';

/** Round to one decimal to avoid 1.0000002 storage noise. */
export function roundFontScale(value: number): number {
    return Math.round(value * 10) / 10;
}

export function clampFontScale(value: number): number {
    if (!Number.isFinite(value)) return FONT_SCALE_DEFAULT;
    return roundFontScale(Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value)));
}

export function parseStoredFontScale(raw: string | null | undefined): number {
    if (raw == null || raw === '') return FONT_SCALE_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return FONT_SCALE_DEFAULT;
    return clampFontScale(n);
}

export function formatFontScalePercent(scale: number): string {
    return `${Math.round(clampFontScale(scale) * 100)}%`;
}

export function stepFontScale(scale: number, direction: 1 | -1): number {
    return clampFontScale(clampFontScale(scale) + direction * FONT_SCALE_STEP);
}

export function canStepFontScale(scale: number, direction: 1 | -1): boolean {
    const next = stepFontScale(scale, direction);
    return next !== clampFontScale(scale);
}

export function loadFontScaleFromStorage(storage: Pick<Storage, 'getItem'> | null | undefined = globalThis.localStorage): number {
    try {
        return parseStoredFontScale(storage?.getItem(FONT_SCALE_STORAGE_KEY) ?? null);
    } catch {
        return FONT_SCALE_DEFAULT;
    }
}

export function saveFontScaleToStorage(
    scale: number,
    storage: Pick<Storage, 'setItem'> | null | undefined = globalThis.localStorage,
): void {
    try {
        storage?.setItem(FONT_SCALE_STORAGE_KEY, String(clampFontScale(scale)));
    } catch {
        // Quota / private mode — ignore.
    }
}

export function applyFontScaleCssVar(
    scale: number,
    root: { style: { setProperty(name: string, value: string): void } } | null | undefined = globalThis.document?.documentElement,
): void {
    root?.style.setProperty(FONT_SCALE_CSS_VAR, String(clampFontScale(scale)));
}
