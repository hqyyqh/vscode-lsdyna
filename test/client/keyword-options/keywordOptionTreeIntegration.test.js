'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const fieldData = require("../../../keywords/runtime/schema/field_data.json");
const nativeFormatFixtures = {
    standard: path.join(__dirname, "../../fixtures/public-behavior/native-formats/native-standard.k"),
    long: path.join(__dirname, "../../fixtures/public-behavior/native-formats/native-long.k"),
    i10: path.join(__dirname, "../../fixtures/public-behavior/native-formats/native-i10.k"),
    free: path.join(__dirname, "../../fixtures/public-behavior/native-formats/native-free.k"),
};
const {
    loadKeywordOptionGrammarRuntime,
} = require("../../../out/core/options/keywordOptionGrammarCatalog");
const { getCatalogInputFormCatalogV4 } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
const {
    buildKeywordOptionSwitchPlan,
    buildKeywordOptionViewModel,
    keywordManagerCatalogSelectorRule,
    keywordManagerInferCatalogSelectorSelections,
    buildKeywordOptionsViewState,
    applyKeywordOptionViewModel,
    locateKeywordManagerSource,
    openKeywordManagerManual,
    generateCommentLine,
    optionSwitchReplacement,
    keywordManagerReplacementMatchesTarget,
    keywordManagerHelpState,
    keywordManagerResolveSchemaField,
    keywordManagerEditField,
    prepareKeywordManagerInstances,
} = require("../../../out/extension")._internals;

function fakeDocument(lines, version = 1) {
    return {
        languageId: 'lsdyna', version, lineCount: lines.length, eol: 1,
        uri: vscode.Uri.file('D:/temp/keyword-options.key'),
        lineAt(index) { return { text: lines[index] }; },
        getText(range) {
            if (!range) return lines.join('\n');
            if (range.start.line === range.end.line) {
                return lines[range.start.line].slice(range.start.character, range.end.character);
            }
            return lines.slice(range.start.line, range.end.line + 1).join('\n');
        },
    };
}

function editorFor(document) {
    return { document, selection: { active: new vscode.Position(0, 0) } };
}

describe('native field states with unchanged spelling selectors', () => {
    it('keeps each file spelling and M branch instead of substituting the GUI NLP form', () => {
        for (const [keyword, pool, fieldName] of [['MAT_036',"record:e33060cfb3db352b1c00e0fe:19676e89920f625312d39e04",'HTA'],
            ['MAT_3-PARAMETER_BARLAT_NLP',"record:e33060cfb3db352b1c00e0fe:ffa1f10215793311c1e4833f",'NLP']]) {
        const form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
        const native = form.reference.formRuleIds.map(id => form.rules[id])
            .find(rule => rule.cardSetId === pool);
        const rows = native.cards.flatMap((card, index) => [
            '$#' + card.fields.map((field, i) => field.name.toLowerCase().padStart(i ? 10 : 8)).join(''),
            (index === 0 ? '         1' : index === 1 ? '        -1' : '').padEnd(80),
        ]);
        const document = fakeDocument(['*' + keyword, ...rows, '*END']);
        const base = buildKeywordOptionViewModel(editorFor(document), 0, {});
        const controller = base.managerCards.flatMap(card => card.fields).find(field => field.name === 'M');
        const changed = buildKeywordOptionViewModel(editorFor(document), 0, {
            fieldDrafts: { [controller.fieldId]: '2' },
        });
        assert.equal(changed.plan.status, 'ready');
        assert.equal(changed.helpContext.nativeForm.cardSetId, pool);
        assert.equal(changed.helpContext.branchEvidence, 'native-file-reader');
        assert.deepEqual(changed.targetLayout.records.map(record => record.lsppCardIndex), [1, 2, 4, 5, 6, 7]);
        const nlp = changed.managerCards.flatMap(card => card.fields).find(field => field.name === fieldName);
        assert.ok(nlp);
        assert.equal(keywordManagerHelpState({ ...changed, selectedFieldId: nlp.fieldId }).schemaName, fieldName);
        const reset = buildKeywordOptionViewModel(editorFor(document), 0, {});
        assert.equal(reset.managerCards.length, 7);
        const title = base.controls.find(control => control.choices.some(choice => choice.value === 'TITLE'));
        const combined = buildKeywordOptionViewModel(editorFor(document), 0, {
            fieldDrafts: { [controller.fieldId]: '2' }, draftControlState: { [title.controlId]: 'TITLE' },
        });
        assert.equal(combined.plan.status, 'ready');
        assert.deepEqual(combined.targetLayout.records.map(record => record.lsppCardIndex), [0, 1, 2, 4, 5, 6, 7]);
        const combinedNlp = combined.managerCards.flatMap(card => card.fields).find(field => field.name === fieldName);
        assert.equal(keywordManagerHelpState({ ...combined, selectedFieldId: combinedNlp.fieldId }).schemaName, fieldName);
        const saved = fakeDocument([combined.targetKeyword,
            ...combined.plan.replacementRecords.flatMap(record => [...record.comments, record.text]), '*END']);
        const reopened = buildKeywordOptionViewModel(editorFor(saved), 0, {});
        assert.equal(reopened.plan.status, 'no-change', reopened.plan.reason);
        assert.deepEqual(reopened.targetLayout.records.map(record => record.lsppCardIndex), [0, 1, 2, 4, 5, 6, 7]);
        const reopenedM = reopened.managerCards.flatMap(card => card.fields).find(field => field.name === 'M');
        assert.equal(reopenedM.value, '2');
        const reopenedTitle = reopened.controls.find(control => control.choices.some(choice => choice.value === 'TITLE'));
        assert.equal(reopenedTitle.value, 'TITLE');
        const reverse = buildKeywordOptionViewModel(editorFor(saved), 0, {
            fieldDrafts: { [reopenedM.fieldId]: '-1' }, draftControlState: { [reopenedTitle.controlId]: '' },
        });
        assert.equal(reverse.plan.status, 'ready', reverse.plan.reason);
        assert.deepEqual(reverse.targetLayout.records.map(record => record.lsppCardIndex), [1, 2, 3, 4, 5, 6, 7]);
        assert.equal(document.getText(), ['*' + keyword, ...rows, '*END'].join('\n'));
        }
    });
});

describe("keyword catalog native ALE TRIM record selection", () => {
    const handoff = require("../../fixtures/public-behavior/trim-record-selection.json");
    const nativeCases = handoff.recordSelection.cases.filter(item =>
        !['SLDSET', 'SHLSET', 'BEAMSET'].includes(item.value));
    let catalog, original, sourceDrift;
    beforeEach(() => { sourceDrift = false; });
    before(() => {
        catalog = getCatalogInputFormCatalogV4();
        original = catalog.formForKeyword;
        catalog.formForKeyword = function(keyword) {
            const form = original.call(this, keyword);
            if (String(keyword).replace(/^\*/, '') !== handoff.keyword || !form || !sourceDrift) return form;
            const copy = structuredClone(form);
            for (const id of copy.reference.formRuleIds) {
                const rule = copy.rules[id];
                rule.catalogSource.datasetSha256 = '0'.repeat(64);
            }
            return copy;
        };
    });
    after(() => { catalog.formForKeyword = original; });
    const source = rows => fakeDocument([`*${handoff.keyword}`, ...rows, '*END']);
    const modelFor = (document, options = {}) => buildKeywordOptionViewModel(editorFor(document), 0, options);
    function change(document, model, row, index, value) {
        const staged = keywordManagerEditField(model, model.managerCards[row].fields[index].fieldId, value);
        assert.ok(staged);
        const next = modelFor(document, { ...staged, selectedFieldId: model.managerCards[row].fields[index].fieldId });
        assert.notEqual(next.plan.status, 'blocked', next.plan.reason);
        return next;
    }
    it('projects every supported file option independently in a mixed source and uses native help', () => {
        const rows = nativeCases.map((item, i) => `${i+1},${item.value},,,${101+i},${201+i},${301+i},${401+i}`);
        const document = source(rows), model = modelFor(document);
        assert.notEqual(model.plan.status, 'blocked', model.plan.reason);
        assert.equal(model.managerCards.length, rows.length);
        for (const [i, item] of nativeCases.entries()) {
            const expected = handoff.cards.find(card => card.cardIndex === item.cardIndex);
            const card = model.managerCards[i];
            assert.deepEqual(card.fields.map(field => field.name), expected.fields.map((field, index) =>
                index === 3 && item.cardIndex > 1 ? 'OUT/IN' : field.name));
            assert.equal(card.fields[1].value, item.value);
            assert.equal(card.fields[4].value, String(101+i));
            const help = keywordManagerHelpState({ ...model, selectedFieldId: card.fields[4].fieldId });
            assert.equal(help.english, expected.fields[4].help.trim(), JSON.stringify({ i, help, cardIndex: card.cardIndex, field: card.fields[4], record: model.targetLayout.records[i] }));
        }
        assert.equal(new Set(model.managerCards.flatMap(card => card.fields.map(field => field.fieldId))).size, rows.length*8);
        assert.equal(document.getText(), [`*${handoff.keyword}`, ...rows, '*END'].join('\n'));
    });
    it('rejects A → B migration without losing tail drafts, restores A, resets and reopens a supported edit', async () => {
        const document = source(['1,PARTSET,,,101,201,301,401', '2,SEGSET,,,102,202,302,402']);
        const base = modelFor(document);
        const before = document.getText(), edited = change(document, base, 0, 4, '42');
        const psidId = base.managerCards[0].fields[4].fieldId;
        const sphereDraft = keywordManagerEditField(edited, base.managerCards[0].fields[1].fieldId, 'SPHERE');
        const sphere = modelFor(document, sphereDraft);
        assert.equal(sphere.plan.status, 'blocked');
        assert.equal(sphere.plan.reason, 'lspp-input-form-field-draft-invalid');
        assert.deepEqual(sphere.plan.replacementRecords, []);
        assert.equal(sphere.fieldDrafts[psidId], '42');
        assert.equal(buildKeywordOptionsViewState(sphere).canApply, false);
        assert.equal(buildKeywordOptionsViewState(sphere).preview, null);
        const originalApply = vscode.workspace.applyEdit;
        let writes = 0;
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        try {
            assert.equal(await applyKeywordOptionViewModel({ getModel: () => sphere, markStale() {} }, editorFor(document)), null);
            assert.equal(writes, 0);
        } finally { vscode.workspace.applyEdit = originalApply; }
        const back = change(document, sphere, 0, 1, 'PARTSET');
        assert.equal(back.fieldDrafts[psidId], '42');
        assert.deepEqual(back.managerCards[0].fields.slice(4).map(field => field.value), ['101', '201', '301', '401']);
        assert.equal(back.managerCards[0].fields[4].draft, '42');
        assert.equal(back.plan.replacementRecords[0].text, '1,PARTSET,,,42,201,301,401');
        assert.equal(back.plan.replacementRecords[1].text, document.lineAt(2).text);
        const reset = modelFor(document);
        assert.deepEqual(reset.fieldDrafts, {});
        assert.deepEqual(reset.managerCards[0].fields.slice(4).map(field => field.value), ['101', '201', '301', '401']);
        const reopened = modelFor(source(back.plan.replacementRecords.map(record => record.text)));
        assert.equal(reopened.managerCards[0].fields[4].name, 'PSID');
        assert.equal(reopened.managerCards[0].fields[4].value, '42');
        assert.deepEqual(reopened.managerCards[0].fields.slice(5).map(field => field.value), ['201', '301', '401']);
        assert.deepEqual(reopened.managerCards[1].fields.slice(4).map(field => field.value), ['102', '202', '302', '402']);
        assert.equal(document.getText(), before);
    });
    it('preserves values for native choices sharing a card and accepts extracted case-insensitive matching', () => {
        const document = source(['2,SEGSET,,,102,202,302,402']);
        const next = change(document, modelFor(document), 0, 1, 'segset');
        assert.deepEqual(next.managerCards[0].fields.slice(4).map(field => field.value), ['102', '202', '302', '402']);
        assert.equal(Object.keys(next.fieldDrafts).length, 1);
    });
    it('rejects unknown and GUI-only choices during preparation without inventing a branch', async () => {
        const document = source(['1,PARTSET,,,101']);
        const base = modelFor(document);
        const before = document.getText(), optionId = base.managerCards[0].fields[1].fieldId;
        const originalApply = vscode.workspace.applyEdit;
        let writes = 0;
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        try {
            for (const value of ['UNKNOWN', 'SLDSET', 'SHLSET', 'BEAMSET']) {
                const staged = keywordManagerEditField(base, optionId, value);
                assert.equal(staged.fieldDrafts[optionId], value);
                const draft = modelFor(document, staged);
                assert.equal(draft.plan.status, 'blocked');
                assert.equal(draft.plan.reason, 'lspp-input-form-field-draft-invalid');
                assert.deepEqual(draft.plan.replacementRecords, []);
                assert.equal(buildKeywordOptionsViewState(draft).canApply, false);
                assert.equal(buildKeywordOptionsViewState(draft).preview, null);
                assert.equal(await applyKeywordOptionViewModel({ getModel: () => draft, markStale() {} }, editorFor(document)), null);
                const unreadable = modelFor(source([`1,${value},,,101`]));
                assert.equal(unreadable.plan.status, 'blocked');
                assert.equal(unreadable.plan.reason, 'lspp-input-form-source-layout-unresolved');
                assert.deepEqual(unreadable.plan.replacementRecords, []);
                assert.deepEqual(unreadable.managerCards, []);
            }
            assert.equal(writes, 0);
        } finally { vscode.workspace.applyEdit = originalApply; }
        assert.equal(document.getText(), before);
    });
    it('rejects source identity drift even when the static spelling layout fits', () => {
        sourceDrift = true;
        const rows = nativeCases.map((item, i) => `${i+1},${item.value}`);
        const model = modelFor(source(rows));
        assert.equal(model.plan.status, 'blocked');
        assert.deepEqual(model.plan.replacementRecords, []);
    });
    it('shows no fabricated cards or help for an empty block', () => {
        const model = modelFor(source([]));
        assert.deepEqual(model.managerCards, []);
        assert.equal(model.help.status, 'none');
    });
    it('reads same-position help from each actual source branch and keeps missing native descriptions empty', () => {
        const document = source(['1,PARTSET,,,101']);
        const base = modelFor(document), id = base.managerCards[0].fields[4].fieldId;
        const before = keywordManagerHelpState({ ...base, selectedFieldId: id });
        const sphere = modelFor(source(['1,SPHERE,,,101']));
        const after = keywordManagerHelpState({ ...sphere, selectedFieldId: id });
        assert.equal(after.schemaName, 'NID');
        assert.notEqual(after.contextKey, before.contextKey);
        const absent = keywordManagerHelpState({ ...sphere, selectedFieldId: sphere.managerCards[0].fields[6].fieldId });
        assert.equal(absent.english, undefined);
        assert.equal(absent.reason, 'description-missing');
    });
    it('preserves native exported comments and all other records when editing a mixed file', () => {
        const exported = handoff.deck.trimEnd().split(/\r?\n/);
        const lines = exported.filter((text, index) => !/,(SLDSET|SHLSET|BEAMSET),/.test(text) &&
            !(text.startsWith('$') && /,(SLDSET|SHLSET|BEAMSET),/.test(exported[index + 1] || '')));
        const line = lines.indexOf(`*${handoff.keyword}`), document = fakeDocument(lines);
        const base = buildKeywordOptionViewModel(editorFor(document), line, {});
        assert.equal(base.plan.status, 'no-change', base.plan.reason);
        const id = base.managerCards[6].fields[4].fieldId;
        const staged = keywordManagerEditField(base, id, '43');
        const edited = buildKeywordOptionViewModel(editorFor(document), line, staged);
        assert.equal(edited.plan.status, 'ready');
        for (let index = 0; index < 6; index++) {
            assert.equal(edited.plan.replacementRecords[index].text, base.block.records[index].text);
            assert.deepEqual(edited.plan.replacementRecords[index].comments, base.block.records[index].comments);
        }
        assert.deepEqual(edited.plan.replacementRecords[6].comments, base.block.records[6].comments);
        assert.equal(edited.plan.replacementRecords[6].text, '10,SPHERE,,,43');
        assert.equal(document.getText(), lines.join('\n'));
    });
});

function fixedCard(card, values = {}) {
    const characters = Array(80).fill(' ');
    for (const field of card) {
        if (!Object.hasOwn(values, field.n)) continue;
        const value = String(values[field.n]);
        const start = field.p + field.w - value.length;
        for (let index = 0; index < value.length; index++) characters[start + index] = value[index];
    }
    return characters.join('');
}

function longCard(card, values = {}) {
    const characters = Array(160).fill(' ');
    for (const field of card) {
        if (!Object.hasOwn(values, field.n)) continue;
        const value = String(values[field.n]);
        const start = field.p * 2 + field.w * 2 - value.length;
        for (let index = 0; index < value.length; index++) characters[start + index] = value[index];
    }
    return characters.join('');
}

function winfrithDocument({ rate = 8, cards = 2, keyword = '*MAT_WINFRITH_CONCRETE',
    globalHeader = null, comma = false, version = 1 } = {}) {
    const entry = fieldData.MAT_WINFRITH_CONCRETE;
    const records = entry.c.slice(0, cards).map((card, index) => fixedCard(card,
        index === 0 ? { MID: 1 } : index === 1 ? { RATE: rate } : {}));
    if (comma && records[1]) records[1] = `0,0,0,0,${rate}`;
    const lines = [keyword, ...records, '*END'];
    if (globalHeader) lines.unshift(globalHeader);
    return { document: fakeDocument(lines, version), keywordLine: globalHeader ? 1 : 0 };
}

function barlatDocument({ fit = 0, hard = 1, a = 0 } = {}) {
    const cards = fieldData.MAT_BARLAT_YLD2000.c;
    const visible = [0, 1, ...(a < 0 ? [2] : []), ...(fit === 0 ? [3] : [4, 5]),
        ...(hard === 3 ? [9, 10, 11] : []), 6, 7, 8];
    return fakeDocument(['*MAT_BARLAT_YLD2000', ...visible.map(index => fixedCard(cards[index],
        index === 0 ? { MID: 1, FIT: fit } : index === 1 ? { HARD: hard, A: a } : {})), '*END']);
}

function nativeMaterialDocument(keyword, visibleCardIndexes, values = {}) {
    const cards = fieldData[keyword].c;
    return fakeDocument([`*${keyword}`, ...visibleCardIndexes.map(cardIndex =>
        fixedCard(cards[cardIndex - 1] || [], values[cardIndex] || {})), '*END']);
}

describe('persistent official keyword option integration', () => {
    let previousUnaudited;
    before(() => {
        previousUnaudited = process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG;
        process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG = '1';
    });
    after(() => {
        if (previousUnaudited === undefined) {
            delete process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG;
        } else {
            process.env.DYNASENSE_ALLOW_UNAUDITED_CATALOG = previousUnaudited;
        }
    });

    it('retains the old GUI-expanded counterexamples as blocked inputs', () => {
        const invalid = [
            fakeDocument(['*MAT_001', '         1'.padEnd(80), ''.padEnd(80)]),
            nativeMaterialDocument('MAT_036', [1,2,3,4,5,6,7], {1:{MID:1},2:{M:1}}),
            nativeMaterialDocument('MAT_ANISOTROPIC_HYPERELASTIC', [1,2,7,12,13,14]),
        ];
        for (const document of invalid) {
            const model = buildKeywordOptionViewModel(editorFor(document), 0, {provisional:true});
            assert.equal(model.plan.status, 'blocked', document.lineAt(0).text);
            assert.equal(buildKeywordOptionsViewState(model).canApply, false);
        }
    });

    it('rejects a staged spelling that belongs to another keyword', async () => {
        const document = barlatDocument();
        const editor = editorFor(document);
        const model = buildKeywordOptionViewModel(editor, 0, { provisional: true, targetKeyword: '*KEYWORD' });
        assert.equal(model.plan.reason, 'lspp-input-form-target-spelling-unavailable');
        assert.equal(buildKeywordOptionsViewState(model).canApply, false);
        assert.equal(await applyKeywordOptionViewModel({ getModel: () => model, markStale() {} }, editor), null);
        assert.equal(document.lineAt(0).text, '*MAT_BARLAT_YLD2000');
    });

    for (const format of ['standard', 'long', 'i10', 'free']) {
        it(`preserves title and repeated native curve rows while editing ${format}`, () => {
            const lines = fs.readFileSync(nativeFormatFixtures[format], 'utf8').split(/\r?\n/);
            const line = lines.indexOf('*DEFINE_CURVE_TITLE');
            const document = fakeDocument(lines);
            const base = buildKeywordOptionViewModel(editorFor(document), line, { provisional: true });
            assert.notEqual(base.plan.status, 'blocked', base.plan.reason);
            assert.equal(base.managerCards[0].fields[0].value, 'format curve');
            const rows = base.managerCards.filter(card => card.occurrenceIndex);
            assert.deepEqual(rows.map(card => card.occurrenceIndex), [1, 2]);
            const ordinate = rows[1].fields.find(field => field.name === 'O1');
            const model = buildKeywordOptionViewModel(editorFor(document), line, {
                provisional: true, fieldDrafts: { [ordinate.fieldId]: '0.75' },
            });
            assert.equal(model.plan.status, 'ready');
            assert.equal(model.plan.replacementRecords.length, 4);
            assert.deepEqual(model.fieldChanges.map(change => [change.name, change.after]), [['O1', '0.75']]);
            assert.equal(model.plan.replacementRecords[0].text, 'format curve');
            assert.equal(model.plan.replacementRecords[2].text, base.block.records[2].text);
        });
    }

    it('resolves a multi-form keyword only from unique source-layout evidence', () => {
        const form = getCatalogInputFormCatalogV4().formForKeyword('*MAT_230');
        const rules = form.reference.formRuleIds.map(id => form.rules[id]);
        const elastic = rules.find(rule => rule.cards[0].fields.some(field => field.name === 'E'));
        const elasticRuleId = form.reference.formRuleIds.find(id => form.rules[id] === elastic);
        const card = elastic.cards[0].fields.map(field => ({
            n: field.name, t: field.type, p: field.position, w: field.width,
        }));
        const ambiguous = buildKeywordOptionViewModel(editorFor(fakeDocument([
            '*MAT_230', fixedCard(card, { MID: 1, RO: 1, E: 2, PR: 0.3 }), '*END',
        ])), 0, { provisional: true });
        assert.equal(ambiguous.plan.reason, 'lspp-input-form-source-layout-ambiguous');
        assert.equal(ambiguous.managerCards.length, 0);
        const ambiguousState = buildKeywordOptionsViewState(ambiguous);
        assert.equal(ambiguousState.status, 'error');
        assert.match(ambiguousState.message, /input-form-\d+.*Card/);
        assert.ok(Array.isArray(ambiguousState.formCandidates));
        assert.ok(ambiguousState.formCandidates.length > 0);
        assert.equal(ambiguousState.selectedFormRuleId, null);

        const selected = buildKeywordOptionViewModel(editorFor(fakeDocument([
            '*MAT_230', fixedCard(card, { MID: 1, RO: 1, E: 2, PR: 0.3 }), '*END',
        ])), 0, { provisional: true, selectedFormRuleId: elasticRuleId });
        assert.equal(selected.plan.status, 'blocked');
        assert.equal(selected.managerCards.length, 0);
        assert.equal(buildKeywordOptionsViewState(selected).canApply, false);

        const header = generateCommentLine(card, 'dollar-hash-fixed', 'upper');
        const resolved = buildKeywordOptionViewModel(editorFor(fakeDocument([
            '*MAT_230', header, fixedCard(card, { MID: 1, RO: 1, E: 2, PR: 0.3 }), '*END',
        ])), 0, { provisional: true });
        assert.equal(resolved.plan.reason, 'lspp-input-form-source-layout-ambiguous');
        assert.equal(resolved.managerCards.length, 0);
    });

    it('recomputes LS-PrePost Barlat cards from FIT, A, and HARD drafts', async () => {
        const document = barlatDocument();
        const base = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        assert.deepEqual(base.managerCards.map(card => card.cardIndex), [1, 2, 4, 7, 8, 9]);
        const fit = base.managerCards[0].fields.find(field => field.name === 'FIT');
        const alpha = base.managerCards.find(card => card.cardIndex === 4).fields[0];
        assert.ok(fit.editable);

        const fitted = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true,
            selectedFieldId: alpha.fieldId,
            fieldDrafts: { [fit.fieldId]: '1.0' },
        });
        assert.deepEqual(fitted.managerCards.map(card => card.cardIndex), [1, 2, 5, 6, 7, 8, 9]);
        assert.equal(fitted.selectedFieldId, fitted.managerCards[0].fields[0].fieldId);
        assert.equal(fitted.plan.status, 'ready');
        assert.equal(fitted.plan.replacementRecords.length, 7);
        const sig00 = fitted.managerCards.find(card => card.cardIndex === 5).fields.find(field => field.name === 'SIG00');
        const withNewField = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true,
            fieldDrafts: { [fit.fieldId]: '1.0', [sig00.fieldId]: '123' },
        });
        assert.equal(withNewField.managerCards.find(card => card.cardIndex === 5)
            .fields.find(field => field.name === 'SIG00').draft, '123');
        assert.ok(withNewField.fieldChanges.some(change => change.name === 'SIG00' && change.after === '123'));

        const hard = base.managerCards[1].fields.find(field => field.name === 'HARD');
        const hardened = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true,
            fieldDrafts: { [hard.fieldId]: '3.0' },
        });
        assert.deepEqual(hardened.managerCards.map(card => card.cardIndex), [1, 2, 4, 10, 11, 12, 7, 8, 9]);

        const aField = base.managerCards[1].fields.find(field => field.name === 'A');
        const negativeA = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true,
            fieldDrafts: { [aField.fieldId]: '-1' },
        });
        assert.deepEqual(negativeA.managerCards.map(card => card.cardIndex), [1, 2, 3, 4, 7, 8, 9]);

        const provider = { getModel: () => withNewField, markStale(uri) { this.staleUri = uri; } };
        const originalApplyEdit = vscode.workspace.applyEdit;
        const originalEditor = vscode.window.activeTextEditor;
        let edit;
        vscode.window.activeTextEditor = editorFor(document);
        vscode.workspace.applyEdit = async value => { edit = value; return true; };
        try {
            assert.ok(await applyKeywordOptionViewModel(provider, vscode.window.activeTextEditor));
            const lines = edit.edits[0].text.split(/\r?\n/);
            assert.equal(lines.length, 9, edit.edits[0].text);
            assert.equal(lines[3].slice(0, 10).trim(), '123');
        } finally {
            vscode.workspace.applyEdit = originalApplyEdit;
            vscode.window.activeTextEditor = originalEditor;
        }
    });

    it('uses physical controller identities and native defaults for hidden cards', () => {
        // Fixed manual: ISO=-3 requires its K1/K2 card; ANISO/ACTIVE are absent.
        const visible = [1, 2, 6];
        const row = values => values.map(value => String(value).padStart(10)).join('');
        const document = fakeDocument(['*MAT_ANISOTROPIC_HYPERELASTIC', row([1,1,0]), row(['ISO',-3,0,0.49]), row([1,1]), '*END']);
        const base = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        assert.deepEqual(base.managerCards.map(card => card.cardIndex), visible);
        assert.equal(base.managerCards.some(card => card.fields.some(field => field.name === 'FTYPE')), false);
        assert.notEqual(base.plan.status, 'blocked');
    });

    it('uses native material predicates beyond Barlat and resolves controllers after hidden cards', () => {
        const fabricDocument = nativeMaterialDocument('MAT_FABRIC', [1, 2, 3, 4, 5], {
            1: { MID: 1 }, 3: { FORM: 0, FVOPT: 0 },
        });
        const fabric = buildKeywordOptionViewModel(editorFor(fabricDocument), 0, { provisional: true });
        assert.deepEqual(fabric.managerCards.map(card => card.cardIndex), [1, 2, 3, 4, 5]);
        const form = fabric.managerCards[2].fields.find(field => field.name === 'FORM');
        const fvopt = fabric.managerCards[2].fields.find(field => field.name === 'FVOPT');
        const fabricChanged = buildKeywordOptionViewModel(editorFor(fabricDocument), 0, {
            provisional: true,
            fieldDrafts: { [form.fieldId]: '14', [fvopt.fieldId]: '-1' },
        });
        assert.deepEqual(fabricChanged.managerCards.map(card => card.cardIndex), [1, 2, 3, 8, 4, 5, 6]);

        const phaseDocument = nativeMaterialDocument('MAT_GENERALIZED_PHASE_CHANGE', [1, 2, 4, 5, 6, 8], {
            1: { MID: 1, N: 8 }, 2: { TASTRT: 0, TEND: 0 }, 6: { NUSHIS: 0 },
        });
        const phase = buildKeywordOptionViewModel(editorFor(phaseDocument), 0, { provisional: true });
        assert.deepEqual(phase.managerCards.map(card => card.cardIndex), [1, 2, 4, 5, 6, 8]);
        const tastrt = phase.managerCards[1].fields.find(field => field.name === 'TASTRT');
        const nushis = phase.managerCards.find(card => card.cardIndex === 6).fields.find(field => field.name === 'NUSHIS');
        const phaseChanged = buildKeywordOptionViewModel(editorFor(phaseDocument), 0, {
            provisional: true,
            fieldDrafts: { [tastrt.fieldId]: '100', [nushis.fieldId]: '1' },
        });
        assert.deepEqual(phaseChanged.managerCards.map(card => card.cardIndex), [1, 2, 3, 4, 5, 6, 7, 8]);

        const compositeBase = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
        const compositeDocument = nativeMaterialDocument(
            'MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE', compositeBase, {
                1: { MID: 1 }, 2: { VEVP: 0 }, 8: { FTYPE: 0 },
            });
        const composite = buildKeywordOptionViewModel(editorFor(compositeDocument), 0, { provisional: true });
        assert.deepEqual(composite.managerCards.map(card => card.cardIndex), compositeBase);
        const vevp = composite.managerCards[1].fields.find(field => field.name === 'VEVP');
        const ftype = composite.managerCards[7].fields.find(field => field.name === 'FTYPE');
        const compositeChanged = buildKeywordOptionViewModel(editorFor(compositeDocument), 0, {
            provisional: true, fieldDrafts: { [vevp.fieldId]: '1', [ftype.fieldId]: '2' },
        });
        assert.deepEqual(compositeChanged.managerCards.map(card => card.cardIndex),
            [1, 2, 3, 4, 5, 6, 7, 14, 15, 10, 11]);
        assert.equal(compositeChanged.managerCards[7].fields[0].name, 'FTYPE');
    });

    it('creates missing records for an empty catalog-backed form', () => {
        const model = buildKeywordOptionViewModel(editorFor(fakeDocument(['*DEFINE_CURVE'])), 0, {
            provisional: true,
        });
        const state = buildKeywordOptionsViewState(model);
        assert.equal(state.status, 'ready');
        assert.equal(state.mode, 'fields');
        assert.equal(model.managerCards.length, 2);
        assert.ok(model.managerCards.every(card => card.editable));
        assert.equal(state.canApply, true);
        assert.equal(state.editLevel, 'editable');
        assert.equal(state.capabilities.find(claim =>
            claim.capabilityId === 'fixed-field-edit').availability, 'available');
    });

    it('expands independently verified native curve point records', () => {
        const cards = fieldData.DEFINE_CURVE.c;
        const document = fakeDocument([
            '*DEFINE_CURVE',
            fixedCard(cards[0], { LCID: 3, SIDR: 0, SFA: 1, SFO: 1, DATTYP: 0, LCINT: 0 }),
            fixedCard(cards[1], { A1: 0, O1: 215 }),
            fixedCard(cards[1], { A1: 1, O1: 216 }),
            fixedCard(cards[1], { A1: 2, O1: 217 }),
        ]);
        const model = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        const state = buildKeywordOptionsViewState(model);

        assert.deepEqual(state.targets, [{ targetKeyword: '*DEFINE_CURVE', selected: true }]);
        assert.deepEqual(model.managerCards.map(card => [card.cardIndex, card.occurrenceIndex]), [
            [1, undefined], [2, 1], [2, 2], [2, 3],
        ]);
        assert.ok(model.managerCards.every(card => card.editable));
        assert.notEqual(state.status, 'error');
        assert.equal(state.capabilities.find(claim =>
            claim.capabilityId === 'repeat-card-edit').availability, 'available');

        const ordinate = model.managerCards[2].fields.find(field => field.name === 'O1');
        const staged = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true,
            fieldDrafts: { [ordinate.fieldId]: '999' },
        });
        assert.equal(staged.plan.status, 'ready');
        assert.deepEqual(staged.fieldChanges.map(change => [change.name, change.before, change.after]), [
            ['O1', '216', '999'],
        ]);
        const replacement = optionSwitchReplacement(document, staged, {
            plan: staged.plan,
            block: { blockEnd: document.lineCount, trailingComments: [] },
        });
        const replacementLines = replacement.text.split(/\r?\n/);
        assert.equal(replacementLines[2], document.lineAt(2).text);
        assert.equal(replacementLines[3].slice(20, 40).trim(), '999');
        assert.equal(replacementLines[4], document.lineAt(4).text);
    });

    it('edits long, I10 and comma/free records through the same catalog writer', () => {
        const cards = fieldData.DEFINE_CURVE.c;
        const fixtures = [
            fakeDocument(['*DEFINE_CURVE+', longCard(cards[0], { LCID: 3 }),
                longCard(cards[1], { A1: 0, O1: 215 }), '*END']),
            fakeDocument(['*KEYWORD I10=Y', '*DEFINE_CURVE', fixedCard(cards[0], { LCID: 3 }),
                fixedCard(cards[1], { A1: 0, O1: 215 }), '*END']),
            fakeDocument(['*DEFINE_CURVE', '3,0,1,1,0,0,0,0', '0, 215', '*END']),
        ];
        for (const document of fixtures) {
            const keywordLine = document.lineAt(0).text.startsWith('*KEYWORD') ? 1 : 0;
            const model = buildKeywordOptionViewModel(editorFor(document), keywordLine, { provisional: true });
            const ordinate = model.managerCards.find(card => card.cardIndex === 2)
                .fields.find(field => field.name === 'O1');
            assert.ok(ordinate.editable, ordinate.reason);
            const staged = buildKeywordOptionViewModel(editorFor(document), keywordLine, {
                provisional: true, fieldDrafts: { [ordinate.fieldId]: '999.5' },
            });
            assert.equal(staged.plan.status, 'ready', staged.plan.reason);
            assert.ok(staged.fieldChanges.some(change => change.after === '999.5'));
            const line = staged.plan.replacementRecords[1].text;
            assert.ok(line.includes('999.5'));
            if (document.lineAt(keywordLine + 2).text.includes(',')) assert.ok(line.includes(','));
        }
    });

    it('edits schema-backed fixed fields even when the keyword has no switchable spelling', () => {
        const include = fieldData.INCLUDE_TRANSFORM.c;
        const document = fakeDocument([
            '*INCLUDE_TRANSFORM',
            'test2/wall2.key',
            fixedCard(include[1], {
                IDNOFF: 10000000, IDEOFF: 10000000, IDPOFF: 10000000, IDMOFF: 10000000,
                IDSOFF: 10000000, IDFOFF: 10000000, IDDOFF: 10000000,
            }),
            fixedCard(include[2], { IDROFF: 10000000 }),
            fixedCard(include[3]),
            fixedCard(include[4], { TRANID: 1000001 }),
        ]);
        const base = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        assert.equal(base.grammar, null);
        assert.equal(base.managerCards.length, 5);
        assert.ok(base.managerCards.every(card => card.editable));
        const baseState = buildKeywordOptionsViewState(base);
        assert.equal(baseState.status, 'configuring');
        assert.equal(baseState.mode, 'fields');
        const fields = base.managerCards.flatMap(card => card.fields);
        assert.equal(fields.find(field => field.name === 'FILENAME').value, 'test2/wall2.key');
        assert.equal(fields.find(field => field.name === 'IDNOFF').value, '10000000');
        assert.equal(fields.find(field => field.name === 'TRANID').value, '1000001');

        const idnoff = fields.find(field => field.name === 'IDNOFF');
        const staged = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true,
            selectedFieldId: idnoff.fieldId,
            fieldDrafts: { [idnoff.fieldId]: '42' },
        });
        assert.equal(staged.plan.status, 'ready');
        const stagedState = buildKeywordOptionsViewState(staged);
        assert.equal(stagedState.preview.changedFields, 1);
        assert.equal(stagedState.preview.reviewLevel, 'field');
        assert.deepEqual(staged.fieldChanges.map(change => [change.name, change.before, change.after]), [
            ['IDNOFF', '10000000', '42'],
        ]);
        assert.equal(staged.help.status, 'ready');
        assert.match(staged.help.english, /Offset to node ID/i);
    });

    it('applies the no-options fixed-field path globally instead of special-casing INCLUDE_TRANSFORM', () => {
        const cards = fieldData.ALE_FSI_LOAD_TO_NODE.c;
        const document = fakeDocument([
            '*ALE_FSI_LOAD_TO_NODE',
            fixedCard(cards[0], { DT: 0.25, NSID: 12, IOPT: 1 }),
            fixedCard(cards[1], { PATH: 'output/db' }),
        ]);
        const model = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        const state = buildKeywordOptionsViewState(model);
        const fields = model.managerCards.flatMap(card => card.fields);
        assert.ok(model.managerCards.every(card => card.editable));
        assert.equal(state.status, 'configuring');
        assert.equal(state.mode, 'fields');
        assert.equal(fields.find(field => field.name === 'NSID').value, '12');
        assert.equal(fields.find(field => field.name === 'PATH').value, 'output/db');
        assert.deepEqual(fields.find(field => field.name === 'IOPT').choices, ['0', '1', '2', '3', '4']);
    });

    it('bounds large repeat blocks and reports an unavailable directory without a current BlockIndex', async () => {
        const lineCount = 1_000_002;
        const makeDocument = () => {
            let reads = 0;
            const document = fakeDocument(['*NODE']);
            document.lineCount = lineCount;
            document.lineAt = index => {
                reads++;
                return { text: index === 0 ? '*NODE' : index === lineCount - 1 ? '*END' : '1 0 0 0' };
            };
            return { document, reads: () => reads };
        };

        const indexed = makeDocument();
        const block = { keyword: 'NODE', startLine: 0, endLine: lineCount - 2, dataLineCount: lineCount - 2 };
        const blockIndex = {
            lineCount,
            findBlockAtLine: () => block,
            getOccurrences: () => [block],
        };
        const indexedModel = buildKeywordOptionViewModel(editorFor(indexed.document), 0, {
            provisional: true,
            blockIndex,
        });
        assert.equal(indexedModel.managerCards.length, 0);
        assert.notEqual(indexedModel.editLevel, 'editable');
        assert.ok(indexed.reads() < 20, `ready index should keep reads constant, got ${indexed.reads()}`);

        for (const missingIndex of [null, {
            lineCount: lineCount - 1,
            getOccurrences() { throw Error('Do not use a stale index'); },
        }]) {
            const fallback = makeDocument();
            const fallbackModel = buildKeywordOptionViewModel(editorFor(fallback.document), 0, {
                provisional: true, blockIndex: missingIndex, deferInstances: true,
            });
            assert.equal(fallbackModel.managerCards.length, 0);
            assert.notEqual(fallbackModel.editLevel, 'editable');
            assert.equal(fallbackModel.directoryStatus, 'error');
            assert.equal(fallbackModel.selectedInstanceId, null);
            assert.deepEqual(fallbackModel.managerInstances, [], 'do not invent a single-item directory');
            assert.equal(await prepareKeywordManagerInstances(fallback.document, missingIndex), false);
            const state = buildKeywordOptionsViewState(fallbackModel);
            assert.equal(state.directoryStatus, 'error');
            assert.ok(state.labels.selectorError && state.labels.selectorReload);
            assert.ok(fallback.reads() < 300, `fallback should stop at its record budget, got ${fallback.reads()}`);
        }
    });

    it('keeps a header-only joint free of invented fields and option dimensions', () => {
        const model = buildKeywordOptionViewModel(
            editorFor(fakeDocument(['*CONSTRAINED_JOINT_REVOLUTE'])), 0, { provisional: true });
        const state = buildKeywordOptionsViewState(model);
        assert.equal(state.mode, 'none');
        assert.deepEqual(model.managerCards, []);
        assert.deepEqual(state.dimensions, []);
        assert.deepEqual(state.targets, [{
            targetKeyword: '*CONSTRAINED_JOINT_REVOLUTE', selected: true,
        }]);
    });

    it('does not merge distinct EXE forms into a searchable alias family', async () => {
        const document = fakeDocument(['*AIRBAG_FLUID_AND_GAS', '1,2,3,4,5,6,7,8', '9,10,11,12,13,14,15', '*END']);
        const populated = buildKeywordOptionViewModel(editorFor(document), 0, {});
        const fields = buildKeywordOptionsViewState(populated);
        assert.equal(fields.dimensions.length, 0);
        assert.deepEqual(fields.targets, [{ targetKeyword: '*AIRBAG_FLUID_AND_GAS', selected: true }]);
        assert.equal(populated.plan.status, 'blocked');
        assert.equal(populated.plan.reason, 'native-file-write-unverified');
        assert.deepEqual(populated.plan.replacementRecords, []);
        assert.deepEqual(populated.managerCards.map(card => card.fields[0].name), ['XWINI', 'GDIR']);
        assert.ok(populated.managerCards.every(card => card.fields.every(field => !field.editable)));
        assert.equal(fields.mode, 'fields');
        assert.equal(fields.canApply, false);
        const empty = fakeDocument(['*AIRBAG_FLUID_AND_GAS']);
        const model = buildKeywordOptionViewModel(editorFor(empty), 0, {
            provisional: true,
        });
        const state = buildKeywordOptionsViewState(model);
        assert.equal(state.mode, 'none');
        assert.equal(state.dimensions.length, 0);
        assert.deepEqual(state.targets, [{ targetKeyword: '*AIRBAG_FLUID_AND_GAS', selected: true }]);
        assert.deepEqual(model.managerCards, []);
        assert.equal(state.canApply, false);
        const originalApply = vscode.workspace.applyEdit;
        let writes = 0;
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        try {
            for (const [view, source] of [[populated, document], [model, empty]]) {
                assert.equal(await applyKeywordOptionViewModel({ getModel: () => view, markStale() {} }, editorFor(source)), null);
            }
            assert.equal(writes, 0);
        } finally { vscode.workspace.applyEdit = originalApply; }
        assert.equal(document.getText(), '*AIRBAG_FLUID_AND_GAS\n1,2,3,4,5,6,7,8\n9,10,11,12,13,14,15\n*END');
        assert.equal(empty.getText(), '*AIRBAG_FLUID_AND_GAS');
    });

    it('projects the native TITLE form state without using legacy grammar', () => {
        const core = fieldData.MAT_001.c;
        const lines = [
            '*MAT_001',
            generateCommentLine(core[0]),
            fixedCard(fieldData.MAT_001.c[0], { MID: 1, E: -1 }),
            generateCommentLine(core[1]),
            ''.padEnd(80),
        ];
        const document = fakeDocument(lines);
        const base = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        const titleId = base.controls.find(control =>
            control.choices.some(choice => choice.value === 'TITLE')).controlId;
        const model = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true, draftControlState: { [titleId]: 'TITLE' },
        });
        assert.ok(model);
        assert.equal(model.plan.status, 'ready');
        assert.equal(model.targetKeyword, '*MAT_001_TITLE');
        assert.equal(model.managerCards[0].fields[0].name, 'TITLE');
    });

    it('does not add field comments when the original block has none', () => {
        const document = fakeDocument(['*MAT_001', fixedCard(fieldData.MAT_001.c[0], { MID: 1, E: -1 }), ''.padEnd(80)]);
        const base = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        const titleId = base.controls.find(control =>
            control.choices.some(choice => choice.value === 'TITLE')).controlId;
        const model = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true, draftControlState: { [titleId]: 'TITLE' },
        });
        assert.equal(model.plan.status, 'ready');
        assert.ok(model.plan.replacementRecords.every(record => record.comments.length === 0));
    });

    it('preserves a trailing standard-input override while switching the official spelling', () => {
        const document = fakeDocument(['*MAT_001-', fixedCard(fieldData.MAT_001.c[0], { MID: 1, E: -1 }), ''.padEnd(80)]);
        const base = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        const titleId = base.controls.find(control =>
            control.choices.some(choice => choice.value === 'TITLE')).controlId;
        const model = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true, draftControlState: { [titleId]: 'TITLE' },
        });
        assert.equal(model.plan.status, 'ready');
        const result = buildKeywordOptionSwitchPlan(document, 0, '*MAT_001_TITLE', null, {
            provisional: true, draftControlState: { [titleId]: 'TITLE' },
        });
        const replacement = optionSwitchReplacement(document, model, result);
        assert.match(replacement.text, /^\*MAT_001_TITLE-/);
    });

    it('switches I10, long, comma and marked spellings without rewriting the data block', () => {
        for (const [keywordLine, dataLine] of [
            ['*AIRBAG_FLUID_AND_GAS+', '1,2,3'],
            ['*AIRBAG_FLUID_AND_GAS%', 'free form data'],
            ['*AIRBAG_FLUID_AND_GAS-', '         1'],
            ['*AIRBAG_FLUID_AND_GAS', '1,2,3'],
        ]) {
            const document = fakeDocument([keywordLine, '$ user comment', dataLine, '', '*END']);
            const model = buildKeywordOptionViewModel(editorFor(document), 0, {
                targetKeyword: '*AIRBAG_FLUID_AND_GAS_ID',
                provisional: true,
            });
            const result = buildKeywordOptionSwitchPlan(document, 0, '*AIRBAG_FLUID_AND_GAS_ID', null,
                { provisional: true });
            assert.equal(result.plan.status, 'ready');
            assert.equal(result.plan.applicationMode, 'keyword-only-preserve-block');
            const replacement = optionSwitchReplacement(document, model, result);
            assert.equal(replacement.range.start.line, 0);
            assert.equal(replacement.range.end.line, 0);
            const marker = /[+%\-]$/.test(keywordLine) ? keywordLine.slice(-1) : '';
            assert.equal(replacement.text, `*AIRBAG_FLUID_AND_GAS_ID${marker}`);
            assert.equal(document.lineAt(1).text, '$ user comment');
            assert.equal(document.lineAt(2).text, dataLine);
            assert.equal(document.lineAt(4).text, '*END');
        }
    });

    it('uses only EXE-catalog form spellings instead of schema aliases', () => {
        const document = fakeDocument(['*MAT_001', fixedCard(fieldData.MAT_001.c[0], { MID: 1, E: -1 }), ''.padEnd(80)]);
        const model = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        assert.ok(model.choices.length >= 1);
        assert.ok(model.choices.some(choice => choice.enabled === true));
        assert.ok(model.choices.every(choice => choice.enabled === true));
        assert.ok(model.choices.some(choice => choice.targetKeyword === '*MAT_001'));
        assert.equal(model.choices.some(choice => choice.targetKeyword === '*MAT_ELASTIC'), true);
        assert.equal(model.grammarKind, 'lspp-input-form');
        assert.equal(buildKeywordOptionsViewState(model).capabilities.find(claim =>
            claim.capabilityId === 'spelling-switch').availability, 'available');
    });

    it('retains a verified native alias through default selectors and still honors TITLE controls', () => {
        for (const [source, target] of [['MAT_001', 'MAT_ELASTIC'], ['MAT_ELASTIC', 'MAT_001']]) {
            const document = fakeDocument([`*${source}`, fixedCard(fieldData.MAT_001.c[0], { MID: 1, E: -1 }), ''.padEnd(80)]);
            const editor = editorFor(document);
            const opened = buildKeywordOptionViewModel(editor, 0, { provisional: true });
            assert.equal(opened.targetKeyword, `*${source}`, 'Opening must not silently select another spelling');
            const staged = buildKeywordOptionViewModel(editor, 0, { provisional: true, targetKeyword: `*${target}` });
            assert.equal(staged.targetKeyword, `*${target}`);
            assert.equal(staged.plan.status, 'ready');
            assert.ok(staged.choices.find(choice => choice.targetKeyword === `*${target}`).selected);
            const title = opened.controls.find(control => control.choices.some(choice => choice.value === 'TITLE'));
            const titled = buildKeywordOptionViewModel(editor, 0, { provisional: true,
                targetKeyword: `*${target}`, draftControlState: { [title.controlId]: 'TITLE' } });
            assert.ok(titled.targetKeyword.endsWith('_TITLE'));
            assert.equal(titled.plan.status, 'ready');
            assert.equal(titled.managerCards[0].fields[0].name, 'TITLE');
        }
    });

    it('keeps a singleton catalog form without inventing an alternative', () => {
        const spelling = '*BATTERY_DATABASE_HISTORY_NODELIST_ON_ELESET';
        const model = buildKeywordOptionViewModel(editorFor(fakeDocument([spelling])), 0,
            { provisional: true });
        const state = buildKeywordOptionsViewState(model);

        assert.equal(model.grammar, null);
        assert.ok(model.inputFormSource);
        assert.equal(model.choices.length, 1);
        assert.equal(state.status, 'ready');
        assert.equal(state.canApply, true);
        assert.equal(state.capabilities.find(claim =>
            claim.capabilityId === 'layout-migration').availability, 'available');
    });

    it('packages every concrete target as writable', function () {
        const runtime = loadKeywordOptionGrammarRuntime();
        const targets = runtime.grammars.flatMap(grammar => grammar.targets);
        assert.equal(targets.length, 4475);
        assert.equal(targets.filter(target => target.writePermission === true).length, 4475);
        const document = fakeDocument(['*MAT_001', fixedCard(fieldData.MAT_001.c[0], { MID: 1, E: -1 }), ''.padEnd(80)]);
        const result = buildKeywordOptionSwitchPlan(document, 0, '*MAT_ELASTIC');
        assert.equal(result.plan.status, 'ready');
    });

    it('applies an EXE-extracted provisional TITLE form', async () => {
        const core = fieldData.MAT_001.c;
        const document = fakeDocument([
            '*MAT_001',
            generateCommentLine(core[0]),
            fixedCard(fieldData.MAT_001.c[0], { MID: 1, E: -1 }),
            generateCommentLine(core[1]),
            ''.padEnd(80),
        ], 1);
        const editor = editorFor(document);
        const base = buildKeywordOptionViewModel(editor, 0, { provisional: true });
        const titleId = base.controls.find(control =>
            control.choices.some(choice => choice.value === 'TITLE')).controlId;
        const model = buildKeywordOptionViewModel(editor, 0, {
            provisional: true,
            draftControlState: { [titleId]: 'TITLE' },
        });
        assert.ok(model);
        assert.ok(model.choices.every(choice => choice.enabled));
        assert.equal(model.plan.status, 'ready');
        assert.equal(model.managerCards[0].fields[0].name, 'TITLE');
        const provider = {
            getModel: () => model,
            markStale(uri) { this.staleUri = uri; },
        };
        const originalEditor = vscode.window.activeTextEditor;
        const originalApplyEdit = vscode.workspace.applyEdit;
        let appliedEdit = null;
        vscode.window.activeTextEditor = editor;
        vscode.workspace.applyEdit = async edit => {
            appliedEdit = edit;
            return true;
        };
        try {
            const result = await applyKeywordOptionViewModel(provider, editor);
            assert.ok(result);
            assert.ok(appliedEdit);
            assert.match(provider.staleUri, /keyword-options\.key$/);
        } finally {
            vscode.window.activeTextEditor = originalEditor;
            vscode.workspace.applyEdit = originalApplyEdit;
        }
    });

    it('does not expose the legacy post-count path when EXE selectors exist', () => {
        const document = fakeDocument([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            '$#   surfa     surfb  surfatyp  surfbtyp   saboxid   sbboxid      sapr      sbpr',
            'base 1', 'base 2', 'base 3', '$ engineer comment must stay',
        ]);
        const model = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        const state = buildKeywordOptionsViewState(model);
        assert.deepEqual(state.postChoices, []);
        assert.equal(state.controls.filter(control => control.kind === 'selector').length, 4);
    });

    it('uses native Contact MPP, thermal, and A-G selector ranges', () => {
        const cards = fieldData.CONTACT_AUTOMATIC_SURFACE_TO_SURFACE.c;
        const document = fakeDocument(['*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            ...cards.map((card, index) => fixedCard(card, index === 0 ? { SURFA: 1, SURFB: 2 } : {})), '*END']);
        const base = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        const selectorId = values => base.controls.find(control =>
            JSON.stringify(control.choices.map(choice => choice.value)) === JSON.stringify(values))
            .controlId;
        const identityId = selectorId(['ID']);
        const mppId = selectorId(['MPP1', 'MPP2']);
        const thermalId = selectorId(['Thermal', 'T_Friction']);
        const optionalId = selectorId(['A', 'AB', 'ABC', 'ABCD', 'ABCDE', 'ABCDEF', 'ABCDEFG']);
        assert.equal(new Set([identityId, mppId, thermalId, optionalId]).size, 4);
        assert.deepEqual(base.controls.find(control => control.controlId === optionalId)
            .choices.map(value => value.value), ['A', 'AB', 'ABC', 'ABCD', 'ABCDE', 'ABCDEF', 'ABCDEFG']);

        const mpp1 = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true, draftControlState: { [mppId]: 'MPP1' },
        });
        assert.equal(mpp1.targetKeyword, '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_MPP');
        assert.equal(mpp1.plan.replacementRecords.length, 4);
        assert.equal(mpp1.managerCards[0].fields[0].name, 'IGNORE');
        const mpp2 = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true, draftControlState: { [mppId]: 'MPP2' },
        });
        assert.equal(mpp2.plan.replacementRecords.length, 5);

        const identified = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true, draftControlState: { [identityId]: 'ID' },
        });
        assert.equal(identified.targetKeyword, '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_ID');
        assert.equal(identified.plan.replacementRecords.length, 4);
        assert.deepEqual(identified.managerCards[0].fields.map(field => field.name), ['CID', 'TITLE']);
        const identifiedMpp = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true,
            draftControlState: { [identityId]: 'ID', [mppId]: 'MPP1' },
        });
        assert.equal(identifiedMpp.targetKeyword,
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE_MPP_ID');
        assert.equal(identifiedMpp.plan.replacementRecords.length, 5);
        assert.equal(identifiedMpp.managerCards[0].fields[0].name, 'CID');
        assert.equal(identifiedMpp.managerCards[1].fields[0].name, 'IGNORE');

        const thermal = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true, draftControlState: { [thermalId]: 'Thermal' },
        });
        assert.equal(thermal.plan.status, 'ready');
        const thermalReplacement = optionSwitchReplacement(document, thermal, thermal);
        assert.equal(keywordManagerReplacementMatchesTarget(document, thermal, { ...thermal, inputFormProjection: { branchEvidence: 'selector' } }, thermalReplacement), true);

        const friction = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true, draftControlState: { [thermalId]: 'T_Friction' },
        });
        assert.equal(friction.plan.status, 'ready');

        const abc = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true, draftControlState: { [optionalId]: 'ABC' },
        });
        assert.equal(abc.plan.replacementRecords.length, 6);
        assert.equal(abc.managerCards.length, 6);
        assert.equal(abc.managerCards.at(-1).fields[0].name, 'IGAP');
        assert.equal(abc.controls.find(control => control.controlId === optionalId).value, 'ABC');

    });

    it('round-trips protected MPP2 syntax and unified identity without shifting base fields', () => {
        for (const keyword of ['CONTACT_AUTOMATIC_SURFACE_TO_SURFACE', 'CONTACT_AUTOMATIC_SINGLE_SURFACE',
            'CONTACT_AUTOMATIC_NODES_TO_SURFACE', 'CONTACT_SURFACE_TO_SURFACE']) {
            const cards = fieldData[keyword].c;
            const source = fakeDocument(['*' + keyword,
                ...cards.map((card, index) => fixedCard(card, index === 0 ? { [card[0].n]: 11, [card[1].n]: 22 } : {})), '*END']);
            const base = buildKeywordOptionViewModel(editorFor(source), 0, {});
            const identity = base.controls.find(c => c.choices.length === 1 && c.choices[0].value === 'ID');
            const mpp = base.controls.find(c => c.choices.some(choice => choice.value === 'MPP2'));
            const optional = base.controls.find(c => c.choices.some(choice => choice.value === 'A'));
            const build = (document, drafts = {}) => buildKeywordOptionViewModel(editorFor(document), 0,
                { draftControlState: drafts });
            const reopen = model => fakeDocument([model.targetKeyword,
                ...model.plan.replacementRecords.flatMap(r => [...r.comments, r.text]), '*END']);
            const selected = build(source, { [mpp.controlId]: 'MPP2' });
            assert.equal(selected.plan.status, 'ready', keyword + ': ' + selected.plan.reason);
            assert.equal(selected.managerCards.length, 5);
            assert.equal(new Set(selected.managerCards.map(card => card.cardId)).size, 5);
            assert.equal(selected.plan.replacementRecords[1].text[0], '&');
            assert.equal(selected.managerCards[1].fields[0].visible, false);
            assert.equal(selected.managerCards[1].fields[0].editable, false);
            assert.deepEqual(selected.plan.replacementRecords.slice(2).map(r => r.text), base.block.records.map(r => r.text));
            const replacement = optionSwitchReplacement(source, selected, selected);
            const result = { ...selected, inputFormProjection: { branchEvidence: 'selector' } };
            assert.equal(keywordManagerReplacementMatchesTarget(source, selected, result, replacement), true);
            for (const corrupted of [replacement.text.replace('&', ' '), replacement.text.replace('        11', '        99')]) {
                assert.notEqual(corrupted, replacement.text, keyword);
                assert.equal(keywordManagerReplacementMatchesTarget(source, selected, result,
                    { ...replacement, text: corrupted }), false, keyword);
            }
            const current = reopen(selected);
            assert.equal(build(current).currentControlState[mpp.controlId], 'MPP2');
            assert.equal(build(current, { [mpp.controlId]: 'MPP2' }).managerCards.length, 5);
            const mpp1 = build(current, { [mpp.controlId]: 'MPP1' });
            assert.equal(mpp1.plan.replacementRecords.length, 4);
            assert.equal(mpp1.plan.requiresLossConfirmation, false);
            const clear = build(current, { [mpp.controlId]: '' });
            assert.equal(clear.plan.replacementRecords.length, 3);
            assert.deepEqual(clear.plan.replacementRecords.map(r => r.text), base.block.records.map(r => r.text));
            const mppA = build(source, { [mpp.controlId]: 'MPP1', [optional.controlId]: 'A' });
            const observedA = build(reopen(mppA));
            assert.equal(observedA.currentControlState[mpp.controlId], 'MPP1');
            assert.equal(observedA.currentControlState[optional.controlId], 'A');
            const addSecond = build(reopen(mppA), { [mpp.controlId]: 'MPP2' });
            assert.deepEqual(addSecond.plan.replacementRecords.slice(2).map(r => r.text), mppA.plan.replacementRecords.slice(1).map(r => r.text));
            const identified = build(source, { [identity.controlId]: 'ID', [mpp.controlId]: 'MPP2' });
            assert.equal(identified.plan.replacementRecords.length, 6);
            assert.equal(identified.managerCards[0].fields[0].name, 'CID');
            assert.equal(identified.plan.replacementRecords[2].text[0], '&');
            const titleSource = fakeDocument([identified.targetKeyword.replace(/_ID$/, '_TITLE'),
                '       123Wall contact'.padEnd(80), ...identified.plan.replacementRecords.slice(1).map(r => r.text), '*END']);
            const titled = build(titleSource);
            assert.equal(titled.currentControlState[identity.controlId], 'TITLE');
            assert.equal(titled.controls.find(c => c.controlId === identity.controlId).choices.length, 1);
            assert.equal(titled.managerCards[0].fields[1].value, 'Wall contact');
            const cancelled = build(titleSource, { [identity.controlId]: '' });
            assert.equal(cancelled.plan.requiresLossConfirmation, true);
            assert.deepEqual(cancelled.plan.discardedFields.map(f => f.name), ['CID', 'TITLE']);
            const reenabled = build(titleSource, { [identity.controlId]: 'TITLE' });
            assert.equal(reenabled.targetKeyword, titled.currentKeyword);
            assert.equal(reenabled.plan.replacementRecords.length, 6);
        }
    });

    it('opens CONTACT_AUTOMATIC_SINGLE_SURFACE_ID from the EXE catalog', () => {
        const cards = fieldData.CONTACT_AUTOMATIC_SINGLE_SURFACE.c;
        const document = fakeDocument([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
            `${String(10001).padStart(10)}Global Contact`.padEnd(80),
            ...cards.map((card, index) => fixedCard(card, index === 0 ? { SSID: 10001, SSTYP: 2 } : {})),
            '*END',
        ]);
        const model = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        const identity = model.controls.find(control =>
            control.choices.map(choice => choice.value).join('|') === 'ID');
        assert.ok(model.inputFormSource);
        assert.equal(model.inputFormSourceError, '');
        assert.equal(identity.value, 'ID');
        assert.equal(model.managerCards[0].fields[0].name, 'CID');
        assert.ok(['ready', 'no-change'].includes(model.plan.status));
    });

    it('keeps MPP markers at column one in supported record formats and protects their drafts', () => {
        const writer = require('../../../out/core/edit/keywordRecordSerializer');
        const cards = fieldData.CONTACT_AUTOMATIC_SURFACE_TO_SURFACE.c;
        const standard = fakeDocument(['*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE', ...cards.map(c => fixedCard(c, {})), '*END']);
        const seed = buildKeywordOptionViewModel(editorFor(standard), 0, {});
        const mppId = seed.controls.find(c => c.choices.some(v => v.value === 'MPP2')).controlId;
        for (const [format, marker] of [['standard', ''], ['long', '+'], ['i10', '%'], ['comma', ''], ['free', '']]) {
            const rows = seed.currentLayout.records.map(record => writer.writeRecordField(
                writer.blankRecord(record.fields, format), record.fields, 0, '1', format));
            const document = fakeDocument(['*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE' + marker, ...rows, '*END']);
            const selected = buildKeywordOptionViewModel(editorFor(document), 0, { draftControlState: { [mppId]: 'MPP2' } });
            assert.equal(selected.plan.status, 'ready', format + ': ' + selected.plan.reason);
            assert.equal(selected.plan.replacementRecords[1].text[0], '&', format);
            assert.deepEqual(selected.plan.replacementRecords.slice(2).map(r => r.text), rows, format);
            const source = fakeDocument([selected.targetKeyword + marker, ...selected.plan.replacementRecords.map(r => r.text), '*END']);
            const current = buildKeywordOptionViewModel(editorFor(source), 0, {});
            assert.equal(current.currentControlState[mppId], 'MPP2', format);
            const syntax = current.managerCards[1].fields[0];
            const blocked = buildKeywordOptionViewModel(editorFor(source), 0, { fieldDrafts: { [syntax.fieldId]: '4' } });
            assert.equal(buildKeywordOptionsViewState(blocked).canApply, false, format);
            const loss = buildKeywordOptionViewModel(editorFor(source), 0, {
                draftControlState: { [mppId]: 'MPP1' },
            });
            assert.equal(loss.plan.requiresLossConfirmation, false, format);
        }
    });

    it('shrinks native Contact optional cards without inventing repeated rows', () => {
        const cards = fieldData.CONTACT_AUTOMATIC_SURFACE_TO_SURFACE.c;
        const source = fakeDocument(['*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            ...cards.map((card, index) => fixedCard(card, index === 0 ? { SURFA: 1, SURFB: 2 } : {})), '*END']);
        const seed = buildKeywordOptionViewModel(editorFor(source), 0, { provisional: true });
        const id = seed.controls.find(control => control.choices.some(choice => choice.value === 'ABCDEFG')).controlId;
        const expanded = buildKeywordOptionViewModel(editorFor(source), 0, {
            provisional: true, draftControlState: { [id]: 'ABCDEF' },
        });
        assert.equal(expanded.plan.replacementRecords.length, 9);
        const reopened = fakeDocument([expanded.targetKeyword,
            ...expanded.plan.replacementRecords.flatMap(record => [...record.comments, record.text]), '*END']);
        const shrunk = buildKeywordOptionViewModel(editorFor(reopened), 0, {
            provisional: true, draftControlState: { [id]: 'ABC' },
        });
        assert.equal(shrunk.plan.status, 'ready');
        assert.equal(shrunk.plan.replacementRecords.length, 6);
        assert.equal(shrunk.managerCards.length, 6);
        const unknown = fakeDocument([expanded.targetKeyword,
            ...expanded.plan.replacementRecords.flatMap(record => [...record.comments, record.text]),
            ' '.repeat(80), ' '.repeat(80), '*END']);
        const blocked = buildKeywordOptionViewModel(editorFor(unknown), 0, {
            provisional: true, draftControlState: { [id]: 'ABC' },
        });
        assert.equal(buildKeywordOptionsViewState(blocked).canApply, false,
            'extra records without native repeat evidence must not authorize a write');
    });

    it('infers native Contact selectors after a write and reopen', () => {
        const cards = fieldData.CONTACT_AUTOMATIC_SURFACE_TO_SURFACE.c;
        const source = fakeDocument(['*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            ...cards.map((card, index) => fixedCard(card, index === 0 ? { SURFA: 1, SURFB: 2 } : {})), '*END']);
        const seed = buildKeywordOptionViewModel(editorFor(source), 0, { provisional: true });
        const ids = Object.fromEntries(seed.controls.map(control => [
            control.choices.map(choice => choice.value).join('|'),
            control.controlId,
        ]));
        const mppId = ids['MPP1|MPP2'];
        const identityId = ids['ID'];
        const thermalId = ids['Thermal|T_Friction'];
        const optionalId = ids['A|AB|ABC|ABCD|ABCDE|ABCDEF|ABCDEFG'];
        const selected = buildKeywordOptionViewModel(editorFor(source), 0, {
            provisional: true,
            draftControlState: {
                [mppId]: 'MPP1',
                [optionalId]: 'ABC',
            },
        });
        assert.equal(selected.plan.status, 'ready');
        assert.equal(buildKeywordOptionsViewState(selected).hasDrafts, true);
        const replacementRecords = selected.plan.replacementRecords.map(record => ({
            ...record, comments: [...record.comments],
        }));
        const put = (recordIndex, position, width, value) => {
            const text = replacementRecords[recordIndex].text.padEnd(80);
            replacementRecords[recordIndex].text = text.slice(0, position) +
                String(value).padStart(width) + text.slice(position + width);
        };
        put(0, 0, 10, 1);       // MPP1/IGNORE
        put(2, 0, 10, 0.5);     // Base/FS; rejects a shifted MPP2 interpretation
        put(4, 0, 10, 2);       // A/SOFT
        put(5, 0, 10, 3.5);     // B/PENMAX
        put(6, 0, 10, 4);       // C/IGAP
        const reopened = fakeDocument([
            selected.targetKeyword,
            ...replacementRecords.flatMap(record => [...record.comments, record.text]),
            '*END',
        ]);
        const selectorRule = keywordManagerCatalogSelectorRule(selected.targetKeyword);
        assert.ok(selectorRule);
        const reopenedBlock = require("../../../out/extension")._internals.collectOptionSwitchBlock(reopened, 0, {});
        const reopenedGrammar = require("../../../out/extension")._internals.buildKeywordOptionSwitchPlan(
            reopened, 0, selected.targetKeyword, null, { provisional: true },
        ).currentGrammar;
        assert.deepEqual(keywordManagerInferCatalogSelectorSelections(
            selectorRule, selected.targetKeyword, reopenedGrammar, reopenedBlock,
        ), {
            [identityId]: '', [mppId]: 'MPP1', [thermalId]: '', [optionalId]: 'ABC',
        }, JSON.stringify({ blockStatus: reopenedBlock.status, blockRecords: reopenedBlock.records?.length,
            grammar: reopenedGrammar?.canonicalSectionId,
            targets: reopenedGrammar?.targets?.map(target => [target.spelling,
                target.layouts?.map(layout => [layout.postCount, layout.layout.records.length])]) }, null, 2));
        const inferred = buildKeywordOptionViewModel(editorFor(reopened), 0, { provisional: true });
        assert.deepEqual(inferred.resolvedTargetState, {
            [identityId]: '',
            [mppId]: 'MPP1',
            [thermalId]: '',
            [optionalId]: 'ABC',
        });
        assert.deepEqual(inferred.draftControlState, {});
        assert.equal(buildKeywordOptionsViewState(inferred).hasDrafts, false);
        assert.deepEqual(Object.fromEntries(inferred.controls.map(control => [
            control.controlId, control.value,
        ])), {
            [identityId]: '',
            [mppId]: 'MPP1',
            [thermalId]: '',
            [optionalId]: 'ABC',
        });
        assert.equal(inferred.plan.status, 'no-change');
    });

    it('consumes the independently discovered ICFD form selector without a keyword branch', () => {
        const cards = fieldData.ICFD_MAT.c;
        const document = fakeDocument([
            '*ICFD_MAT',
            fixedCard(cards[0], { MID: 1, FLG: 2 }),
            '*END',
        ]);
        const base = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        const selector = base.controls.find(control =>
            control.choices.map(choice => choice.value).join(',') === 'A,AB');
        assert.ok(selector);
        const controlId = selector.controlId;
        const a = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true,
            draftControlState: { [controlId]: 'A' },
        });
        assert.equal(a.plan.status, 'ready');
        assert.equal(a.plan.replacementRecords.length, 2);
        assert.equal(a.managerCards.at(-1).fields[0].name, 'HC');
        const ab = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true,
            draftControlState: { [controlId]: 'AB' },
        });
        assert.equal(ab.plan.status, 'ready');
        assert.equal(ab.plan.replacementRecords.length, 3);
        assert.equal(ab.managerCards.at(-1).fields[0].name, 'NNMOID');
    });

    it('projects safe fixed-width fields with schema choices and a field-identity help pane', () => {
        const document = fakeDocument([
            '*SET_NODE',
            ''.padEnd(80),
            ''.padEnd(80),
        ]);
        const model = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        assert.equal(model.managerCards.length, 2);
        assert.ok(model.managerCards.every(card => card.editable));
        const solver = model.managerCards[0].fields.find(field => field.name === 'SOLVER');
        assert.ok(solver);
        assert.deepEqual(solver.choices, ['MECH', 'CESE', 'ICFD']);
        assert.equal(solver.defaultValue, 'MECH');
        const selected = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true,
            selectedFieldId: solver.fieldId,
        });
        assert.equal(selected.help.status, 'ready');
        assert.equal(selected.help.fieldId, solver.fieldId);
        assert.match(`${selected.help.english} ${selected.help.localized}`, /solver|求解器/i);
        assert.equal(selected.help.defaultValue, 'MECH');
        assert.deepEqual(selected.help.choices, ['MECH', 'CESE', 'ICFD']);
        const selectedState = buildKeywordOptionsViewState(selected);
        assert.equal(selectedState.editLevel, 'editable');
        assert.equal(selectedState.capabilities.find(claim =>
            claim.capabilityId === 'fixed-field-edit').availability, 'available');
        assert.equal(selectedState.capabilities.find(claim =>
            claim.capabilityId === 'field-help').availability, 'available');
        const choiceCapability = selectedState.capabilities.find(claim => claim.capabilityId === 'field-choice');
        assert.equal(choiceCapability.availability, 'available');
        assert.ok(choiceCapability.evidenceIds.includes(solver.fieldId));
        assert.deepEqual(selectedState.capabilities.filter(claim =>
            ['repeat-card-edit', 'special-form'].includes(claim.capabilityId)), []);

        const unused = model.managerCards[0].fields.find(field => field.name === 'UNUSED');
        const unavailable = buildKeywordOptionViewModel(editorFor(document), 0, {
            provisional: true,
            selectedFieldId: unused.fieldId,
        });
        assert.equal(unavailable.help.status, 'unavailable');
        assert.equal(unavailable.help.fieldId, unused.fieldId);
    });

    it('lists current-file instances with category metadata and repeated-keyword counts', () => {
        const document = fakeDocument([
            '*SET_NODE', ''.padEnd(80), ''.padEnd(80),
            '*MAT_001', ''.padEnd(80), ''.padEnd(80),
            '*SET_NODE', ''.padEnd(80), ''.padEnd(80),
            '*END',
        ]);
        const model = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        assert.equal(model.managerInstances.length, 2);
        const sets = model.managerInstances.filter(instance => instance.keyword === '*SET_NODE');
        assert.equal(sets.length, 2);
        assert.ok(sets.every(instance => instance.occurrenceCount === 2));
        assert.ok(sets.every(instance => instance.category));
        assert.equal(sets[0].selected, true);
        assert.equal(sets[1].reason, 'select-instance-to-evaluate');
        assert.match(sets[1].message, /select|选择/i);
    });

    it('groups confirmed title aliases, keeps unknown spellings separate and ignores target drafts', () => {
        const fixed = values => values.map(value => String(value).padStart(10)).join('');
        const document = fakeDocument(['*MAT_ELASTIC', fixed([1,7.85,210000,0.3,0,0,0,0]),
            '*MAT_ELASTIC_TITLE', 'Steel', fixed([2,2.7,70000,0.33,0,0,0,0]), '*MAT_002', ''.padEnd(80),
            '*PRIVATE_A', '1,2', '*PRIVATE_A_TITLE', 'A', '*DATABASE_SLEOUT', '0.01,1,12,0', '*END']);
        const base = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true });
        assert.deepEqual(base.managerInstances.map(item => item.keyword), ['*MAT_ELASTIC', '*MAT_ELASTIC_TITLE']);
        assert.equal(base.managerInstances[1].title, 'Steel');
        assert.deepEqual(base.managerInstances[1].identity, { field: 'MID', value: '2' });
        const staged = buildKeywordOptionViewModel(editorFor(document), 0, { provisional: true, targetKeyword: '*MAT_002' });
        assert.deepEqual(staged.managerInstances.map(item => item.instanceId), base.managerInstances.map(item => item.instanceId));
        const unknown = buildKeywordOptionViewModel(editorFor(document), 7, { provisional: true });
        assert.deepEqual(unknown.managerInstances.map(item => item.keyword), ['*PRIVATE_A']);
        const sleout = buildKeywordOptionViewModel(editorFor(document), 11, { provisional: true });
        assert.equal(sleout.managerInstances.length, 1);
        assert.equal(sleout.managerInstances[0].identity, undefined, 'LCUR is a reference');
        assert.deepEqual(sleout.managerInstances[0].summary, [{ field: 'DT', value: '0.01' }, { field: 'BINARY', value: '1' }]);
        const comma = fakeDocument(['*MAT_ELASTIC', '1,7.85,210000,0.3', '*END']);
        assert.deepEqual(buildKeywordOptionViewModel(editorFor(comma), 0).managerInstances[0].identity,
            { field: 'MID', value: '1' }, 'confirmed source reads do not require write support');
        const unverified = fakeDocument(['*MAT_DAMAGE_1', '         1', '', '', '', '', '', 'unassigned record', '*END']);
        assert.equal(buildKeywordOptionViewModel(editorFor(unverified), 0).managerInstances[0].identity, undefined);
        assert.deepEqual(buildKeywordOptionViewModel(editorFor(unverified), 0).managerInstances[0].summary, []);
    });

    it('ignores retired project injection and preserves readonly file boundaries', () => {
        const originalFs = vscode.workspace.fs;
        vscode.workspace.fs = { isWritableFileSystem: scheme => scheme !== 'locked' };
        try {
            const document = fakeDocument(['*MAT_001', fixedCard(fieldData.MAT_001.c[0], { MID: 1, E: -1 }), ''.padEnd(80)]);
            document.uri = { scheme: 'locked', fsPath: path.resolve('project', 'locked.k'), toString: () => 'locked:///locked.k' };
            document.isDirty = true;
            const model = buildKeywordOptionViewModel(editorFor(document), 0, {
                provisional: true, targetKeyword: '*MAT_001_TITLE', scope: 'project',
                managerInstances: [{ instanceId: 'foreign:0', uri: 'file:///other.k', keyword: '*MAT_001', line: 0 }],
            });
            assert.equal(model.managerInstances.length, 1);
            assert.equal(model.managerInstances[0].uri, document.uri.toString());
            assert.equal(model.managerInstances[0].dirty, true);
            assert.equal(model.managerInstances[0].readonly, true);
            const view = buildKeywordOptionsViewState(model);
            assert.equal(view.canApply, false);
            assert.ok(view.cards.flatMap(card => card.fields).every(field => field.editable === false));
            assert.ok(view.capabilities.filter(capability => capability.write)
                .every(capability => capability.availability === 'recovery'));
        } finally { vscode.workspace.fs = originalFs; }
    });

    it('locates the selected source line and opens the selected target manual chapter', async () => {
        const document = fakeDocument([
            '*SET_NODE', ''.padEnd(80), ''.padEnd(80),
            '*MAT_001', ''.padEnd(80), ''.padEnd(80),
        ]);
        const base = buildKeywordOptionViewModel(editorFor(document), 3, { provisional: true });
        const titleId = base.controls.find(control =>
            control.choices.some(choice => choice.value === 'TITLE')).controlId;
        const model = buildKeywordOptionViewModel(editorFor(document), 3, {
            provisional: true,
            draftControlState: { [titleId]: 'TITLE' },
        });
        const sourceEditor = editorFor(document);
        sourceEditor.viewColumn = vscode.ViewColumn.Two;
        let shown = null;
        let revealed = null;
        const commands = [];
        const originalShowTextDocument = vscode.window.showTextDocument;
        const originalVisibleTextEditors = vscode.window.visibleTextEditors;
        const originalExecuteCommand = vscode.commands.executeCommand;
        const originalRevealType = vscode.TextEditorRevealType;
        vscode.TextEditorRevealType = { InCenterIfOutsideViewport: 1 };
        vscode.window.visibleTextEditors = [sourceEditor];
        vscode.window.showTextDocument = async (target, options) => {
            shown = { target, options };
            return sourceEditor;
        };
        sourceEditor.revealRange = (range, revealType) => { revealed = { range, revealType }; };
        vscode.commands.executeCommand = async (...args) => { commands.push(args); };
        try {
            assert.equal(await locateKeywordManagerSource(model, sourceEditor), true);
            assert.strictEqual(shown.target, document);
            assert.equal(shown.options.viewColumn, vscode.ViewColumn.Two);
            assert.equal(sourceEditor.selection.active.line, model.structureDiagnostic?.line ?? 3);
            assert.equal(revealed.range.start.line, model.structureDiagnostic?.line ?? 3);
            assert.equal(await openKeywordManagerManual(model), true);
            assert.deepEqual(commands, [[
                'extension.manual.pickPackChapter', '*MAT_001_TITLE', 'reader',
            ]]);
            assert.equal(await locateKeywordManagerSource(null, sourceEditor), false);
            assert.equal(await openKeywordManagerManual(null), false);
        } finally {
            vscode.window.showTextDocument = originalShowTextDocument;
            vscode.window.visibleTextEditors = originalVisibleTextEditors;
            vscode.commands.executeCommand = originalExecuteCommand;
            vscode.TextEditorRevealType = originalRevealType;
        }
    });

    it('applies a fixed-field draft as one undoable WorkspaceEdit without changing the keyword', async () => {
        const document = fakeDocument([
            '*SET_NODE',
            ''.padEnd(80),
            ''.padEnd(80),
        ]);
        const editor = editorFor(document);
        const base = buildKeywordOptionViewModel(editor, 0, { provisional: true });
        const field = base.managerCards[0].fields.find(candidate => candidate.name === 'SID');
        assert.ok(field?.editable);
        const model = buildKeywordOptionViewModel(editor, 0, {
            provisional: true,
            selectedFieldId: field.fieldId,
            fieldDrafts: { [field.fieldId]: '42' },
        });
        assert.equal(model.plan.status, 'ready');
        assert.deepEqual(model.fieldChanges.map(change => change.after), ['42']);
        const state = buildKeywordOptionsViewState(model);
        assert.equal(state.canApply, true);
        assert.deepEqual(state.preview.details.fields, ['SID:  → 42']);

        const provider = {
            getModel: () => model,
            markStale(uri) { this.staleUri = uri; },
        };
        const originalEditor = vscode.window.activeTextEditor;
        const originalApplyEdit = vscode.workspace.applyEdit;
        let appliedEdit = null;
        vscode.window.activeTextEditor = editor;
        vscode.workspace.applyEdit = async edit => {
            appliedEdit = edit;
            return true;
        };
        try {
            assert.ok(await applyKeywordOptionViewModel(provider, editor));
            assert.equal(appliedEdit.edits.length, 1);
            assert.match(appliedEdit.edits[0].text, /\s+42/);
            assert.match(appliedEdit.edits[0].text, /^\*SET_NODE/);
        } finally {
            vscode.window.activeTextEditor = originalEditor;
            vscode.workspace.applyEdit = originalApplyEdit;
        }
    });

    it('rejects unsafe fixed-field drafts and does not enable apply', () => {
        const document = fakeDocument([
            '*SET_NODE',
            ''.padEnd(80),
            ''.padEnd(80),
        ]);
        const editor = editorFor(document);
        const base = buildKeywordOptionViewModel(editor, 0, { provisional: true });
        const field = base.managerCards[0].fields.find(candidate => candidate.name === 'SID');
        assert.ok(field);
        for (const value of ['12345678901', '12\n34', '12\u0000']) {
            const model = buildKeywordOptionViewModel(editor, 0, {
                provisional: true,
                fieldDrafts: { [field.fieldId]: value },
                selectedFieldId: field.fieldId,
            });
            assert.equal(model.fieldChanges.length, 0);
            assert.equal(model.fieldDrafts[field.fieldId], value);
            const view = buildKeywordOptionsViewState(model);
            assert.equal(view.hasDrafts, true);
            assert.equal(view.canApply, false);
        }
    });

    it('keeps a changed source draft visible but stale and non-applicable', () => {
        const document = fakeDocument(['*SET_NODE', '        42'.padEnd(80), ''.padEnd(80)]);
        const editor = editorFor(document);
        const base = buildKeywordOptionViewModel(editor, 0, { provisional: true });
        const field = base.managerCards[0].fields.find(candidate => candidate.name === 'SID');
        const model = buildKeywordOptionViewModel(editor, 0, {
            provisional: true,
            fieldDrafts: { [field.fieldId]: '99' },
        });
        model.stale = true;
        const view = buildKeywordOptionsViewState(model);
        assert.equal(view.status, 'stale');
        assert.equal(view.hasDrafts, true);
        assert.equal(view.canApply, false);
        assert.match(view.message, /源文件内容已变化|source changed/i);
        const relocated = buildKeywordOptionsViewState({ ...model, sourceAnchorInvalid: true });
        assert.equal(relocated.message, '');
        assert.equal(relocated.status, 'stale');
        assert.equal(relocated.hasDrafts, true);
        assert.equal(relocated.canApply, false);
    });

    it('drops a normalized no-op field draft so it does not pin the manager session', () => {
        const document = fakeDocument(['*SET_NODE', '        42'.padEnd(80), ''.padEnd(80)]);
        const editor = editorFor(document);
        const base = buildKeywordOptionViewModel(editor, 0, { provisional: true });
        const field = base.managerCards[0].fields.find(candidate => candidate.name === 'SID');
        assert.equal(field.value, '42');
        const model = buildKeywordOptionViewModel(editor, 0, {
            provisional: true,
            fieldDrafts: { [field.fieldId]: ' 42 ' },
            selectedFieldId: field.fieldId,
        });
        assert.deepEqual(model.fieldDrafts, {});
        assert.equal(model.managerCards[0].fields.find(candidate => candidate.fieldId === field.fieldId).draft, undefined);
        assert.equal(model.fieldChanges.length, 0);
        assert.equal(buildKeywordOptionsViewState(model).canApply, false);
    });

    it('enforces schema enum choices in the host staging path', () => {
        const document = fakeDocument(['*SET_NODE', ''.padEnd(80), ''.padEnd(80)]);
        const editor = editorFor(document);
        const base = buildKeywordOptionViewModel(editor, 0, { provisional: true });
        const field = base.managerCards[0].fields.find(candidate => candidate.name === 'SOLVER');
        assert.deepEqual(field.choices, ['MECH', 'CESE', 'ICFD']);
        const model = buildKeywordOptionViewModel(editor, 0, {
            provisional: true,
            fieldDrafts: { [field.fieldId]: 'NOT_A_SOLVER' },
            selectedFieldId: field.fieldId,
        });
        assert.equal(model.fieldChanges.length, 0);
        assert.equal(buildKeywordOptionsViewState(model).canApply, false);
    });

    it('blocks a field apply when the document block changes after the manager snapshot', async () => {
        const document = fakeDocument(['*SET_NODE', ''.padEnd(80), ''.padEnd(80)]);
        const editor = editorFor(document);
        const base = buildKeywordOptionViewModel(editor, 0, { provisional: true });
        const field = base.managerCards[0].fields.find(candidate => candidate.name === 'SID');
        const model = buildKeywordOptionViewModel(editor, 0, {
            provisional: true,
            fieldDrafts: { [field.fieldId]: '42' },
            selectedFieldId: field.fieldId,
        });
        const originalLineAt = document.lineAt.bind(document);
        document.lineAt = index => ({ text: index === 1 ? 'external edit'.padEnd(80) : originalLineAt(index).text });
        const provider = { getModel: () => model, markStale(uri) { this.staleUri = uri; } };
        const originalApplyEdit = vscode.workspace.applyEdit;
        let called = false;
        vscode.workspace.applyEdit = async () => { called = true; return true; };
        try {
            assert.equal(await applyKeywordOptionViewModel(provider, editor), null);
            assert.equal(called, false);
            assert.equal(provider.staleUri, document.uri.fsPath);
        } finally {
            vscode.workspace.applyEdit = originalApplyEdit;
        }
    });

    it('uses the EXE form instead of the former manual WINFRITH suffix rule', () => {
        const ready = winfrithDocument();
        const base = buildKeywordOptionViewModel(editorFor(ready.document), ready.keywordLine, { provisional: true });
        assert.equal(base.dynamicCards, undefined);
        assert.equal(base.plan.status, 'ready');
        assert.equal(base.plan.replacementRecords.length, 7);
        assert.equal(buildKeywordOptionsViewState(base).canApply, true);
    });

    it('applies a catalog field edit without merging manual dynamic-card state', async () => {
        const fixture = winfrithDocument();
        const editor = editorFor(fixture.document);
        const base = buildKeywordOptionViewModel(editor, fixture.keywordLine, { provisional: true });
        assert.equal(base.dynamicCards, undefined);
        const mid = base.managerCards[0].fields.find(field => field.name === 'MID');
        assert.ok(mid?.editable);
        const model = buildKeywordOptionViewModel(editor, fixture.keywordLine, {
            provisional: true,
            dynamicCardsSelected: true,
            fieldDrafts: { [mid.fieldId]: '42' },
            selectedFieldId: mid.fieldId,
        });
        assert.equal(model.dynamicCards, undefined);
        assert.equal(model.plan.dynamicCardChanges, undefined);
        assert.equal(model.fieldChanges.length, 1);
        assert.equal(model.plan.replacementRecords.length, 7);

        const provider = { getModel: () => model, markStale(uri) { this.staleUri = uri; } };
        const originalApplyEdit = vscode.workspace.applyEdit;
        const originalEditor = vscode.window.activeTextEditor;
        let appliedEdit = null;
        vscode.window.activeTextEditor = editor;
        vscode.workspace.applyEdit = async edit => { appliedEdit = edit; return true; };
        try {
            const applied = await applyKeywordOptionViewModel(provider, editor);
            assert.ok(applied);
            assert.strictEqual(applied.edit, appliedEdit);
            assert.equal(appliedEdit.edits.length, 1, 'one WorkspaceEdit preserves one Undo unit');
            assert.equal(applied.plan.fieldChanges[0].after, '42');
        } finally {
            vscode.window.activeTextEditor = originalEditor;
            vscode.workspace.applyEdit = originalApplyEdit;
        }
    });

    it('ignores retired dynamic-card request state', () => {
        const fixture = winfrithDocument();
        const model = buildKeywordOptionViewModel(editorFor(fixture.document), fixture.keywordLine, {
            provisional: true,
            dynamicCardsSelected: true,
        });
        assert.equal(model.dynamicCards, undefined);
        assert.equal(model.dynamicCardsSelected, false);
        assert.equal(model.session.dynamicLayoutId, null);
        assert.equal(model.plan.status, 'ready');
    });

    it('opens CONTACT_AUTOMATIC_SINGLE_SURFACE_ID with pipe comments ($ and |) and resolves all 7 cards without blocking', () => {
        const userDocument = fakeDocument([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
            '$       ID|                                                                 NAME|',
            '   8000001SingleSurface',
            '$     SSID|     MSID|     STYP|   MSTYPE|   SBOXID|   MBOXID|      SPR|     MPR|',
            '   8000001         2         0         2         0         0         0',
            '$       FS|       FD|       DC|       VC|      VDC|   PENCHK|       BT|       DT|',
            '        10        12        56      12.3       985       222        12        0.',
            '$      SFS|      SFM|      SST|      MST|     SFST|     SFMT|      FSF|      VSF|',
            '        1.        1.        0.        0.       0.9       0.9        0.        0.',
            '$     SOFT|   SOFSCL|   LCIDAB|   MAXPAR|    SBOPT|    DEPTH|    BSORT|   FRCFRQ|',
            '         2       0.1               1.025        0.         2         0         1',
            '$   PENMAX|   THKOPT|   SHLTHK|    SNLOG|     ISYM|    I2D3D|   SLDTHK|   SLDSTF|',
            '        0.         0         0         0         0         0        0.         2',
            '$     IGAP|   IGNORE|   DPRFAC|   DTSTIF|         |         |   FLANGL|  CID_RCF|',
            '         2         1        0.        0.                            0.',
            '*END',
        ]);
        const model = buildKeywordOptionViewModel(editorFor(userDocument), 0, {});
        assert.ok(model, 'model should be created');
        assert.notEqual(model.plan.status, 'blocked', `plan should not be blocked: ${model.plan.reason}`);
        assert.ok(['ready', 'no-change'].includes(model.plan.status));
        assert.equal(model.managerCards.length, 7, 'all 7 cards (ID + 3 base + 3 optional) should be resolved');

        // Check cards
        assert.equal(model.managerCards[0].fields[0].name, 'CID');
        assert.equal(model.managerCards[0].fields[1].name, 'TITLE');
        assert.equal(model.managerCards[1].fields[0].name, 'SURFA');
        const contactHelp = keywordManagerHelpState({ ...model,
            selectedFieldId: model.managerCards[1].fields[0].fieldId });
        assert.equal(contactHelp.schemaName, 'SURFA');
        assert.equal(contactHelp.schemaKeyword, 'CONTACT_AUTOMATIC_SINGLE_SURFACE');
        assert.equal(contactHelp.status, 'ready');
        const contactField = model.managerCards[1].fields[0];
        assert.equal(contactHelp.fieldId, contactField.fieldId);
        assert.deepEqual([contactField.line, contactField.position, contactField.width, contactField.value],
            [4, 0, 10, '8000001']);
        assert.equal(contactHelp.english, fieldData.CONTACT_AUTOMATIC_SINGLE_SURFACE.c[0][0].h);
        assert.ok(contactHelp.localized?.includes('从段集 ID'));

        assert.equal(model.managerCards[2].fields[0].name, 'FS');
        assert.equal(model.managerCards[3].fields[0].name, 'SFSA');
        assert.equal(model.managerCards[4].fields[0].name, 'SOFT');
        assert.equal(model.managerCards[5].fields[0].name, 'PENMAX');
        assert.equal(model.managerCards[6].fields[0].name, 'IGAP');

        // Check selectors
        const controls = model.controls || [];
        const optControl = controls.find(c => (c.choices || []).some(v => v.value === 'ABC'));
        assert.ok(optControl, 'A/ABCDEFG selector control should exist');
        assert.equal(optControl.value, 'ABC');

        const spellingControl = controls.find(c => (c.choices || []).some(v => v.value === 'ID'));
        assert.ok(spellingControl, 'ID/TITLE selector control should exist');
        assert.equal(spellingControl.value, 'ID');

        // All fields should be editable
        for (const card of model.managerCards) {
            for (const field of card.fields) {
                assert.ok(field.editable, `field ${field.name} on card ${card.cardIndex} should be editable`);
            }
        }
    });

    it('infers native Contact selectors for 7-line records with ZERO comments via domain structural precedence', () => {
        const zeroCommentsDoc = fakeDocument([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
            '   8000001SingleSurface',
            '   8000001         2         0         2         0         0         0',
            '        10        12        56      12.3       985       222        12        0.',
            '        1.        1.        0.        0.       0.9       0.9        0.        0.',
            '         2       0.1               1.025        0.         2         0         1',
            '        0.         0         0         0         0         0        0.         2',
            '         2         1        0.        0.                            0.',
            '*END',
        ]);
        const model = buildKeywordOptionViewModel(editorFor(zeroCommentsDoc), 0, {});
        assert.ok(model);
        assert.notEqual(model.plan.status, 'blocked', `plan should not be blocked: ${model.plan.reason}`);
        assert.equal(model.managerCards.length, 7, 'all 7 cards should be inferred even without comments');
        assert.equal(model.managerCards[4].fields[0].name, 'SOFT');
        assert.equal(model.currentControlState['native-selector-143e5a2be'], 'ABC');
    });

    it('edits and applies fixed fields on 7-line Contact without destroying existing pipe comments', async () => {
        const userDocument = fakeDocument([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
            '$       ID|                                                                 NAME|',
            '   8000001SingleSurface',
            '$     SSID|     MSID|     STYP|   MSTYPE|   SBOXID|   MBOXID|      SPR|     MPR|',
            '   8000001         2         0         2         0         0         0',
            '$       FS|       FD|       DC|       VC|      VDC|   PENCHK|       BT|       DT|',
            '        10        12        56      12.3       985       222        12        0.',
            '$      SFS|      SFM|      SST|      MST|     SFST|     SFMT|      FSF|      VSF|',
            '        1.        1.        0.        0.       0.9       0.9        0.        0.',
            '$     SOFT|   SOFSCL|   LCIDAB|   MAXPAR|    SBOPT|    DEPTH|    BSORT|   FRCFRQ|',
            '         2       0.1               1.025        0.         2         0         1',
            '$   PENMAX|   THKOPT|   SHLTHK|    SNLOG|     ISYM|    I2D3D|   SLDTHK|   SLDSTF|',
            '        0.         0         0         0         0         0        0.         2',
            '$     IGAP|   IGNORE|   DPRFAC|   DTSTIF|         |         |   FLANGL|  CID_RCF|',
            '         2         1        0.        0.                            0.',
            '*END',
        ]);
        const editor = editorFor(userDocument);
        const base = buildKeywordOptionViewModel(editor, 0, {});
        const softField = base.managerCards[4].fields.find(f => f.name === 'SOFT');
        assert.ok(softField);

        const edited = buildKeywordOptionViewModel(editor, 0, {
            fieldDrafts: { [softField.fieldId]: '1' },
        });
        assert.equal(edited.plan.status, 'ready');
        assert.equal(edited.plan.commentChanges.length, 0, 'existing comments should be preserved intact');

        const replacement = edited.plan.replacementRecords.map(r => r.text);
        assert.equal(replacement.length, 7);
        assert.equal(replacement[4], '         1       0.1               1.025        0.         2         0         1');

        const provider = { getModel: () => edited, markStale() {} };
        const originalApplyEdit = vscode.workspace.applyEdit;
        const originalEditor = vscode.window.activeTextEditor;
        let appliedEdit = null;
        vscode.window.activeTextEditor = editor;
        vscode.workspace.applyEdit = async edit => { appliedEdit = edit; return true; };
        try {
            const applied = await applyKeywordOptionViewModel(provider, editor);
            assert.ok(applied);
            assert.strictEqual(applied.edit, appliedEdit);
        } finally {
            vscode.window.activeTextEditor = originalEditor;
            vscode.workspace.applyEdit = originalApplyEdit;
        }
    });

    it('reopens edited 7-line Contact document and verifies stable round-trip identification', () => {
        const modifiedDocument = fakeDocument([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
            '$       ID|                                                                 NAME|',
            '   8000001SingleSurface',
            '$     SSID|     MSID|     STYP|   MSTYPE|   SBOXID|   MBOXID|      SPR|     MPR|',
            '   8000001         2         0         2         0         0         0',
            '$       FS|       FD|       DC|       VC|      VDC|   PENCHK|       BT|       DT|',
            '        10        12        56      12.3       985       222        12        0.',
            '$      SFS|      SFM|      SST|      MST|     SFST|     SFMT|      FSF|      VSF|',
            '        1.        1.        0.        0.       0.9       0.9        0.        0.',
            '$     SOFT|   SOFSCL|   LCIDAB|   MAXPAR|    SBOPT|    DEPTH|    BSORT|   FRCFRQ|',
            '         1       0.1               1.025        0.         2         0         1',
            '$   PENMAX|   THKOPT|   SHLTHK|    SNLOG|     ISYM|    I2D3D|   SLDTHK|   SLDSTF|',
            '        0.         0         0         0         0         0        0.         2',
            '$     IGAP|   IGNORE|   DPRFAC|   DTSTIF|         |         |   FLANGL|  CID_RCF|',
            '         2         1        0.        0.                            0.',
            '*END',
        ]);
        const model = buildKeywordOptionViewModel(editorFor(modifiedDocument), 0, {});
        assert.ok(model);
        assert.notEqual(model.plan.status, 'blocked');
        assert.equal(model.managerCards.length, 7);
        assert.equal(model.managerCards[4].fields.find(f => f.name === 'SOFT')?.value, '1');
        assert.equal(model.currentControlState['native-selector-143e5a2be'], 'ABC');
    });

    it('deterministically resolves full ladder of Contact optional cards (4, 5, 6, 7, 8, 11 lines) with ZERO comments', () => {
        const baseLines = [
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
            '   8000001SingleSurface',
            '   8000001         2         0         2         0         0         0',
            '        10        12        56      12.3       985       222        12        0.',
            '        1.        1.        0.        0.       0.9       0.9        0.        0.',
        ];
        const optionalCards = [
            '         2       0.1               1.025        0.         2         0         1', // Card A (SOFT=2)
            '        0.         0         0         0         0         0        0.         2', // Card B (SLDSTF=2)
            '         2         1        0.        0.                            0.',          // Card C (IGAP=2)
            '         1        0.        0.        0.        0.         0         0         0', // Card D (Q2TRI=1)
            '         0         0         0         0        0.         0        0.         0', // Card E
            '         0         0         0        0.         0         0        0.        0.', // Card F
            '                  0.',                                                               // Card G (SHLOFF in col 10-20)
        ];

        const testCases = [
            { count: 4, expectedCards: 4, expectedSelector: '' },
            { count: 5, expectedCards: 5, expectedSelector: 'A' },
            { count: 6, expectedCards: 6, expectedSelector: 'AB' },
            { count: 7, expectedCards: 7, expectedSelector: 'ABC' },
            { count: 8, expectedCards: 8, expectedSelector: 'ABCD' },
            { count: 11, expectedCards: 11, expectedSelector: 'ABCDEFG' },
        ];

        for (const tc of testCases) {
            const extra = tc.count - 4;
            const lines = [...baseLines, ...optionalCards.slice(0, extra), '*END'];
            const doc = fakeDocument(lines);
            const model = buildKeywordOptionViewModel(editorFor(doc), 0, {});
            assert.ok(model, `model should be built for count=${tc.count}`);
            assert.notEqual(model.plan.status, 'blocked', `plan should not be blocked for count=${tc.count}`);
            assert.equal(model.managerCards.length, tc.expectedCards, `cards length mismatch for count=${tc.count}`);
            assert.equal(model.currentControlState['native-selector-143e5a2be'], tc.expectedSelector,
                `selector mismatch for count=${tc.count}`);
        }
    });

    it('remains 100% robust against adversarial / misleading comments and resolves purely by data geometry', () => {
        const adversarialDoc = fakeDocument([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
            '$ MISLEADING COMMENT: MID RO E PR SIGY ETAN FAIL TDEL',
            '   8000001SingleSurface',
            '$ ANOTHER FAKE HEADER: K FRAD H0 LCH G1 BCID ALGO UNUSED',
            '   8000001         2         0         2         0         0         0',
            '$ WRONG ORDER HEADER: PENMAX THKOPT SHLTHK SNLOG ISYM I2D3D SLDTHK SLDSTF',
            '        10        12        56      12.3       985       222        12        0.',
            '$ RANDOM NOISE: 1234567890 !@#$%^&*()',
            '        1.        1.        0.        0.       0.9       0.9        0.        0.',
            '$ HELLO WORLD: FOO BAR BAZ',
            '         2       0.1               1.025        0.         2         0         1',
            '$ WRONG COMMENT: FS FD DC VC VDC PENCHK BT DT',
            '        0.         0         0         0         0         0        0.         2',
            '$ COMPLETELY UNRELATED: A B C D E F G H',
            '         2         1        0.        0.                            0.',
            '*END',
        ]);
        const model = buildKeywordOptionViewModel(editorFor(adversarialDoc), 0, {});
        assert.ok(model);
        assert.notEqual(model.plan.status, 'blocked');
        assert.equal(model.managerCards.length, 7, 'all 7 cards must be resolved despite adversarial comments');
        assert.equal(model.managerCards[4].fields[0].name, 'SOFT');
        assert.equal(model.currentControlState['native-selector-143e5a2be'], 'ABC');
        assert.equal(model.currentControlState['native-selector-143e5a495'], '', 'thermal must remain unselected');
    });

    it('isolates non-thermal keywords and refuses thermal false positives even with misleading thermal comments', () => {
        const fakeThermalDoc = fakeDocument([
            '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
            '   8000001SingleSurface',
            '   8000001         2         0         2         0         0         0',
            '        10        12        56      12.3       985       222        12        0.',
            '        1.        1.        0.        0.       0.9       0.9        0.        0.',
            '$#       k      frad        h0       lch        g1      bcid      algo',
            '         2       0.1               1.025        0.         2         0         1',
            '$#   lcfst     lcfdt   formula',
            '        0.         0         0         0         0         0        0.         2',
            '$#    soft    sofscl    lcidab    maxpar     sbopt     depth     bsort    frcfrq',
            '         2         1        0.        0.                            0.',
            '*END',
        ]);
        const model = buildKeywordOptionViewModel(editorFor(fakeThermalDoc), 0, {});
        assert.ok(model);
        assert.notEqual(model.plan.status, 'blocked');
        assert.equal(model.managerCards.length, 7);
        // Non-thermal keyword *CONTACT_AUTOMATIC_SINGLE_SURFACE_ID must NOT map to Thermal/T_Friction
        assert.equal(model.currentControlState['native-selector-143e5a2be'], 'ABC');
        assert.equal(model.currentControlState['native-selector-143e5a495'], '');
    });

    describe('keywordManagerHelpState optional and base card field resolution', () => {
        it('resolves DTSTIF help in *CONTACT_AUTOMATIC_SINGLE_SURFACE Optional Card C', () => {
            const model = {
                currentKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE',
                selectedFieldId: 'card-6-field-3',
                managerCards: [
                    {
                        cardIndex: 1,
                        fields: [
                            { fieldId: 'card-1-field-0', name: 'SSID', position: 0, width: 10 },
                            { fieldId: 'card-1-field-1', name: 'MSID', position: 10, width: 10 },
                        ],
                    },
                    {
                        cardIndex: 6,
                        fields: [
                            { fieldId: 'card-6-field-0', name: 'IGAP', position: 0, width: 10 },
                            { fieldId: 'card-6-field-1', name: 'IGNORE', position: 10, width: 10 },
                            { fieldId: 'card-6-field-2', name: 'DPRFAC', position: 20, width: 10 },
                            { fieldId: 'card-6-field-3', name: 'DTSTIF', position: 30, width: 10 },
                            { fieldId: 'card-6-field-4', name: 'EDGEK', position: 40, width: 10 },
                        ],
                    },
                ],
            };

            const help = keywordManagerHelpState(model);
            assert.ok(help, 'help object should exist');
            assert.equal(help.status, 'ready');
            assert.equal(help.name, 'DTSTIF');
            assert.equal(help.fieldId, 'card-6-field-3');
            assert.ok(help.localized && help.localized.includes('适用于 SOFT = 1、SOFT = 2 和 Mortar 接触'),
                `expected Chinese help for DTSTIF, got: ${help.localized}`);
            assert.ok(help.english && help.english.includes('Applies to the SOFT=1 and SOFT=2 and Mortar contacts'),
                `expected English help for DTSTIF, got: ${help.english}`);
        });

        it('resolves base card field SSID and FS correctly', () => {
            const model = {
                currentKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE',
                selectedFieldId: 'card-1-field-0',
                managerCards: [
                    {
                        cardIndex: 1,
                        fields: [
                            { fieldId: 'card-1-field-0', name: 'SSID', position: 0, width: 10 },
                            { fieldId: 'card-1-field-1', name: 'MSID', position: 10, width: 10 },
                        ],
                    },
                ],
            };
            const help = keywordManagerHelpState(model);
            assert.equal(help.status, 'ready');
            assert.equal(help.name, 'SSID');
            assert.ok(help.localized || help.english);
        });

        it('disambiguates identical field names across different cards based on geometry and siblings', () => {
            // IGNORE on Card C (pos 10)
            const modelCardC = {
                currentKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE',
                selectedFieldId: 'card-6-field-1',
                managerCards: [
                    {
                        cardIndex: 6,
                        fields: [
                            { fieldId: 'card-6-field-0', name: 'IGAP', position: 0, width: 10 },
                            { fieldId: 'card-6-field-1', name: 'IGNORE', position: 10, width: 10 },
                            { fieldId: 'card-6-field-2', name: 'DPRFAC', position: 20, width: 10 },
                        ],
                    },
                ],
            };
            const helpCardC = keywordManagerHelpState(modelCardC);
            assert.equal(helpCardC.status, 'ready');
            assert.equal(helpCardC.name, 'IGNORE');
            assert.ok(helpCardC.localized && helpCardC.localized.includes('针对 *CONTACT_AUTOMATIC 选项'),
                `expected Card C IGNORE help, got: ${helpCardC.localized}`);

            // IGNORE on MPP card (pos 0)
            const modelMpp = {
                currentKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE',
                selectedFieldId: 'card-mpp-field-0',
                managerCards: [
                    {
                        cardIndex: 5,
                        fields: [
                            { fieldId: 'card-mpp-field-0', name: 'IGNORE', position: 0, width: 10 },
                            { fieldId: 'card-mpp-field-1', name: 'BCKT', position: 10, width: 10 },
                        ],
                    },
                ],
            };
            const helpMpp = keywordManagerHelpState(modelMpp);
            assert.equal(helpMpp.status, 'ready');
            assert.equal(helpMpp.name, 'IGNORE');
            assert.ok(helpMpp.localized && helpMpp.localized.includes('为该接触对启用'),
                `expected MPP IGNORE help, got: ${helpMpp.localized}`);
        });

        it('resolves TITLE help via HEADING alias in *CONTACT_AUTOMATIC_SINGLE_SURFACE_ID Card 0', () => {
            const model = {
                currentKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE_ID',
                selectedFieldId: 'card-0-field-1',
                managerCards: [
                    {
                        cardIndex: 0,
                        fields: [
                            { fieldId: 'card-0-field-0', name: 'CID', position: 0, width: 10 },
                            { fieldId: 'card-0-field-1', name: 'TITLE', position: 10, width: 70 },
                        ],
                    },
                ],
            };
            const help = keywordManagerHelpState(model);
            assert.equal(help.status, 'ready');
            assert.equal(help.name, 'TITLE');
            assert.ok(help.localized && help.localized.includes('接口描述符'),
                `expected localized help for TITLE via HEADING alias, got: ${help.localized}`);
            assert.ok(help.english && help.english.includes('Interface descriptor'),
                `expected english help for TITLE via HEADING alias, got: ${help.english}`);
        });

        it('gracefully returns status unavailable for nonexistent fields', () => {
            const model = {
                currentKeyword: '*CONTACT_AUTOMATIC_SINGLE_SURFACE',
                selectedFieldId: 'card-1-field-nonexistent',
                managerCards: [
                    {
                        cardIndex: 1,
                        fields: [
                            { fieldId: 'card-1-field-nonexistent', name: 'NON_EXISTENT_FIELD_XYZ', position: 0, width: 10 },
                        ],
                    },
                ],
            };
            const help = keywordManagerHelpState(model);
            assert.equal(help.status, 'unavailable');
            assert.equal(help.reason, 'field-unmatched');
        });
    });
});


describe('branch-aware keyword manager help', () => {
    const fixtures = require("../../support/keyword-manager/help-branch-fixtures.cjs");
    function sourceFor(fixture) {
        const header = fixture.header ? ['$#' + fixture.header.map((name, index) =>
            name.padStart(index === 0 ? 8 : 10)).join('')] : [];
        return fakeDocument([`*${fixture.keyword}`, ...header, ...fixture.lines, '*END']);
    }
    for (const fixture of fixtures) it(`classifies ${fixture.id} without borrowing another branch's help`, () => {
        const document = sourceFor(fixture), before = document.getText();
        const model = buildKeywordOptionViewModel(editorFor(document), 0, {});
        if (fixture.keyword === 'MAT_230') {
            assert.equal(model.plan.reason, 'lspp-input-form-source-layout-ambiguous');
            assert.equal(model.managerCards.length, 0);
            assert.equal(model.help.reason, 'form-unresolved');
            assert.equal(document.getText(), before);
            return;
        }
        const field = model.managerCards.flatMap(card => card.fields).find(field => field.name === fixture.field);
        assert.ok(field, fixture.id);
        const help = keywordManagerHelpState({ ...model, selectedFieldId: field.fieldId });
        assert.equal(help.reason, fixture.reason, fixture.id);
        if (fixture.source) assert.equal(help.schemaKeyword, fixture.source);
        if (fixture.reason) { assert.equal(help.english, undefined); assert.equal(help.localized, undefined); }
        else assert.ok(help.english || help.localized);
        assert.ok(help.contextKey);
        assert.equal(model.selectedFormRuleId, null, 'auto-resolution must use its actual rule, not the staged selection');
        assert.equal(document.getText(), before);
        assert.ok(!Object.hasOwn(buildKeywordOptionsViewState(model), 'helpContext'));
        assert.ok(!Object.hasOwn(buildKeywordOptionsViewState(model), 'inputFormSource'));
        assert.ok(!Object.hasOwn(buildKeywordOptionsViewState(model), 'inputFormSourceError'));
    });
    it('keeps ambiguous forms unresolved even after explicit choices or comment changes', () => {
        const document = fakeDocument(['*MAT_230', fixtures[0].lines[0], '*END']);
        const initial = buildKeywordOptionViewModel(editorFor(document), 0, {});
        assert.equal(initial.help.reason, 'form-unresolved');
        const catalog = getCatalogInputFormCatalogV4().formForKeyword('MAT_230');
        const sources = [];
        for (const ruleId of catalog.reference.formRuleIds) {
            const model = buildKeywordOptionViewModel(editorFor(document), 0, { selectedFormRuleId: ruleId });
            assert.equal(model.managerCards.length, 0);
            assert.equal(model.help.reason, 'form-unresolved');
            assert.equal(buildKeywordOptionsViewState(model).canApply, false);
        }
        assert.equal(buildKeywordOptionViewModel(editorFor(document), 0, {}).help.reason, 'form-unresolved');
    });
    it('rejects unverified OPTION branch drafts without borrowing help or writing, and restores help on reset', async () => {
        const document = sourceFor(fixtures.find(f => f.id === 'trim-partset'));
        const base = buildKeywordOptionViewModel(editorFor(document), 0, {});
        const fields = base.managerCards[0].fields, field = fields.find(f => f.name === 'PSID'), option = fields.find(f => f.name === 'OPTION');
        const baseHelp = keywordManagerHelpState({ ...base, selectedFieldId: field.fieldId });
        const before = document.getText(), originalApply = vscode.workspace.applyEdit;
        let writes = 0;
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        try {
            const record = base.targetLayout.records[0];
            const sphereLine = fixtures.find(f => f.id === 'trim-sphere').lines[0];
            for (const staged of [keywordManagerEditField(base, option.fieldId, 'SPHERE'),
                { recordDrafts: { [record.recordMigrationId]: sphereLine } }]) {
                assert.ok(staged);
                const draft = buildKeywordOptionViewModel(editorFor(document), 0, { ...staged, selectedFieldId: field.fieldId });
                assert.equal(draft.plan.status, 'blocked');
                assert.equal(draft.plan.reason, 'lspp-input-form-field-draft-invalid');
                assert.deepEqual(draft.plan.replacementRecords, []);
                assert.equal(buildKeywordOptionsViewState(draft).canApply, false);
                assert.equal(draft.help.schemaName, baseHelp.schemaName);
                assert.equal(draft.help.english, baseHelp.english);
                assert.equal(await applyKeywordOptionViewModel({ getModel: () => draft, markStale() {} }, editorFor(document)), null);
                assert.equal(writes, 0);
                assert.equal(document.getText(), before);
            }
        } finally { vscode.workspace.applyEdit = originalApply; }
        const reset = buildKeywordOptionViewModel(editorFor(document), 0, { selectedFieldId: field.fieldId });
        assert.equal(reset.help.contextKey, baseHelp.contextKey);
        const sphere = buildKeywordOptionViewModel(editorFor(sourceFor(fixtures.find(f => f.id === 'trim-sphere'))), 0,
            { selectedFieldId: field.fieldId });
        assert.equal(sphere.help.schemaName, 'NID');
        assert.equal(sphere.help.status, 'ready');
        assert.notEqual(sphere.help.contextKey, baseHelp.contextKey);
        assert.equal(document.getText(), before);
    });
    it('explains unavailable draft layouts in both languages and rechecks forged ready plans without writing', async () => {
        const i18n = require('../../../out/core/i18n');
        const document = sourceFor(fixtures.find(f => f.id === 'trim-partset')), editor = editorFor(document);
        const before = document.getText(), originalConfiguration = vscode.workspace.getConfiguration;
        const originalApply = vscode.workspace.applyEdit, originalMessage = vscode.window.showInformationMessage;
        const originalEditor = vscode.window.activeTextEditor;
        let writes = 0, lastMessage;
        vscode.workspace.applyEdit = async () => { writes++; return true; };
        vscode.window.showInformationMessage = async message => { lastMessage = message; };
        vscode.window.activeTextEditor = editor;
        try {
            for (const [language, message, invalidMessage] of [
                ['zh-cn', '这些修改无法应用到当前字段布局。文件未修改，请还原修改的值后再试。',
                    '本次修改包含无效字段，请修正标记项后再应用。'],
                ['en', 'These changes cannot be applied to the current field layout. Your file has not changed. Revert the changed values and try again.',
                    'Some changes are invalid. Correct the marked fields before applying.'],
            ]) {
                vscode.workspace.getConfiguration = (...args) => {
                    const config = originalConfiguration(...args);
                    return { ...config, get: (key, ...rest) => key === 'language' ? language : config.get(key, ...rest) };
                };
                i18n.updateLanguage();
                const base = buildKeywordOptionViewModel(editor, 0, {});
                const option = base.managerCards[0].fields.find(field => field.name === 'OPTION');
                const psid = base.managerCards[0].fields.find(field => field.name === 'PSID');
                assert.ok(option.choices.includes('SPHERE'), 'SPHERE is a valid option, not an invalid field value');
                const staged = keywordManagerEditField(base, option.fieldId, 'SPHERE');
                assert.ok(staged);
                const draft = buildKeywordOptionViewModel(editor, 0, staged);
                assert.equal(draft.plan.status, 'blocked');
                assert.equal(draft.plan.reason, 'lspp-input-form-field-draft-invalid');
                assert.ok(draft.managerCards[0].fields.every(field => !field.diagnostic?.blocksApply));
                const view = buildKeywordOptionsViewState(draft);
                assert.equal(view.status, 'error');
                assert.equal(view.message, message);
                assert.equal(view.canApply, false);
                assert.equal(view.preview, null);
                const readonly = { ...draft, readonly: true };
                for (const model of [draft, { ...draft, plan: { ...draft.plan, status: 'ready', reason: 'forged-ready' } }, readonly]) {
                    let staleCalls = 0;
                    lastMessage = undefined;
                    assert.equal(await applyKeywordOptionViewModel({ getModel: () => model, markStale() { staleCalls++; } }, editor), null);
                    assert.equal(lastMessage, model === readonly ? i18n.get('keywordManagerApplyUnavailable') : message);
                    assert.equal(staleCalls, model.plan.status === 'ready' ? 1 : 0, 'a ready claim must be re-prepared and rejected');
                    assert.equal(writes, 0);
                    assert.equal(document.getText(), before);
                }
                const invalid = buildKeywordOptionViewModel(editor, 0, { fieldDrafts: { [psid.fieldId]: '12345678901' } });
                assert.ok(invalid.managerCards[0].fields.find(field => field.fieldId === psid.fieldId).diagnostic.blocksApply);
                assert.equal(buildKeywordOptionsViewState(invalid).message, invalidMessage, 'actual field errors keep their specific message');
                assert.equal(buildKeywordOptionsViewState(invalid).canApply, false);
            }
        } finally {
            vscode.workspace.getConfiguration = originalConfiguration;
            vscode.workspace.applyEdit = originalApply;
            vscode.window.showInformationMessage = originalMessage;
            vscode.window.activeTextEditor = originalEditor;
            i18n.updateLanguage();
        }
        assert.equal(writes, 0);
        assert.equal(document.getText(), before);
    });
    it('edits and reopens values within the same native TRIM branch without changing adjacent records', async () => {
        const fixture = fixtures.find(f => f.id === 'trim-partset'), sibling = fixtures.find(f => f.id === 'trim-sphere').lines[0];
        const lines = ['*' + fixture.keyword, fixture.lines[0], sibling, '*END'];
        const document = fakeDocument(lines), editor = editorFor(document);
        const base = buildKeywordOptionViewModel(editor, 0, {}), field = base.managerCards[0].fields.find(f => f.name === 'PSID');
        const draft = buildKeywordOptionViewModel(editor, 0, keywordManagerEditField(base, field.fieldId, '7'));
        assert.equal(draft.plan.status, 'ready');
        assert.equal(buildKeywordOptionsViewState(draft).canApply, true);
        assert.equal(draft.plan.replacementRecords[1].text, sibling);
        const originalApply = vscode.workspace.applyEdit, originalEditor = vscode.window.activeTextEditor;
        let writes = 0, applied;
        vscode.window.activeTextEditor = editor;
        vscode.workspace.applyEdit = async edit => { writes++; applied = edit; return true; };
        try { assert.ok(await applyKeywordOptionViewModel({ getModel: () => draft, markStale() {} }, editor)); }
        finally { vscode.workspace.applyEdit = originalApply; vscode.window.activeTextEditor = originalEditor; }
        assert.equal(writes, 1);
        assert.equal(applied.edits.length, 1);
        const expected = lines.slice(0, -1);
        expected[1] = expected[1].slice(0, 40) + '7'.padStart(10) + expected[1].slice(50);
        assert.equal(applied.edits[0].text, expected.join('\n') + '\n');
        const reopened = buildKeywordOptionViewModel(editorFor(fakeDocument([...expected, '*END'])), 0, {});
        assert.equal(reopened.plan.status, 'no-change');
        assert.equal(reopened.managerCards[0].fields.find(f => f.name === 'PSID').value, '7');
        assert.equal(document.getText(), lines.join('\n'));
    });
    it('keeps incomplete ALE instances, changed native sources and unsupported LONG selector windows unresolved', () => {
        const fixture = fixtures.find(f => f.id === 'ale-reference-source');
        const incomplete = fakeDocument(['*' + fixture.keyword, fixture.lines[0], '*END']);
        const model = buildKeywordOptionViewModel(editorFor(incomplete), 0, {});
        assert.equal(model.plan.status, 'blocked');
        assert.deepEqual(model.managerCards, []);
        assert.equal(model.help.reason, 'form-unresolved');
        assert.equal(buildKeywordOptionsViewState(model).canApply, false);
        assert.equal(incomplete.getText(), ['*' + fixture.keyword, fixture.lines[0], '*END'].join('\n'));
        const { nativeFileReadContext } = require('../../../out/core/semantics/nativeFileReadContext');
        const trim = fixtures.find(f => f.id === 'trim-partset');
        const form = getCatalogInputFormCatalogV4().formForKeyword(trim.keyword, false);
        const rule = { ...form.rules[form.reference.formRuleIds[0]], catalogSource: form.source };
        const wrong = nativeFileReadContext({ ...rule, catalogSource: { ...form.source, datasetSha256: '0'.repeat(64) } },
            '*' + trim.keyword, trim.lines, 'standard');
        assert.equal(wrong.kind, 'unsupported-source');
        assert.equal(wrong.select(), null);
        const longRow = [1, 'SEGSET', 0, 0, 1, 2, 0, 0].map(value => String(value).padStart(20)).join('');
        const unsupported = nativeFileReadContext(rule, '*' + trim.keyword + ' +', [longRow], 'standard');
        assert.equal(unsupported.select(), null);
        const longDocument = fakeDocument(['*' + trim.keyword + ' +', longRow, '*END']);
        const longModel = buildKeywordOptionViewModel(editorFor(longDocument), 0, {});
        assert.equal(longModel.plan.status, 'blocked');
        assert.equal(buildKeywordOptionsViewState(longModel).canApply, false);
        assert.equal(longDocument.getText(), ['*' + trim.keyword + ' +', longRow, '*END'].join('\n'));
    });
});
