'use strict';
const assert = require('node:assert/strict');
const { vscodeMock } = require("../support/helpers");
const i18n = require('../../out/core/i18n');
const schema = require('../../out/core/keywordSchema');
const { buildFieldHelpMarkdown, keywordHoverMarkdown, buildKeywordSemanticAdviceMarkdown } = require('../../out/extension')._internals;

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
    it('localizes card table labels in both schema and native presentations', () => {
        const entry = { c: [[{ n: 'TITLE', p: 0, w: 80 }]], r: true };
        language('zh-cn');
        const chinese = keywordHoverMarkdown('TEST', entry);
        assert.match(chinese, /卡片/);
        assert.match(chinese, /标题/);
        assert.match(chinese, /最后一张卡片随每行数据重复/);
        assert.match(keywordHoverMarkdown('TEST', entry, [], 'TEST', [], entry.c), /\| 卡片 \|/);
        language('en');
        const english = keywordHoverMarkdown('TEST', entry);
        assert.match(english, /\| Card \|/);
        assert.match(english, /Title/);
        assert.match(english, /Last card repeats/);
    });
});
