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
    it('keeps unread eighth and later tail rows unavailable without losing the real prefix or seven tail cards', async () => {
        const api = require("../../../out/extension")._internals;
        const { vscodeMock } = require("../../support/helpers");
        const { nativeSpellingBinding, nativeFileLayoutKind } = require("../../../out/core/semantics/catalogNativeFileLayout");
        const { nativeFileReadContext } = require("../../../out/core/semantics/nativeFileReadContext");
        const catalog = api.getCatalogInputFormCatalogV4();
        const provider = new LsdynaFieldHoverProvider();
        const tasks = specimens.tasks.filter(task => task.keyword === 'CONTACT_RIGID_BODY_ONE_WAY_TO_RIGID_BODY_ID_MPP');
        assert.equal(tasks.length, 4);
        for (const task of tasks) {
            for (const keyword of [task.keyword, task.keyword.replace(/_ID_MPP$/, '_MPP_ID')]) {
                const lines = task.lines.slice();
                lines[0] = lines[0].replace(task.keyword, keyword);
                const text = [...lines, '*END'].join('\n');
                const doc = { ...fakeDoc(text), version: 1 };
                const binding = nativeSpellingBinding(keyword);
                const form = catalog.formForKeyword(binding.baseKeyword, false);
                const rule = { ...form.rules[form.reference.formRuleIds[0]], catalogSource: form.source };
                const reading = nativeFileReadContext(rule, lines[0], lines.slice(1), 'standard');
                const selected = reading.select();
                assert.ok(selected, `${task.id}: previous records remain readable`);
                assert.equal(selected.current[0].cardIndex, 0);
                assert.equal(selected.current[1].cardIndex, -1);
                assert.deepEqual(selected.current.slice(6, 13).map(record => record.cardIndex), [5,6,7,8,9,10,11]);
                assert.equal(reading.writeCompatible(selected.current), false);
                for (const record of task.records) {
                    const info = resolve(doc, record.lineOffset).cardInfo;
                    assert.deepEqual(info?.card.map(field => field.nativeIdentity.fieldRecordId), record.fieldAddresses,
                        `${keyword}: real record ${record.lineOffset}`);
                }
                assert.ok(lines.length - 1 > task.records.length + 1);
                for (let line = task.records.length + 1; line < lines.length; line++) {
                    assert.equal(reading.cards.has(selected.current[line - 1].cardIndex), false, `${keyword}: no overflow descriptor`);
                    const result = resolve(doc, line);
                    assert.equal(result.cardInfo, null, `${keyword}: unread row ${line}`);
                    assert.equal(result.reason, 'native-field-descriptor-unavailable');
                    const hover = await provider.provideHover(doc, { line, character: 0 });
                    assert.ok(hover, `${keyword}: retain the existing unresolved-field notice`);
                    assert.doesNotMatch(hover.contents[0].value, /\*\*(?:CID|TITLE)\*\*/);
                }
                for (const forged of [{ ...rule, catalogSource: { ...form.source, datasetSha256: 'wrong-source' } },
                    { ...rule, cardSetId: '0x0' }]) {
                    assert.equal(nativeFileLayoutKind(forged, keyword), 'unsupported-source');
                    assert.equal(nativeFileReadContext(forged, lines[0], lines.slice(1), 'standard').select(), null);
                }
                assert.equal(nativeFileReadContext(rule, '*' + keyword + ' %', lines.slice(1), 'long').readInputFailure,
                    'native-mixed-global-long-local-i10-flags-unimplemented');
                const editor = { document: doc, selection: { active: { line: task.records.length + 1, character: 0 } } };
                const model = api.buildKeywordOptionViewModel(editor, editor.selection.active.line, {});
                assert.equal(model.plan.status, 'blocked');
                assert.equal(api.buildKeywordOptionsViewState(model).canApply, false);
                assert.deepEqual(model.plan.replacementRecords, []);
                assert.ok(model.managerCards.every(card => card.line <= task.records.length + 1 && card.fields.every(field => !field.editable)));
                const applyEdit = vscodeMock.workspace.applyEdit;
                let writes = 0;
                vscodeMock.workspace.applyEdit = async () => { writes++; return true; };
                try {
                    assert.equal(await api.applyKeywordOptionViewModel({ getModel: () => model, markStale() {} }, editor), null);
                    assert.equal(writes, 0);
                    assert.equal(doc.getText(), text);
                } finally { vscodeMock.workspace.applyEdit = applyEdit; }
            }
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
