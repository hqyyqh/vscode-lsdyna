# LS-DYNA Global Manuals Directory Configuration Design

此文档阐述了修改手册路径配置（`lsdyna.manualsDir`）持久化行为的设计方案，保证其始终保存在全局（Global）设置中，且在发生写入失败时友好地弹窗报错。

## 需求背景
1. 原先在配置手册路径时，如果当前在工作空间中，插件会默认将其写入到工作空间设置中（即本地文件夹的 `.vscode/settings.json`）。
2. 用户期望该配置必须只保存在全局（Global），避免在每个项目的当前文件夹中生成本地配置，并且期望在 VS Code 首选项设置中全局可见。如果写入全局失败，需要直接弹窗报错提示。

## 方案设计

### 1. 多语言资源更新
在 `src/core/i18n.js` 的 `LOCALES` 配置中添加 `failedToSaveGlobalConfig` 翻译项：

- **`zh-cn`**:
  `failedToSaveGlobalConfig: '无法将手册路径保存到全局配置：{0}'`
- **`en`**:
  `failedToSaveGlobalConfig: 'Failed to save manuals directory globally: {0}'`

### 2. 配置项写入重构
在 `src/extension.js` 中的 `extension.configureManualsDir` 命令实现内，移除根据工作区决定写入目标的逻辑，将其固定为 `vscode.ConfigurationTarget.Global`。
同时，使用 `try-catch` 包裹 `config.update(...)` 调用，发生异常时通过 `vscode.window.showErrorMessage` 向用户报错。

```javascript
try {
    await config.update('manualsDir', selectedPath, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(i18n.get('manualDirSetTo', selectedPath));
} catch (err) {
    vscode.window.showErrorMessage(i18n.get('failedToSaveGlobalConfig', err.message));
}
```

## 验证计划

### 自动化单元测试
- 编写或更新 `test/client/providers/phase7_features.test.js` 中的测试用例，验证调用 `extension.configureManualsDir` 时，传递给 `config.update` 的第三个参数始终为 `vscodeMock.ConfigurationTarget.Global`。
- 验证当 `config.update` 抛出错误时，调用了 `vscodeMock.window.showErrorMessage` 并且携带对应的国际化文本。

### 手动验证
- 在 VS Code 插件环境中运行，点击状态栏或触发命令设置手册路径，验证项目的 `.vscode/settings.json` 中没有生成 `lsdyna.manualsDir` 配置，而是在 VS Code 的 User Settings（用户设置，即全局配置）中生成了该项，且可在 VS Code 全局设置 UI 界面搜索到。
