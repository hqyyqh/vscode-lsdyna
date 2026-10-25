'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require('../../support/helpers');
const { LsdynaFieldHoverProvider } = require('../../../out/extension')._internals;

describe('local hover preparation', () => {
    for (const line of [0, 1]) it(`shows ${line ? 'field' : 'keyword'} help without preparing unrelated include blocks`, async () => {
        const doc = fakeDoc(['*DATABASE_BINARY_D3PLOT', '     0.005',
            ...Array.from({ length: 50 }, (_, index) => ['*INCLUDE', `missing-${index}.k`]).flat(), '*END'].join('\n'));
        const read = doc.lineAt.bind(doc);
        const reads = [];
        doc.lineAt = index => { reads.push(index); return read(index); };
        const hover = await new LsdynaFieldHoverProvider().provideHover(doc, { line, character: line ? 5 : 2 });
        assert.ok(hover);
        assert.ok(!reads.includes(100), 'Local help waited for unrelated include blocks');
    });
});
