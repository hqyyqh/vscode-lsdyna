'use strict';
require("../../support/register-out");
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { fakeDoc } = require("../../support/helpers");
const extension = require("../../../out/extension")._internals;
const assertNativeReferenceAuthority = require("../../support/native-reference-authority");
const { nativeKeywordTemplate } = require("../../../out/core/completion/nativeKeywordTemplate");
const { nativeSpellingBinding, nativeSpellingGap } = require("../../../out/core/semantics/catalogNativeFileLayout");
const fixture = require("../../fixtures/public-behavior/single-card-prefix-scope-display.json");

describe('single-card prefix scope display-only operation boundaries', function () {
    this.timeout(120000);
    it('accounts for all 124 identities and verifies displayed native identities without edit authorization', async () => {
        const report = fixture;
        const references = new extension.LsdynaReferenceProvider();
        let bindings = 0, gaps = 0;
        assert.equal(report.identities.length, 124);
        for (const identity of report.identities) {
            const keyword = identity.keyword, binding = nativeSpellingBinding(keyword), gap = nativeSpellingGap(keyword);
            if (!binding) {
                assert.ok(gap && (gap.reason || gap.reasons?.length), keyword + ': missing explicit evidence gap');
                assert.equal(nativeKeywordTemplate(keyword).status, 'retained-unverified', keyword + ': gap insertion authorized');
                gaps++;
                continue;
            }
            bindings++;
            assert.ok(binding.prefixScopeEvidence || binding.numericPrefixEvidence, keyword + ': binding lacks independent prefix scope evidence');
            assert.notEqual(identity.classification, 'ambiguous', keyword + ': ambiguous scope gained binding');
            assert.equal(binding.displayOnly, true, keyword);
            assert.ok(binding.prefixCard, keyword + ': prefix card missing');
            assert.equal(nativeKeywordTemplate(keyword).reason, 'native-edit-binding-unverified', keyword);
            for (const format of ['standard', 'comma', 'long', 'i10']) {
                const task = identity.cases.find(task => task.format === format);
                assert.ok(task, keyword + ': missing contrast task');
                const observation = task;
                assert.ok(observation.records.length >= 2, task.id + ': missing actual prefix/body read');
                // Two keyword blocks also exercise the boundary for fixed-one readers.
                const doc = fakeDoc([...task.lines, ...task.lines, '*END'].join('\n'), `D:/prefix-display/${keyword}-${format}.k`);
                Object.assign(doc, { languageId: 'lsdyna', version: 1, eol: 1,
                    uri: vscode.Uri.file(`D:/prefix-display/${keyword}-${format}.k`) });
                for (const blockStart of [0, task.lines.length]) {
                    for (const record of observation.records) {
                        const line = blockStart + record.lineOffset;
                        const card = extension.getCardInfoForDocumentLineWithSuggest(doc, line).cardInfo?.card;
                        assert.ok(card?.length, task.id + ':' + line + ': missing display fields');
                        assert.deepEqual(card.map(field => [field.nativeIdentity?.fieldRecordId, field.n, field.t]),
                            record.fields.map(([address, name, type]) => [address, /^\s*[-_]*\s*$/.test(name) ? 'UNUSED' : name,
                                [0, -2].includes(Number(type)) ? 'string' : Math.abs(Number(type)) === 1 ? 'integer' : 'real']),
                            task.id + ':' + line + ': wrong native prefix/body identity');
                        assert.equal(extension.getCardFieldsForLine(doc, line), null, task.id + ': formatting authorized');
                        for (const field of card) {
                            const position = new vscode.Position(line, field.p + Math.floor(field.w / 2));
                            assertNativeReferenceAuthority(extension, doc, position, field, card, keyword, format, task.id);
                            assert.deepEqual(await references.provideReferences(doc, position,
                                { includeDeclaration: true }, { isCancellationRequested: false }), [], task.id);
                        }
                        if (keyword === 'AIRBAG_REFERENCE_GEOMETRY_RDT_TITLE' && format === 'standard' &&
                            blockStart === 0 && record.lineOffset === 2) {
                            const nid = card.find(field => field.n === 'NID'), x = card.find(field => field.n === 'X');
                            assert.equal(nid.nativeIdentity.fieldRecordId, "record:be72f73ab914ef36120044a5:0c0853ccac229175cbbcf08d");
                            assert.equal(x.p, nid.p + nid.w);
                            assert.equal(doc.lineAt(line).text.slice(nid.p, nid.p + nid.w).trim(), '1000305');
                            assertNativeReferenceAuthority(extension, doc, new vscode.Position(line, x.p),
                                nid, card, keyword, format, task.id + ': caret after NID');
                        }
                    }
                }
                if (format === 'standard') {
                    const model = extension.buildKeywordOptionViewModel({ document: doc,
                        selection: { active: new vscode.Position(0, 0) } }, 0, {});
                    assert.equal(extension.buildKeywordOptionsViewState(model).canApply, false, keyword);
                    const fields = model.managerCards.flatMap(card => card.fields || []);
                    assert.ok(fields.length, keyword + ': no displayed manager fields');
                    for (const field of fields.filter(field => !field.editable)) assert.equal(extension.keywordManagerEditField(model, field.fieldId, '1'), null,
                        keyword + ': unauthorized manager edit');
                }
            }
        }
        assert.ok(bindings > 0, 'no bindings were actually verified');
        assert.equal(bindings + gaps, 124);
        console.log(`    Prefix scope: ${bindings} display bindings verified; ${gaps} explicit gaps remain unverified`);
    });
});
