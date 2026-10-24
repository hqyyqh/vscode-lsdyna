'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const api = require("../../../out/extension")._internals;
const { documentFor, editorFor } = require("../../support/keyword-manager/conditional-fixtures.cjs")({ vscode, generateCommentLine: api.generateCommentLine });
const { nativeFileReadContext } = require("../../../out/core/semantics/nativeFileReadContext");
const { CatalogInputFormCatalogV4 } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
const catalog = new CatalogInputFormCatalogV4({ rootDir: path.resolve(__dirname, "../../../keywords/runtime/input-form") });
const published = require("../../../keywords/runtime/native-readers/lspp-standard-repeat-readers.json");
const descriptors = require("../../fixtures/public-behavior/standard-repeat-fields.json");
// Original 4.14 input/returned bytes: seatbelt-sbrid-formats-native, two records per format.
const seatbeltInputs = {
    standard: ['  979001       0       0       0  987100               0       0       0', '  979002       0       0       0  987101               0       0       0'],
    comma: ['979003,0,0,0,987100,0,0,0', '979004,0,0,0,987101,0,0,0'],
    long: ['              979005                   0                   0                   0              987100                   0                   0                   0', '              979006                   0                   0                   0              987101                   0                   0                   0'],
    i10: ['    979007         0         0         0    987100               0         0         0', '    979008         0         0         0    987101               0         0         0'],
};
const seatbeltNames = ['EID', 'PID', 'N1', 'N2', 'SBRID', 'SLEN', 'N3', 'N4'];
const seatbeltAddresses = ["record:1786cdc8dc093e114e364515:313ac0046c71448bc71fae43", "record:1786cdc8dc093e114e364515:02021cebce7434c16c7466c0", "record:1786cdc8dc093e114e364515:2b844c9ee62ee17f428f3f2e", "record:1786cdc8dc093e114e364515:d835e4056dde06b9acaa39f2", "record:1786cdc8dc093e114e364515:972fd957cfc90b16bbbe1281", "record:1786cdc8dc093e114e364515:e5093e44c07c47d8a6b1b89c", "record:1786cdc8dc093e114e364515:ee1259b422582167de95b32e", "record:1786cdc8dc093e114e364515:2cb9b86f6586c4802593b137"];
const seatbeltValues = (id, index) => [String(id), '0', '0', '0', String(987100 + index), '0', '0', '0'];
describe('native repeated records and format boundaries', () => {
    for (const keyword of Object.keys(published.bindings)) {
        const form = catalog.formForKeyword(keyword);
        const rule = { ...form.rules[form.reference.formRuleIds[0]], catalogSource: form.source };
        const nativeFields = rule.cards[0].fields.map(field => descriptors[field.fieldRecordId]);
        const seatbelt = keyword === 'ELEMENT_SEATBELT';
        const row = value => {
            const text = Array(Math.max(...nativeFields.map(field => field.position + field.width))).fill(' ');
            for (const field of nativeFields) text.splice(field.position, field.width,
                ...String(field.position ? 1 : value).padStart(field.width));
            return text.join('');
        };
        for (const count of [1, 2, 3]) for (const comments of [[], ['$# WRONG, TITLE', '$ 中文说明']]) {
            it(`${keyword}: ${count} records, ${comments.length} comments, editable fields agree with Hover`, () => {
                const lines = ['*' + keyword, ...Array.from({ length: count }, (_, index) => [...comments, row(index + 1)]).flat(), '*END'];
                const document = documentFor(lines);
                const model = api.buildKeywordOptionViewModel(editorFor(document), 0, {});
                const view = api.buildKeywordOptionsViewState(model);
                assert.equal(view.canApply, false);
                assert.equal(model.managerCards.length, count);
                assert.equal(model.plan.status, 'no-change');
                assert.deepEqual(model.choices.map(choice => choice.targetKeyword), ['*' + keyword]);
                const fields = model.managerCards.flatMap(card => card.fields);
                assert.equal(new Set(fields.map(field => field.fieldId)).size, fields.length);
                for (const card of model.managerCards) {
                    assert.equal(card.editable, true);
                    const hover = api.getCardInfoForDocumentLineWithSuggest(document, card.line).cardInfo;
                    assert.deepEqual(hover.card.map(field => field.n), card.fields.map(field => field.name));
                    assert.deepEqual(card.fields.map(field => field.value), nativeFields.map(field =>
                        lines[card.line].slice(field.position, field.position + field.width).trim()));
                }
                assert.deepEqual(model.managerCards.map(card => card.fields[0].value), Array.from({ length: count }, (_, index) => String(index + 1)));
                const drafted = api.buildKeywordOptionViewModel(editorFor(document), 0, api.keywordManagerEditField(model, fields[0].fieldId, '999'));
                assert.equal(api.buildKeywordOptionsViewState(drafted).canApply, true);
            });
        }
        for (const [marker, global, rows] of [
            [' +', 'standard', [row(1)]], [' %', 'standard', [row(1)]],
            ['', 'long', [row(1)]], ['', 'i10', [row(1)]],
            ['', 'standard', [row(1), '2,1']],
        ]) it(`${keyword}: ${seatbelt ? 'reads observed formats' : 'blocks'} ${marker || global} / ${rows.at(-1).includes(',') ? 'comma' : 'fixed'}`, () => {
            const format = marker === ' +' || global === 'long' ? 'long' : marker === ' %' || global === 'i10' ? 'i10' : 'comma';
            const source = seatbelt ? format === 'comma' ? [seatbeltInputs.standard[0], seatbeltInputs.comma[1]] : seatbeltInputs[format] : rows;
            const context = nativeFileReadContext(rule, '*' + keyword + marker, source, global);
            if (seatbelt) {
                assert.equal(context.readInputFailure, undefined);
                const selected = context.select();
                assert.deepEqual(selected.current, [0, 1].map(instanceStart => ({ cardIndex: 1, instanceStart, key: `instance:${instanceStart}:card:1` })));
                assert.deepEqual(selected.target, selected.current);
                assert.deepEqual(selected.counts, [1, 1]);
                assert.deepEqual(context.select(true), selected);
                assert.equal(context.writeCompatible(selected.current), true);
                const ids = format === 'long' ? [979005, 979006] : format === 'i10' ? [979007, 979008] : [979001, 979004];
                assert.deepEqual(source.map((text, index) => seatbeltNames.map((_name, field) => context.read(text, 1, field))), ids.map(seatbeltValues));
                assert.deepEqual(context.cards.get(1).fields.map(field => field.fieldRecordId), seatbeltAddresses);
                return;
            }
            assert.ok(context.readInputFailure);
            assert.equal(context.select(), null);
            assert.equal(context.select(true), null);
            assert.equal(context.read(rows[0], 1, 0), '');
            assert.equal(context.writeCompatible([{ cardIndex: 1 }]), false);
        });
        it(`${keyword}: respects a local standard override`, () => {
            const context = nativeFileReadContext(rule, '*' + keyword + ' -', [row(1), row(2)], 'long');
            assert.equal(context.readInputFailure, undefined);
            assert.equal(context.select().current.length, 2);
            assert.equal(context.writeCompatible(context.select().current), true);
        });
        for (const [marker, value] of [[' +', row(1)], [' %', row(1)], ['', '1,2,3']]) {
            it(`${keyword}: ${seatbelt ? 'observed formats agree through Hover and manager' : 'unsupported formats cannot bypass the Hover ordinal fast path or manager protection'} (${marker || 'comma'})`, () => {
                const format = marker === ' +' ? 'long' : marker === ' %' ? 'i10' : 'comma';
                const document = documentFor(['*' + keyword + marker, ...(seatbelt ? seatbeltInputs[format] : [value]), '*END']);
                const hover = api.getCardInfoForDocumentLineWithSuggest(document, 1);
                if (seatbelt) {
                    const model = api.buildKeywordOptionViewModel(editorFor(document), 0, {});
                    const ids = format === 'long' ? [979005, 979006] : format === 'i10' ? [979007, 979008] : [979003, 979004];
                    const positions = format === 'long' ? [0, 20, 40, 60, 80, 100, 120, 140] : format === 'i10' ? [0, 10, 20, 30, 40, 50, 66, 76] : [0, 7, 9, 11, 13, 20, 22, 24];
                    const widths = format === 'long' ? Array(8).fill(20) : format === 'i10' ? [10, 10, 10, 10, 10, 16, 10, 10] : [6, 1, 1, 1, 6, 1, 1, 1];
                    assert.equal(model.managerCards.length, 2);
                    assert.equal(model.plan.status, 'no-change');
                    assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
                    assert.equal(new Set(model.managerCards.flatMap(card => card.fields.map(field => field.fieldId))).size, 16);
                    for (const [index, card] of model.managerCards.entries()) {
                        const info = api.getCardInfoForDocumentLineWithSuggest(document, index + 1).cardInfo;
                        assert.equal(info.nativeInstanceStart, index);
                        assert.equal(info.inputFormat, format);
                        assert.deepEqual(info.card.map(field => field.nativeIdentity.fieldRecordId), seatbeltAddresses);
                        assert.deepEqual(info.card.map(field => field.n), seatbeltNames);
                        assert.deepEqual(info.card.map(field => field.rawValue), seatbeltValues(ids[index], index));
                        assert.deepEqual(info.card.map(field => [field.p, field.w]), positions.map((position, field) => [position, widths[field]]));
                        assert.deepEqual(info.card.map(field => field.nativeRange), positions.map((position, field) => ({
                            start: position, end: position + widths[field],
                        })));
                        assert.deepEqual(card.fields.map(field => field.name), seatbeltNames);
                        assert.deepEqual(card.fields.map(field => field.value), seatbeltValues(ids[index], index));
                        assert.deepEqual(card.fields.map(field => [field.position, field.width]), format === 'comma'
                            ? nativeFields.map(field => [field.position, field.width])
                            : positions.map((position, field) => [position, widths[field]]));
                    }
                    return;
                }
                assert.equal(hover.cardInfo, null);
                assert.match(hover.reason, /format-not-supported-by-binding/);
                const model = api.buildKeywordOptionViewModel(editorFor(document), 0, {});
                assert.equal(model.managerCards.length, 0);
                assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
            });
        }
        it(`${keyword}: rejects changed executable or record pool identities`, () => {
            const document = documentFor(['*' + keyword, row(1), '*END']);
            for (const candidate of [{ ...rule, catalogSource: { ...rule.catalogSource, datasetSha256: '0'.repeat(64) } },
                { ...rule, cardSetId: '0x0' }]) {
                const context = nativeFileReadContext(candidate, '*' + keyword, [row(1)], 'standard');
                assert.equal(context.kind, 'unsupported-source');
                assert.equal(context.select(), null);
                assert.deepEqual(context.select(true), { current: [], target: [], counts: [] });
                const result = { block: api.collectOptionSwitchBlock(document, 0), plan: { targetKeyword: '*' + keyword } };
                assert.equal(api.keywordManagerPrepareCatalogInputFormLayoutForRule(document, 0, result, candidate), null);
                assert.equal(api.keywordManagerPrepareCatalogInputFormLayoutForRule(document, 0, result, candidate,
                    { [`lspp-input:${keyword}:instance:0:card:1:field:0`]: '7' },
                    { [`lspp-input:${keyword}:instance:0:card:1`]: row(7) }), null);
                assert.equal(result.currentLayout, undefined);
                assert.equal(result.targetLayout, undefined);
                assert.deepEqual(result.plan, { targetKeyword: '*' + keyword });
                assert.equal(document.getText(), ['*' + keyword, row(1), '*END'].join('\n'));
            }
        });
        it(`${keyword}: preserves a blank repeated record and stops at the next keyword`, () => {
            const model = api.buildKeywordOptionViewModel(editorFor(documentFor([
                '*' + keyword, row(1), ' '.repeat(row(1).length), row(3), '*NODE', '         9', '*END',
            ])), 0, {});
            assert.equal(model.block.records.length, 3);
            assert.equal(model.managerCards.length, 3);
            assert.ok(model.managerCards[1].fields.every(field => field.value === ''));
            assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
        });
        for (const occurrence of [0, 1, 2]) for (let fieldIndex = 0; fieldIndex < nativeFields.length; fieldIndex++) {
            it(`${keyword}: edits record ${occurrence + 1}, field ${nativeFields[fieldIndex].name} without touching other bytes`, async () => {
                const lines = ['*' + keyword, '$ first', row(1), '$# misleading title', row(2), '$ last', row(3), '*END'];
                const editor = editorFor(documentFor(lines));
                const model = api.buildKeywordOptionViewModel(editor, 0, {});
                const field = model.managerCards[occurrence].fields[fieldIndex];
                const drafts = api.keywordManagerEditField(model, field.fieldId, '7');
                assert.ok(drafts);
                const staged = api.buildKeywordOptionViewModel(editor, 0, drafts);
                assert.equal(api.buildKeywordOptionsViewState(staged).canApply, true, staged.plan.reason);
                assert.equal(editor.document.getText(), lines.join('\n'));
                const originalApply = vscode.workspace.applyEdit, originalEditor = vscode.window.activeTextEditor;
                let applied;
                vscode.window.activeTextEditor = editor;
                vscode.workspace.applyEdit = async edit => { applied = edit; return true; };
                try { await api.applyKeywordOptionViewModel({ getModel: () => staged, markStale() {} }, editor); }
                finally { vscode.workspace.applyEdit = originalApply; vscode.window.activeTextEditor = originalEditor; }
                assert.ok(applied);
                const expected = lines.slice(0, -1), descriptor = nativeFields[fieldIndex];
                const source = expected[2 + occurrence * 2];
                expected[2 + occurrence * 2] = source.slice(0, descriptor.position) + '7'.padStart(descriptor.width) + source.slice(descriptor.position + descriptor.width);
                assert.equal(applied.edits[0].text, expected.join('\n') + '\n');
                const reopened = api.buildKeywordOptionViewModel(editorFor(documentFor([...expected, '*END'])), 0, {});
                assert.equal(reopened.managerCards[occurrence].fields[fieldIndex].value, '7');
                for (let index = 0; index < 3; index++) if (index !== occurrence)
                    assert.deepEqual(reopened.managerCards[index].fields.map(field => field.value), model.managerCards[index].fields.map(field => field.value));
            });
        }
    }
});
