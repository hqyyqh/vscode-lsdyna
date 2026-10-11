'use strict';

const assert = require('assert');
const { fakeDoc, vscodeMock } = require('../../support/helpers');
const { createCardCellEditGuard } = require('../../../src/client/services/cardCellEditGuard');
const extension = require('../../../src/extension')._internals;

const fields = [{ p: 0, w: 10 }, { p: 10, w: 10 }, { p: 20, w: 10 }];
const line = '         1         2         3';
function document() {
    const doc = fakeDoc('*NODE\n' + line, '/project/navigation.key');
    doc.uri.toString = () => 'file:///project/navigation.key';
    doc.version = 1;
    doc.languageId = 'lsdyna';
    doc.isClosed = false;
    return doc;
}
function guard() {
    return createCardCellEditGuard({ getCardFieldsForLine: () => fields });
}
const selection = new vscodeMock.Selection(
    new vscodeMock.Position(1, 11), new vscodeMock.Position(1, 20));
const change = { range: selection, rangeLength: 9, text: '9' };

describe('card cell navigation document identity', () => {
    it('rejects another object with the same URI and version for A and Ap typing', () => {
        for (const mode of ['A', 'Ap']) {
            const owner = document();
            const other = document();
            const state = guard();
            if (mode === 'A') state.markA(owner, 1, 1, true);
            else state.markAp(owner, 1, 1, 20);
            assert.strictEqual(state.getNav(other), null);
            assert.strictEqual(state.navMatches(other, 1), false);
            assert.strictEqual(state.planType(other, selection, '9'), null);
            assert.ok(state.getNav(owner));
        }
    });

    it('ignores foreign change, selection and close events without clearing the current owner', () => {
        const owner = document();
        const old = document();
        const state = guard();
        state.markA(owner, 1, 1, true);
        const before = state.getNav(owner);
        old.version = 2;
        assert.strictEqual(state.planPostEditCorrection(old, [change]), null);
        state.onSelectionChange({ document: old, selection, selections: [selection] });
        state.clearNav(old);
        assert.deepStrictEqual(state.getNav(owner), before);
        state.clearNav(owner);
        assert.strictEqual(state.getNav(owner), null);
    });

    it('does not read or mark closed documents', () => {
        const owner = document();
        const state = guard();
        state.markA(owner, 1, 1, true);
        owner.isClosed = true;
        owner.lineAt = () => { throw new Error('closed document must not be read'); };
        assert.strictEqual(state.getNav(), null);
        assert.strictEqual(state.navMatches(owner, 1), false);
        assert.strictEqual(state.planType(owner, selection, '9'), null);
        assert.strictEqual(state.planPostEditCorrection(owner, [change]), null);
        state.clearNav();
        state.markA(owner, 1, 1, true);
        state.markAp(owner, 1, 1, 20);
        assert.strictEqual(state.getNav(), null);
    });

    it('returns frozen snapshots that cannot mutate or track private selection updates', () => {
        const owner = document();
        const state = guard();
        state.markAp(owner, 1, 1, 20);
        const before = state.getNav(owner);
        assert.ok(Object.isFrozen(before));
        assert.throws(() => { before.fieldIndex = 0; }, TypeError);
        const caret = new vscodeMock.Selection(
            new vscodeMock.Position(1, 19), new vscodeMock.Position(1, 19));
        state.onSelectionChange({ document: owner, selection: caret, selections: [caret] });
        assert.strictEqual(before.expectedStart, 20);
        assert.strictEqual(state.getNav(owner).expectedStart, 19);
        assert.strictEqual(state.getNav(owner).fieldIndex, 1);
    });

    it('binds the selection grace to its document object and rejects closed owners', () => {
        const owner = document();
        const other = document();
        const state = guard();
        extension.markCardCellA(state, owner, 1, 1, true);
        assert.ok(extension.hasRecentCardCellSelectionGrace(owner));
        assert.strictEqual(extension.hasRecentCardCellSelectionGrace(other), false);
        assert.ok(extension.cardCellASelectionGraceRemaining(state.getNav(owner), owner) > 0);
        assert.strictEqual(extension.cardCellASelectionGraceRemaining(state.getNav(owner), other), 0);
        owner.isClosed = true;
        assert.strictEqual(extension.hasRecentCardCellSelectionGrace(owner), false);
    });

    it('requires the singleton navigation owner for continued Tab selection', () => {
        const owner = document();
        const other = document();
        const state = extension.ensureCardCellEditGuard();
        state.clearNav();
        try {
            state.markA(owner, 1, 1, true);
            const nav = state.getNav();
            const selected = new vscodeMock.Selection(
                new vscodeMock.Position(1, nav.expectedStart), new vscodeMock.Position(1, nav.expectedEnd));
            assert.strictEqual(extension.isTabSelectionEligible({ document: owner }, selected), true);
            assert.strictEqual(extension.isTabSelectionEligible({ document: other }, selected), false);
        } finally {
            state.clearNav();
        }
    });
});
