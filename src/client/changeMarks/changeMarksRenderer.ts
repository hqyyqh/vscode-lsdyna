'use strict';

/**
 * Gutter / line / minimap decorations for session change marks.
 * @module client/changeMarks/changeMarksRenderer
 *
 * Visual strategy:
 * - Glyph margin: solid / hollow / triangle SVG (no left text border).
 * - Unsaved glyphs carry a small status dot, so saved state is not color-only.
 * - Optional whole-line tint (isWholeLine) — reliable for short/long lines.
 * - Minimap + overview: separate dual-color whole-line layers.
 */

import type { ChangeMarksDiffResult, ChangeMarkVisualKind } from './types';
const { emptyChangeMarks } = require('./types');
const {
    COLOR_UNSAVED,
    COLOR_SAVED,
    resolveChangeMarksPalette,
} = require('./changeMarksTheme');

export type ChangeMarksRenderer = {
    apply(editor: any, marks: ChangeMarksDiffResult): void;
    clear(editor: any): void;
    dispose(): void;
};

export type ChangeMarksRendererOpts = {
    showOverviewRuler?: boolean;
    showLineBackground?: boolean;
    /** Dual-color minimap (unsaved/saved only). Default true. */
    showMinimap?: boolean;
    getHoverMessage?: (kind: ChangeMarkVisualKind) => string;
};

/** Encode #rrggbb as %23rrggbb for use inside an unescaped SVG data URI. */
function pctHash(hex: string): string {
    return String(hex || '').replace(/^#/, '%23');
}

function svgDataUriRaw(svgWithPctColors: string): string {
    return `data:image/svg+xml;utf8,${svgWithPctColors}`;
}

type ChangeMarkSaveState = 'saved' | 'unsaved';

function unsavedStatusCue(color: string, state: ChangeMarkSaveState): string {
    return state === 'unsaved'
        ? `<circle data-change-state="unsaved" cx="13" cy="3" r="1.7" fill="${color}"/>`
        : '';
}

/** Filled vertical bar — modified. */
export function solidBarSvg(hex: string, state: ChangeMarkSaveState = 'saved'): string {
    const c = pctHash(hex);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">`
        + `<rect x="5" y="1" width="6" height="14" rx="1" fill="${c}"/>`
        + unsavedStatusCue(c, state)
        + `</svg>`;
    return svgDataUriRaw(svg);
}

/** Hollow outline bar — inserted. */
export function hollowBarSvg(hex: string, state: ChangeMarkSaveState = 'saved'): string {
    const c = pctHash(hex);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">`
        + `<rect x="5.5" y="1.5" width="5" height="13" rx="1" fill="none" stroke="${c}" stroke-width="1.6"/>`
        + unsavedStatusCue(c, state)
        + `</svg>`;
    return svgDataUriRaw(svg);
}

/** Filled triangle — deleted-line neighbor anchor. */
export function deleteTriangleSvg(hex: string, state: ChangeMarkSaveState = 'saved'): string {
    const c = pctHash(hex);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">`
        + `<polygon points="3,4 13,8 3,12" fill="${c}"/>`
        + unsavedStatusCue(c, state)
        + `</svg>`;
    return svgDataUriRaw(svg);
}

/**
 * @param {any} vscodeApi
 * @param {ChangeMarksRendererOpts} [opts]
 */
export function createChangeMarksRenderer(
    vscodeApi: any,
    opts: ChangeMarksRendererOpts = {},
): ChangeMarksRenderer {
    const showOverview = opts.showOverviewRuler !== false;
    const showLineBg = opts.showLineBackground !== false;
    const showMinimap = opts.showMinimap !== false;
    const Uri = vscodeApi.Uri;
    const windowApi = vscodeApi.window;
    const ThemeColor = vscodeApi.ThemeColor;
    const OverviewRulerLane = vscodeApi.OverviewRulerLane;
    const MinimapPosition = vscodeApi.MinimapPosition;

    const palette = resolveChangeMarksPalette(vscodeApi);
    const orangeHex = String(palette.unsaved);
    const greenHex = String(palette.saved);

    function parseIcon(dataUri: string): any {
        try {
            return Uri.parse(dataUri);
        } catch {
            return dataUri;
        }
    }

    const orangeSolid = parseIcon(solidBarSvg(orangeHex, 'unsaved'));
    const orangeHollow = parseIcon(hollowBarSvg(orangeHex, 'unsaved'));
    const orangeTriangle = parseIcon(deleteTriangleSvg(orangeHex, 'unsaved'));
    const greenSolid = parseIcon(solidBarSvg(greenHex, 'saved'));
    const greenHollow = parseIcon(hollowBarSvg(greenHex, 'saved'));
    const greenTriangle = parseIcon(deleteTriangleSvg(greenHex, 'saved'));

    function themeColor(id: string): any {
        return ThemeColor ? new ThemeColor(id) : id;
    }

    /**
     * Glyph + optional whole-line tint. No border. No minimap (separate layer).
     */
    function makeGutterType(gutterUri: any, lineBg: string | undefined) {
        const o: any = {
            gutterIconPath: gutterUri,
            gutterIconSize: 'contain',
            // Whole-line tint is the reliable VS Code path for short/long lines alike.
            isWholeLine: !!(showLineBg && lineBg),
        };
        if (showLineBg && lineBg) {
            o.backgroundColor = lineBg;
        }
        return windowApi.createTextEditorDecorationType(o);
    }

    function makeMapType(colorId: string) {
        const o: any = {
            isWholeLine: true,
        };
        if (showOverview && OverviewRulerLane) {
            o.overviewRulerColor = themeColor(colorId);
            o.overviewRulerLane = OverviewRulerLane.Left;
        }
        if (showMinimap) {
            const gutterPos = MinimapPosition && MinimapPosition.Gutter != null
                ? MinimapPosition.Gutter
                : (MinimapPosition && MinimapPosition.Inline != null ? MinimapPosition.Inline : 1);
            o.minimap = {
                color: themeColor(colorId),
                position: gutterPos,
            };
        }
        return windowApi.createTextEditorDecorationType(o);
    }

    function makeMapHexType(accentHex: string) {
        if (!showMinimap) return null;
        const gutterPos = MinimapPosition && MinimapPosition.Gutter != null
            ? MinimapPosition.Gutter
            : (MinimapPosition && MinimapPosition.Inline != null ? MinimapPosition.Inline : 1);
        return windowApi.createTextEditorDecorationType({
            isWholeLine: true,
            minimap: {
                color: accentHex,
                position: gutterPos,
            },
        });
    }

    const gutterTypes: Record<ChangeMarkVisualKind, any> = {
        unsavedModified: makeGutterType(orangeSolid, palette.unsavedBackground),
        unsavedInserted: makeGutterType(orangeHollow, palette.unsavedBackground),
        unsavedDeleted: makeGutterType(orangeTriangle, palette.unsavedBackground),
        savedModified: makeGutterType(greenSolid, palette.savedBackground),
        savedInserted: makeGutterType(greenHollow, palette.savedBackground),
        savedDeleted: makeGutterType(greenTriangle, palette.savedBackground),
    };

    const mapUnsavedTheme = (showMinimap || showOverview) ? makeMapType(COLOR_UNSAVED) : null;
    const mapSavedTheme = (showMinimap || showOverview) ? makeMapType(COLOR_SAVED) : null;
    const mapUnsavedHex = makeMapHexType(orangeHex);
    const mapSavedHex = makeMapHexType(greenHex);

    const defaultHovers: Record<ChangeMarkVisualKind, string> = {
        unsavedModified: 'Unsaved · modified (vs last save)',
        unsavedInserted: 'Unsaved · inserted line',
        unsavedDeleted: 'Unsaved · deleted line(s) nearby',
        savedModified: 'Saved · modified since opened',
        savedInserted: 'Saved · inserted since opened',
        savedDeleted: 'Saved · deleted line(s) nearby since opened',
    };

    function hoverFor(kind: ChangeMarkVisualKind): string {
        try {
            const custom = opts.getHoverMessage?.(kind);
            if (custom) return custom;
        } catch { /* ignore */ }
        return defaultHovers[kind];
    }

    function lineLengthAt(document: any, line: number): number {
        try {
            if (typeof document.lineAt === 'function') {
                const t = document.lineAt(line);
                return t?.text != null ? String(t.text).length : 0;
            }
        } catch { /* ignore */ }
        return 0;
    }

    /** Whole-line ranges (0..1 or 0..0) with hover — isWholeLine paints full row. */
    function optionsForLines(document: any, lines: number[], kind: ChangeMarkVisualKind): any[] {
        if (!document || !lines || lines.length === 0) return [];
        const Range = vscodeApi.Range;
        const Position = vscodeApi.Position;
        const max = Math.max(0, (document.lineCount || 1) - 1);
        const hover = hoverFor(kind);
        const out = [];
        for (const line of lines) {
            if (line < 0 || line > max) continue;
            const len = lineLengthAt(document, line);
            const end = len > 0 ? 1 : 0;
            out.push({
                range: new Range(new Position(line, 0), new Position(line, end)),
                hoverMessage: hover,
            });
        }
        return out;
    }

    function optionsForMap(document: any, lines: number[]): any[] {
        if (!document || !lines || lines.length === 0) return [];
        const Range = vscodeApi.Range;
        const Position = vscodeApi.Position;
        const max = Math.max(0, (document.lineCount || 1) - 1);
        const out = [];
        for (const line of lines) {
            if (line < 0 || line > max) continue;
            const len = lineLengthAt(document, line);
            const end = len > 0 ? 1 : 0;
            out.push({
                range: new Range(new Position(line, 0), new Position(line, end)),
            });
        }
        return out;
    }

    function apply(editor: any, marks: ChangeMarksDiffResult): void {
        if (!editor || typeof editor.setDecorations !== 'function') return;
        const doc = editor.document;
        const m = marks || emptyChangeMarks();

        editor.setDecorations(gutterTypes.unsavedModified, optionsForLines(doc, m.unsavedModifiedLines, 'unsavedModified'));
        editor.setDecorations(gutterTypes.unsavedInserted, optionsForLines(doc, m.unsavedInsertedLines, 'unsavedInserted'));
        editor.setDecorations(gutterTypes.unsavedDeleted, optionsForLines(doc, m.unsavedDeletedLines || [], 'unsavedDeleted'));
        editor.setDecorations(gutterTypes.savedModified, optionsForLines(doc, m.savedModifiedLines, 'savedModified'));
        editor.setDecorations(gutterTypes.savedInserted, optionsForLines(doc, m.savedInsertedLines, 'savedInserted'));
        editor.setDecorations(gutterTypes.savedDeleted, optionsForLines(doc, m.savedDeletedLines || [], 'savedDeleted'));

        const unsavedLines = [
            ...(m.unsavedModifiedLines || []),
            ...(m.unsavedInsertedLines || []),
            ...(m.unsavedDeletedLines || []),
        ];
        const savedLines = [
            ...(m.savedModifiedLines || []),
            ...(m.savedInsertedLines || []),
            ...(m.savedDeletedLines || []),
        ];
        const unsavedOpts = optionsForMap(doc, unsavedLines);
        const savedOpts = optionsForMap(doc, savedLines);

        if (mapUnsavedTheme) editor.setDecorations(mapUnsavedTheme, unsavedOpts);
        if (mapSavedTheme) editor.setDecorations(mapSavedTheme, savedOpts);
        if (mapUnsavedHex) editor.setDecorations(mapUnsavedHex, unsavedOpts);
        if (mapSavedHex) editor.setDecorations(mapSavedHex, savedOpts);
    }

    function clear(editor: any): void {
        apply(editor, emptyChangeMarks());
    }

    function dispose(): void {
        for (const t of Object.values(gutterTypes)) {
            if (t && typeof t.dispose === 'function') t.dispose();
        }
        for (const t of [mapUnsavedTheme, mapSavedTheme, mapUnsavedHex, mapSavedHex]) {
            if (t && typeof t.dispose === 'function') t.dispose();
        }
    }

    return { apply, clear, dispose };
}

module.exports = {
    createChangeMarksRenderer,
    solidBarSvg,
    hollowBarSvg,
    deleteTriangleSvg,
};

export {};
