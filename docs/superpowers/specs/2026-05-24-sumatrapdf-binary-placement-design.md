# Design Spec: SumatraPDF Binary Placement and Configurations

## 1. Purpose
The goal is to bundle the `SumatraPDF.exe` executable inside the VS Code extension to provide an out-of-the-box, zero-configuration PDF viewing experience on Windows. 

## 2. Requirements & Options Analysis
We discussed two approaches for tracking and bundling the binary:
* **Option 1 (Implicit):** Depend on current settings which do not ignore `bin/`.
* **Option 2 (Explicit Negation - Approved):** Explicitly add negation patterns to `.gitignore` and `.vscodeignore` to ensure the binary is always tracked by Git and packaged by VS Code, even if wildcard excludes are added in the future.

## 3. Detailed Actions
1. **Binary Placement:**
   - Source: `C:\Users\qyang\Downloads\SumatraPDF.exe` (host system)
   - Destination: `d:\Project\vscode-lsdyna\bin\SumatraPDF.exe`
2. **Git Configuration (`.gitignore`):**
   - Add `!bin/SumatraPDF.exe` to allow committing the executable.
3. **Packaging Configuration (`.vscodeignore`):**
   - Add `!bin/SumatraPDF.exe` to make sure it is included in VS Code extension packages.

## 4. Verification Plan
- **File Existence:** Verify `bin/SumatraPDF.exe` exists by running:
  `Test-Path bin/SumatraPDF.exe` in PowerShell.
- **Git Status:** Verify that `bin/SumatraPDF.exe`, `.gitignore`, and `.vscodeignore` show up as modified/untracked files and can be successfully added to the index.
