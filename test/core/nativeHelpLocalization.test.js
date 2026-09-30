'use strict';
const assert = require('node:assert/strict');
const { fakeDoc } = require('../helpers');
const vscode = require('../vscode-mock');
const schema = require('../../out/core/keywordSchema');
const { buildHelpTextIndex } = require('../../scripts/generate-field-help-runtime.cjs');

describe('source-bound help translations', function () {
    this.timeout(20000);
    it('keeps source-review metadata out of the runtime text index', () => {
        const index = buildHelpTextIndex([], [{ english: 'Value…', localized: '值…',
            sourceIssue: 'INTERNAL_REVIEW_MARKER', reviewNotes: 'INTERNAL_REVIEW_NOTES' }]);
        assert.deepEqual(Object.values(index), ['值…']);
        assert.doesNotMatch(JSON.stringify(index), /sourceIssue|reviewNotes|INTERNAL_REVIEW/);
    });
    it('reuses an identical existing Chinese slot instead of storing its text twice', () => {
        const shards = [{ payload: { start: 0, english: ['Value.'], localized: ['值。'] } }];
        const rows = [{ english: 'Value.', localized: '值。' }, { english: ' Value. ', localized: '值。' }];
        assert.deepEqual(Object.values(buildHelpTextIndex(shards, rows)), [0]);
        assert.throws(() => buildHelpTextIndex(shards, [...rows, { english: 'Value.', localized: '不同的值。' }]), /Conflicting/);
        assert.deepEqual(Object.values(buildHelpTextIndex(shards, [{ english: 'Value.', localized: '新译文。' }])), ['新译文。']);
    });
    it('does not reuse conflicting translations or ignore changed source tokens', () => {
        const index = buildHelpTextIndex([{ payload: { start: 0,
            english: ['Value > 0.', 'Value  >\n0.', 'Value < 0.'],
            localized: ['值大于 0。', '不同的译文。', '值小于 0。'] } }]);
        assert.equal(Object.keys(index).length, 1);
        assert.deepEqual(Object.values(index), [2]);
        assert.deepEqual(Object.values(buildHelpTextIndex([], [
            { english: 'Value.', localized: '值。' },
            { english: ' Value. ', localized: '值。' },
        ])), ['值。']);
        assert.throws(() => buildHelpTextIndex([], [
            { english: 'Value.', localized: '值。' },
            { english: ' Value. ', localized: '不同的值。' },
        ]), /Conflicting/);
    });

    it('rejects an old slot translation after the English is replaced', () => {
        const field = schema.loadKeywordSchema().NODE.c[0][0];
        assert.ok(schema.getLocalizedFieldHelp(field));
        assert.equal(schema.getLocalizedFieldHelp({ ...field, h: 'A new unreviewed definition.' }), null);
        assert.equal(schema.getLocalizedHelpForText('A new unreviewed definition.'), null);
    });

    it('uses the complete manual parameter text rather than the original schema translation', () => {
        const lookup = schema.lookupKeywordSchema('PARAMETER', schema.loadKeywordSchema());
        const field = lookup.entry.c[0][0];
        assert.match(schema.getEnglishFieldHelp(field), /Appendix U/);
        assert.match(schema.getLocalizedFieldHelp(field), /附录 U/);
        assert.match(schema.getLocalizedFieldHelp(field), /TIME/);
    });

    it('shares the source-bound translation with native keyword-manager help', () => {
        const { keywordManagerHelpState } = require('../../out/extension')._internals;
        const result = keywordManagerHelpState({ currentKeyword: 'MAT_ELASTIC', selectedFieldId: 'ro',
            managerCards: [{ fields: [{ fieldId: 'ro', name: 'RO' }] }],
            targetLayout: { records: [{ lsppCardIndex: 1, fields: [{ fieldMigrationId: 'ro' }] }] },
            helpContext: { branchEvidence: 'native-file-reader', nativeForm: {
                cards: [{ cardIndex: 1, fields: [{ fieldIndex: 0, name: 'RO', help: 'Mass density.' }] }],
            } },
        });
        assert.equal(result.english, 'Mass density.');
        assert.equal(result.localized, '质量密度。');
    });

    it('translates native E and ELFORM in real Chinese provider output and preserves English mode', async () => {
        const prior = vscode.workspace.getConfiguration;
        const i18n = require('../../out/core/i18n');
        const { LsdynaFieldHoverProvider } = require('../../out/extension')._internals;
        try {
            for (const language of ['zh-cn', 'en']) {
                vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'language' ? language : fallback });
                i18n.updateLanguage();
                for (const [keyword, row, character, english, chinese] of [
                    ['MAT_ELASTIC', '         1      7800     2.1e5       0.3', 20, "Definition of Young's modulus", '杨氏模量'],
                    ['SECTION_SHELL', '         1         2', 10, 'ELFORM Element formulation options', '单元'],
                ]) {
                    const hover = await new LsdynaFieldHoverProvider().provideHover(
                        fakeDoc(`*${keyword}\n${row}\n*END`), { line: 1, character });
                    const text = hover.contents[0].value;
                    assert.ok(text.includes(language === 'zh-cn' ? chinese : english), `${language} ${keyword}`);
                    if (language === 'zh-cn') assert.ok(!text.includes(english), keyword);
                }
            }
        } finally {
            vscode.workspace.getConfiguration = prior;
            i18n.updateLanguage();
        }
    });
});
