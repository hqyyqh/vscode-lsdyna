'use strict';
require("../../support/register-out");
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { fakeDoc } = require("../../support/helpers");
const extension = require("../../../out/extension")._internals;
const { nativeKeywordTemplate } = require("../../../out/core/completion/nativeKeywordTemplate");
const { nativeSpellingBinding, nativeSpellingGap } = require("../../../out/core/semantics/catalogNativeFileLayout");
const fixture = require("../../fixtures/public-behavior/remaining-title-prefix-display.json");

describe('remaining TITLE prefix display-only operation boundaries', function () {
    this.timeout(120000);
    it('preserves explicit parameter references inside display-only native fields', async () => {
        const doc = fakeDoc('*PARAMETER\nIPID     42\n*DEFINE_CONTROL_VOLUME_TITLE\nVolume\n&PID,0,0\n*END');
        extension.setReferenceQueryClientForTesting(require('../../support/parameter-project.cjs').parameterDocumentQueryClient(doc));
        try {
            const locations = await new extension.LsdynaReferenceProvider().provideReferences(doc,
                new vscode.Position(4, 2), { includeDeclaration: true }, { isCancellationRequested: false });
            assert.deepEqual(locations.map(location => location.range.start.line), [4]);
            const definition = await new extension.LsdynaDefinitionProvider().provideDefinition(doc,
                new vscode.Position(4, 2), { isCancellationRequested: false });
            assert.equal(definition.range.start.line, 1);
        } finally { extension.setReferenceQueryClientForTesting(null); }
    });
    it('accounts for all 21 identities and verifies displayed native identities without edit authorization', async () => {
        const report = fixture;
        const references = new extension.LsdynaReferenceProvider();
        let bindings = 0, gaps = 0;
        assert.equal(report.identities.length, 21);
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
                            const position = new vscode.Position(line, field.nativeRange.start);
                            assert.equal(extension.fieldReferenceAtPosition(doc, position), null, task.id);
                            assert.deepEqual(await references.provideReferences(doc, position,
                                { includeDeclaration: true }, { isCancellationRequested: false }), [], task.id);
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
        assert.equal(bindings, 20); assert.equal(gaps, 1);
        assert.equal(bindings + gaps, 21);
        console.log(`    Prefix scope: ${bindings} display bindings verified; ${gaps} explicit gaps remain unverified`);
    });
});
