'use strict';

/**
 * Theme-aware palettes for session change marks.
 *
 * Gutter SVGs require concrete colors, so this module resolves the selected
 * scheme once and supplies the same hex values to every renderer layer.
 *
 * @module client/changeMarks/changeMarksTheme
 */

const {
    EXTENSION_THEME_PALETTES,
    CHANGE_MARKS_COLOR_SCHEME_PALETTES,
    themeKindFromVscode,
    resolveExtensionThemePalette,
} = require('../../core/theme/extensionTheme');

export type ChangeMarksThemeKind = 'light' | 'dark' | 'highContrast' | 'highContrastLight';
export type ChangeMarksColorScheme = 'adaptive' | 'orangeBlue' | 'redBlue' | 'highContrast' | 'custom';

export type ChangeMarksPalette = {
    kind: ChangeMarksThemeKind;
    scheme: ChangeMarksColorScheme;
    unsaved: string;
    saved: string;
    unsavedBackground: string;
    savedBackground: string;
};

export type ChangeMarksColorOptions = {
    colorScheme?: string;
    customUnsavedColor?: string;
    customSavedColor?: string;
};

type ForegroundPair = { unsaved: string; saved: string };

/** Existing color IDs remain available as a compatibility input. */
export const COLOR_UNSAVED = 'lsdyna.changeMarks.unsaved';
export const COLOR_SAVED = 'lsdyna.changeMarks.saved';

/** Adaptive defaults aligned with package.json contributes.colors. */
export const PALETTES: Record<ChangeMarksThemeKind, Omit<ChangeMarksPalette, 'kind' | 'scheme'>> =
    Object.fromEntries(
        Object.entries(EXTENSION_THEME_PALETTES).map(([kind, palette]: [string, any]) => [
            kind,
            { ...palette.changeMarks },
        ])
    ) as Record<ChangeMarksThemeKind, Omit<ChangeMarksPalette, 'kind' | 'scheme'>>;

/**
 * Every preset has explicit light/dark/HC variants. Colors are checked at
 * >= 3:1 against the representative editor background for that theme kind.
 */
export const COLOR_SCHEME_PALETTES: Record<
    Exclude<ChangeMarksColorScheme, 'adaptive' | 'custom'>,
    Record<ChangeMarksThemeKind, ForegroundPair>
> = CHANGE_MARKS_COLOR_SCHEME_PALETTES;

const BACKGROUND_ALPHA: Record<ChangeMarksThemeKind, number> = {
    light: 0.10,
    dark: 0.14,
    highContrast: 0.16,
    highContrastLight: 0.12,
};

const VALID_SCHEMES = new Set<ChangeMarksColorScheme>([
    'adaptive',
    'orangeBlue',
    'redBlue',
    'highContrast',
    'custom',
]);

/** Normalize supported opaque colors to #rrggbb. */
export function normalizeColorHex(value: unknown): string | null {
    const raw = String(value || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(raw)) {
        const [r, g, b] = raw.slice(1).split('');
        return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return null;
}

/** Backward-compatible helper used by SVG tests and callers. */
export function normalizeHex(hex: string): string {
    const raw = String(hex || '').trim();
    return normalizeColorHex(raw.startsWith('#') ? raw : `#${raw}`)
        || (raw.startsWith('#') ? raw : `#${raw}`);
}

/** @deprecated Use normalizeHex; retained for compatibility. */
export function hexForSvg(hex: string): string {
    return normalizeHex(hex).replace(/^#/, '%23');
}

export function colorWithAlpha(hex: string, alpha: number): string {
    const normalized = normalizeColorHex(hex);
    if (!normalized) return 'transparent';
    const r = Number.parseInt(normalized.slice(1, 3), 16);
    const g = Number.parseInt(normalized.slice(3, 5), 16);
    const b = Number.parseInt(normalized.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(2)})`;
}

function wildcardMatches(pattern: string, value: string): boolean {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try {
        return new RegExp(`^${escaped}$`, 'i').test(value);
    } catch {
        return pattern.toLowerCase() === value.toLowerCase();
    }
}

function legacyColorOverrides(vscodeApi: any): Partial<ForegroundPair> {
    try {
        const config = vscodeApi?.workspace?.getConfiguration?.('workbench');
        const values = config?.get?.('colorCustomizations') || {};
        if (!values || typeof values !== 'object' || Array.isArray(values)) return {};

        const result: Partial<ForegroundPair> = {};
        const apply = (source: any) => {
            if (!source || typeof source !== 'object' || Array.isArray(source)) return;
            const unsaved = normalizeColorHex(source[COLOR_UNSAVED]);
            const saved = normalizeColorHex(source[COLOR_SAVED]);
            if (unsaved) result.unsaved = unsaved;
            if (saved) result.saved = saved;
        };

        apply(values);
        const themeName = String(config?.get?.('colorTheme') || '').trim();
        if (themeName) {
            for (const [scope, scopedValues] of Object.entries(values)) {
                if (!scope.startsWith('[') || !scope.endsWith(']')) continue;
                const patterns = [...scope.matchAll(/\[([^\]]+)\]/g)].map(match => match[1]);
                if (patterns.some(pattern => wildcardMatches(pattern, themeName))) apply(scopedValues);
            }
        }
        return result;
    } catch {
        return {};
    }
}

function normalizeScheme(value: unknown): ChangeMarksColorScheme {
    const scheme = String(value || 'adaptive') as ChangeMarksColorScheme;
    return VALID_SCHEMES.has(scheme) ? scheme : 'adaptive';
}

export function resolveChangeMarksPalette(
    vscodeApi: any,
    options: ChangeMarksColorOptions = {},
): ChangeMarksPalette {
    let kind: ChangeMarksThemeKind = 'dark';
    try {
        kind = themeKindFromVscode(vscodeApi?.window?.activeColorTheme?.kind);
    } catch {
        kind = 'dark';
    }

    const scheme = normalizeScheme(options.colorScheme);
    const adaptive = resolveExtensionThemePalette(kind).changeMarks;
    let pair: ForegroundPair = { unsaved: adaptive.unsaved, saved: adaptive.saved };

    if (scheme === 'custom') {
        pair = {
            unsaved: normalizeColorHex(options.customUnsavedColor) || pair.unsaved,
            saved: normalizeColorHex(options.customSavedColor) || pair.saved,
        };
    } else if (scheme === 'adaptive') {
        pair = { ...pair, ...legacyColorOverrides(vscodeApi) };
    } else {
        pair = { ...COLOR_SCHEME_PALETTES[scheme][kind] };
    }

    const alpha = BACKGROUND_ALPHA[kind];
    return {
        kind,
        scheme,
        unsaved: normalizeHex(pair.unsaved),
        saved: normalizeHex(pair.saved),
        unsavedBackground: colorWithAlpha(pair.unsaved, alpha),
        savedBackground: colorWithAlpha(pair.saved, alpha),
    };
}

module.exports = {
    COLOR_UNSAVED,
    COLOR_SAVED,
    PALETTES,
    COLOR_SCHEME_PALETTES,
    themeKindFromVscode,
    resolveChangeMarksPalette,
    normalizeColorHex,
    normalizeHex,
    hexForSvg,
    colorWithAlpha,
};

export {};
