'use strict';

const assert = require('assert');
const fieldData = require('../../keywords/field_data.json');
const {
    classifyGrid,
    clearCell,
    readCellValue,
    writeCellR1,
    cardTotalWidth,
} = require('../../src/core/edit/cardCellModel');
const { isLongFormatKeyword } = require('../../src/core/keywordSchema');

// Helpers mirror test/editor-safety/cardLayoutSafety.test.js (the canonical
// 495-layout iteration that locks the 20,780 / 20,726 / 117,738 / 495 inventory).
// Keep these in sync if the generated schema iteration changes.
function collectCards(schema) {
    const cards = [];
    for (const [keyword, entry] of Object.entries(schema)) {
        for (const [index, card] of (entry.c || []).entries()) {
            cards.push({ source: `${keyword}.c[${index}]`, keyword, card });
        }
        for (const [optionIndex, option] of (entry.o || []).entries()) {
            for (const [cardIndex, card] of (option.c || []).entries()) {
                cards.push({
                    source: `${keyword}.o[${optionIndex}].c[${cardIndex}]`,
                    keyword,
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

// Replace one character at column `col` with `,`, keeping line length unchanged.
function withCommaAt(line, col) {
    return line.slice(0, col) + ',' + line.slice(col + 1);
}

describe('editor safety: card-layout dangerous-input fail-closed (495 layouts)', () => {
    const cards = collectCards(fieldData);
    const nonEmptyCards = cards.filter(({ card }) => card.length > 0);
    const distinctLayouts = new Map();
    for (const item of nonEmptyCards) {
        if (!distinctLayouts.has(layoutKey(item.card))) {
            distinctLayouts.set(layoutKey(item.card), item);
        }
    }
    const safeLayouts = [...distinctLayouts.values()].filter(({ card }) => !geometryIssue(card));

    it('locks the same 495-layout inventory as the canonical pass', () => {
        assert.strictEqual(nonEmptyCards.length, 20726);
        assert.strictEqual(distinctLayouts.size, 495);
        assert.ok(safeLayouts.length > 0, 'at least one safe distinct layout must exist');
    });

    // Primary decision item: a comma-free-format line must never be rewritten by
    // fixed-column Tab/cell editing. Any comma in the line closes editing.
    it('closes editing for any comma in the line, for every safe layout', () => {
        for (const { source, card } of safeLayouts) {
            const line = buildPopulatedLine(card);
            const commaLine = withCommaAt(line, card[0].p);
            assert.notStrictEqual(
                classifyGrid(commaLine, card),
                'intact',
                `${source}: a comma in the line must close fixed-column editing (Tab must not rewrite comma-free format)`,
            );
        }
    });

    it('closes editing for a line longer than the card width (overflow), for every safe layout', () => {
        for (const { source, card } of safeLayouts) {
            const total = cardTotalWidth(card);
            const overflow = buildPopulatedLine(card) + 'X'.repeat(4);
            assert.ok(overflow.trimEnd().length > total, `${source}: fixture must overflow`);
            assert.notStrictEqual(
                classifyGrid(overflow, card),
                'intact',
                `${source}: a line longer than the card width must close fixed-column editing`,
            );
        }
    });

    // Boundary width / overflow value: a value longer than the field width must
    // truncate within the cell and must not shift any neighbor column.
    it('truncates an overflow value within the field and keeps every neighbor byte-identical, for every safe layout', () => {
        for (const { source, card } of safeLayouts) {
            const original = buildPopulatedLine(card);
            for (const [index, field] of card.entries()) {
                const overflowValue = 'X'.repeat(field.w + 3);
                const written = writeCellR1(original, card, index, overflowValue);
                assert.strictEqual(
                    written.slice(field.p, field.p + field.w),
                    'X'.repeat(field.w),
                    `${source} field ${index}: overflow value must truncate to the field width`,
                );
                assert.strictEqual(
                    written.slice(0, field.p),
                    original.slice(0, field.p),
                    `${source} field ${index}: bytes before the field must not shift`,
                );
                assert.strictEqual(
                    written.slice(field.p + field.w),
                    original.slice(field.p + field.w),
                    `${source} field ${index}: bytes after the field must not shift`,
                );
            }
        }
    });

    // Empty value: writing empty must read back empty, leave the cell as spaces,
    // and keep every neighbor byte-identical.
    it('writes empty into a field, reads empty back, and keeps every neighbor byte-identical, for every safe layout', () => {
        for (const { source, card } of safeLayouts) {
            const original = buildPopulatedLine(card);
            for (const [index, field] of card.entries()) {
                const written = writeCellR1(original, card, index, '');
                assert.strictEqual(
                    readCellValue(written, card, index),
                    '',
                    `${source} field ${index}: empty write must read empty`,
                );
                assert.strictEqual(
                    written.slice(field.p, field.p + field.w),
                    ' '.repeat(field.w),
                    `${source} field ${index}: empty cell must be all spaces`,
                );
                assert.strictEqual(written.slice(0, field.p), original.slice(0, field.p));
                assert.strictEqual(written.slice(field.p + field.w), original.slice(field.p + field.w));
            }
        }
    });

    it('clears a field to spaces and keeps every neighbor byte-identical, for every safe layout', () => {
        for (const { source, card } of safeLayouts) {
            const original = buildPopulatedLine(card);
            for (const [index, field] of card.entries()) {
                const cleared = clearCell(original, card, index);
                assert.strictEqual(readCellValue(cleared, card, index), '');
                assert.strictEqual(cleared.slice(0, field.p), original.slice(0, field.p));
                assert.strictEqual(cleared.slice(field.p + field.w), original.slice(field.p + field.w));
            }
        }
    });
});

describe('editor safety: same-keyword cross-card mixed format is classified independently', () => {
    function safeMultiCardKeywords(maxCount) {
        const out = [];
        for (const [keyword, entry] of Object.entries(fieldData)) {
            const cards = (entry.c || []).filter(c => c.length > 0 && !geometryIssue(c));
            if (cards.length >= 2) {
                out.push({ keyword, cards });
                if (out.length >= maxCount) break;
            }
        }
        return out;
    }

    // Official rule: fixed and comma formats may mix across different cards of
    // the same keyword, but not within one card. Each (line, card) pair is
    // classified on its own, so cross-card mixing is allowed.
    it('allows a fixed card and a comma card of the same keyword to be classified independently', () => {
        const keywords = safeMultiCardKeywords(5);
        assert.ok(keywords.length > 0, 'schema must have keywords with multiple safe non-empty cards');
        for (const { keyword, cards } of keywords) {
            const cardA = cards[0];
            const cardB = cards[1];
            const fixedLineA = buildPopulatedLine(cardA);
            const commaLineB = withCommaAt(buildPopulatedLine(cardB), cardB[0].p);
            assert.strictEqual(
                classifyGrid(fixedLineA, cardA),
                'intact',
                `${keyword}: fixed card A should be intact`,
            );
            assert.notStrictEqual(
                classifyGrid(commaLineB, cardB),
                'intact',
                `${keyword}: comma card B should close editing`,
            );
        }
    });

    it('closes editing when a single card itself mixes comma into a fixed row (same-card mixing forbidden)', () => {
        const keywords = safeMultiCardKeywords(5);
        for (const { keyword, cards } of keywords) {
            const card = cards[0];
            if (card.length < 2) continue;
            const line = buildPopulatedLine(card);
            const mixedLine = withCommaAt(line, card[1].p);
            assert.notStrictEqual(
                classifyGrid(mixedLine, card),
                'intact',
                `${keyword}: a comma in one field of a fixed row must close editing (same-card mixing forbidden)`,
            );
        }
    });
});

describe('editor safety: collapsed free-format tokens close editing', () => {
    // A short collapsed free-format line on a stringy-field layout: more
    // whitespace tokens than physical non-empty cells, no comma, no overflow.
    // classifyGrid must close editing (messy) rather than rewrite the tokens.
    it('treats a short collapsed free-format line on stringy fields as messy', () => {
        const stringyCard = [
            { p: 0, w: 10, t: 'string' },
            { p: 10, w: 10, t: 'string' },
        ];
        const collapsed = 'a b c d'; // 4 tokens, len 7 < total 20, no comma
        assert.strictEqual(classifyGrid(collapsed, stringyCard), 'messy');
    });

    // The ambiguous "1 2 3 4" free-format line on a numeric card carries
    // internal whitespace inside a non-stringy field, which also closes editing.
    it('treats ambiguous whitespace tokens on a numeric card as messy', () => {
        const numericCard = [
            { p: 0, w: 8, t: 'integer' },
            { p: 8, w: 16, t: 'real' },
            { p: 24, w: 16, t: 'real' },
            { p: 40, w: 16, t: 'real' },
        ];
        assert.strictEqual(classifyGrid('1 2 3 4', numericCard), 'messy');
    });
});

describe('editor safety: long-format keywords are excluded from fixed-column editing', () => {
    // Official Vol I physical pages 397-398 / printed pages 2-31-2-32: long format
    // doubles field widths (I8->I16, I10->I20). The schema hard-codes short-format
    // widths, so a long-format keyword must bail out of column-based cell editing
    // rather than rewrite the line against the wrong widths.
    it('flags per-keyword long format (+) and global LONG=Y/S', () => {
        assert.strictEqual(isLongFormatKeyword('*NODE+'), true);
        assert.strictEqual(isLongFormatKeyword('*ELEMENT_SHELL+'), true);
        assert.strictEqual(isLongFormatKeyword('*KEYWORD LONG=Y'), true);
        assert.strictEqual(isLongFormatKeyword('*KEYWORD LONG=S'), true);
        assert.strictEqual(isLongFormatKeyword('*KEYWORD long=y'), true);
        assert.strictEqual(isLongFormatKeyword('*KEYWORD,LONG=Y'), true);
    });

    it('does not flag ordinary short-format keywords', () => {
        assert.strictEqual(isLongFormatKeyword('*NODE'), false);
        assert.strictEqual(isLongFormatKeyword('*KEYWORD'), false);
        assert.strictEqual(isLongFormatKeyword('*ELEMENT_SHELL'), false);
        assert.strictEqual(isLongFormatKeyword('*KEYWORD LONG=N'), false);
        assert.strictEqual(isLongFormatKeyword('not a keyword'), false);
        assert.strictEqual(isLongFormatKeyword(''), false);
    });
});
