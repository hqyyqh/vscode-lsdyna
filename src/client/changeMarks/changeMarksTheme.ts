'use strict';

/**
 * Theme-aware palettes for session change marks.
 * Gutter SVGs need concrete hex (ThemeColor cannot paint data-URI icons);
 * overview / minimap use contributed ThemeColor ids with the same defaults.
 *
 * @module client/changeMarks/changeMarksTheme
 */

const {
    EXTENSION_THEME_PALETTES,
    themeKindFromVscode,
    resolveExtensionThemePalette,
} = require('../../core/theme/extensionTheme');

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
export const PALETTES: Record<ChangeMarksThemeKind, Omit<ChangeMarksPalette, 'kind'>> =
    Object.fromEntries(
        Object.entries(EXTENSION_THEME_PALETTES).map(([kind, palette]: [string, any]) => [
            kind,
            { ...palette.changeMarks },
        ])
    ) as Record<ChangeMarksThemeKind, Omit<ChangeMarksPalette, 'kind'>>;

/**
 * Map VS Code ColorThemeKind (or kind number) to our palette bucket.
 * Light=1, Dark=2, HighContrast=3, HighContrastLight=4
 */
export function resolveChangeMarksPalette(vscodeApi: any): ChangeMarksPalette {
    let kind: ChangeMarksThemeKind = 'dark';
    try {
        kind = themeKindFromVscode(vscodeApi?.window?.activeColorTheme?.kind);
    } catch {
        kind = 'dark';
    }
    return { kind, ...resolveExtensionThemePalette(kind).changeMarks };
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
