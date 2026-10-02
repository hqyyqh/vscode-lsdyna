'use strict';

const assert = require('assert');
const {
    classifyOpaqueCommentDirective,
    classifyInlineCommentedKeyword,
    isColumnZeroKeywordBoundary,
    resolveOpaqueLocationFromBlocks,
    resolveOpaqueLocationBounded,
} = require('../../../src/core/parser/opaqueCommentRange');

describe('opaqueCommentRange', () => {
    it('recognizes only exact column-zero COMMENT directives', () => {
        assert.deepEqual(classifyOpaqueCommentDirective('*COMMENT'), {
            kind: 'comment', tokenStart: 0, tokenEnd: 8,
        });
        assert.deepEqual(classifyOpaqueCommentDirective('*comment_noecho, disabled'), {
            kind: 'comment-noecho', tokenStart: 0, tokenEnd: 15,
        });
        assert.deepEqual(classifyOpaqueCommentDirective(Buffer.from('*CoMmEnT\t*NODE')), {
            kind: 'comment', tokenStart: 0, tokenEnd: 8,
        });
        for (const text of [' *COMMENT', '\t*COMMENT', '$*COMMENT', '*COMMENTARY', '*COMMENT_X', '*COMMENT$']) {
            assert.equal(classifyOpaqueCommentDirective(text), null, text);
        }
    });

    it('recognizes only the manual inline disabled-keyword form', () => {
        assert.deepEqual(classifyInlineCommentedKeyword('*COMMENT  *MAT_024_TITLE'), {
            kind: 'comment', tokenStart: 0, tokenEnd: 8, keywordStart: 10,
        });
        assert.deepEqual(classifyInlineCommentedKeyword('*COMMENT_NOECHO\t*DEFINE_CURVE'), {
            kind: 'comment-noecho', tokenStart: 0, tokenEnd: 15, keywordStart: 16,
        });
        assert.equal(classifyInlineCommentedKeyword('*COMMENT'), null);
        assert.equal(classifyInlineCommentedKeyword('*COMMENT ordinary text'), null);
        assert.equal(classifyInlineCommentedKeyword('*COMMENT  $ already a line comment'), null);
    });

    it('treats any column-zero asterisk as a boundary', () => {
        assert.equal(isColumnZeroKeywordBoundary('*END'), true);
        assert.equal(isColumnZeroKeywordBoundary('*PRIVATE'), true);
        assert.equal(isColumnZeroKeywordBoundary('*'), true);
        assert.equal(isColumnZeroKeywordBoundary(' *END'), false);
        assert.equal(isColumnZeroKeywordBoundary('$*END'), false);
    });

    it('resolves COMMENT token separately from its suffix and body using blocks', () => {
        const blocks = [
            { keyword: 'COMMENT', startLine: 2, endLine: 5, opaqueKind: 'comment', opaqueStartCharacter: 8 },
            { keyword: 'END', startLine: 6, endLine: 6 },
        ];
        assert.equal(resolveOpaqueLocationFromBlocks(blocks, 2, 7).state, 'active');
        assert.equal(resolveOpaqueLocationFromBlocks(blocks, 2, 8).state, 'opaque');
        assert.equal(resolveOpaqueLocationFromBlocks(blocks, 5, 0).state, 'opaque');
        assert.equal(resolveOpaqueLocationFromBlocks(blocks, 6, 0).state, 'active');
        assert.equal(resolveOpaqueLocationFromBlocks(blocks, 0, 0).state, 'active');
        assert.equal(resolveOpaqueLocationFromBlocks([{ startLine: 2, endLine: 1 }], 2, 0).state, 'unknown');
        assert.equal(resolveOpaqueLocationFromBlocks([
            { keyword: '*COMMENT', startLine: 2, endLine: 5 },
        ], 3, 0).state, 'unknown');
    });

    it('uses a bounded backward resolver and fails closed when proof is out of budget', () => {
        const lines = [
            '*KEYWORD',
            '*COMMENT   *INCLUDE',
            ' *END',
            '$*END',
            'body.k',
            '*PRIVATE',
            'active',
        ];
        const readLine = line => lines[line];
        assert.equal(resolveOpaqueLocationBounded(readLine, 1, 7).state, 'active');
        assert.equal(resolveOpaqueLocationBounded(readLine, 1, 8).state, 'opaque');
        assert.equal(resolveOpaqueLocationBounded(readLine, 4, 0).state, 'opaque');
        assert.equal(resolveOpaqueLocationBounded(readLine, 5, 0).state, 'active');
        assert.equal(resolveOpaqueLocationBounded(readLine, 6, 0).state, 'active');
        assert.equal(resolveOpaqueLocationBounded(readLine, 4, 0, { maxLookbackLines: 1 }).state, 'unknown');
        assert.equal(resolveOpaqueLocationBounded(readLine, 4, 0, { maxLineCharacters: 2 }).state, 'unknown');
    });
});
