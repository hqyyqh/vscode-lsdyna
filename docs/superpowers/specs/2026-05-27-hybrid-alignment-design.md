# Design Spec: LS-DYNA Keyword Line Hybrid Alignment Mode

This spec outlines the design for Task 4, which upgrades the alignment algorithm `alignLineText` in the LS-DYNA VS Code extension.

## 1. Context and Problem Statement
Currently, `alignLineText` formats fields by splitting the line by whitespace into tokens, then aligning each token to the corresponding card field definition.
This works well for unaligned lists, but fails under two major cases:
1. **Empty lines**: When an empty line is typed, it should format and return a space-filled line matching the entire width of the card's fields.
2. **Physical columns shifting**: If a user enters text at a specific physical column index (e.g., column 10) but leaves previous columns blank, token-based splitting shifts that text all the way to the left (first field). Instead, it should preserve the physical layout and align `123` to the second field.

## 2. Proposed Solution (Hybrid Alignment)
We upgrade `alignLineText` to use a hybrid alignment approach:
1. **Empty line check**: If the input is empty (or only whitespace), generate a line filled with spaces up to the total width of all fields in the card.
2. **Physical column extraction**: Extract values based on the physical character positions (`p`) and widths (`w`) defined in the card fields.
3. **Internal spaces & Token count check**: If any extracted field contains internal spaces, or if the number of non-empty physically extracted fields differs from the token count (when splitting by whitespace), we fall back to token-based whitespace splitting.
4. **Formatting**: Apply the determined values to the card layout, right-aligning each value within its field width, and padding with spaces as appropriate.

## 3. Test Cases (TDD)
We will add three tests in `test/client/providers/advanced_features.test.js` under the `alignLineText` block:
1. Formats empty line and returns a space-filled line matching card length.
2. Preserves the physical columns and avoids shifting values leftward.
3. Falls back to whitespace-splitting for unaligned lists.

## 4. Test Environment Fix
Add `onDidSaveTextDocument` mock to `test/vscode-mock.js` to prevent existing test failures.
