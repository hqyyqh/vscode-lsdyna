'use strict';
const assert = require('node:assert/strict');
const { vscodeMock } = require("../support/helpers");
const i18n = require('../../out/core/i18n');
const schema = require('../../out/core/keywordSchema');
const { buildFieldHelpMarkdown, keywordHoverMarkdown, buildKeywordSemanticAdviceMarkdown } = require('../../out/extension')._internals;
const { LsdynaFieldHoverProvider } = require('../../out/extension')._internals;
const { fakeDoc } = require('../support/helpers');

describe('hover language presentation', () => {
    let configuration;
    let translate;
    beforeEach(() => {
        configuration = vscodeMock.workspace.getConfiguration;
        translate = schema.getLocalizedHelpForText;
        schema.getLocalizedHelpForText = () => null;
    });
    afterEach(() => {
        vscodeMock.workspace.getConfiguration = configuration;
        schema.getLocalizedHelpForText = translate;
        i18n.updateLanguage();
    });
    function language(value) {
        vscodeMock.workspace.getConfiguration = () => ({ get: key => key === 'language' ? value : undefined });
        i18n.updateLanguage();
    }
    it('uses complete option help in Chinese, preserves its original action, and rejects changed sources', () => {
        const source = 'Use OPTION only if FLAG = 1.';
        const advice = { keyword: '*TEST', optionSlots: [{ slot: 'OPTION', required: false, summary: source, evidence: [] }] };
        schema.getLocalizedHelpForText = text => text === source ? '仅当 FLAG = 1 时使用 OPTION。' : null;
        language('zh-cn');
        const chinese = buildKeywordSemanticAdviceMarkdown(advice);
        assert.match(chinese, /仅当 FLAG = 1 时使用 OPTION/);
        assert.match(chinese, /command:extension.showFieldHelpEnglish/);
        advice.optionSlots[0].summary = 'Use OPTION only if FLAG = 2.';
        const changed = buildKeywordSemanticAdviceMarkdown(advice);
        assert.match(changed, /FLAG = 2/);
        assert.match(changed, /暂无已核对中文说明/);
        assert.doesNotMatch(changed, /仅当 FLAG = 1/);
        language('en');
        const english = buildKeywordSemanticAdviceMarkdown(advice);
        assert.match(english, /Use OPTION only if FLAG = 2\./);
        assert.doesNotMatch(english, /暂无|仅当/);
    });
    it('keeps the provisional warning and English original without exposing database provenance', () => {
        language('zh-cn');
        schema.getLocalizedHelpForText = text => text === 'Unique source description.' ? '唯一的来源说明。' : null;
        const markdown = buildFieldHelpMarkdown({ n: 'TEST', nativeIdentity: true }, { schemaText: 'Unique source description.' });
        assert.match(markdown, /暂定说明/);
        assert.match(markdown, /字段定义/);
        assert.doesNotMatch(markdown, /LS-PrePost|LSPP/i);
        assert.match(markdown, /唯一的来源说明/);
        assert.match(markdown, /command:extension.showFieldHelpEnglish/);
    });
    it('retains untranslated source and identifies its translation gap', () => {
        language('zh-cn');
        schema.getLocalizedHelpForText = () => null;
        const markdown = buildFieldHelpMarkdown({ n: 'TEST', nativeIdentity: true }, { schemaText: 'Exact unknown source.' });
        assert.match(markdown, /暂无已核对的中文译文/);
        assert.match(markdown, /Exact unknown source\./);
    });
    it('keeps English mode and localizes generated fallback in Chinese mode', () => {
        language('en');
        const field = { n: 'TEST', nativeIdentity: true, t: 'integer', p: 0, w: 10 };
        assert.match(buildFieldHelpMarkdown(field), /Provisional.*field name/s);
        assert.match(buildFieldHelpMarkdown(field), /columns 1-10/);
        language('zh-cn');
        assert.match(buildFieldHelpMarkdown(field), /类型：整数，第 1—10 列/);
    });
    it('keeps all physical field ranges in a compact horizontal Hover table', async () => {
        const doc = fakeDoc('*NODE\n       1             0.0             0.0             0.0\n*END');
        for (const locale of ['zh-cn', 'en']) {
            language(locale);
            const hover = await new LsdynaFieldHoverProvider().provideHover(doc, { line: 1, character: 2 });
            const markdown = hover.contents[0].value;
            assert.ok(!markdown.includes('$(table)'));
            assert.ok(markdown.includes('NID</span></sub>'));
            assert.ok(!markdown.includes('**NID**</span></sub>'));
            assert.ok(markdown.includes('<sub>1&#8209;8</sub>'));
            for (const [name, columns] of [['X', '9-24'], ['Y', '25-40'], ['Z', '41-56']]) {
                assert.ok(markdown.includes(`<sub>${name}</sub>`), name);
                assert.ok(markdown.includes(`<sub>${columns.replace('-', '&#8209;')}</sub>`), columns);
            }
        }
    });
    it('shows later cards in ordinary keyword hover without requiring detailed mode', async () => {
        const doc = fakeDoc('*MAT_024\n*END');
        for (const locale of ['zh-cn', 'en']) {
            language(locale);
            const hover = await new LsdynaFieldHoverProvider().provideHover(doc, { line: 0, character: 3 });
            const markdown = hover.contents[0].value;
            for (const field of ['MID', 'RO', 'C', 'P', 'LCSS', 'EPS1', 'ES1']) {
                assert.ok(markdown.includes(`<sub>${field}</sub>`), `${locale}: ${field}`);
            }
            assert.equal((markdown.match(/\| ---/g) || []).length, 8, 'one shared eight-column header');
            assert.equal((markdown.match(/<sub>1&#8209;10<\/sub>/g) || []).length, 1, 'ranges appear only once');
            assert.doesNotMatch(markdown, /\*\*(?:MID|LCSS|EPS1|ES1)\*\*/);
            assert.doesNotMatch(markdown, /最后一张卡片随每行数据重复|✨|\$\(table\)/);
        }
    });
    it('retains schema help when the native reader has no current records', async () => {
        const doc = fakeDoc('*MAT_BARLAT_YLD2000\n*END');
        const hover = await new LsdynaFieldHoverProvider().provideHover(doc, { line: 0, character: 3 });
        assert.match(hover.contents[0].value, /<sub>MID<\/sub>/);
        assert.match(hover.contents[0].value, /<sub>HARD<\/sub>/);
    });
    it('marks the complete width of a wide field across shared column intervals', async () => {
        const original = schema.getRenderedCardsForLookup;
        schema.getRenderedCardsForLookup = () => [
            [{ n: 'TITLE', p: 0, w: 80 }],
            [{ n: 'ID', p: 0, w: 10 }, { n: 'VALUE', p: 10, w: 10 }],
        ];
        try {
            const hover = await new LsdynaFieldHoverProvider().provideHover(fakeDoc('*MAT_024\n*END'), { line: 0, character: 3 });
            const rows = hover.contents[0].value.split('\n').filter(line => line.startsWith('|'));
            assert.match(rows[0], /1&#8209;10.*11&#8209;20.*21&#8209;80/);
            assert.equal(rows[2], '| <sub>TITLE</sub> | <sub>→</sub> | <sub>→</sub> |');
            assert.equal(rows[3], '| <sub>ID</sub> | <sub>VALUE</sub> |  |');
        } finally { schema.getRenderedCardsForLookup = original; }
    });
    it('localizes card table labels in both schema and native presentations', () => {
        const entry = { c: [[{ n: 'TITLE', p: 0, w: 80 }]], r: true };
        language('zh-cn');
        const chinese = keywordHoverMarkdown('TEST', entry);
        assert.match(chinese, /卡片/);
        assert.match(chinese, /标题/);
        assert.doesNotMatch(chinese, /最后一张卡片随每行数据重复|✨/);
        assert.match(keywordHoverMarkdown('TEST', entry, [], 'TEST', [], entry.c), /\| 卡片 \|/);
        language('en');
        const english = keywordHoverMarkdown('TEST', entry);
        assert.match(english, /\| Card \|/);
        assert.match(english, /Title/);
        assert.doesNotMatch(english, /Last card repeats|✨/);
    });
});
