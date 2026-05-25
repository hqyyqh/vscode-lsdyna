# Codebase Documentation and JSDoc Annotation Design

This document details the design specifications and roadmap for systematically adding comprehensive JSDoc/TSDoc annotations and file-level header descriptions to the entire `src/` directory of the VS Code LS-DYNA extension.

## Goal

To improve developer collaboration and future AI code comprehension by enriching the JavaScript source files with clear English comments, file-level responsibility descriptions, and detailed JSDoc type annotations.

---

## 1. Documentation Standards

### 1.1 File Header Description
Every source file under `src/` must start with a file header containing the following sections:
*   `@fileoverview`: A short summary of the file's primary purpose.
*   `@module`: The module namespace, relative to `src/` (e.g. `core/parser/blockScanner`).
*   **Description**: A paragraph explaining the file's responsibilities, input/output structures, and its role/context in the extension architecture (e.g. client, server, or worker context).

**Template:**
```javascript
/**
 * @fileoverview [One-line summary of file purpose]
 * @module [module-path]
 * 
 * [Detailed description explaining what the file does, its inputs and outputs,
 * and how it fits into the broader application architecture.]
 * 
 * Role in System: [e.g. Client-side VS Code provider, isolated LSP server handler, high-performance background worker, etc.]
 */
```

### 1.2 JSDoc Type Definitions (`@typedef`)
To model complex domain entities without TS interfaces, we will define explicit JSDoc typedefs. These definitions should be placed near the top of the files where they are first produced or heavily used, enabling IDE auto-complete and type validation.

Key Domain Entities to define:
*   `KeywordBlock`: `{ keyword: string, startLine: number, endLine: number }`
*   `IncludeNode`: Representing a node in the include file dependency tree.
*   `ParameterInfo`: Representing parameter definitions and definitions.
*   `ManualIndex`: Cached or indexed page data for SumatraPDF and LS-DYNA Manual lookups.

### 1.3 Function & Method JSDoc
Every function (exported or internal helpers) and class method must have JSDoc detailing:
*   Its purpose and side effects.
*   `@param {type} name` - Description.
*   `@returns {type}` - Return value description.
*   `@throws {type}` - (If applicable) Exception types thrown.

---

## 2. File-by-File Documentation Roadmap

The `src/` codebase is organized as follows:

| Directory | Role / Files | Annotation Scope |
|---|---|---|
| `src/core/parser/` | Scanners for blocks, keywords, and includes | `blockScanner.js`, `includeScanner.js`, `keywordScanner.js` (Types: `KeywordBlock`, `IncludeMatch`) |
| `src/core/cache/` | L2 persistent disk and memory caching | `cacheManifestStore.js`, `diskSnapshotStore.js`, `snapshotSerializer.js` |
| `src/core/incremental/`| Incremental parsing and range shifting | `blockIndex.js`, `fileInvalidation.js` |
| `src/core/project/` | Project-wide indexing and graph resolver | `projectGraph.js`, `projectIndexer.js` |
| `src/core/` | Manual parsing & indexing | `manualIndexer.js` |
| `src/client/` | VS Code extension client providers & UI | `includeTreeProvider.js`, `keywordIndexProvider.js`, `indexClient.js` |
| `src/server/` | Language Server Protocol (LSP) server | `server.js`, `requestRouter.js`, `sessionManager.js` |
| `src/worker/` | Background indexing workers | `scanWorker.js`, `projectIndexLoader.js`, `workerPool.js` |
| `src/shared/` | Protocol messaging types | `protocol.js` |
| `src/` | Main entry point | `extension.js` |

---

## 3. Verification Plan

### Automated Verification
*   Run VS Code extension compilation and type check via TypeScript compiler in non-emitting mode (e.g. `npx tsc --noEmit` if typescript is installed as a devDependency, or check with ESLint) to ensure no syntax errors were introduced.
*   Run existing tests: `npm run test` or check test runner configuration.

### Manual Verification
*   Verify that hovering over functions in VS Code displays the newly added JSDoc comments.
*   Ensure the extension starts up and behaves correctly in the extension development host.
