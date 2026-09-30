'use strict';

const assert = require('assert');
const { fakeDoc, vscodeMock } = require('../helpers');
const { handleLineCommentToggle, setFileIndexForTesting } = require('../../src/extension')._internals;
const {
    planLineCommentToggle,
    LINE_COMMENT_TOGGLE_LIMITS,
} = require('../../src/core/edit/lineCommentToggle');

describe('LS-DYNA line comment toggle planner', () => {
    function entries(lines) {
        return lines.map((text, i) => ({ line: i, text }));
    }

    function applyPlan(lines, plan) {
        const result = [...lines];
        for (const edit of plan.edits) {
            if (edit.type === 'insert') result[edit.line] = `$${result[edit.line]}`;
            if (edit.type === 'delete') result[edit.line] = result[edit.line].slice(1);
            if (edit.type === 'insert-keyword-comment') {
                result[edit.line] = `*COMMENT ${result[edit.line]}`;
            }
            if (edit.type === 'delete-keyword-comment') {
                result[edit.line] = result[edit.line].slice(edit.endCharacter);
            }
        }
        return result;
    }

    it('comments a keyword using the manual inline COMMENT form', () => {
        const plan = planLineCommentToggle(entries(['*KEYWORD']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 0, type: 'insert-keyword-comment' }]);
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

    it('keeps an empty-only selection byte-clean', () => {
        const plan = planLineCommentToggle(entries(['']));
        assert.strictEqual(plan.status, 'noop');
        assert.strictEqual(plan.mode, 'noop');
        assert.deepStrictEqual(plan.edits, []);
    });

    it('keeps a whitespace-only selection byte-clean', () => {
        const plan = planLineCommentToggle(entries(['   ']));
        assert.strictEqual(plan.status, 'noop');
        assert.strictEqual(plan.mode, 'noop');
        assert.deepStrictEqual(plan.edits, []);
    });

    it('mixed selection layers every ordinary line so authored comments survive the round trip', () => {
        const plan = planLineCommentToggle(entries(['$ keep', 'turn me']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [
            { line: 0, type: 'insert' },
            { line: 1, type: 'insert' },
        ]);
        const commented = applyPlan(['$ keep', 'turn me'], plan);
        assert.deepStrictEqual(commented, ['$$ keep', '$turn me']);
        assert.deepStrictEqual(
            applyPlan(commented, planLineCommentToggle(entries(commented))),
            ['$ keep', 'turn me'],
        );
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

    it('treats an indented $ line as code and adds an outer column-zero marker', () => {
        const plan = planLineCommentToggle(entries(['    $ legacy']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 0, type: 'insert' }]);
    });

    it('comments both an indented $ line and ordinary code in mixed mode', () => {
        const plan = planLineCommentToggle(entries(['    $ legacy', 'turn me']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [
            { line: 0, type: 'insert' },
            { line: 1, type: 'insert' },
        ]);
    });

    it('ordinary column-zero comment plus indented $ layers both lines for exact restoration', () => {
        const plan = planLineCommentToggle(entries(['$ ordinary', '    $ legacy']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [
            { line: 0, type: 'insert' },
            { line: 1, type: 'insert' },
        ]);
    });

    it('$# field-header selected alone receives an outer comment layer', () => {
        const plan = planLineCommentToggle(entries(['$#   secid       mid']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 0, type: 'insert' }]);
    });

    it('$# field-header mixed with data layers both lines', () => {
        const plan = planLineCommentToggle(entries(['$#   secid       mid', '       1       2']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [
            { line: 0, type: 'insert' },
            { line: 1, type: 'insert' },
        ]);
    });

    it('indented $# field-header receives a column-zero outer layer', () => {
        const plan = planLineCommentToggle(entries(['   $# nid']));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [{ line: 0, type: 'insert' }]);
    });

    it('$# field-header comment then uncomment is a strict inverse', () => {
        const original = '$#     mid        ro         e';
        const commentPlan = planLineCommentToggle(entries([original]));
        assert.deepStrictEqual(commentPlan.edits, [{ line: 0, type: 'insert' }]);

        const commented = applyPlan([original], commentPlan);
        assert.deepStrictEqual(commented, [`$${original}`]);

        const uncommentPlan = planLineCommentToggle(entries(commented));
        assert.strictEqual(uncommentPlan.mode, 'uncomment');
        assert.deepStrictEqual(applyPlan(commented, uncommentPlan), [original]);
    });

    it('ordinary comments, field headers, and code all receive one outer layer', () => {
        const original = ['$ note', '$#     mid        ro', '       1       2'];
        const plan = planLineCommentToggle(entries(original));
        assert.strictEqual(plan.mode, 'comment');
        assert.deepStrictEqual(plan.edits, [
            { line: 0, type: 'insert' },
            { line: 1, type: 'insert' },
            { line: 2, type: 'insert' },
        ]);
        assert.deepStrictEqual(applyPlan(original, plan), [
            '$$ note',
            '$$#     mid        ro',
            '$       1       2',
        ]);
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

    it('protects blank, COMMENT control, and opaque body', () => {
        const plan = planLineCommentToggle([
            { line: 0, text: '*COMMENT', kind: 'opaque-control' },
            { line: 1, text: 'hidden', kind: 'opaque-body' },
            { line: 2, text: '   ', kind: 'blank' },
        ]);
        assert.strictEqual(plan.status, 'noop');
        assert.deepStrictEqual(plan.edits, []);
    });

    it('comments a keyword block on its first physical line and preserves every body byte', () => {
        const original = [
            '*DEFINE_CURVE',
            '         3         0 0.0000000',
            '$  add another point -- resolution IS lost when table of curves is used',
            '100. 3400.e+0',
        ];
        const commentPlan = planLineCommentToggle(entries(original));
        assert.deepStrictEqual(commentPlan.edits, [
            { line: 0, type: 'insert-keyword-comment' },
        ]);
        const commented = applyPlan(original, commentPlan);
        assert.deepStrictEqual(commented, [
            '*COMMENT *DEFINE_CURVE',
            original[1],
            original[2],
            original[3],
        ]);

        const uncommentPlan = planLineCommentToggle([
            { line: 0, text: commented[0], kind: 'disabled-keyword' },
            { line: 1, text: commented[1], kind: 'opaque-body' },
            { line: 2, text: commented[2], kind: 'opaque-body' },
            { line: 3, text: commented[3], kind: 'opaque-body' },
        ]);
        assert.deepStrictEqual(applyPlan(commented, uncommentPlan), original);
    });

    it('removes the complete authored spacing before an inline disabled keyword', () => {
        const text = '*COMMENT  *MAT_024_TITLE';
        const plan = planLineCommentToggle(entries([text]));
        assert.strictEqual(plan.mode, 'uncomment');
        assert.deepStrictEqual(plan.edits, [
            { line: 0, type: 'delete-keyword-comment', endCharacter: 10 },
        ]);
        assert.deepStrictEqual(applyPlan([text], plan), ['*MAT_024_TITLE']);
    });

    it('protects ordinary COMMENT text and layers mixed disabled keywords reversibly', () => {
        assert.strictEqual(
            planLineCommentToggle(entries(['*COMMENT ordinary engineering note'])).status,
            'noop',
        );

        const original = ['*COMMENT *INCLUDE', '*NODE'];
        const commentPlan = planLineCommentToggle(entries(original));
        const commented = applyPlan(original, commentPlan);
        assert.deepStrictEqual(commented, [
            '*COMMENT *COMMENT *INCLUDE',
            '*COMMENT *NODE',
        ]);
        assert.deepStrictEqual(
            applyPlan(commented, planLineCommentToggle(entries(commented))),
            original,
        );
    });

    it('rejects unknown state and duplicate conflicts atomically', () => {
        const unknown = planLineCommentToggle([
            { line: 0, text: 'active', kind: 'code' },
            { line: 1, text: 'uncertain', kind: 'unknown' },
        ]);
        assert.strictEqual(unknown.status, 'rejected');
        assert.deepStrictEqual(unknown.edits, []);

        const conflict = planLineCommentToggle([
            { line: 2, text: 'a', kind: 'code' },
            { line: 2, text: 'b', kind: 'code' },
        ]);
        assert.strictEqual(conflict.status, 'rejected');
        assert.deepStrictEqual(conflict.edits, []);
    });

    it('enforces selected-line, edit, character, and physical-line budgets atomically', () => {
        const tenThousand = Array.from({ length: 10_000 }, (_, line) => ({ line, text: 'x', kind: 'code' }));
        assert.strictEqual(planLineCommentToggle(tenThousand).status, 'ready');
        assert.strictEqual(planLineCommentToggle([
            ...tenThousand,
            { line: 10_000, text: 'x', kind: 'code' },
        ]).reason, 'selection-budget-exceeded');
        assert.strictEqual(planLineCommentToggle(entries(['a', 'b']), { maxEdits: 1 }).reason, 'edit-budget-exceeded');

        const line64KiB = 'x'.repeat(64 * 1024);
        assert.strictEqual(planLineCommentToggle([{ line: 0, text: line64KiB }]).status, 'ready');
        assert.strictEqual(planLineCommentToggle([{ line: 0, text: line64KiB + 'x' }]).reason, 'line-too-long');
        const exact8MiB = Array.from({ length: 128 }, (_, line) => ({ line, text: line64KiB, kind: 'code' }));
        assert.strictEqual(planLineCommentToggle(exact8MiB).status, 'ready');
        assert.strictEqual(planLineCommentToggle([
            ...exact8MiB,
            { line: 128, text: 'x', kind: 'code' },
        ]).reason, 'character-budget-exceeded');
        assert.equal(LINE_COMMENT_TOGGLE_LIMITS.maxSelectedLines, 10_000);
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

    it('protects a large COMMENT range using a ready live index while toggling later active code', async () => {
        const lines = ['*COMMENT   *INCLUDE'];
        for (let line = 1; line <= 300; line++) lines.push(line === 20 ? '    *NODE' : `hidden ${line}`);
        lines.push('*SET_SEGMENT', '$#       sid', '       1');
        const filePath = '/test/comment-toggle-ready.key';
        const document = fakeDoc(lines.join('\n'), filePath);
        document.languageId = 'lsdyna';
        document.version = 7;
        const selection = new vscodeMock.Selection(
            new vscodeMock.Position(0, 0),
            new vscodeMock.Position(lines.length - 1, lines[lines.length - 1].length),
        );
        const plannedEdits = [];
        const editor = {
            document,
            selections: [selection],
            async edit(callback) {
                callback({
                    insert(position, text) { plannedEdits.push({ type: 'insert', line: position.line, text }); },
                    delete(range) { plannedEdits.push({ type: 'delete', line: range.start.line }); },
                });
                return true;
            },
        };
        setFileIndexForTesting(filePath, {
            documentVersion: 7,
            keywordBlocks: [
                {
                    keyword: '*COMMENT',
                    startLine: 0,
                    endLine: 300,
                    opaqueKind: 'comment',
                    opaqueStartCharacter: 8,
                },
                { keyword: '*SET_SEGMENT', startLine: 301, endLine: 303 },
            ],
        });
        try {
            assert.equal(await handleLineCommentToggle(editor), true);
            assert.deepEqual(plannedEdits, [
                { type: 'insert', line: 0, text: '*COMMENT ' },
                { type: 'insert', line: 301, text: '*COMMENT ' },
            ]);
        } finally {
            setFileIndexForTesting(filePath, null);
        }
    });

    it('rejects active plus deep opaque selections when bounded fallback cannot prove the range', async () => {
        const lines = ['*COMMENT'];
        for (let line = 1; line <= 300; line++) lines.push(`hidden ${line}`);
        lines.push('*NODE');
        const document = fakeDoc(lines.join('\n'), '/test/comment-toggle-unknown.key');
        document.languageId = 'lsdyna';
        document.version = 2;
        const selection = new vscodeMock.Selection(
            new vscodeMock.Position(258, 0),
            new vscodeMock.Position(301, lines[301].length),
        );
        let editCalls = 0;
        const editor = {
            document,
            selections: [selection],
            async edit() { editCalls++; return true; },
        };

        assert.equal(await handleLineCommentToggle(editor), false);
        assert.equal(editCalls, 0);
    });
});
