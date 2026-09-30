'use strict';
require('./register-out');
const assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib');
const {fakeDoc}=require('./helpers');
const fixtures=JSON.parse(zlib.gunzipSync(fs.readFileSync(require.resolve('./fixtures/public-behavior/mixed-reader-safety.json.gz'))));
const runtime=require('../keywords/lspp-spelling-file-readers.json');
const {resolveCardForDocumentLine,loadKeywordSchema}=require('../out/core/keywordSchema');
const {nativeKeywordTemplate}=require('../out/core/completion/nativeKeywordTemplate');
const {getCardFieldsForLine}=require('../out/extension')._internals;
const schema=loadKeywordSchema(),archive={plan:{source:{scope:fixtures.remaining.scope},tasks:fixtures.remaining.rejectedTasks.map(t=>({...t,prefix:'none'}))}};
const originalBindings=()=>Object.entries(runtime.bindings).filter(([keyword])=>fixtures.remaining.scope.includes(keyword));
const sample=binding=>fixtures.remaining.samples[Object.entries(runtime.bindings).find(([,value])=>value===binding)[0]];
describe('retained suffix identity and editing boundaries',function(){this.timeout(120000);
it('keeps literal commas and the 80-column bound for every independently bound NAME prefix', async () => {
        const { LsdynaFieldHoverProvider } = require('../out/extension')._internals;
        const provider = new LsdynaFieldHoverProvider();
        let checked = 0;
        for (const [keyword, binding] of originalBindings()) {
            if (binding.prefixCard?.fields[0]?.fieldRecordId !== "record:1cd1189cbb8b718bfe96753f:06509dc141dce99161b083a1") continue;
            const task = sample(binding);
            for (const format of ['', ' +', ' %']) {
                const lines = [...task.lines];
                lines[0] = '*' + keyword + format;
                lines[1] = '  Region, one'.padEnd(79, 'x') + ',trailing';
                const doc = fakeDoc(lines.join('\n'));
                const result = resolveCardForDocumentLine(doc, 1, schema);
                const field = result.cardInfo.card[0];
                assert.equal(field.rawValue, lines[1].slice(0, 80).trim(), keyword);
                assert.deepEqual(field.nativeRange, { start: 0, end: 80 }, keyword);
                assert.equal(field.nativeIdentity.fieldRecordId, "record:1cd1189cbb8b718bfe96753f:06509dc141dce99161b083a1");
                const hover = await provider.provideHover(doc, { line: 1, character: 9 });
                assert.equal(hover.range.start.character, 0);
                assert.equal(hover.range.end.character, 80);
                assert.ok(hover.contents[0].value.includes('**NAME**'));
                checked++;
            }
        }
        assert.equal(checked, 162);
    });
it('retains native-rejected spellings without static field help', async () => {
        for (const keyword of archive.plan.source.scope.filter(keyword => runtime.gaps[keyword])) {
            assert.equal(runtime.gaps[keyword].nativeRejected, true, keyword);
            const task = archive.plan.tasks.find(t => t.keyword === keyword && t.prefix === 'none');
            const document = fakeDoc(task.lines.concat('*END').join('\n'));
            const result = resolveCardForDocumentLine(document, 1, schema);
            assert.equal(result.status, 'unsupported', keyword);
            assert.equal(result.reason, 'native-file-spelling-rejected', keyword);
            const provider = new (require('../out/extension')._internals.LsdynaFieldHoverProvider)();
            const hover = await provider.provideHover(document, {line:1, character:0}, {isCancellationRequested:false});
            assert.ok(hover.contents.some(content => content.value.includes('This keyword spelling is not supported by the current field rules; no corresponding field help is available.')));
            assert.equal(nativeKeywordTemplate(keyword).reason, 'native-edit-binding-unverified', keyword);
        }
    });
it('keeps every new spelling outside field editing and insertion authorization', () => {
        for (const [keyword, binding] of originalBindings()) {
            const task = sample(binding);
            const document = fakeDoc(task.lines.concat('*END').join('\n'));
            assert.equal(nativeKeywordTemplate(keyword).reason, 'native-edit-binding-unverified', keyword);
            for (let line = 1; line < task.lines.length; line++)
                assert.equal(getCardFieldsForLine(document, line), null, keyword);
        }
    });
it('uses a distinct prefix and field identity for each repeated title instance', () => {
        for (const [keyword, binding] of originalBindings().filter(([, b]) => b.prefixScope === 'instance')) {
            const task = sample(binding);
            const rows = task.lines.slice(1);
            const document = { ...fakeDoc([task.lines[0], ...rows, ...rows, '*END'].join('\n')), version: 1 };
            const first = resolveCardForDocumentLine(document, 1, schema).cardInfo.card;
            const second = resolveCardForDocumentLine(document, 1 + rows.length, schema).cardInfo.card;
            assert.equal(first[0].nativeIdentity.fieldRecordId, "record:1cd1189cbb8b718bfe96753f:06509dc141dce99161b083a1", keyword);
            assert.equal(second[0].nativeIdentity.fieldRecordId, first[0].nativeIdentity.fieldRecordId, keyword);
            assert.notEqual(first[0].nativeIdentity.recordKey, second[0].nativeIdentity.recordKey, keyword);
            assert.equal(second[0].nativeIdentity.instanceStart, rows.length, keyword);
        }
    });
it('keeps the ordinal path for late fixed instances with and without per-instance titles', async () => {
        const { nativeFieldsNeedOnlyOrdinal } = require('../out/core/semantics/nativeFieldResolution');
        const { resolveCardForDocumentLineAsync } = require('../out/core/keywordSchema');
        for (const keyword of ['ELEMENT_BEAM_TITLE', 'DUALCESE_GRAVITY_TITLE']) {
            assert.equal(nativeFieldsNeedOnlyOrdinal(keyword), true, keyword);
            const task = sample(runtime.bindings[keyword]), rows = task.lines.slice(1);
            const document = fakeDoc([task.lines[0], ...Array.from({ length: 1000 }, () => rows).flat(), '*END'].join('\n'));
            document.version = 1;
            const start = 1 + 999 * rows.length;
            const first = resolveCardForDocumentLine(document, 1, schema).cardInfo.card;
            const result = await resolveCardForDocumentLineAsync(document, start, schema, { keywordLine: 0 });
            assert.equal(result.status, 'resolved', keyword);
            const last = result.cardInfo.card;
            assert.deepEqual(last.map(f => f.nativeIdentity.fieldRecordId), first.map(f => f.nativeIdentity.fieldRecordId), keyword);
            assert.equal(last[0].nativeIdentity.instanceStart, start - 1, keyword);
        }
    });
it('invalidates the same document across every observed conditional layout transition and undo/redo',()=>{
 for(const group of fixtures.remaining.transitions){
  const document=fakeDoc('');let version=0;
  for(const task of [...group.tasks,...group.tasks.slice().reverse(),...group.tasks]){
   Object.assign(document,fakeDoc(task.lines.concat('*END').join('\n')),{version:++version});
   for(const record of task.records){
    const result=resolveCardForDocumentLine(document,record.lineOffset,schema);
    assert.equal(result.status,'resolved',task.id);
    assert.deepEqual(result.cardInfo.card.map(field=>field.nativeIdentity.fieldRecordId),record.fields,task.id);
   }
  }
 }
});
});
