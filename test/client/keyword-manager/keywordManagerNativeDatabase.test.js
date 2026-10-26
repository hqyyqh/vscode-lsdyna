'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const handoff = require("../../fixtures/public-behavior/database-records.json");
const { buildKeywordOptionViewModel, keywordManagerEditField, keywordManagerHelpState, keywordManagerInstances } = require("../../../out/extension")._internals;
const nativeFile = fs.readFileSync(path.join(__dirname, "../../fixtures/public-behavior/native-inputs/database-native-output.k"), 'utf8');
const nativeIdFile = fs.readFileSync(path.join(__dirname, "../../fixtures/public-behavior/native-inputs/database-id-native-input.k"), 'utf8');
const rowsFor = (keyword, input = nativeFile) => input.replace(/\r\n/g, '\n').split(`*${keyword}\n`)[1].split('\n*')[0].split('\n')
    .filter(line => line.trim() && !line.startsWith('$'));
const documentFor = (keyword, rows) => {
    const lines = [`*${keyword}`, ...rows, '*END'];
    return { languageId: 'lsdyna', version: 1, eol: 1, lineCount: lines.length,
        uri: vscode.Uri.file('D:/temp/native-database.k'),
        lineAt: i => ({ text: lines[i] }), getText: () => lines.join('\n') };
};
const modelFor = (document, options = {}) => buildKeywordOptionViewModel({ document,
    selection: { active: new vscode.Position(0, 0) } }, 0, options);

describe('published native DATABASE descriptor records', () => {
    it('projects seven native cards and matches all 33 field help descriptions', () => {
        let cards = 0, fields = 0;
        for (const native of handoff.rows) {
            const keyword = `DATABASE_${native.name}`;
            const model = modelFor(documentFor(keyword, rowsFor(keyword)));
            assert.notEqual(model.plan.status, 'blocked', `${keyword}: ${model.plan.reason}`);
            assert.equal(model.managerCards.length, native.card_count, keyword);
            cards += model.managerCards.length;
            for (const [cardIndex, card] of model.managerCards.entries()) {
                assert.equal(card.fields.length, native.cards[cardIndex].fields.length);
                for (const [index, field] of card.fields.entries()) {
                    const expected = native.cards[cardIndex].fields[index];
                    assert.equal(field.name, expected.name === '-' ? 'UNUSED' : expected.name);
                    const help = keywordManagerHelpState({ ...model, selectedFieldId: field.fieldId });
                    assert.equal(help.english, /^[\s.-]*$/.test(expected.help || '') ? undefined : expected.help.trim());
                    fields++;
                }
            }
        }
        assert.equal(cards, 7); assert.equal(fields, 33);
    });
    it('edits and serializes each keyword then reopens with other fields preserved', () => {
        for (const native of handoff.rows) {
            const keyword = `DATABASE_${native.name}`;
            const document = documentFor(keyword, rowsFor(keyword));
            const model = modelFor(document);
            const first = model.managerCards[0].fields[0];
            assert.equal(first.editable, true);
            const staged = keywordManagerEditField(model, first.fieldId, '42');
            assert.ok(staged);
            const edited = modelFor(document, staged);
            assert.notEqual(edited.plan.status, 'blocked', edited.plan.reason);
            const reopened = modelFor(documentFor(keyword, edited.plan.replacementRecords.map(row => row.text)));
            assert.equal(reopened.managerCards[0].fields[0].value, '42');
            assert.deepEqual(reopened.managerCards.flatMap(card => card.fields).slice(1).map(field => field.value),
                model.managerCards.flatMap(card => card.fields).slice(1).map(field => field.value));
            assert.equal(document.getText(), documentFor(keyword, rowsFor(keyword)).getText());
        }
    });
    it('does not expose native placeholder slots as meaningful editable fields', () => {
        const keyword = 'DATABASE_BINARY_RUNRSF';
        const model = modelFor(documentFor(keyword, rowsFor(keyword)));
        const native = handoff.rows.find(row => row.name === 'BINARY_RUNRSF');
        const placeholderIndex = native.cards[0].fields.findIndex(field => field.name === '-');
        assert.equal(placeholderIndex, 5);
        const placeholder = model.managerCards[0].fields[placeholderIndex];
        assert.equal(placeholder.editable, false);
        assert.equal(keywordManagerHelpState({ ...model, selectedFieldId: placeholder.fieldId }).english, 'Unused.');
        const values = rowsFor(keyword)[0].split(','); values[placeholderIndex] = '99';
        const originalDocument = documentFor(keyword, [values.join(',')]);
        const unchanged = modelFor(originalDocument);
        const staged = keywordManagerEditField(unchanged, unchanged.managerCards[0].fields[0].fieldId, '43');
        const edited = modelFor(originalDocument, staged);
        const saved = edited.plan.replacementRecords.map(row => row.text);
        assert.equal(modelFor(documentFor(keyword, saved)).managerCards[0].fields[placeholderIndex].value, '99');
        assert.equal(originalDocument.getText(), documentFor(keyword, [values.join(',')]).getText());
    });
    it('removes all seven historical DATABASE candidates outside the native extent', () => {
        let removed = 0;
        for (const native of handoff.rows) {
            const keyword = `DATABASE_${native.name}`;
            const candidates = native.removedCandidates;
            const model = modelFor(documentFor(keyword, rowsFor(keyword)));
            for (const candidate of candidates) {
                assert.equal(model.managerCards.some(card => card.cardIndex === candidate.card), false);
                removed++;
            }
        }
        assert.equal(removed, 7);
    });
    it('edits the five native ID spellings without inventing an ID prefix record', () => {
        for (const name of ['BLSTFOR', 'CPMFOR', 'D3CRACK', 'D3DRLF', 'RUNRSF']) {
            const keyword = `DATABASE_BINARY_${name}_ID`;
            const document = documentFor(keyword, rowsFor(keyword, nativeIdFile));
            const model = modelFor(document);
            assert.notEqual(model.plan.status, 'blocked', `${keyword}: ${model.plan.reason}`);
            assert.equal(model.managerCards.length, 1);
            const staged = keywordManagerEditField(model, model.managerCards[0].fields[0].fieldId, '43');
            assert.ok(staged);
            const edited = modelFor(document, staged);
            assert.notEqual(edited.plan.status, 'blocked', edited.plan.reason);
            assert.equal(edited.plan.replacementRecords.length, 1);
            const reopened = modelFor(documentFor(keyword, edited.plan.replacementRecords.map(row => row.text)));
            assert.equal(reopened.managerCards.length, 1);
            assert.equal(reopened.managerCards[0].fields[0].value, '43');
        }
    });
    it('edits all six native LONG and I10 inputs while preserving other values and comments', () => {
        for (const [format, marker] of [['long', '+'], ['i10', '%']]) {
            const input = fs.readFileSync(path.join(__dirname, `../../fixtures/public-behavior/native-inputs/database-${format}-native-input.k`), 'utf8');
            for (const native of handoff.rows) {
                const keyword = `DATABASE_${native.name} ${marker}`;
                const document = documentFor(keyword, ['$ retained comment', ...rowsFor(keyword, input)]);
                const model = modelFor(document);
                assert.notEqual(model.plan.status, 'blocked', `${keyword}: ${model.plan.reason}`);
                const staged = keywordManagerEditField(model, model.managerCards[0].fields[0].fieldId, '42');
                const edited = modelFor(document, staged);
                assert.notEqual(edited.plan.status, 'blocked', edited.plan.reason);
                assert.deepEqual(edited.plan.replacementRecords.map(row => row.comments), model.plan.replacementRecords.map(row => row.comments));
                const saved = edited.plan.replacementRecords.flatMap(row => [...(row.comments || []), row.text]);
                const reopened = modelFor(documentFor(keyword, saved));
                assert.equal(reopened.managerCards[0].fields[0].value, '42', keyword);
                assert.deepEqual(reopened.managerCards.flatMap(card => card.fields).slice(1).map(field => field.value),
                    model.managerCards.flatMap(card => card.fields).slice(1).map(field => field.value));
                assert.equal(document.getText(), documentFor(keyword, ['$ retained comment', ...rowsFor(keyword, input)]).getText());
            }
        }
    });
});

describe('native DATABASE proven record boundaries', () => {
    it('selects two same-head RUNRSF instances independently and preserves the other record', () => {
        const keyword = 'DATABASE_BINARY_RUNRSF';
        const rows = ['$ first', '101,1,1,1,1,,1', '$ second', '202,1,1,1,1,,1'];
        const document = documentFor(keyword, rows);
        const editor = { document, selection: { active: new vscode.Position(4, 0) } };
        const second = buildKeywordOptionViewModel(editor, 4);
        assert.notEqual(second.plan.status, 'blocked', second.plan.reason);
        assert.equal(second.managerInstances.filter(item => item.keyword === `*${keyword}`).length, 2);
        assert.equal(second.managerCards.length, 1);
        assert.equal(second.managerCards[0].fields[0].value, '202');
        for (const commentLine of [0, 1, 3]) {
            const fromComment = buildKeywordOptionViewModel(editor, commentLine);
            assert.equal(fromComment.managerCards.length, 1);
            assert.equal(fromComment.managerCards[0].fields[0].value, commentLine === 3 ? '202' : '101');
            if (commentLine === 3) assert.equal(fromComment.selectedInstanceId, second.selectedInstanceId);
        }
        const fieldId = second.managerCards[0].fields[0].fieldId;
        const staged = keywordManagerEditField(second, fieldId, '42');
        const edited = modelFor(document, { ...staged, selectedFieldId: fieldId });
        assert.equal(edited.selectedInstanceId, second.selectedInstanceId);
        assert.equal(edited.plan.replacementRecords[0].text, '101,1,1,1,1,,1');
        assert.equal(edited.managerCards[0].fields[0].draft, '42');
        assert.deepEqual(edited.plan.replacementRecords.map(row => row.comments), second.plan.replacementRecords.map(row => row.comments));
        const saved = edited.plan.replacementRecords.flatMap(row => [...(row.comments || []), row.text]);
        const reopenedDocument = documentFor(keyword, saved);
        const reopened = buildKeywordOptionViewModel({ document: reopenedDocument, selection: { active: new vscode.Position(4, 0) } }, 4);
        assert.equal(reopened.managerCards[0].fields[0].value, '42');
        const project = keywordManagerInstances(document, 4);
        assert.equal(project.length, 2);
        assert.equal(project.filter(item => item.selected).length, 1);
        assert.equal(project.find(item => item.selected).line, 4);
    });
    it('keeps empty RUNRSF empty and one-card D3DAT without adding a default card', () => {
        const empty = modelFor(documentFor('DATABASE_BINARY_RUNRSF', []));
        assert.equal(empty.managerCards.length, 0);
        assert.equal(empty.plan.replacementRecords.length, 0);
        assert.equal(empty.managerInstances.filter(item => item.keyword === '*DATABASE_BINARY_RUNRSF').length, 0);
        const document = documentFor('DATABASE_BINARY_D3DAT', ['303,1,1,1,1']);
        const model = modelFor(document);
        assert.notEqual(model.plan.status, 'blocked', model.plan.reason);
        assert.equal(model.managerCards.length, 1);
        const staged = keywordManagerEditField(model, model.managerCards[0].fields[0].fieldId, '42');
        const edited = modelFor(document, staged);
        assert.equal(edited.plan.replacementRecords.length, 1);
        const reopened = modelFor(documentFor('DATABASE_BINARY_D3DAT', edited.plan.replacementRecords.map(row => row.text)));
        assert.equal(reopened.managerCards.length, 1);
        assert.equal(reopened.managerCards[0].fields[0].value, '42');
    });
    it('selects and edits every verified repeated instance including D3DAT 2+2+1', () => {
        for (const input of handoff.repeatedInputs) {
            const document = documentFor(input.keyword, input.records);
            const initial = modelFor(document);
            const instances = initial.managerInstances.filter(item => item.keyword === `*${input.keyword}`);
            assert.equal(instances.length, input.keyword.endsWith('D3DAT') ? 3 : 2);
            for (const [ordinal, instance] of instances.entries()) {
                const model = buildKeywordOptionViewModel({ document, selection: { active: new vscode.Position(instance.line, 0) } }, instance.line);
                assert.equal(model.selectedInstanceId, instance.instanceId);
                assert.equal(model.managerCards.length, input.keyword.endsWith('D3DAT') && ordinal < 2 ? 2 : 1);
                const fieldId = model.managerCards[0].fields[0].fieldId;
                const staged = keywordManagerEditField(model, fieldId, '42');
                const edited = modelFor(document, { ...staged, selectedFieldId: fieldId });
                assert.equal(edited.selectedInstanceId, instance.instanceId);
                const saved = edited.plan.replacementRecords.map(row => row.text);
                assert.equal(saved.length, input.records.length);
                input.records.forEach((text, index) => {
                    if (index !== instance.recordStartIndex) assert.equal(saved[index], text);
                });
                const reopenedDocument = documentFor(input.keyword, saved);
                const reopened = buildKeywordOptionViewModel({ document: reopenedDocument,
                    selection: { active: new vscode.Position(instance.line, 0) } }, instance.line);
                assert.equal(reopened.managerCards[0].fields[0].value, '42');
                assert.equal(reopened.managerCards.length, model.managerCards.length);
            }
        }
    });
    it('keeps non-target keyword blocks and comments byte-identical in a mixed document', () => {
        const keyword = 'DATABASE_BINARY_RUNRSF';
        const suffix = ['$ neighbor', '*DATABASE_BINARY_D3DAT', '303,1,1,1,1', '$ next', '*DATABASE_BINARY_BLSTFOR', '909,1,1,1,1'];
        const document = documentFor(keyword, ['101,1,1,1,1,,1', '$ second', '202,1,1,1,1,,1', ...suffix]);
        const model = buildKeywordOptionViewModel({ document, selection: { active: new vscode.Position(3, 0) } }, 3);
        const fieldId = model.managerCards[0].fields[0].fieldId;
        const staged = keywordManagerEditField(model, fieldId, '42');
        const edited = modelFor(document, { ...staged, selectedFieldId: fieldId });
        assert.equal(edited.plan.replacementRecords.length, 2);
        assert.equal(edited.plan.replacementRecords[0].text, '101,1,1,1,1,,1');
        const originalLines = document.getText().split('\n');
        const replacement = edited.plan.replacementRecords.flatMap(row => [...(row.comments || []), row.text]);
        const preservedTail = originalLines.slice(edited.block.blockEnd);
        const rebuilt = [...originalLines.slice(0, 1), ...replacement, ...(edited.block.trailingComments || []), ...preservedTail];
        assert.equal(rebuilt.slice(-suffix.length - 1).join('\n'), [...suffix, '*END'].join('\n'));
        assert.equal(document.getText(), originalLines.join('\n'));
    });
});
