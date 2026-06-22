'use strict';

const assert = require('assert');
const {
    findLatestValidRevision,
    isValidUtf8,
    normalizeRecoveredMarkdown,
    shouldRecoverDocument,
} = require('../scripts/recover-superpowers-docs.cjs');

describe('recover-superpowers-docs', () => {
    it('recognizes valid and invalid UTF-8 buffers without replacement decoding', () => {
        assert.equal(isValidUtf8(Buffer.from('有效 UTF-8', 'utf8')), true);
        assert.equal(isValidUtf8(Buffer.from([0xe6, 0x3f, 0xad])), false);
    });

    it('selects the newest historical revision whose blob is strict UTF-8', () => {
        const blobs = new Map([
            ['newest', Buffer.from([0xe6, 0x3f, 0xad])],
            ['older-valid', Buffer.from('恢复内容', 'utf8')],
            ['oldest', Buffer.from('更早内容', 'utf8')],
        ]);
        const revision = findLatestValidRevision(
            ['newest', 'older-valid', 'oldest'],
            commit => blobs.get(commit)
        );
        assert.equal(revision, 'older-valid');
    });

    it('returns null when no historical revision is recoverable', () => {
        const revision = findLatestValidRevision(
            ['broken'],
            () => Buffer.from([0xff])
        );
        assert.equal(revision, null);
    });

    it('removes trailing spaces while preserving recovered UTF-8 text', () => {
        const normalized = normalizeRecoveredMarkdown(Buffer.from('**架构：** \r\n正文  \n', 'utf8'));
        assert.equal(normalized.toString('utf8'), '**架构：**\r\n正文\n');
    });

    it('keeps recovery reproducible after the working copy has already been repaired', () => {
        const valid = Buffer.from('已恢复', 'utf8');
        const invalid = Buffer.from([0xe6, 0x3f, 0xad]);
        assert.equal(shouldRecoverDocument(valid, invalid), true);
        assert.equal(shouldRecoverDocument(invalid, valid), true);
        assert.equal(shouldRecoverDocument(valid, valid), false);
    });
});
