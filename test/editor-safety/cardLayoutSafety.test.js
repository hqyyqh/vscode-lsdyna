'use strict';

const assert = require('assert');
const fieldData = require('../../keywords/field_data.json');
const {
    classifyGrid,
    clearCell,
    readCellValue,
    writeCellR1,
} = require('../../src/core/edit/cardCellModel');

function collectCards(schema) {
    const cards = [];
    for (const [keyword, entry] of Object.entries(schema)) {
        for (const [index, card] of (entry.c || []).entries()) {
            cards.push({ source: `${keyword}.c[${index}]`, card });
        }
        for (const [optionIndex, option] of (entry.o || []).entries()) {
            for (const [cardIndex, card] of (option.c || []).entries()) {
                cards.push({
                    source: `${keyword}.o[${optionIndex}].c[${cardIndex}]`,
                    card,
                });
            }
        }
    }
    return cards;
}

function layoutKey(card) {
    return card.map(field => `${field.p}:${field.w}:${field.t || ''}`).join('|');
}

function geometryIssue(card) {
    let previousEnd = -1;
    for (const [index, field] of card.entries()) {
        if (!Number.isInteger(field.p) || field.p < 0) {
            return `field ${index} has invalid start ${field.p}`;
        }
        if (!Number.isInteger(field.w) || field.w <= 0) {
            return `field ${index} has invalid width ${field.w}`;
        }
        if (index > 0 && field.p < previousEnd) {
            return `field ${index} starts at ${field.p} before previous end ${previousEnd}`;
        }
        previousEnd = field.p + field.w;
    }
    return null;
}

function makeValue(field, fieldIndex) {
    const type = String(field.t || '').toLowerCase();
    const candidates = type === 'real'
        ? ['-1.2E-3', '-1.2', '1']
        : type === 'integer'
            ? ['-17', '7']
            : ['&PARAM', 'TEXT', 'X'];
    return candidates.find(value => value.length <= field.w) || 'X'.slice(0, field.w);
}

function buildPopulatedLine(card) {
    let line = ' '.repeat(Math.max(...card.map(field => field.p + field.w)));
    for (const [index, field] of card.entries()) {
        line = writeCellR1(line, card, index, makeValue(field, index));
    }
    return line;
}

describe('editor safety: complete card-layout inventory', () => {
    const cards = collectCards(fieldData);
    const nonEmptyCards = cards.filter(({ card }) => card.length > 0);
    const distinctLayouts = new Map();
    for (const item of nonEmptyCards) {
        if (!distinctLayouts.has(layoutKey(item.card))) {
            distinctLayouts.set(layoutKey(item.card), item);
        }
    }

    it('locks the complete generated-schema inventory used by this safety pass', () => {
        assert.strictEqual(Object.keys(fieldData).length, 5362);
        assert.strictEqual(cards.length, 20780);
        assert.strictEqual(nonEmptyCards.length, 20726);
        assert.strictEqual(
            nonEmptyCards.reduce((sum, { card }) => sum + card.length, 0),
            117738,
        );
        assert.strictEqual(distinctLayouts.size, 495);
    });

    it('fails closed for every overlapping or otherwise invalid schema geometry', () => {
        const unsafe = nonEmptyCards.filter(({ card }) => geometryIssue(card));
        assert.ok(unsafe.length > 0, 'fixture must exercise unsafe schema geometries');

        const failures = unsafe.filter(({ card }) => {
            const total = Math.max(...card.map(field => field.p + Math.max(0, field.w)));
            return classifyGrid(' '.repeat(total), card) !== 'off';
        });

        assert.deepStrictEqual(
            failures.map(({ source, card }) => ({
                source,
                issue: geometryIssue(card),
            })),
            [],
            'unsafe card geometry must never enter fixed-column editing',
        );
    });

    it('keeps neighboring slices byte-identical for every safe distinct layout', () => {
        for (const { source, card } of distinctLayouts.values()) {
            if (geometryIssue(card)) continue;
            const original = buildPopulatedLine(card);

            if (!(card.length === 1 && card[0].w >= 40)) {
                assert.strictEqual(
                    classifyGrid(original, card),
                    'intact',
                    `${source} should be recognized as an intact fixed-width layout`,
                );
            }

            for (const [index, field] of card.entries()) {
                const cleared = clearCell(original, card, index);
                assert.strictEqual(
                    cleared.slice(0, field.p),
                    original.slice(0, field.p),
                    `${source} field ${index} changed bytes before its slice`,
                );
                assert.strictEqual(
                    cleared.slice(field.p + field.w),
                    original.slice(field.p + field.w),
                    `${source} field ${index} changed bytes after its slice`,
                );
                assert.strictEqual(readCellValue(cleared, card, index), '');
            }
        }
    });

    it('round-trips representative engineer inputs that fit each safe field', () => {
        for (const { source, card } of distinctLayouts.values()) {
            if (geometryIssue(card)) continue;
            let line = ' '.repeat(Math.max(...card.map(field => field.p + field.w)));
            for (const [index, field] of card.entries()) {
                const value = makeValue(field, index);
                line = writeCellR1(line, card, index, value);
                assert.strictEqual(
                    readCellValue(line, card, index),
                    value,
                    `${source} field ${index} failed to round-trip ${value}`,
                );
            }
        }
    });
});
