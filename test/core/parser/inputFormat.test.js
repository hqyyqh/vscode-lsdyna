'use strict';

const assert = require('assert');
const {
    globalInputFormatFromKeywordLine,
    keywordInputFormat,
    keywordInputFormatOverride,
    stripKeywordInputFormatMarker,
} = require('../../../src/core/parser/inputFormat');

describe('official keyword input format controls', () => {
    it('distinguishes keyword input from structured-deck output mode', () => {
        assert.equal(globalInputFormatFromKeywordLine('*KEYWORD LONG=Y'), 'long');
        assert.equal(globalInputFormatFromKeywordLine('*KEYWORD LONG=K'), 'long');
        assert.equal(globalInputFormatFromKeywordLine('*KEYWORD LONG=S', 'long'), 'standard');
        assert.equal(globalInputFormatFromKeywordLine('*KEYWORD I10=Y'), 'i10');
        assert.equal(globalInputFormatFromKeywordLine('*KEYWORD I10=N', 'i10'), 'standard');
        assert.equal(globalInputFormatFromKeywordLine('*NODE LONG=Y'), 'standard');
    });

    it('honors attached and separated per-keyword overrides', () => {
        assert.equal(keywordInputFormat('*NODE+', 'standard'), 'long');
        assert.equal(keywordInputFormat('*NODE +', 'standard'), 'long');
        assert.equal(keywordInputFormat('*NODE-', 'long'), 'standard');
        assert.equal(keywordInputFormat('*NODE -', 'long'), 'standard');
        assert.equal(keywordInputFormat('*NODE%', 'long'), 'i10');
        assert.equal(keywordInputFormat('*NODE,%', 'standard'), 'i10');
        assert.equal(keywordInputFormat('*NODE', 'long'), 'long');
    });

    it('does not treat marker-like option text as a keyword override', () => {
        assert.equal(keywordInputFormatOverride('*KEYWORD LONG=S'), null);
        assert.equal(keywordInputFormatOverride('*NODE +invalid'), null);
        assert.equal(keywordInputFormatOverride('17 - 3'), null);
        assert.equal(stripKeywordInputFormatMarker('*ELEMENT_SHELL-'), '*ELEMENT_SHELL');
    });
});
