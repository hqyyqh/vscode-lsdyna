'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require('./helpers');
const vscode = require('./vscode-mock');
const { LsdynaFieldHoverProvider, LsdynaFieldCompletionProvider, getCardFieldsForLine } = require('../out/extension')._internals;

describe('mixed-case schema identities through providers', function () {
    this.timeout(15000);
    it('keeps material identity and TITLE offsets for all affected spellings', async () => {
        const hoverProvider = new LsdynaFieldHoverProvider();
        const completionProvider = new LsdynaFieldCompletionProvider();
        for (const keyword of ['MAT_115_o', 'MAT_115_o_TITLE', 'MAT_249_UDfiber', 'MAT_249_UDfiber_TITLE']) {
            const title = keyword.endsWith('_TITLE');
            for (const spelling of [keyword, keyword.toUpperCase(), keyword.toLowerCase()]) {
                const doc = fakeDoc(['*' + spelling, ...(title ? ['case-sensitive help identity'] : []),
                    '         1' + ' '.repeat(70), '*END'].join('\n'));
                const line = title ? 2 : 1;
                const hover = await hoverProvider.provideHover(doc, new vscode.Position(line, 1));
                assert.ok(hover, spelling);
                assert.match(hover.contents[0].value, /\*\*MID\*\*/);
                assert.match(hover.contents[0].value, /Material identification/);
                assert.equal(hover.range.start.character, 0);
                assert.equal(hover.range.end.character, 10);
                const items = await completionProvider.provideCompletionItems(doc, new vscode.Position(line, 0),
                    { isCancellationRequested: false }, { triggerKind: 0 });
                assert.deepEqual(items, [], 'Display recovery must not open insertion permissions: ' + spelling);
                assert.equal(getCardFieldsForLine(doc, line), null, 'Formatting/edit geometry remains unverified');
                if (title) {
                    const heading = await hoverProvider.provideHover(doc, new vscode.Position(1, 1));
                    assert.match(heading.contents[0].value, /\*\*TITLE\*\*/);
                }
            }
        }
    });
});
