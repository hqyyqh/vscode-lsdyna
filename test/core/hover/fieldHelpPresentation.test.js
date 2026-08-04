'use strict';

const assert = require('assert');
const {
    selectFieldHelp,
    formatFieldHelpMarkdown,
    escapeHtml,
    isShortEnglish,
    previewEnglish,
    SHORT_ENGLISH_MAX_CHARS,
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

    describe('isShortEnglish', () => {
        it('treats empty as short', () => {
            assert.strictEqual(isShortEnglish(''), true);
            assert.strictEqual(isShortEnglish(null), true);
            assert.strictEqual(isShortEnglish('   '), true);
        });

        it('treats single-line short text as short', () => {
            assert.strictEqual(isShortEnglish('Set ID.'), true);
            assert.strictEqual(isShortEnglish('a'.repeat(SHORT_ENGLISH_MAX_CHARS)), true);
        });

        it('treats single-line over cap as long', () => {
            assert.strictEqual(isShortEnglish('a'.repeat(SHORT_ENGLISH_MAX_CHARS + 1)), false);
        });

        it('treats multi-line as long even when short total length', () => {
            assert.strictEqual(isShortEnglish('EQ.0:\nOff'), false);
            assert.strictEqual(isShortEnglish('Line1\r\nLine2'), false);
        });
    });

    describe('previewEnglish', () => {
        it('returns empty for blank input', () => {
            assert.strictEqual(previewEnglish(''), '');
            assert.strictEqual(previewEnglish('   \n  '), '');
        });

        it('keeps a short single line without ellipsis', () => {
            assert.strictEqual(previewEnglish('Set ID.'), 'Set ID.');
            assert.strictEqual(previewEnglish('a'.repeat(SHORT_ENGLISH_MAX_CHARS)), 'a'.repeat(SHORT_ENGLISH_MAX_CHARS));
        });

        it('truncates a long first line with ellipsis', () => {
            const long = 'X'.repeat(SHORT_ENGLISH_MAX_CHARS + 10);
            const preview = previewEnglish(long);
            assert.strictEqual(preview.length, SHORT_ENGLISH_MAX_CHARS + 1);
            assert.ok(preview.endsWith('…'));
            assert.strictEqual(preview.slice(0, SHORT_ENGLISH_MAX_CHARS), 'X'.repeat(SHORT_ENGLISH_MAX_CHARS));
        });

        it('uses first line only and adds ellipsis when multi-line', () => {
            assert.strictEqual(previewEnglish('EQ.0: Off\nEQ.1: On'), 'EQ.0: Off…');
        });
    });

    describe('formatFieldHelpMarkdown', () => {
        it('formats primary only without muted span when no secondary', () => {
            const md = formatFieldHelpMarkdown({ primary: 'Only text', secondary: null });
            assert.strictEqual(md, 'Only text');
            assert.ok(!md.includes('opacity'));
            assert.ok(!md.includes('descriptionForeground'));
            assert.ok(!md.includes('<details'));
            assert.ok(!md.includes('command:'));
        });

        it('puts Chinese primary before muted English secondary HTML for short EN', () => {
            const md = formatFieldHelpMarkdown({
                primary: '集合 ID。',
                secondary: 'Set ID.',
            });
            const zhAt = md.indexOf('集合');
            const enAt = md.indexOf('Set ID.');
            const styleAt = md.indexOf('opacity');
            assert.ok(zhAt >= 0);
            assert.ok(enAt > zhAt);
            assert.ok(styleAt > zhAt);
            assert.ok(md.includes('descriptionForeground') || md.includes('opacity:0.72'));
            assert.ok(!md.includes('<details'));
            assert.ok(!md.includes('command:'));
            assert.ok(md.includes('<span'));
        });

        it('previews long multi-line English and adds command link', () => {
            const longEn = 'EQ.0: Off\nEQ.1: On\nMore detail here.';
            const href = 'command:extension.showFieldHelpEnglish?%5B%22abc%22%5D';
            const md = formatFieldHelpMarkdown(
                { primary: '开关。', secondary: longEn },
                { summaryLabel: '英文原文', englishCommandHref: href },
            );
            assert.ok(md.includes('开关。'));
            assert.ok(md.includes('EQ.0: Off…'));
            assert.ok(md.includes('<span'));
            assert.ok(md.includes('[英文原文](' + href));
            assert.ok(!md.includes('<details'));
            assert.ok(!md.includes('EQ.1: On'));
        });

        it('previews long single-line English without requiring href', () => {
            const long = 'X'.repeat(SHORT_ENGLISH_MAX_CHARS + 5);
            const md = formatFieldHelpMarkdown({ primary: '中文', secondary: long });
            assert.ok(md.includes('…'));
            assert.ok(md.includes('<span'));
            assert.ok(!md.includes('command:'));
            assert.ok(!md.includes('<details'));
        });

        it('escapes HTML in secondary and preserves newlines in primary', () => {
            const md = formatFieldHelpMarkdown({
                primary: '行一\n行二',
                secondary: 'LT.0.0: a < b & c',
            });
            assert.ok(md.includes('行一  \n行二'));
            assert.ok(md.includes('LT.0.0: a &lt; b &amp; c'));
            assert.ok(!md.includes('a < b'));
            assert.ok(md.includes('<span'));
            assert.ok(!md.includes('<details'));
        });

        it('escapes angle brackets in multi-line preview', () => {
            const md = formatFieldHelpMarkdown(
                { primary: '中文', secondary: 'a < b\nsecond line' },
                { summaryLabel: 'EN', englishCommandHref: 'command:extension.showFieldHelpEnglish?%5B%221%22%5D' },
            );
            assert.ok(md.includes('a &lt; b…'));
            assert.ok(md.includes('[EN](command:extension.showFieldHelpEnglish'));
        });
    });

    describe('escapeHtml', () => {
        it('escapes ampersand angle brackets and quotes', () => {
            assert.strictEqual(
                escapeHtml('a < b & "c"'),
                'a &lt; b &amp; &quot;c&quot;'
            );
        });
    });
});
