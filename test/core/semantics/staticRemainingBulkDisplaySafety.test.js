'use strict';
require("../../support/register-out");
const assert = require('node:assert/strict');
const assertReadonlyReader = require('../../support/keyword-manager/readonly-reader.cjs');
const vscode = require('vscode');
const { fakeDoc } = require("../../support/helpers");
const extension = require("../../../out/extension")._internals;
const assertNativeReferenceAuthority = require("../../support/native-reference-authority");
const { nativeKeywordTemplate } = require("../../../out/core/completion/nativeKeywordTemplate");
const { nativeConditionalBinding } = require("../../../out/core/semantics/nativeConditionalLayout");
const fixture = require("../../fixtures/public-behavior/static-remaining-bulk-display.json");

describe('static remaining bulk display-only operation boundaries', function () {
    this.timeout(120000);
    it('retains explicit parameter references in a newly bound native field', async () => {
        const doc = fakeDoc('*PARAMETER\nIPID     42\n*MAT_007\n&PID,0,0,0,0,0,0,0\n*END');
        extension.setReferenceQueryClientForTesting(require('../../support/parameter-project.cjs').parameterDocumentQueryClient(doc));
        try {
            const locations = await new extension.LsdynaReferenceProvider().provideReferences(doc,
                new vscode.Position(3, 2), { includeDeclaration: true }, { isCancellationRequested: false });
            assert.deepEqual(locations.map(location => location.range.start.line), [3]);
            const definition = await new extension.LsdynaDefinitionProvider().provideDefinition(doc,
                new vscode.Position(3, 2), { isCancellationRequested: false });
            assert.equal(definition.range.start.line, 1);
        } finally { extension.setReferenceQueryClientForTesting(null); }
    });
    it('checks all proven bindings in four formats against archived records and protects read-only files', async () => {
        const references = new extension.LsdynaReferenceProvider();
        const identities = fixture.identities;
        assert.equal(identities.length, fixture.baseKeywords.length + fixture.addedKeywords.length);
        for (const keyword of fixture.addedKeywords) assert.ok(identities.some(item => item.keyword === keyword));
        let recordsChecked = 0, fieldsChecked = 0;
        for (const identity of identities) {
            const keyword = identity.keyword, binding = nativeConditionalBinding(keyword);
            assert.equal(binding.displayOnly, true, keyword);
            assert.equal(binding.kind, identity.classification === 'fixed-one' ? 'conditional-sequence' : 'fixed-instances', keyword);
            assert.equal(nativeKeywordTemplate(keyword).reason, 'native-edit-binding-unverified', keyword);
            for (const format of ['standard', 'comma', 'long', 'i10']) {
                const task = identity.cases.find(task => task.format === format);
                assert.ok(task, keyword + ': missing archived format/count');
                const observation = task;
                assert.equal(observation.observed, 'observed', task.id);
                assert.equal(observation.records.length, binding.kind === 'fixed-instances' ? 3 : 1, task.id);
                const file = `D:/bulk-display/${keyword}-${format}.k`;
                const doc = fakeDoc([...task.lines, ...task.lines, '*END'].join('\n'), file);
                Object.assign(doc, { languageId: 'lsdyna', version: 1, eol: 1, uri: vscode.Uri.file(file) });
                for (const blockStart of [0, task.lines.length]) for (const record of observation.records) {
                    const line = blockStart + record.lineOffset;
                    const card = extension.getCardInfoForDocumentLineWithSuggest(doc, line).cardInfo?.card;
                    assert.ok(card?.length, task.id + ':' + line + ': missing display fields');
                    assert.deepEqual(card.map(field => [field.nativeIdentity?.fieldRecordId, field.n, field.t]),
                        record.fields.map(([address, name, type]) => [address, /^\s*[-_]*\s*$/.test(name) ? 'UNUSED' : name,
                            [0, -2].includes(Number(type)) ? 'string' : Math.abs(Number(type)) === 1 ? 'integer' : 'real']),
                        task.id + ':' + line + ': native identity drift');
                    assert.equal(extension.getCardFieldsForLine(doc, line), null, task.id + ': formatting authorized');
                    recordsChecked++;
                    for (const field of card) {
                        const position = new vscode.Position(line, field.p + Math.floor(field.w / 2));
                        assertNativeReferenceAuthority(extension, doc, position, field, card, keyword, format, task.id);
                        assert.deepEqual(await references.provideReferences(doc, position,
                            { includeDeclaration: true }, { isCancellationRequested: false }), [], task.id + ': fallback reference authorized');
                        fieldsChecked++;
                    }
                }
                const model = extension.buildKeywordOptionViewModel({ document: doc,
                    selection: { active: new vscode.Position(0, 0) } }, 0, {});
                assert.equal(extension.buildKeywordOptionsViewState(model).canApply, false, task.id);
                const managerFields = model.managerCards.flatMap(card => card.fields || []);
                assert.ok(managerFields.length, task.id + ': no manager display fields');
                assertReadonlyReader(doc);
            }
        }
        console.log(`    Bulk display-only: ${identities.length} identities, ${identities.length * 4} format cases, ${recordsChecked} records, ${fieldsChecked} fields`);
    });
});
