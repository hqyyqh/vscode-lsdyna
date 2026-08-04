'use strict';

const assert = require('assert');
const { fakeDoc, vscodeMock } = require('../helpers');
const {
    handleLineCommentToggle,
    planLineCommentToggle,
} = require('../../src/extension')._internals;

describe('LS-DYNA line comment toggle planner', () => {
    function entries(lines) {
        return lines.map((text, i) => ({ line: i, text }));
    }

    it('comments a single uncommented line by inserting $ at column 0', () => {
        const plan = planLineCommentToggle(entries(['*KEYWORD']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 0, type: 'insert' }]);
    });

    it('preserves indentation: planning is column-0 insert only (no space, no trim)', () => {
        const plan = planLineCommentToggle(entries(['       1       2']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 0, type: 'insert' }]);
    });

    it('uncomments a column-0 $ line by deleting exactly one $', () => {
        const plan = planLineCommentToggle(entries(['$*KEYWORD']));
        assert.strictEqual(plan.mode, 'uncomment');
        assert.deepStrictEqual(plan.edits, [{ line: 0, type: 'delete' }]);
    });

    it('treats an empty line as uncommented and comments it to a lone $', () => {
        const plan = planLineCommentToggle(entries(['']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 0, type: 'insert' }]);
    });

    it('treats a whitespace-only line as uncommented', () => {
        const plan = planLineCommentToggle(entries(['   ']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 0, type: 'insert' }]);
    });

    it('mixed selection: comments only the uncommented lines, never adds $$', () => {
        const plan = planLineCommentToggle(entries(['$ keep', 'turn me']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 1, type: 'insert' }]);
    });

    it('all-commented selection: uncomments every column-0 $ line', () => {
        const plan = planLineCommentToggle(entries(['$ a', '$ b']));
        assert.strictEqual(plan.mode, 'uncomment');
        assert.deepStrictEqual(plan.edits, [
            { line: 0, type: 'delete' },
            { line: 1, type: 'delete' },
        ]);
    });

    it('uncomment removes only one $ from a $$ line (strict single-char inverse)', () => {
        const plan = planLineCommentToggle(entries(['$$ note']));
        assert.strictEqual(plan.mode, 'uncomment');
        assert.deepStrictEqual(plan.edits, [{ line: 0, type: 'delete' }]);
    });

    it('legacy indented $ line alone: recognized as commented but not rewritten', () => {
        const plan = planLineCommentToggle(entries(['    $ legacy']));
        assert.strictEqual(plan.mode, 'uncomment');
        assert.deepStrictEqual(plan.edits, []);
    });

    it('legacy indented $ line mixed with uncommented: comment-mode skips it (no $$)', () => {
        const plan = planLineCommentToggle(entries(['    $ legacy', 'turn me']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 1, type: 'insert' }]);
    });

    it('$# field-header lines are never toggled, even when selected alone', () => {
        const plan = planLineCommentToggle(entries(['$#   secid       mid']));
        assert.strictEqual(plan.mode, 'noop');
        assert.deepStrictEqual(plan.edits, []);
    });

    it('$# field-header mixed with data: only the data line is commented', () => {
        const plan = planLineCommentToggle(entries(['$#   secid       mid', '       1       2']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 1, type: 'insert' }]);
    });

    it('comment then uncomment on a column-0 $ line is a strict inverse', () => {
        const original = '       1       2';
        const afterComment = '$' + original;
        const commentPlan = planLineCommentToggle(entries([original]));
        assert.deepStrictEqual(commentPlan.edits, [{ line: 0, type: 'insert' }]);
        const uncommentPlan = planLineCommentToggle(entries([afterComment]));
        assert.strictEqual(uncommentPlan.mode, 'uncomment');
        assert.deepStrictEqual(uncommentPlan.edits, [{ line: 0, type: 'delete' }]);
    });

    it('empty input is a no-op', () => {
        const plan = planLineCommentToggle([]);
        assert.strictEqual(plan.mode, 'noop');
        assert.deepStrictEqual(plan.edits, []);
    });

    it('deduplicates repeated line entries to a single edit (no $$)', () => {
        const plan = planLineCommentToggle([{ line: 2, text: 'a' }, { line: 2, text: 'a' }]);
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 2, type: 'insert' }]);
    });

    it('returns false and preserves state when editor.edit returns false', async () => {
        const document = fakeDoc('       1       2', '/test/comment-toggle.key');
        document.languageId = 'lsdyna';
        const selection = new vscodeMock.Selection(
            new vscodeMock.Position(0, 0),
            new vscodeMock.Position(0, 0),
        );
        const plannedEdits = [];
        const editor = {
            document,
            selections: [selection],
            async edit(callback) {
                callback({
                    insert(position, text) {
                        plannedEdits.push({ type: 'insert', position, text });
                    },
                    delete(range) {
                        plannedEdits.push({ type: 'delete', range });
                    },
                });
                return false;
            },
        };

        const originalText = document.getText();
        const result = await handleLineCommentToggle(editor);

        assert.strictEqual(result, false);
        assert.strictEqual(document.getText(), originalText);
        assert.strictEqual(editor.selections[0], selection);
        assert.strictEqual(plannedEdits.length, 1);
        assert.strictEqual(plannedEdits[0].type, 'insert');
        assert.deepStrictEqual(plannedEdits[0].position, new vscodeMock.Position(0, 0));
        assert.strictEqual(plannedEdits[0].text, '$');
    });
});
