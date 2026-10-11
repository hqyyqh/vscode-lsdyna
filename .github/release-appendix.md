---

## Install and use this release

### Extension

Requires VS Code 1.100.0 or later.

1. Download the `dynasense-<version>-<platform>.vsix` asset for your system: `win32-x64` (Windows x64), `linux-x64` (Linux x64), or `darwin-arm64` (macOS Apple silicon).
2. In VS Code, open **Extensions** → **…** → **Install from VSIX…**, then select the downloaded file.
3. Run **Developer: Reload Window** after installation. When replacing the same extension version during testing, restart VS Code if the previous behavior is still present.

### Optional local manual pack

PDF manuals are not included in the VSIX. Download either pack below and extract it completely:

- **English:** [lsdyna-manual-pack-en.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-en.zip)
- **Bilingual:** [lsdyna-manual-pack-bilingual.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-bilingual.zip)

**Official documentation:** The [Ansys LS-DYNA manuals download page](https://lsdyna.ansys.com/manuals-download/) provides the official original documents. The ZIP files above are local manual packs for use with the extension.

Run **Set LS-DYNA Manuals Directory** and select the extracted outer folder containing `manifest.json`. Keep the internal indexes, images, and PDF files together.

On Windows, SumatraPDF can open the PDF at the requested page. Place `SumatraPDF.exe` in the manual-pack folder or its `pdf` subfolder. SumatraPDF is Windows-only. The in-editor reader remains available on other platforms, where PDFs open with the system application.

> **Authority notice:** Only the PDF manuals are the official, authoritative reference. In-editor text, Chinese translations, hover summaries, search results, and indexes are convenience aids.

---

## 安装和使用本版本

### 插件

需要 VS Code 1.100.0 或更新版本。

1. 下载适合当前系统的 `dynasense-<version>-<platform>.vsix`：`win32-x64`（Windows x64）、`linux-x64`（Linux x64）或 `darwin-arm64`（macOS Apple 芯片）。
2. 在 VS Code 中打开**扩展** → **…** → **从 VSIX 安装…**，选择下载的文件。
3. 安装后运行 **Developer: Reload Window（开发人员: 重新加载窗口）**。测试时如果覆盖安装相同版本，仍未看到更新后的功能，请重启 VS Code。

### 可选的本地手册包

PDF 手册不包含在 VSIX 中。请任选下方一个手册包并完整解压：

- **英文版：** [lsdyna-manual-pack-en.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-en.zip)
- **双语版：** [lsdyna-manual-pack-bilingual.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna-manual-pack-bilingual.zip)

**官方文档：** [Ansys LS-DYNA 官方手册下载页](https://lsdyna.ansys.com/manuals-download/)提供官方原版文档；上方 ZIP 为供插件使用的本地手册包。

运行**设置 LS-DYNA 手册目录**，选择解压后包含 `manifest.json` 的最外层文件夹。请保持内部索引、图片和 PDF 文件的目录结构完整。

在 Windows 上，可使用 SumatraPDF 跳转到指定 PDF 页码；将 `SumatraPDF.exe` 放在手册包文件夹或其 `pdf` 子文件夹中。SumatraPDF 仅支持 Windows。其他系统仍可使用内置阅读器，PDF 将由系统默认程序打开。

> **权威性说明：** 只有 PDF 手册是官方权威资料。内置文字、中文翻译、悬停摘要、搜索结果和索引仅用于辅助阅读。
