'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require('./helpers');
const { getEnglishFieldHelp } = require('../out/core/keywordSchema');
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve } = require('../out/extension')._internals;
const {plan,evidence,extraStandard,extraFormats,extraEvidence,reopenPlan}=require('./fixtures/public-behavior/optional-form-header.json');
const readers=require('../keywords/lspp-optional-form-header-readers.json');

describe('native omitted form-only ID/TITLE header', function () {
    this.timeout(120000);
    it('maps all sixteen exact readers and four formats through the real hover provider', async () => {
        assert.equal(Object.keys(readers.bindings).length, 16);
        const provider = new LsdynaFieldHoverProvider();
        const extraKeywords = new Set(extraFormats.tasks.map(task => task.keyword));
        const tasks = [
            ...plan.tasks.map(task => [task, evidence]),
            ...extraStandard.tasks.filter(task => extraKeywords.has(task.keyword))
                .map(task => [task, extraEvidence]),
            ...extraFormats.tasks.map(task => [task, extraEvidence]),
        ];
        assert.equal(tasks.length, 64);
        for (const [task, proof] of tasks) {
            const doc = fakeDoc([...task.lines, '*END'].join('\n'));
            for (const expected of task.expectedRecords) {
                const info = resolve(doc, expected.lineOffset).cardInfo;
                const line = doc.lineAt(expected.lineOffset).text;
                const ranges = task.format === 'comma' ? (() => {
                    let offset = 0;
                    return line.split(',').map(value => {
                        const range = { start: offset, end: offset + value.length };
                        offset += value.length + 1;
                        return range;
                    });
                })() : expected.fields.map((_, index) => ({
                    start: index * (task.format === 'long' ? 20 : 10),
                    end: Math.min(line.length, (index + 1) * (task.format === 'long' ? 20 : 10)),
                }));
                assert.equal(info?.resolutionSource, 'native-file-reader', task.id);
                assert.equal(info.nativeCardIndex, expected.cardIndex, task.id);
                assert.deepEqual(info.card.map(field => field.nativeIdentity?.fieldRecordId),
                    expected.fields.map(field => field.address), task.id);
                assert.deepEqual(info.card.map(field => field.n), expected.fields.map(field => field.name), task.id);
                for (const [index, field] of info.card.entries()) {
                    const native = proof.nativeDescriptors[field.nativeIdentity.fieldRecordId];
                    assert.ok(native, `${task.id}: ${field.n}`);
                    assert.equal(field.t, [0, -2].includes(native.type) ? 'string' :
                        Math.abs(native.type) === 1 ? 'integer' : 'real', `${task.id}: ${field.n} type`);
                    assert.equal(getEnglishFieldHelp(field)?.trim() || '', native.help?.trim() || '',
                        `${task.id}: ${field.n} help`);
                    assert.equal(field.rawValue.trim(), expected.fields[index].value.trim(),
                        `${task.id}: ${field.n} raw value`);
                    assert.deepEqual(field.nativeRange, ranges[index], `${task.id}: ${field.n} range`);
                }
                const first = info.card.find(field => field.nativeRange.end > field.nativeRange.start);
                if (first) {
                    const hover = await provider.provideHover(doc,
                        { line: expected.lineOffset, character: first.nativeRange.start });
                    assert.ok(hover, `${task.id}: ${first.n} hover`);
                    assert.ok(hover.contents[0].value.includes(`**${first.n}**`), task.id);
                }
            }
        }
    });
    it('reopens all twelve LS-PrePost saved layouts including blank default records', async () => {
        assert.equal(reopenPlan.tasks.length, 12);
        const provider = new LsdynaFieldHoverProvider();
        for (const task of reopenPlan.tasks) {
            const doc = fakeDoc([...task.lines, '*END'].join('\n'));
            const records = [];
            let inside = false;
            for (let line = 0; line < doc.lineCount; line++) {
                const text = doc.lineAt(line).text;
                if (text === '*' + task.keyword) { inside = true; continue; }
                if (!inside || text.startsWith('*')) continue;
                if (text.trimStart().startsWith('$')) continue;
                const info = resolve(doc, line).cardInfo;
                assert.equal(info?.resolutionSource, 'native-file-reader', `${task.id}: line ${line}`);
                records.push(info);
                for (const field of info.card) {
                    const native = extraEvidence.nativeDescriptors[field.nativeIdentity.fieldRecordId];
                    assert.ok(native, `${task.id}: ${field.n}`);
                    assert.equal(getEnglishFieldHelp(field)?.trim() || '', native.help?.trim() || '',
                        `${task.id}: ${field.n} help`);
                }
                assert.ok(await provider.provideHover(doc, { line, character: 0 }),
                    `${task.id}: line ${line} hover`);
            }
            assert.deepEqual(records.map(info => info.card.map(field => field.nativeIdentity.fieldRecordId)),
                task.expectedRecords.map(record => record.fields.map(field => field.address)), task.id);
        }
    });
});
