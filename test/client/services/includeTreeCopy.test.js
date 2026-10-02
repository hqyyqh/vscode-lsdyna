'use strict';

const assert = require('assert');
const path = require('path');
const {
    buildIncludeCopyChoices,
    truncateForToast,
} = require('../../../src/client/services/includeTreeCopy');

describe('includeTreeCopy', () => {
    describe('buildIncludeCopyChoices', () => {
        it('returns empty for blank paths', () => {
            assert.deepEqual(buildIncludeCopyChoices(''), []);
            assert.deepEqual(buildIncludeCopyChoices('   '), []);
            assert.deepEqual(buildIncludeCopyChoices(null), []);
        });

        it('includes basename and absolute path', () => {
            const abs = path.normalize('D:\\ws\\models\\a.k');
            const choices = buildIncludeCopyChoices(abs);
            assert.ok(choices.some(c => c.id === 'basename' && c.value === 'a.k'));
            assert.ok(choices.some(c => c.id === 'absolute' && c.value === abs));
            assert.ok(!choices.some(c => c.id === 'workspaceRelative'));
        });

        it('includes workspace-relative when distinct from absolute', () => {
            const abs = path.normalize('D:\\ws\\models\\a.k');
            const choices = buildIncludeCopyChoices(abs, {
                asRelativePath: () => 'models/a.k',
            });
            assert.ok(choices.some(c => c.id === 'basename' && c.value === 'a.k'));
            assert.ok(choices.some(c => c.id === 'workspaceRelative' && c.value === 'models/a.k'));
            assert.ok(choices.some(c => c.id === 'absolute'));
        });

        it('skips workspace-relative when equal to absolute path', () => {
            const abs = path.normalize('D:\\ws\\a.k');
            const choices = buildIncludeCopyChoices(abs, {
                asRelativePath: (p) => p,
            });
            assert.ok(!choices.some(c => c.id === 'workspaceRelative'));
            assert.ok(choices.some(c => c.id === 'absolute'));
        });

        it('skips workspace-relative when asRelativePath throws or returns empty', () => {
            const abs = path.normalize('/tmp/x.k');
            assert.ok(!buildIncludeCopyChoices(abs, {
                asRelativePath: () => {
                    throw new Error('no ws');
                },
            }).some(c => c.id === 'workspaceRelative'));
            assert.ok(!buildIncludeCopyChoices(abs, {
                asRelativePath: () => '',
            }).some(c => c.id === 'workspaceRelative'));
        });
    });

    describe('truncateForToast', () => {
        it('returns short strings unchanged', () => {
            assert.equal(truncateForToast('a.k'), 'a.k');
        });

        it('truncates long strings with ellipsis in the middle', () => {
            const long = 'x'.repeat(100);
            const out = truncateForToast(long, 20);
            assert.ok(out.length <= 20);
            assert.ok(out.includes('...'));
        });
    });
});
