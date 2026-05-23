# Reveal in Explorer & Left-Aligned Size Layout Design

## Goal
1. Remove file size from the right-aligned `FileDecoration` badge to avoid character limit restrictions.
2. Add a hoverable inline command/icon on the right side of the Include Tree items that reveals the selected file in the Windows OS File Explorer and selects it.
3. Show the file volume/size in the left-aligned `TreeItem.description` (following the filename and subpath), with vivid emoji indicators and a clean layout.

## Proposed Changes

### 1. Right-Aligned Inline Reveal Button
We will add an inline action button on the tree view.
- **Icon**: `$(folder-opened)` (the folder opened icon).
- **Behavior**: Clicking it executes `revealFileInOS`, which reveals the containing folder in Windows Explorer and selects the file.
- **Visibility**: Displayed only on hover for valid, existing files (`viewItem == file`).
- **FileDecoration Badge**: We will remove the size badge from the decoration provider for resolved files, returning only the status tooltip and green color. Missing files will still show `⚠`.

### 2. Left-Aligned Vivid Size Layout
We will display file sizes in the `TreeItem.description`.
- **Emoji Sizing**:
  - Size < 10 KB: `⚡ <Size>` (represents lightning fast loading)
  - 10 KB <= Size < 1 MB: `💾 <Size>` (represents standard file disk size)
  - Size >= 1 MB: `📦 <Size>` (represents larger files)
- **Separation & Layout**:
  - If a file is nested in a relative path: `subpath  •  [Emoji] [Size]`
  - If a file is not nested: `[Emoji] [Size]`
  - For missing files: `[subpath]  •  not found` or just `not found`
  - For circular dependencies: `[subpath]  •  circular` or just `circular`
  - For scan failures: `[subpath]  •  scan failed` or just `scan failed`

## Proposed Components & Files

### `package.json`
- Register `extension.revealInExplorer` command with icon `$(folder-opened)`.
- Contribute the command to `view/item/context` when `view == lsdynaIncludeTree && viewItem == file` with `"group": "inline"`.

### `src/extension.js`
- Implement `extension.revealInExplorer` command callback using `vscode.commands.executeCommand('revealFileInOS', item.resourceUri)`.
- Remove size badges from `LsdynaFileDecorationProvider` for resolved files.

### `src/client/providers/includeTreeProvider.js`
- Define `formatVividBytes(bytes)` helper.
- Implement `applyVividDescription(item, relDir)` to dynamically build the structured description text containing subpath and vivid file size information.
- Update `IncludeItem` constructor, `_buildItemFromTreeNode`, and `_buildItem` to use `applyVividDescription`.

### `test/extension.test.js`
- Update unit tests for descriptions and decoration providers to match the new behavior.
