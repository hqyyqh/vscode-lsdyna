# Design: 3D Surface Plot for LS-DYNA Tables

This document details the design for rendering a 3D surface/wireframe plot for LS-DYNA tables (`*DEFINE_TABLE*` of type `1D`, `2D`, or `3D`) on hover.

## 3D Table Data Structure

An LS-DYNA table maps Y-axis coordinate values (e.g. strain rates, lode parameters) to child curves. Each child curve defines a relationship between $X$ and $Z$.
- **$Y$ coordinate**: Abscissa value of the table.
- **$X$ coordinate**: Abscissa of the child curve (e.g. plastic strain).
- **$Z$ coordinate**: Ordinate of the child curve (e.g. yield stress).

For standard `1D` tables:
1. The table specifies a list of $Y$ values.
2. The subsequent keywords in the input deck are the child curves (one for each $Y$ value, in sequential order).
3. By resolving these child curves, we obtain the full 3D dataset $(X, Y, Z)$ representing a surface.

---

## 3D Axonometric Projection

To render a 3D plot within a static SVG inside the hover popup, we project 3D coordinates $(X, Y, Z)$ into 2D SVG canvas coordinates $(u, v)$:

1. **Normalize**:
   $$x_n = \frac{X - minX}{maxX - minX}, \quad y_n = \frac{Y - minY}{maxY - minY}, \quad z_n = \frac{Z - minZ}{maxZ - minZ}$$

2. **Project**:
   $$u = u_0 + x_n \cdot dx_X + y_n \cdot dx_Y$$
   $$v = v_0 + x_n \cdot dy_X + y_n \cdot dy_Y + z_n \cdot dy_Z$$

   *Suggested Projection Vectors (optimized for SVGs of size $380 \times 220$):*
   - X-axis vector: $(dx_X, dy_X) = (160, 20)$ (slightly tilted down)
   - Y-axis vector: $(dx_Y, dy_Y) = (90, -45)$ (depth, tilted up-right)
   - Z-axis vector: $(dx_Z, dy_Z) = (0, -100)$ (vertical, straight up)
   - Base Offset (origin): $(u_0, v_0) = (70, 165)$

---

## Visual Elements

- **Back Grid Walls**: Dash-lined background grids on the floor ($Z = minZ$) and back-left wall ($X = minX$) to enhance depth perception.
- **Axes**: Distinct $X$, $Y$, and $Z$ axes with tick marks and labels.
- **Vibrant HSL Heatmap Colors**: Curves are drawn at different depths (Y values), styled with a gradient from Cyan (lowest Y) to Yellow-Orange (highest Y) in dark mode, and Blue to Red in light mode.
- **Wireframe Grid Mesh**: If the point counts of adjacent curves match, thin connecting lines are drawn between corresponding points of adjacent curves to render a beautiful wireframe surface mesh.

---

## Verification Plan

- Run `npm test` to ensure all tests pass.
- Add unit tests for 3D table SVG rendering.
- Manually hover over `table 100` reference in `mat_test.key` and verify rendering.
