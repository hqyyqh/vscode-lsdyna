# Same Directory Include Autocomplete Design

## Goal
Ensure that candidate files in the same directory as the current file (or directly inside the resolved search directories) are suggested when triggering autocompletion with a slash `/` or backslash `\`.

## Requirements
1. **Match Slash Trigger**: When the user triggers autocompletion by typing `/` or `\` in the `*INCLUDE` block, files in the same directory (which normally do not contain `/` or `\`) must not be filtered out by VS Code's completion matching engine.
2. **Clean Display & Exact Insert**: The completion items should display the clean file name (e.g. `file1.k`) and replace the typed `/` or `\` with the clean file name when selected.
3. **Robust Prefix Support**: Support dynamic matching for prefixes like `/`, `\`, `./`, and `.\`.

## Proposed Changes

### `src/extension.js`
- Modify `LsdynaIncludeCompletionProvider` to extract the `currentPrefix` of the current line from the start of the include card to the cursor.
- If a candidate file path does not contain a slash or backslash (which means it resides directly in the search path directory, such as the document's own directory), dynamically adjust the completion item's `filterText` based on the prefix:
  - If the prefix starts with `./`, set `filterText` to `./${file}`.
  - If the prefix starts with `.\`, set `filterText` to `.\${file}`.
  - If the prefix starts with `/`, set `filterText` to `/${file}`.
  - If the prefix starts with `\`, set `filterText` to `\${file}`.

### `test/extension.test.js`
- Add unit tests in `LsdynaIncludeCompletionProvider` block to verify that:
  - When typing `/` or `\`, same-directory files are correctly suggested and have matching `filterText` set.
  - Selecting the item replaces the typed slash/backslash correctly.
