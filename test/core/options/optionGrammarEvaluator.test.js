'use strict';

const assert = require('node:assert/strict');
const { OptionGrammarEvaluator } = require('../../../out/core/options/optionGrammarEvaluator');

function grammar(grammarKind, targets) {
    return {
        schemaVersion: 2,
        kind: 'keyword-option-grammar-v2',
        grammarId: `fixture:${grammarKind}`,
        grammarKind,
        permissions: { display: true },
        targets: targets.map((selection, index) => ({
            targetId: `target:${index}`,
            spelling: `*FIXTURE_${index}`,
            selection: { slots: selection },
            disposition: 'editable',
            writePermission: true,
            writeBlocker: null,
            layouts: [],
            evidence: [{ evidenceId: `fixture:${index}` }],
        })),
    };
}

describe('OptionGrammarEvaluator v2 fixtures', () => {
    const evaluator = new OptionGrammarEvaluator();
    for (const kind of ['exclusive', 'ordered-subset', 'allowed-sequences', 'cross-product', 'compatibility-indeterminate']) {
        it(`evaluates ${kind} only through an enumerated concrete target`, () => {
            const fixture = grammar(kind, [
                { axisA: ['A'], axisB: ['1'] },
                { axisA: ['B', 'A'], axisB: ['2'] },
            ]);
            assert.equal(evaluator.evaluate(fixture, { axisA: ['B', 'A'], axisB: ['2'] }).state, 'exact');
            assert.equal(evaluator.evaluate(fixture, { axisA: ['A', 'B'], axisB: ['2'] }).state, 'invalid');
            assert.equal(evaluator.evaluate(fixture, { axisA: ['B', 'A'] }).state, 'ambiguous');
        });
    }

    it('preserves the current equivalent spelling and otherwise selects the producer preference', () => {
        const fixture = grammar('allowed-sequences', [
            { type: ['REVOLUTE'], modifiers: ['LOCAL', 'ID'] },
            { type: ['REVOLUTE'], modifiers: ['LOCAL', 'ID'] },
        ]);
        fixture.targets[0].spelling = '*FIXTURE_REVOLUTE_LOCAL_ID';
        fixture.targets[1].spelling = '*FIXTURE_REVOLUTE_ID_LOCAL';
        fixture.targets[0].semanticSelectionId = fixture.targets[1].semanticSelectionId = 'selection:1';
        fixture.targets[0].preferredForSelection = true;
        fixture.targets[1].preferredForSelection = false;
        const selection = { type: ['REVOLUTE'], modifiers: ['LOCAL', 'ID'] };

        assert.equal(evaluator.evaluate(fixture, selection).target.spelling,
            '*FIXTURE_REVOLUTE_LOCAL_ID');
        assert.equal(evaluator.evaluate(fixture, selection, {
            currentSpelling: '*FIXTURE_REVOLUTE_ID_LOCAL',
        }).target.spelling, '*FIXTURE_REVOLUTE_ID_LOCAL');
    });
});
