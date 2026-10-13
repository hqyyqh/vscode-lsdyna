'use strict';
const assert = require('node:assert/strict');
const assertReadonlyReader = require('../../support/keyword-manager/readonly-reader.cjs');
const fs = require('node:fs'), zlib = require('node:zlib');
const cases = JSON.parse(zlib.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/suffix-reader-cases.json.gz')));
const samples = JSON.parse(zlib.gunzipSync(fs.readFileSync('test/fixtures/public-behavior/suffixSample-reader-cases.json.gz')));
const { fakeDoc } = require("../../support/helpers");
const { nativeKeywordTemplate } = require("../../../out/core/completion/nativeKeywordTemplate");
const { getCardFieldsForLine, buildKeywordOptionViewModel, buildKeywordOptionsViewState } = require("../../../out/extension")._internals;
const bindings = require("../../../keywords/runtime/native-readers/lspp-suffix-fixed-readers.json").bindings;
function sample(keyword) {
    const matches = Object.values(samples).flat().filter(task => task.keyword === keyword && task.format === 'standard' &&
        task.prefix === (bindings[keyword].prefixSemantics === 'title' ? 'candidate' : 'none'));
    assert.equal(matches.length, 1, `Exactly one observed public case for ${keyword}`);
    return matches[0];
}
describe('observed suffix display operation boundaries', function () {
    this.timeout(60000);
    it('selects the observed file pool across hover and manager without changing GUI aliases', async () => {
        const { resolveCardForDocumentLine, loadKeywordSchema } = require("../../../out/core/keywordSchema");
        const { nativeFileCatalogKeyword, nativeFileLayoutKind } = require("../../../out/core/semantics/catalogNativeFileLayout");
        const catalog = require("../../../out/core/semantics/catalogInputFormCatalogV4").getCatalogInputFormCatalogV4();
        const { LsdynaFieldCompletionProvider } = require("../../../out/extension")._internals;
        const schema = loadKeywordSchema();
        const archive = { plan: { tasks: cases.pools } };
        for (const task of archive.plan.tasks.filter(task => task.prefix === 'none')) {
            const gui = catalog.formForKeyword(task.keyword);
            assert.equal(gui.reference.aliasOf, 'CONSTRAINED_COORDINATE_LOCAL');
            const guiRule = gui.rules[gui.reference.formRuleIds[0]];
            assert.equal(nativeFileLayoutKind({ ...guiRule, catalogSource: gui.source }, task.keyword), 'unsupported-source');
            assert.equal(nativeFileCatalogKeyword(task.keyword), 'CONSTRAINED_COORDINATE');
            const document = { ...fakeDoc(task.lines.join('\n')), version: 1 };
            const card = resolveCardForDocumentLine(document, 1, schema).cardInfo.card;
            const expected = task.expectedRecords[0].fields;
            assert.deepEqual(card.map(f => f.nativeIdentity.fieldRecordId), expected.map(f => f.address));
            const model = buildKeywordOptionViewModel({ document, selection: { active: { line: 1, character: 0 } } }, 1, {});
            const source = model.managerCards.find(card => card.line === 1);
            assert.deepEqual(source.fields.map(f => f.name), expected.map(f => f.name));
            assert.deepEqual(source.fields.map(f => f.value), card.map(f => f.rawValue));
            assertReadonlyReader(document, 1);
            assert.equal(buildKeywordOptionsViewState(model).canApply, false);
            assert.deepEqual(await new LsdynaFieldCompletionProvider().provideCompletionItems(document,
                { line: 1, character: 0 }, null, {}), [], 'Display binding must not grant insertion or old-pool completion');
            // A spelling edit on the same document must replace the pool immediately.
            const prior = document.lineAt.bind(document);
            document.lineAt = line => line === 0 ? { ...prior(line), text: '*CONSTRAINED_COORDINATE_LOCAL' } : prior(line);
            document.version++;
            assert.notDeepEqual(resolveCardForDocumentLine(document, 1, schema).cardInfo.card.map(f => f.nativeIdentity.fieldRecordId), expected.map(f => f.address));
            document.lineAt = prior;
            document.version++;
            assert.deepEqual(resolveCardForDocumentLine(document, 1, schema).cardInfo.card.map(f => f.nativeIdentity.fieldRecordId), expected.map(f => f.address));
        }
    });
    it('keeps formatting and insertion unapproved for every newly observed spelling', () => {
        for (const keyword of Object.keys(bindings)) {
            const task = sample(keyword), document = fakeDoc(task.lines.concat('*END').join('\n'));
            assert.equal(nativeKeywordTemplate(keyword).reason, 'native-edit-binding-unverified', keyword);
            for (let line = 1; line < task.lines.length; line++)
                assert.equal(getCardFieldsForLine(document, line), null, keyword);
        }
    });
    it('protects both prefix mechanisms when the filesystem is read-only', () => {
        const vscode = require('vscode');
        for (const keyword of ['ALE_FRAGMENTATION_TITLE', 'DUALCESE_CONTROL_MESH_MOV_TITLE']) {
            const task = sample(keyword), document = fakeDoc(task.lines.concat('*END').join('\n'));
            Object.assign(document, { languageId: 'lsdyna', version: 1, eol: 1, uri: vscode.Uri.file('D:/temp/suffix-reader.k') });
            const model = buildKeywordOptionViewModel({ document, selection: { active: new vscode.Position(0, 0) } }, 0, {});
            assert.equal(buildKeywordOptionsViewState(model).canApply, false, keyword);
            assert.ok(model.managerCards.length, keyword);
            assertReadonlyReader(document);
        }
    });
});
