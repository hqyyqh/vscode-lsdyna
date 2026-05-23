# Specification: Robust LS-DYNA Manual Hover Fix and Fallback

## 1. Goal Description

This specification addresses an issue where the LS-DYNA manual hover links do not display for keywords ending in `_TITLE` (e.g. `*MAT_PIECEWISE_LINEAR_PLASTICITY_TITLE`) or keywords like `*CONTROL_SOLUTION` in the active VS Code extension environment. 

To resolve this, we will implement:
- **Cache Versioning**: Invalidates stale/incomplete caches in `workspaceState` across runs.
- **Robust Path Resolution**: Scans all active workspace folders, `process.cwd()`, and the extension path for manuals directories.
- **Fallback Hover**: Displays a minimal hover containing the manual links even when a keyword has no metadata in `field_data.json` but has bookmark matches.
- **Diagnostics logging**: Adds an output channel `"LS-DYNA Manuals"` to log indexer progress.

## 2. Component Specifications

### 2.1 manualIndexer.js

- **Cache Versioning**:
  - Add `const CACHE_VERSION = 2;`
  - Change the cache validity check to verify that `cache[pdfPath].version === CACHE_VERSION`.
- **Multi-Path Resolution**:
  - Resolve the relative `manualsDir` against all `workspaceFolders` if they exist.
  - Scan all resolved directories, deduplicate them, and find PDF files.
- **Logging**:
  - Create a VS Code Output Channel named `"LS-DYNA Manuals"` and log directory scans, cache hits, parser invocations, bookmark counts, and error details.

### 2.2 extension.js (Hover Provider)

- **Fallback Hover**:
  - In `LsdynaFieldHoverProvider.provideHover` keyword line check, if `lookupKeyword(kwName)` returns null, perform a fallback check:
    - Call `manualIndexer.getManualLocations(manualIndexer.cleanKeyword(kwName))`.
    - If locations are returned, construct a minimal markdown hover `**\*${kwName}**` with manual links appended.

## 3. Verification Plan

### Automated Tests
- Run `npm test` to ensure no regressions.
- Update `test/core/manualIndexer.test.js` to cover the cache versioning logic.
- Update `test/extension.test.js` to cover fallback hovers when no metadata entry is available.
