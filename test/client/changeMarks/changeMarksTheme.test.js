'use strict';

const assert = require('assert');
const {
    themeKindFromVscode,
    resolveChangeMarksPalette,
    hexForSvg,
    normalizeHex,
    normalizeColorHex,
    colorWithAlpha,
    PALETTES,
    COLOR_SCHEME_PALETTES,
    COLOR_UNSAVED,
    COLOR_SAVED,
} = require('../../../src/client/changeMarks/changeMarksTheme');

function luminance(hex) {
    const channels = [1, 3, 5]
        .map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(left, right) {
    const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('changeMarksTheme', () => {
    it('maps ColorThemeKind numbers to palette buckets', () => {
        assert.strictEqual(themeKindFromVscode(1), 'light');
        assert.strictEqual(themeKindFromVscode(2), 'dark');
        assert.strictEqual(themeKindFromVscode(3), 'highContrast');
        assert.strictEqual(themeKindFromVscode(4), 'highContrastLight');
        assert.strictEqual(themeKindFromVscode(undefined), 'dark');
    });

    it('resolves distinct unsaved/saved hex for light vs dark', () => {
        const light = resolveChangeMarksPalette({ window: { activeColorTheme: { kind: 1 } } });
        const dark = resolveChangeMarksPalette({ window: { activeColorTheme: { kind: 2 } } });
        assert.strictEqual(light.kind, 'light');
        assert.strictEqual(dark.kind, 'dark');
        assert.notStrictEqual(light.unsaved, dark.unsaved);
        assert.notStrictEqual(light.saved, dark.saved);
        assert.ok(light.unsavedBackground.includes('0.10'));
        assert.ok(dark.unsavedBackground.includes('0.14'));
    });

    it('keeps line-background alpha well below 0.20', () => {
        for (const key of Object.keys(PALETTES)) {
            const p = PALETTES[key];
            for (const bg of [p.unsavedBackground, p.savedBackground]) {
                const m = String(bg).match(/[\d.]+(?=\))/);
                assert.ok(m, bg);
                assert.ok(Number(m[0]) < 0.20, `${key} alpha too strong: ${bg}`);
            }
        }
    });

    it('normalizes and encodes hex for SVG data URIs', () => {
        assert.strictEqual(normalizeHex('#E2A03A'), '#e2a03a');
        assert.strictEqual(normalizeHex('89d185'), '#89d185');
        assert.strictEqual(normalizeColorHex('#ABC'), '#aabbcc');
        assert.strictEqual(normalizeColorHex('abcdef'), null);
        assert.strictEqual(normalizeColorHex('#xyzxyz'), null);
        assert.strictEqual(colorWithAlpha('#123456', 0.14), 'rgba(18, 52, 86, 0.14)');
        assert.strictEqual(hexForSvg('#e2a03a'), '%23e2a03a');
        assert.strictEqual(hexForSvg('89d185'), '%2389d185');
    });

    it('resolves each preset for all four VS Code theme kinds', () => {
        const kinds = { light: 1, dark: 2, highContrast: 3, highContrastLight: 4 };
        for (const [scheme, palettes] of Object.entries(COLOR_SCHEME_PALETTES)) {
            for (const [kind, vscodeKind] of Object.entries(kinds)) {
                const actual = resolveChangeMarksPalette({ window: { activeColorTheme: { kind: vscodeKind } } }, {
                    colorScheme: scheme,
                });
                assert.strictEqual(actual.kind, kind);
                assert.strictEqual(actual.scheme, scheme);
                assert.strictEqual(actual.unsaved, palettes[kind].unsaved);
                assert.strictEqual(actual.saved, palettes[kind].saved);
                assert.match(actual.unsavedBackground, /^rgba\(/);
                assert.match(actual.savedBackground, /^rgba\(/);
            }
        }
    });

    it('keeps every recommended preset at least 3:1 against its theme background', () => {
        const backgrounds = {
            light: '#ffffff',
            dark: '#1e1e1e',
            highContrast: '#000000',
            highContrastLight: '#ffffff',
        };
        for (const [scheme, palettes] of Object.entries(COLOR_SCHEME_PALETTES)) {
            for (const [kind, pair] of Object.entries(palettes)) {
                for (const [state, color] of Object.entries(pair)) {
                    const ratio = contrast(color, backgrounds[kind]);
                    assert.ok(ratio >= 3, `${scheme}.${kind}.${state} contrast ${ratio.toFixed(2)} < 3:1`);
                }
            }
        }
    });

    it('uses valid custom colors and falls back per invalid custom value', () => {
        const vscode = { window: { activeColorTheme: { kind: 2 } } };
        const custom = resolveChangeMarksPalette(vscode, {
            colorScheme: 'custom',
            customUnsavedColor: '#123456',
            customSavedColor: '#ABCDEF',
        });
        assert.strictEqual(custom.unsaved, '#123456');
        assert.strictEqual(custom.saved, '#abcdef');

        const fallback = resolveChangeMarksPalette(vscode, {
            colorScheme: 'custom',
            customUnsavedColor: 'bad',
            customSavedColor: '#abcdef',
        });
        assert.strictEqual(fallback.unsaved, PALETTES.dark.unsaved);
        assert.strictEqual(fallback.saved, '#abcdef');
    });

    it('honors legacy global and active-theme color customizations in adaptive mode', () => {
        const vscode = {
            window: { activeColorTheme: { kind: 2 } },
            workspace: {
                getConfiguration(section) {
                    assert.strictEqual(section, 'workbench');
                    return {
                        get(key) {
                            if (key === 'colorTheme') return 'Engineering Dark';
                            if (key === 'colorCustomizations') return {
                                'lsdyna.changeMarks.unsaved': '#112233',
                                'lsdyna.changeMarks.saved': '#445566',
                                '[Engineering*]': {
                                    'lsdyna.changeMarks.saved': '#abcdef',
                                },
                            };
                            return undefined;
                        },
                    };
                },
            },
        };
        const actual = resolveChangeMarksPalette(vscode, { colorScheme: 'adaptive' });
        assert.strictEqual(actual.unsaved, '#112233');
        assert.strictEqual(actual.saved, '#abcdef');
    });

    it('exports stable contributed color ids', () => {
        assert.strictEqual(COLOR_UNSAVED, 'lsdyna.changeMarks.unsaved');
        assert.strictEqual(COLOR_SAVED, 'lsdyna.changeMarks.saved');
    });
});
