# LS-DYNA Card Field Smart Align and Tab Navigation Design Spec

This document details the design for implementing smart field alignment and tab-key navigation within LS-DYNA card data rows in VS Code.

## 1. Goal & Context
Currently, LS-DYNA data card lines require strict fixed-column formatting (typically 10 characters per field). If a user types less than 10 characters and moves to the next field via Tab:
- Standard snippet placeholder expansion gets broken due to text length change causing column drifting.
- Entering text on raw empty lines doesn't automatically format columns until the user leaves the line.
- Native VS Code tab inserts custom-size tabs or spaces that misalign the fixed-column layout.

This design implements a customized Tab key handler coupled with physical column-width alignment to provide a smooth, pre-aligned, and auto-wrapped field navigation experience.

---

## 2. Detailed Technical Design

### A. Context Key & Keybinding configuration
We introduce a custom VS Code context key: `lsdyna.shouldAlignTab`.
We register a keybinding in `package.json` for the `Tab` key that triggers our command `extension.lsdynaTab` only when this context key is `true`.

**Keybinding Configuration (`package.json`)**:
```json
{
    "command": "extension.lsdynaTab",
    "key": "tab",
    "when": "editorTextFocus && editorLangId == 'lsdyna' && !suggestWidgetVisible && lsdyna.shouldAlignTab"
}
```

### B. Context Key Lifecycle Management
We monitor selection changes and active text editor changes.
- **Listeners**:
  - `vscode.window.onDidChangeTextEditorSelection`
  - `vscode.window.onDidChangeActiveTextEditor`
- **Evaluation Logic**:
  When the active cursor selection updates:
  1. Determine if the editor's document is an LS-DYNA file.
  2. Get the current cursor line number (`lineNum`).
  3. Verify if the line is a **card data line** (does not start with `*` or `$`).
  4. Fetch the card definition via `getCardFieldsForLine(document, lineNum)`.
  5. If a card definition exists with non-empty fields, set the context key `lsdyna.shouldAlignTab` to `true`. Otherwise, set it to `false`.

### C. Advanced Alignment Algorithm (`alignLineText`)
We update `alignLineText(text, card)` to use a hybrid approach:
1. **Empty Text Handling**: If the text is empty or only whitespace, return a line pre-filled with spaces matching the card's total length (e.g. 72 or 80 spaces).
2. **Physical Column Extraction**:
   - Extract raw values from the line based on the exact start position and width of each field: `text.slice(f.p, f.p + f.w)`.
   - Trim the extracted values to get the clean content.
3. **Fallback to Whitespace Splitting**:
   - If any extracted value contains internal whitespace (e.g. `"123 456"`), or if the count of non-empty physical values does not equal the count of whitespace-split tokens, we fall back to split-by-whitespace (`text.trim().split(/\s+/)`). This ensures compatibility with unaligned pasted lines.
4. **Right-Align Values**: Align and pad each extracted value to `f.w` width and assemble the final line.

### D. The Tab Handler Command (`extension.lsdynaTab`)
When the user presses Tab on an active card data line:
1. **Find Current Field Index**:
   - Compare current cursor column position (`col`) against field boundaries.
   - The cursor is in `currentFieldIndex` if `col >= f.p && col < (nextField.p or f.p + f.w)`.
2. **Determine Target Field Index**:
   - `targetIndex = currentFieldIndex + 1`.
3. **Format & Align Current Line**:
   - Call `alignLineText(text, card)` to format the line.
   - Programmatically replace the line text with the aligned content.
4. **Position the Cursor**:
   - If `targetIndex < card.length` (not the last field):
     - Move the cursor to `card[targetIndex].p`.
   - If `targetIndex === card.length` (the last field, trigger wrap/jump):
     - Check the next line `lineNum + 1`.
     - If the next line is a card data line or an empty line, move cursor to `(lineNum + 1, 0)`.
     - If the next line is the end of the document, append a new line and move cursor to the new line `(lineNum + 1, 0)`.
     - Otherwise (next line is comment or keyword), move cursor to `(lineNum + 1, 0)` but let the next selection change deactivate `lsdyna.shouldAlignTab`.

---

## 3. Verification & Test Cases

1. **Unit tests for `alignLineText`**:
   - Empty input yields space-filled line.
   - Partially filled field yields right-aligned value in the exact column.
   - Out-of-alignment whitespace-split values are redistributed properly.
2. **Integration / Extension tests for `extension.lsdynaTab`**:
   - Pressing Tab inside field 1 formats field 1 and jumps to column 10 (field 2 start).
   - Pressing Tab on the last field format-aligns current line, wraps down, and places cursor at the beginning of the next line.
