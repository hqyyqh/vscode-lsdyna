'use strict';

const assert = require('assert');
const {
    selectFieldHelp,
    formatFieldHelpMarkdown,
} = require('../../../src/core/hover/fieldHelpPresentation');

describe('fieldHelpPresentation', () => {
    describe('selectFieldHelp', () => {
        it('uses localized help as primary with English secondary for Chinese UI', () => {
            assert.deepStrictEqual(
                selectFieldHelp('Set ID.', '集合 ID。', 'zh-cn'),
                { primary: '集合 ID。', secondary: 'Set ID.' }
            );
        });

        it('keeps English primary for English UI and untranslated Chinese fields', () => {
            assert.deepStrictEqual(
                selectFieldHelp('Set ID.', '集合 ID。', 'en'),
                { primary: 'Set ID.', secondary: null }
            );
            assert.deepStrictEqual(
                selectFieldHelp('Set ID.', null, 'zh-cn'),
                { primary: 'Set ID.', secondary: null }
            );
        });
    });

    describe('formatFieldHelpMarkdown', () => {
        it('formats primary help without an English action when no secondary exists', () => {
            const md = formatFieldHelpMarkdown({ primary: 'Only text', secondary: null });
            assert.strictEqual(md, 'Only text');
            assert.ok(!md.includes('command:'));
        });

        it('keeps English hidden when no original link is available', () => {
            const md = formatFieldHelpMarkdown({
                primary: '集合 ID。',
                secondary: 'Set ID.',
            });
            assert.strictEqual(md, '集合 ID。');
        });

        it('prefixes Chinese help with one original link and no tooltip', () => {
            const english = 'EQ.0: Off\nEQ.1: On';
            const href = 'command:extension.showFieldHelpEnglish?%5B%22abc%22%5D';
            const md = formatFieldHelpMarkdown(
                { primary: '开关。', secondary: english },
                { summaryLabel: '原文', englishCommandHref: href },
            );
            assert.strictEqual(md, `[原文](${href}) 开关。`);
            assert.ok(!md.includes('EQ.0: Off'));
            assert.ok(!md.includes('EQ.1: On'));
        });

        it('preserves primary newlines', () => {
            const md = formatFieldHelpMarkdown({ primary: '行一\n行二', secondary: null });
            assert.strictEqual(md, '行一  \n行二');
        });
    });
});
