import { describe, expect, it } from 'vitest';
import {
    FONT_SCALE_DEFAULT,
    FONT_SCALE_MAX,
    FONT_SCALE_MIN,
    applyFontScaleCssVar,
    canStepFontScale,
    clampFontScale,
    formatFontScalePercent,
    loadFontScaleFromStorage,
    parseStoredFontScale,
    saveFontScaleToStorage,
    stepFontScale,
} from '../src/readerFontScale';

describe('readerFontScale', () => {
    it('clamps and rounds scale values', () => {
        expect(clampFontScale(1)).toBe(1);
        expect(clampFontScale(0.5)).toBe(FONT_SCALE_MIN);
        expect(clampFontScale(9)).toBe(FONT_SCALE_MAX);
        expect(clampFontScale(Number.NaN)).toBe(FONT_SCALE_DEFAULT);
        expect(clampFontScale(1.04)).toBe(1);
        expect(clampFontScale(1.06)).toBe(1.1);
    });

    it('parses storage and steps by 0.1', () => {
        expect(parseStoredFontScale(null)).toBe(FONT_SCALE_DEFAULT);
        expect(parseStoredFontScale('1.2')).toBe(1.2);
        expect(parseStoredFontScale('nope')).toBe(FONT_SCALE_DEFAULT);
        expect(stepFontScale(1, 1)).toBe(1.1);
        expect(stepFontScale(1, -1)).toBe(0.9);
        expect(stepFontScale(FONT_SCALE_MAX, 1)).toBe(FONT_SCALE_MAX);
        expect(stepFontScale(FONT_SCALE_MIN, -1)).toBe(FONT_SCALE_MIN);
        expect(canStepFontScale(FONT_SCALE_MAX, 1)).toBe(false);
        expect(canStepFontScale(1, 1)).toBe(true);
    });

    it('formats percent labels', () => {
        expect(formatFontScalePercent(1)).toBe('100%');
        expect(formatFontScalePercent(1.2)).toBe('120%');
        expect(formatFontScalePercent(0.8)).toBe('80%');
    });

    it('reads and writes storage adapters', () => {
        const map = new Map<string, string>();
        const storage = {
            getItem: (k: string) => map.get(k) ?? null,
            setItem: (k: string, v: string) => { map.set(k, v); },
        };
        expect(loadFontScaleFromStorage(storage)).toBe(FONT_SCALE_DEFAULT);
        saveFontScaleToStorage(1.3, storage);
        expect(loadFontScaleFromStorage(storage)).toBe(1.3);
    });

    it('applies CSS custom property on a root-like object', () => {
        const props = new Map<string, string>();
        applyFontScaleCssVar(1.4, {
            style: {
                setProperty(name, value) { props.set(name, value); },
            },
        });
        expect(props.get('--reader-font-scale')).toBe('1.4');
    });
});
