'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { validateProjectContracts } = require('../scripts/validate-project-contracts.cjs');

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
        assert.equal(zh['commands.scanKeywordIndex.title'], '扫描关键字索引');
        assert.equal(zh['commands.keywordIndexSetLocal.title'], '显示当前文件');
        assert.equal(zh['commands.configureManualsDir.title'], '设置 LS-DYNA 手册目录');
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
});
