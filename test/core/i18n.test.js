'use strict';

const assert = require('node:assert/strict');
const vscode = require("../support/vscode-mock");
const i18n = require('../../src/core/i18n');

describe('Runtime UI language', () => {
    for (const host of ['zh-cn', 'en']) {
        for (const setting of ['auto', 'zh-cn', 'en']) {
            it(`uses the documented language for VS Code ${host}, plugin ${setting}`, () => {
                const previousLanguage = vscode.env.language;
                const previousConfiguration = vscode.workspace.getConfiguration;
                try {
                    vscode.env.language = host;
                    vscode.workspace.getConfiguration = () => ({ get: () => setting });
                    i18n.updateLanguage();
                    const expected = setting === 'auto' ? host : setting;
                    assert.equal(i18n.getLanguage(), expected);
                    assert.equal(i18n.get('keywordOptionsReset'), expected === 'zh-cn' ? '取消修改' : 'Discard changes');
                    assert.equal(i18n.get('mainDeckContextChooseAction'), expected === 'zh-cn' ? '选择主文件' : 'Choose main deck');
                    for (const count of [0, 1, 2]) {
                        const message = i18n.get('keywordStructureMissingCount', count);
                        assert.equal(message, expected === 'zh-cn' ? `缺少 ${count} 条必需记录` : `Required records missing: ${count}`);
                    }
                } finally {
                    vscode.env.language = previousLanguage;
                    vscode.workspace.getConfiguration = previousConfiguration;
                    i18n.updateLanguage();
                }
            });
        }
    }
});
