# LS-DYNA VS Code Extension - Sidebar Beautification Possibilities & Design Specification

This document outlines the visual and interactive enhancement possibilities for the LS-DYNA Sidebar views (`Include Tree` and `Keyword Index`). It analyzes VS Code's extension architecture and presents three concrete options ranging from native UI polishing to completely custom interactive dashboards.

---

## 1. Architectural Constraints & VS Code UI Frameworks

VS Code supports two primary ways of rendering sidebar panels:

1. **Native TreeView (`vscode.TreeDataProvider`)**:
   - **How it works**: The extension defines nodes using the native VS Code tree component.
   - **Styling Limits**: No custom HTML, CSS, or JS can be injected. Tree item layout, font size, margins, and hover effects are standard and controlled by the active VS Code theme.
   - **Customizable Elements**: Icons (Codicons or custom SVGs), Icon colors (`ThemeColor`), node descriptions, rich Markdown tooltips, File Decorations (badges & colors on the far right), and inline actions (`view/item/context`).

2. **Webview View (`vscode.WebviewViewProvider`)**:
   - **How it works**: The sidebar panel is replaced with an embedded iframe running custom HTML, CSS, and JS.
   - **Styling Limits**: None. Complete styling freedom using HTML5, TailwindCSS, Vanilla CSS, gradients, animations, WebGL, SVG, etc.
   - **Customizable Elements**: Arbitrary custom trees, interactive charts, drag-and-drop file organization, animated folder collapse/expand, search/filter inputs, and graphical nodes.

---

## 2. Option 1: Native UX Extensions (Polished & Seamless)

This option retains the high performance of the native TreeView but utilizes every styling/decoration API VS Code offers to create a premium, context-rich environment.

### Design Elements

#### A. Interactive File Decorations (`FileDecorationProvider`)
We can register a custom `vscode.FileDecorationProvider` for LS-DYNA include files. This dynamically decorates the tree nodes in the sidebar:
- **Resolved Includes**: A green check badge or a dot on the far right, and green-tinted file name.
- **Missing Includes**: An amber `!` warning badge on the far right, and yellow/orange tinted text.
- *Visual representation:*
  ```text
  ▼ Main File (ram-detailed.key)
    ├─► vehicle_body.k                   ✓ (green)
    ├─► chassis_subassembly.k            ✓ (green)
    └─► engine_bracket_v2.k              ⚠ missing (amber)
  ```

#### B. Rich Markdown Tooltips (`vscode.MarkdownString`)
Hovering over a tree item displays an informative card instead of plain text:
- **Include Node Tooltip**: Displays file size, file path relative to root, parent-child links, and resolution status with icons.
- **Keyword Node Tooltip**: Displays a markdown table with occurrence counts across different subfiles and a mini code snippet showing the first reference.

#### C. Custom SVG Icons and Theme Color Bindings
Instead of using standard VS Code icons, we can design custom SVGs for LS-DYNA cards:
- Use a custom icon for `*KEYWORD` categories.
- Assign theme-aware colors to icons, e.g., using `new vscode.ThemeIcon('symbol-field', new vscode.ThemeColor('symbolIcon.fieldForeground'))`.

#### D. Inline Context Action Buttons
Add context-sensitive actions visible only when hovering over tree nodes:
- **Split Open**: Opens the target file in a new column beside the current editor (`$(split-horizontal)`).
- **Reveal in Explorer**: Selects and highlights the file inside VS Code's default explorer (`$(reveal)`).
- **Scan Keywords**: Instantly re-scans keyword occurrences inside that specific subfile (`$(refresh)`).

---

## 3. Option 2: Webview View (Full Design Freedom & Interactive Graph)

This option replaces the native tree views with a custom-rendered webview, turning the sidebar into a modern, responsive web app panel.

### Visual Architecture

The Webview sidebar is divided into three core tabs: **Include Tree**, **Keyword Index**, and **Dependency Graph**.

#### Tab 1: Include Tree
- **Theme-Aware Style**: High-contrast dark mode with subtle glowing borders, glassmorphism card layouts, and CSS transitions on item expand/collapse.
- **Dynamic Search Filter**: A real-time text input at the top. As you type, unmatched nodes fade out, and matched nodes expand automatically.
- **Status Indicator**: Pulse animations (using CSS keyframes) on missing include files to draw immediate attention.

```html
<!-- Visual layout concept for a Webview tree item -->
<div class="tree-item resolved flex items-center p-2 hover:bg-vscode-hover transition-all duration-200">
  <svg class="w-4 h-4 mr-2 text-green-500 animate-pulse" ...></svg>
  <span class="text-sm font-medium text-vscode-text">vehicle_chassis.k</span>
  <span class="ml-auto text-xs opacity-60">Resolved</span>
</div>
```

#### Tab 2: Keyword Index & Occurrence Heatmap
- Represents keywords as cards.
- Displays occurrence density using a micro horizontal bar chart (sparkline) representing the ratio of this keyword's usage compared to others.
- Clicking on a keyword displays a list of occurrences, each styled with line number badges and syntax-highlighted code previews of the surrounding lines.

#### Tab 3: Interactive SVG Dependency Graph
Renders an interactive hierarchical graph (using D3.js or a lightweight canvas engine):
- **Nodes**: Represent files. Circular nodes color-coded by file type or status (green for resolved, red for missing, blue for current file).
- **Edges**: Directed lines showing include relationships.
- **Interactions**:
  - Drag nodes to rearrange.
  - Double-click a node to open that file in the editor.
  - Hover over an edge to see path details.

---

## 4. Option 3: Unified Project Dashboard (Custom Editor)

Instead of squeezing complex visuals into the narrow sidebar, we can create a **Project Dashboard** Custom Editor. When the user clicks a "Show Project Dashboard" button in the sidebar title bar, VS Code opens a new tab displaying a full-width dashboard.

### Dashboard Key Features

1. **Include Graph visualizer**: A large, canvas-based zoomable tree graph.
2. **File Size & Complexity Analytics**:
   - Bar chart showing the line count distribution across include files.
   - Pie chart showing the keyword distribution (e.g., how many `*NODE` vs `*ELEMENT` vs `*MAT` cards are in the model).
3. **Missing Reference Resolution Center**:
   - A table listing all missing includes.
   - An inline button next to each missing file to "Search & Re-associate" or "Create File".
4. **Parameter Dependency Tracker**:
   - Visual map of `*PARAMETER` definitions and where they are referenced across the entire project structure.

---

## 5. Summary and Recommendations

| Feature | Native UX (Option 1) | Webview View (Option 2) | Custom Dashboard (Option 3) |
| :--- | :--- | :--- | :--- |
| **Visual Quality** | High (Polished standard) | Extremely High (Custom CSS) | Premium Desktop App Feel |
| **Interactivity** | Hover actions, Tooltips | Drag-and-drop, SVG Graph | Pan/Zoom Graph, Charts |
| **Performance** | Native (Ultra fast) | Webview Overhead (Moderate) | Webview Tab (On Demand) |
| **Best Fit For** | Efficiency & seamlessness | Visual dependency tracking | Structural analysis & reports |

### Recommended Action Plan

We recommend a **hybrid approach**:
1. **Enhance Native TreeViews with Option 1**: Implement `FileDecorationProvider` for green/red status colors and badges, add detailed markdown tooltips, and register the inline action buttons (`Open to Side` and `Reveal in Explorer`) to provide immediate usability improvements.
2. **Implement Option 3 (Unified Dashboard) as a separate tab** if you need high-end graphical representations (like D3 charts and 3D previews), keeping the sidebar lightweight and performant.
