'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { fakeDoc } = require('./helpers');
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve,
    buildKeywordOptionViewModel: model } = require('../out/extension')._internals;
const grammar = require('../keywords/lspp-generic-file-readers.json');
const fixtures = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/public-behavior/fixed-reader-cases.json.gz'))));

describe('inventory driven fixed EOS readers', () => {

    it('matches native card/field identities, current values, ranges and manager source instances', async function () {
        // This aggregate exercises 768 native instances through every field's real hover provider.
        // Individual hover/cache latency remains covered separately.
        this.timeout(120000);
        const provider = new LsdynaFieldHoverProvider();
        for (const bundle of fixtures) for (const job of bundle.jobs) {
            const doc = { ...fakeDoc(job.input, path.resolve('out/fixed-regression', String(job.id), `${job.id}.k`)), version: 1 };
            const reads = new Map(job.reads.map(read => [read.sourceLine, read]));
            let start = 1;
            for (const id of job.tasks) {
                const task = bundle.tasks.find(t => t.id === id);
                const binding = grammar.fixedBindings[task.keyword.replace(/_TITLE$/, '')];
                const title = Number(task.keyword.endsWith('_TITLE'));
                let manager;
                for (const [index, record] of task.expectedRecords.entries()) {
                    const line = start + record.lineOffset, info = resolve(doc, line).cardInfo;
                    if (index % binding.cardCount === 0) {
                        manager = model({ document: doc, selection: { active: { line, character: 0 } } }, line, {});
                        assert.notEqual(manager.plan.status, 'blocked', `${task.keyword} ${task.format}: ${manager.plan.reason}`);
                        assert.deepEqual(manager.plan.replacementRecords.map(r => r.text), task.lines.slice(1));
                    }
                    assert.ok(info, `${task.keyword} ${task.format} line ${line}: ${resolve(doc, line).reason}`);
                    assert.equal(info.nativeCardIndex, index % binding.cardCount + 1);
                    assert.equal(info.nativeInstanceStart, Math.floor(index / binding.cardCount) * (binding.cardCount + title));
                    assert.deepEqual(info.card.map(f => f.nativeIdentity.fieldRecordId), reads.get(line).fields.map(f => f.descriptorAddress));
                    assert.deepEqual(info.card.map(f => f.rawValue), record.fields.map(f => f.value));
                    const managerCard = manager.managerCards.find(c => c.line === line);
                    assert.ok(managerCard, `${task.keyword} ${task.format} line ${line}; manager lines ${manager.managerCards.map(c => c.line)}`);
                    assert.deepEqual(managerCard.fields.map(f => f.value), record.fields.map(f => f.value));
                    for (const [i, field] of info.card.entries()) {
                        assert.equal(field.t, reads.get(line).fields[i].type === 1 ? 'integer' : 'real');
                        const nativeDescriptor = reads.get(line).fields[i];
                        const width = task.format === 'long' ? 20 : nativeDescriptor.width;
                        const start = task.format === 'comma' ? record.fields.slice(0, i).reduce((n, f) => n + f.value.length + 1, 0)
                            : task.format === 'long' ? i * 20 : nativeDescriptor.position;
                        const end = start + (task.format === 'comma' ? record.fields[i].value.length : width);
                        const hover = await provider.provideHover(doc, { line, character: field.p });
                        assert.ok(hover?.contents[0].value.includes(`**${field.n}**`), `${task.keyword}: ${field.n}`);
                        assert.equal(hover.range.start.character, start);
                        assert.equal(hover.range.end.character, end);
                    }
                }
                start += task.lines.length;
            }
        }
    });

    it('maps records independently of comments and retains a certain prefix for an incomplete instance', () => {
        for (const comment of ['', '$ ordinary', '$# WRONG FIELDS', '$HMNAME metadata']) {
            const lines = ['*EOS_GRUNEISEN', '12,1,2,3,4,5,6,7'];
            if (comment) lines.push(comment);
            const tail = lines.length;
            lines.push('2.125,2.25', '13,1,2,3,4,5,6,7', '*END');
            const doc = fakeDoc(lines.join('\n'));
            assert.equal(resolve(doc, tail).cardInfo.nativeCardIndex, 2);
            assert.equal(resolve(doc, tail + 1).cardInfo.nativeCardIndex, 1);
            assert.equal(resolve(doc, tail + 1).cardInfo.nativeInstanceStart, 2);
        }
    });
});
