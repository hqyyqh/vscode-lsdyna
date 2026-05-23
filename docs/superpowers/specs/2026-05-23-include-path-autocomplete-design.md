# Include Path Autocomplete Design

## Goal
Improve the `*INCLUDE` (and related include keywords) editing experience by automatically suggesting matching include files when typing path segments, scoped to the directories resolved via `*INCLUDE_PATH` and `*INCLUDE_PATH_RELATIVE` that are valid on the current computer.

## Requirements
1. **Trigger Context**: Automatically trigger path autocomplete when the cursor is on a line directly under an `*INCLUDE` block (but not comment lines starting with `$`, and not include path definitions like `*INCLUDE_PATH`).
2. **Valid Search Paths**:
   - Parse all search paths defined in the current document using the existing `getSearchPath(document)` helper.
   - Verify each path exists on the local filesystem and is a directory. Ignore any invalid paths (e.g. directories from other computers that do not exist locally).
3. **Candidate Suggestion**:
   - Scan valid search directories recursively up to depth 3 (max 300 files total to ensure high performance).
   - Suggest files relative to their respective search directory using forward slashes (e.g., `submodels/material.k`).
   - Support multiple candidates if a file name appears in multiple directories.
4. **Trigger Characters**: Trigger completion automatically on typing normal characters, and explicitly on `/` and `\`.

## Proposed Changes

### `src/extension.js`
- Define `LsdynaIncludeCompletionProvider` implementing `vscode.CompletionItemProvider`.
- Register the provider in `activate(context)` for the `lsdyna` language with triggers `'/'` and `'\\'`.
- Export `LsdynaIncludeCompletionProvider` in `_internals` for testability.

### `test/extension.test.js`
- Add unit tests for `LsdynaIncludeCompletionProvider` to verify that it returns correct path suggestions based on mock documents and existing fixture paths.
