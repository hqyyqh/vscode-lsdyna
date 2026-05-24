# Design Spec: Repository Compaction and Development Documentation

This document outlines the design and execution steps for purging heavy binary/manual directories from Git history and adding comprehensive development documentation to the repository.

## 1. Goal Description

- **Repo Compaction**: Completely remove `"LS-DYNA Manuals"` (large PDFs) and `"bin"` (containing SumatraPDF binaries/caches) from the entire Git history of all local branches to reduce the `.git` database size from ~300MB to a few megabytes.
- **Development Documentation**: Add a root-level `DEVELOPMENT.md` detailing environment setup, test execution, compilation/packaging commands, and PDF manual configurations.
- **Branch Management**: Run these operations on a new branch `feature/cleanup-and-docs` first, then apply the history rewriting across all local branches.

## 2. Git History Purging Plan

### Method: Built-in `git filter-branch`
Since Python's `git-filter-repo` is not pre-installed, we will use the built-in `git filter-branch` tool with `--index-filter` for efficiency.

#### Step 2.1: Branch Out
Create and switch to `feature/cleanup-and-docs` from the current branch.

#### Step 2.2: Add the Development Guide
Create `DEVELOPMENT.md` in the root folder and commit it.

#### Step 2.3: Rewrite History
Run:
```powershell
git filter-branch --force --index-filter "git rm -rf --cached --ignore-unmatch 'LS-DYNA Manuals' bin" --prune-empty --tag-name-filter cat -- --all
```

#### Step 2.4: Clean Original Backups and Reclaim Disk Space
Git stores original refs under `refs/original/`. We must remove them and run aggressive garbage collection:
```powershell
git for-each-ref --format="%(refname)" refs/original/ | foreach { git update-ref -d $_ }
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

## 3. DEVELOPMENT.md Content Design

The root-level `DEVELOPMENT.md` will contain the following structured sections:
1. **Prerequisites**: Required Node.js version, recommended VS Code version, and necessary developer environment info.
2. **Setup**: Installing package dependencies via `npm install`.
3. **Running and Testing**:
   - Running the extension locally for debugging.
   - Launching tests using `npm test` (with notes on how the VS Code testing environment runs).
4. **Packaging and Compilation**:
   - Packaging command: `npx -y @vscode/vsce package --no-git-tag-version --no-update-package-json`
   - Description of output `.vsix` file.
5. **PDF Manual & SumatraPDF Integration Configuration Guide**:
   - Setting up `lsdyna.manualsDir` to point to the local manuals folder.
   - For Windows users: Copying `SumatraPDF.exe` to the manuals folder to enable page-specific jumps.
   - Explaining the auto-indexing and directory watcher behaviors.
