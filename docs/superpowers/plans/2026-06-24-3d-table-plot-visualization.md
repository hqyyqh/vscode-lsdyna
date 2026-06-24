# 3D Table Plot Visualization 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 实现 LS-DYNA 1D/2D/3D Table 曲线定义在 hover popups 中的 3D 轴侧图可视化，并在 `mat_test.key` 中完整验证 table 100 的渲染。

**架构：**
1. 编译并使用单元测试锁死已有的 1D table 解析逻辑。
2. 在 `curvePlotRenderer.ts` 中实现 axonometric 3D projection 算法，以生成 3D SVG 数据 URI，包含 3D 坐标轴、背景墙网格、多曲线 HSL 热力图颜色和点数匹配时的网格连接线。
3. 在 `fieldReferenceHover.ts` 中判断如果定义为 `table` 且已解析了子曲线，则调用 3D SVG 渲染并在 hover popup 中输出。

**技术栈：** TypeScript, Node.js, SVG, VS Code Extension API.

---

### 任务 1：编译并补充 1D Table 解析的单元测试

**文件：**
- 修改：`test/core/references/curveTableDefinitionScanner.test.js`

- [ ] **步骤 1：编写失败的测试**
  在 `test/core/references/curveTableDefinitionScanner.test.js` 底部添加测试用例，定义 1D table 结构及随后的多条子曲线，并断言其子曲线被正确关联。
  ```javascript
  it('parses standard 1D table and maps to subsequent child curves', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsdyna-ref-table1d-'));
      const filePath = path.join(dir, 'table1d.k');
      fs.writeFileSync(filePath, [
          '*DEFINE_TABLE_TITLE',
          'LCSDG',
          '       100         1         0',
          '$              Value',
          '                  -1',
          '                 0.5',
          '*DEFINE_CURVE_TITLE',
          'curve 1',
          '       101',
          '                  -1         1.5',
          '*DEFINE_CURVE_TITLE',
          'curve 2',
          '       102',
          '                  -1         0.8',
          '*END'
      ].join('\n'));

      try {
          const result = await scanCurveTableDefinitionsFromFileIndex(
              await buildFileIndex(filePath),
              block => readBlockText(block)
          );
          assert.equal(result.tables.length, 1);
          assert.equal(result.tables[0].id, 100);
          assert.equal(result.tables[0].tableType, '1d');
          assert.equal(result.tables[0].rows.length, 2);
          assert.equal(result.tables[0].rows[0].value, -1);
          assert.equal(result.tables[0].rows[0].childId, 101);
          assert.equal(result.tables[0].rows[1].value, 0.5);
          assert.equal(result.tables[0].rows[1].childId, 102);
      } finally {
          fs.rmSync(dir, { recursive: true, force: true });
      }
  });
  ```

- [ ] **步骤 2：运行测试验证通过**
  运行：`npm test`
  预期：PASS

- [ ] **步骤 3：Commit**
  ```bash
  git add test/core/references/curveTableDefinitionScanner.test.js
  git commit -m "test: add unit test for standard 1D table parsing"
  ```

---

### 任务 2：实现 3D SVG 渲染算法

**文件：**
- 修改：`src/core/references/curvePlotRenderer.ts`
- 测试：`test/core/references/curvePlotRenderer.test.js`

- [ ] **步骤 1：编写 3D 渲染函数及其类型定义**
  在 `src/core/references/curvePlotRenderer.ts` 中添加并导出 `renderTable3dSvgDataUri(definition, options = {})` 函数。
  ```typescript
  function renderTable3dSvgDataUri(definition, options = {}) {
      const renderOptions: any = options || {};
      const isDark = renderOptions.isDark !== false;
      const width = 380;
      const height = 220;
      
      const u0 = 70;
      const v0 = 165;
      
      const dxX = 160;
      const dyX = 20;
      
      const dxY = 90;
      const dyY = -45;
      
      const dxZ = 0;
      const dyZ = -100;

      const curves = [];
      const ys = [];
      let minX = Infinity, maxX = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;

      for (const row of definition.rows || []) {
          if (!row.points || row.points.length < 2) continue;
          ys.push(row.value);
          curves.push({
              y: row.value,
              points: row.points
          });
          for (const pt of row.points) {
              if (pt.x < minX) minX = pt.x;
              if (pt.x > maxX) maxX = pt.x;
              if (pt.y < minZ) minZ = pt.y;
              if (pt.y > maxZ) maxZ = pt.y;
          }
      }

      if (curves.length === 0) return null;

      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);

      const spanX = maxX === minX ? 1 : maxX - minX;
      const spanY = maxY === minY ? 1 : maxY - minY;
      const spanZ = maxZ === minZ ? 1 : maxZ - minZ;

      function project(x, y, z) {
          const xn = (x - minX) / spanX;
          const yn = spanY === 0 ? 0.5 : (y - minY) / spanY;
          const zn = (z - minZ) / spanZ;
          const u = u0 + xn * dxX + yn * dxY;
          const v = v0 + xn * dyX + yn * dyY + zn * dyZ;
          return { u, v };
      }

      function getCurveColor(t, isDark) {
          if (isDark) {
              const hue = 180 - t * 140;
              return `hsl(${hue}, 100%, 65%)`;
          } else {
              const hue = 210 - t * 210;
              return `hsl(${hue}, 80%, 45%)`;
          }
      }

      const axisColor = isDark ? '#888888' : '#777777';
      const gridColor = isDark ? '#444444' : '#dddddd';
      const textColor = isDark ? '#cccccc' : '#333333';
      const labelColor = isDark ? '#aaaaaa' : '#555555';

      const svgElements = [];
      const title = xmlEscape(definition.title || definition.keyword || 'table');
      svgElements.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}">`);
      svgElements.push(`<text x="${width / 2}" y="16" fill="${textColor}" font-size="11" font-family="sans-serif" font-weight="bold" text-anchor="middle">${title}</text>`);

      // Floor & Wall Grid lines (Z = minZ, X = minX)
      const gridDivs = 4;
      for (let i = 0; i <= gridDivs; i++) {
          const t = i / gridDivs;
          const p1 = project(minX + t * spanX, minY, minZ);
          const p2 = project(minX + t * spanX, maxY, minZ);
          svgElements.push(`<line x1="${p1.u.toFixed(1)}" y1="${p1.v.toFixed(1)}" x2="${p2.u.toFixed(1)}" y2="${p2.v.toFixed(1)}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="2,2"/>`);
          const p3 = project(minX, minY + t * spanY, minZ);
          const p4 = project(maxX, minY + t * spanY, minZ);
          svgElements.push(`<line x1="${p3.u.toFixed(1)}" y1="${p3.v.toFixed(1)}" x2="${p4.u.toFixed(1)}" y2="${p4.v.toFixed(1)}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="2,2"/>`);
          const w1 = project(minX, minY + t * spanY, minZ);
          const w2 = project(minX, minY + t * spanY, maxZ);
          svgElements.push(`<line x1="${w1.u.toFixed(1)}" y1="${w1.v.toFixed(1)}" x2="${w2.u.toFixed(1)}" y2="${w2.v.toFixed(1)}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="2,2"/>`);
          const w3 = project(minX, minY, minZ + t * spanZ);
          const w4 = project(minX, maxY, minZ + t * spanZ);
          svgElements.push(`<line x1="${w3.u.toFixed(1)}" y1="${w3.v.toFixed(1)}" x2="${w4.u.toFixed(1)}" y2="${w4.v.toFixed(1)}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="2,2"/>`);
      }

      // Draw Axes
      const zOrigin = project(minX, minY, minZ);
      const zMax = project(minX, minY, maxZ);
      svgElements.push(`<line x1="${zOrigin.u.toFixed(1)}" y1="${zOrigin.v.toFixed(1)}" x2="${zMax.u.toFixed(1)}" y2="${zMax.v.toFixed(1)}" stroke="${axisColor}" stroke-width="1.5"/>`);
      const xMax = project(maxX, minY, minZ);
      svgElements.push(`<line x1="${zOrigin.u.toFixed(1)}" y1="${zOrigin.v.toFixed(1)}" x2="${xMax.u.toFixed(1)}" y2="${xMax.v.toFixed(1)}" stroke="${axisColor}" stroke-width="1.5"/>`);
      const yMax = project(minX, maxY, minZ);
      svgElements.push(`<line x1="${zOrigin.u.toFixed(1)}" y1="${zOrigin.v.toFixed(1)}" x2="${yMax.u.toFixed(1)}" y2="${yMax.v.toFixed(1)}" stroke="${axisColor}" stroke-width="1.5"/>`);

      // Draw Curves & connecting wireframe lines
      const numCurves = curves.length;
      for (let j = 0; j < numCurves; j++) {
          const curve = curves[j];
          const color = getCurveColor(numCurves > 1 ? j / (numCurves - 1) : 0.5, isDark);
          const polyPoints = curve.points.map(pt => {
              const p = project(pt.x, curve.y, pt.y);
              return `${p.u.toFixed(1)},${p.v.toFixed(1)}`;
          }).join(' ');
          svgElements.push(`<polyline points="${polyPoints}" fill="none" stroke="${color}" stroke-width="2"/>`);

          if (j < numCurves - 1 && curves[j+1].points.length === curve.points.length) {
              const nextCurve = curves[j+1];
              for (let k = 0; k < curve.points.length; k++) {
                  const pCurr = project(curve.points[k].x, curve.y, curve.points[k].y);
                  const pNext = project(nextCurve.points[k].x, nextCurve.y, nextCurve.points[k].y);
                  svgElements.push(`<line x1="${pCurr.u.toFixed(1)}" y1="${pCurr.v.toFixed(1)}" x2="${pNext.u.toFixed(1)}" y2="${pNext.v.toFixed(1)}" stroke="${color}" stroke-width="0.5" opacity="0.6"/>`);
              }
          }
      }

      // Labels & values
      const zMid = project(minX, minY, minZ + spanZ / 2);
      svgElements.push(
          `<text x="${zOrigin.u - 8}" y="${zOrigin.v}" fill="${labelColor}" font-size="8" font-family="sans-serif" text-anchor="end" dominant-baseline="middle">${formatValue(minZ)}</text>`,
          `<text x="${zMid.u - 8}" y="${zMid.v}" fill="${labelColor}" font-size="8" font-family="sans-serif" text-anchor="end" dominant-baseline="middle">${formatValue(minZ + spanZ / 2)}</text>`,
          `<text x="${zMax.u - 8}" y="${zMax.v}" fill="${labelColor}" font-size="8" font-family="sans-serif" text-anchor="end" dominant-baseline="middle">${formatValue(maxZ)}</text>`,
          `<text x="${zMax.u - 25}" y="${zMax.v - 5}" fill="${textColor}" font-size="9" font-family="sans-serif" font-weight="bold" text-anchor="middle">Z (value)</text>`
      );
      const xMid = project(minX + spanX / 2, minY, minZ);
      svgElements.push(
          `<text x="${zOrigin.u}" y="${zOrigin.v + 12}" fill="${labelColor}" font-size="8" font-family="sans-serif" text-anchor="middle">${formatValue(minX)}</text>`,
          `<text x="${xMax.u}" y="${xMax.v + 12}" fill="${labelColor}" font-size="8" font-family="sans-serif" text-anchor="middle">${formatValue(maxX)}</text>`,
          `<text x="${xMid.u + 15}" y="${xMid.v + 22}" fill="${textColor}" font-size="9" font-family="sans-serif" font-weight="bold" text-anchor="middle">X (curve var)</text>`
      );
      const yMid = project(minX, minY + spanY / 2, minZ);
      svgElements.push(
          `<text x="${yMax.u - 5}" y="${yMax.v + 10}" fill="${labelColor}" font-size="8" font-family="sans-serif" text-anchor="middle">${formatValue(maxY)}</text>`,
          `<text x="${yMid.u - 40}" y="${yMid.v - 5}" fill="${textColor}" font-size="9" font-family="sans-serif" font-weight="bold" text-anchor="middle">Y (table var)</text>`
      );

      svgElements.push('</svg>');
      return `data:image/svg+xml;base64,${Buffer.from(svgElements.join(''), 'utf8').toString('base64')}`;
  }
  ```
  在文件底部的 `module.exports` 中添加并导出 `renderTable3dSvgDataUri`。

- [ ] **步骤 2：在单元测试中增加对 `renderTable3dSvgDataUri` 的测试**
  在 `test/core/references/curvePlotRenderer.test.js` 中增加测试：
  ```javascript
  it('renders a 3D table SVG data URI correctly', () => {
      const { renderTable3dSvgDataUri } = require('../../../out/core/references/curvePlotRenderer');
      const dataUri = renderTable3dSvgDataUri({
          title: 'Table 3D Test',
          keyword: '*DEFINE_TABLE_TITLE',
          rows: [
              {
                  value: 0,
                  points: [
                      { x: 0, y: 10 },
                      { x: 1, y: 20 }
                  ]
              },
              {
                  value: 1,
                  points: [
                      { x: 0, y: 15 },
                      { x: 1, y: 25 }
                  ]
              }
          ]
      });
      assert.ok(dataUri.startsWith('data:image/svg+xml;base64,'));
  });
  ```

- [ ] **步骤 3：编译并运行测试**
  运行：`npm run compile`，然后 `npm test`
  预期：PASS

- [ ] **步骤 4：Commit**
  ```bash
  git add src/core/references/curvePlotRenderer.ts test/core/references/curvePlotRenderer.test.js
  git commit -m "feat: implement 3D table SVG rendering with unit tests"
  ```

---

### 任务 3：在 Hover 中展示 3D 曲面图

**文件：**
- 修改：`src/core/references/fieldReferenceHover.ts`
- 测试：`test/core/references/fieldReferenceHover.test.js`

- [ ] **步骤 1：在 `fieldReferenceHover.ts` 中引入 `renderTable3dSvgDataUri` 并进行渲染**
  引入：
  ```javascript
  const {
      renderCurveSvgDataUri,
      renderCurveMarkdownFallback,
      renderTable3dSvgDataUri,
      markdownCode,
  } = require('./curvePlotRenderer');
  ```
  修改 `appendTablePreview` 函数以生成 3D 图像：
  ```typescript
  function appendTablePreview(lines, definition, isDark = true) {
      // Hydrate child curve points into table rows
      const tableWithPoints = {
          ...definition,
          rows: (definition.rows || []).map(row => {
              const matches = definition.resolvedChildren && definition.resolvedChildren.get(row.childId);
              const points = (matches && matches[0] && matches[0].points) || [];
              return { ...row, points };
          })
      };

      // Try rendering 3D SVG
      const dataUri = renderTable3dSvgDataUri(tableWithPoints, { isDark });
      if (dataUri) {
          lines.push('', `![3D table preview](${dataUri})`);
      }

      // Fallback text table underneath
      const childLabel = definition.tableType === '3d' ? 'table ID' : 'curve ID';
      const rows = (definition.rows || []).slice(0, MAX_TABLE_ROWS);
      if (rows.length === 0) {
          return;
      }
      lines.push('', `| value | ${childLabel} |`, '| ---: | ---: |');
      for (const row of rows) {
          lines.push(`| ${markdownCode(row.valueRaw)} | ${childLink(row, definition)} |`);
      }
      const omitted = (definition.rows || []).length - rows.length;
      if (omitted > 0) {
          lines.push(`| ... | ${omitted} more rows |`);
      }
  }
  ```
  更新 `appendDefinition` 调用，向 `appendTablePreview` 传递 `isDark`：
  ```typescript
  } else if (definition.kind === 'table') {
      appendTablePreview(lines, definition, isDark);
  }
  ```

- [ ] **步骤 2：在单元测试中增加 Table Hover 测试**
  在 `test/core/references/fieldReferenceHover.test.js` 中补充对应的单元测试。

- [ ] **步骤 3：编译并运行测试**
  运行：`npm run compile`，然后 `npm test`
  预期：PASS

- [ ] **步骤 4：Commit**
  ```bash
  git add src/core/references/fieldReferenceHover.ts test/core/references/fieldReferenceHover.test.js
  git commit -m "feat: integrate 3D table surface rendering in hover popup"
  ```

---

### 任务 4：手动编译验证

- [ ] **步骤 1：再次编译并验证**
  运行：`npm run compile`
  预期：全套单元测试通过，编译无 Warning/Error。
