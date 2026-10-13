'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const api = require('../../../out/extension')._internals;
const { documentFor, editorFor } = require('../../support/keyword-manager/conditional-fixtures.cjs')({ vscode, generateCommentLine: api.generateCommentLine });
const row = (...values) => values.map(value => String(value).padStart(10)).join('');

describe('reported keyword manager layouts', () => {
    it('exposes read-only mass field navigation on every record without granting alignment authority', () => {
        const lines = ['*ELEMENT_MASS', '$主驾', '    8010    8010           0.077', '$副驾',
            '    8020    8020           0.050', '$主驾后排', '    8030    8030           1.E-7', '$副驾后排',
            '    8040    8040           1.E-7'];
        const doc = documentFor(lines);
        for (const line of [2,4,6,8]) {
            assert.equal(api.getCardFieldsForLine(doc, line), null);
            const fields = api.getReadOnlyNavigationFields(doc, line);
            assert.equal(fields.length, 3, 'Absent optional trailing cells must not trap Tab at the physical end of line');
            assert.deepEqual(fields.slice(0,3).map(field => [field.n, field.p, field.w]),
                [['EID',0,8],['NID',8,8],['MASS',16,16]]);
            for (const field of fields) {
                const end = Math.min(field.nativeRange.end, doc.lineAt(line).text.length);
                assert.equal(api.isTabSelectionEligible({document:doc}, new vscode.Selection(new vscode.Position(line,field.p),new vscode.Position(line,end))),true);
                assert.equal(api.isTabSelectionEligible({document:doc}, new vscode.Selection(new vscode.Position(line,field.p+1),new vscode.Position(line,end))),false);
            }
        }
        assert.equal(doc.getText(), lines.join('\n'));
    });
    it('edits one transformation without losing the following operation or comments', () => {
        const lines = ['*DEFINE_TRANSFORMATION', row(1), '$ translation', row('TRANSL', '1161.', '-741.6', '-262.57'),
            '$ rotation', row('ROTATE', 0, 0, 1, '1161.', 0, 0, 180), '*END'];
        const doc = documentFor(lines), editor = editorFor(doc);
        const original = api.buildKeywordOptionViewModel(editor, 0, {});
        assert.notEqual(original.plan.status, 'blocked', original.plan.reason);
        assert.deepEqual(original.managerCards.map(card => card.cardIndex), [1, 2, 2]);
        const field = original.managerCards[1].fields.find(field => field.name === 'A1');
        assert.equal(field.editable, true);
        const edited = api.buildKeywordOptionViewModel(editor, 0, { fieldDrafts: { [field.fieldId]: '1200.' } });
        assert.notEqual(edited.plan.status, 'blocked', edited.plan.reason);
        const records = edited.plan.replacementRecords;
        assert.equal(records.length, 3);
        assert.equal(records[2].text, lines[5]);
        assert.match(records[1].text, /1200\./);
        assert.equal(doc.getText(), lines.join('\n'));
    });
    it('keeps MATRIX rows attached to their operation before a following translation', () => {
        const lines = ['*DEFINE_TRANSFORMATION', row(2), row('MATRIX'), row(1,0,0,0,0,1,0,0), row(0,0,1,0,0,0,0,1), row('TRANSL',1,2,3), '*END'];
        const model = api.buildKeywordOptionViewModel(editorFor(documentFor(lines)), 0, {});
        assert.notEqual(model.plan.status, 'blocked', model.plan.reason);
        assert.deepEqual(model.managerCards.map(card => card.cardIndex), [1,2,3,4,2]);
    });
});
