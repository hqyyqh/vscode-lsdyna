# LS-DYNA Tab Wrap Stuck Fix Design

此文档阐述了当下一行是关键字或注释时，在卡片最后一格按 Tab 会被卡在当前行行尾，无法回到第一格的修复与优化设计。

## 方案设计

### 自动插入新行机制
在最后一格按 Tab 键换行时：
- 如果下一行不存在（文件末尾），或者下一行以 `*` 或 `$` 开头（关键字或注释），则自动在当前行尾插入 `\n`。
- 将光标定位至新产生的空白行第一格（第 `0` 列），从而打破卡顿，允许连续 Tab 录入数据。

```javascript
    } else {
        // It's the last field, wrap to the next line
        const nextLineNum = lineNum + 1;
        let shouldInsertNewLine = false;

        if (nextLineNum >= document.lineCount) {
            shouldInsertNewLine = true;
        } else {
            const nextLine = document.lineAt(nextLineNum);
            const trimmedNext = nextLine.text.trimStart();
            if (trimmedNext.startsWith('*') || trimmedNext.startsWith('$')) {
                shouldInsertNewLine = true;
            }
        }

        if (shouldInsertNewLine) {
            await editor.edit(editBuilder => {
                editBuilder.insert(new vscode.Position(lineNum, alignedText.length), '\n');
            }, { undoStopBefore: false, undoStopAfter: false });
        }

        const newPos = new vscode.Position(nextLineNum, 0);
        editor.selection = new vscode.Selection(newPos, newPos);
    }
```

## 验证计划

### 自动化单元测试
- 更新 `test/client/providers/phase7_features.test.js` 中的测试用例，模拟下一行是关键字的情况，验证此时是否会自动在当前行尾插入换行符并把光标移动到下一行第 0 列。
