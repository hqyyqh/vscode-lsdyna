# 2026-05-24 SumatraPDF Test Suite Refactoring Design Spec

## 1. Goal Description
The objective is to replace the old `extension.openManual command` test suite (around line 1716 to the end of `test/extension.test.js`) with a comprehensive set of test cases validating the new SumatraPDF integration and fallback logic.

## 2. Detailed Test Case Design
We will cover the following scenarios:

1. **User Configured Path (`sumatrapdfPath`)**:
   - Platform: `win32`
   - Config: `lsdyna.sumatrapdfPath` configured to a custom path (e.g. `C:\custom\SumatraPDF.exe`).
   - Mock: `fs.existsSync` returns `true` for this path.
   - Assert: `child_process.spawn` is invoked with this path and standard options.

2. **Bundled SumatraPDF**:
   - Platform: `win32`
   - Config: `sumatrapdfPath` is undefined.
   - Mock: `context.asAbsolutePath(path.join('bin', 'SumatraPDF.exe'))` returns a mock bundled path. `fs.existsSync` returns `true` only for the bundled path.
   - Assert: `child_process.spawn` is invoked with the bundled path.

3. **Registry Query (HKLM / HKCU App Paths)**:
   - Platform: `win32`
   - Config: `sumatrapdfPath` is undefined.
   - Mock: `fs.existsSync` returns `false` for bundled/custom paths. `child_process.exec` simulates a successful query for SumatraPDF path (e.g. returns a valid path in registry query). `fs.existsSync` returns `true` for the registry path.
   - Assert: `child_process.spawn` is invoked with the registry path.

4. **PATH Environment Variable**:
   - Platform: `win32`
   - Config: `sumatrapdfPath` is undefined.
   - Mock: Registry query fails/returns empty. `process.env.PATH` includes a specific directory. `fs.existsSync` returns `true` only for `SumatraPDF.exe` under that directory.
   - Assert: `child_process.spawn` is invoked with the directory path.

5. **Common Heuristic Paths**:
   - Platform: `win32`
   - Config: `sumatrapdfPath` is undefined.
   - Mock: Registry query fails, `process.env.PATH` is empty. `fs.existsSync` returns `true` only for `C:\Program Files\SumatraPDF\SumatraPDF.exe`.
   - Assert: `child_process.spawn` is invoked with the heuristic path.

6. **Fallback to `openManualFallback` when SumatraPDF is not found**:
   - Platform: `win32`
   - Config: `sumatrapdfPath` is undefined.
   - Mock: All SumatraPDF search methods fail (return `null`).
   - Assert: `child_process.exec` is called with `cmd.exe /c start "" "file:///C:/path/to/manual.pdf#page=12"`.

7. **Fallback when `spawn` throws an error**:
   - Platform: `win32`
   - Config: Custom path configured.
   - Mock: Custom path exists, but `child_process.spawn` returns a mock child process that fires an `'error'` event.
   - Assert: `child_process.exec` is called with the fallback `cmd.exe /c start ...` command.

8. **Fallback to `vscode.env.openExternal` when `openManualFallback` itself fails**:
   - Platform: `win32`
   - Mock: SumatraPDF not found. `child_process.exec` for the fallback command fails/errors.
   - Assert: `vscode.env.openExternal` is invoked.

9. **Non-Windows Platform (e.g. macOS / `darwin`)**:
   - Platform: `darwin`
   - Assert: Directly calls `vscode.env.openExternal`. No spawning or exec commands are run.

## 3. Mocking Strategy
- **`process.platform`**: Use `Object.defineProperty(process, 'platform', ...)` to override.
- **`child_process.spawn`**: Mock to track arguments, environments, options, and returns a dummy EventEmitter representing the child process (with `on`, `unref`, and optional error trigger).
- **`child_process.exec`**: Mock to track commands executed, support callback invocation, and return error/stdout.
- **`fs.existsSync`**: Intercept calls to check mock paths and fallback to original `fs.existsSync` for standard module paths.
- **`vscodeMock.workspace.getConfiguration`**: Simulate returning configuration for `sumatrapdfPath`.
- **`vscodeMock.env.openExternal`**: Capture uri/arguments to verify fallback behaviour.
