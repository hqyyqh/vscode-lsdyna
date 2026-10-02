'use strict';
const assert = require('node:assert/strict');
const fixture = require("../../fixtures/public-behavior/shared-byte-cases.json");
const serializer = require('../../../out/core/edit/keywordRecordSerializer');
const vscode = require('vscode');
const { getCatalogInputFormCatalogV4 } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
const {
    buildKeywordOptionViewModel, buildKeywordOptionsViewState, applyKeywordOptionViewModel,
    keywordManagerPrepareCatalogInputFormLayoutForRule: prepare,
    keywordManagerFieldProjection: project,
    keywordManagerEditField: edit,
    keywordManagerStageFieldDrafts: stage,
} = require('../../../out/extension')._internals;

function setup(card) {
    const text = ' '.repeat(Math.max(80, ...card.fields.map(field => field.position + field.width)));
    const document = { version: 1, lineCount: 3, uri: { toString: () => 'file:///shared.key' },
        lineAt: index => ({ text: ['*SHARED', text, '*END'][index] }), getText: () => `*SHARED\n${text}\n*END` };
    const rule = { catalogRuleId: 'native-shared-fixture', cards: [card],
        serializationFormats: ['standard-fixed'], catalogSource: { datasetSha256: fixture.datasetSha256 } };
    const result = { block: { status: 'ready', records: [{ text, comments: [] }] }, plan: {} };
    assert.ok(prepare(document, 0, result, rule));
    assert.notEqual(result.plan.status, 'blocked', result.plan.reason);
    const model = { ...result, managerCards: project(document, 0, result).cards, fieldDrafts: {}, recordDrafts: {} };
    return { document, result, rule, model };
}

describe('EXE-backed shared byte editing', () => {
    it('accounts for all 78 overlaps without removing native fields', () => {
        assert.equal(fixture.cases.length, 78);
        assert.equal(fixture.after.safeWriteGaps.length, 0);
        assert.equal(fixture.after.sharedByteOverlaps, 78);
        for (const { card } of fixture.cards) {
            assert.ok(serializer.hasSharedByteContract(card, fixture.datasetSha256));
            assert.equal(card.fields.length, card.serializationSlots.length);
            const { model } = setup(card);
            assert.equal(model.managerCards[0].fields.length, card.fields.length);
            assert.ok(model.managerCards[0].fields.every(field => field.editable));
        }
    });

    for (const [caseIndex, entry] of fixture.cases.entries()) {
        it(`preserves exact shared bytes in both directions: ${caseIndex + 1} ${entry.ruleId}/${entry.cardIndex}`, () => {
            const card = fixture.cards.find(item => item.ruleId === entry.ruleId && item.card.cardIndex === entry.cardIndex).card;
            const fields = card.fields;
            const indexes = entry.fieldIds.map(id => fields.findIndex(field => field.fieldId === id));
            assert.ok(indexes.every(index => index >= 0));
            let text = ' '.repeat(Math.max(80, ...fields.map(field => field.position + field.width))) + '$tail';
            for (const index of [...indexes, ...indexes.reverse()]) {
                const field = fields[index];
                const previous = text;
                text = serializer.editSharedRecord(text, fields, index, '7', 'standard');
                assert.equal(text.slice(0, field.position), previous.slice(0, field.position));
                assert.equal(text.slice(field.position + field.width), previous.slice(field.position + field.width));
                for (let other = 0; other < fields.length; other++) {
                    assert.equal(serializer.readRecordField(text, fields, other, 'standard'),
                        text.slice(fields[other].position, fields[other].position + fields[other].width).trim());
                }
                assert.ok(text.endsWith('$tail'));
            }
        });
    }

    it('stages shared record bytes, previews both fields, and resets the complete draft', () => {
        const card = fixture.cards.find(item => item.ruleId === 'input-form-1198').card;
        const { model, document, rule } = setup(card);
        const field = model.managerCards[0].fields.find(field => field.name === 'TIMSTR');
        const drafts = edit(model, field.fieldId, '12');
        assert.ok(drafts);
        assert.deepEqual(drafts.fieldDrafts, {});
        assert.equal(Object.keys(drafts.recordDrafts).length, 1);
        const next = { block: model.block, plan: {} };
        prepare(document, 0, next, rule, drafts.fieldDrafts, drafts.recordDrafts);
        const changes = stage(next, drafts.fieldDrafts, drafts.recordDrafts);
        assert.deepEqual(changes.details.map(field => [field.name, field.after]), [['TIMSTR', '12'], ['ICD7A', '12']]);
        const projected = project(document, 0, next).cards;
        assert.equal(projected[0].fields.find(field => field.name === 'ICD7A').draft, '12');
        assert.equal(next.plan.replacementRecords[0].text, Object.values(drafts.recordDrafts)[0]);
        const reset = edit({ ...next, ...drafts, managerCards: projected }, field.fieldId, '');
        assert.deepEqual(reset.recordDrafts, {});
        assert.equal(edit(model, field.fieldId, '1'.repeat(11)), null);
        assert.equal(edit(model, field.fieldId, '1\n2'), null);
        assert.equal(edit(model, field.fieldId, '1,2'), null);
    });

    it('preserves partial-overlap spacing across sequential host edits', () => {
        const entry = fixture.cases.find(entry => {
            const card = fixture.cards.find(item => item.ruleId === entry.ruleId && item.card.cardIndex === entry.cardIndex).card;
            const [a, b] = entry.fieldIds.map(id => card.fields.find(field => field.fieldId === id));
            return a.position !== b.position && [a, b].every(field => !field.choices?.length);
        });
        const card = fixture.cards.find(item => item.ruleId === entry.ruleId && item.card.cardIndex === entry.cardIndex).card;
        const { document, model, rule } = setup(card);
        let current = model;
        for (const nativeId of entry.fieldIds) {
            const index = card.fields.findIndex(field => field.fieldId === nativeId);
            const field = current.managerCards[0].fields[index];
            const before = current.plan.replacementRecords[0].text;
            const drafts = edit(current, field.fieldId, '1');
            const next = { block: model.block, plan: {} };
            assert.ok(prepare(document, 0, next, rule, {}, drafts.recordDrafts));
            assert.ok(stage(next, {}, drafts.recordDrafts));
            assert.equal(next.plan.replacementRecords[0].text,
                serializer.editSharedRecord(before, current.targetLayout.records[0].fields, index, '1', 'standard'));
            current = { ...next, ...drafts, managerCards: project(document, 0, next).cards };
        }
    });

    it('previews changed spacing even when both displayed numeric values stay the same', () => {
        const card = fixture.cards.find(item => item.ruleId === 'input-form-1198').card;
        const { document, result, rule } = setup(card);
        result.block.records[0].text = ' '.repeat(30) + '1'.padEnd(10) + ' '.repeat(40);
        prepare(document, 0, result, rule);
        const model = { ...result, managerCards: project(document, 0, result).cards };
        const field = model.managerCards[0].fields.find(field => field.name === 'TIMSTR');
        const drafts = edit(model, field.fieldId, '1');
        const changes = stage(result, {}, drafts.recordDrafts);
        assert.deepEqual(changes.details.map(change => [change.before, change.after]),
            [['1·········', '·········1'], ['1·········', '·········1']]);
    });

    it('reevaluates a controller changed through its overlapping field and rejects unknown states', () => {
        const card = fixture.cards.find(item => item.ruleId === 'input-form-1198').card;
        const { document, result, rule } = setup(card);
        // Synthetic state table tests wiring only; geometry remains the pinned native card.
        rule.controllerFields = [{ name: 'ICD7A', cardIndex: 2, fieldIndex: 4 }];
        rule.domains = [{ field: 'ICD7A', intervals: [{ max: 0 }, { min: 1 }] }];
        rule.states = [{ domainIndexes: [0], cardIndexes: [2] }, { domainIndexes: [1], cardIndexes: [2, 3] }];
        rule.cards = [card, { cardIndex: 3, fields: [{ fieldIndex: 0, name: 'EXTRA', type: 1, position: 0, width: 10 }] }];
        assert.ok(prepare(document, 0, result, rule));
        const model = { ...result, managerCards: project(document, 0, result).cards };
        const field = model.managerCards[0].fields.find(field => field.name === 'TIMSTR');
        const drafts = edit(model, field.fieldId, '1');
        const next = { block: result.block, plan: {} };
        assert.ok(prepare(document, 0, next, rule, {}, drafts.recordDrafts));
        assert.deepEqual(next.inputFormProjection.currentCardIndexes, [2]);
        assert.deepEqual(next.inputFormProjection.targetCardIndexes, [2, 3]);
        assert.ok(stage(next, {}, drafts.recordDrafts));
        const invalid = edit(model, field.fieldId, '&UNKNOWN');
        assert.equal(prepare(document, 0, { block: result.block, plan: {} }, rule, {}, invalid.recordDrafts), null);
    });

    it('fails closed on missing/tampered contracts, unsupported formats and edits outside fields', () => {
        const card = structuredClone(fixture.cards.find(item => item.ruleId === 'input-form-1198').card);
        assert.equal(serializer.hasSharedByteContract(card, '0'.repeat(64)), false);
        card.serializationSlots[0].position++;
        assert.equal(serializer.hasSharedByteContract(card, fixture.datasetSha256), false);
        const validCard = fixture.cards.find(item => item.ruleId === 'input-form-1198').card;
        const { result } = setup(validCard);
        const id = result.targetLayout.records[0].recordMigrationId;
        for (const format of ['long', 'i10', 'free', 'comma']) {
            assert.equal(serializer.editSharedRecord('', validCard.fields, 3, '1', format), null);
            assert.equal(stage({ ...result, inputFormat: format }, {}, { [id]: result.block.records[0].text }), null);
        }
        const outside = result.block.records[0].text.slice(0, -1) + '!';
        assert.equal(stage(result, {}, { [id]: outside }), null);
        assert.equal(stage(result, {}, { unknown: '' }), null);
    });

    it('runs model → preview → one WorkspaceEdit, rejecting stale or unpreviewed bytes', async () => {
        const catalog = getCatalogInputFormCatalogV4();
        const originalResolve = catalog.resolveFormForKeyword;
        const originalApply = vscode.workspace.applyEdit;
        const originalEditor = vscode.window.activeTextEditor;
        const card = fixture.cards.find(item => item.ruleId === 'input-form-1198').card;
        const native = { ruleId: 'lspp-native-input-form', cards: [card],
            serializationFormats: ['standard-fixed'], cardSetId: 'test-fixture' };
        catalog.resolveFormForKeyword = keyword => keyword.replace(/^\*/, '') === 'SHARED'
            ? { keyword: 'SHARED', reference: { formRuleIds: ['shared'] }, rules: { shared: native },
                source: { schemaVersion: 4, datasetVersion: 'fixture', datasetSha256: fixture.datasetSha256,
                    conservationSatisfied: true } } : null;
        const lines = ['*SHARED', ' '.repeat(80), '*END'];
        const document = { languageId: 'lsdyna', version: 1, lineCount: 3, eol: 1,
            uri: vscode.Uri.file('D:/temp/shared.key'),
            lineAt: index => ({ text: lines[index] }),
            getText: range => range ? lines.slice(range.start.line, range.end.line + 1).join('\n') : lines.join('\n') };
        const editor = { document, selection: { active: new vscode.Position(0, 0) } };
        const edits = [];
        vscode.window.activeTextEditor = editor;
        vscode.workspace.applyEdit = async edit => { edits.push(edit); return true; };
        try {
            const base = buildKeywordOptionViewModel(editor, 0, { provisional: true });
            const field = base.managerCards[0].fields.find(field => field.name === 'TIMSTR');
            assert.ok(field.editable);
            const focused = buildKeywordOptionViewModel(editor, 0, { selectedFieldId: field.fieldId, provisional: true });
            assert.equal(focused.selectedInstanceId, base.selectedInstanceId,
                'focusing a data field must retain the keyword instance identity');
            assert.ok(focused.managerInstances.find(instance => instance.instanceId === base.selectedInstanceId)?.selected);
            const drafts = edit(base, field.fieldId, '123');
            const model = buildKeywordOptionViewModel(editor, 0, { ...drafts, selectedFieldId: field.fieldId, provisional: true });
            assert.equal(model.plan.status, 'ready', model.plan.reason);
            const state = buildKeywordOptionsViewState(model);
            assert.equal(state.canApply, true);
            assert.deepEqual(state.preview.sharedByteChanges, ['TIMSTR: ∅ → 123', 'ICD7A: ∅ → 123']);
            const provider = { getModel: () => model, markStale() {} };
            assert.ok(await applyKeywordOptionViewModel(provider, editor));
            assert.equal(edits.length, 1);
            assert.equal(edits[0].edits.length, 1);
            assert.ok(edits[0].edits[0].text.includes(model.plan.replacementRecords[0].text));
            model.recordDrafts[Object.keys(model.recordDrafts)[0]] = ' '.repeat(80);
            assert.equal(await applyKeywordOptionViewModel(provider, editor), null);
            assert.equal(edits.length, 1);
            Object.assign(model, buildKeywordOptionViewModel(editor, 0, { ...drafts, provisional: true }));
            lines[1] = '9'.padEnd(80);
            document.version++;
            provider.refreshModel = () => { throw new Error('must not rebase stale byte drafts'); };
            assert.equal(await applyKeywordOptionViewModel(provider, editor), null);
            assert.equal(edits.length, 1);
        } finally {
            catalog.resolveFormForKeyword = originalResolve;
            vscode.workspace.applyEdit = originalApply;
            vscode.window.activeTextEditor = originalEditor;
        }
    });
});
