# DynaSense 双市场自动发布实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立可 dry-run、可重跑、由语义化标签驱动的双市场自动发布，并将 `dev` 合并到保留的 `master` 稳定分支。

**架构：** CI 与发布拆成两个工作流。CI 覆盖 `dev`/`master`，发布工作流只在版本标签或手动调度时运行；构建一次 VSIX 后将同一制品交给两个市场与 GitHub Release。

**技术栈：** GitHub Actions、Node.js 20、npm、`@vscode/vsce` 3.9、`ovsx` 1.0、GitHub CLI。

---

## 文件结构

- 创建：`.github/workflows/ci.yml` — 日常提交和 pull request 的完整验证。
- 修改：`.github/workflows/release.yml` — 标签/手动触发的构建、双市场发布和 GitHub Release。
- 删除：`.github/workflows/feature_ci.yaml` — 移除只安装依赖却命名为发布的误导工作流。
- 删除：`.github/workflows/master_ci.yaml` — 移除按 master 提交和版本差异发布的旧流程。
- 修改：`package.json`、`package-lock.json` — 锁定 `ovsx` CLI 并移除失效的 semantic-release 配置。
- 创建：`docs/superpowers/specs/2026-06-20-marketplace-release-automation-design.md` — 发布架构与凭据边界。

### 任务 1：锁定发布工具

**文件：**
- 修改：`package.json`
- 修改：`package-lock.json`

- [ ] **步骤 1：加入 Open VSX CLI**

运行：

```powershell
node "D:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install --save-dev ovsx@1.0.1
```

预期：两个包文件记录 `ovsx` 1.0.1，现有 `@vscode/vsce` 版本保持锁定。

- [ ] **步骤 2：确认发布命令参数**

运行：

```powershell
node .\node_modules\@vscode\vsce\vsce publish --help
node .\node_modules\ovsx\lib\ovsx publish --help
```

预期：`vsce` 支持 `--packagePath`、`--skip-duplicate`，`ovsx` 支持 VSIX 路径、PAT 与重复版本跳过选项。

- [ ] **步骤 3：删除失效配置**

从 `package.json` 删除引用未安装 `semantic-release` 插件的 `release` 对象。

### 任务 2：替换 CI 工作流

**文件：**
- 创建：`.github/workflows/ci.yml`
- 删除：`.github/workflows/feature_ci.yaml`
- 删除：`.github/workflows/master_ci.yaml`

- [ ] **步骤 1：创建无发布副作用的 CI**

配置 push/pull_request 覆盖 `dev` 与 `master`，使用 `actions/checkout@v4`、`actions/setup-node@v4`、Node.js 20 和 npm cache，依次执行：

```bash
npm ci
npm test
npm audit --omit=dev
```

- [ ] **步骤 2：删除两个职责重叠的旧工作流**

预期：仓库只剩一个 CI 与一个 release 工作流，不再出现“成功但只执行 npm install”的发布流水线。

### 任务 3：实现标签发布与 dry-run

**文件：**
- 修改：`.github/workflows/release.yml`

- [ ] **步骤 1：定义触发器和互斥规则**

配置 `v*.*.*` tag push 与带布尔输入 `publish` 的 `workflow_dispatch`；设置 `contents: write` 和基于 ref 的 concurrency。

- [ ] **步骤 2：加入版本门禁**

读取 `package.json` 版本并输出 VSIX 名称。标签事件必须满足 `${GITHUB_REF_NAME#v} == package.json.version`，不匹配时以非零状态退出。

- [ ] **步骤 3：构建唯一 VSIX**

依次运行 `npm ci`、`npm test`、`npm audit --omit=dev` 和：

```bash
npx vsce package --out "dynasense-${VERSION}.vsix"
```

使用 `actions/upload-artifact@v4` 上传该文件。

- [ ] **步骤 4：加入安全发布步骤**

仅在标签事件或手动 `publish=true` 时：检查 `VSCE_PAT`、`OVSX_PAT` 非空，发布同一 VSIX，且不回显凭据。

- [ ] **步骤 5：创建 GitHub Release**

仅标签事件调用 `softprops/action-gh-release@v2`，上传同一 VSIX并生成发布说明。

### 任务 4：本地验证与提交

**文件：**
- 验证上述全部修改

- [ ] **步骤 1：验证 YAML、包文件和差异**

运行：

```powershell
npm test
npm audit --omit=dev
npx vsce package --out dist\automation-dry-run.vsix
git diff --check
```

预期：289 个测试通过；生产审计 0 漏洞；VSIX 生成成功；差异检查无输出。

- [ ] **步骤 2：提交自动化配置**

```powershell
git add .github package.json package-lock.json docs/superpowers
git commit -m "ci: automate dual marketplace releases"
```

### 任务 5：集成 dev 与 master

**文件：**
- 无新增文件

- [ ] **步骤 1：将自动化提交快进到 dev**

在主工作区执行 `git merge --ff-only codex/publish-3.0.6`，再次运行测试并推送 `dev`。

- [ ] **步骤 2：将 dev 合并到 master**

切换 `master`，获取远端状态，使用 `git merge --no-ff dev`（若可快进则允许快进）并推送 `master`。不删除本地或远端 `dev`。

- [ ] **步骤 3：确认远端分支**

核对 `origin/dev` 与 `origin/master` 均包含自动化提交，且 `dev` 仍存在。

### 任务 6：配置凭据并运行 GitHub dry-run

**文件：**
- GitHub 仓库 Secrets：`VSCE_PAT`、`OVSX_PAT`

- [ ] **步骤 1：由用户在 GitHub 安全输入界面保存两个新令牌**

令牌不通过聊天传递。保存后用 `gh secret list` 只验证名称存在。

- [ ] **步骤 2：手动调度 dry-run**

```powershell
gh workflow run release.yml --ref master -f publish=false
```

等待运行结束并检查测试、审计、打包及 artifact 上传步骤；确认两个商店发布步骤均跳过。

- [ ] **步骤 3：记录正式发布流程**

下一个版本合并到 master 后执行：

```powershell
git tag -a vX.Y.Z -m "DynaSense X.Y.Z"
git push origin vX.Y.Z
```

标签自动触发双市场发布，不用再次手工上传。
