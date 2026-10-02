'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
const contract = require("../../fixtures/public-behavior/volume-record-selection.json");
const { getCatalogInputFormCatalogV4, projectNativeStringTailCards } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
const { buildKeywordOptionViewModel, keywordManagerEditField, keywordManagerHelpState, optionSwitchReplacement } = require("../../../out/extension")._internals;
const keyword = contract.recordSelection.keyword;
const sourceLines = lines => {
    return { languageId: 'lsdyna', version: 1, eol: 1, lineCount: lines.length,
        uri: vscode.Uri.file('D:/temp/native-volume.k'),
        lineAt: i => ({ text: lines[i] }), getText: () => lines.join('\n') };
};
const source = (rows, marker = '') => sourceLines([`*${keyword}${marker}`, ...rows, '*END']);
const modelFor = (document, options = {}, line = 0) => buildKeywordOptionViewModel({ document,
    selection: { active: new vscode.Position(line, 0) } }, line, options);

describe('native VOLUME prefix plus one GEOM record', () => {
    it('loads the published twelve-branch relation and its native record behavior', () => {
        const form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
        const rule = form.rules[form.reference.formRuleIds[0]];
        assert.deepEqual(rule.recordSelection.cases, contract.recordSelection.cases);
        assert.equal(rule.recordSelection.cards.length, 13);
        assert.equal(rule.recordSelection.recordBehavior.recordsPerInstance, 2);
        assert.equal(rule.recordSelection.recordBehavior.keywordHeaderPerInstance, true);
        assert.deepEqual(rule.recordSelection.recordBehavior.formats, ['standard', 'comma', 'long', 'i10']);
        assert.ok(rule.recordSelection.recordBehavior.readSaveEvidenceSha256.includes(
            'e60a6eb00e7dc99deb46dec78b886230efd0548d28bbbdf64e8d46d3885eb8c6'));
    });
    it('rejects source or physical descriptor drift without mutating the original cards', () => {
        const form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
        const rule = form.rules[form.reference.formRuleIds[0]];
        const before = JSON.stringify(rule);
        const changed = structuredClone(contract);
        changed.branchFields[1].fields[2].field_record_id = '0x1';
        assert.throws(() => projectNativeStringTailCards(rule, changed, form.source.datasetSha256));
        const geometry = structuredClone(contract);
        geometry.prefixFields[0].fields[0].width += 1;
        assert.throws(() => projectNativeStringTailCards(rule, geometry, form.source.datasetSha256));
        const missing = structuredClone(contract);
        missing.recordSelection.cases.pop();
        assert.throws(() => projectNativeStringTailCards(rule, missing, form.source.datasetSha256));
        assert.throws(() => projectNativeStringTailCards(rule, contract, '0'.repeat(64)));
        for (const width of ['unknown', 0, -1, 11, 9, undefined]) {
            const invalid = structuredClone(contract);
            invalid.recordSelection.controllerReadWidth = width;
            assert.throws(() => projectNativeStringTailCards(rule, invalid, form.source.datasetSha256));
        }
        const projected = projectNativeStringTailCards(rule, contract, form.source.datasetSha256);
        const nativeBase = contract.branchFields.find(card => card.cardIndex === 2);
        const nativeBranch = contract.branchFields.find(card => card.cardIndex === 3);
        assert.notEqual(nativeBase.fields[1].help, nativeBranch.fields[1].help);
        assert.equal(projected.find(card => card.cardIndex === 3).fields[1].help, nativeBase.fields[1].help);
        assert.equal(JSON.stringify(rule), before);
    });
    const change = (document, model, row, index, value, line = 0) => {
        const staged = keywordManagerEditField(model, model.managerCards[row].fields[index].fieldId, value);
        assert.ok(staged, `edit ${row}/${index} to ${value}`);
        const next = modelFor(document, staged, line);
        assert.notEqual(next.plan.status, 'blocked', next.plan.reason);
        return next;
    };
    it('projects all twelve native GEOM cases and their help with the fixed first card', () => {
        for (const format of ['comma', 'standard']) {
        for (const item of contract.recordSelection.cases) {
            const rows = format === 'comma' ? ['1,2,3,4', `${item.value},1`]
                : [['1','2','3','4'], [item.value,'1']].map(values => values.map(value => value.padStart(10)).join(''));
            const model = modelFor(source(rows));
            assert.notEqual(model.plan.status, 'blocked', `${item.value}: ${model.plan.reason}`);
            assert.equal(model.managerCards.length, 2);
            const prefixNative = contract.prefixFields[0];
            for (const [index, field] of model.managerCards[0].fields.entries()) {
                const help = keywordManagerHelpState({ ...model, selectedFieldId: field.fieldId });
                assert.equal(help.schemaName, prefixNative.fields[index].name);
                assert.equal(help.english, /^[\s.-]*$/.test(prefixNative.fields[index].help || '')
                    ? undefined : prefixNative.fields[index].help.trim());
            }
            const native = contract.branchFields.find(card => card.cardIndex === item.cardIndex);
            const base = contract.branchFields.find(card => card.cardIndex === contract.recordSelection.controllerCardIndex);
            // The observed editor append starts at local field 2; raw reader
            // branch descriptors for GEOM/INOUT are not the editor's controls.
            const expected = [...base.fields.slice(0, 2), ...native.fields.slice(2)];
            assert.deepEqual(model.managerCards[1].fields.map(field => field.name), native.fields.map(field => field.name));
            for (const [index, field] of model.managerCards[1].fields.entries()) {
                const help = keywordManagerHelpState({ ...model, selectedFieldId: field.fieldId });
                assert.equal(help.schemaName, expected[index].name);
                assert.equal(help.english, /^[\s.-]*$/.test(expected[index].help || '')
                    ? undefined : expected[index].help.trim());
                const active = model.helpContext.nativeForm.cards.find(card => card.cardIndex === item.cardIndex);
                assert.equal(active.fields[index].fieldRecordId, expected[index].field_record_id);
            }
        }
        }
    });
    it('edits prefix field zero without treating it as GEOM and keeps prefix through a branch change', () => {
        const document = source(['1,2,3,4', 'PARTSET,1,11,12,13,14,15']);
        const prefix = change(document, modelFor(document), 0, 0, '42');
        const ellipsoid = change(document, prefix, 1, 0, 'ELLIPSOID');
        assert.equal(ellipsoid.managerCards[0].fields[0].draft, '42');
        assert.equal(ellipsoid.managerCards[1].fields[1].value, '1');
        assert.deepEqual(ellipsoid.managerCards[1].fields.slice(2, 7).map(field => field.draft), ['', '', '', '', '']);
        const reopened = modelFor(source(ellipsoid.plan.replacementRecords.map(record => record.text)));
        assert.equal(reopened.managerCards[0].fields[0].value, '42');
        assert.equal(reopened.managerCards[1].fields[0].value, 'ELLIPSOID');
        const changedTail = change(document, ellipsoid, 1, 2, '1202');
        const back = change(document, changedTail, 1, 0, 'PARTSET');
        assert.equal(back.managerCards[0].fields[0].draft, '42');
        assert.equal(back.managerCards[1].fields[1].value, '1');
        assert.deepEqual(back.managerCards[1].fields.slice(2).map(field => field.draft), ['', '', '', '', '']);
        assert.equal(modelFor(document).managerCards[0].fields[0].value, '1');
    });
    it('saves LONG branch edits with GEOM in the native first-ten-byte window and reopens the values', () => {
        // Native LONG reader still selects GEOM from its first ten bytes.
        // The recorded EXE counterexample right-aligns the token in twenty
        // bytes and corrupts tail integer interpretation; never reproduce it.
        const prefix = ['42', '', '0', '', '1', '', '', '0'].map(value => value.padStart(20)).join('');
        const geom = 'PARTSET'.padEnd(20) + ['1', '202', '2.3', '0', '0', '0'].map(value => value.padStart(20)).join('');
        const document = source([prefix, geom], ' +');
        for (const item of contract.recordSelection.cases) {
            const edited = change(document, modelFor(document), 1, 0, item.value);
            const rows = edited.plan.replacementRecords.map(record => record.text);
            assert.equal(rows[0], prefix, 'fixed first record must remain byte-identical');
            assert.equal(rows[1].slice(0, 10).trim(), item.value);
            assert.equal(rows[1].slice(10, 20), ' '.repeat(10));
            const reopened = modelFor(source(rows, ' +'));
            assert.notEqual(reopened.plan.status, 'blocked', reopened.plan.reason);
            assert.equal(reopened.managerCards[1].fields[0].value, item.value);
            assert.equal(reopened.managerCards[1].fields[1].value, '1');
            if (item.value === 'PARTSET') {
                assert.equal(reopened.managerCards[1].fields[2].value, '202');
            } else {
                assert.deepEqual(reopened.managerCards[1].fields.slice(2, 7).map(field => field.value), ['', '', '', '', '']);
            }
        }
        const ellipsoid = change(document, modelFor(document), 1, 0, 'ELLIPSOID');
        const withId = change(document, ellipsoid, 1, 2, '1202');
        const saved = withId.plan.replacementRecords.map(record => record.text);
        assert.equal(saved[1].slice(40, 60), '1202'.padStart(20));
        assert.equal(modelFor(source(saved, ' +')).managerCards[1].fields[2].value, '1202');
    });
    it('rejects LONG controller tokens outside the native read window while accepting I10', () => {
        const prefix = ['42', '', '0', '', '1', '', '', '0'].map(value => value.padStart(20)).join('');
        for (const item of contract.recordSelection.cases) {
            const invalid = item.value.padStart(20) + '1'.padStart(20);
            assert.equal(modelFor(source([prefix, invalid], ' +')).plan.status, 'blocked', item.value);
            const i10 = source(['42'.padStart(10), item.value.padEnd(10) + '1'.padStart(10)], ' %');
            const model = modelFor(i10);
            assert.notEqual(model.plan.status, 'blocked', `${item.value}: ${model.plan.reason}`);
            const saved = change(i10, model, 1, 1, '0').plan.replacementRecords.map(record => record.text);
            assert.equal(modelFor(source(saved, ' %')).managerCards[1].fields[1].value, '0');
        }
    });
    it('keeps tail values on the same native branch and rejects unknown and multi-instance input', () => {
        const document = source(['1,2,3,4', 'ELLIPSOID,1,11,12,13,14,15']);
        const model = modelFor(document);
        const same = change(document, model, 1, 0, 'ellipsoid');
        assert.deepEqual(same.managerCards[1].fields.slice(2, 7).map(field => field.value), ['11', '12', '13', '14', '15']);
        assert.equal(keywordManagerEditField(model, model.managerCards[1].fields[0].fieldId, 'UNKNOWN'), null);
        for (const rows of [[], ['1,2,3,4'], ['1,2,3,4', 'UNKNOWN,1'],
            ['1,2,3,4', 'ALL,1', '2,2,3,4', 'ALL,1']]) {
            assert.equal(modelFor(source(rows)).plan.status, 'blocked');
        }
    });
    it('edits each independently headed native instance and preserves every non-target byte through save/reopen', () => {
        // Preserve all twelve independently headed records and card comments.
        const bytes = Buffer.from(contract.deck, 'utf8');
        const original = bytes.toString('utf8').replace(/\r\n/g, '\n')
            .replace('*END', '$ non-target trailing comment\n*DATABASE_BINARY_D3PLOT\n0.25\n*END');
        const headers = original.split('\n').flatMap((line, index) => line === `*${keyword}` ? [index] : []);
        assert.equal(headers.length, 12);
        for (const [index, line] of headers.entries()) {
            const document = sourceLines(original.split('\n'));
            const base = modelFor(document, {}, line);
            assert.notEqual(base.plan.status, 'blocked', base.plan.reason);
            assert.equal(base.managerCards[1].fields[0].value, contract.recordSelection.cases[index].value);
            const edited = change(document, base, 1, 1, '1', line);
            const replacement = optionSwitchReplacement(document, edited, edited);
            assert.equal(replacement.range.start.line, line);
            assert.equal(replacement.range.start.character, 0);
            assert.equal(replacement.range.end.character, 0);
            const lines = original.split('\n');
            const before = lines.slice(0, replacement.range.start.line).join('\n') + '\n';
            const after = lines.slice(replacement.range.end.line).join('\n');
            const saved = before + replacement.text + after;
            assert.equal(saved.slice(0, before.length), before);
            assert.equal(saved.slice(saved.length - after.length), after);
            for (const record of base.block.records) for (const comment of record.comments || []) {
                assert.ok(replacement.text.includes(comment), 'source record comment must survive application');
            }
            const reopened = modelFor(sourceLines(saved.split('\n')), {}, line);
            assert.equal(reopened.managerCards[1].fields[1].value, '1');
            assert.equal(reopened.managerCards[1].fields[0].value, contract.recordSelection.cases[index].value);
            assert.deepEqual(reopened.managerCards[1].fields.slice(2).map(field => field.value),
                base.managerCards[1].fields.slice(2).map(field => field.value));
            assert.equal(reopened.managerCards[0].fields[0].value, String(index + 1));
        }
    });
});

