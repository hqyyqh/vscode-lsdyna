# LS-DYNA Tab Wrap Fix Design

此文档阐述了如何修复在最后一个字段的末尾按下 Tab 时，光标跳回当前行第二格而不是正确换行至下一行第一格的问题。

## 方案设计

### 修复定位逻辑 (`handleTabAlignment`)
当光标在最后一个字段的右边界或越界时，`currentFieldIndex` 定位循环由于严格的边界判断会失败，导致其保持默认值 `0`。
我们在循环外增加越界判定：
- 如果没有匹配到字段，且光标列号大等于最后一个字段的起始列号，则将 `currentFieldIndex` 设为最后一个字段。
- 否则设为第一个字段。

```javascript
    let currentFieldIndex = -1;
    for (let i = 0; i < card.length; i++) {
        const f = card[i];
        const nextF = card[i + 1];
        const end = nextF ? nextF.p : (f.p + f.w);
        if (col >= f.p && col < end) {
            currentFieldIndex = i;
            break;
        }
    }
    if (currentFieldIndex === -1) {
        if (col >= card[card.length - 1].p) {
            currentFieldIndex = card.length - 1;
        } else {
            currentFieldIndex = 0;
        }
    }
```

## 验证计划

### 自动化单元测试
- 在 `test/client/providers/phase7_features.test.js` 中添加针对最后一个字段右边界按下 Tab 的测试，验证其是否正确换行至下一行第一格。
