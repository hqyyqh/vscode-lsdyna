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
                    assert.equal(i18n.get('keywordOptionsTreeDiscardWarningSingle', 1, 'UC1=0.25'), expected === 'zh-cn'
                        ? '切换关键字选项将丢弃 1 个非空字段：UC1=0.25'
                        : 'Switching keyword options will discard 1 non-empty field: UC1=0.25');
                    assert.equal(i18n.get('keywordOptionsTreeDiscardWarning', 2, 'UC1=0.25, UC2=0.5'), expected === 'zh-cn'
                        ? '切换关键字选项将丢弃 2 个非空字段：UC1=0.25, UC2=0.5'
                        : 'Switching keyword options will discard 2 non-empty fields: UC1=0.25, UC2=0.5');
                    for (const count of [0, 1, 2]) {
                        const message = i18n.get('keywordStructureMissingCount', count);
                        assert.equal(message, expected === 'zh-cn' ? `缺少 ${count} 条必需记录` : `Required records missing: ${count}`);
                    }
                    for (const token of ['$&', '$`', "$'", '$$', '{1}']) {
                        const deck = `D:/decks/cash${token}.k`, disk = `D:/disk/${token}.k`;
                        const message = i18n.get('includePathCaseMismatch', deck, disk);
                        assert.ok(message.includes(deck), message);
                        assert.ok(message.includes(disk), message);
                    }
                    assert.equal(i18n.get('{0} / {0} / {1} / {expected}', '{1}', '$&'), '{1} / {1} / $& / {expected}');
                } finally {
                    vscode.env.language = previousLanguage;
                    vscode.workspace.getConfiguration = previousConfiguration;
                    i18n.updateLanguage();
                }
            });
        }
    }
});
