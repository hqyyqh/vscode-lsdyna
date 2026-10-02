'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), zlib = require('node:zlib'), crypto = require('node:crypto');
const { fakeDoc } = require("../../support/helpers");
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve,
    buildKeywordOptionViewModel: model } = require("../../../out/extension")._internals;
const grammar = require("../../../keywords/runtime/native-readers/lspp-batch-fixed-readers.json");
const cases = new Map(JSON.parse(zlib.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/batch-reader-cases.json.gz'))).map(task => [task.id, task]));

describe('batch native fixed readers', () => {
    it('requires the verified source and exact dispatch spelling without replacing prior conditional rules', function () {
        this.timeout(60000);
        const { nativeFileLayoutKind, nativeBatchFixedBinding } = require("../../../out/core/semantics/catalogNativeFileLayout");
        const catalog = require("../../../out/core/semantics/catalogInputFormCatalogV4").getCatalogInputFormCatalogV4();
        for (const [keyword, binding] of Object.entries(grammar.bindings)) {
            const form = catalog.formForKeyword(keyword);
            const rule = { ...form.rules[binding.ruleId], catalogSource: form.source };
            assert.equal(nativeFileLayoutKind({ ...rule, catalogSource: { datasetSha256: 'wrong' } }, keyword), 'unsupported-source');
            assert.equal(nativeFileLayoutKind({ ...rule, cardSetId: '0x0' }, keyword), 'unsupported-source');
            if (!grammar.bindings[keyword + '_TITLE'] &&
                !require("../../../keywords/runtime/native-readers/lspp-suffix-fixed-readers.json").bindings[keyword + '_TITLE'] &&
                !require("../../../keywords/runtime/native-readers/lspp-spelling-file-readers.json").bindings[keyword + '_TITLE'])
                assert.equal(nativeBatchFixedBinding(keyword + '_TITLE'), undefined);
            assert.equal(nativeBatchFixedBinding(keyword + '_TITLE_UNREGISTERED'), undefined);
        }
        for (const keyword of Object.keys(require("../../../keywords/runtime/native-readers/lspp-spelling-file-readers.json").gaps))
            assert.equal(nativeBatchFixedBinding(keyword), undefined);
        const conditional = require("../../../keywords/runtime/native-readers/lspp-ordinal-conditional-readers.json");
        for (const [keyword, binding] of Object.entries(conditional.bindings)) {
            const form = catalog.formForKeyword(keyword);
            const rule = form.reference.formRuleIds.map(id => form.rules[id]).find(rule => rule.cardSetId === binding.cardSetId);
            assert.equal(nativeFileLayoutKind({ ...rule, catalogSource: form.source }, keyword), binding.kind);
        }
        const database = catalog.formForKeyword('DATABASE_BINARY_D3DAT');
        const databaseRule = database.rules[database.reference.formRuleIds[0]];
        assert.equal(nativeFileLayoutKind({ ...databaseRule, catalogSource: database.source }, 'DATABASE_BINARY_D3DAT'), null,
            'retain the existing record grammar, including its optional trailing record');
    });
    it('does not grant an existing operation association from help or a partial card match', () => {
        const { loadKeywordSchema, resolveCardForDocumentLine } = require("../../../out/core/keywordSchema");
        const schema = loadKeywordSchema(), keyword = 'LOAD_BODY_Z';
        const task = [...cases.values()].find(task => task.keyword === keyword && task.format === 'standard');
        const doc = { ...fakeDoc(task.lines.join('\n')), version: 1 };
        const read = source => resolveCardForDocumentLine(doc, 1, source).cardInfo.card;
        assert.ok(read(schema).every(field => field.nativeStaticBinding));
        const changed = { ...schema, [keyword]: structuredClone(schema[keyword]) };
        changed[keyword].c[0][1].n = 'OTHER';
        const fields = read(changed);
        assert.ok(fields.every(field => !field.nativeStaticBinding));
        assert.ok(fields.every(field => field.nativeIdentity));
    });
    it('matches independent field identities, values and real hover ranges in all archived formats', async function () {
        this.timeout(180000);
        const provider = new LsdynaFieldHoverProvider();
        const seen = new Map();
        for (const task of cases.values()) {
            const doc = { ...fakeDoc(task.lines.join('\n'), `/native-fixed/${task.id}.k`), version: 1 };
            const formats = seen.get(task.keyword) || new Set(); formats.add(task.format); seen.set(task.keyword, formats);
            for (const record of task.expectedRecords) {
                const result = resolve(doc, record.lineOffset), info = result.cardInfo;
                assert.ok(info, `${task.keyword} ${task.format}: ${result.reason}`);
                assert.deepEqual(info.card.map(f => f.nativeIdentity.fieldRecordId), record.fields.map(f => f.address), task.keyword);
                assert.deepEqual(info.card.map(f => f.rawValue), record.fields.map(f => f.value), `${task.keyword} ${task.format}`);
                for (const field of info.card) {
                    const hover = await provider.provideHover(doc, { line: record.lineOffset, character: field.p });
                    assert.ok(hover?.contents[0].value.includes(`**${field.n}**`), `${task.keyword}: ${field.n}`);
                    assert.equal(hover.range.start.character, field.p);
                    const end = Math.min(task.lines[record.lineOffset].length,
                        field.p + (task.format === 'comma' ? field.rawValue.length : field.w));
                    assert.equal(hover.range.end.character, end, `${task.keyword} ${task.format} ${field.n}`);
                }
            }
        }
        assert.equal(seen.size, Object.values(grammar.bindings).filter(binding => !binding.readWindows).length);
        for (const formats of seen.values()) assert.equal(formats.size, 4);
    });
    it('keeps fixed source records consistent in manager views with misleading comments', function () {
        this.timeout(120000);
        for (const task of cases.values()) {
            if (task.format !== 'standard') continue;
            const doc = { ...fakeDoc([task.lines[0], '$# WRONG FIELD NAMES', ...task.lines.slice(1)].join('\n'),
                `/native-fixed-manager/${task.id}.k`), version: 1 };
            const views = new Map();
            for (const record of task.expectedRecords) {
                const line = record.lineOffset + 1;
                const source = resolve(doc, line).cardInfo;
                assert.ok(source, task.keyword);
                const instance = source.nativeInstanceStart;
                if (!views.has(instance)) views.set(instance,
                    model({ document: doc, selection: { active: { line, character: 0 } } }, line, {}));
                const view = views.get(instance);
                const card = view.managerCards.find(c => c.line === line);
                assert.ok(card, `${task.keyword}: manager source card ${line}`);
                assert.deepEqual(card.fields.map(f => f.value), source.card.map(f => f.rawValue), task.keyword);
            }
        }
    });
});
