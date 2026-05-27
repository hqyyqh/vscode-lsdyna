# LS-DYNA Field Comment Completion Design

This document details the design for providing aligned field comment completions (starting with `$#`) in LS-DYNA decks.

## 1. Goal

When a user types `$` or `$#` in an LS-DYNA file, autocomplete suggests the corresponding aligned field comment line matching the active card fields of the next data line (or the current position if it matches).

## 2. Technical Design

### 2.1 Trigger Guard Modification
In [src/extension.js](file:///d:/Project/vscode-lsdyna/src/extension.js), modify the guard in `LsdynaFieldCompletionProvider`:
```javascript
// Allow trigger character '$' and '$#' to bypass the comment guard
if (trimmed.startsWith('*') || (trimmed.startsWith('$') && !trimmed.startsWith('$#') && trimmed !== '$')) {
    return [];
}
```

### 2.2 Completion Logic for Comment Lines
When `trimmed === '$'` or `trimmed.startsWith('$#')`:
1. Query the fields for the next line using `getCardFieldsForLine(document, position.line + 1)`.
2. If a card is found and contains fields:
   - Generate the aligned comment line using `generateCommentLine(card)`.
   - Build a `vscode.CompletionItem` with:
     - **Label**: `$#`
     - **Detail**: `(LS-DYNA) 插入字段注释行`
     - **Documentation**: A markdown block previewing the comment line (e.g. `"$#  SECID       MID"`).
     - **InsertText**: The generated comment line string.
     - **Range**: A range covering `[0, position.character]` on the current line to replace the typed `$` or `$#` completely.

### 2.3 Alignment Algorithm: `generateCommentLine(card)`
```javascript
function generateCommentLine(card) {
    if (!card || card.length === 0) return '';
    
    const lastField = card[card.length - 1];
    const totalLen = lastField.p + lastField.w;
    
    const chars = Array(totalLen).fill(' ');
    chars[0] = '$';
    chars[1] = '#';
    
    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        const name = f.n || '';
        
        let startIdx = f.p;
        if (startIdx < 2) {
            startIdx = 2;
        }
        
        let maxEnd = f.p + f.w;
        if (i < card.length - 1) {
            maxEnd = Math.min(maxEnd, card[i + 1].p);
        }
        
        const maxLen = maxEnd - startIdx;
        if (maxLen <= 0) continue;

        let alignedName = name;
        if (name.length < maxLen) {
            alignedName = name.padStart(maxLen - 1) + ' ';
        } else {
            alignedName = name.slice(0, maxLen);
        }
        
        for (let k = 0; k < alignedName.length; k++) {
            chars[startIdx + k] = alignedName[k];
        }
    }
    
    return chars.join('').trimEnd();
}
```

## 3. Verification Plan

### 3.1 Automated Unit Tests
We will add new tests inside [test/client/providers/phase7_features.test.js](file:///d:/Project/vscode-lsdyna/test/client/providers/phase7_features.test.js) under the `LsdynaFieldCompletionProvider` suite:
1. **Verification of trigger condition**: Verify that when text is `$` or `$#`, the provider does not return empty but provides a completion list containing the `$#` item.
2. **Verification of aligned content**: Verify that `generateCommentLine(card)` produces exactly aligned comment lines for standard cards (e.g. 10-char fields like `*SECTION_SHELL` and 8-char fields like `*ELEMENT_SHELL`).
3. **Verification of fallback**: Verify that if there are no card fields associated with the line, it returns empty.
