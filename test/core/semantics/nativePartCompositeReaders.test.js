'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const assertNativeReaderValue = require('../../support/native-reader-values');
const { getCardInfoForDocumentLineWithSuggest: resolve, LsdynaFieldHoverProvider,
    buildKeywordOptionViewModel: model } = require("../../../out/extension")._internals;

const partCompositeReaders = require("../../../keywords/runtime/native-readers/lspp-part-composite-readers.json");
const tasks=require("../../fixtures/public-behavior/part-composite-readers.json");

describe('native PART_COMPOSITE instance readers', () => {
    it('validates part-composite-readers catalog evidence and bindings structure', () => {
        for (const [kw, binding] of Object.entries(partCompositeReaders.bindings)) {
            assert.equal(binding.kind, 'part-composite', kw);
            assert.ok([3, 4].includes(binding.cardCount), kw);
        }
        assert.ok(tasks.length === 48, `Extracted ${tasks.length} node tasks across formats`);
    });

    it('matches independently observed field identities, values, and hover ranges in four formats', async function () {
        this.timeout(60000);
        const provider = new LsdynaFieldHoverProvider();

        for (const task of tasks) {
            const doc = { ...fakeDoc(task.lines.join('\n'), `/node/${task.keyword}-${task.format}.k`), version: 1 };
            for (const record of task.expectedRecords) {
                const result = resolve(doc, record.lineOffset);
                const info = result.cardInfo;
                assert.ok(info, `${task.keyword} ${task.format} line ${record.lineOffset}: ${result.reason}`);
                // nativeCardIndex verified via fields

                // Verify field addresses match observed native descriptors
                assert.deepEqual(
                    info.card.map(f => f.nativeIdentity?.fieldRecordId),
                    record.fields.map(f => f.address),
                    `${task.keyword} ${task.format} addresses`
                );

                // Verify field names match
                assert.deepEqual(
                    info.card.map(f => f.n),
                    record.fields.map(f => /^[-_]*$/.test(f.name) ? 'UNUSED' : f.name),
                    `${task.keyword} ${task.format} names`
                );

                // Source tokens are exact; native numeric/default observations are separate.
                for (let i = 0; i < info.card.length; i++) {
                    assertNativeReaderValue(info.card[i], record.fields[i], `${task.keyword} ${task.format} ${info.card[i].n}`);
                }

                for (const field of record.fields.filter(f => f.range.end > f.range.start)) {
                    const hover = await provider.provideHover(doc, { line: record.lineOffset, character: field.range.start });
                    const name = /^[-_]*$/.test(field.name) ? 'UNUSED' : field.name;
                    assert.ok(hover?.contents[0].value.includes(`**${name}**`), `${task.keyword} ${name}`);
                    assert.deepEqual([hover.range.start.line, hover.range.start.character, hover.range.end.line, hover.range.end.character],
                        [record.lineOffset, field.range.start, record.lineOffset, field.range.end]);
                }

                const view = model({ document: doc, selection: { active: { line: record.lineOffset, character: 0 } } }, record.lineOffset, {});
                assert.ok(view?.managerCards?.some(card => card.line === record.lineOffset), `${task.keyword} manager line ${record.lineOffset}`);
                for (const card of view.managerCards) {
                    const source = task.expectedRecords.find(r => r.lineOffset === card.line);
                    assert.ok(source, `Manager card at line ${card.line} for ${task.keyword}`);
                    // Manager string cells expose trimmed source text; the raw reader above retains TITLE padding.
                    assert.deepEqual(card.fields.map(f => [f.name, f.type, f.value, f.line]), source.fields.map(f => [
                        /^[-_]*$/.test(f.name) ? 'UNUSED' : f.name, f.type === 0 ? '' : String(f.type),
                        f.type === 0 ? f.rawValue.trim() : f.rawValue, source.lineOffset,
                    ]));
                }
            }
        }
    });

    it('ignores inserted misleading comments and preserves card layout', function () {
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

    it('retains repeating integration layer card identity across multiple layer records', () => {
        const text = [
            '*PART_COMPOSITE_CONTACT',
            'Composite Shell Part',
            '     10064         0         0       0.0         0         0         0         0',
            '       0.1       0.1       0.0       0.0       0.0       0.0       0.0       0.0',
            '         1       0.5       0.0         0         2       0.5       0.0         0',
            '         3       0.5      45.0         0         4       0.5     -45.0         0',
            '         5       0.5      90.0         0         6       0.5     -90.0         0',
        ].join('\n');
        const doc = fakeDoc(text);

        const title = resolve(doc, 1).cardInfo;
        assert.ok(title);
        assert.equal(title.nativeCardIndex, 1);
        assert.equal(title.card[0].n, 'TITLE');

        const main = resolve(doc, 2).cardInfo;
        assert.ok(main);
        assert.equal(main.nativeCardIndex, 2);
        assert.equal(main.card[0].n, 'PID');

        const contact = resolve(doc, 3).cardInfo;
        assert.ok(contact);
        assert.equal(contact.nativeCardIndex, 3);
        assert.equal(contact.card[0].n, 'FS');

        const layer1 = resolve(doc, 4).cardInfo;
        assert.ok(layer1);
        assert.equal(layer1.nativeCardIndex, 4);
        assert.equal(layer1.card[0].n, 'MID1');
        assert.equal(layer1.card[0].nativeIdentity.recordKey, 'instance:0:card:4');

        const layer2 = resolve(doc, 5).cardInfo;
        assert.ok(layer2);
        assert.equal(layer2.nativeCardIndex, 4);
        assert.equal(layer2.card[0].n, 'MID1');
        assert.equal(layer2.card[0].nativeIdentity.recordKey, 'instance:0:card:4:repeat:1');

        const layer3 = resolve(doc, 6).cardInfo;
        assert.ok(layer3);
        assert.equal(layer3.nativeCardIndex, 4);
        assert.equal(layer3.card[0].n, 'MID1');
        assert.equal(layer3.card[0].nativeIdentity.recordKey, 'instance:0:card:4:repeat:2');
    });
});
