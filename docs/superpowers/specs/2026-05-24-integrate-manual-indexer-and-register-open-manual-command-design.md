# Task 3 Design Spec: Integrate manualIndexer and Register openManual Command

## 1. Goal
Integrate `manualIndexer` into `src/extension.js` and register the command `extension.openManual`.
Specifically:
1. Import `manualIndexer` in `src/extension.js`.
2. Asynchronously call `manualIndexer.initialize(context)` at the start of `activate(context)`.
3. Register the `extension.openManual` command in `activate(context)`.
4. Update `package.json` to include `"category": "LS-DYNA"` for `extension.openManual` command and add `"onCommand:extension.openManual"` to `activationEvents`.

## 2. Detailed Technical Design

### A. In `src/extension.js`:
- Import `manualIndexer` at the top:
  ```javascript
  const manualIndexer = require('./core/manualIndexer');
  ```
- Import `child_process` (required for system opening on Windows):
  ```javascript
  const child_process = require('child_process');
  ```
- At the start of `activate(context)`:
  ```javascript
  // Initialize the manual indexer in background
  manualIndexer.initialize(context).catch(err => {
      console.error('Failed to initialize manualIndexer:', err);
  });
  ```
- Register command `extension.openManual`:
  ```javascript
  context.subscriptions.push(
      vscode.commands.registerCommand('extension.openManual', async (pdfPath, pageNum) => {
          const config = vscode.workspace.getConfiguration('lsdyna');
          const viewer = config.get('manualViewer') || 'system';

          if (viewer === 'vscode') {
              try {
                  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pdfPath));
              } catch (err) {
                  vscode.window.showErrorMessage(`Failed to open PDF in VS Code: ${err.message}`);
              }
          } else {
              // system viewer
              if (process.platform === 'win32') {
                  const formattedPath = pdfPath.replace(/\\/g, '/');
                  const fileUrl = `file:///${formattedPath}#page=${pageNum}`;
                  child_process.exec(`cmd.exe /c start "" "${fileUrl}"`, (error) => {
                      if (error) {
                          // fallback
                          vscode.env.openExternal(vscode.Uri.file(pdfPath));
                      }
                  });
              } else {
                  vscode.env.openExternal(vscode.Uri.file(pdfPath));
              }
          }
      })
  );
  ```

### B. In `package.json`:
- Under `contributes.commands`, find the entry for `extension.openManual` and modify it:
  ```json
              {
                  "command": "extension.openManual",
                  "title": "Open LS-DYNA Keyword Manual",
                  "category": "LS-DYNA"
              }
  ```
- Under `activationEvents`, add `"onCommand:extension.openManual"`.

## 3. Verification Plan
- Run `npm test` to make sure existing tests are unaffected.
- We will add testing for the command integration in `test/extension.test.js` or verify manual integration manually.
