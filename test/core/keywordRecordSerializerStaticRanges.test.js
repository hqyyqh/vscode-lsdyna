'use strict';

const assert = require('assert');
const { formattedReadRanges } = require('../../out/core/edit/keywordRecordSerializer');

const fields = (count, width = 10) => Array.from({ length: count }, (_, index) => ({
    name: `F${index}`,
    type: 2,
    position: index * width,
    width,
}));

describe('Static descriptor read ranges', () => {
    it('clips standard, LONG and I10 windows to the characters present', () => {
        assert.deepEqual(formattedReadRanges(fields(3), '123456789012345', 'standard'), [
            { start: 0, end: 10 }, { start: 10, end: 15 }, { start: 15, end: 15 },
        ]);
        assert.deepEqual(formattedReadRanges(fields(3), 'x'.repeat(25), 'long'), [
            { start: 0, end: 20 }, { start: 20, end: 25 }, { start: 25, end: 25 },
        ]);
        assert.deepEqual(formattedReadRanges(fields(3), 'x'.repeat(15), 'i10'), [
            { start: 0, end: 10 }, { start: 10, end: 15 }, { start: 15, end: 15 },
        ]);
    });

    it('uses native read geometry before clipping fixed-width ranges', () => {
        const geometry = fields(2).map((field, index) => ({
            ...field,
            nativeReadGeometry: {
                long: { position: index * 24, width: 24 },
                i10: { position: index * 12, width: 12 },
            },
        }));
        assert.deepEqual(formattedReadRanges(geometry, 'x'.repeat(30), 'long'), [
            { start: 0, end: 24 }, { start: 24, end: 30 },
        ]);
        assert.deepEqual(formattedReadRanges(geometry, 'x'.repeat(18), 'i10'), [
            { start: 0, end: 12 }, { start: 12, end: 18 },
        ]);
    });

    it('trims comma tokens and represents empty or missing values as zero-width ranges', () => {
        const text = '  one ,   , &P  ';
        const ranges = formattedReadRanges(fields(4), text, 'comma');
        assert.deepEqual(ranges, [
            { start: 2, end: 5 },
            { start: 10, end: 10 },
            { start: 12, end: 14 },
            { start: text.length, end: text.length },
        ]);
        assert.equal(text.slice(ranges[0].start, ranges[0].end), 'one');
        assert.equal(text.slice(ranges[2].start, ranges[2].end), '&P');

        assert.deepEqual(formattedReadRanges(fields(4), '1, 2', 'comma'), [
            { start: 0, end: 1 }, { start: 3, end: 4 },
            { start: 4, end: 4 }, { start: 4, end: 4 },
        ]);
    });

    it('fails closed for extra comma tokens or unsupported read formats', () => {
        assert.deepEqual(formattedReadRanges(fields(2), '1,2,3', 'comma'), []);
        assert.deepEqual(formattedReadRanges(fields(2), '1 2', 'free'), []);
        assert.deepEqual(formattedReadRanges(fields(1), 'raw', 'raw'), []);
    });

    it('covers a raw title including commas and spaces without accepting unsafe geometry', () => {
        const title = [{ name: 'TITLE', type: 0, position: 0, width: 80 }];
        for (const text of ['', '  标题, title  ', 'x'.repeat(90)]) {
            assert.deepEqual(formattedReadRanges(title, text, 'raw'), [{ start: 0, end: text.length }]);
        }
        for (const invalid of [[{ ...title[0], position: 1 }], [{ ...title[0], width: -1 }], [...title, ...title]])
            assert.deepEqual(formattedReadRanges(invalid, 'title', 'raw'), []);
    });

    it('does not mutate the source geometry while projecting ranges', () => {
        const geometry = fields(2);
        const before = JSON.stringify(geometry);
        formattedReadRanges(geometry, '1,2', 'comma');
        formattedReadRanges(geometry, 'x'.repeat(30), 'long');
        assert.equal(JSON.stringify(geometry), before);
    });
});
