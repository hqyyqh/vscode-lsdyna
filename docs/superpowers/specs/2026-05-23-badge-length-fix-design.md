# VS Code FileDecoration Badge Length Limit Fix Design

## Context & Problem
We recently implemented file size displays on the right side of tree items in the VS Code Include Tree sidebar using `FileDecorationProvider`'s `badge` property.
However, in VS Code, `FileDecoration.badge` is strictly limited to 1 or 2 characters. When the badge string length exceeds 2 characters (e.g. `'45K'`, `'1.2M'`), VS Code silently ignores the decoration, leaving the badge blank.

## Design Goal
- Ensure that the file sizes are formatted to fit within strictly 2 characters (JavaScript length <= 2).
- Keep the design intuitive: small files display their size (e.g. `2k`), while larger files display their order of magnitude (e.g. `K` for KB, `1M` for small MB files, `M` for large MB files, `G` for GB files).
- Keep full exact sizes in hover tooltips.
- Add `normalizePathKey` to the exported internals in `src/extension.js` to fix the test loading issue.

## Proposed Options

### Option A: Enforce strictly 2-character limit on the badge
We redefine the compact file size formatting helper `formatShortBytes`:
- Size <= 0: `'0'`
- Size < 10 KB: `${Math.round(bytes / 1024)}k` (e.g. `1k`..`9k`)
- 10 KB <= Size < 1 MB: `'K'`
- 1 MB <= Size < 10 MB: `${Math.round(bytes / (1024*1024))}M` (e.g. `1M`..`9M`)
- 10 MB <= Size < 1 GB: `'M'`
- 1 GB <= Size < 10 GB: `${Math.round(bytes / (1024*1024*1024))}G`
- Size >= 10 GB: `'G'`

This guarantees that every returned badge is at most 2 characters.

### Option B: Use `TreeItem.description` (left-aligned)
If Option A is too compact, we can revert to placing the file size in the `TreeItem.description` (e.g. `(45.3 KB)`). However, this would place the file size on the left next to the filename, violating the user's preference for right-aligned placement.

**Recommendation:** Option A. It achieves the user's layout requirement (right-aligned) while working within VS Code's strict API constraints.

## Proposed Changes

### 1. [includeTreeProvider.js](file:///d:/Project/vscode-lsdyna/src/client/providers/includeTreeProvider.js)
Redefine `formatShortBytes` to implement Option A's rules.

### 2. [extension.js](file:///d:/Project/vscode-lsdyna/src/extension.js)
Export `normalizePathKey` from `module.exports._internals` to fix the unit test failure.

### 3. [extension.test.js](file:///d:/Project/vscode-lsdyna/test/extension.test.js)
Update unit tests for `formatShortBytes` and `LsdynaFileDecorationProvider` to reflect the new compact badge format.

## Verification
- Run `npm test` to ensure all tests pass.
