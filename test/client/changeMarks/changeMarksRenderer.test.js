'use strict';

const assert = require('assert');
const {
    createChangeMarksRenderer,
    solidBarSvg,
    hollowBarSvg,
    deleteTriangleSvg,
} = require('../../../src/client/changeMarks/changeMarksRenderer');
const {
    COLOR_UNSAVED,
    COLOR_SAVED,
    PALETTES,
} = require('../../../src/client/changeMarks/changeMarksTheme');

function createMockVscode(themeKind = 2) {
    const created = [];
    return {
        Uri: { parse: (s) => ({ toString: () => s, path: s, scheme: 'data' }) },
        Position: function Position(line, character) {
            this.line = line;
            this.character = character;
        },
        Range: function Range(a, b) {
            this.start = a;
            this.end = b;
        },
        ThemeColor: function ThemeColor(id) { this.id = id; },
        OverviewRulerLane: { Left: 1 },
        MinimapPosition: { Inline: 1, Gutter: 2 },
        window: {
            activeColorTheme: { kind: themeKind },
            createTextEditorDecorationType(opts) {
                const t = { opts, dispose() { t.disposed = true; } };
                created.push(t);
                return t;
            },
        },
        _created: created,
    };
}

describe('changeMarksRenderer', () => {
    it('builds solid vs hollow SVGs with %23 colors and no full encodeURIComponent', () => {
        const solid = solidBarSvg('#e2a03a');
        const hollow = hollowBarSvg('#e2a03a');
        const tri = deleteTriangleSvg('#e2a03a');
        assert.notStrictEqual(solid, hollow);
        assert.ok(solid.startsWith('data:image/svg+xml;utf8,'));
        assert.ok(solid.includes('<svg'));
        assert.ok(solid.includes('fill="%23e2a03a"'));
        assert.ok(!solid.includes('%3C'));
        assert.ok(hollow.includes('fill="none"'));
        assert.ok(tri.includes('polygon'));
    });

    it('uses theme palette for gutter SVG (light vs dark differ)', () => {
        const darkVscode = createMockVscode(2);
        createChangeMarksRenderer(darkVscode, { showMinimap: false, showOverviewRuler: false }).dispose();
        const lightVscode = createMockVscode(1);
        createChangeMarksRenderer(lightVscode, { showMinimap: false, showOverviewRuler: false }).dispose();

        const darkUri = String(darkVscode._created[0].opts.gutterIconPath.toString());
        const lightUri = String(lightVscode._created[0].opts.gutterIconPath.toString());
        assert.notStrictEqual(darkUri, lightUri);
        assert.ok(darkUri.includes('e2a03a') || darkUri.includes('%23e2a03a'));
    });

    it('creates whole-line gutter tint without borders; separate minimap types', () => {
        const vscode = createMockVscode(2);
        const renderer = createChangeMarksRenderer(vscode, {
            showOverviewRuler: true,
            showLineBackground: true,
            showMinimap: true,
        });
        // 6 gutter + 2 theme map + 2 hex map
        assert.strictEqual(vscode._created.length, 10);

        const gutterTypes = vscode._created.filter(t => t.opts.gutterIconPath);
        assert.strictEqual(gutterTypes.length, 6);
        for (const t of gutterTypes) {
            assert.strictEqual(t.opts.isWholeLine, true, 'whole-line tint');
            assert.ok(t.opts.backgroundColor);
            assert.ok(!t.opts.borderColor);
            assert.ok(!t.opts.minimap, 'minimap is separate');
        }

        const mapTypes = vscode._created.filter(t => t.opts.minimap);
        assert.ok(mapTypes.length >= 2);
        for (const t of mapTypes) {
            assert.strictEqual(t.opts.isWholeLine, true);
            const color = t.opts.minimap.color;
            const ok =
                color === PALETTES.dark.unsaved
                || color === PALETTES.dark.saved
                || (color && (color.id === COLOR_UNSAVED || color.id === COLOR_SAVED));
            assert.ok(ok, `unexpected minimap color ${color}`);
        }
        renderer.dispose();
    });

    it('omits background when showLineBackground is false', () => {
        const vscode = createMockVscode(1);
        const renderer = createChangeMarksRenderer(vscode, {
            showMinimap: false,
            showLineBackground: false,
            showOverviewRuler: false,
        });
        assert.strictEqual(vscode._created.length, 6);
        for (const t of vscode._created) {
            assert.ok(!t.opts.backgroundColor);
            assert.strictEqual(t.opts.isWholeLine, false);
            assert.ok(t.opts.gutterIconPath);
        }
        renderer.dispose();
    });

    it('applies whole-line gutter options and map layers', () => {
        const vscode = createMockVscode(1);
        const calls = [];
        const editor = {
            document: {
                lineCount: 7,
                lineAt(line) {
                    return { text: line === 0 ? '*SET_PART_ADD' : `L${line}` };
                },
            },
            setDecorations(type, opts) {
                calls.push({ type, opts });
            },
        };
        const renderer = createChangeMarksRenderer(vscode, {
            showLineBackground: true,
            showMinimap: true,
            showOverviewRuler: true,
            getHoverMessage: (kind) => `hover:${kind}`,
        });
        renderer.apply(editor, {
            unsavedModifiedLines: [0],
            unsavedInsertedLines: [2],
            unsavedDeletedLines: [4],
            savedModifiedLines: [3],
            savedInsertedLines: [5],
            savedDeletedLines: [1],
        });
        assert.strictEqual(calls.length, 10);

        const gutterCalls = calls.filter(c => c.type.opts && c.type.opts.gutterIconPath);
        assert.strictEqual(gutterCalls.length, 6);
        for (const c of gutterCalls) {
            if (c.opts.length) {
                // Whole-line: short range is fine; no after-pad
                assert.ok(!c.opts[0].renderOptions?.after);
                assert.ok(String(c.opts[0].hoverMessage).startsWith('hover:'));
                assert.ok(c.opts[0].range.end.character <= 1);
            }
        }
        renderer.dispose();
    });
});
