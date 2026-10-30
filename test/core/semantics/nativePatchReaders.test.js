'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const z = require('node:zlib');
const { fakeDoc } = require("../../support/helpers");
const { getCardInfoForDocumentLineWithSuggest: resolve, LsdynaFieldHoverProvider,
    buildKeywordOptionViewModel: model } = require("../../../out/extension")._internals;

const tasks = JSON.parse(z.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/patch-reader-cases.json.gz')));

describe('native PATCH instance readers', () => {
    it('matches the independently retained records through actual hover and source manager in four formats', async function () {
        this.timeout(60000);
        const provider = new LsdynaFieldHoverProvider();
        for (const task of tasks) {
            const doc = { ...fakeDoc(task.lines.join('\n'), '/patch/' + task.id + '.k'), version: 1 };
            for (const record of task.expectedRecords) {
                const result = resolve(doc, record.lineOffset);
                const info = result.cardInfo;
                assert.ok(info, `${task.keyword} ${task.format} line ${record.lineOffset}: ${result.reason}`);
                assert.deepEqual(info.card.map(f => f.nativeIdentity?.fieldRecordId), record.fields.map(f => f.address), task.keyword);
                assert.deepEqual(info.card.map(f => f.n), record.fields.map(f => /^[-_]*$/.test(f.name) ? 'UNUSED' : f.name));
                assert.deepEqual(info.card.map(f => f.rawValue), record.fields.map(f => f.value), `${task.keyword} ${task.format}`);
                for (const field of info.card) {
                    const hover = await provider.provideHover(doc, { line: record.lineOffset, character: field.p });
                    assert.ok(hover?.contents[0].value.replace(/`/g, '').includes('**' + field.n + '**'), `${task.keyword} ${field.n}`);
                    assert.equal(hover.range.start.character, field.p);
                }
            }
            const view = model({ document: doc, selection: { active: { line: 1, character: 0 } } }, 1, {});
            assert.ok(view?.managerCards?.length, `${task.keyword} manager`);
            for (const card of view.managerCards) {
                const record = task.expectedRecords.find(r => r.lineOffset === card.line);
                assert.ok(record);
                assert.deepEqual(card.fields.map(f => f.value), record.fields.map(f => f.value));
            }
        }
    });

    it('ignores inserted misleading comments and preserves instance identity', function () {
        this.timeout(60000);
        for (const task of tasks) {
            if (task.format !== 'standard') continue;
            const lines = task.lines.flatMap((line, i) => i ? ['$# WRONG COMMENT', line] : [line]);
            const doc = { ...fakeDoc(lines.join('\n'), '/patch-comments/' + task.id + '.k'), version: 1 };
            for (const record of task.expectedRecords) {
                const before = resolve(fakeDoc(task.lines.join('\n')), record.lineOffset).cardInfo;
                const after = resolve(doc, record.lineOffset * 2).cardInfo;
                assert.deepEqual(after.card.map(f => [f.nativeIdentity.fieldRecordId, f.rawValue]),
                    before.card.map(f => [f.nativeIdentity.fieldRecordId, f.rawValue]));
                assert.equal(after.nativeInstanceStart, before.nativeInstanceStart);
            }
        }
    });

    it('retains proven prefix when records are incomplete or unknown', () => {
        const lines = ['*ELEMENT_SHELL_BEXT_PATCH', '100,1,1', '0,0,0,2,2,0,0'];
        const doc = fakeDoc(lines.join('\n'));
        const card1 = resolve(doc, 1).cardInfo;
        assert.ok(card1);
        assert.equal(card1.nativeCardIndex, 1);
        const card2 = resolve(doc, 2).cardInfo;
        assert.ok(card2);
        assert.equal(card2.nativeCardIndex, 2);
    });
});
