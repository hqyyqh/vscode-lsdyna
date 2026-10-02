'use strict';
const assert = require('node:assert/strict');
const {fakeDoc} = require("../../support/helpers");
const {LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve,
    resolveKeywordLookupWithSuggest} = require("../../../out/extension")._internals;
const {KeywordStructureCatalog} = require("../../../out/core/structure/structureCatalog");
describe('known keyword identities without field rules', () => {
    it('never treats a registered input-form spelling as a typo', function () {
        this.timeout(20000);
        const names = Object.keys(require("../../../keywords/runtime/input-form/manifest.json").keywords);
        assert.ok(names.length > 4000);
        for (const name of names) assert.equal(resolveKeywordLookupWithSuggest(null,0,name).viaSuggest,false,name);
    });
    it('never substitutes a similar keyword for any manual-only census identity', async function () {
        this.timeout(20000);
        const entries = require("../../fixtures/public-behavior/manual-only-keyword-names.json");
        assert.equal(entries.length,201);
        const provider = new LsdynaFieldHoverProvider();
        for (const entry of entries) for (const marker of ['', '+', ' +', '-', ' %', ',+']) {
            const doc = fakeDoc('*' + entry.keyword + marker + '\n         1\n*END');
            const result = resolve(doc,1);
            assert.equal(result.viaSuggest,false,entry.keyword + marker);
            assert.equal(result.suggestedName,null,entry.keyword + marker);
            const hover = await provider.provideHover(doc,{line:1,character:5},{isCancellationRequested:false});
            if (hover) assert.ok(hover.contents.every(c => !c.value?.includes('similar keyword')),entry.keyword);
        }
        const cese = fakeDoc('*CESE\n         1\n*END');
        assert.equal(await provider.provideHover(cese,{line:1,character:5},{isCancellationRequested:false}),null);
    });
    it('does not mistake unavailable identity evidence for an unknown spelling', () => {
        const catalog = new KeywordStructureCatalog({runtimeRoot:require('node:path').join(__dirname,"../../missing-runtime")});
        assert.equal(catalog.hasKeywordIdentity('CESE'),null);
        const valid = new KeywordStructureCatalog();
        assert.equal(valid.hasKeywordIdentity('CESE'),true);
        assert.equal(valid.hasKeywordIdentity('AN_INTENTIONAL_UNKNOWN_TEST_KEYWORD'),false);
    });
});
