'use strict';
require('./register-out');
const assert = require('node:assert/strict');
const vscode = require('vscode');
const { fakeDoc } = require('./helpers');
const extension = require('../out/extension')._internals;
const { nativeKeywordTemplate } = require('../out/core/completion/nativeKeywordTemplate');
const { nativeSpellingBinding, nativeSpellingGap } = require("../out/core/semantics/catalogNativeFileLayout");
const path = require('node:path');
const fs = require('node:fs'), zlib = require('node:zlib');
const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/public-behavior/single-card-suffix-display.json.gz'))));
const plan = { identities: fixture.identities, tasks: fixture.tasks };
const analysis = { identities: fixture.classifications };
function published(keyword) {
    const observed = analysis.identities.find(item => item.keyword === keyword);
    assert.ok(observed, keyword + ': missing native classification');
    const binding = nativeSpellingBinding(keyword);
    if (observed.classification === 'mixed-or-incomplete') {
        const gap = nativeSpellingGap(keyword);
        assert.equal(binding, undefined, keyword + ': mixed observation must not gain a binding');
        assert.ok(gap && (gap.reason || gap.reasons?.length), keyword + ': explicit evidence gap missing');
        return false;
    }
    assert.ok(binding?.noPrefixRepeatEvidence, keyword + ': published native evidence missing');
    return true;
}

describe('single-card suffix display-only operation boundaries', function () {
    this.timeout(120000);
    it('accounts for 207 identities and keeps display bindings unauthorized for formatting and insertion', () => {
        assert.equal(plan.identities.length, 207);
        for (const keyword of plan.identities) {
            if (!published(keyword)) {
                assert.equal(nativeKeywordTemplate(keyword).status, 'retained-unverified', keyword + ': gap template authorization');
                continue;
            }
            const binding = nativeSpellingBinding(keyword);
            assert.ok(binding?.noPrefixRepeatEvidence, keyword + ': published native evidence missing');
            assert.equal(binding.displayOnly, true, keyword);
            assert.equal(binding.prefixCard, undefined, keyword);
            const task = plan.tasks.find(task => task.keyword === keyword && task.format === 'standard' && task.repeatCount === 2);
            const doc = fakeDoc([...task.lines, '*END'].join('\n'), `D:/suffix-display/${keyword}.k`);
            assert.ok(extension.getCardInfoForDocumentLineWithSuggest(doc, 1).cardInfo?.card?.length,
                keyword + ': absence of display data must not make safety test vacuous');
            assert.equal(extension.getCardFieldsForLine(doc, 1), null, keyword + ': formatting geometry authorized');
            assert.equal(nativeKeywordTemplate(keyword).reason, 'native-edit-binding-unverified', keyword);
        }
    });
    it('blocks manager writes and reference lookup on displayed fields', async () => {
        const references = new extension.LsdynaReferenceProvider();
        for (const keyword of plan.identities) {
            if (!published(keyword)) continue;
            assert.ok(nativeSpellingBinding(keyword)?.noPrefixRepeatEvidence, keyword + ': binding missing');
            const task = plan.tasks.find(task => task.keyword === keyword && task.format === 'standard' && task.repeatCount === 2);
            const doc = fakeDoc([...task.lines, '*END'].join('\n'), `D:/suffix-display/${keyword}.k`);
            Object.assign(doc, { languageId: 'lsdyna', version: 1, eol: 1,
                uri: vscode.Uri.file(`D:/suffix-display/${keyword}.k`) });
            const model = extension.buildKeywordOptionViewModel({ document: doc,
                selection: { active: new vscode.Position(0, 0) } }, 0, {});
            assert.equal(extension.buildKeywordOptionsViewState(model).canApply, false, keyword);
            const fields = model.managerCards.flatMap(card => card.fields || []);
            assert.ok(fields.length, keyword + ': no displayed manager fields');
            assert.ok(fields.every(field => !field.editable), keyword + ': editable display field');
            assert.equal(extension.keywordManagerEditField(model, fields[0].fieldId, '1'), null,
                keyword + ': unauthorized manager edit');
            const card = extension.getCardInfoForDocumentLineWithSuggest(doc, 1).cardInfo.card;
            const position = new vscode.Position(1, card[0].nativeRange.start);
            assert.equal(extension.fieldReferenceAtPosition(doc, position), null, keyword);
            assert.deepEqual(await references.provideReferences(doc, position,
                { includeDeclaration: true }, { isCancellationRequested: false }), [], keyword);
        }
    });
});
