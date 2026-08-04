'use strict';

/**
 * Concrete fallback colors used only where VS Code cannot resolve a ThemeColor
 * for us (for example SVG data URIs and animated rgba decorations).
 *
 * Normal editor/tree UI must use VS Code ThemeColor ids directly. Keeping the
 * exceptional colors here makes four-theme support auditable and testable.
 */

export type ExtensionThemeKind = 'light' | 'dark' | 'highContrast' | 'highContrastLight';

export type ExtensionThemePalette = {
    kind: ExtensionThemeKind;
    changeMarks: {
        unsaved: string;
        saved: string;
        unsavedBackground: string;
        savedBackground: string;
    };
    jumpPulseRgb: string;
    curve: {
        axis: string;
        grid: string;
        text: string;
        label: string;
        accent: string;
        seriesLightness: number;
        seriesSaturation: number;
    };
};

type PaletteDefaults = Omit<ExtensionThemePalette, 'kind'>;

export const EXTENSION_THEME_PALETTES: Record<ExtensionThemeKind, PaletteDefaults> = {
    light: {
        changeMarks: {
            unsaved: '#b8860b',
            saved: '#2e7d32',
            unsavedBackground: 'rgba(184, 134, 11, 0.10)',
            savedBackground: 'rgba(46, 125, 50, 0.10)',
        },
        jumpPulseRgb: '214, 113, 0',
        curve: {
            axis: '#595959',
            grid: '#767676',
            text: '#1f1f1f',
            label: '#4f4f4f',
            accent: '#0066b8',
            seriesLightness: 38,
            seriesSaturation: 85,
        },
    },
    dark: {
        changeMarks: {
            unsaved: '#e2a03a',
            saved: '#89d185',
            unsavedBackground: 'rgba(226, 160, 58, 0.14)',
            savedBackground: 'rgba(137, 209, 133, 0.14)',
        },
        jumpPulseRgb: '255, 213, 79',
        curve: {
            axis: '#b3b3b3',
            grid: '#6e6e6e',
            text: '#f0f0f0',
            label: '#d0d0d0',
            accent: '#4fc3f7',
            seriesLightness: 68,
            seriesSaturation: 95,
        },
    },
    highContrast: {
        changeMarks: {
            unsaved: '#ffcc00',
            saved: '#3ddc84',
            unsavedBackground: 'rgba(255, 204, 0, 0.16)',
            savedBackground: 'rgba(61, 220, 132, 0.16)',
        },
        jumpPulseRgb: '255, 255, 0',
        curve: {
            axis: '#ffffff',
            grid: '#a6a6a6',
            text: '#ffffff',
            label: '#ffffff',
            accent: '#00ffff',
            seriesLightness: 65,
            seriesSaturation: 100,
        },
    },
    highContrastLight: {
        changeMarks: {
            unsaved: '#8b6914',
            saved: '#0b6a0b',
            unsavedBackground: 'rgba(139, 105, 20, 0.12)',
            savedBackground: 'rgba(11, 106, 11, 0.12)',
        },
        jumpPulseRgb: '138, 79, 0',
        curve: {
            axis: '#000000',
            grid: '#595959',
            text: '#000000',
            label: '#000000',
            accent: '#005fb8',
            seriesLightness: 35,
            seriesSaturation: 100,
        },
    },
};

/** VS Code ColorThemeKind: Light=1, Dark=2, HC=3, HC Light=4. */
export function themeKindFromVscode(kind: unknown): ExtensionThemeKind {
    const numericKind = Number(kind);
    if (numericKind === 1) return 'light';
    if (numericKind === 3) return 'highContrast';
    if (numericKind === 4) return 'highContrastLight';
    return 'dark';
}

export function themeKindFromRenderOptions(options: any = {}): ExtensionThemeKind {
    if (options && typeof options.themeKind === 'string' && options.themeKind in EXTENSION_THEME_PALETTES) {
        return options.themeKind as ExtensionThemeKind;
    }
    if (options && options.themeKind != null) {
        return themeKindFromVscode(options.themeKind);
    }
    if (options && options.isDark === false) return 'light';
    return 'dark';
}

export function resolveExtensionThemePalette(kind: unknown): ExtensionThemePalette {
    const resolvedKind = typeof kind === 'string' && kind in EXTENSION_THEME_PALETTES
        ? kind as ExtensionThemeKind
        : themeKindFromVscode(kind);
    return { kind: resolvedKind, ...EXTENSION_THEME_PALETTES[resolvedKind] };
}

module.exports = {
    EXTENSION_THEME_PALETTES,
    themeKindFromVscode,
    themeKindFromRenderOptions,
    resolveExtensionThemePalette,
};

export {};
