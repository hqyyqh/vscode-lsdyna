'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const z = require('node:zlib');
const { fakeDoc } = require("../../support/helpers");
const assertNativeReaderValue = require('../../support/native-reader-values');
const { getCardInfoForDocumentLineWithSuggest: resolve, LsdynaFieldHoverProvider,
    buildKeywordOptionViewModel: model } = require("../../../out/extension")._internals;

const tasks = JSON.parse(z.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/node-reader-cases.json.gz')));

describe('native NODE instance readers', () => {

    it('matches independently observed field identities, values, and hover ranges in four formats', async function () {
        this.timeout(60000);
        const provider = new LsdynaFieldHoverProvider();

        for (const task of tasks) {
            const doc = { ...fakeDoc(task.lines.join('\n'), `/node/${task.keyword}-${task.format}.k`), version: 1 };
            for (const record of task.expectedRecords) {
                const result = resolve(doc, record.lineOffset);
                const info = result.cardInfo;
                assert.ok(info, `${task.keyword} ${task.format} line ${record.lineOffset}: ${result.reason}`);
                assert.equal(info.nativeCardIndex, 1, task.keyword);

                // Verify field addresses match observed native descriptors
                assert.deepEqual(
                    info.card.map(f => f.nativeIdentity?.fieldRecordId),
                    record.fields.map(f => f.address),
                    `${task.keyword} ${task.format} addresses`
                );

                // Verify field names match
                assert.deepEqual(
                    info.card.map(f => f.n),
                    record.fields.map(f => f.name),
                    `${task.keyword} ${task.format} names`
                );

                // Source tokens are exact; native numeric/default observations are separate.
                for (let i = 0; i < info.card.length; i++) {
                    assertNativeReaderValue(info.card[i], record.fields[i], `${task.keyword} ${task.format} ${info.card[i].n}`);
                }

                // Shared windows split the hover where the set of identities changes.
                const boundaries = record.fields.flatMap(field => [field.range.start, field.range.end]);
                for (const field of record.fields.filter(f => f.range.end > f.range.start)) {
                    const hover = await provider.provideHover(doc, { line: record.lineOffset, character: field.range.start }, undefined, true);
                    assert.ok(hover?.contents[0].value.includes(`**${field.name}**`), `${task.keyword} ${field.name}`);
                    assert.deepEqual([hover.range.start.line, hover.range.start.character, hover.range.end.line, hover.range.end.character],
                        [record.lineOffset, field.range.start, record.lineOffset, Math.min(...boundaries.filter(value => value > field.range.start))]);
                }

                const view = model({ document: doc, selection: { active: { line: record.lineOffset, character: 0 } } }, record.lineOffset, {});
                assert.ok(view?.managerCards?.some(card => card.line === record.lineOffset), `${task.keyword} manager line ${record.lineOffset}`);
                for (const card of view.managerCards) {
                    const source = task.expectedRecords.find(r => r.lineOffset === card.line);
                    assert.ok(source, `Manager card at line ${card.line} for ${task.keyword}`);
                    assert.deepEqual(card.fields.map(f => [f.name, f.type, f.value, f.line]),
                        source.fields.map(f => [f.name, String(f.type), f.rawValue, source.lineOffset]));
                }
            }
        }
    });

    it('ignores inserted misleading comments and preserves instance identity', function () {
        this.timeout(60000);
        for (const task of tasks) {
            if (task.format !== 'standard') continue;
            const lines = task.lines.flatMap((line, i) => i ? ['$# WRONG COMMENT ID X Y', line] : [line]);
            const doc = { ...fakeDoc(lines.join('\n'), `/node-comments/${task.keyword}.k`), version: 1 };
            for (const record of task.expectedRecords) {
                const before = resolve(fakeDoc(task.lines.join('\n')), record.lineOffset).cardInfo;
                const after = resolve(doc, record.lineOffset * 2).cardInfo;
                assert.deepEqual(
                    after.card.map(f => [f.nativeIdentity?.fieldRecordId, f.n]),
                    before.card.map(f => [f.nativeIdentity?.fieldRecordId, f.n]),
                    task.keyword
                );
            }
        }
    });

    it('retains single-card instance identity across repeated node records', () => {
        const text = [
            '*NODE_TRANSFORM',
            '       100       200         0',
            '       101       200         0',
            '       102       201         1',
        ].join('\n');
        const doc = fakeDoc(text);
        const card1 = resolve(doc, 1).cardInfo;
        assert.ok(card1);
        assert.equal(card1.nativeCardIndex, 1);
        assert.equal(card1.nativeInstanceStart, 0);

        const card2 = resolve(doc, 2).cardInfo;
        assert.ok(card2);
        assert.equal(card2.nativeCardIndex, 1);
        assert.equal(card2.nativeInstanceStart, 1);

        const card3 = resolve(doc, 3).cardInfo;
        assert.ok(card3);
        assert.equal(card3.nativeCardIndex, 1);
        assert.equal(card3.nativeInstanceStart, 2);
    });
});
