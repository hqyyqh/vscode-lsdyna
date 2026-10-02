'use strict';

const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve } =
    require("../../../out/extension")._internals;
const { getCatalogInputFormCatalogV4 } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
const { selectCountedOccurrenceLayout } = require("../../../out/core/semantics/nativeCountedOccurrenceLayout");

const rules = require("../../../keywords/runtime/native-readers/lspp-occurrence-readers.json");
const {report,plan} = require("../../fixtures/public-behavior/counted-occurrence-records.json");
const replaceSlot = (text, slot, value) => text.slice(0, slot * 10) + String(value).padStart(10) + text.slice(slot * 10 + 10);

describe('native counted occurrence hover', function () {
    this.timeout(30000);

    it('binds all 13 runtime rules to independently observed control and boundary evidence', () => {
        assert.equal(Object.keys(rules.bindings).length, 13);
        const catalog = getCatalogInputFormCatalogV4();
        for (const [keyword, binding] of Object.entries(rules.bindings)) {
            const identity = report.identities.find(item => item.keyword === keyword);
            assert.equal(identity?.conclusion, 'confirmed-cause', keyword);
            const form = catalog.formForKeyword(keyword), rule = form.rules[form.reference.formRuleIds[0]];
            assert.equal(rule.cardSetId, binding.cardSetId, keyword);
            assert.equal(rule.cards.length, binding.cardCount, keyword);
            for (const control of binding.controls) {
                const task = report.tasks.find(item => item.keyword === keyword &&
                    item.control.name === control.name && item.conclusion === 'confirmed-cause');
                assert.ok(task, `${keyword}/${control.name}: missing confirmed task`);
                assert.equal(task.baseline.entityBoundariesAfterRecord[0], binding.prefix.length);
                const boundary = task.mutated.entityBoundariesAfterRecord[0];
                assert.equal(boundary, binding.prefix.length + control.records.length);
                const field = rule.cards[control.card - 1].fields[control.field];
                assert.equal(field.name, control.name);
                assert.equal(field.fieldRecordId, task.control.fieldRecordId);
                assert.deepEqual(control.records.map(card => rule.cards[card - 1].fields[0].fieldRecordId),
                    task.mutated.nativeFirstFieldAddresses.slice(binding.prefix.length, boundary));
            }
        }
    });

    it('resolves repeated instances and stops after an unknown parameter', () => {
        const binding = { prefix: [1, 2], maximumActiveControls: 1,
            controls: [{ name: 'COUNT', card: 2, field: 0, allowed: [0, 1], records: [3] }] };
        const rows = ['head', '0', 'head', '1', 'tail'];
        const selected = selectCountedOccurrenceLayout(binding, rows,
            row => rows[row], value => value);
        assert.deepEqual(selected.current.map(item => [item.cardIndex, item.instanceStart]),
            [[1, 0], [2, 0], [1, 2], [2, 2], [3, 2]]);
        const uncertainRows = ['head', '0', 'head', '&COUNT', 'tail'];
        const uncertain = selectCountedOccurrenceLayout(binding, uncertainRows,
            row => uncertainRows[row], value => value);
        assert.deepEqual(uncertain.current.map(item => item.cardIndex), [1, 2]);
        assert.equal(uncertain.failureKind, 'input-uncertain');
        assert.match(uncertain.reasons[0], /unresolved/);
    });

    it('matches every confirmed native record and instance restart through the shared resolver', () => {
        const catalog = getCatalogInputFormCatalogV4();
        for (const taskResult of report.tasks.filter(item => item.conclusion === 'confirmed-cause')) {
            const task = plan.tasks.find(item => item.id === taskResult.taskId);
            const form = catalog.formForKeyword(task.keyword), rule = form.rules[form.reference.formRuleIds[0]];
            const doc = fakeDoc([...task.lines, '*END'].join('\n'));
            for (let index = 0; index < taskResult.mutated.nativeFirstFieldAddresses.length; index++) {
                const line = task.recordSentinels[index].lineOffset;
                const info = resolve(doc, line).cardInfo;
                assert.ok(info, `${task.id}/record-${index + 1}: unresolved`);
                assert.equal(rule.cards[info.nativeCardIndex - 1].fields[0].fieldRecordId,
                    taskResult.mutated.nativeFirstFieldAddresses[index], `${task.id}/record-${index + 1}`);
            }
        }
    });

    it('uses each AIRBAG_ALE count for the actual tail hover and invalidates on edit and undo', async () => {
        const provider = new LsdynaFieldHoverProvider();
        const expected = [
            ['NAIR', 9, 30, 'MWAIR'],
            ['NGAS', 10, 0, 'LCMF'],
            ['NORIF', 11, 0, 'NODEID'],
        ];
        for (const [name, cardIndex, character, fieldName] of expected) {
            const task = plan.tasks.find(item => item.keyword === 'AIRBAG_ALE' && item.controlMutation.name === name);
            const tailLine = task.recordSentinels.find(item => item.cardIndex === 9).lineOffset;
            const doc = { ...fakeDoc([...task.lines, '*END'].join('\n')), version: 1 };
            const card = resolve(doc, tailLine).cardInfo;
            assert.equal(card.nativeCardIndex, cardIndex);
            assert.equal(card.card.find(field => field.p === character).n, fieldName);
            const hover = await provider.provideHover(doc, { line: tailLine, character }, { isCancellationRequested: false });
            assert.ok(hover.contents[0].value.includes(`**${fieldName}**`));
            assert.equal(hover.range.start.line, tailLine);
        }

        const task = plan.tasks.find(item => item.keyword === 'AIRBAG_ALE' && item.controlMutation.name === 'NAIR');
        const lines = [...task.lines, '*END'];
        const controlLine = task.recordSentinels.find(item => item.cardIndex === 8).lineOffset;
        const tailLine = task.recordSentinels.find(item => item.cardIndex === 9).lineOffset;
        const original = lines[controlLine];
        const doc = { ...fakeDoc(lines.join('\n')), version: 1, lineCount: lines.length,
            lineAt: line => ({ text: lines[line] }) };
        assert.equal(resolve(doc, tailLine).cardInfo.nativeCardIndex, 9);
        assert.ok((await provider.provideHover(doc, { line: tailLine, character: 30 },
            { isCancellationRequested: false })).contents[0].value.includes('**MWAIR**'));
        lines[controlLine] = replaceSlot(replaceSlot(original, 3, 0), 4, 1); doc.version++;
        assert.equal(resolve(doc, tailLine).cardInfo.nativeCardIndex, 10);
        assert.ok((await provider.provideHover(doc, { line: tailLine, character: 0 },
            { isCancellationRequested: false })).contents[0].value.includes('**LCMF**'));
        lines[controlLine] = original; doc.version++;
        assert.equal(resolve(doc, tailLine).cardInfo.nativeCardIndex, 9);
        assert.ok((await provider.provideHover(doc, { line: tailLine, character: 30 },
            { isCancellationRequested: false })).contents[0].value.includes('**MWAIR**'));
    });

    it('fails closed for unknown controls, simultaneous counts and non-standard formats', () => {
        const source = plan.tasks.find(item => item.keyword === 'AIRBAG_ALE' && item.controlMutation.name === 'NAIR');
        const controlLine = source.recordSentinels.find(item => item.cardIndex === 8).lineOffset;
        const tailLine = source.recordSentinels.find(item => item.cardIndex === 9).lineOffset;
        const unknown = [...source.lines, '*END'];
        unknown[controlLine] = replaceSlot(unknown[controlLine], 3, '&COUNT');
        assert.equal(resolve(fakeDoc(unknown.join('\n')), tailLine).cardInfo, null);
        const blank = [...source.lines, '*END'];
        blank[controlLine] = replaceSlot(blank[controlLine], 3, '');
        assert.equal(resolve(fakeDoc(blank.join('\n')), tailLine).cardInfo, null);
        const simultaneous = [...source.lines, '*END'];
        simultaneous[controlLine] = replaceSlot(simultaneous[controlLine], 4, 1);
        assert.equal(resolve(fakeDoc(simultaneous.join('\n')), tailLine).cardInfo, null);
        const long = [...source.lines, '*END']; long[0] += ' +';
        assert.equal(resolve(fakeDoc(long.join('\n')), tailLine).cardInfo, null);
        const comma = [...source.lines, '*END']; comma[2] = '0,0,0,0,0,0,0,0';
        assert.equal(resolve(fakeDoc(comma.join('\n')), tailLine).cardInfo, null);
        const keywordSchema = require("../../../out/core/keywordSchema");
        const schema = keywordSchema.loadKeywordSchema();
        const context = keywordSchema.readCardContext(fakeDoc([...source.lines, '*END'].join('\n')), tailLine, schema);
        assert.equal(context.status, 'resolved');
        assert.deepEqual(keywordSchema.resolveCardFromContext(context.context, schema, null, true),
            { status: 'unsupported', reason: 'native-edit-binding-unverified' });
    });
});
