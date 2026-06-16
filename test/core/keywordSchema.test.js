'use strict';

const assert = require('assert');
const { fakeDoc } = require('../helpers');

describe('keywordSchema resolver', () => {
    it('resolves title variants to canonical schema and renders TITLE first', () => {
        const { lookupKeywordSchema, getRenderedCards } = require('../../src/core/keywordSchema');

        const lookup = lookupKeywordSchema('MAT_001_TITLE');
        assert.ok(lookup);
        assert.equal(lookup.inputName, 'MAT_001_TITLE');
        assert.equal(lookup.canonicalName, 'MAT_001');
        assert.deepEqual(lookup.activeOptions, ['TITLE']);

        const rendered = getRenderedCards(lookup.entry, lookup.activeOptions);
        assert.equal(rendered[0][0].n, 'TITLE');
        assert.equal(rendered[1][0].n, 'MID');
    });

    it('resolves manifest aliases to the canonical card schema', () => {
        const { lookupKeywordSchema } = require('../../src/core/keywordSchema');

        const lookup = lookupKeywordSchema('SET_NODE');
        assert.ok(lookup);
        assert.equal(lookup.canonicalName, 'SET_NODE_LIST');
        assert.equal(lookup.entry.c[0][0].n, 'SID');
    });

    it('matches CONTACT optional cards by observed data line count', () => {
        const { getCardForDocumentLine } = require('../../src/core/keywordSchema');
        const doc = fakeDoc([
            '*CONTACT_AUTOMATIC_SURFACE_TO_SURFACE',
            'base card 1',
            'base card 2',
            'base card 3',
            'optional card A',
            'optional card B',
            'optional card C',
            'optional card D',
            'optional card E',
            'optional card F',
            ''
        ].join('\n'));

        const optionA = getCardForDocumentLine(doc, 4);
        assert.ok(optionA);
        assert.equal(optionA[0].n, 'SOFT');

        const optionF = getCardForDocumentLine(doc, 9);
        assert.ok(optionF);
        assert.equal(optionF[0].n, 'PSTIFF');
    });

    it('matches a TITLE data line instead of returning null', () => {
        const { getCardForDocumentLine } = require('../../src/core/keywordSchema');
        const doc = fakeDoc('*MAT_001_TITLE\nMaterial title\n        1\n');

        const titleCard = getCardForDocumentLine(doc, 1);
        assert.ok(titleCard);
        assert.equal(titleCard[0].n, 'TITLE');
    });

    it('keeps old compact entries usable when option metadata is absent', () => {
        const { getRenderedCards } = require('../../src/core/keywordSchema');
        const entry = { c: [[{ n: 'A', p: 0, w: 10 }], [{ n: 'B', p: 0, w: 10 }]], r: 1 };

        const cards = getRenderedCards(entry, [], 4);
        assert.equal(cards.length, 4);
        assert.equal(cards[0][0].n, 'A');
        assert.equal(cards[3][0].n, 'B');
    });

    it('caches loaded schema JSON per language', () => {
        const fs = require('fs');
        const keywordSchema = require('../../src/core/keywordSchema');
        const originalReadFileSync = fs.readFileSync;
        let fieldDataReads = 0;

        keywordSchema.resetKeywordSchemaCache();
        fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
            if (String(filePath).endsWith('field_data.json')) {
                fieldDataReads++;
            }
            return originalReadFileSync.call(this, filePath, ...args);
        };

        try {
            const first = keywordSchema.loadKeywordSchema(() => 'en');
            const second = keywordSchema.loadKeywordSchema(() => 'en');

            assert.strictEqual(first, second);
            assert.equal(fieldDataReads, 1);
        } finally {
            fs.readFileSync = originalReadFileSync;
            keywordSchema.resetKeywordSchemaCache();
        }
    });
});
