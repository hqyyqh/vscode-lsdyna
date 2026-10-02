'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const z = require('node:zlib');
const crypto = require('node:crypto');
const base64 = require('node:buffer').Buffer;
const { fakeDoc } = require("../../support/helpers");
const { getCardInfoForDocumentLineWithSuggest: resolve, LsdynaFieldHoverProvider,
    buildKeywordOptionViewModel: model } = require("../../../out/extension")._internals;

const nodeReaders = require("../../../keywords/runtime/native-readers/lspp-node-readers.json");
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

                // Verify field rawValues
                for (let i = 0; i < info.card.length; i++) {
                    const actual = info.card[i].rawValue;
                    const expected = record.fields[i].value;
                    if (actual !== expected) {
                        const numActual = Number(actual.replace(/[dD]/g, 'e'));
                        const numExpected = Number(expected.replace(/[dD]/g, 'e'));
                        assert.ok(
                            actual === expected || (!isNaN(numActual) && !isNaN(numExpected) && numActual === numExpected),
                            `${task.keyword} ${task.format} field ${info.card[i].n}: expected ${expected}, got ${actual}`
                        );
                    }
                }

                // Verify hover provides valid markdown and field ranges
                for (const field of info.card.filter(f => f.nativeRange.end > f.nativeRange.start)) {
                    const hover = await provider.provideHover(doc, { line: record.lineOffset, character: field.p });
                    assert.ok(hover?.contents[0].value.includes(field.n), `${task.keyword} ${field.n}`);
                    assert.equal(hover.range.start.character, field.nativeRange.start);
                }
            }

            // Verify source manager cards
            const view = model({ document: doc, selection: { active: { line: 1, character: 0 } } }, 1, {});
            assert.ok(view?.managerCards?.length, `${task.keyword} manager`);
            for (const card of view.managerCards) {
                const record = task.expectedRecords.find(r => r.lineOffset === card.line);
                assert.ok(record, `Manager card at line ${card.line} for ${task.keyword}`);
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
