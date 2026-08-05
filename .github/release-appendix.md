---

## Install and use this release

### Extension

1. Download the `dynasense-<version>.vsix` asset below.
2. In VS Code, open **Extensions** → **…** → **Install from VSIX…**, then select the downloaded file.
3. Run **Developer: Reload Window** after installation. When replacing the same extension version during testing, restart VS Code if the old extension host is still active.

### Optional local manual pack

PDF manuals are not included in the VSIX. Download and fully extract one pack:

- **English original:** [lsdyna-manual-pack-en_20260804.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-en_20260804.zip)
- **Bilingual — English original + Chinese translation:** [lsdyna-manual-pack-bilingual_20260804.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-bilingual_20260804.zip)

Run **Set LS-DYNA Manuals Directory** and select the extracted outer folder containing `manifest.json`. Keep the internal indexes, images, and PDF files together.

The pack uses SumatraPDF for page-specific PDF opening on Windows; SumatraPDF is Windows-only. The in-editor reader remains available on other platforms, where PDFs open with the system application.

> **Authority notice:** Only the PDF manuals are the official, authoritative reference. In-editor text, Chinese translations, hover summaries, search results, and indexes are convenience aids.

---

## 安装和使用本版本

### 插件

1. 下载下方的 `dynasense-<version>.vsix` 文件。
2. 在 VS Code 中打开**扩展** → **…** → **从 VSIX 安装…**，选择下载的文件。
3. 安装后运行 **Developer: Reload Window（开发人员: 重新加载窗口）**。测试时如果覆盖安装相同版本，而旧扩展进程仍在运行，请重启 VS Code。

### 可选的本地手册包

PDF 手册不包含在 VSIX 中。请下载一个手册包并完整解压：

- **英文原版：** [lsdyna-manual-pack-en_20260804.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-en_20260804.zip)
- **双语版——英文原版 + 中文翻译：** [lsdyna-manual-pack-bilingual_20260804.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-bilingual_20260804.zip)

运行**设置 LS-DYNA 手册目录**，选择解压后包含 `manifest.json` 的最外层文件夹。请保持内部索引、图片和 PDF 文件的目录结构完整。

手册包在 Windows 上使用 SumatraPDF 跳转到指定 PDF 页码；SumatraPDF 仅支持 Windows。其他系统仍可使用内置阅读器，PDF 将由系统默认程序打开。

> **权威性说明：** 只有 PDF 手册是官方权威资料。内置文字、中文翻译、悬停摘要、搜索结果和索引仅用于辅助阅读。
