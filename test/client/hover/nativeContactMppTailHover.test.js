'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const { getEnglishFieldHelp } = require("../../../out/core/keywordSchema");
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve } = require("../../../out/extension")._internals;
const readers = require("../../../keywords/runtime/native-readers/lspp-contact-mpp-tail-readers.json");
const fixture=require("../../fixtures/public-behavior/contact-mpp-tail.json");
const {evidence,specimens,cardinality,specialBoundaries}=fixture;

describe('shared native seven-card CONTACT MPP tail', function () {
    this.timeout(120000);
    it('keeps the native LONG CID/TITLE prefix at 20/160 for both spellings', async () => {
        const task = specimens.tasks.find(item => item.format === 'long');
        assert.ok(task);
        assert.deepEqual(fixture.longPrefixAddresses,
            ["record:3c11134d2da44eeb1b070a21:33a805f7079dbac5b4380db2", "record:3c11134d2da44eeb1b070a21:862cf498cb0e4801cd85287b"]);
        assert.equal(task.lines[1].length, 180);
        assert.equal(task.lines[1].slice(0, 20).trim(), '1000001');
        assert.equal(task.lines[1].slice(20, 180).trim(), 'MPP native prefix');

        const provider = new LsdynaFieldHoverProvider();
        for (const spelling of [task.keyword, task.keyword.replace(/_ID_MPP$/, '_MPP_ID')]) {
            const lines = [...task.lines, '*END'];
            lines[0] = `*${spelling} +`;
            const doc = fakeDoc(lines.join('\n'));
            const info = resolve(doc, 1).cardInfo;
            assert.equal(info?.resolutionSource, 'native-file-reader', spelling);
            assert.deepEqual(info.card.map(field => [field.n, field.rawValue, field.nativeRange]), [
                ['CID', '1000001', { start: 0, end: 20 }],
                ['TITLE', 'MPP native prefix', { start: 20, end: 180 }],
            ], spelling);
            for (const [name, character, start, end] of [
                ['CID', 15, 0, 20], ['TITLE', 90, 20, 180],
            ]) {
                const hover = await provider.provideHover(doc, { line: 1, character });
                assert.ok(hover?.contents[0].value.includes(`**${name}**`), `${spelling}: ${name}`);
                assert.equal(hover.range.start.character, start, `${spelling}: ${name} start`);
                assert.equal(hover.range.end.character, end, `${spelling}: ${name} end`);
            }
        }
    });
    it('uses the native record and field identity for 33 aliases in four formats', async () => {
        assert.equal(Object.keys(readers.bindings).length, 66); // ID_MPP and saved MPP_ID.
        assert.equal(specimens.tasks.length, 132);
        const provider = new LsdynaFieldHoverProvider();
        for (const task of specimens.tasks) {
            const doc = fakeDoc([...task.lines, '*END'].join('\n'));
            for (const record of task.records) {
                const info = resolve(doc, record.lineOffset).cardInfo;
                assert.ok(info, `${task.id} record ${record.lineOffset}`);
                assert.deepEqual(info.card.map(field => field.nativeIdentity?.fieldRecordId),
                    record.fieldAddresses, `${task.id} record ${record.lineOffset}`);
                for (const field of info.card) {
                    const descriptor = evidence.descriptors[field.nativeIdentity.fieldRecordId];
                    assert.ok(descriptor, `${task.id}: ${field.n}`);
                    assert.equal(getEnglishFieldHelp(field)?.trim() || '', descriptor.help?.trim() || '',
                        `${task.id}: ${field.n} help`);
                    assert.equal(field.t, [0, -2].includes(descriptor.type) ? 'string' :
                        Math.abs(descriptor.type) === 1 ? 'integer' : 'real', `${task.id}: ${field.n} type`);
                }
                const first = info.card.find(field => field.nativeRange.end > field.nativeRange.start);
                if (first) {
                    const hover = await provider.provideHover(doc,
                        { line: record.lineOffset, character: first.nativeRange.start });
                    assert.ok(hover, `${task.id}: hover ${first.n}`);
                    assert.ok(hover.contents[0].value.includes(`**${first.n}**`), task.id);
                }
            }
            if (task.lines.length - 1 > task.records.length)
                assert.equal(resolve(doc, task.records.length + 1).cardInfo, null,
                    `${task.id}: unread tail must not use static help`);
        }
    });
    it('maps all eight special-card zero, one and seven boundaries through the provider', async () => {
        const provider = new LsdynaFieldHoverProvider();
        for (const task of specialBoundaries.tasks) {
            const doc = fakeDoc([...task.lines, '*END'].join('\n'));
            for (const record of task.expectedRecords) {
                const info = resolve(doc, record.lineOffset).cardInfo;
                assert.ok(info, `${task.id}: card ${record.cardIndex}`);
                assert.deepEqual(info.card.map(field => field.nativeIdentity?.fieldRecordId),
                    record.fields.map(field => field.address), task.id);
                const first = info.card.find(field => field.nativeRange.end > field.nativeRange.start);
                if (first) assert.ok(await provider.provideHover(doc,
                    { line: record.lineOffset, character: first.nativeRange.start }), task.id);
            }
        }
    });
    it('maps zero, one, three and seven native tail records through the provider', async () => {
        const provider = new LsdynaFieldHoverProvider();
        for (const task of cardinality.tasks) {
            const doc = fakeDoc([...task.lines, '*END'].join('\n'));
            for (const record of task.expectedRecords) {
                const info = resolve(doc, record.lineOffset).cardInfo;
                assert.ok(info, `${task.id}: card ${record.cardIndex}`);
                assert.deepEqual(info.card.map(field => field.nativeIdentity?.fieldRecordId),
                    record.fields.map(field => field.address), task.id);
                const first = info.card.find(field => field.nativeRange.end > field.nativeRange.start);
                if (first) assert.ok(await provider.provideHover(doc,
                    { line: record.lineOffset, character: first.nativeRange.start }), task.id);
            }
        }
    });
    it('reopens the canonical MPP_ID spelling with all seven native tail cards', async () => {
        assert.equal(fixture.saved.keyword, '*CONTACT_AUTOMATIC_GENERAL_TIEBREAK_MPP_ID');
        const doc = fakeDoc(fixture.saved.deck);
        const provider = new LsdynaFieldHoverProvider();
        const records = [];
        for (let line = 0; line < doc.lineCount; line++) {
            const text = doc.lineAt(line).text;
            if (text.trimStart().startsWith('$#') || text.startsWith('*')) continue;
            const info = resolve(doc, line).cardInfo;
            if (!info) continue;
            records.push(info);
            const first = info.card.find(field => field.nativeRange.end > field.nativeRange.start);
            if (first) assert.ok(await provider.provideHover(doc,
                { line, character: first.nativeRange.start }), `saved card ${info.nativeCardIndex}`);
        }
        assert.deepEqual(records.map(info => info.card[0].nativeIdentity.fieldRecordId),
            fixture.saved.records.map(([address]) => address));
    });
    it('hovers all native fields after special-card save and reopen', async () => {
        const provider = new LsdynaFieldHoverProvider();
        for (const {name,deck,records} of fixture.specialSaved) {
            const doc = fakeDoc(deck);
            const cards = [];
            for (let line = 0; line < doc.lineCount; line++) {
                const info = resolve(doc, line).cardInfo;
                if (info?.resolutionSource !== 'native-file-reader') continue;
                cards.push(info);
                for (const field of info.card) {
                    const descriptor = evidence.descriptors[field.nativeIdentity.fieldRecordId];
                    assert.ok(descriptor, `${name}: ${field.n} native field`);
                    assert.equal(getEnglishFieldHelp(field)?.trim() || '', descriptor.help?.trim() || '',
                        `${name}: ${field.n} help`);
                }
                const first = info.card.find(field => field.nativeRange.end > field.nativeRange.start);
                if (first) assert.ok(await provider.provideHover(doc,
                    { line, character: first.nativeRange.start }), `${name}: card ${info.nativeCardIndex}`);
            }
            assert.deepEqual(cards.map(info => [info.card[0].nativeIdentity.fieldRecordId, info.card.length]),
                records, name);
        }
    });
});
