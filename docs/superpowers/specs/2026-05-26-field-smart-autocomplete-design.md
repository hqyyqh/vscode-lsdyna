# LS-DYNA Field Smart Autocomplete and Row Template Design Spec

This specification outlines the design and implementation of a smart, column-aligned autocomplete provider for LS-DYNA card fields. It enables simulation engineers to input card data with precision alignment (typically 10-character columns) and generate full row card templates with Tab-navigation snippets.

## 1. Goal Description
In LS-DYNA input files, data cards are strictly column-aligned (commonly 10 characters per field). Manually typing space padding is tedious and error-prone. The goal is to:
1. Provide a completion item for each individual card field that automatically pads the required spaces to the field's starting index and inserts a width-aligned default placeholder (Smart Padding).
2. Provide a full-row template completion item that generates all fields aligned correctly for the active card, allowing engineers to cycle-edit via `Tab` (Row Template).

---

## 2. Component Design

### 2.1 [NEW] `LsdynaFieldCompletionProvider`
We will create a new class `LsdynaFieldCompletionProvider` inside `src/extension.js` that implements `vscode.CompletionItemProvider`.

#### Trigger Conditions:
- The active document belongs to `lsdyna` language.
- The current line is not a keyword line (does not start with `*`) and not a comment line (does not start with `$`).
- There is a valid enclosing keyword above the line, resolved via standard `lookupKeyword(kwName)`.
- The current line index matches a valid data card inside the keyword schema definition.

#### Completion Options:
1. **Row Card Template** (when trigger context is an empty line or at the beginning of the line):
   - Computes column structures for the exact card.
   - Piles spacing and default aligned placeholders (e.g. `"${1:         0}${2:       0.0}"`).
2. **Individual Aligned Fields**:
   - Calculates space differences: `padding = field.p - col` (where `col` is `position.character`).
   - If `col <= field.p`, provides a suggestion that inserts `" ".repeat(padding) + "${1:[aligned_default]}`".

---

## 3. Detailed Translation and UI Labels

To ensure consistent integration with the dynamic `i18n.js` framework, we will add new translation keys:

### 3.1 Chinese Keys (`zh-cn`):
- `fieldCompletionLabel`: `"{0} (第 {1}-{2} 列)"` (e.g. "MID (第 11-20 列)")
- `rowTemplateLabel`: `"✨ 生成整行卡片模板 (Card {0})"`
- `fieldDetail`: `"卡片字段 ({0}) - {1}"` (e.g. "卡片字段 (I) - 材料ID")
- `rowTemplateDetail`: `"LS-DYNA 字段对齐模板"`

### 3.2 English Keys (`en`):
- `fieldCompletionLabel`: `"{0} (Col {1}-{2})"`
- `rowTemplateLabel`: `"✨ Generate Row Card Template (Card {0})"`
- `fieldDetail`: `"Card Field ({0}) - {1}"`
- `rowTemplateDetail`: `"LS-DYNA Column-Aligned Template"`

---

## 4. Verification Plan

### 4.1 Unit Testing
We will add high-fidelity unit tests to `test/client/providers/phase7_features.test.js` or a new test file:
- **Test 1**: Verify `LsdynaFieldCompletionProvider` returns an empty array on keyword or comment lines.
- **Test 2**: Verify it returns the full-row template completion item on an empty line.
- **Test 3**: Verify smart column space padding calculation for single fields (e.g., if cursor is at column 5, and field starts at column 10, it inserts 5 spaces and the aligned placeholder).

### 4.2 Manual Verification
- Open an LS-DYNA file and start a new line under a recognized keyword (e.g. `*NODE`).
- Trigger completion (Ctrl+Space), verify the `"✨ 生成整行卡片模板 (Card 1)"` option is present.
- Select the template, verify the line is automatically padded to 80 characters, and verify Tab cycling works.
- On a partially filled line, trigger completion for an individual field (e.g. `X`). Verify it inserts the correct number of spaces and aligns the value.
