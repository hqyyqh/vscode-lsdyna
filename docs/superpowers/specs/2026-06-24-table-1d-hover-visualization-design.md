# Design Spec: Standard 1D Table Parsing and Hover Visualization Support

This specification documents the design and fix to support standard 1D table parsing (`*DEFINE_TABLE` and `*DEFINE_TABLE_TITLE`) and their hover visualization in VS Code.

## Problem Description

When users define standard 1D tables (`*DEFINE_TABLE*` without `_2D` or `_3D` suffix) and hover over references to them, the hover does not display the table rows. It only shows the header and table title.

## Root Cause Analysis

1. **Empty Rows in Initial Parse**:
   Standard 1D tables only specify abscissa values in their block (one value per line or multiple values per line), and do not pair values with curve IDs in the same block. Previously, the parser only supported `2d` and `3d` tables that require at least two tokens per line.
2. **Missing Compilation**:
   The TypeScript source file `src/core/references/curveTableDefinitionScanner.ts` was modified by a previous implementation to support 1D tables and resolve child curves, but these changes were never compiled, tested, or verified. The extension was still running the old compiled code in `out/` which did not parse 1D tables properly.

## Proposed Solution (Option A - Recommended)

1. **Compile & Sync**: Compile the existing changes in `src/core/references/curveTableDefinitionScanner.ts` to `out/` using `npm run compile`.
2. **Add Unit Tests**: Add a unit test in `test/core/references/curveTableDefinitionScanner.test.js` to test parsing standard 1D tables and mapping them to their subsequent curves.
3. **Validate Hover rendering**: Verify that the hover rendering works correctly when displaying the table preview.

## Verification Plan

- Run `npm test` to ensure all tests pass.
- Verify the specific unit test for standard 1D tables.
