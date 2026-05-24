# LS-DYNA Extension README Update and Localization Design Spec

## 1. Goal Description

This design specification details the updates to the English `README.md` and the creation of `README_zh.md` to reflect the series of new features introduced since commit `e5ed9fb59f8dad3203b9e102451e453d6beceaee`.

The project has evolved significantly, introducing out-of-process Language Server (LSP) indexing, L2 persistent caching, local LS-DYNA PDF manual indexing/integration, SumatraPDF integration, Include File autocomplete, Sidebar improvements (decorations and file size badges), and editor rulers. These features must be well-documented in both English and Chinese.

## 2. Document Layout & Structure

We will implement **Option A**:
- Modify `README.md` (English) to include the updated features and settings.
- Add a language switcher link at the very top of both files:
  - In `README.md`: `[简体中文](README_zh.md)`
  - In `README_zh.md`: `[English](README.md)`
- Create `README_zh.md` (Chinese) as a complete and localized mirror of `README.md`.

## 3. Detailed Changes per Document

### 3.1. README.md Updates

We will expand or add the following sections:

#### Language Switcher
At the very top of `README.md`, insert:
```markdown
[简体中文](README_zh.md)
```

#### Features Section
*   **Syntax & Navigation**:
    *   Mention Keyword Folding (each `*KEYWORD` block collapses independently).
    *   Mention block-level incremental parsing keeping the index updated instantly on keystroke.
    *   Mention default editor rulers (field markers) for LS-DYNA files with an optimized, non-intrusive color palette.
*   **Include Files**:
    *   Mention same-directory include file path autocomplete (triggered by slash `/` or backspace, with remote paths filtered out).
    *   Mention hover actions for existing include files.
*   **LS-DYNA Manual Integration (NEW Sub-section)**:
    *   Explain bookmark-based PDF manual indexing (`manualIndexer`) and cache.
    *   Detail how keyword and field hover cards show direct page links to the PDF manual.
    *   Describe the `openManual` command to search and open manuals.
    *   Explain the integration with SumatraPDF (Windows) for precise page navigation, tab recycling, and single-instance handling.
*   **Sidebar Panel**:
    *   Mention the **Include Tree** changes: display of formatted file sizes directly in tree descriptions and right-hand decoration badges.
    *   Mention the use of `FileDecorationProvider` to apply global workspace warning/success indicators to missing or resolved include files.
    *   Mention the visual refinement (replacing standard emojis with block level level indicator bars `▏`, `▌`, `█`).
*   **Performance & Architecture**:
    *   Highlight the **LSP Process Isolation** (moving indexers to a separate Language Server process).
    *   Highlight the **L2 Persistent Disk Cache** (LRU cache with auto-vacuuming in global storage).
    *   Highlight performance improvements for large files: binary buffer scanning (`keywordScanner` using sliding window, `blockScanner` using column-1 check, and `includeScanner` using selective buffer decoding), navigation using `vscode.open` instead of `openTextDocument` to prevent UI freezing.

#### Settings Section
Add the following parameter to the settings table:
*   `lsdyna.sumatrapdfPath`: Custom executable path for SumatraPDF (Windows only) to enable precise page navigation.

---

### 3.2. README_zh.md Content

We will create the file `README_zh.md` at the repository root. It will contain:
- Language switcher link to `README.md`.
- Symmetrical translation of all headings, lists, tables, and code snippets from the updated `README.md`.
- Natural and professional Chinese technical translation (e.g., translating "inlay hints" to "内联提示", "diagnostics" to "诊断", "sidebar" to "侧边栏", "LSP process isolation" to "LSP 进程隔离", "persistent cache" to "持久化缓存").

## 4. Verification Plan

### Manual Verification
1.  Verify the links between `README.md` and `README_zh.md` render correctly in the markdown preview pane of VS Code.
2.  Review both files for formatting errors, broken markdown links, or missing images.
3.  Check that all CLI commands, configurations, and paths are correct.
