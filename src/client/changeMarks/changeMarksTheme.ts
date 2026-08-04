'use strict';

/**
 * Theme-aware palettes for session change marks.
 * Gutter SVGs need concrete hex (ThemeColor cannot paint data-URI icons);
 * overview / minimap use contributed ThemeColor ids with the same defaults.
 *
 * @module client/changeMarks/changeMarksTheme
 */

export type ChangeMarksThemeKind = 'light' | 'dark' | 'highContrast' | 'highContrastLight';

export type ChangeMarksPalette = {
    kind: ChangeMarksThemeKind;
    /** Unsaved (orange family) gutter / solid fill. */
    unsaved: string;
    /** Saved (green family) gutter / solid fill. */
    saved: string;
    /** Restrained whole-line tint (alpha hard-capped well below 0.20). */
    unsavedBackground: string;
    savedBackground: string;
};

/** Contributed color ids (package.json contributes.colors). */
export const COLOR_UNSAVED = 'lsdyna.changeMarks.unsaved';
export const COLOR_SAVED = 'lsdyna.changeMarks.saved';

/**
 * Defaults aligned with package.json color contribution.
 * Light: deeper amber/green for contrast on white.
 * Dark: brighter marks for contrast on dark chrome.
 * HC: high-signal yellow/lime.
 */
export const PALETTES: Record<ChangeMarksThemeKind, Omit<ChangeMarksPalette, 'kind'>> = {
    light: {
        unsaved: '#b8860b',
        saved: '#2e7d32',
        unsavedBackground: 'rgba(184, 134, 11, 0.10)',
        savedBackground: 'rgba(46, 125, 50, 0.10)',
    },
    dark: {
        unsaved: '#e2a03a',
        saved: '#89d185',
        unsavedBackground: 'rgba(226, 160, 58, 0.14)',
        savedBackground: 'rgba(137, 209, 133, 0.14)',
    },
    highContrast: {
        unsaved: '#ffcc00',
        saved: '#3ddc84',
        unsavedBackground: 'rgba(255, 204, 0, 0.16)',
        savedBackground: 'rgba(61, 220, 132, 0.16)',
    },
    highContrastLight: {
        unsaved: '#8b6914',
        saved: '#0b6a0b',
        unsavedBackground: 'rgba(139, 105, 20, 0.12)',
        savedBackground: 'rgba(11, 106, 11, 0.12)',
    },
};

/**
 * Map VS Code ColorThemeKind (or kind number) to our palette bucket.
 * Light=1, Dark=2, HighContrast=3, HighContrastLight=4
 */
export function themeKindFromVscode(kind: unknown): ChangeMarksThemeKind {
    const n = Number(kind);
    if (n === 1) return 'light';
    if (n === 4) return 'highContrastLight';
    if (n === 3) return 'highContrast';
    if (n === 2) return 'dark';
    // Unknown / missing: prefer dark (common for CAE night work)
    return 'dark';
}

export function resolveChangeMarksPalette(vscodeApi: any): ChangeMarksPalette {
    let kind: ChangeMarksThemeKind = 'dark';
    try {
        kind = themeKindFromVscode(vscodeApi?.window?.activeColorTheme?.kind);
    } catch {
        kind = 'dark';
    }
    return { kind, ...PALETTES[kind] };
}

/**
 * Normalize to #rrggbb for SVG attributes.
 * Pass the raw #hex into the SVG string and let encodeURIComponent handle # → %23 once.
 * Do not pre-encode as %23 — double encoding breaks solid fills in data-URI icons.
 */
export function normalizeHex(hex: string): string {
    const raw = String(hex || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
    return raw.startsWith('#') ? raw : `#${raw}`;
}

/** @deprecated Use normalizeHex + single encodeURIComponent on the full SVG. */
export function hexForSvg(hex: string): string {
    return normalizeHex(hex).replace(/^#/, '%23');
}

module.exports = {
    COLOR_UNSAVED,
    COLOR_SAVED,
    PALETTES,
    themeKindFromVscode,
    resolveChangeMarksPalette,
    normalizeHex,
    hexForSvg,
};

export {};
