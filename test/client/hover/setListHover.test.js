'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve,
    getCardFieldsForLine } = require("../../../out/extension")._internals;
const archives = require("../../fixtures/public-behavior/set-list-readers.json");
const evidence = archives[0];

describe('SET list shared file reader', function () {
    this.timeout(30000);
    it('keeps ordinary list bindings display-only and rejects template insertion', () => {
        const bindings = require("../../../keywords/runtime/native-readers/lspp-conditional-layout-readers.json").bindings;
        for (const name of new Set(archives.flatMap(archive => archive.cases.map(sample => sample.keyword)))) {
            const binding = bindings[name];
            assert.deepEqual(binding.steps, [1, { repeatToEnd: 2 }]);
            assert.equal(binding.displayOnly, true);
            assert.equal(require("../../../out/core/completion/nativeKeywordTemplate").nativeKeywordTemplate(name).status, 'retained-unverified');
        }
    });
    it('allows verified manager field drafts while retaining observed record identities', () => {
        const vscode = require('vscode');
        const { buildKeywordOptionViewModel: model, buildKeywordOptionsViewState: view } = require("../../../out/extension")._internals;
        for (const archive of archives) for (const sample of archive.cases.filter(c => c.format === 'standard' && c.listRecords === 3)) {
            const text = archive.input.split('\n').slice(sample.keywordLine, sample.endLine).concat('*END').join('\n');
            const doc = fakeDoc(text);
            Object.assign(doc, { languageId: 'lsdyna', version: 1, eol: 1, uri: vscode.Uri.file('D:/temp/set-list.k') });
            const result = model({ document: doc, selection: { active: new vscode.Position(0, 0) } }, 0, {});
            assert.equal(view(result).canApply, false);
            assert.ok(result.managerCards.length >= 4, sample.keyword);
            assert.ok(result.managerCards.every(c => c.editable), sample.keyword);
            const field = result.managerCards[1].fields[0];
            const drafts = require("../../../out/extension")._internals.keywordManagerEditField(result, field.fieldId, '77');
            const staged = model({ document: doc, selection: { active: new vscode.Position(0, 0) } }, 0, drafts);
            assert.equal(view(staged).canApply, true, sample.keyword);
            assert.equal(doc.getText(), text, 'Preparing a draft must not write to the document');
        }
    });
    it('replays all 288 independent spelling, format and repetition observations through hover', async () => {
      for (const archive of archives) {
        const doc = fakeDoc(archive.input), provider = new LsdynaFieldHoverProvider();
        let records = 0, fields = 0;
        for (const sample of archive.cases) {
            const keys = new Set();
            for (const [row, native] of sample.nativeRecords.entries()) {
                const line = native.sourceLine, info = resolve(doc, line).cardInfo;
                assert.ok(info, `${sample.keyword}/${sample.format}/${row}`);
                assert.equal(info.nativeCardIndex, row ? 2 : 1);
                assert.equal(info.card.length, native.fields.length);
                keys.add(info.card[0].nativeIdentity.recordKey);
                let offset = 0;
                for (const [index, expected] of native.fields.entries()) {
                    const actual = info.card[index], raw = sample.candidateValues[row][index];
                    assert.equal(actual.nativeIdentity.fieldRecordId, expected.descriptorAddress);
                    assert.equal(actual.n, expected.name === '-' ? 'UNUSED' : expected.name);
                    assert.equal(actual.t, expected.type === 0 ? 'string' : expected.type === 1 ? 'integer' : 'real');
                    if (expected.descriptorAddress === "record:6c17c0d6f0b0f85398b38555:995ceec141094a603a73fe98") {
                        assert.equal(actual.d, '1');
                        assert.deepEqual(actual.e, ['1', '2', '3']);
                    }
                    assert.equal(actual.rawValue.trim(), raw);
                    assert.equal(actual.nativeStaticBinding, undefined);
                    // Input construction and archived physical lines are the range oracle.
                    const width = sample.format === 'comma' ? raw.length : sample.format === 'long' ? 20 : 10;
                    assert.deepEqual(actual.nativeRange, { start: offset, end: offset + width });
                    if (width && expected.name !== '-' && expected.name.toLowerCase() !== 'unused') {
                        const hover = await provider.provideHover(doc, { line, character: offset }, { isCancellationRequested: false });
                        assert.ok(hover, `${sample.keyword}/${line}/${expected.name}`);
                        assert.ok(hover.contents.some(c => c.value?.replace(/`/g, '').includes(`**${expected.name}**`)));
                        assert.equal(hover.range.start.character, offset);
                        assert.equal(hover.range.end.character, offset + width);
                    }
                    offset += width + Number(sample.format === 'comma');
                    fields++;
                }
                assert.equal(getCardFieldsForLine(doc, line), null, 'Display verification does not authorize formatting');
                records++;
            }
            assert.equal(keys.size, sample.listRecords + 1);
        }
        assert.equal(records, archive.cases.length * 7 / 3);
        assert.ok(fields > 1000);
      }
        // Retain the independent native normalization counterexamples.
        assert.equal(evidence.failures.length, 24);
        assert.ok(evidence.failures.every(f => f.issues.join() === 'native-value/0/6'));
    });
});
