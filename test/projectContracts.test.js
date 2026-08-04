'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    validateManifestLocalization,
    validateParallelMessages,
    validateProjectContracts,
    validateTrackedPaths,
} = require('../scripts/validate-project-contracts.cjs');

describe('project contracts', () => {
    it('keeps manifest, documentation, localization, activation, and UTF-8 contracts valid', () => {
        const errors = validateProjectContracts(path.resolve(__dirname, '..'));
        assert.deepEqual(errors, []);
    });

    it('keeps static NLS copy polished for supported locales', () => {
        const repoRoot = path.resolve(__dirname, '..');
        const en = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.nls.json'), 'utf8'));
        const zh = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.nls.zh-cn.json'), 'utf8'));

        assert.equal(en['commands.scanKeywordIndex.title'], 'Scan Keyword Index');
        assert.equal(en['commands.keywordIndexSetLocal.title'], 'Show Current File');
        assert.equal(en['commands.configureManualsDir.title'], 'Set LS-DYNA Manuals Directory');
        assert.equal(en['commands.openManualReader.title'], 'Open Manual Reader');
        assert.equal(en['commands.openCurrentKeywordManual.title'], 'Open Manual for Current Keyword');
        assert.equal(zh['commands.scanKeywordIndex.title'], '扫描关键字索引');
        assert.equal(zh['commands.keywordIndexSetLocal.title'], '显示当前文件');
        assert.equal(zh['commands.configureManualsDir.title'], '设置 LS-DYNA 手册目录');
        assert.equal(zh['commands.openManualReader.title'], '打开手册阅读器');
        assert.equal(zh['commands.openCurrentKeywordManual.title'], '打开当前关键字的手册');
        assert.match(en['viewsWelcome.lsdynaIncludeTree.contents'], /^Open an LS-DYNA file/);
        assert.match(zh['viewsWelcome.lsdynaIncludeTree.contents'], /^打开 LS-DYNA 文件/);

        const zhText = JSON.stringify(zh);
        for (const phrase of ['(Hover)', '(Configure Folder)', '(Setup Guide)', 'optional cards', 'field data', '扫描全树']) {
            assert.ok(!zhText.includes(phrase), `zh-cn NLS copy should not contain "${phrase}"`);
        }

        const enText = JSON.stringify(en);
        for (const phrase of ['file(s)', 'Full Tree', 'Plug-and-Play', 'Column-Aligned', 'optional cards']) {
            assert.ok(!enText.includes(phrase), `en NLS copy should not contain "${phrase}"`);
        }
    });

    it('rejects locale placeholder drift', () => {
        const errors = [];
        validateParallelMessages(
            new Map([['message', 'Value {0} at {1}']]),
            new Map([['message', '值 {0}']]),
            'en',
            'zh',
            errors
        );
        assert.deepEqual(errors, ['en.message placeholders (0,1) differ from zh (0)']);
    });

    it('rejects hard-coded manifest command copy', () => {
        const errors = [];
        validateManifestLocalization({
            description: '%extension.description%',
            contributes: {
                commands: [{ title: 'Hard-coded command' }],
                viewsContainers: { activitybar: [] },
                views: {},
                viewsWelcome: [],
                configuration: { properties: {} },
                colors: {},
            },
        }, errors);
        assert.deepEqual(errors, ['manifest user-facing text is not localized: contributes.commands[0].title']);
    });

    it('rejects tracked process artifacts while allowing stable maintenance docs', () => {
        const errors = [];
        validateTrackedPaths([
            'docs/field-data-zh-translation-guide.md',
            'docs/reports/field-data-zh/final.json',
            '.github/analysis/2026-05-18-include-tree-analysis.md',
            '.github/release-appendix.md',
            '.github/workflows/ci.yml',
            'keywords/field_data_translation_review.py',
        ], errors);
        assert.deepEqual(errors, [
            'process artifact must not be tracked: docs/reports/field-data-zh/final.json',
            'process artifact must not be tracked: .github/analysis/2026-05-18-include-tree-analysis.md',
            'process artifact must not be tracked: .github/release-appendix.md',
            'process artifact must not be tracked: keywords/field_data_translation_review.py',
        ]);
    });
});
