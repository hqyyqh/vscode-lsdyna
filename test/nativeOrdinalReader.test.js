'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const { fakeDoc } = require('./helpers');
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve, buildKeywordOptionViewModel: model } = require('../out/extension')._internals;
const grammar = require('../keywords/lspp-ordinal-file-readers.json');
const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/public-behavior/ordinal-reader-cases.json.gz'))));

describe('native ordinal entity reader', () => {

    it('uses actual card counts and native field windows for every source record including TITLE text', async function () {
        this.timeout(30000);
        const provider = new LsdynaFieldHoverProvider();
        let records = 0, zeroRecords = 0, rejected = 0;
        for (const job of bundle.jobs) {
            const doc = { ...fakeDoc(job.input, path.resolve('out/ordinal-regression', `${job.id}.k`)), version: 1 };
            const reads = new Map(job.reads.map(read => [read.sourceLine, read]));
            let start = 1;
            for (const id of job.tasks) {
                const task = bundle.tasks.find(t => t.id === id), binding = grammar.bindings[task.keyword.replace(/_TITLE$/, '')];
                for (let offset = 1; offset < task.lines.length; offset++) {
                    const line = start + offset, result = resolve(doc, line);
                    if (task.keyword.endsWith('_TITLE') && binding.titleSpelling === 'rejected') {
                        assert.equal(result.cardInfo, null);
                        assert.equal(result.reason, 'native-title-spelling-rejected');
                        rejected++;
                        continue;
                    }
                    const native = reads.get(line), info = result.cardInfo;
                    assert.ok(native, `${task.keyword} native record ${line}`);
                    assert.ok(info, `${task.keyword} ${task.format} ${line}: ${result.reason}`);
                    assert.equal(info.nativeCardIndex, (offset - 1) % binding.cardCount + 1);
                    assert.equal(info.nativeInstanceStart, Math.floor((offset - 1) / binding.cardCount) * binding.cardCount);
                    assert.deepEqual(info.card.map(f => f.nativeIdentity.fieldRecordId), native.fields.map(f => f.descriptorAddress));
                    if (!native.fields.length) zeroRecords++;
                    records++;
                    for (const [index, field] of info.card.entries()) {
                        const descriptor = native.fields[index], text = doc.lineAt(line).text;
                        const tokens = text.split(',');
                        const width = task.format === 'long' ? 20 : descriptor.width;
                        const position = text.includes(',') ? tokens.slice(0,index).reduce((n,s) => n+s.length+1,0) : task.format === 'long' ? index * 20 : descriptor.position;
                        const raw = text.includes(',') ? (tokens[index] || '').trim() : text.slice(position, position+width).trim();
                        assert.equal(field.rawValue, raw);
                        assert.equal(field.t, native.fields[index].type === 1 ? 'integer' : 'real');
                        if (position >= text.length) continue;
                        const hover = await provider.provideHover(doc, { line, character: position });
                        assert.ok(hover?.contents[0].value.includes(`**${field.n}**`), `${task.keyword} ${field.n}`);
                        assert.equal(hover.range.start.character, position);
                        assert.equal(hover.range.end.character, Math.min(text.length, position + (text.includes(',') ? raw.length : width)));
                    }
                    if (!task.keyword.endsWith('_TITLE')) {
                        const manager = model({ document: doc, selection: { active: { line, character: 0 } } }, line, {});
                        assert.notEqual(manager.plan.status, 'blocked', `${task.keyword} ${line}: ${manager.plan.reason}`);
                        assert.deepEqual(manager.plan.replacementRecords.map(r => r.text), task.lines.slice(1));
                        const card = manager.managerCards.find(c => c.line === line);
                        assert.ok(card, `${task.keyword} manager record ${line}`);
                        assert.deepEqual(card.fields.map(f => f.value), info.card.map(f => f.rawValue));
                    }
                }
                start += task.lines.length;
            }
        }
        assert.equal(records, 480);
        assert.equal(zeroRecords, 4);
        assert.equal(rejected, 160);
    });

    it('preserves zero-field source records on edits and keeps comments independent from field identity', () => {
        for (const task of bundle.tasks.filter(t => !t.keyword.endsWith('_TITLE') && t.format === 'comma')) {
            for (const comment of ['$ ordinary', '$# MISLEADING FIELD TITLES', '  $HMNAME metadata']) {
                const lines = [task.lines[0], ...task.lines.slice(1).flatMap(line => [comment, line]), '*END'];
                const doc = fakeDoc(lines.join('\n'));
                const binding = grammar.bindings[task.keyword];
                for (let index = 1; index < task.lines.length; index++) {
                    const info = resolve(doc, index * 2).cardInfo;
                    assert.equal(info.nativeCardIndex, (index - 1) % binding.cardCount + 1);
                    assert.equal(info.nativeInstanceStart, Math.floor((index - 1) / binding.cardCount) * binding.cardCount);
                }
            }
        }
        for (const task of bundle.tasks.filter(t => t.keyword === 'BATTERY_ECHEM_CONTROL_THERMAL')) {
            const doc = fakeDoc([...task.lines, '*END'].join('\n'));
            const editor = { document: doc, selection: { active: { line: 1, character: 0 } } };
            const original = model(editor, 1, {});
            const field = original.managerCards[0].fields.find(f => f.name === 'ITTYPE');
            const edited = model(editor, 1, { fieldDrafts: { [field.fieldId]: '1' } });
            assert.notEqual(edited.plan.status, 'blocked');
            assert.equal(edited.plan.replacementRecords[1].text, task.lines[2]);
            assert.equal(edited.managerCards[1].fields.length, 0);
            const reopened = fakeDoc([task.lines[0], ...edited.plan.replacementRecords.map(r => r.text), '*END'].join('\n'));
            assert.equal(resolve(reopened, 1).cardInfo.card[1].rawValue, '1');
            assert.deepEqual(resolve(reopened, 2).cardInfo.card, []);
            const rawEdit = model(editor, 1, { recordDrafts: {
                'lspp-input:BATTERY_ECHEM_CONTROL_THERMAL:instance:0:card:2': '9',
            } });
            assert.equal(rawEdit.plan.status, 'blocked', 'a consumed zero-field row does not authorize a byte edit');
        }
    });
});
