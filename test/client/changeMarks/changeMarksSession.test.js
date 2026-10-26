'use strict';

const assert = require('assert');
const { createChangeMarksSessionStore } = require('../../../src/client/changeMarks/changeMarksSession');
const { emptyChangeMarks } = require('../../../src/client/changeMarks/types');

describe('changeMarksSession', () => {
    it('open sets origin and save point equal; no marks until edit', () => {
        const store = createChangeMarksSessionStore();
        const rec = store.open('file:///a.k', 'L1\nL2');
        assert.strictEqual(rec.originText, 'L1\nL2');
        assert.strictEqual(rec.savePointText, 'L1\nL2');
        assert.deepStrictEqual(rec.marks, emptyChangeMarks());
        assert.strictEqual(store.size(), 1);
    });

    it('applyCurrent marks unsavedModified; save promotes to savedModified', () => {
        const store = createChangeMarksSessionStore();
        store.open('u1', 'A\nB\nC');
        let marks = store.applyCurrent('u1', 'A\nB2\nC');
        assert.deepStrictEqual(marks.unsavedModifiedLines, [1]);
        assert.deepStrictEqual(marks.savedModifiedLines, []);

        marks = store.save('u1', 'A\nB2\nC');
        assert.deepStrictEqual(marks.unsavedModifiedLines, []);
        assert.deepStrictEqual(marks.savedModifiedLines, [1]);
    });

    it('applyCurrent marks unsavedDeleted; save promotes to savedDeleted', () => {
        const store = createChangeMarksSessionStore();
        store.open('u-del', 'A\nB\nC');
        let marks = store.applyCurrent('u-del', 'A\nC');
        assert.deepStrictEqual(marks.unsavedDeletedLines, [1]);
        assert.deepStrictEqual(marks.savedDeletedLines, []);

        marks = store.save('u-del', 'A\nC');
        assert.deepStrictEqual(marks.unsavedDeletedLines, []);
        assert.deepStrictEqual(marks.savedDeletedLines, [1]);
        const snap = store.snapshot('u-del');
        assert.deepStrictEqual(snap.marks.savedDeletedLines, [1]);
    });

    it('resetOrigin clears both baselines and marks', () => {
        const store = createChangeMarksSessionStore();
        store.open('u2', 'A\nB');
        store.applyCurrent('u2', 'A\nB2');
        store.save('u2', 'A\nB2');
        const marks = store.resetOrigin('u2', 'A\nB2');
        assert.deepStrictEqual(marks, emptyChangeMarks());
        const snap = store.snapshot('u2');
        assert.strictEqual(snap.originText, 'A\nB2');
        assert.strictEqual(snap.savePointText, 'A\nB2');
    });

    it('branches Save As state without mutating the source session', () => {
        const store = createChangeMarksSessionStore();
        store.open('file:///source.k', 'A\nB');
        store.applyCurrent('file:///source.k', 'A\nB2');

        const destination = store.branch('file:///source.k', 'file:///copy.k', 'A\nB2');

        assert.ok(destination);
        assert.strictEqual(destination.originText, 'A\nB');
        assert.strictEqual(destination.savePointText, 'A\nB2');
        assert.deepStrictEqual(destination.marks.unsavedModifiedLines, []);
        assert.deepStrictEqual(destination.marks.savedModifiedLines, [1]);
        assert.strictEqual(store.get('file:///source.k').savePointText, 'A\nB');
    });

    it('can branch from a snapshot after the source session has closed', () => {
        const store = createChangeMarksSessionStore();
        store.open('file:///source.k', 'A\nB\nC');
        store.applyCurrent('file:///source.k', 'A\nC');
        const snapshot = store.snapshot('file:///source.k');
        store.close('file:///source.k');

        const destination = store.branch(snapshot, 'file:///copy.k', 'A\nC');

        assert.ok(destination);
        assert.deepStrictEqual(destination.marks.savedDeletedLines, [1]);
        assert.strictEqual(store.get('file:///source.k'), null);
    });

    it('does not branch from an unknown source', () => {
        const store = createChangeMarksSessionStore();
        assert.strictEqual(store.branch('file:///missing.k', 'file:///copy.k', 'A'), null);
        assert.strictEqual(store.get('file:///copy.k'), null);
    });

    it('close removes session; unknown uri returns null', () => {
        const store = createChangeMarksSessionStore();
        store.open('u3', 'x');
        store.close('u3');
        assert.strictEqual(store.get('u3'), null);
        assert.strictEqual(store.applyCurrent('missing', 'y'), null);
        assert.strictEqual(store.save('missing', 'y'), null);
    });

    it('accepts uri-like objects with toString', () => {
        const store = createChangeMarksSessionStore();
        const uri = { toString: () => 'file:///obj.k' };
        store.open(uri, 'Z');
        assert.ok(store.get(uri));
        assert.strictEqual(store.get('file:///obj.k').originText, 'Z');
    });
});
