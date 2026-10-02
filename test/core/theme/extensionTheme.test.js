'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    EXTENSION_THEME_PALETTES,
    CHANGE_MARKS_COLOR_SCHEME_PALETTES,
    DEFAULT_CHANGE_MARKS_CUSTOM_COLORS,
    themeKindFromVscode,
    themeKindFromRenderOptions,
    resolveExtensionThemePalette,
} = require('../../../out/core/theme/extensionTheme');

function rgb(hex) {
    const value = String(hex).replace('#', '');
    return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16));
}

function channel(value) {
    const normalized = value / 255;
    return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
    const [red, green, blue] = rgb(hex).map(channel);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(left, right) {
    const lighter = Math.max(luminance(left), luminance(right));
    const darker = Math.min(luminance(left), luminance(right));
    return (lighter + 0.05) / (darker + 0.05);
}

describe('extensionTheme', () => {
    it('maps all VS Code ColorThemeKind values and legacy render options', () => {
        assert.equal(themeKindFromVscode(1), 'light');
        assert.equal(themeKindFromVscode(2), 'dark');
        assert.equal(themeKindFromVscode(3), 'highContrast');
        assert.equal(themeKindFromVscode(4), 'highContrastLight');
        assert.equal(themeKindFromRenderOptions({ themeKind: 3 }), 'highContrast');
        assert.equal(themeKindFromRenderOptions({ themeKind: 'highContrastLight' }), 'highContrastLight');
        assert.equal(themeKindFromRenderOptions({ isDark: false }), 'light');
    });

    it('provides complete, distinct palettes for all four theme classes', () => {
        assert.deepEqual(Object.keys(EXTENSION_THEME_PALETTES).sort(), [
            'dark',
            'highContrast',
            'highContrastLight',
            'light',
        ]);
        const accents = new Set();
        for (const kind of Object.keys(EXTENSION_THEME_PALETTES)) {
            const palette = resolveExtensionThemePalette(kind);
            assert.equal(palette.kind, kind);
            for (const value of [
                palette.changeMarks.unsaved,
                palette.changeMarks.saved,
                palette.curve.axis,
                palette.curve.grid,
                palette.curve.text,
                palette.curve.label,
                palette.curve.accent,
            ]) {
                assert.match(value, /^#[0-9a-f]{6}$/i);
            }
            accents.add(palette.curve.accent);
        }
        assert.equal(accents.size, 4);
    });

    it('keeps status and chart strokes at least 3:1 against representative editor backgrounds', () => {
        const backgrounds = {
            light: '#ffffff',
            dark: '#1e1e1e',
            highContrast: '#000000',
            highContrastLight: '#ffffff',
        };
        for (const kind of Object.keys(backgrounds)) {
            const palette = resolveExtensionThemePalette(kind);
            for (const [name, value] of Object.entries({
                unsaved: palette.changeMarks.unsaved,
                saved: palette.changeMarks.saved,
                axis: palette.curve.axis,
                grid: palette.curve.grid,
                accent: palette.curve.accent,
            })) {
                const ratio = contrast(value, backgrounds[kind]);
                assert.ok(ratio >= 3, `${kind}.${name} contrast ${ratio.toFixed(2)} is below 3:1`);
            }
        }
    });

    it('keeps contributed change-mark defaults synchronized with the centralized palette', () => {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
        const colors = new Map(manifest.contributes.colors.map(color => [color.id, color.defaults]));
        const unsaved = colors.get('lsdyna.changeMarks.unsaved');
        const saved = colors.get('lsdyna.changeMarks.saved');
        for (const [manifestKey, paletteKey] of [
            ['light', 'light'],
            ['dark', 'dark'],
            ['highContrast', 'highContrast'],
            ['highContrastLight', 'highContrastLight'],
        ]) {
            assert.equal(unsaved[manifestKey], EXTENSION_THEME_PALETTES[paletteKey].changeMarks.unsaved);
            assert.equal(saved[manifestKey], EXTENSION_THEME_PALETTES[paletteKey].changeMarks.saved);
        }
    });

    it('keeps selectable schemes and custom defaults synchronized with the manifest', () => {
        const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
        const settings = manifest.contributes.configuration.properties;
        assert.deepEqual(settings['lsdyna.changeMarks.colorScheme'].enum, [
            'adaptive',
            ...Object.keys(CHANGE_MARKS_COLOR_SCHEME_PALETTES),
            'custom',
        ]);
        assert.equal(
            settings['lsdyna.changeMarks.customUnsavedColor'].default,
            DEFAULT_CHANGE_MARKS_CUSTOM_COLORS.unsaved,
        );
        assert.equal(
            settings['lsdyna.changeMarks.customSavedColor'].default,
            DEFAULT_CHANGE_MARKS_CUSTOM_COLORS.saved,
        );
    });
});
