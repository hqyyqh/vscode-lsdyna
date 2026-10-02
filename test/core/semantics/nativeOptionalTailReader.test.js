'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const {fakeDoc}=require("../../support/helpers");
const {LsdynaFieldHoverProvider,getCardInfoForDocumentLineWithSuggest:resolve,buildKeywordOptionViewModel:model}=require("../../../out/extension")._internals;
const grammar=require("../../../keywords/runtime/native-readers/lspp-optional-tail-readers.json");
const fixtures=JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve("../../fixtures/public-behavior/optional-tail-records.json.gz"))));
describe('single entity optional tail reading boundaries',function(){
it('keeps CPM_VENT unresolved rather than authorizing a negative first-card index',()=>{const pending=grammar.pendingBindings.DEFINE_CPM_VENT;assert.equal(pending.runtimeCardCount-pending.optionalCards,-1);assert.equal(grammar.bindings.DEFINE_CPM_VENT,undefined);});
it('uses native identities, source values and one source instance through real hover and manager', async function () {
        this.timeout(30000);
        const provider = new LsdynaFieldHoverProvider();
        for (const [bundleIndex,bundle] of fixtures.entries()) for (const job of bundle.jobs) {
            const doc = { ...fakeDoc(job.input, path.resolve('out/optional-regression', String(bundleIndex), `${job.id}.k`)), version: 1 };

            const reads = new Map(job.reads.map(o => [o.sourceLine, o]));
            let start = 1;
            for (const id of job.tasks) {
                const task = bundle.tasks.find(t => t.id === id);
                const maximum = grammar.bindings[task.keyword.replace(/_TITLE$/, '')].cardCount;
                const title = Number(task.keyword.endsWith('_TITLE'));
                const sourceCount = task.lines.length - 1 - title;
                let manager;
                if (sourceCount) {
                    manager = model({ document: doc, selection: { active: { line: start + 1 + title, character: 0 } } }, start + 1 + title, {});
                    if (sourceCount > maximum) assert.equal(manager.plan.status, 'blocked');
                    else {
                        assert.notEqual(manager.plan.status, 'blocked', `${task.keyword} ${task.format} ${task.id} count=${sourceCount}: ${manager.plan.reason}`);
                        assert.deepEqual(manager.plan.replacementRecords.map(r => r.text), task.lines.slice(1), 'no-op preserves missing optional rows and blank records');
                    }
                }
                for (const record of task.expectedRecords) {
                    const line = start + record.lineOffset, info = resolve(doc, line).cardInfo;
                    assert.ok(info, `${task.keyword} line ${line}: ${resolve(doc, line).reason}`);
                    assert.equal(info.nativeInstanceStart, 0);
                    assert.deepEqual(info.card.map(f => f.nativeIdentity.fieldRecordId), reads.get(line).fields.map(f => f.descriptorAddress));
                    assert.deepEqual(info.card.map(f => f.rawValue), record.fields.map(f => f.value));
                    if (sourceCount <= maximum) {
                        const card = manager.managerCards.find(c => c.line === line);
                        assert.ok(card, `source manager card ${line}`);
                        assert.deepEqual(card.fields.map(f => f.value), record.fields.map(f => f.value));
                    }
                    for (const field of info.card) {
                        if (!doc.lineAt(line).text) continue;
                        const hover = await provider.provideHover(doc, { line, character: field.p });
                        assert.ok(hover?.contents[0].value.includes(`**${field.n}**`), field.n);
                        assert.equal(hover.range.start.character, field.nativeRange.start);
                        assert.equal(hover.range.end.character, field.nativeRange.end);
                    }
                }
                if (sourceCount > maximum) assert.equal(resolve(doc, start + 1 + title + maximum).cardInfo, null);
                start += task.lines.length;
            }
        }
    });
it('keeps blank optional records and ignores misleading annotations without inventing another instance', () => {
        for (const comment of ['', '$# WRONG FIELD\n', '$ ordinary\n$HMNAME metadata\n']) {
            const lines = ['*DEFINE_CPG_GAS_PROPERTIES', '12,1,2,3,4,5,6', ...comment.trimEnd().split('\n').filter(Boolean), '', '42', '99', '*END'];
            const doc = fakeDoc(lines.join('\n'));
            assert.equal(resolve(doc, lines.length - 4).cardInfo.nativeCardIndex, 2);
            assert.equal(resolve(doc, lines.length - 3).cardInfo.card[0].n, 'TC');
            assert.equal(resolve(doc, lines.length - 2).cardInfo, null);
        }
    });
});
