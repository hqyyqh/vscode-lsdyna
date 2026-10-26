'use strict';

/**
 * Per-document session store for change marks (origin + save point).
 * @module client/changeMarks/changeMarksSession
 */

const { computeChangeMarks } = require('./changeMarksDiff');
const { emptyChangeMarks } = require('./types');
import type { ChangeMarksDiffResult, ChangeMarksSessionSnapshot } from './types';

export type SessionRecord = {
    uri: string;
    originText: string;
    savePointText: string;
    marks: ChangeMarksDiffResult;
};

type SessionOrigin = string | { toString(): string } | Pick<SessionRecord, 'originText'>;

function cloneMarks(marks: ChangeMarksDiffResult): ChangeMarksDiffResult {
    return {
        unsavedModifiedLines: marks.unsavedModifiedLines.slice(),
        unsavedInsertedLines: marks.unsavedInsertedLines.slice(),
        unsavedDeletedLines: (marks.unsavedDeletedLines || []).slice(),
        savedModifiedLines: marks.savedModifiedLines.slice(),
        savedInsertedLines: marks.savedInsertedLines.slice(),
        savedDeletedLines: (marks.savedDeletedLines || []).slice(),
    };
}

export function createChangeMarksSessionStore() {
    /** @type {Map<string, SessionRecord>} */
    const sessions = new Map();

    function keyOf(uri: string | { toString(): string }): string {
        return typeof uri === 'string' ? uri : uri.toString();
    }

    function open(uri: string | { toString(): string }, text: string): SessionRecord {
        const key = keyOf(uri);
        const t = text == null ? '' : String(text);
        const rec: SessionRecord = {
            uri: key,
            originText: t,
            savePointText: t,
            marks: emptyChangeMarks(),
        };
        sessions.set(key, rec);
        return rec;
    }

    function get(uri: string | { toString(): string }): SessionRecord | null {
        return sessions.get(keyOf(uri)) || null;
    }

    function close(uri: string | { toString(): string }): void {
        sessions.delete(keyOf(uri));
    }

    function recompute(rec: SessionRecord, currentText: string): ChangeMarksDiffResult {
        rec.marks = computeChangeMarks(rec.originText, rec.savePointText, currentText);
        return rec.marks;
    }

    function applyCurrent(uri: string | { toString(): string }, currentText: string): ChangeMarksDiffResult | null {
        const rec = get(uri);
        if (!rec) return null;
        return recompute(rec, currentText);
    }

    function save(uri: string | { toString(): string }, currentText: string): ChangeMarksDiffResult | null {
        const rec = get(uri);
        if (!rec) return null;
        rec.savePointText = currentText == null ? '' : String(currentText);
        return recompute(rec, rec.savePointText);
    }

    /**
     * Creates a destination session that continues an existing editing lineage.
     * The source record is left untouched: Save As creates a branch, not a move.
     * A snapshot-like object is accepted so the source document may close before
     * VS Code emits the destination save event.
     */
    function branch(
        source: SessionOrigin,
        destinationUri: string | { toString(): string },
        currentText: string,
    ): SessionRecord | null {
        const sourceRec = typeof source === 'string'
            ? get(source)
            : source && typeof source === 'object' && 'originText' in source
                ? source
                : get(source as { toString(): string });
        if (!sourceRec || typeof sourceRec.originText !== 'string') return null;

        const destinationKey = keyOf(destinationUri);
        const t = currentText == null ? '' : String(currentText);
        const rec: SessionRecord = {
            uri: destinationKey,
            originText: sourceRec.originText,
            savePointText: t,
            marks: emptyChangeMarks(),
        };
        sessions.set(destinationKey, rec);
        recompute(rec, t);
        return rec;
    }

    function resetOrigin(uri: string | { toString(): string }, currentText: string): ChangeMarksDiffResult | null {
        const rec = get(uri);
        if (!rec) return null;
        const t = currentText == null ? '' : String(currentText);
        rec.originText = t;
        rec.savePointText = t;
        rec.marks = emptyChangeMarks();
        return rec.marks;
    }

    function snapshot(uri: string | { toString(): string }): ChangeMarksSessionSnapshot | null {
        const rec = get(uri);
        if (!rec) return null;
        return {
            uri: rec.uri,
            originText: rec.originText,
            savePointText: rec.savePointText,
            marks: cloneMarks(rec.marks),
        };
    }

    function clearAll(): void {
        sessions.clear();
    }

    function size(): number {
        return sessions.size;
    }

    return {
        open,
        get,
        close,
        applyCurrent,
        save,
        branch,
        resetOrigin,
        snapshot,
        clearAll,
        size,
    };
}

module.exports = {
    createChangeMarksSessionStore,
};

export {};
