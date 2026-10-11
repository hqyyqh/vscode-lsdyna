const assert = require('node:assert/strict');
const { generateCommentLine } = require('../../../src/core/completion/fieldComment');

describe('field comment generation boundaries', () => {
    it('rejects invalid geometry before allocating a fixed comment row', () => {
        for (const card of [
            [{ n: 'A', p: 0, w: 10.5 }], [{ n: 'A', p: -1, w: 10 }],
            [{ n: 'A', p: 0, w: 0 }], [{ n: 'A', p: 0, w: NaN }],
            [{ n: 'A', p: 0, w: Infinity }], [{ n: 'A', p: 65536, w: 1 }],
            [{ n: 'A', p: 0, w: Number.MAX_SAFE_INTEGER }], [null],
            [{ n: 'A', p: 0, w: 10 }, { n: 'B', p: 1.5, w: 10 }],
        ]) assert.equal(generateCommentLine(card), '', JSON.stringify(card));
    });

    it('preserves compact wide labels and the record width ceiling', () => {
        for (const width of [81, 512, 65536]) {
            assert.equal(generateCommentLine([{ n: 'PATH', p: 0, w: width }]), '$# path');
            assert.equal(generateCommentLine([{ n: 'PATH', p: 0, w: width }], 'dollar-pipe-fixed', 'upper'), '$ PATH');
        }
    });

    it('keeps fixed labels, gaps, coercible numeric geometry and pipe positions', () => {
        const card = [{ n: 'A', p: '0', w: '10' }, { n: 'B', p: 20, w: 10 }];
        assert.equal(generateCommentLine(card), '$#       a                   b');
        assert.equal(generateCommentLine(card, 'dollar-pipe-fixed', 'upper'), '$        A          |        B');
    });

    it('describes legitimate shared byte ranges without overlapping label writes', () => {
        const card = [{ n: 'A', p: 0, w: 10 }, { n: 'B', p: 5, w: 10 }];
        assert.equal(generateCommentLine(card), '$# a [1-10] | b [6-15]');
        assert.equal(generateCommentLine(card, 'dollar-pipe-fixed', 'upper'), '$ A [1-10] | B [6-15]');
    });
});
