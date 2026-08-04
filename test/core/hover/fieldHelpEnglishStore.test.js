'use strict';

const assert = require('assert');
const {
    FIELD_HELP_ENGLISH_STORE_MAX,
    stashFieldHelpEnglish,
    getFieldHelpEnglish,
    clearFieldHelpEnglishStore,
    fieldHelpEnglishStoreSize,
} = require('../../../src/core/hover/fieldHelpEnglishStore');

describe('fieldHelpEnglishStore', () => {
    beforeEach(() => {
        clearFieldHelpEnglishStore();
    });

    afterEach(() => {
        clearFieldHelpEnglishStore();
    });

    it('stashes and retrieves text by id', () => {
        const id = stashFieldHelpEnglish('EQ.0: Off\nEQ.1: On');
        assert.ok(id && typeof id === 'string');
        assert.strictEqual(getFieldHelpEnglish(id), 'EQ.0: Off\nEQ.1: On');
        // multi-click: still present
        assert.strictEqual(getFieldHelpEnglish(id), 'EQ.0: Off\nEQ.1: On');
    });

    it('returns undefined for unknown id', () => {
        assert.strictEqual(getFieldHelpEnglish('missing'), undefined);
        assert.strictEqual(getFieldHelpEnglish(''), undefined);
    });

    it('evicts oldest entries when over capacity', () => {
        const ids = [];
        for (let i = 0; i < FIELD_HELP_ENGLISH_STORE_MAX + 3; i++) {
            ids.push(stashFieldHelpEnglish(`text-${i}`));
        }
        assert.strictEqual(fieldHelpEnglishStoreSize(), FIELD_HELP_ENGLISH_STORE_MAX);
        assert.strictEqual(getFieldHelpEnglish(ids[0]), undefined);
        assert.strictEqual(getFieldHelpEnglish(ids[1]), undefined);
        assert.strictEqual(getFieldHelpEnglish(ids[2]), undefined);
        assert.strictEqual(
            getFieldHelpEnglish(ids[ids.length - 1]),
            `text-${FIELD_HELP_ENGLISH_STORE_MAX + 2}`
        );
    });
});
