'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), z = require('node:zlib');
const { fakeDoc } = require("../../support/helpers");
const { getCardInfoForDocumentLineWithSuggest: resolve, LsdynaFieldHoverProvider,
    buildKeywordOptionViewModel: model, keywordManagerEditField: edit } = require("../../../out/extension")._internals;
const { nativeKeywordTemplate } = require("../../../out/core/completion/nativeKeywordTemplate");
const cases = JSON.parse(z.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/residual-reader-cases.json.gz')));
const read = name => ({ plan: { tasks: cases[name] } });

describe('residual fixed reader closure', () => {
    it('uses the independently observed second phase-change card including both reserved slots', async function () {
        this.timeout(30000);
        const archive = read('phaseChange'), hover = new LsdynaFieldHoverProvider();
        for (const task of archive.plan.tasks) {
            const doc = fakeDoc(task.lines.join('\n'));
            for (const record of task.expectedRecords) {
                const info = resolve(doc, record.lineOffset).cardInfo;
                assert.deepEqual(info.card.map(f => f.nativeIdentity.fieldRecordId), record.fields.map(f => f.address));
                assert.deepEqual(info.card.map(f => f.rawValue), record.fields.map(f => f.value));
                assert.deepEqual(info.card.map(f => f.n), record.fields.map(f => !f.name || f.name === '-' ? 'UNUSED' : f.name));
                for (const field of info.card) {
                    const result = await hover.provideHover(doc, { line: record.lineOffset, character: field.p });
                    assert.ok(result.contents[0].value.includes('**' + field.n + '**'));
                    assert.equal(result.range.start.character, field.p);
                }
            }
            const view = model({ document: doc, selection: { active: { line: 1, character: 0 } } }, 1, {});
            const tail = view.managerCards.find(card => card.line === 2);
            assert.deepEqual(tail.fields.map(f => f.name), ['Y3','UNUSED','UNUSED','IFUNC']);
            for (const field of tail.fields.slice(1,3)) {
                assert.equal(field.editable, false);
                assert.equal(edit(view, field.fieldId, '9'), null);
            }
        }
        assert.deepEqual(nativeKeywordTemplate('DUALCESE_INITIAL_PHASE_CHANGE').cardIndexes, [1,2]);
    });
    it('keeps the eleven proven header-only readers separate from field bindings', () => {
        const archive = read('headerOnly');
        const bindings = require("../../../keywords/runtime/native-readers/lspp-batch-fixed-readers.json").fieldlessBindings;
        assert.equal(Object.keys(bindings).length, 11);
        for (const task of archive.plan.tasks) {
            const doc = fakeDoc(task.lines.join('\n'));
            for (let line = 1; line < task.lines.length; line++) {
                const result = resolve(doc, line);
                assert.equal(result.cardInfo, null);
                assert.equal(result.reason, 'native-reader-has-no-data-fields');
            }
            assert.deepEqual(nativeKeywordTemplate(task.keyword).body, ['*' + task.keyword, '$0']);
        }
    });
});
