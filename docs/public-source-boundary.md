# Public source development / 对外源码开发

The public `dev` branch accepts reviewed contributions; `master` is the stable release branch.

公开 `dev` 分支接收经审查的贡献，`master` 为稳定发布分支。

Run inside the candidate:

```sh
npm ci
python -m pip install -r requirements-dev.txt
npm run build
npm run data:check
npm run update:source-manifest -- --check
npm run check:contracts
npm test
npm run test:webview
python -m unittest discover -s test/scripts/build/keywords -p "test_*.py" -v
npm run check:field-data-zh
npm run check:native-help-zh
npm run check:manual-semantics-zh
npm audit
npm run package
```

Read [CONTRIBUTING.md](../CONTRIBUTING.md) for F5 and review requirements, and
[keywords/README.md](../keywords/README.md) for editable engineering data.
The four-role manifest records the complete public inventory and actual bytes.
Its updater can accept source changes, local authoring changes and verified
deterministic output; it cannot change an original snapshot or manufacture new
native-source certification. Boundary checks scan current files, including newly
added source not yet listed in the manifest.

F5 与审查要求见 [CONTRIBUTING.md](../CONTRIBUTING.md)，工程数据维护见
[keywords/README.md](../keywords/README.md)。四职责清单记录完整公开文件集合
及真实字节。更新器可接收源码、本地作者数据和经确定性重建核验的输出，但不能改写
原快照或制造新的原生来源认证。边界检查扫描当前文件，包括尚未写入清单的新增源码。

A public projection has its own real content identity. Source quotations, required
licenses, engineering behavior, permission limits and old source identities remain
truthful. Original protected evidence is retained internally; the private inverse
ledger proves the transformation. The relaxed-model public fixture retains all 16
shard bytes and has a distinct, statically pinned manifest identity. The 17-file
fixture is preserved as evidence; ordinary regression fixtures remain editable.

公开投影具有独立且真实的内容身份。来源引文、必要许可、工程行为、权限限制及原来源
身份必须保持真实。受保护的原始证据在内部完整保留，私密逆向记录验证转换。
relaxed-model 公开行为样例保留全部 16 个分片字节，使用独立且静态绑定的清单身份。
包含 17 个文件的样例作为证据保留；普通回归样例仍可编辑。

Source export records `requires-independent-validation` until the candidate is
independently built and checked. CI builds the pinned SQLite driver and a separate VSIX on Windows x64,
Linux x64 and macOS arm64. Each platform's identical artifact is installed on
VS Code 1.100.0 and 1.139.1; binaries are never shared across platforms. The manual renderer uses
an original synthetic fixture; it does not certify an official manual. Record
actual passed, failed and unverified results. Export, package creation, local
validation and pull requests do not perform or authorize a push, stable merge,
tag or release.

在独立构建和验证前，导出记录 `requires-independent-validation`。CI 分别在 Windows x64、
Linux x64 和 macOS arm64 构建固定版本的 SQLite 驱动及对应 VSIX；每个平台使用
同一份产物在 VS Code 1.100.0 和 1.139.1 中安装验收，不跨平台复用原生二进制。手册渲染使用原创合成样例，不认证
官方手册。应记录实际通过、失败和未验证结果。导出、打包、本地验证和拉取请求不执行
或授权推送、稳定分支合并、打标签或发布。


The release workflow reuses `public-ci.yml`, verifies each platform's package hash
and both host reports, then publishes those verified files. Host evidence includes
an upgrade from the hash-pinned 3.1.5 release, a window reload, missing-manual
behavior, an offline scenario and ordinary Node-project debugging on Windows.
Offline checks intercept extension-host HTTP/fetch and emulate offline Webviews;
they do not change the operating system firewall. Benchmark runs alternate the
paired baseline and candidate with 20 cold launches per scenario and 100 refreshes
per rendered-manager session. Peak RSS is the extension-host process high-water
mark, not the aggregate memory of every VS Code process.

发布流程复用 `public-ci.yml`，验证各平台包的摘要及两个宿主报告后，才发布对应文件。
宿主证据覆盖从固定摘要的 3.1.5 版本升级、窗口重载、手册缺失、离线场景，以及 Windows
普通 Node 项目调试。离线检查拦截扩展宿主的 HTTP/fetch 并模拟 Webview 离线，不修改
操作系统防火墙。基准交替运行成对的对照包和候选包，每种场景各采集 20 次冷启动，
每次实际表单渲染场景采集 100 次刷新。峰值 RSS 表示扩展宿主进程的历史最高内存，
不代表所有 VS Code 进程的合计内存。
