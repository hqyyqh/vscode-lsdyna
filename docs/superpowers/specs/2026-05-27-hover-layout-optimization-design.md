# LS-DYNA Hover Layout Optimization Design

This document details the design for optimizing the layout of LS-DYNA hover cards to reduce line occupancy, increase information density, and enhance the visual contrast of the currently hovered field in the card structure.

## 1. Goal

1. **Reduce vertical space consumption** of the hover card by eliminating redundant headers, horizontal rules, and excessive empty lines.
2. **Improve field contrast**: The current table header automatically bolds all field names, making the hovered field indistinguishable. By transposing the grid header to represent column offsets and using inline code syntax block combined with bold styling (`**`NAME`**`), the currently hovered field will stand out with strong background contrast.

## 2. Technical Design

### 2.1 Hover Card Rendering Refactoring
In [src/extension.js](file:///d:/Project/vscode-lsdyna/src/extension.js), modify the generation logic inside `LsdynaFieldHoverProvider.provideHover`:

```javascript
// Before:
const typeLabel = field.t ? ` *(${field.t})*` : '';
const helpText = field.h ? `\n\n${formatHoverHelpText(field.h)}` : '';

// Build a visual card structure grid showing neighboring fields and column offsets
const headers = card.map(f => f.n === field.n ? `**${f.n}**` : f.n);
const separators = card.map(() => '---');
const columns = card.map(f => `${f.p + 1}-${f.p + f.w}`);

const gridTable = [
    `| ${headers.join(' | ')} |`,
    `| ${separators.join(' | ')} |`,
    `| ${columns.join(' | ')} |`
].join('\n');

const md = new vscode.MarkdownString(`### Field: **${field.n}**${typeLabel}${helpText}\n\n---\n**Card Structure:**\n\n${gridTable}`);
```

```javascript
// After:
const typeLabel = field.t ? ` *(${field.t})*` : '';
const helpText = field.h ? `\n\n${formatHoverHelpText(field.h)}` : '';

// Build transposed grid table header and highlight active field name as bold inline code
const columnsHeader = card.map(f => `${f.p + 1}-${f.p + f.w}`);
const separators = card.map(() => '---');
const fieldNamesBody = card.map(f => f.n === field.n ? `**\`${f.n}\`**` : f.n);

const gridTable = [
    `| ${columnsHeader.join(' | ')} |`,
    `| ${separators.join(' | ')} |`,
    `| ${fieldNamesBody.join(' | ')} |`
].join('\n');

const md = new vscode.MarkdownString(`### **${field.n}**${typeLabel}${helpText}\n\n**Card Columns:**\n${gridTable}`);
```

## 3. Verification Plan

### 3.1 Automated Unit Tests
We will update the hover tests in [test/client/providers/advanced_features.test.js](file:///d:/Project/vscode-lsdyna/test/client/providers/advanced_features.test.js) under the `LsdynaFieldHoverProvider` block to:
1. Verify that `LsdynaFieldHoverProvider` output markdown text contains the updated structure layout (e.g. `### **MID**` instead of `### Field: **MID**`).
2. Verify that the grid table contains columns as header and highlighted field name (e.g., matching the `**`MID`**` pattern).
