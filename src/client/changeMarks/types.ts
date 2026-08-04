'use strict';

/**
 * Session change marks (no-Git line markers).
 * @module client/changeMarks/types
 */

/** How a line differs from the comparison baseline (save or origin). */
export type LineChangeKind = 'modified' | 'inserted' | 'deleted';

/**
 * Six-way mark sets for current document lines (0-based).
 * Unsaved (orange) beats saved (green) for the same line.
 * Within a save-state: modified > inserted > deleted.
 *
 * Deleted marks are anchors on a surviving neighbor line (the gap has no current index).
 */
export type ChangeMarksDiffResult = {
    /** Unsaved modified: dirty vs save, paired line changed. */
    unsavedModifiedLines: number[];
    /** Unsaved inserted: dirty vs save, insert relative to save. */
    unsavedInsertedLines: number[];
    /**
     * Unsaved deleted: lines removed vs save, anchored on the first remaining
     * line after the gap (or last line if trailing delete).
     */
    unsavedDeletedLines: number[];
    /** Saved modified: clean vs save, still differs from origin (paired). */
    savedModifiedLines: number[];
    /** Saved inserted: clean vs save, insert relative to origin. */
    savedInsertedLines: number[];
    /**
     * Saved deleted: lines removed since open (and already saved),
     * anchored on a surviving neighbor line.
     */
    savedDeletedLines: number[];
};

export function emptyChangeMarks(): ChangeMarksDiffResult {
    return {
        unsavedModifiedLines: [],
        unsavedInsertedLines: [],
        unsavedDeletedLines: [],
        savedModifiedLines: [],
        savedInsertedLines: [],
        savedDeletedLines: [],
    };
}

export type ChangeMarksConfig = {
    enabled: boolean;
    maxLineCount: number;
    debounceMs: number;
    showOverviewRuler: boolean;
    /** Very restrained whole-line tint; default true. */
    showLineBackground: boolean;
    /**
     * Dual-color minimap (unsaved/saved only).
     * Does not encode modify / insert / delete shapes — that stays on the gutter.
     * Default true.
     */
    showMinimap: boolean;
};

export type ChangeMarksSessionSnapshot = {
    uri: string;
    originText: string;
    savePointText: string;
    marks: ChangeMarksDiffResult;
};

/** Decorations / hover keys for the six visual states. */
export type ChangeMarkVisualKind =
    | 'unsavedModified'
    | 'unsavedInserted'
    | 'unsavedDeleted'
    | 'savedModified'
    | 'savedInserted'
    | 'savedDeleted';

module.exports = {
    emptyChangeMarks,
};

export {};
