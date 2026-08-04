'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const runtimePrefix = 'vscode-lsdyna-editor-safety-close-dialog-';

function resolveVSCodeExecutable() {
    if (process.env.VSCODE_EXECUTABLE_PATH) {
        const configured = path.resolve(process.env.VSCODE_EXECUTABLE_PATH);
        if (!fs.existsSync(configured) || !fs.statSync(configured).isFile()) {
            throw new Error(
                `VS Code executable does not exist or is not a file: ${configured}`,
            );
        }
        return configured;
    }
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        const candidate = path.join(
            process.env.LOCALAPPDATA,
            'Programs',
            'Microsoft VS Code',
            'Code.exe',
        );
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    throw new Error(
        'Set VSCODE_EXECUTABLE_PATH to a VS Code executable for the native dialog test.',
    );
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function reserveLoopbackPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

async function connectWorkbenchDevTools(port) {
    const deadline = Date.now() + 15000;
    let target = null;
    while (Date.now() < deadline && !target) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/list`);
            const targets = response.ok ? await response.json() : [];
            target = targets.find(item =>
                item.type === 'page' &&
                typeof item.url === 'string' &&
                item.url.includes('/workbench.html') &&
                item.webSocketDebuggerUrl
            );
        } catch (_) {
            // Electron publishes the Workbench target after the main process starts.
        }
        if (!target) await delay(50);
    }
    if (!target) throw new Error('VS Code Workbench DevTools target was not published');

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await Promise.race([
        new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        }),
        delay(5000).then(() => {
            throw new Error('Timed out connecting to VS Code Workbench DevTools');
        }),
    ]);

    let nextId = 1;
    const pending = new Map();
    socket.addEventListener('message', event => {
        let message;
        try {
            message = JSON.parse(String(event.data));
        } catch (_) {
            return;
        }
        if (!message.id || !pending.has(message.id)) return;
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result || {});
    });

    return {
        socket,
        call(method, params = {}) {
            const id = nextId++;
            const command = new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                socket.send(JSON.stringify({ id, method, params }));
            });
            return Promise.race([
                command,
                delay(5000).then(() => {
                    throw new Error(`Timed out waiting for CDP ${method}`);
                }),
            ]);
        },
    };
}

async function evaluate(devTools, expression) {
    const response = await devTools.call('Runtime.evaluate', {
        expression,
        returnByValue: true,
    });
    if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.text || 'Renderer evaluation failed');
    }
    return response.result ? response.result.value : undefined;
}

async function waitFor(read, accept, label, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let value;
    while (Date.now() < deadline) {
        value = await read();
        if (accept(value)) return value;
        await delay(25);
    }
    throw new Error(`${label}: ${JSON.stringify(value)}`);
}

async function dispatchKey(devTools, key, code, virtualKeyCode, modifiers = 0) {
    const params = {
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
    };
    await devTools.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
    await devTools.call('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

async function rendererEditorState(devTools) {
    return evaluate(devTools, `(() => {
        const editor = document.querySelector('.monaco-editor.focused') ||
            document.querySelector('.monaco-editor');
        const lines = editor ? Array.from(
            editor.querySelectorAll('.view-lines .view-line')
        ).map(line => String(line.textContent || '').replace(/\u00a0/g, ' ')) : [];
        return {
            lines,
            tabs: Array.from(document.querySelectorAll('.tab')).map(tab => ({
                text: String(tab.textContent || '').trim(),
                className: String(tab.className || ''),
                ariaLabel: tab.getAttribute('aria-label') || ''
            }))
        };
    })()`);
}

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function workspaceSnapshot(workspaceDirectory) {
    const result = {};
    for (const name of fs.readdirSync(workspaceDirectory).sort()) {
        const filePath = path.join(workspaceDirectory, name);
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        result[name] = { bytes: stat.size, sha256: sha256(filePath) };
    }
    return result;
}

function createEvidenceDirectory() {
    const parent = path.join(os.tmpdir(), 'vscode-lsdyna-editor-safety-evidence');
    fs.mkdirSync(parent, { recursive: true });
    return fs.mkdtempSync(path.join(parent, 'close-dialog-'));
}

function removeRuntimeDirectory(runtimeDirectory) {
    const resolved = path.resolve(runtimeDirectory);
    if (
        path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolved).startsWith(runtimePrefix)
    ) {
        throw new Error(`Refusing to remove unexpected runtime directory: ${resolved}`);
    }
    fs.rmSync(resolved, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
    });
}

async function stopChildProcess(child, timeoutMs = 5000) {
    if (!child.pid) return true;
    if (child.exitCode !== null || child.signalCode !== null) return true;
    const exited = new Promise(resolve => child.once('exit', () => resolve(true)));
    child.kill();
    const stopped = await Promise.race([
        exited,
        delay(timeoutMs).then(() => false),
    ]);
    if (
        !stopped &&
        child.exitCode === null &&
        child.signalCode === null
    ) {
        return false;
    }
    await delay(250);
    return true;
}

async function main() {
    if (process.platform !== 'win32') {
        throw new Error('The native dirty-close dialog test requires Windows');
    }

    const vscodeExecutablePath = resolveVSCodeExecutable();
    const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), runtimePrefix));
    const workspaceDirectory = path.join(runtimeDirectory, 'workspace');
    const userDataDirectory = path.join(runtimeDirectory, 'user-data');
    const extensionsDirectory = path.join(runtimeDirectory, 'extensions');
    const evidenceDirectory = createEvidenceDirectory();
    fs.mkdirSync(workspaceDirectory);
    fs.mkdirSync(path.join(userDataDirectory, 'User'), { recursive: true });
    fs.mkdirSync(extensionsDirectory);
    fs.writeFileSync(
        path.join(userDataDirectory, 'User', 'settings.json'),
        `${JSON.stringify({ 'files.hotExit': 'off' }, null, 2)}\n`,
        'utf8',
    );

    const deckPath = path.join(workspaceDirectory, 'close-unsaved.key');
    const otherPath = path.join(workspaceDirectory, 'other-condition.key');
    const original = '*KEYWORD\r\n*NODE\r\n    1       0       0       0\r\n*END\r\n';
    fs.writeFileSync(deckPath, original, 'utf8');
    fs.writeFileSync(otherPath, '*KEYWORD\r\n*END\r\n', 'utf8');
    const before = workspaceSnapshot(workspaceDirectory);

    const port = await reserveLoopbackPort();
    const logs = [];
    const child = childProcess.spawn(vscodeExecutablePath, [
        '--new-window',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        `--extensionDevelopmentPath=${repoRoot}`,
        `--user-data-dir=${userDataDirectory}`,
        `--extensions-dir=${extensionsDirectory}`,
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${port}`,
        '--goto',
        `${deckPath}:3:1`,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const childStarted = new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
    });
    child.stdout.on('data', chunk => logs.push(String(chunk)));
    child.stderr.on('data', chunk => logs.push(String(chunk)));
    child.on('error', error => logs.push(`[process error] ${error.stack || error}\n`));

    let devTools = null;
    let passed = false;
    try {
        await childStarted;
        devTools = await connectWorkbenchDevTools(port);
        await waitFor(
            () => rendererEditorState(devTools),
            state => state.lines.some(line => line.includes('1       0')),
            'Workbench did not open the LS-DYNA deck',
            15000,
        );
        await delay(1500);

        await dispatchKey(devTools, '/', 'Slash', 191, 2);
        const dirtyState = await waitFor(
            () => rendererEditorState(devTools),
            state =>
                state.lines.some(line => line.startsWith('$    1')) &&
                state.tabs.some(tab =>
                    tab.text.includes('close-unsaved.key') &&
                    tab.className.split(/\s+/).includes('dirty')
                ),
            'Ctrl+/ did not use the LS-DYNA column-zero comment command',
        );
        assert.deepStrictEqual(workspaceSnapshot(workspaceDirectory), before);

        // Close the real Workbench window. The save decision is a Windows
        // TaskDialog, so it is intentionally validated outside --extensionTestsPath.
        await dispatchKey(devTools, 'W', 'KeyW', 87, 10);
        const dialogResult = JSON.parse(childProcess.execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-File',
                path.join(repoRoot, 'scripts', 'editor-safety-native-dialog.ps1'),
                '-OwnerProcessId',
                String(child.pid),
                '-Action',
                'Cancel',
            ],
            { encoding: 'utf8' },
        ));
        assert.ok(dialogResult.Instruction.includes('close-unsaved.key'));
        assert.deepStrictEqual(
            dialogResult.Buttons.map(button => button.AutomationId),
            ['CommandButton_100', 'CommandButton_101', 'CommandButton_102'],
        );
        assert.ok(dialogResult.Buttons.every(button => button.Name));
        assert.strictEqual(dialogResult.Closed, true);

        const cancelledState = await waitFor(
            () => rendererEditorState(devTools),
            state =>
                state.lines.some(line => line.startsWith('$    1')) &&
                state.tabs.some(tab =>
                    tab.text.includes('close-unsaved.key') &&
                    tab.className.split(/\s+/).includes('dirty')
                ),
            'Cancel did not keep the dirty editor open',
        );
        assert.ok(
            cancelledState.tabs.some(tab => tab.text.includes('close-unsaved.key')),
            'Cancel removed the dirty deck tab',
        );
        assert.deepStrictEqual(workspaceSnapshot(workspaceDirectory), before);

        const screenshot = await devTools.call('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: false,
            fromSurface: true,
        });
        fs.writeFileSync(
            path.join(evidenceDirectory, 'cancelled-dirty-close.png'),
            Buffer.from(screenshot.data, 'base64'),
        );
        await dispatchKey(devTools, 'z', 'KeyZ', 90, 2);
        const restoredState = await waitFor(
            () => rendererEditorState(devTools),
            state =>
                state.lines.some(line => line.startsWith('    1')) &&
                state.tabs.some(tab =>
                    tab.text.includes('close-unsaved.key') &&
                    !tab.className.split(/\s+/).includes('dirty')
                ),
            'Ctrl+Z did not restore the pre-comment text',
        );
        assert.deepStrictEqual(workspaceSnapshot(workspaceDirectory), before);

        const result = {
            capturedAt: new Date().toISOString(),
            vscodeExecutablePath,
            extensionRoot: repoRoot,
            before,
            dirtyState,
            dialog: dialogResult,
            cancelledState,
            restoredState,
            after: workspaceSnapshot(workspaceDirectory),
            diskClean: true,
        };
        fs.writeFileSync(
            path.join(evidenceDirectory, 'result.json'),
            `${JSON.stringify(result, null, 2)}\n`,
            'utf8',
        );
        passed = true;
        console.log(`[close dialog] evidence: ${evidenceDirectory}`);
        console.log('[close dialog] native Cancel preserved the dirty editor and disk bytes');
    } finally {
        if (devTools) devTools.socket.close();
        const stopped = await stopChildProcess(child);
        fs.writeFileSync(path.join(evidenceDirectory, 'code.log'), logs.join(''), 'utf8');
        if (passed && stopped) {
            removeRuntimeDirectory(runtimeDirectory);
        } else {
            console.error(`[close dialog] failed runtime preserved: ${runtimeDirectory}`);
            console.error(`[close dialog] evidence preserved: ${evidenceDirectory}`);
        }
        if (!stopped) {
            throw new Error(
                `VS Code process ${child.pid} did not exit; runtime directory was preserved`,
            );
        }
    }
}

module.exports = {
    removeRuntimeDirectory,
    resolveVSCodeExecutable,
    stopChildProcess,
};

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error);
        process.exitCode = 1;
    });
}
