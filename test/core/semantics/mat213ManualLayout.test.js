'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require("../../support/helpers");
const { LsdynaFieldHoverProvider, getCardInfoForDocumentLineWithSuggest: resolve } = require("../../../out/extension")._internals;
const { nativeFileReadContext } = require("../../../out/core/semantics/nativeFileReadContext");
const { getCatalogInputFormCatalogV4 } = require("../../../out/core/semantics/catalogInputFormCatalogV4");
describe('MAT213 pinned native LONG dispatch and write compatibility', () => {
    it('shares attached, separated and comma-separated input markers across file consumers', () => {
        for (const keyword of ['MAT_001','MAT_001_TITLE','MAT_ELASTIC','MAT_ELASTIC_TITLE']) {
            const form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
            const rule = {...form.rules[form.reference.formRuleIds[0]],catalogSource:form.source};
            for (const [marker, format, width] of [['+','long',20],['-','standard',10],['%','i10',10]])
                for (const separator of ['', ' ', ',']) {
                    const rows = [...(keyword.endsWith('_TITLE') ? ['test title'] : []),
                        [1,1,1,0.3].map(value => String(value).padStart(width)).join('')];
                    const reading = nativeFileReadContext(rule, '*' + keyword + separator + marker, rows, 'long');
                    assert.equal(reading.input,format);
                    assert.equal(reading.kind,'conditional-sequence');
                    assert.deepEqual(reading.select(false).current.map(record => record.cardIndex),
                        keyword.endsWith('_TITLE') ? [0,1] : [1]);
                }
        }
    });
    for (const keyword of ['MAT_213','MAT_213_TITLE','MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE','MAT_COMPOSITE_TABULATED_PLASTICITY_DAMAGE_TITLE'])
        for (const ftype of [0,1,2,3,4])
        it(`reads ${keyword} FTYPE=${ftype} while preserving native writer restrictions`, async () => {
            const provider = new LsdynaFieldHoverProvider();
            const branch = 8; // Native dispatch reads the blank first ten columns as zero.
            const expected = [1,2,3,4,5,6,7,branch,branch + 1,10,11];
            const rows = expected.map((_,index) => Array.from({length:8}, (__,column) =>
                String(index === 7 && column === 0 ? ftype : 0).padStart(20)).join(''));
            if (ftype === 0 || ftype === 3) rows[8] = '';
            const title = keyword.endsWith('_TITLE'), data = [...(title ? ['native format identity'] : []), ...rows];
            const doc = fakeDoc(['*' + keyword + ' +', ...data, '*END'].join('\n'));
            for (const [index, card] of expected.entries())
                assert.equal(resolve(doc, index + 1 + Number(title)).cardInfo.nativeCardIndex, card);
            const line = 8 + Number(title);
            const hover = await provider.provideHover(doc, {line, character:19}, {isCancellationRequested:false});
            assert.ok(hover.contents.some(c => c.value.includes('**FTYPE**')));
            assert.equal(hover.range.start.character,0); assert.equal(hover.range.end.character,20);
            const form = getCatalogInputFormCatalogV4().formForKeyword(keyword);
            const rule = {...form.rules[form.reference.formRuleIds[0]], catalogSource:form.source};
            const reading = nativeFileReadContext(rule, '*' + keyword + ' +', data, 'standard');
            const selection = reading.select(false);
            assert.equal(selection.current.length, data.length);
            assert.equal(reading.writeCompatible(selection.current), ftype === 0);
            rows[7] = String(ftype).padStart(10) + ' '.repeat(10) + rows[7].slice(20);
            const compatible = nativeFileReadContext(rule, '*' + keyword + ' +', [...(title ? ['native format identity'] : []), ...rows], 'standard');
            assert.equal(compatible.writeCompatible(compatible.select(false).current), true);
            assert.equal(compatible.select(false).current[7 + Number(title)].cardIndex, [8,12,14,16,18][ftype]);
        });
});
