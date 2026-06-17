
---

### 📖 PDF Manual Integration Setup

> **Note**: Due to size limits, offline PDF manuals are not packaged within the `.vsix` extension. You can easily configure them using either of the methods below.

#### 🚀 Method 1: Download Pre-packed ZIP (Recommended)
We have pre-packed plug-and-play zip files with SumatraPDF included.

- **English Version**: [Download lsdyna_manual_pack_en.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna_manual_pack_en.zip)

**How to use**:
Extract the downloaded zip to any location on your PC. Then, click the **gear icon (⚙️)** on any hover card in VS Code to set the directory path to your extracted folder.

#### 🛠️ Method 2: DIY Setup
If you prefer using your own PDF files, follow these steps:
1. Download manuals from [Ansys LS-DYNA Official Website](https://lsdyna.ansys.com/manuals-download/).
2. Download a **Portable** version of SumatraPDF from [SumatraPDF Official Website](https://www.sumatrapdfreader.org/free-pdf-reader).
3. Place all the downloaded PDF files and `SumatraPDF.exe` into the same folder.
4. Click the **gear icon (⚙️)** on the hover card, or search for `lsdyna.manualsDir` in settings to point to this folder.

> ⚠️ **Important Note**
> The extension indexes PDF pages entirely based on **PDF Bookmarks**. Filenames do not affect the search, but if you modify or merge the PDFs, **you must preserve the original bookmarks** for the precise navigation to work.

---

### 📖 附加功能：PDF 手册集成配置指南

> **说明**: 由于体积原因，离线的 PDF 手册文件并没有直接打包在 `.vsix` 扩展插件中。您可以通过以下两种方式轻松完成配置。

#### 🚀 方式一：一键下载整合包（推荐）
我们为您准备了带有便携版 SumatraPDF 的即插即用压缩包。

- **含中文翻译的手册包**: [Download lsdyna_manual_pack.zip](https://github.com/hqyyqh/vscode-lsdyna/releases/download/2.0.7.3/lsdyna_manual_pack.zip)

**使用方法**:
将下载的压缩包解压到您电脑上的任意位置，然后在 VS Code 的悬停提示卡片 (Hover) 中点击 **齿轮图标 (⚙️)**，将路径指定为您解压后的文件夹即可。

#### 🛠️ 方式二：手动配置
如果您想使用自己平时习惯的 PDF 版本，可以按如下步骤操作：
1. 从 [Ansys LS-DYNA 官网](https://lsdyna.ansys.com/manuals-download/) 下载您需要的帮助手册 PDF。
2. 从 [SumatraPDF 官网](https://www.sumatrapdfreader.org/free-pdf-reader) 下载一个**便携版 (Portable)** 的 SumatraPDF 阅读器。
3. 将下载的所有 PDF 文件和 `SumatraPDF.exe` 放入同一个文件夹中。
4. 同样在悬停卡片上点击**齿轮图标 (⚙️)**，或者在设置中搜索 `lsdyna.manualsDir` 来指向该文件夹。

> ⚠️ **重要提示**
> 插件检索 PDF 页码完全基于 **PDF 的内置书签 (Bookmarks)**，因此文件的名称并不重要。但请注意，如果您对 PDF 文件进行了修改或合并，**一定要保留原有的 PDF 书签**，否则无法实现精确跳转。
