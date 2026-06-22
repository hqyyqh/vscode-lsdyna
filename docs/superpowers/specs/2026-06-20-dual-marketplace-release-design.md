# DynaSense 双市场发布设计

**目标：** 将当前 `dev` 分支的 DynaSense 首次发布到 Visual Studio Marketplace 与 Open VSX，统一扩展标识为 `hqyyqh.dynasense`，首发版本为 `3.0.6`。

## 发布源与版本

- 当前 `dev` HEAD 是唯一发布源。
- 将 `package.json` 和 `package-lock.json` 的版本同步提升到 `3.0.6`。
- 不复用现有 `dynasense-3.0.5.vsix`；它不包含当前 HEAD 的全部图标改动。
- 从已验证的工作区重新生成唯一的 `dynasense-3.0.6.vsix`，两个市场发布同一个文件，并记录 SHA-256。

## 本地发布门禁

依次执行以下检查，任一失败都中止发布并先修复：

1. 使用锁文件安装依赖。
2. 运行完整测试套件和 TypeScript 编译。
3. 使用 `vsce package` 生成 VSIX。
4. 审计 VSIX 文件清单、扩展标识、版本、入口文件、许可证、图标和关键字数据。
5. 检查包内不存在令牌、开发目录、测试目录或其他明显敏感文件。

## Visual Studio Marketplace

1. 使用 Microsoft 账户进入发布者管理页。
2. 创建或确认发布者 ID `hqyyqh`。
3. 创建仅具扩展发布所需权限的 Azure DevOps Personal Access Token；令牌仅在本机发布进程中临时使用。
4. 使用项目内固定版本的 `vsce` 发布已验证的 VSIX。
5. 通过 Marketplace 公开 API 和扩展详情页确认 `hqyyqh.dynasense@3.0.6` 可见。

官方流程：<https://code.visualstudio.com/api/working-with-extensions/publishing-extension>

## Open VSX

1. 登录 Open VSX，并关联 Eclipse 账户。
2. 阅读并接受 Open VSX Publisher Agreement。
3. 创建一次发布所需的 Open VSX 访问令牌。
4. 创建或确认命名空间 `hqyyqh`。
5. 使用 `ovsx` 发布与 Marketplace 完全相同的 VSIX。
6. 通过 Open VSX 公开 API 和扩展详情页确认 `hqyyqh.dynasense@3.0.6` 可见。

官方流程：<https://github.com/eclipse/openvsx/wiki/Publishing-Extensions>

## 凭据与外部副作用

- 不把令牌写入源码、配置文件、命令历史、提交或聊天输出。
- 登录、验证码、协议接受和令牌生成页面需要用户在浏览器中完成必要的身份确认。
- 发布动作只针对 `hqyyqh.dynasense@3.0.6`；不覆盖、删除或取消发布其他扩展。
- 若任一市场已存在同版本，先核对其内容与哈希，不进行强制覆盖。

## 发布后验证与监控

- 两个市场都必须返回发布者、扩展名和版本 `3.0.6`。
- 验证公开详情页、下载地址和安装标识可用。
- 若市场仍在索引，创建本线程的短间隔心跳检查，持续到两个市场均公开可安装或出现需要人工处理的明确拒绝。
- 最终交付两个市场的公开链接、VSIX SHA-256、验证时间和任何后续维护注意事项。
