const assert = require('assert');

describe('keywordLine', () => {
    it('classifies indented mixed-case keyword lines', () => {
        const { classifyKeywordLine } = require('../../../out/core/parser/keywordLine');

        assert.deepStrictEqual(classifyKeywordLine('\t *Include,foo'), {
            isKeyword: true,
            indent: 2,
            rawKeyword: '*Include',
            normalizedKeyword: '*INCLUDE',
            hasLowercase: true,
        });
    });

    it('finds a keyword asterisk after spaces and tabs only', () => {
        const { findKeywordAsterisk } = require('../../../out/core/parser/keywordLine');

        assert.strictEqual(findKeywordAsterisk(Buffer.from(' \t*include')), 2);
        assert.strictEqual(findKeywordAsterisk(Buffer.from('  123')), -1);
    });
});
