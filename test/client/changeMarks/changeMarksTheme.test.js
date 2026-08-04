'use strict';

const assert = require('assert');
const {
    themeKindFromVscode,
    resolveChangeMarksPalette,
    hexForSvg,
    normalizeHex,
    PALETTES,
    COLOR_UNSAVED,
    COLOR_SAVED,
} = require('../../../src/client/changeMarks/changeMarksTheme');

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
        assert.strictEqual(hexForSvg('#e2a03a'), '%23e2a03a');
        assert.strictEqual(hexForSvg('89d185'), '%2389d185');
    });

    it('exports stable contributed color ids', () => {
        assert.strictEqual(COLOR_UNSAVED, 'lsdyna.changeMarks.unsaved');
        assert.strictEqual(COLOR_SAVED, 'lsdyna.changeMarks.saved');
    });
});
