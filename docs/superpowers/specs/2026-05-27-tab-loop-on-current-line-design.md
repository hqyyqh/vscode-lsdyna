# LS-DYNA Tab Loop On Current Line Design

此文档阐述了在卡片最后一格按下 Tab 时，光标直接在当前行循环跳回第一个字段，而不需要跨行或者插入空行的设计。

## 方案设计

### 循环跳转逻辑 (`handleTabAlignment`)
当在卡片最后一格（`targetIndex >= card.length`）按下 Tab 键时：
- 光标不向下换行，也不插入空行。
- 直接定位回当前行第一个字段的起始位置 `card[0].p`。

```javascript
    // 4. Handle cursor movement
    if (targetIndex < card.length) {
        const prevF = card[currentFieldIndex];
        const prevVal = alignedText.slice(prevF.p, prevF.p + prevF.w).trim();
        const targetCol = card[targetIndex].p;
        const targetColOffset = prevVal.length > 0 ? 1 : 0;
        const newPos = new vscode.Position(lineNum, targetCol + targetColOffset);
        editor.selection = new vscode.Selection(newPos, newPos);
    } else {
        // Loop back to the first field on the current line
        const targetCol = card[0].p;
        const newPos = new vscode.Position(lineNum, targetCol);
        editor.selection = new vscode.Selection(newPos, newPos);
    }
```

## 验证计划

### 自动化单元测试
- 在 `test/client/providers/phase7_features.test.js` 中更新及添加相关的单元测试用例，模拟在最后一格按下 Tab，验证光标是否正确返回当前行第 `card[0].p` 列。
