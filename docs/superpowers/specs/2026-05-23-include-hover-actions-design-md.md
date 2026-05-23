# LS-DYNA Include Hover Actions Design Specification

We want to enhance the hover experience on `*INCLUDE` file paths in the VS Code LS-DYNA extension. Currently, when an include file exists, VS Code shows the default document link hover ("Follow link"). We want to replace or supplement this with a custom hover window offering three actions:
1. **在新标签打开链接** (Open link in new tab)
2. **分栏打开** (Open in split editor / beside)
3. **打开文件所在路径** (Reveal file in Windows File Explorer)

All actions should be displayed with clean icon indicators (using VS Code Codicons) and clear Chinese labels.

## Proposed Options

### Option 1 (Recommended): Custom Command Wrappers
Register three custom commands in the extension that take the string path as an argument:
- `extension.openIncludeNewTab`: Runs `vscode.open` with `{ preview: false }`.
- `extension.openIncludeSplit`: Runs `vscode.open` with `{ viewColumn: vscode.ViewColumn.Beside, preview: false }`.
- `extension.openIncludeFolder`: Runs `revealFileInOS` with the file URI.

Then we construct command URIs passing the absolute file path as a simple JSON string array.

**Pros**:
- String serialization in JSON query arguments (`["d:\\path\\to\\file"]`) is extremely robust and avoids any version-specific serialization issues of `vscode.Uri` objects.
- Easy to add logging or error handling.

**Cons**:
- Requires registering three new commands in the extension.

---

### Option 2: Direct Command Serialization
Serialize `vscode.Uri` objects directly into built-in VS Code commands `vscode.open` and `revealFileInOS`.

**Pros**:
- No new commands registered.

**Cons**:
- Fragile because `vscode.Uri` has unique JSON serialization layouts (`{"$mid": 1, ...}`) which might not deserialize reliably back to `vscode.Uri` objects across different VS Code API versions.

---

## Detailed Hover Design

When a user hovers over a valid, resolved include file path, the `LsdynaFieldHoverProvider` will intercept and return a `vscode.Hover` with the following markdown content:

```markdown
### 📂 **Include File: filename.key**
*File exists / 文件存在*

---

- [$(go-to-file) **在新标签打开链接**](command:extension.openIncludeNewTab?%5B%22...%22%5D)
- [$(split-horizontal) **分栏打开**](command:extension.openIncludeSplit?%5B%22...%22%5D)
- [$(folder-opened) **打开文件所在路径**](command:extension.openIncludeFolder?%5B%22...%22%5D)
```

The MarkdownString will have `isTrusted = true` to allow command execution.

## Verification Plan

### Automated Tests
- Add unit tests in `test/extension.test.js` to assert that `LsdynaFieldHoverProvider` returns the custom markdown containing the three command links when hovering over a resolved include line.
- Verify that hovering over non-include lines or unresolved include lines does not show the file actions hover.

### Manual Verification
- Launch the extension, hover over a resolved include path, and click each of the three options:
  - "在新标签打开链接" should open the file in a new non-preview tab.
  - "分栏打开" should open the file in a split editor beside the current editor.
  - "打开文件所在路径" should open Windows File Explorer with the file selected.
