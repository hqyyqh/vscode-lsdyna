'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const vscode = require('vscode');

const workspaceRoot = process.env.LSDYNA_EDITOR_SAFETY_WORKSPACE;
const devToolsPort = Number(process.env.LSDYNA_EDITOR_SAFETY_CDP_PORT || 0);

function withTimeout(promise, milliseconds, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), milliseconds);
        Promise.resolve(promise).then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

async function connectWorkbenchDevTools() {
    if (!devToolsPort || typeof fetch !== 'function' || typeof WebSocket !== 'function') {
        throw new Error('VS Code renderer DevTools is unavailable');
    }

    const deadline = Date.now() + 5000;
    let target = null;
    while (Date.now() < deadline && !target) {
        try {
            const response = await fetch(`http://127.0.0.1:${devToolsPort}/json/list`);
            if (response.ok) {
                const targets = await response.json();
                target = targets.find(item =>
                    item.type === 'page' &&
                    typeof item.url === 'string' &&
                    item.url.includes('/workbench.html') &&
                    item.webSocketDebuggerUrl
                );
            }
        } catch (_) {
            // Electron may publish its DevTools target after the extension host starts.
        }
        if (!target) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!target) throw new Error('VS Code workbench DevTools target was not published');

    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await withTimeout(
        new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
        }),
        3000,
        'Timed out connecting to VS Code workbench DevTools',
    );

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
        if (message.error) {
            entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        } else {
            entry.resolve(message.result || {});
        }
    });

    const call = (method, params = {}) => {
        const id = nextId++;
        const command = new Promise((resolve, reject) => {
            pending.set(id, { method, resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
        });
        return withTimeout(
            command,
            3000,
            `Timed out waiting for CDP ${method}`,
        );
    };

    return {
        call,
        close() {
            for (const entry of pending.values()) {
                entry.reject(new Error('VS Code workbench DevTools connection closed'));
            }
            pending.clear();
            socket.close();
        },
    };
}

async function getRendererActiveElement(devTools) {
    const response = await devTools.call('Runtime.evaluate', {
        expression: `(() => {
            const element = document.activeElement;
            return element ? {
                tagName: element.tagName,
                className: String(element.className || ''),
                value: typeof element.value === 'string' ? element.value : null
            } : null;
        })()`,
        returnByValue: true,
    });
    return response.result ? response.result.value : null;
}

async function waitForRendererInput(devTools, expectedValue = null) {
    const deadline = Date.now() + 3000;
    let activeElement = null;
    while (Date.now() < deadline) {
        activeElement = await getRendererActiveElement(devTools);
        if (
            activeElement &&
            activeElement.tagName === 'INPUT' &&
            (expectedValue === null || activeElement.value === expectedValue)
        ) {
            return activeElement;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(
        `Renderer input did not become ready: ${JSON.stringify(activeElement)}`,
    );
}

async function waitForRendererEditorFocus(devTools) {
    const deadline = Date.now() + 3000;
    let activeElement = null;
    while (Date.now() < deadline) {
        activeElement = await getRendererActiveElement(devTools);
        if (
            activeElement &&
            (
                (
                    activeElement.tagName === 'TEXTAREA' &&
                    activeElement.className.includes('inputarea')
                ) ||
                activeElement.className.includes('native-edit-context')
            )
        ) {
            return activeElement;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(
        `Renderer editor did not receive focus: ${JSON.stringify(activeElement)}`,
    );
}

async function waitForRendererActionWidget(devTools) {
    const deadline = Date.now() + 3000;
    let widget = null;
    while (Date.now() < deadline) {
        const response = await devTools.call('Runtime.evaluate', {
            expression: `(() => {
                const isVisible = element =>
                    element instanceof HTMLElement &&
                    element.offsetParent !== null;
                const element = document.querySelector('.action-widget');
                if (!isVisible(element)) return null;
                const rows = Array.from(
                    element.querySelectorAll('.monaco-list-row.action')
                ).filter(isVisible).map(row =>
                    String(row.textContent || '').trim()
                );
                return {
                    text: String(element.textContent || '').trim(),
                    rows
                };
            })()`,
            returnByValue: true,
        });
        widget = response.result ? response.result.value : null;
        if (widget && widget.rows.length > 0) return widget;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(
        `Renderer Code Action widget did not become ready: ${JSON.stringify(widget)}`,
    );
}

async function getRendererMenuItemState(devTools, expectedKeybinding) {
    const response = await devTools.call('Runtime.evaluate', {
        expression: `(() => {
            const normalize = value => String(value || '').replace(/\\s+/g, '').toLowerCase();
            const queryAllDeep = selector => {
                const matches = [];
                const roots = [document];
                for (const root of roots) {
                    matches.push(...root.querySelectorAll(selector));
                    for (const element of root.querySelectorAll('*')) {
                        if (element.shadowRoot) roots.push(element.shadowRoot);
                    }
                }
                return matches;
            };
            const isVisible = element => {
                if (!(element instanceof HTMLElement)) return false;
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' && style.visibility !== 'hidden';
            };
            const elements = queryAllDeep(
                '.monaco-menu .action-menu-item'
            ).filter(isVisible);
            const items = elements.map(element => ({
                text: String(element.textContent || '').trim(),
                keybinding: String(
                    element.querySelector('.keybinding')?.textContent || ''
                ).trim(),
                ariaLabel: element.getAttribute('aria-label') || '',
                disabled: element.getAttribute('aria-disabled') === 'true'
            }));
            const expected = normalize(${JSON.stringify(expectedKeybinding)});
            const targetIndex = items.findIndex(item =>
                !item.disabled && normalize(item.keybinding) === expected
            );
            if (targetIndex < 0) return { items, point: null };
            const clickTarget = elements[targetIndex].querySelector('.action-label') ||
                elements[targetIndex];
            const rect = clickTarget.getBoundingClientRect();
            return {
                items,
                point: {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    ...items[targetIndex]
                }
            };
        })()`,
        returnByValue: true,
    });
    return response.result ? response.result.value : null;
}

async function waitForRendererMenuItem(devTools, expectedKeybinding) {
    const deadline = Date.now() + 3000;
    let state = null;
    while (Date.now() < deadline) {
        state = await getRendererMenuItemState(devTools, expectedKeybinding);
        if (state?.point) return state.point;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    await captureRendererDiagnostic(
        devTools,
        `context-menu-${String(expectedKeybinding).replace(/[^a-z0-9]+/gi, '-')}`,
    );
    throw new Error(
        `Renderer menu item did not become ready (${expectedKeybinding}): ` +
        JSON.stringify(state),
    );
}

async function getRendererSuggestionWidget(devTools) {
    const response = await devTools.call('Runtime.evaluate', {
        expression: `(() => {
            const isVisible = element => {
                if (!(element instanceof HTMLElement)) return false;
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rect.width > 0 &&
                    rect.height > 0 &&
                    style.display !== 'none' &&
                    style.visibility !== 'hidden';
            };
            const element = document.querySelector('.suggest-widget');
            if (!isVisible(element)) return null;
            const rows = Array.from(
                element.querySelectorAll('.monaco-list-row')
            ).filter(isVisible).map(row =>
                String(row.textContent || '').trim()
            );
            return {
                text: String(element.innerText || '').trim().slice(0, 500),
                rows
            };
        })()`,
        returnByValue: true,
    });
    return response.result ? response.result.value : null;
}

async function waitForRendererSuggestionWidget(devTools) {
    const deadline = Date.now() + 3000;
    let widget = null;
    while (Date.now() < deadline) {
        widget = await getRendererSuggestionWidget(devTools);
        if (widget && widget.rows.length > 0) return widget;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(
        `Renderer Suggest widget did not become ready: ${JSON.stringify(widget)}`,
    );
}

async function dispatchRendererKey(devTools, key, code, virtualKeyCode, modifiers = 0) {
    const params = {
        key,
        code,
        modifiers,
        windowsVirtualKeyCode: virtualKeyCode,
        nativeVirtualKeyCode: virtualKeyCode,
    };
    if (modifiers === 0 && typeof key === 'string' && key.length === 1) {
        params.text = key;
        params.unmodifiedText = key;
    }
    await devTools.call('Input.dispatchKeyEvent', {
        type: params.text ? 'keyDown' : 'rawKeyDown',
        ...params,
    });
    await devTools.call('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
}

async function getRendererVisibleElementCenter(devTools, selector) {
    const response = await devTools.call('Runtime.evaluate', {
        expression: `(() => {
            const elements = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
            const element = elements.find(candidate => {
                if (!(candidate instanceof HTMLElement)) return false;
                const rect = candidate.getBoundingClientRect();
                const style = getComputedStyle(candidate);
                return rect.width > 0 && rect.height > 0 &&
                    style.display !== 'none' && style.visibility !== 'hidden';
            });
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                text: String(element.textContent || '').trim()
            };
        })()`,
        returnByValue: true,
    });
    const point = response.result ? response.result.value : null;
    if (!point) throw new Error(`Visible renderer element not found: ${selector}`);
    return point;
}

async function getRendererEditorPositionPoint(devTools, oneBasedLine, zeroBasedColumn = 0) {
    const response = await devTools.call('Runtime.evaluate', {
        expression: `(() => {
            const editor = document.querySelector('.monaco-editor.focused');
            if (!(editor instanceof HTMLElement)) return null;
            const lineNumber = Array.from(
                editor.querySelectorAll('.margin-view-overlays .line-numbers')
            ).find(element => String(element.textContent || '').trim() === ${JSON.stringify(String(oneBasedLine))});
            if (!(lineNumber instanceof HTMLElement)) return null;
            const lineRect = lineNumber.getBoundingClientRect();
            const viewLine = Array.from(editor.querySelectorAll('.view-lines .view-line'))
                .find(element => {
                    const rect = element.getBoundingClientRect();
                    return Math.abs(rect.top - lineRect.top) < 1;
                });
            if (!(viewLine instanceof HTMLElement)) return null;

            const walker = document.createTreeWalker(viewLine, NodeFilter.SHOW_TEXT);
            let remaining = ${Number(zeroBasedColumn)};
            let node = walker.nextNode();
            while (node) {
                const length = String(node.nodeValue || '').length;
                if (remaining <= length) {
                    const range = document.createRange();
                    range.setStart(node, remaining);
                    range.collapse(true);
                    const rect = range.getBoundingClientRect();
                    return {
                        x: rect.left,
                        y: lineRect.top + lineRect.height / 2,
                        lineText: String(viewLine.textContent || '')
                    };
                }
                remaining -= length;
                node = walker.nextNode();
            }
            return null;
        })()`,
        returnByValue: true,
    });
    const point = response.result ? response.result.value : null;
    if (!point) {
        throw new Error(
            `Visible editor position not found: ${oneBasedLine}:${zeroBasedColumn}`,
        );
    }
    return point;
}

async function dispatchRendererMouseClick(
    devTools,
    point,
    modifiers = 0,
    button = 'left',
) {
    const buttonMask = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
    const base = {
        x: point.x,
        y: point.y,
        modifiers,
        button,
        clickCount: 1,
        pointerType: 'mouse',
    };
    await devTools.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        ...base,
        button: 'none',
        buttons: 0,
    });
    let pressError = null;
    try {
        await devTools.call('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            ...base,
            buttons: buttonMask,
        });
    } catch (err) {
        pressError = err;
    }
    try {
        await devTools.call('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            ...base,
            buttons: 0,
        });
    } catch (err) {
        if (!pressError) throw err;
    }
    if (pressError) throw pressError;
}

async function dispatchRendererMouseDrag(devTools, start, end, modifiers = 0) {
    const mouseEvent = (type, point, options = {}) => devTools.call(
        'Input.dispatchMouseEvent',
        {
            type,
            x: point.x,
            y: point.y,
            modifiers,
            button: options.button || 'left',
            buttons: options.buttons || 0,
            clickCount: 1,
            pointerType: 'mouse',
        },
    );
    await mouseEvent('mouseMoved', start, { button: 'none' });
    let dragError = null;
    try {
        await mouseEvent('mousePressed', start, { buttons: 1 });
        for (let step = 1; step <= 4; step++) {
            const fraction = step / 4;
            await mouseEvent('mouseMoved', {
                x: start.x + (end.x - start.x) * fraction,
                y: start.y + (end.y - start.y) * fraction,
            }, { buttons: 1 });
        }
    } catch (err) {
        dragError = err;
    }
    try {
        await mouseEvent('mouseReleased', end);
    } catch (err) {
        if (!dragError) throw err;
    }
    if (dragError) throw dragError;
}

async function setRendererComposition(devTools, text) {
    await devTools.call('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
    });
}

async function commitRendererComposition(devTools, text) {
    await devTools.call('Input.insertText', { text });
}

async function captureRendererDiagnostic(devTools, name) {
    const basePath = path.join(
        path.dirname(workspaceRoot),
        `${path.basename(workspaceRoot)}-${name}`,
    );
    const screenshot = await devTools.call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
        fromSurface: true,
    });
    fs.writeFileSync(`${basePath}.png`, Buffer.from(screenshot.data, 'base64'));

    const state = await devTools.call('Runtime.evaluate', {
        expression: `(() => {
            const queryAllDeep = selector => {
                const matches = [];
                const roots = [document];
                for (const root of roots) {
                    matches.push(...root.querySelectorAll(selector));
                    for (const element of root.querySelectorAll('*')) {
                        if (element.shadowRoot) roots.push(element.shadowRoot);
                    }
                }
                return matches;
            };
            const isVisible = element =>
                element instanceof HTMLElement &&
                element.offsetParent !== null;
            const describe = element => element ? {
                tagName: element.tagName,
                className: String(element.className || ''),
                id: element.id || '',
                value: typeof element.value === 'string' ? element.value : null,
                text: String(element.textContent || '').trim().slice(0, 500),
                ariaLabel: element.getAttribute('aria-label'),
                title: element.getAttribute('title')
            } : null;
            return {
                activeElement: describe(document.activeElement),
                visibleInputs: Array.from(document.querySelectorAll('input'))
                    .filter(isVisible)
                    .map(describe),
                visibleRenameOrPreviewElements: Array.from(
                    document.querySelectorAll(
                        '[class*="rename"], [class*="bulk-edit"], [class*="refactor"]'
                    )
                ).filter(isVisible).map(describe),
                visibleContextOrMenuElements: queryAllDeep(
                    '[class*="context-view"], [class*="monaco-menu"], [role="menu"]'
                ).filter(isVisible).map(describe)
            };
        })()`,
        returnByValue: true,
    });
    const diagnostic = state.result ? state.result.value : null;
    fs.writeFileSync(
        `${basePath}.json`,
        `${JSON.stringify(diagnostic, null, 2)}\n`,
        'utf8',
    );
    console.error(`Renderer diagnostic screenshot: ${basePath}.png`);
    console.error(`Renderer diagnostic state: ${basePath}.json`);
    return diagnostic;
}

function workspaceSnapshot() {
    const result = {};
    function visit(directory, relativeDirectory = '') {
        for (const name of fs.readdirSync(directory).sort()) {
            const filePath = path.join(directory, name);
            const relativePath = path.join(relativeDirectory, name).split(path.sep).join('/');
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                visit(filePath, relativePath);
                continue;
            }
            if (!stat.isFile()) continue;
            const bytes = fs.readFileSync(filePath);
            result[relativePath] = {
                bytes: bytes.length,
                sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            };
        }
    }
    visit(workspaceRoot);
    return result;
}

async function openFixture(name, showOptions = {}) {
    let document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(workspaceRoot, name)),
    );
    if (document.languageId !== 'lsdyna') {
        document = await vscode.languages.setTextDocumentLanguage(document, 'lsdyna');
    }
    const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
        ...showOptions,
    });
    return { document, editor };
}

function hoverMarkdown(hover) {
    return (hover && hover.contents || []).map(content =>
        typeof content === 'string' ? content : String(content && content.value || '')
    ).join('\n');
}

async function executeHover(document, position, expectedFragment) {
    const hovers = await vscode.commands.executeCommand(
        'vscode.executeHoverProvider',
        document.uri,
        position,
    );
    const hover = (hovers || []).find(candidate =>
        hoverMarkdown(candidate).includes(expectedFragment)
    );
    assert.ok(
        hover,
        `No hover contained ${JSON.stringify(expectedFragment)} at ${position.line}:${position.character}`,
    );
    return hover;
}

function selectionShape(selection) {
    return {
        anchor: [selection.anchor.line, selection.anchor.character],
        active: [selection.active.line, selection.active.character],
    };
}

function latencySummary(samples) {
    assert.ok(Array.isArray(samples) && samples.length > 0);
    const sorted = samples.slice().sort((left, right) => left - right);
    const percentile = ratio =>
        sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
    return {
        count: sorted.length,
        minMs: Number(sorted[0].toFixed(1)),
        medianMs: Number(percentile(0.5).toFixed(1)),
        p95Ms: Number(percentile(0.95).toFixed(1)),
        maxMs: Number(sorted[sorted.length - 1].toFixed(1)),
    };
}

function assertLatencyBudget(label, samples, p95BudgetMs, maxBudgetMs) {
    const summary = latencySummary(samples);
    assert.ok(
        summary.p95Ms <= p95BudgetMs,
        `${label} p95 ${summary.p95Ms} ms exceeded ${p95BudgetMs} ms`,
    );
    assert.ok(
        summary.maxMs <= maxBudgetMs,
        `${label} max ${summary.maxMs} ms exceeded ${maxBudgetMs} ms`,
    );
    return summary;
}

async function settleCardCellPostEdit(document) {
    const pending = vscode.extensions
        .getExtension('hqyyqh.dynasense')
        ?.exports?._internals
        ?.waitForCardCellPostEdit?.(document);
    if (pending) await pending;
}

async function writeClipboardText(text) {
    for (let attempt = 0; attempt < 5; attempt++) {
        await vscode.env.clipboard.writeText(text);
        if (await vscode.env.clipboard.readText() === text) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.strictEqual(await vscode.env.clipboard.readText(), text);
}

async function waitForAssertion(assertion, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            await assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    throw lastError || new Error('Timed out waiting for editor state');
}

async function settleQuickPickCommand(commandPromise, commands) {
    await new Promise(resolve => setTimeout(resolve, 150));
    for (const command of commands) {
        await vscode.commands.executeCommand(command);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = await Promise.race([
        commandPromise,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('Quick Pick command did not settle')),
            2000,
        )),
    ]);
    await new Promise(resolve => setTimeout(resolve, 100));
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await new Promise(resolve => setTimeout(resolve, 50));
    return result;
}

async function settleSuggestionCommand(command, expectSuggestions = true) {
    const devTools = expectSuggestions ? await connectWorkbenchDevTools() : null;
    try {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        if (devTools) {
            await waitForRendererEditorFocus(devTools);
        } else {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (devTools) {
            await dispatchRendererKey(devTools, ' ', 'Space', 32, 2);
            await waitForRendererSuggestionWidget(devTools);
        } else {
            await vscode.commands.executeCommand('editor.action.triggerSuggest');
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        await vscode.commands.executeCommand(command);
        await new Promise(resolve => setTimeout(resolve, 200));
    } finally {
        if (devTools) devTools.close();
    }
}

async function chooseContactPostOption(keywordLine, nextCount) {
    const commandPromise = vscode.commands.executeCommand(
        'extension.lsdynaChooseKeywordOptions',
        keywordLine,
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    await vscode.commands.executeCommand('quickInput.accept');
    await new Promise(resolve => setTimeout(resolve, 100));
    await vscode.commands.executeCommand('quickInput.first');
    for (let index = 0; index < nextCount; index++) {
        await vscode.commands.executeCommand('quickInput.next');
    }
    await vscode.commands.executeCommand('quickInput.accept');
    return Promise.race([
        commandPromise,
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('CONTACT option command did not settle')),
            2000,
        )),
    ]);
}

async function assertInteractiveLatencyBaseline() {
    const workspaceBefore = workspaceSnapshot();
    const measurements = {};
    const {
        document: fixedDocument,
        editor: fixedEditor,
    } = await openFixture('fixed.key');
    const fixedOriginal = fixedDocument.getText();
    const devTools = await connectWorkbenchDevTools();
    const tabSamples = [];
    const typeSamples = [];

    try {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        for (let iteration = 0; iteration < 12; iteration++) {
            if (iteration > 0) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            fixedEditor.selection = new vscode.Selection(2, 0, 2, 0);
            await new Promise(resolve => setTimeout(resolve, 30));
            assert.strictEqual(fixedEditor.selection.active.character, 0);
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            await waitForRendererEditorFocus(devTools);

            let started = performance.now();
            await dispatchRendererKey(devTools, 'Tab', 'Tab', 9);
            await waitForAssertion(() => {
                assert.strictEqual(fixedEditor.selection.start.character, 9);
                assert.strictEqual(fixedEditor.selection.end.character, 24);
            });
            tabSamples.push(performance.now() - started);

            started = performance.now();
            await dispatchRendererKey(devTools, '9', 'Digit9', 57);
            await waitForAssertion(() => {
                assert.strictEqual(fixedDocument.lineAt(2).text.slice(8, 24).trim(), '9');
            });
            typeSamples.push(performance.now() - started);

            await vscode.commands.executeCommand('undo');
            await waitForAssertion(() => {
                assert.strictEqual(fixedDocument.getText(), fixedOriginal);
                assert.strictEqual(fixedDocument.isDirty, false);
            });
        }
    } finally {
        devTools.close();
    }

    measurements.rendererTab = assertLatencyBudget(
        'renderer Tab',
        tabSamples,
        150,
        500,
    );
    measurements.rendererType = assertLatencyBudget(
        'renderer field type',
        typeSamples,
        150,
        500,
    );

    const hoverPosition = new vscode.Position(1, 2);
    await vscode.commands.executeCommand(
        'vscode.executeHoverProvider',
        fixedDocument.uri,
        hoverPosition,
    );
    const hoverSamples = [];
    for (let iteration = 0; iteration < 12; iteration++) {
        const started = performance.now();
        await vscode.commands.executeCommand(
            'vscode.executeHoverProvider',
            fixedDocument.uri,
            hoverPosition,
        );
        hoverSamples.push(performance.now() - started);
    }
    measurements.hoverProvider = assertLatencyBudget(
        'hover provider',
        hoverSamples,
        500,
        1500,
    );

    const {
        document: completionDocument,
    } = await openFixture('completion.key');
    const completionPosition = new vscode.Position(2, 4);
    await vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider',
        completionDocument.uri,
        completionPosition,
    );
    const completionSamples = [];
    for (let iteration = 0; iteration < 12; iteration++) {
        const started = performance.now();
        const completionList = await vscode.commands.executeCommand(
            'vscode.executeCompletionItemProvider',
            completionDocument.uri,
            completionPosition,
        );
        completionSamples.push(performance.now() - started);
        assert.ok(completionList.items.length > 0);
    }
    measurements.completionProvider = assertLatencyBudget(
        'completion provider',
        completionSamples,
        500,
        1500,
    );

    const switchSamples = [];
    for (let iteration = 0; iteration < 12; iteration++) {
        const targetDocument = iteration % 2 === 0
            ? fixedDocument
            : completionDocument;
        const started = performance.now();
        await vscode.window.showTextDocument(targetDocument, {
            preview: false,
            preserveFocus: false,
        });
        await waitForAssertion(() => {
            assert.strictEqual(vscode.window.activeTextEditor.document, targetDocument);
        });
        switchSamples.push(performance.now() - started);
    }
    measurements.smallFileSwitch = assertLatencyBudget(
        'small file switch',
        switchSamples,
        500,
        1500,
    );

    await openFixture('passive.key');
    let started = performance.now();
    await vscode.commands.executeCommand('extension.scanIncludeTree');
    measurements.includeScanColdMs = Number((performance.now() - started).toFixed(1));
    assert.ok(
        measurements.includeScanColdMs <= 5000,
        `cold include scan took ${measurements.includeScanColdMs} ms`,
    );
    const includeScanSamples = [];
    for (let iteration = 0; iteration < 4; iteration++) {
        started = performance.now();
        await vscode.commands.executeCommand('extension.scanIncludeTree');
        includeScanSamples.push(performance.now() - started);
    }
    measurements.includeScanWarm = assertLatencyBudget(
        'warm include scan',
        includeScanSamples,
        3000,
        5000,
    );

    assert.strictEqual(fixedDocument.getText(), fixedOriginal);
    assert.strictEqual(fixedDocument.isDirty, false);
    assert.strictEqual(completionDocument.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    console.log(`Editor safety interactive latency: ${JSON.stringify(measurements)}`);
}

async function assertPassiveOperationsDoNotWrite() {
    const before = workspaceSnapshot();
    const { document, editor } = await openFixture('passive.key');
    assert.strictEqual(document.isDirty, false);

    await vscode.commands.executeCommand(
        'vscode.executeHoverProvider',
        document.uri,
        new vscode.Position(1, 2),
    );
    await vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider',
        document.uri,
        new vscode.Position(2, 0),
    );
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    assert.strictEqual(await document.save(), true);
    assert.strictEqual(document.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), before);
}

async function assertFunctionalHoverMatrix() {
    const before = workspaceSnapshot();
    const { document, editor } = await openFixture('hover-functional.key');
    const parameterCases = [
        { position: new vscode.Position(2, 3), rangeText: 'AB_CD_EF' },
        { position: new vscode.Position(4, 10), rangeText: 'AB_CD_EF' },
        { position: new vscode.Position(6, 5), rangeText: '-&AB_CD_EF' },
    ];
    for (const item of parameterCases) {
        const hover = await executeHover(document, item.position, 'Current-file source definition');
        const markdown = hoverMarkdown(hover);
        assert.ok(markdown.includes('`7`'));
        assert.strictEqual(document.getText(hover.range), item.rangeText);
        assert.ok(!markdown.includes('complete project scan is unavailable'));
    }

    const unresolved = await executeHover(
        document,
        new vscode.Position(7, 5),
        'complete project scan is unavailable',
    );
    assert.strictEqual(document.getText(unresolved.range), '&UNKNOWN');

    const parameterKeyword = await executeHover(
        document,
        new vscode.Position(1, 4),
        'PARAMETER_MUTABLE_NOECHO_LOCAL',
    );
    const parameterKeywordMarkdown = hoverMarkdown(parameterKeyword);
    assert.ok(parameterKeywordMarkdown.includes('PRMR1'));
    assert.ok(parameterKeywordMarkdown.includes('Available Options'));
    assert.ok(parameterKeywordMarkdown.includes('command:extension.selectKeyword'));

    const includeHover = await executeHover(
        document,
        new vscode.Position(9, 4),
        'command:extension.openIncludeNewTab',
    );
    const includeMarkdown = hoverMarkdown(includeHover);
    assert.strictEqual(document.getText(includeHover.range), 'Sub/Part.key');
    assert.ok(includeMarkdown.includes('command:extension.openIncludeSplit'));
    assert.ok(includeMarkdown.includes('command:extension.openIncludeFolder'));

    const missingInclude = await executeHover(
        document,
        new vscode.Position(11, 4),
        '$(symbol-field)',
    );
    const missingIncludeMarkdown = hoverMarkdown(missingInclude);
    assert.ok(missingIncludeMarkdown.includes('FILENAME'));
    assert.ok(!missingIncludeMarkdown.includes('command:extension.openIncludeNewTab'));

    const nodeKeyword = await executeHover(
        document,
        new vscode.Position(12, 2),
        '$(symbol-keyword)',
    );
    const nodeKeywordMarkdown = hoverMarkdown(nodeKeyword);
    assert.ok(nodeKeywordMarkdown.includes('**\\*NODE**'));
    assert.ok(nodeKeywordMarkdown.includes('command:extension.lsdynaFormatSelection'));

    const nodeField = await executeHover(
        document,
        new vscode.Position(13, 2),
        '$(symbol-field)',
    );
    assert.strictEqual(document.getText(nodeField.range).length, 8);
    assert.ok(hoverMarkdown(nodeField).includes('NID'));

    const unknownKeyword = await executeHover(
        document,
        new vscode.Position(14, 4),
        'command:extension.addCustomValidKeyword',
    );
    assert.ok(hoverMarkdown(unknownKeyword).includes('NOT_A_REAL_KEYWORD'));

    const devTools = await connectWorkbenchDevTools();
    try {
        const position = new vscode.Position(6, 5);
        editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await vscode.commands.executeCommand('editor.action.showHover');

        let renderedText = '';
        await waitForAssertion(async () => {
            const response = await devTools.call('Runtime.evaluate', {
                expression: `(() => {
                    const visible = element =>
                        element instanceof HTMLElement && element.offsetParent !== null;
                    const hover = Array.from(document.querySelectorAll('.monaco-hover'))
                        .find(visible);
                    return hover ? String(hover.textContent || '') : '';
                })()`,
                returnByValue: true,
            });
            renderedText = response.result ? String(response.result.value || '') : '';
            assert.ok(renderedText.includes('AB_CD_EF'));
            assert.ok(renderedText.includes('Current-file source definition'));
        }, 3000);
        await dispatchRendererKey(devTools, 'Escape', 'Escape', 27);
    } finally {
        devTools.close();
    }

    assert.strictEqual(document.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), before);
}

async function assertCompletionAcceptCancelIsLocalAndUndoable() {
    const {
        document: otherDocument,
    } = await openFixture('completion-other-condition.key');
    const otherOriginal = otherDocument.getText();
    const { document, editor } = await openFixture('completion.key');
    const original = document.getText();
    const workspaceBefore = workspaceSnapshot();
    const position = new vscode.Position(2, 4);
    editor.selection = new vscode.Selection(position, position);

    const completionList = await vscode.commands.executeCommand(
        'vscode.executeCompletionItemProvider',
        document.uri,
        position,
    );
    assert.ok(
        completionList.items.some(item => {
            const label = typeof item.label === 'string' ? item.label : item.label.label;
            return label === 'Sub/Part.key';
        }),
        'include completion provider did not return the fixture path',
    );

    await settleSuggestionCommand('hideSuggestWidget');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
    assert.strictEqual(otherDocument.getText(), otherOriginal);
    assert.strictEqual(otherDocument.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    editor.selection = new vscode.Selection(position, position);
    await settleSuggestionCommand('acceptSelectedSuggestion');
    await waitForAssertion(() => {
        assert.strictEqual(document.lineAt(2).text, 'Sub/Part.key');
    });
    assert.strictEqual(document.isDirty, true);
    assert.strictEqual(otherDocument.getText(), otherOriginal);
    assert.strictEqual(otherDocument.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    const devTools = await connectWorkbenchDevTools();
    try {
        editor.options = {
            ...editor.options,
            insertSpaces: true,
            tabSize: 4,
        };
        editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand(
            'workbench.action.focusActiveEditorGroup',
        );
        await waitForRendererEditorFocus(devTools);
        await dispatchRendererKey(devTools, ' ', 'Space', 32, 2);
        const widget = await waitForRendererSuggestionWidget(devTools);
        assert.ok(widget.rows.some(row => row.includes('Sub/Part.key')));
        await dispatchRendererKey(devTools, 'Tab', 'Tab', 9);
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(2).text, 'Sub/Part.key');
            assert.strictEqual(document.isDirty, true);
        });
        assert.strictEqual(otherDocument.getText(), otherOriginal);
        assert.strictEqual(otherDocument.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await waitForRendererEditorFocus(devTools);
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
    } finally {
        devTools.close();
    }
}

async function assertCompletionMixedCursorsFailClosed() {
    const { document, editor } = await openFixture('completion-mixed-cursors.key');
    const original = document.getText();
    const workspaceBefore = workspaceSnapshot();
    editor.selections = [
        new vscode.Selection(2, 4, 2, 4),
        new vscode.Selection(3, 19, 3, 19),
    ];

    await settleSuggestionCommand('acceptSelectedSuggestion', false);
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
    assert.strictEqual(editor.selections.length, 2);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    const {
        document: sameKindDocument,
        editor: sameKindEditor,
    } = await openFixture('completion-multi-include.key');
    const sameKindOriginal = sameKindDocument.getText();
    sameKindEditor.options = {
        ...sameKindEditor.options,
        insertSpaces: true,
        tabSize: 4,
    };
    sameKindEditor.selection = new vscode.Selection(2, 4, 2, 4);
    await vscode.commands.executeCommand('editor.action.insertCursorBelow');
    assert.strictEqual(sameKindEditor.selections.length, 2);

    const devTools = await connectWorkbenchDevTools();
    try {
        await vscode.commands.executeCommand(
            'workbench.action.focusActiveEditorGroup',
        );
        await waitForRendererEditorFocus(devTools);
        await dispatchRendererKey(devTools, ' ', 'Space', 32, 2);
        await new Promise(resolve => setTimeout(resolve, 250));
        const suggestionWidget = await getRendererSuggestionWidget(devTools);
        assert.ok(
            suggestionWidget === null || suggestionWidget.rows.length === 0,
            'multi-cursor completion must not expose an acceptable item',
        );

        await dispatchRendererKey(devTools, 'Tab', 'Tab', 9);
        await waitForAssertion(() => {
            assert.strictEqual(sameKindDocument.lineAt(2).text, 'Sub/    ');
            assert.strictEqual(sameKindDocument.lineAt(3).text, 'Sub/    ');
            assert.strictEqual(sameKindEditor.selections.length, 2);
            assert.strictEqual(sameKindDocument.isDirty, true);
        });
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(sameKindDocument.getText(), sameKindOriginal);
            assert.strictEqual(sameKindDocument.isDirty, false);
        });
    } finally {
        devTools.close();
    }
}

async function assertMultiCursorNavigationCommandsFailClosed() {
    const { document, editor } = await openFixture('fixed.key');
    const original = document.getText();
    for (const command of [
        'extension.lsdynaTab',
        'extension.lsdynaShiftTab',
        'extension.lsdynaSelectCell',
    ]) {
        editor.selections = [
            new vscode.Selection(2, 0, 2, 0),
            new vscode.Selection(2, 24, 2, 24),
        ];
        const beforeSelections = editor.selections.map(selectionShape);

        await vscode.commands.executeCommand(command);

        assert.strictEqual(document.getText(), original, command);
        assert.strictEqual(editor.selections.length, 2, command);
        assert.deepStrictEqual(
            editor.selections.map(selectionShape),
            beforeSelections,
            command,
        );
        assert.strictEqual(document.isDirty, false, command);
    }
}

async function assertMultiCursorDeleteCommandsFailClosed() {
    const { document, editor } = await openFixture('fixed.key');
    const original = document.getText();

    for (const command of [
        'extension.lsdynaCellDeleteRight',
        'extension.lsdynaCellDeleteLeft',
    ]) {
        editor.selections = [
            new vscode.Selection(2, 9, 2, 24),
            new vscode.Selection(2, 40, 2, 40),
        ];
        const beforeSelections = editor.selections.map(selectionShape);

        await vscode.commands.executeCommand(command);

        assert.strictEqual(document.getText(), original, command);
        assert.strictEqual(editor.selections.length, 2, command);
        assert.deepStrictEqual(
            editor.selections.map(selectionShape),
            beforeSelections,
            command,
        );
        assert.strictEqual(document.isDirty, false, command);
    }
}

async function assertRendererMultiCursorKeysStayNativeAndUndoable() {
    const workspaceBefore = workspaceSnapshot();
    const devTools = await connectWorkbenchDevTools();

    const focusEditor = async (name, selection) => {
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
        const opened = await openFixture(name, {
            viewColumn: vscode.ViewColumn.One,
        });
        opened.editor.options = {
            ...opened.editor.options,
            insertSpaces: true,
            tabSize: 4,
        };
        opened.editor.selection = selection;
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForAssertion(() => {
            assert.strictEqual(vscode.window.activeTextEditor, opened.editor);
            assert.deepStrictEqual(
                selectionShape(opened.editor.selection),
                selectionShape(selection),
            );
        });
        await waitForRendererEditorFocus(devTools);
        return opened;
    };

    const addCursorBelow = async editor => {
        const source = editor.selection;
        const expectedSelections = [
            source,
            new vscode.Selection(
                source.anchor.translate(1, 0),
                source.active.translate(1, 0),
            ),
        ];
        const sortedShapes = selections => selections
            .map(selectionShape)
            .sort((left, right) =>
                left.anchor[0] - right.anchor[0] ||
                left.anchor[1] - right.anchor[1]
            );
        await vscode.commands.executeCommand('editor.action.insertCursorBelow');
        await waitForAssertion(() => {
            assert.deepStrictEqual(
                sortedShapes(editor.selections),
                sortedShapes(expectedSelections),
            );
        }, 3000);
        await waitForRendererEditorFocus(devTools);
    };

    const undoWithRenderer = async (document, original) => {
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
    };

    try {
        const tabSelection = new vscode.Selection(2, 0, 2, 0);
        const {
            document: tabDocument,
            editor: tabEditor,
        } = await focusEditor('renderer-multi.key', tabSelection);
        const tabOriginal = tabDocument.getText();
        const tabOriginalLines = tabOriginal.split('\r\n');
        assert.strictEqual(tabDocument.eol, vscode.EndOfLine.CRLF);

        await addCursorBelow(tabEditor);
        await dispatchRendererKey(devTools, 'Tab', 'Tab', 9);
        await waitForAssertion(() => {
            assert.strictEqual(
                tabDocument.lineAt(2).text,
                `    ${tabOriginalLines[2]}`,
            );
            assert.strictEqual(
                tabDocument.lineAt(3).text,
                `    ${tabOriginalLines[3]}`,
            );
            assert.strictEqual(tabEditor.selections.length, 2);
            assert.strictEqual(tabDocument.isDirty, true);
        });
        assert.strictEqual(tabDocument.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await undoWithRenderer(tabDocument, tabOriginal);

        const shiftTabSelection = new vscode.Selection(2, 4, 2, 4);
        const {
            document: shiftTabDocument,
            editor: shiftTabEditor,
        } = await focusEditor(
            'renderer-multi-indented.key',
            shiftTabSelection,
        );
        const shiftTabOriginal = shiftTabDocument.getText();
        const shiftTabOriginalLines = shiftTabOriginal.split('\r\n');
        const nativeOutdent = line => {
            const leadingSpaces = line.length - line.trimStart().length;
            const targetIndent = Math.max(
                0,
                Math.floor((leadingSpaces - 1) / 4) * 4,
            );
            return ' '.repeat(targetIndent) + line.slice(leadingSpaces);
        };
        await addCursorBelow(shiftTabEditor);
        await dispatchRendererKey(devTools, 'Tab', 'Tab', 9, 8);
        await waitForAssertion(() => {
            assert.strictEqual(
                shiftTabDocument.lineAt(2).text,
                nativeOutdent(shiftTabOriginalLines[2]),
            );
            assert.strictEqual(
                shiftTabDocument.lineAt(3).text,
                nativeOutdent(shiftTabOriginalLines[3]),
            );
            assert.strictEqual(shiftTabEditor.selections.length, 2);
            assert.strictEqual(shiftTabDocument.isDirty, true);
        });
        assert.strictEqual(shiftTabDocument.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await undoWithRenderer(shiftTabDocument, shiftTabOriginal);

        const {
            editor: deleteEditor,
        } = await focusEditor(
            'renderer-multi.key',
            new vscode.Selection(2, 0, 2, 0),
        );
        deleteEditor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        await addCursorBelow(deleteEditor);
        await dispatchRendererKey(devTools, 'Delete', 'Delete', 46);
        await waitForAssertion(() => {
            for (const line of [2, 3]) {
                assert.strictEqual(
                    tabDocument.lineAt(line).text,
                    tabOriginalLines[line].slice(0, 9) +
                        tabOriginalLines[line].slice(24),
                );
            }
            assert.strictEqual(deleteEditor.selections.length, 2);
            assert.strictEqual(tabDocument.isDirty, true);
        });
        assert.strictEqual(tabDocument.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await undoWithRenderer(tabDocument, tabOriginal);

        deleteEditor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        deleteEditor.selection = new vscode.Selection(2, 24, 2, 24);
        await addCursorBelow(deleteEditor);
        await dispatchRendererKey(devTools, 'Backspace', 'Backspace', 8);
        await waitForAssertion(() => {
            for (const line of [2, 3]) {
                assert.strictEqual(
                    tabDocument.lineAt(line).text,
                    tabOriginalLines[line].slice(0, 23) +
                        tabOriginalLines[line].slice(24),
                );
            }
            assert.strictEqual(deleteEditor.selections.length, 2);
            assert.strictEqual(tabDocument.isDirty, true);
        });
        assert.strictEqual(tabDocument.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await undoWithRenderer(tabDocument, tabOriginal);

        deleteEditor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        const primaryTypeSelection = deleteEditor.selection;
        const secondaryTypeSelection = new vscode.Selection(
            primaryTypeSelection.anchor.translate(1, 0),
            primaryTypeSelection.active.translate(1, 0),
        );
        deleteEditor.selections = [
            primaryTypeSelection,
            secondaryTypeSelection,
        ];
        await vscode.commands.executeCommand('type', { text: 'X' });
        await waitForAssertion(() => {
            for (const line of [2, 3]) {
                assert.strictEqual(
                    tabDocument.lineAt(line).text,
                    tabOriginalLines[line].slice(0, 9) +
                        'X' +
                        tabOriginalLines[line].slice(24),
                );
            }
            assert.strictEqual(deleteEditor.selections.length, 2);
            assert.strictEqual(tabDocument.isDirty, true);
        });
        assert.strictEqual(tabDocument.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await undoWithRenderer(tabDocument, tabOriginal);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        const {
            document: selectCellDocument,
            editor: selectCellEditor,
        } = await focusEditor(
            'renderer-multi.key',
            new vscode.Selection(2, 0, 2, 0),
        );
        const selectCellOriginal = selectCellDocument.getText();
        await dispatchRendererKey(
            devTools,
            'ArrowRight',
            'ArrowRight',
            39,
            9,
        );
        await waitForAssertion(() => {
            assert.deepStrictEqual(
                selectionShape(selectCellEditor.selection),
                selectionShape(new vscode.Selection(2, 8, 2, 0)),
            );
        });
        assert.strictEqual(selectCellDocument.getText(), selectCellOriginal);
        assert.strictEqual(selectCellDocument.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        selectCellEditor.selection = new vscode.Selection(2, 0, 2, 0);
        await addCursorBelow(selectCellEditor);
        const beforeSelectCellMulti = selectCellEditor.selections.map(selectionShape);
        await dispatchRendererKey(
            devTools,
            'ArrowRight',
            'ArrowRight',
            39,
            9,
        );
        await waitForAssertion(() => {
            assert.strictEqual(selectCellEditor.selections.length, 2);
            assert.deepStrictEqual(
                selectCellEditor.selections.map(selectionShape),
                beforeSelectCellMulti,
            );
            assert.strictEqual(selectCellDocument.getText(), selectCellOriginal);
            assert.strictEqual(selectCellDocument.isDirty, false);
        });
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        selectCellEditor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
        devTools.close();
    }
}

async function assertRendererAltClickMultiCursorActionsAreAtomic() {
    const editorConfiguration = vscode.workspace.getConfiguration('editor');
    const originalGlobalModifier = editorConfiguration.inspect('multiCursorModifier')?.globalValue;
    await editorConfiguration.update(
        'multiCursorModifier',
        'alt',
        vscode.ConfigurationTarget.Global,
    );
    let devTools = null;

    try {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        const workspaceBefore = workspaceSnapshot();
        devTools = await connectWorkbenchDevTools();
        const { document, editor } = await openFixture('renderer-multi.key', {
            viewColumn: vscode.ViewColumn.One,
        });
        const original = document.getText();
        const originalLines = original.split('\r\n');
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);

        // A real renderer mouse event with Alt establishes the second caret.
        const secondLinePoint = await getRendererEditorPositionPoint(devTools, 4);
        await dispatchRendererMouseClick(devTools, secondLinePoint, 1);
        const sortedSelectionShapes = selections => selections
            .map(selectionShape)
            .sort((left, right) =>
                left.anchor[0] - right.anchor[0] ||
                left.anchor[1] - right.anchor[1]
            );
        await waitForAssertion(() => {
            assert.deepStrictEqual(
                sortedSelectionShapes(editor.selections),
                sortedSelectionShapes([
                    new vscode.Selection(2, 0, 2, 0),
                    new vscode.Selection(3, 0, 3, 0),
                ]),
            );
        });
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);

        // Select Cell is extension-owned and must fail closed as one operation
        // when the mouse-created multi-cursor state is present.
        const beforeSelectCell = editor.selections.map(selectionShape);
        await dispatchRendererKey(devTools, 'ArrowRight', 'ArrowRight', 39, 9);
        await waitForAssertion(() => {
            assert.deepStrictEqual(
                editor.selections.map(selectionShape),
                beforeSelectCell,
            );
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });

        // Line comment intentionally supports multiple cursors atomically: both
        // lines change, and one renderer Ctrl+Z restores the exact CRLF buffer.
        await dispatchRendererKey(devTools, '/', 'Slash', 191, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(2).text, `$${originalLines[2]}`);
            assert.strictEqual(document.lineAt(3).text, `$${originalLines[3]}`);
            assert.strictEqual(document.isDirty, true);
        });
        assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
        assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        if (devTools) devTools.close();
        await editorConfiguration.update(
            'multiCursorModifier',
            originalGlobalModifier,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertRendererMouseDragSelectionsAreScopedAndUndoable() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const workspaceBefore = workspaceSnapshot();
    let devTools = null;
    try {
        devTools = await connectWorkbenchDevTools();
        const { document, editor } = await openFixture('fixed.key', {
            viewColumn: vscode.ViewColumn.One,
        });
        const original = document.getText();
        const originalLine = document.lineAt(2).text;
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);

        const dragColumns = async (startColumn, endColumn) => {
            const start = await getRendererEditorPositionPoint(
                devTools,
                3,
                startColumn,
            );
            const end = await getRendererEditorPositionPoint(
                devTools,
                3,
                endColumn,
            );
            await dispatchRendererMouseDrag(devTools, start, end);
            await waitForAssertion(() => {
                assert.deepStrictEqual(
                    selectionShape(editor.selection),
                    selectionShape(new vscode.Selection(
                        2,
                        startColumn,
                        2,
                        endColumn,
                    )),
                );
            });
            await new Promise(resolve => setTimeout(resolve, 50));
        };

        // The visible 0.0 value lives wholly inside field 2. Delete must clear
        // those columns without collapsing any later fixed-width field.
        await dragColumns(21, 24);
        await dispatchRendererKey(devTools, 'Delete', 'Delete', 46);
        const afterCellDelete =
            originalLine.slice(0, 21) + '   ' + originalLine.slice(24);
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(2).text, afterCellDelete);
            assert.strictEqual(document.lineAt(2).text.length, originalLine.length);
            assert.strictEqual(document.isDirty, true);
        });
        assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });

        // A cross-field drag is ambiguous for fixed-column protection. Typing
        // stays native and replaces the whole selection, never only one field.
        await dragColumns(20, 26);
        await dispatchRendererKey(devTools, 'X', 'KeyX', 88);
        const afterCrossFieldType =
            originalLine.slice(0, 20) + 'X' + originalLine.slice(26);
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(2).text, afterCrossFieldType);
            assert.strictEqual(document.isDirty, true);
        });
        assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
        assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        if (devTools) devTools.close();
    }
}

async function assertRendererContextMenuPasteAndCutAreScopedAndUndoable() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const workspaceBefore = workspaceSnapshot();
    const originalClipboardText = await vscode.env.clipboard.readText();
    let devTools = null;

    try {
        devTools = await connectWorkbenchDevTools();
        const { document, editor } = await openFixture('fixed.key', {
            viewColumn: vscode.ViewColumn.One,
        });
        const original = document.getText();
        const originalLine = document.lineAt(2).text;
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await writeClipboardText('9.5');
        const selectionRangeShape = selection => ({
            start: [selection.start.line, selection.start.character],
            end: [selection.end.line, selection.end.character],
        });

        // Right-click inside the selected field and click the visible Paste row.
        const pasteSelectionBeforeMenu = selectionRangeShape(editor.selection);
        const pasteClickPoint = await getRendererEditorPositionPoint(devTools, 3, 12);
        await dispatchRendererMouseClick(devTools, pasteClickPoint, 0, 'right');
        const pasteMenuPoint = await waitForRendererMenuItem(devTools, 'Ctrl+V');
        assert.deepStrictEqual(
            selectionRangeShape(editor.selection),
            pasteSelectionBeforeMenu,
        );
        await new Promise(resolve => setTimeout(resolve, 150));
        await dispatchRendererMouseClick(devTools, pasteMenuPoint);
        await new Promise(resolve => setTimeout(resolve, 100));
        if (document.getText() === original) {
            const menuAfterClick = await getRendererMenuItemState(devTools, 'Ctrl+V');
            await captureRendererDiagnostic(devTools, 'context-menu-paste-noop');
            throw new Error(
                'Mouse-clicked Paste remained a no-op: ' + JSON.stringify({
                    pasteMenuPoint,
                    menuAfterClick,
                    selection: selectionShape(editor.selection),
                    clipboard: await vscode.env.clipboard.readText(),
                }),
            );
        }
        await settleCardCellPostEdit(document);
        await waitForAssertion(() => {
            const changedLine = document.lineAt(2).text;
            assert.strictEqual(changedLine.length, originalLine.length);
            assert.strictEqual(changedLine.slice(0, 8), originalLine.slice(0, 8));
            assert.strictEqual(changedLine.slice(8, 24).trim(), '9.5');
            assert.strictEqual(changedLine.slice(24), originalLine.slice(24));
            assert.strictEqual(document.isDirty, true);
        });
        assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });

        // Cut through the visible context menu must preserve the later fields,
        // and one renderer undo must restore the exact pre-Cut buffer.
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        await vscode.commands.executeCommand('type', { text: '1234' });
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(2).text.slice(8, 24).trim(), '1234');
        });
        const beforeCut = document.getText();
        const cutStart = await getRendererEditorPositionPoint(devTools, 3, 21);
        const cutEnd = await getRendererEditorPositionPoint(devTools, 3, 23);
        await dispatchRendererMouseDrag(devTools, cutStart, cutEnd);
        await waitForAssertion(() => {
            assert.deepStrictEqual(
                selectionShape(editor.selection),
                selectionShape(new vscode.Selection(2, 21, 2, 23)),
            );
        });
        const cutSelectionBeforeMenu = selectionRangeShape(editor.selection);
        const cutClickPoint = await getRendererEditorPositionPoint(devTools, 3, 22);
        await dispatchRendererMouseClick(devTools, cutClickPoint, 0, 'right');
        const cutMenuPoint = await waitForRendererMenuItem(devTools, 'Ctrl+X');
        assert.deepStrictEqual(
            selectionRangeShape(editor.selection),
            cutSelectionBeforeMenu,
        );
        await new Promise(resolve => setTimeout(resolve, 150));
        await dispatchRendererMouseClick(devTools, cutMenuPoint);
        await settleCardCellPostEdit(document);
        await waitForAssertion(() => {
            const changedLine = document.lineAt(2).text;
            assert.strictEqual(changedLine.length, originalLine.length);
            assert.strictEqual(changedLine.slice(8, 24).trim(), '14');
            assert.strictEqual(changedLine.slice(24), originalLine.slice(24));
            assert.strictEqual(document.isDirty, true);
        });
        assert.strictEqual(await vscode.env.clipboard.readText(), '23');
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), beforeCut);
            assert.strictEqual(document.isDirty, true);
        });
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
        assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        try {
            if (devTools) {
                try {
                    await dispatchRendererKey(devTools, 'Escape', 'Escape', 27);
                } finally {
                    devTools.close();
                }
            }
        } finally {
            await writeClipboardText(originalClipboardText);
        }
    }
}

async function assertCellDeleteCannotModifyReadonlyDeck() {
    const filesConfiguration = vscode.workspace.getConfiguration('files');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await filesConfiguration.update(
        'readonlyInclude',
        { '**/fixed-readonly.key': true },
        vscode.ConfigurationTarget.Global,
    );

    try {
        const { document, editor } = await openFixture('fixed-readonly.key');
        const original = document.getText();
        const workspaceBefore = workspaceSnapshot();
        for (const command of [
            'extension.lsdynaCellDeleteRight',
            'extension.lsdynaCellDeleteLeft',
        ]) {
            editor.selection = new vscode.Selection(2, 0, 2, 0);
            await vscode.commands.executeCommand('extension.lsdynaTab');
            await vscode.commands.executeCommand(command);
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.strictEqual(document.getText(), original, command);
            assert.strictEqual(document.isDirty, false, command);
        }

        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        await vscode.commands.executeCommand('type', { text: '9' });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.strictEqual(document.getText(), original, 'type');
        assert.strictEqual(document.isDirty, false, 'type');

        const lineEnd = document.lineAt(2).range.end;
        editor.selection = new vscode.Selection(lineEnd, lineEnd);
        await vscode.commands.executeCommand('type', { text: '\n' });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.strictEqual(document.getText(), original, 'Enter');
        assert.strictEqual(document.isDirty, false, 'Enter');
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        await filesConfiguration.update(
            'readonlyInclude',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertCellDeleteAndEnterUseCurrentExternalVersion() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const fixturePath = path.join(workspaceRoot, 'fixed-external-edit.key');
    const originalBytes = fs.readFileSync(fixturePath);
    const { document, editor } = await openFixture('fixed-external-edit.key');
    const original = document.getText();
    const originalLine = document.lineAt(2).text;
    const externalLine = `${'2'.padStart(8, ' ')}${originalLine.slice(8)}`;
    const externalText = original.replace(originalLine, externalLine);

    try {
        fs.writeFileSync(fixturePath, externalText, 'utf8');
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), externalText);
            assert.strictEqual(document.isDirty, false);
        });
        const workspaceAfterExternal = workspaceSnapshot();

        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        await vscode.commands.executeCommand('extension.lsdynaCellDeleteRight');
        const deletedLine = document.lineAt(2).text;
        assert.strictEqual(deletedLine.slice(0, 8).trim(), '2');
        assert.strictEqual(deletedLine.slice(8, 24).trim(), '');
        assert.strictEqual(deletedLine.slice(24), externalLine.slice(24));
        assert.strictEqual(document.isDirty, true);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceAfterExternal);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), externalText);
        assert.strictEqual(document.isDirty, false);

        const lineEnd = document.lineAt(2).range.end;
        editor.selection = new vscode.Selection(lineEnd, lineEnd);
        await vscode.commands.executeCommand('type', { text: '\n' });
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(3).text, '');
        });
        assert.strictEqual(document.isDirty, true);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceAfterExternal);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), externalText);
        assert.strictEqual(document.isDirty, false);
    } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        fs.writeFileSync(fixturePath, originalBytes);
    }
}

async function assertTypeAfterExternalReloadCannotCollapseColumns() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const fixturePath = path.join(workspaceRoot, 'fixed-stale-nav.key');
    const originalBytes = fs.readFileSync(fixturePath);
    const { document, editor } = await openFixture('fixed-stale-nav.key');
    const original = document.getText();
    const originalLine = document.lineAt(2).text;
    const externalLine = `${'2'.padStart(8, ' ')}${originalLine.slice(8)}`;
    const externalText = original.replace(originalLine, externalLine);

    try {
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        fs.writeFileSync(fixturePath, externalText, 'utf8');
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), externalText);
            assert.strictEqual(document.isDirty, false);
        });
        const workspaceAfterExternal = workspaceSnapshot();
        const currentEditor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
            preview: false,
            preserveFocus: false,
        });
        const currentCaret = new vscode.Position(3, 0);
        currentEditor.selection = new vscode.Selection(currentCaret, currentCaret);
        await waitForAssertion(() => {
            assert.strictEqual(vscode.window.activeTextEditor, currentEditor);
            assert.strictEqual(currentEditor.selection.active.line, 3);
            assert.strictEqual(currentEditor.selection.active.character, 0);
        });

        await vscode.commands.executeCommand('type', { text: '9' });
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(3).text, '9*END');
        });
        assert.strictEqual(document.lineAt(2).text, externalLine);
        assert.strictEqual(document.isDirty, true);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceAfterExternal);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), externalText);
        assert.strictEqual(document.isDirty, false);
    } finally {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        fs.writeFileSync(fixturePath, originalBytes);
    }
}

async function assertCellDeleteAndBackspaceAreLocalAndUndoable() {
    const { document, editor } = await openFixture('fixed.key');
    const original = document.getText();
    const originalLine = document.lineAt(2).text;

    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await vscode.commands.executeCommand('extension.lsdynaCellDeleteRight');

    let changedLine = document.lineAt(2).text;
    assert.strictEqual(changedLine.slice(0, 8), originalLine.slice(0, 8));
    assert.strictEqual(changedLine.slice(8, 24).trim(), '');
    assert.strictEqual(changedLine.slice(24), originalLine.slice(24));

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await vscode.commands.executeCommand('type', { text: '1234' });
    const beforeBackspace = document.getText();
    await vscode.commands.executeCommand('extension.lsdynaCellDeleteLeft');

    changedLine = document.lineAt(2).text;
    assert.strictEqual(changedLine.slice(8, 24).trim(), '123');
    assert.strictEqual(changedLine.slice(24), originalLine.slice(24));

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), beforeBackspace);
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertEmptyCellBackspaceMovesWithoutWriting() {
    const { document, editor } = await openFixture('fixed-empty-field.key');
    const original = document.getText();

    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    assert.strictEqual(editor.selection.start.character, 9);
    assert.strictEqual(editor.selection.end.character, 24);

    await vscode.commands.executeCommand('extension.lsdynaCellDeleteLeft');

    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
    assert.strictEqual(editor.selection.start.character, 0);
    assert.strictEqual(editor.selection.end.character, 8);
}

async function assertSecondDeleteRemovesNowEmptyCardRow() {
    for (const command of [
        'extension.lsdynaCellDeleteRight',
        'extension.lsdynaCellDeleteLeft',
    ]) {
        const { document, editor } = await openFixture('empty-row.key');
        const original = document.getText();
        editor.selection = new vscode.Selection(2, 0, 2, 8);

        await vscode.commands.executeCommand(command);
        const emptyRowText = document.getText();
        assert.strictEqual(document.lineCount, 5, command);
        assert.strictEqual(document.lineAt(2).text.trim(), '', command);

        await vscode.commands.executeCommand(command);
        assert.strictEqual(document.lineCount, 4, command);
        assert.strictEqual(document.lineAt(2).text, '*END', command);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), emptyRowText, command);
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original, command);
        assert.strictEqual(document.isDirty, false, command);
    }
}

async function assertCommaDeleteUsesNativeUndoableEditing() {
    const { document, editor } = await openFixture('comma.key');
    const original = document.getText();

    for (const [command, caret] of [
        ['extension.lsdynaCellDeleteLeft', 3],
        ['extension.lsdynaCellDeleteRight', 2],
    ]) {
        editor.selection = new vscode.Selection(2, caret, 2, caret);
        await vscode.commands.executeCommand(command);
        assert.notStrictEqual(document.getText(), original, command);
        assert.ok(document.lineAt(2).text.includes(','), command);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original, command);
        assert.strictEqual(document.isDirty, false, command);
    }
}

async function assertEnterIsAtomicAndUndoable() {
    for (const [name, expectedEol] of [
        ['enter-lf.key', vscode.EndOfLine.LF],
        ['enter-crlf.key', vscode.EndOfLine.CRLF],
    ]) {
        const { document, editor } = await openFixture(name);
        const original = document.getText();
        const observedChanges = [];
        const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document === document) {
                observedChanges.push(event.contentChanges.map(change => change.text));
            }
        });
        assert.strictEqual(document.eol, expectedEol, name);
        editor.selection = new vscode.Selection(2, 8, 2, 8);

        try {
            await vscode.commands.executeCommand('type', { text: '\n' });
            await waitForAssertion(() => {
                assert.strictEqual(document.lineAt(3).text, '', name);
            });
        } finally {
            changeSubscription.dispose();
        }
        assert.ok(
            observedChanges.some(changes =>
                changes.some(text => /^\r?\n[ \t]+$/.test(text))),
            `${name}: VS Code did not emit an auto-indented line break`,
        );
        assert.strictEqual(document.eol, expectedEol, name);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original, name);
        assert.strictEqual(document.isDirty, false, name);

        editor.selection = new vscode.Selection(2, 8, 2, 8);
        await vscode.commands.executeCommand('type', { text: '\n' });
        await vscode.commands.executeCommand('type', { text: 'X' });
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(3).text, 'X', name);
        });

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.lineAt(3).text, '', `${name}: first rapid undo`);
        assert.notStrictEqual(document.getText(), original, `${name}: first rapid undo`);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original, `${name}: second rapid undo`);
        assert.strictEqual(document.isDirty, false, name);
    }

    const { document, editor } = await openFixture('enter-multi.key');
    const original = document.getText();
    const observedChanges = [];
    const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document === document) {
            observedChanges.push(event.contentChanges.map(change => change.text));
        }
    });
    editor.selections = [
        new vscode.Selection(2, 8, 2, 8),
        new vscode.Selection(3, 8, 3, 8),
    ];

    try {
        await vscode.commands.executeCommand('type', { text: '\n' });
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(3).text, '');
            assert.strictEqual(document.lineAt(5).text, '');
        });
    } finally {
        changeSubscription.dispose();
    }
    assert.ok(
        observedChanges.some(changes =>
            changes.length === 2 &&
            changes.every(text => /^\r?\n[ \t]+$/.test(text))),
        'multi-cursor Enter did not emit one complete auto-indented change batch',
    );
    assert.strictEqual(editor.selections.length, 2);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertKeywordTitleOptionIsTransactional() {
    const { document, editor } = await openFixture('option-title.key');
    const original = document.getText();
    const otherFilesBefore = workspaceSnapshot();
    editor.selection = new vscode.Selection(1, 0, 1, 0);

    let commandPromise = vscode.commands.executeCommand(
        'extension.lsdynaChooseKeywordOptions',
        1,
    );
    await settleQuickPickCommand(commandPromise, ['quickInput.hide']);
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), otherFilesBefore);

    commandPromise = vscode.commands.executeCommand(
        'extension.lsdynaChooseKeywordOptions',
        1,
    );
    await settleQuickPickCommand(commandPromise, [
        'quickInput.first',
        'quickInput.toggleCheckbox',
        'quickInput.accept',
    ]);
    assert.strictEqual(document.lineAt(1).text, '*MAT_001_TITLE');
    assert.strictEqual(document.lineAt(2).text.trim(), '$# title');
    assert.strictEqual(document.lineAt(3).text, '');
    assert.strictEqual(document.lineAt(4).text, '       1');

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    commandPromise = vscode.commands.executeCommand(
        'extension.lsdynaChooseKeywordOptions',
        1,
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    await editor.edit(editBuilder => {
        editBuilder.insert(new vscode.Position(0, 0), '$ concurrent engineer edit\r\n');
    });
    const afterConcurrentEdit = document.getText();
    await settleQuickPickCommand(commandPromise, [
        'quickInput.first',
        'quickInput.toggleCheckbox',
        'quickInput.accept',
    ]);

    assert.strictEqual(document.getText(), afterConcurrentEdit);
    const devTools = await connectWorkbenchDevTools();
    try {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
    } finally {
        devTools.close();
    }
    await waitForAssertion(() => {
        assert.strictEqual(document.getText(), original);
    });
    assert.strictEqual(document.isDirty, false);
}

async function assertKeywordOptionsCannotModifyReadonlyDeck() {
    const filesConfiguration = vscode.workspace.getConfiguration('files');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await filesConfiguration.update(
        'readonlyInclude',
        { '**/option-title-readonly.key': true },
        vscode.ConfigurationTarget.Global,
    );

    try {
        const { document, editor } = await openFixture('option-title-readonly.key');
        const original = document.getText();
        const workspaceBefore = workspaceSnapshot();
        editor.selection = new vscode.Selection(1, 0, 1, 0);
        const commandPromise = vscode.commands.executeCommand(
            'extension.lsdynaChooseKeywordOptions',
            1,
        );
        await settleQuickPickCommand(commandPromise, [
            'quickInput.first',
            'quickInput.toggleCheckbox',
            'quickInput.accept',
        ]);

        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        await filesConfiguration.update(
            'readonlyInclude',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertKeywordOptionPickerSwitchIsNoOp() {
    const { document, editor } = await openFixture('option-title.key');
    const original = document.getText();
    const workspaceBefore = workspaceSnapshot();
    editor.selection = new vscode.Selection(1, 0, 1, 0);

    const commandPromise = vscode.commands.executeCommand(
        'extension.lsdynaChooseKeywordOptions',
        1,
    );
    await new Promise(resolve => setTimeout(resolve, 100));

    const { document: otherDocument, editor: otherEditor } = await openFixture(
        'option-title-other-condition.key',
    );
    const otherOriginal = otherDocument.getText();
    await settleQuickPickCommand(commandPromise, [
        'quickInput.first',
        'quickInput.toggleCheckbox',
        'quickInput.accept',
    ]);

    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
    assert.strictEqual(otherDocument.getText(), otherOriginal);
    assert.strictEqual(otherDocument.isDirty, false);
    assert.strictEqual(vscode.window.activeTextEditor, otherEditor);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
}

async function assertContactOptionsDoNotDuplicateOrRemoveComments() {
    const { document, editor } = await openFixture('option-contact.key');
    const original = document.getText();
    const otherFilesBefore = workspaceSnapshot();
    editor.selection = new vscode.Selection(1, 0, 1, 0);

    await chooseContactPostOption(1, 6);
    const withAThroughF = document.getText();
    assert.strictEqual(document.lineCount, 20);
    assert.strictEqual(document.lineAt(5).text, '$ engineer comment must stay');
    assert.strictEqual(
        document.lineAt(6).text,
        '$#    soft    sofscl    lcidab    maxpar     sbopt     depth     bsort    frcfrq',
    );
    assert.strictEqual(
        document.lineAt(16).text,
        '$#  pstiff   ignroff               fstol    2dbinr    ssftyp     swtpr    tetfac',
    );
    assert.strictEqual(document.lineAt(18).text, '*END');
    assert.deepStrictEqual(workspaceSnapshot(), otherFilesBefore);

    const versionAfterAdd = document.version;
    await chooseContactPostOption(1, 6);
    assert.strictEqual(document.getText(), withAThroughF);
    assert.strictEqual(document.version, versionAfterAdd);

    await chooseContactPostOption(1, 3);
    assert.strictEqual(document.lineCount, 14);
    assert.strictEqual(document.lineAt(5).text, '$ engineer comment must stay');
    assert.strictEqual(
        document.lineAt(10).text,
        '$#    igap    ignore    dprfac    dtstif     edgek              flangl   cid_rcf',
    );
    assert.strictEqual(document.lineAt(12).text, '*END');

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), withAThroughF);
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertParameterRenameIsDocumentLocalAndUndoable() {
    const { document, editor } = await openFixture('rename.key');
    const original = document.getText();
    const otherPath = path.join(workspaceRoot, 'rename-other-version.key');
    const otherBytes = fs.readFileSync(otherPath);
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    editor.selection = new vscode.Selection(2, 3, 2, 3);

    const edit = await vscode.commands.executeCommand(
        'vscode.executeDocumentRenameProvider',
        document.uri,
        new vscode.Position(2, 3),
        'finish',
    );
    assert.ok(edit);
    const entries = edit.entries();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0][0].toString(), document.uri.toString());
    assert.strictEqual(entries[0][1].length, 3);

    assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
    assert.strictEqual(document.lineAt(2).text, 'R finish 1.0');
    assert.strictEqual(document.lineAt(4).text, 'R dtplot finish/100.0');
    assert.strictEqual(document.lineAt(6).text, '&finish');
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    assert.deepStrictEqual(fs.readFileSync(otherPath), otherBytes);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    assert.strictEqual(document.isDirty, false);
    assert.deepStrictEqual(fs.readFileSync(otherPath), otherBytes);

    for (const invalidName of ['2finish', 'pi', 'curve', 'Int', 'abort', 'xdr_int']) {
        await assert.rejects(
            vscode.commands.executeCommand(
                'vscode.executeDocumentRenameProvider',
                document.uri,
                new vscode.Position(2, 3),
                invalidName,
            ),
            /parameter name/i,
        );
    }
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
    assert.deepStrictEqual(fs.readFileSync(otherPath), otherBytes);
}

async function assertParameterRenameRendererCancelAndAcceptAreScoped() {
    const editorConfiguration = vscode.workspace.getConfiguration('editor');
    await editorConfiguration.update(
        'rename.enablePreview',
        true,
        vscode.ConfigurationTarget.Global,
    );
    const {
        document: otherDocument,
    } = await openFixture('rename-other-version.key', {
        viewColumn: vscode.ViewColumn.Two,
    });
    const otherOriginal = otherDocument.getText();
    const { document } = await openFixture('rename.key', {
        viewColumn: vscode.ViewColumn.One,
    });
    const original = document.getText();
    const originalEol = document.eol;
    const workspaceBefore = workspaceSnapshot();
    const devTools = await connectWorkbenchDevTools();

    const prepareRenameWidget = async newName => {
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
        const currentEditor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
            preview: false,
            preserveFocus: false,
        });
        currentEditor.selection = new vscode.Selection(2, 3, 2, 3);
        await waitForAssertion(() => {
            assert.strictEqual(vscode.window.activeTextEditor, currentEditor);
            assert.strictEqual(currentEditor.selection.active.line, 2);
            assert.strictEqual(currentEditor.selection.active.character, 3);
        });

        const renameCommand = vscode.commands.executeCommand('editor.action.rename');
        const initialInput = await waitForRendererInput(devTools);
        assert.strictEqual(initialInput.value, 'endtime');
        await dispatchRendererKey(devTools, 'a', 'KeyA', 65, 2);
        await devTools.call('Input.insertText', { text: newName });
        await waitForRendererInput(devTools, newName);
        assert.strictEqual(document.getText(), original);
        // An async function assimilates a returned promise. Wrap the command so
        // callers can dismiss/accept the widget before awaiting its completion.
        return { renameCommand };
    };

    const waitForRenameCommand = (renameCommand, finalAction) => {
        return withTimeout(
            renameCommand,
            3000,
            `Rename widget did not settle after ${finalAction}`,
        );
    };

    const waitForPreview = async () => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            const response = await devTools.call('Runtime.evaluate', {
                expression: `Array.from(document.querySelectorAll('.bulk-edit-panel'))
                    .some(element => element.offsetParent !== null)`,
                returnByValue: true,
            });
            if (response.result && response.result.value === true) return;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        const diagnostic = await captureRendererDiagnostic(
            devTools,
            'rename-preview-after-ctrl-enter',
        );
        throw new Error(
            `Rename preview did not become visible: ${JSON.stringify(diagnostic)}`,
        );
    };

    const settleRenameWidget = async (newName, finalKey) => {
        const { renameCommand } = await prepareRenameWidget(newName);
        await dispatchRendererKey(
            devTools,
            finalKey,
            finalKey,
            finalKey === 'Escape' ? 27 : 13,
        );
        await waitForRenameCommand(renameCommand, finalKey);
        await new Promise(resolve => setTimeout(resolve, 100));
    };

    try {
        await settleRenameWidget('cancelled', 'Escape');
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.strictEqual(document.eol, originalEol);
        assert.strictEqual(otherDocument.getText(), otherOriginal);
        assert.strictEqual(otherDocument.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        const { renameCommand: previewRenameCommand } =
            await prepareRenameWidget('previewed');
        await dispatchRendererKey(devTools, 'Enter', 'Enter', 13, 2);
        await waitForPreview();
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.strictEqual(otherDocument.getText(), otherOriginal);
        assert.strictEqual(otherDocument.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        const discardCommand = vscode.commands.executeCommand('refactorPreview.discard');
        await withTimeout(
            Promise.all([discardCommand, previewRenameCommand]),
            5000,
            'Rename preview discard did not settle',
        );
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        await settleRenameWidget('finish', 'Enter');
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(2).text, 'R finish 1.0');
            assert.strictEqual(document.lineAt(4).text, 'R dtplot finish/100.0');
            assert.strictEqual(document.lineAt(6).text, '&finish');
        });
        assert.strictEqual(document.isDirty, true);
        assert.strictEqual(document.eol, originalEol);
        assert.strictEqual(otherDocument.getText(), otherOriginal);
        assert.strictEqual(otherDocument.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.strictEqual(document.eol, originalEol);
        assert.strictEqual(otherDocument.getText(), otherOriginal);
        assert.strictEqual(otherDocument.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        devTools.close();
        await editorConfiguration.update(
            'rename.enablePreview',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertIncludeCaseQuickFixIsLocalAndUndoable() {
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    await configuration.update(
        'include.pathCaseCheck',
        'strict',
        vscode.ConfigurationTarget.Global,
    );
    try {
        const { document, editor } = await openFixture('include-case.key');
        const original = document.getText();
        const workspaceBefore = workspaceSnapshot();
        editor.selection = new vscode.Selection(2, 2, 2, 2);

        await waitForAssertion(() => {
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            assert.ok(diagnostics.some(item => item.code === 'include-path-case-mismatch'));
        }, 3000);

        await vscode.commands.executeCommand('editor.action.codeAction', {
            kind: vscode.CodeActionKind.QuickFix.value,
            apply: 'first',
            preferred: true,
        });
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(2).text, 'Sub/Part.key');
        });
        assert.strictEqual(document.lineAt(0).text, '*KEYWORD');
        assert.strictEqual(document.lineAt(1).text, '*INCLUDE');
        assert.strictEqual(document.lineAt(3).text, '*END');
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        const {
            document: continuedDocument,
            editor: continuedEditor,
        } = await openFixture('include-case-continued.key');
        const continuedOriginal = continuedDocument.getText();
        continuedEditor.selection = new vscode.Selection(2, 2, 2, 2);
        assert.strictEqual(continuedDocument.eol, vscode.EndOfLine.CRLF);
        await waitForAssertion(() => {
            const diagnostics = vscode.languages.getDiagnostics(continuedDocument.uri);
            assert.ok(diagnostics.some(item => item.code === 'include-path-case-mismatch'));
        }, 3000);

        await vscode.commands.executeCommand('editor.action.codeAction', {
            kind: vscode.CodeActionKind.QuickFix.value,
            apply: 'first',
            preferred: true,
        });
        await waitForAssertion(() => {
            assert.strictEqual(continuedDocument.lineAt(2).text, 'Sub/ +');
            assert.strictEqual(continuedDocument.lineAt(3).text, 'Part.key');
        });
        assert.strictEqual(continuedDocument.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(continuedDocument.getText(), continuedOriginal);
        assert.strictEqual(continuedDocument.isDirty, false);
        assert.strictEqual(continuedDocument.eol, vscode.EndOfLine.CRLF);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        await configuration.update(
            'include.pathCaseCheck',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertIncludeCaseQuickFixMouseClickIsLocalAndUndoable() {
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    const originalGlobalMode = configuration.inspect('include.pathCaseCheck')?.globalValue;
    await configuration.update(
        'include.pathCaseCheck',
        'strict',
        vscode.ConfigurationTarget.Global,
    );
    let devTools = null;
    try {
        devTools = await connectWorkbenchDevTools();
        const { document, editor } = await openFixture('include-case.key');
        const original = document.getText();
        const workspaceBefore = workspaceSnapshot();
        editor.selection = new vscode.Selection(2, 2, 2, 2);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await waitForAssertion(() => {
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            assert.ok(diagnostics.some(item => item.code === 'include-path-case-mismatch'));
        }, 3000);

        const actionMenu = vscode.commands.executeCommand('editor.action.codeAction', {
            kind: vscode.CodeActionKind.QuickFix.value,
            apply: 'never',
            preferred: true,
        });
        const widget = await waitForRendererActionWidget(devTools);
        assert.strictEqual(widget.rows.length, 1);
        const actionPoint = await getRendererVisibleElementCenter(
            devTools,
            '.action-widget .monaco-list-row.action',
        );
        assert.strictEqual(actionPoint.text, widget.rows[0]);
        await dispatchRendererMouseClick(devTools, actionPoint);
        await withTimeout(actionMenu, 3000, 'Mouse-clicked Code Action did not settle');

        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(2).text, 'Sub/Part.key');
            assert.strictEqual(document.isDirty, true);
        });
        assert.strictEqual(document.lineAt(0).text, '*KEYWORD');
        assert.strictEqual(document.lineAt(1).text, '*INCLUDE');
        assert.strictEqual(document.lineAt(3).text, '*END');
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        try {
            await vscode.commands.executeCommand('hideCodeActionWidget');
        } finally {
            if (devTools) devTools.close();
            await configuration.update(
                'include.pathCaseCheck',
                originalGlobalMode,
                vscode.ConfigurationTarget.Global,
            );
        }
    }
}

async function assertStaleIncludeCaseQuickFixFailsClosed() {
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    await configuration.update(
        'include.pathCaseCheck',
        'strict',
        vscode.ConfigurationTarget.Global,
    );
    const targetPath = path.join(workspaceRoot, 'Sub', 'Part.key');
    const movedPath = path.join(workspaceRoot, 'Sub', 'Part-moved.key');
    let moved = false;
    try {
        const { document, editor } = await openFixture('include-case.key');
        const original = document.getText();
        editor.selection = new vscode.Selection(2, 2, 2, 2);

        await waitForAssertion(() => {
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            assert.ok(diagnostics.some(item => item.code === 'include-path-case-mismatch'));
        }, 3000);

        fs.renameSync(targetPath, movedPath);
        moved = true;
        assert.ok(
            vscode.languages.getDiagnostics(document.uri)
                .some(item => item.code === 'include-path-case-mismatch'),
            'the test requires the previously published diagnostic to remain observable',
        );

        await vscode.commands.executeCommand('editor.action.codeAction', {
            kind: vscode.CodeActionKind.QuickFix.value,
            apply: 'first',
            preferred: true,
        });
        await new Promise(resolve => setTimeout(resolve, 100));

        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    } finally {
        const active = vscode.window.activeTextEditor;
        if (active?.document?.isDirty) {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        if (moved && fs.existsSync(movedPath)) {
            fs.renameSync(movedPath, targetPath);
        }
        await configuration.update(
            'include.pathCaseCheck',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertIncludeCaseQuickFixCancelIsNoOp() {
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    await configuration.update(
        'include.pathCaseCheck',
        'strict',
        vscode.ConfigurationTarget.Global,
    );
    try {
        const { document, editor } = await openFixture('include-case.key');
        const original = document.getText();
        const workspaceBefore = workspaceSnapshot();
        editor.selection = new vscode.Selection(2, 2, 2, 2);
        await waitForAssertion(() => {
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            assert.ok(diagnostics.some(item => item.code === 'include-path-case-mismatch'));
        }, 3000);

        const actionMenu = vscode.commands.executeCommand('editor.action.codeAction', {
            kind: vscode.CodeActionKind.QuickFix.value,
            apply: 'never',
            preferred: true,
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        await vscode.commands.executeCommand('hideCodeActionWidget');
        await actionMenu;

        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        await vscode.commands.executeCommand('hideCodeActionWidget');
        await configuration.update(
            'include.pathCaseCheck',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertIncludeCaseQuickFixPreviewIsNonMutating() {
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    await configuration.update(
        'include.pathCaseCheck',
        'strict',
        vscode.ConfigurationTarget.Global,
    );
    try {
        const { document, editor } = await openFixture('include-case.key');
        const original = document.getText();
        const workspaceBefore = workspaceSnapshot();
        editor.selection = new vscode.Selection(2, 2, 2, 2);
        await waitForAssertion(() => {
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            assert.ok(diagnostics.some(item => item.code === 'include-path-case-mismatch'));
        }, 3000);

        const actionMenu = vscode.commands.executeCommand('editor.action.codeAction', {
            kind: vscode.CodeActionKind.QuickFix.value,
            apply: 'never',
            preferred: true,
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        await vscode.commands.executeCommand('previewSelectedCodeAction');
        await actionMenu;
        await new Promise(resolve => setTimeout(resolve, 200));

        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await vscode.commands.executeCommand('refactorPreview.discard');
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    } finally {
        await vscode.commands.executeCommand('hideCodeActionWidget');
        await vscode.commands.executeCommand('refactorPreview.discard');
        await configuration.update(
            'include.pathCaseCheck',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertIncludeCaseActionRevalidatesAfterMenuWait() {
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    await configuration.update(
        'include.pathCaseCheck',
        'strict',
        vscode.ConfigurationTarget.Global,
    );
    const targetPath = path.join(workspaceRoot, 'Sub', 'Part.key');
    const movedPath = path.join(workspaceRoot, 'Sub', 'Part-menu-moved.key');
    let moved = false;
    let devTools = null;
    try {
        devTools = await connectWorkbenchDevTools();
        const { document, editor } = await openFixture('include-case.key');
        const original = document.getText();
        editor.selection = new vscode.Selection(2, 2, 2, 2);
        await waitForAssertion(() => {
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            assert.ok(diagnostics.some(item => item.code === 'include-path-case-mismatch'));
        }, 3000);

        const actionMenu = vscode.commands.executeCommand('editor.action.codeAction', {
            kind: vscode.CodeActionKind.QuickFix.value,
            apply: 'never',
            preferred: true,
        });
        await waitForRendererActionWidget(devTools);
        fs.renameSync(targetPath, movedPath);
        moved = true;
        await dispatchRendererKey(devTools, 'Enter', 'Enter', 13);
        await actionMenu;
        await new Promise(resolve => setTimeout(resolve, 100));

        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    } finally {
        await vscode.commands.executeCommand('hideCodeActionWidget');
        const active = vscode.window.activeTextEditor;
        if (active?.document?.isDirty) {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        if (moved && fs.existsSync(movedPath)) {
            fs.renameSync(movedPath, targetPath);
        }
        if (devTools) devTools.close();
        await configuration.update(
            'include.pathCaseCheck',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertIncludeCaseActionRevalidatesAfterCaseOnlyRename() {
    if (process.platform !== 'win32') return;

    const configuration = vscode.workspace.getConfiguration('lsdyna');
    await configuration.update(
        'include.pathCaseCheck',
        'strict',
        vscode.ConfigurationTarget.Global,
    );
    const targetPath = path.join(workspaceRoot, 'CaseOnly', 'Part.key');
    const casePath = path.join(workspaceRoot, 'CaseOnly', 'PART.key');
    const temporaryPath = path.join(
        workspaceRoot,
        'CaseOnly',
        'Part-case-rename-temporary.key',
    );
    let caseRenamed = false;
    let devTools = null;
    try {
        devTools = await connectWorkbenchDevTools();
        const { document, editor } = await openFixture('include-case-only.key');
        const original = document.getText();
        editor.selection = new vscode.Selection(2, 2, 2, 2);
        await waitForAssertion(() => {
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            assert.ok(diagnostics.some(
                item => item.code === 'include-path-case-mismatch',
            ));
        }, 3000);

        const actionMenu = vscode.commands.executeCommand(
            'editor.action.codeAction',
            {
                kind: vscode.CodeActionKind.QuickFix.value,
                apply: 'never',
                preferred: true,
            },
        );
        await waitForRendererActionWidget(devTools);

        fs.renameSync(targetPath, temporaryPath);
        fs.renameSync(temporaryPath, casePath);
        caseRenamed = true;
        assert.strictEqual(
            path.basename(fs.realpathSync.native(casePath)),
            'PART.key',
            'the test requires the on-disk filename casing to change',
        );
        await dispatchRendererKey(devTools, 'Enter', 'Enter', 13);
        await actionMenu;
        await new Promise(resolve => setTimeout(resolve, 100));

        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    } finally {
        await vscode.commands.executeCommand('hideCodeActionWidget');
        const active = vscode.window.activeTextEditor;
        if (active?.document?.isDirty) {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        if (caseRenamed && fs.existsSync(casePath)) {
            fs.renameSync(casePath, temporaryPath);
            fs.renameSync(temporaryPath, targetPath);
        } else if (fs.existsSync(temporaryPath)) {
            fs.renameSync(temporaryPath, targetPath);
        }
        if (devTools) devTools.close();
        await configuration.update(
            'include.pathCaseCheck',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertIncludeCaseQuickFixCannotModifyReadonlyDeck() {
    const lsdynaConfiguration = vscode.workspace.getConfiguration('lsdyna');
    const filesConfiguration = vscode.workspace.getConfiguration('files');
    await lsdynaConfiguration.update(
        'include.pathCaseCheck',
        'strict',
        vscode.ConfigurationTarget.Global,
    );
    await filesConfiguration.update(
        'readonlyInclude',
        { '**/include-case-readonly.key': true },
        vscode.ConfigurationTarget.Global,
    );
    try {
        const { document, editor } = await openFixture('include-case-readonly.key');
        const original = document.getText();
        const workspaceBefore = workspaceSnapshot();
        editor.selection = new vscode.Selection(2, 2, 2, 2);
        await waitForAssertion(() => {
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            assert.ok(diagnostics.some(item => item.code === 'include-path-case-mismatch'));
        }, 3000);

        await vscode.commands.executeCommand('editor.action.codeAction', {
            kind: vscode.CodeActionKind.QuickFix.value,
            apply: 'first',
            preferred: true,
        });
        await new Promise(resolve => setTimeout(resolve, 100));

        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        const active = vscode.window.activeTextEditor;
        if (active?.document?.isDirty) {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        await filesConfiguration.update(
            'readonlyInclude',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
        await lsdynaConfiguration.update(
            'include.pathCaseCheck',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertIncludeCaseActionDoesNotOverwriteMenuTimeEdit() {
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    await configuration.update(
        'include.pathCaseCheck',
        'strict',
        vscode.ConfigurationTarget.Global,
    );
    try {
        const { document, editor } = await openFixture('include-case.key');
        const original = document.getText();
        const workspaceBefore = workspaceSnapshot();
        editor.selection = new vscode.Selection(2, 2, 2, 2);
        await waitForAssertion(() => {
            const diagnostics = vscode.languages.getDiagnostics(document.uri);
            assert.ok(diagnostics.some(item => item.code === 'include-path-case-mismatch'));
        }, 3000);

        const actionMenu = vscode.commands.executeCommand('editor.action.codeAction', {
            kind: vscode.CodeActionKind.QuickFix.value,
            apply: 'never',
            preferred: true,
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.strictEqual(await editor.edit(editBuilder => {
            editBuilder.replace(document.lineAt(2).range, 'other/part.key');
        }), true);
        await vscode.commands.executeCommand('acceptSelectedCodeAction');
        await actionMenu;
        await new Promise(resolve => setTimeout(resolve, 100));

        assert.strictEqual(document.lineAt(2).text, 'other/part.key');
        assert.strictEqual(document.isDirty, true);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    } finally {
        await vscode.commands.executeCommand('hideCodeActionWidget');
        const active = vscode.window.activeTextEditor;
        if (active?.document?.isDirty) {
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
        await configuration.update(
            'include.pathCaseCheck',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertCellTypeIsLocalAndUndoable() {
    const { document, editor } = await openFixture('fixed.key');
    const original = document.getText();
    const originalLine = document.lineAt(2).text;
    editor.selection = new vscode.Selection(2, 0, 2, 0);

    await vscode.commands.executeCommand('extension.lsdynaTab');
    assert.strictEqual(editor.selection.start.character, 9);
    assert.strictEqual(editor.selection.end.character, 24);

    await vscode.commands.executeCommand('type', { text: '9.5' });
    const changedLine = document.lineAt(2).text;
    assert.strictEqual(changedLine.slice(0, 8), originalLine.slice(0, 8));
    assert.strictEqual(changedLine.slice(8, 24).trim(), '9.5');
    assert.strictEqual(changedLine.slice(24), originalLine.slice(24));

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertCommaTabKeepsFreeFormatAndUndo() {
    const { document, editor } = await openFixture('comma.key');
    const original = document.getText();
    editor.selection = new vscode.Selection(2, 0, 2, 0);

    await vscode.commands.executeCommand('extension.lsdynaTab');
    assert.ok(document.lineAt(2).text.includes('1,2.0,-3.0,4.0'));
    assert.ok(document.lineAt(2).text.includes(','));

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertOverWidthTypeIsRejectedAtomically() {
    const { document, editor } = await openFixture('fixed.key');
    const original = document.getText();
    editor.selection = new vscode.Selection(2, 0, 2, 0);

    await vscode.commands.executeCommand('extension.lsdynaTab');
    await vscode.commands.executeCommand('type', { text: '12345678901234567' });

    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertFormatOnSaveScopeAndUndo() {
    const configuration = vscode.workspace.getConfiguration('editor');
    const otherFilesBefore = workspaceSnapshot();
    await configuration.update(
        'formatOnSave',
        true,
        vscode.ConfigurationTarget.Global,
    );

    try {
        const { document, editor } = await openFixture('format-on-save.key');
        const cleanBytes = fs.readFileSync(document.uri.fsPath);
        assert.strictEqual(await document.save(), true);
        assert.deepStrictEqual(fs.readFileSync(document.uri.fsPath), cleanBytes);

        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(1, 0), '$ engineer edit\n');
        });
        const beforeSaveText = document.getText();
        assert.strictEqual(document.isDirty, true);

        assert.strictEqual(await document.save(), true);
        assert.strictEqual(document.isDirty, false);
        assert.notStrictEqual(document.getText(), beforeSaveText);

        const otherFilesAfter = workspaceSnapshot();
        for (const [name, fingerprint] of Object.entries(otherFilesBefore)) {
            if (name === 'format-on-save.key') continue;
            assert.deepStrictEqual(otherFilesAfter[name], fingerprint);
        }

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), beforeSaveText);
        assert.strictEqual(document.isDirty, true);
        await vscode.commands.executeCommand('workbench.action.files.revert');
    } finally {
        await configuration.update(
            'formatOnSave',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertExplicitFormattingIsScopedAndUndoable() {
    const {
        document: otherDocument,
    } = await openFixture('format-selection-other-condition.key');
    const otherOriginal = otherDocument.getText();
    const { document, editor } = await openFixture('format-selection.key');
    const original = document.getText();
    const workspaceBefore = workspaceSnapshot();
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);

    editor.selection = new vscode.Selection(
        new vscode.Position(2, 0),
        new vscode.Position(4, 0),
    );
    await vscode.commands.executeCommand('extension.lsdynaFormatSelection');

    assert.strictEqual(document.lineAt(2).text.slice(0, 8).trim(), '1');
    assert.strictEqual(document.lineAt(2).text.slice(8, 24).trim(), '2.0');
    assert.strictEqual(document.lineAt(4).text, 'p'.repeat(100));
    assert.strictEqual(document.lineAt(5).text, '*END');
    assert.strictEqual(otherDocument.getText(), otherOriginal);
    assert.strictEqual(otherDocument.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    editor.selection = new vscode.Selection(
        new vscode.Position(0, 0),
        document.lineAt(document.lineCount - 1).range.end,
    );
    await vscode.commands.executeCommand('extension.lsdynaFormatSelection');

    const nodeLine = document.lineAt(2).text;
    assert.strictEqual(nodeLine.slice(0, 8).trim(), '1');
    assert.strictEqual(nodeLine.slice(8, 24).trim(), '2.0');
    assert.strictEqual(nodeLine.slice(24, 40).trim(), '-3.0');
    assert.strictEqual(nodeLine.slice(40, 56).trim(), '4.0');
    assert.strictEqual(nodeLine.length, 56);
    assert.strictEqual(document.lineAt(4).text, `${'p'.repeat(78)} +`);
    assert.strictEqual(document.lineAt(5).text, 'p'.repeat(22));
    assert.strictEqual(document.lineAt(6).text, '*END');
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    assert.strictEqual(document.isDirty, true);
    assert.strictEqual(otherDocument.getText(), otherOriginal);
    assert.strictEqual(otherDocument.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    assert.strictEqual(document.isDirty, false);
    assert.strictEqual(otherDocument.getText(), otherOriginal);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
}

async function assertOverlappingFormatSelectionsAreAtomicAndUndoable() {
    const {
        document: otherDocument,
    } = await openFixture('format-selection-other-condition.key');
    const otherOriginal = otherDocument.getText();
    const { document, editor } = await openFixture('format-selection-overlap.key');
    const original = document.getText();
    const workspaceBefore = workspaceSnapshot();
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);

    const firstSelection = new vscode.Selection(
        new vscode.Position(0, 0),
        document.lineAt(4).range.end,
    );
    const overlappingSelection = new vscode.Selection(
        new vscode.Position(2, 0),
        document.lineAt(5).range.end,
    );
    editor.selections = [
        firstSelection,
        overlappingSelection,
        overlappingSelection,
    ];
    assert.strictEqual(editor.selections.length, 3);

    await vscode.commands.executeCommand('extension.lsdynaFormatSelection');

    const nodeLine = document.lineAt(2).text;
    assert.strictEqual(nodeLine.slice(0, 8).trim(), '1');
    assert.strictEqual(nodeLine.slice(8, 24).trim(), '2.0');
    assert.strictEqual(nodeLine.slice(24, 40).trim(), '-3.0');
    assert.strictEqual(nodeLine.slice(40, 56).trim(), '4.0');
    assert.strictEqual(nodeLine.length, 56);
    assert.strictEqual(document.lineAt(4).text, `${'p'.repeat(78)} +`);
    assert.strictEqual(document.lineAt(5).text, 'p'.repeat(22));
    assert.strictEqual(document.lineAt(6).text, '*END');
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    assert.strictEqual(document.isDirty, true);
    assert.strictEqual(otherDocument.getText(), otherOriginal);
    assert.strictEqual(otherDocument.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    assert.strictEqual(document.isDirty, false);
    assert.strictEqual(otherDocument.getText(), otherOriginal);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
}

async function assertOnBlurFormattingTracksOnlyTheActiveCondition() {
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    const workspaceBefore = workspaceSnapshot();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const {
        document: inactiveDocument,
        editor: inactiveEditor,
    } = await openFixture('on-blur-inactive-condition.key', {
        viewColumn: vscode.ViewColumn.Two,
    });
    const inactiveOriginal = inactiveDocument.getText();

    const {
        document: activeDocument,
        editor: activeEditor,
    } = await openFixture('on-blur-active-condition.key', {
        viewColumn: vscode.ViewColumn.One,
    });
    const activeOriginal = activeDocument.getText();
    activeEditor.selection = new vscode.Selection(2, 0, 2, 0);

    await configuration.update(
        'autoFormat',
        'onBlur',
        vscode.ConfigurationTarget.Global,
    );

    try {
        // A visible but inactive editor can emit its own selection event.
        // That event must not replace the active condition tracked for onBlur.
        inactiveEditor.selection = new vscode.Selection(2, 0, 2, 0);
        await new Promise(resolve => setTimeout(resolve, 50));

        const {
            document: nextDocument,
            editor: nextEditor,
        } = await openFixture('on-blur-next-condition.key', {
            viewColumn: vscode.ViewColumn.One,
        });
        const nextOriginal = nextDocument.getText();

        await waitForAssertion(() => {
            assert.notStrictEqual(activeDocument.getText(), activeOriginal);
            assert.strictEqual(activeDocument.isDirty, true);
        }, 3000);
        assert.strictEqual(activeDocument.lineAt(2).text.slice(0, 8).trim(), '1');
        assert.strictEqual(activeDocument.lineAt(2).text.slice(8, 24).trim(), '2');
        assert.strictEqual(activeDocument.lineAt(2).text.slice(24, 40).trim(), '3');
        assert.strictEqual(activeDocument.isDirty, true);
        assert.strictEqual(inactiveDocument.getText(), inactiveOriginal);
        assert.strictEqual(inactiveDocument.isDirty, false);
        assert.strictEqual(nextDocument.getText(), nextOriginal);
        assert.strictEqual(nextDocument.isDirty, false);
        assert.strictEqual(vscode.window.activeTextEditor, nextEditor);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        await vscode.window.showTextDocument(activeDocument, {
            viewColumn: vscode.ViewColumn.One,
            preview: false,
            preserveFocus: false,
        });
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(activeDocument.getText(), activeOriginal);
        assert.strictEqual(activeDocument.eol, vscode.EndOfLine.CRLF);
        assert.strictEqual(activeDocument.isDirty, false);
    } finally {
        await configuration.update(
            'autoFormat',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const {
        document: disabledDocument,
        editor: disabledEditor,
    } = await openFixture('on-blur-disabled.key');
    const disabledOriginal = disabledDocument.getText();
    disabledEditor.selection = new vscode.Selection(2, 0, 2, 0);
    await openFixture('on-blur-next-condition.key');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.strictEqual(disabledDocument.getText(), disabledOriginal);
    assert.strictEqual(disabledDocument.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
}

async function assertOnBlurFormattingCannotModifyReadonlyDeck() {
    const lsdynaConfiguration = vscode.workspace.getConfiguration('lsdyna');
    const filesConfiguration = vscode.workspace.getConfiguration('files');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await filesConfiguration.update(
        'readonlyInclude',
        { '**/on-blur-readonly.key': true },
        vscode.ConfigurationTarget.Global,
    );
    await lsdynaConfiguration.update(
        'autoFormat',
        'onBlur',
        vscode.ConfigurationTarget.Global,
    );

    try {
        const { document, editor } = await openFixture('on-blur-readonly.key');
        const original = document.getText();
        const workspaceBefore = workspaceSnapshot();
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await openFixture('on-blur-next-condition.key');
        await new Promise(resolve => setTimeout(resolve, 150));

        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        await lsdynaConfiguration.update(
            'autoFormat',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
        await filesConfiguration.update(
            'readonlyInclude',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertOnBlurFormattingCannotModifyOsReadonlyDeck() {
    if (process.platform !== 'win32') return;

    const lsdynaConfiguration = vscode.workspace.getConfiguration('lsdyna');
    const filesConfiguration = vscode.workspace.getConfiguration('files');
    const fixturePath = path.join(workspaceRoot, 'on-blur-os-readonly.key');
    const originalBytes = fs.readFileSync(fixturePath);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    childProcess.execFileSync('attrib.exe', ['+R', fixturePath]);
    await filesConfiguration.update(
        'readonlyFromPermissions',
        true,
        vscode.ConfigurationTarget.Global,
    );
    await lsdynaConfiguration.update(
        'autoFormat',
        'onBlur',
        vscode.ConfigurationTarget.Global,
    );

    try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fixturePath));
        assert.strictEqual(
            (Number(stat.permissions || 0) & vscode.FilePermission.Readonly) !== 0,
            false,
            'This regression requires the VS Code 1.130 file provider gap on Windows',
        );
        assert.throws(
            () => {
                const descriptor = fs.openSync(fixturePath, 'r+');
                fs.closeSync(descriptor);
            },
            error => error && (error.code === 'EPERM' || error.code === 'EACCES'),
            'The Windows read-only attribute must reject a real writable file handle',
        );
        const { document, editor } = await openFixture('on-blur-os-readonly.key');
        const original = document.getText();
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await openFixture('on-blur-next-condition.key');
        await new Promise(resolve => setTimeout(resolve, 100));

        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(fs.readFileSync(fixturePath), originalBytes);
    } finally {
        await lsdynaConfiguration.update(
            'autoFormat',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
        await filesConfiguration.update(
            'readonlyFromPermissions',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
        childProcess.execFileSync('attrib.exe', ['-R', fixturePath]);
    }
}

async function assertOnBlurFormattingUsesCurrentExternalVersion() {
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const workspaceBefore = workspaceSnapshot();
    const fixturePath = path.join(workspaceRoot, 'on-blur-external-change.key');
    const originalBytes = fs.readFileSync(fixturePath);
    const externalText = '*KEYWORD\r\n*NODE\r\n21 22 23\r\n*END\r\n';
    const externalBytes = Buffer.from(externalText, 'utf8');
    let restored = false;

    await configuration.update(
        'autoFormat',
        'onBlur',
        vscode.ConfigurationTarget.Global,
    );
    try {
        const { document, editor } = await openFixture('on-blur-external-change.key');
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        const observedEvents = [];
        const selectionSubscription = vscode.window.onDidChangeTextEditorSelection(event => {
            if (event.textEditor.document !== document) return;
            observedEvents.push({
                type: 'selection',
                kind: event.kind,
                version: document.version,
                selections: event.selections.map(selection => selectionShape(selection)),
            });
        });
        const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== document) return;
            observedEvents.push({
                type: 'content',
                version: document.version,
                changes: event.contentChanges.map(change => ({
                    range: [
                        change.range.start.line,
                        change.range.start.character,
                        change.range.end.line,
                        change.range.end.character,
                    ],
                    text: change.text,
                })),
            });
        });

        try {
            fs.writeFileSync(fixturePath, externalBytes);
            await waitForAssertion(() => {
                assert.strictEqual(
                    document.getText(),
                    externalText,
                    `external reload events: ${JSON.stringify(observedEvents)}`,
                );
                assert.strictEqual(
                    document.isDirty,
                    false,
                    `external reload events: ${JSON.stringify(observedEvents)}`,
                );
            }, 3000);
        } finally {
            selectionSubscription.dispose();
            changeSubscription.dispose();
        }

        // A subsequent explicit engineer selection re-arms onBlur against the
        // externally reloaded document version.
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await new Promise(resolve => setTimeout(resolve, 50));
        const afterExternalWrite = workspaceSnapshot();

        await openFixture('on-blur-next-condition.key');
        await waitForAssertion(() => {
            assert.notStrictEqual(document.getText(), externalText);
            assert.strictEqual(document.isDirty, true);
        });
        assert.strictEqual(document.lineAt(2).text.slice(0, 8).trim(), '21');
        assert.strictEqual(document.lineAt(2).text.slice(8, 24).trim(), '22');
        assert.strictEqual(document.lineAt(2).text.slice(24, 40).trim(), '23');
        assert.strictEqual(document.isDirty, true);
        assert.deepStrictEqual(workspaceSnapshot(), afterExternalWrite);

        await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
            preview: false,
            preserveFocus: false,
        });
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), externalText);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(fs.readFileSync(fixturePath), externalBytes);
    } finally {
        await configuration.update(
            'autoFormat',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        fs.writeFileSync(fixturePath, originalBytes);
        restored = true;
    }

    assert.strictEqual(restored, true);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
}

async function assertRapidCloseDuringOnBlurCheckIsNonMutating() {
    const lsdynaConfiguration = vscode.workspace.getConfiguration('lsdyna');
    const filesConfiguration = vscode.workspace.getConfiguration('files');
    const fixturePath = path.join(workspaceRoot, 'on-blur-rapid-close.key');
    const originalBytes = fs.readFileSync(fixturePath);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await filesConfiguration.update(
        'readonlyFromPermissions',
        true,
        vscode.ConfigurationTarget.Global,
    );
    await lsdynaConfiguration.update(
        'autoFormat',
        'onBlur',
        vscode.ConfigurationTarget.Global,
    );
    try {
        for (let iteration = 0; iteration < 12; iteration++) {
            const { document, editor } = await openFixture('on-blur-rapid-close.key');
            const original = document.getText();
            editor.selection = new vscode.Selection(2, 0, 2, 0);
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            await waitForAssertion(() => {
                assert.ok(
                    !vscode.window.visibleTextEditors.some(
                        visible => visible.document === document,
                    ),
                );
            }, 3000);
            assert.strictEqual(document.isDirty, false);
            if (!document.isClosed) {
                assert.strictEqual(document.getText(), original);
            }
            assert.deepStrictEqual(fs.readFileSync(fixturePath), originalBytes);
        }
    } finally {
        await lsdynaConfiguration.update(
            'autoFormat',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
        await filesConfiguration.update(
            'readonlyFromPermissions',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertAutoSaveFormatIsLocalAndUndoable() {
    const filesConfiguration = vscode.workspace.getConfiguration('files');
    const editorConfiguration = vscode.workspace.getConfiguration('editor');
    const workspaceBefore = workspaceSnapshot();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await filesConfiguration.update(
        'autoSave',
        'afterDelay',
        vscode.ConfigurationTarget.Global,
    );
    await filesConfiguration.update(
        'autoSaveDelay',
        100,
        vscode.ConfigurationTarget.Global,
    );
    await editorConfiguration.update(
        'formatOnSave',
        true,
        vscode.ConfigurationTarget.Global,
    );

    try {
        const {
            document: otherDocument,
        } = await openFixture('autosave-other-condition.key', {
            viewColumn: vscode.ViewColumn.Two,
        });
        const otherOriginal = otherDocument.getText();
        const {
            document,
            editor,
        } = await openFixture('autosave.key', {
            viewColumn: vscode.ViewColumn.One,
        });
        const originalText = document.getText();
        const originalEol = document.eol;
        await editor.edit(editBuilder => {
            editBuilder.insert(new vscode.Position(1, 0), '$ engineer autosave\r\n');
        });
        const beforeFormatText = document.getText();
        assert.strictEqual(document.isDirty, true);

        await vscode.window.showTextDocument(otherDocument, {
            viewColumn: vscode.ViewColumn.Two,
            preview: false,
            preserveFocus: false,
        });
        await waitForAssertion(() => {
            assert.strictEqual(document.isDirty, false);
            assert.strictEqual(document.getText(), beforeFormatText);
        }, 5000);

        assert.strictEqual(document.eol, originalEol);
        assert.strictEqual(fs.readFileSync(document.uri.fsPath, 'utf8'), beforeFormatText);
        assert.strictEqual(otherDocument.getText(), otherOriginal);
        assert.strictEqual(otherDocument.isDirty, false);
        const workspaceAfter = workspaceSnapshot();
        for (const [name, fingerprint] of Object.entries(workspaceBefore)) {
            if (name === 'autosave.key') continue;
            assert.deepStrictEqual(workspaceAfter[name], fingerprint, name);
        }

        await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
            preview: false,
            preserveFocus: false,
        });
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), originalText);
        assert.strictEqual(document.isDirty, true);
        assert.strictEqual(document.eol, originalEol);
        await vscode.commands.executeCommand('workbench.action.files.revert');
    } finally {
        await editorConfiguration.update(
            'formatOnSave',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
        await filesConfiguration.update(
            'autoSaveDelay',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
        await filesConfiguration.update(
            'autoSave',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertCommittedImeTextIsEditorLocalAndUndoable() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const workspaceBefore = workspaceSnapshot();

    const plainUri = vscode.Uri.file(path.join(workspaceRoot, 'plain-notes.txt'));
    const plainDocument = await vscode.workspace.openTextDocument(plainUri);
    const plainEditor = await vscode.window.showTextDocument(plainDocument, {
        preview: false,
        preserveFocus: false,
    });
    assert.strictEqual(plainDocument.languageId, 'plaintext');
    const plainOriginal = plainDocument.getText();
    plainEditor.selection = new vscode.Selection(0, 16, 0, 16);
    await vscode.commands.executeCommand('type', { text: '中文输入' });
    assert.strictEqual(plainDocument.getText(), 'Engineer notes: 中文输入\r\n');
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(plainDocument.getText(), plainOriginal);
    assert.strictEqual(plainDocument.isDirty, false);

    const { document: fixedDocument, editor: fixedEditor } = await openFixture('fixed.key');
    const fixedOriginal = fixedDocument.getText();
    const fixedOriginalLine = fixedDocument.lineAt(2).text;
    fixedEditor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await vscode.commands.executeCommand('type', { text: '中文' });
    const fixedChangedLine = fixedDocument.lineAt(2).text;
    assert.strictEqual(fixedChangedLine.length, fixedOriginalLine.length);
    assert.strictEqual(fixedChangedLine.slice(8, 24).trim(), '中文');
    assert.strictEqual(fixedChangedLine.slice(24), fixedOriginalLine.slice(24));
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(fixedDocument.getText(), fixedOriginal);
    assert.strictEqual(fixedDocument.isDirty, false);
    fixedEditor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');

    await vscode.window.showTextDocument(plainDocument, {
        preview: false,
        preserveFocus: false,
    });
    plainEditor.selection = new vscode.Selection(0, 16, 0, 16);
    await vscode.commands.executeCommand('type', { text: '切换后输入' });
    assert.strictEqual(plainDocument.getText(), 'Engineer notes: 切换后输入\r\n');
    assert.strictEqual(fixedDocument.getText(), fixedOriginal);
    assert.strictEqual(fixedDocument.isDirty, false);
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(plainDocument.getText(), plainOriginal);
    assert.strictEqual(plainDocument.isDirty, false);

    const { document, editor } = await openFixture('ime-comment.key');
    const original = document.getText();
    const commentLength = document.lineAt(1).text.length;
    editor.selection = new vscode.Selection(1, commentLength, 1, commentLength);
    await vscode.commands.executeCommand('type', { text: '中文注释' });
    assert.strictEqual(document.lineAt(1).text, '$ Engineer note: 中文注释');
    assert.strictEqual(document.eol, vscode.EndOfLine.CRLF);
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
}

async function assertRendererImeCompositionIsLocalAndUndoable() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const workspaceBefore = workspaceSnapshot();
    const devTools = await connectWorkbenchDevTools();

    try {
        const {
            document: commentDocument,
            editor: commentEditor,
        } = await openFixture('ime-comment.key');
        const commentOriginal = commentDocument.getText();
        const commentLength = commentDocument.lineAt(1).text.length;
        commentEditor.selection = new vscode.Selection(
            1,
            commentLength,
            1,
            commentLength,
        );
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);

        await setRendererComposition(devTools, '中');
        await waitForAssertion(() => {
            assert.strictEqual(commentDocument.lineAt(1).text, '$ Engineer note: 中');
        });
        await setRendererComposition(devTools, '中文');
        await waitForAssertion(() => {
            assert.strictEqual(commentDocument.lineAt(1).text, '$ Engineer note: 中文');
        });
        await commitRendererComposition(devTools, '中文');
        await waitForAssertion(() => {
            assert.strictEqual(commentDocument.lineAt(1).text, '$ Engineer note: 中文');
        });
        await vscode.commands.executeCommand('undo');
        await waitForAssertion(() => {
            assert.strictEqual(commentDocument.getText(), commentOriginal);
            assert.strictEqual(commentDocument.isDirty, false);
        });

        commentEditor.selection = new vscode.Selection(
            1,
            commentLength,
            1,
            commentLength,
        );
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await setRendererComposition(devTools, '取消');
        await waitForAssertion(() => {
            assert.strictEqual(commentDocument.lineAt(1).text, '$ Engineer note: 取消');
        });
        await setRendererComposition(devTools, '');
        await waitForAssertion(() => {
            assert.strictEqual(commentDocument.getText(), commentOriginal);
        });
        // VS Code 1.130.0 keeps a document dirty after CDP cancels a
        // composition even though the text is byte-for-byte original. Treat
        // this as the renderer baseline rather than extension-owned state.
        await vscode.commands.executeCommand('workbench.action.files.revert');
        assert.strictEqual(commentDocument.isDirty, false);

        const {
            document: fixedDocument,
            editor: fixedEditor,
        } = await openFixture('fixed.key');
        const fixedOriginal = fixedDocument.getText();
        const fixedLine = fixedDocument.lineAt(2).text;
        const selectFixedCell = async () => {
            fixedEditor.selection = new vscode.Selection(2, 0, 2, 0);
            await vscode.commands.executeCommand('extension.lsdynaTab');
            assert.strictEqual(fixedEditor.selection.start.character, 9);
            assert.strictEqual(fixedEditor.selection.end.character, 24);
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            await waitForRendererEditorFocus(devTools);
        };
        const assertFixedValue = expected => {
            const line = fixedDocument.lineAt(2).text;
            assert.strictEqual(line.length, fixedLine.length);
            assert.strictEqual(line.slice(8, 24).trim(), expected);
            assert.strictEqual(line.slice(24), fixedLine.slice(24));
        };

        await selectFixedCell();
        await setRendererComposition(devTools, 'z');
        await waitForAssertion(() => {
            assert.ok(fixedDocument.lineAt(2).text.includes('z'));
        });
        await setRendererComposition(devTools, "zhong'wen");
        await new Promise(resolve => setTimeout(resolve, 100));
        await commitRendererComposition(devTools, '中文');
        await waitForAssertion(() => {
            assertFixedValue('中文');
        });
        await settleCardCellPostEdit(fixedDocument);
        await dispatchRendererKey(devTools, 'X', 'KeyX', 88);
        await waitForAssertion(() => {
            assertFixedValue('中文X');
        });
        await vscode.commands.executeCommand('undo');
        await waitForAssertion(() => {
            assertFixedValue('中文');
        });
        await vscode.commands.executeCommand('undo');
        await waitForAssertion(() => {
            assert.strictEqual(fixedDocument.getText(), fixedOriginal);
            assert.strictEqual(fixedDocument.isDirty, false);
        });

        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        devTools.close();
    }
}

async function assertRendererImeCompositionCancelRestoresCell() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const workspaceBefore = workspaceSnapshot();
    const devTools = await connectWorkbenchDevTools();

    try {
        const { document, editor } = await openFixture('fixed-stale-nav.key');
        const original = document.getText();
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);

        await setRendererComposition(devTools, 'q');
        await waitForAssertion(() => {
            assert.ok(document.lineAt(2).text.includes('q'));
        });
        await setRendererComposition(devTools, 'quxiao');
        await new Promise(resolve => setTimeout(resolve, 100));
        await setRendererComposition(devTools, '');
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
            assert.strictEqual(editor.selection.start.character, 9);
            assert.strictEqual(editor.selection.end.character, 24);
        });
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        devTools.close();
    }
}

async function assertRendererImeCompositionOverWidthIsRejected() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const workspaceBefore = workspaceSnapshot();
    const devTools = await connectWorkbenchDevTools();

    try {
        const { document, editor } = await openFixture('fixed-empty-field.key');
        const original = document.getText();
        const tooWideComposition = '超'.repeat(17);
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);

        await setRendererComposition(devTools, tooWideComposition);
        await commitRendererComposition(devTools, tooWideComposition);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
            assert.strictEqual(editor.selection.start.character, 9);
            assert.strictEqual(editor.selection.end.character, 24);
        }, 5000);
        await settleCardCellPostEdit(document);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        devTools.close();
    }
}

async function assertOfficialFormatCorpusFailsClosedInRealHost() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const workspaceBefore = workspaceSnapshot();

    for (const name of [
        'long-keyword-lf.key',
        'long-per-keyword-lf.key',
        'i10-per-keyword-lf.key',
    ]) {
        const { document, editor } = await openFixture(
            path.join('official-corpus', name),
        );
        const original = document.getText();
        const originalDataLine = document.lineAt(2).text;
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        assert.ok(
            document.lineAt(2).text.endsWith(originalDataLine),
            `${name} must not be token-reflowed or truncated`,
        );
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original, name);
        assert.strictEqual(document.isDirty, false, name);
    }

    const {
        document: mixedDocument,
        editor: mixedEditor,
    } = await openFixture(path.join('official-corpus', 'mixed-card-formats-lf.key'));
    const mixedOriginal = mixedDocument.getText();
    mixedEditor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    assert.strictEqual(mixedDocument.getText(), mixedOriginal);
    assert.strictEqual(mixedDocument.isDirty, false);
    mixedEditor.selection = new vscode.Selection(3, 0, 3, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    assert.ok(mixedDocument.lineAt(3).text.includes(','));
    assert.ok(mixedDocument.lineAt(4).text.includes(','));
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(mixedDocument.getText(), mixedOriginal);
    assert.strictEqual(mixedDocument.isDirty, false);

    const {
        document: tailDocument,
        editor: tailEditor,
    } = await openFixture(
        path.join('official-corpus', 'column-80-tail-no-final-newline.key'),
    );
    const tailOriginal = tailDocument.getText();
    tailEditor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    assert.ok(tailDocument.lineAt(2).text.includes('IGNORED_AFTER_COLUMN_80'));
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(tailDocument.getText(), tailOriginal);
    assert.strictEqual(tailDocument.getText().endsWith('\n'), false);
    assert.strictEqual(tailDocument.isDirty, false);

    for (const length of [236, 237]) {
        const relative = path.join(
            'official-corpus',
            'include-boundaries',
            `include-${length}-lf.key`,
        );
        const { document, editor } = await openFixture(relative);
        const original = document.getText();
        editor.selection = new vscode.Selection(
            new vscode.Position(0, 0),
            document.lineAt(document.lineCount - 1).range.end,
        );
        await vscode.commands.executeCommand('extension.lsdynaFormatSelection');
        assert.strictEqual(document.getText(), original, relative);
        assert.strictEqual(document.isDirty, false, relative);
    }

    const bomPath = path.join('official-corpus', 'utf8-bom-crlf.key');
    const bomAbsolutePath = path.join(workspaceRoot, bomPath);
    const bomBefore = fs.readFileSync(bomAbsolutePath);
    const { document: bomDocument } = await openFixture(bomPath);
    assert.strictEqual(bomDocument.eol, vscode.EndOfLine.CRLF);
    assert.strictEqual(await bomDocument.save(), true);
    assert.deepStrictEqual(fs.readFileSync(bomAbsolutePath), bomBefore);

    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
}

async function runPasteIntoSelectedCellAssertions() {
    const { document, editor } = await openFixture('fixed.key');
    const original = document.getText();
    const originalLine = document.lineAt(2).text;
    for (const command of [
        'editor.action.clipboardPasteAction',
        'editor.action.pasteAsText',
    ]) {
        for (let iteration = 0; iteration < 12; iteration++) {
            const tabSettleMs = [0, 1, 5, 10, 19, 20, 21, 50, 100][iteration % 9];
            const guard = vscode.extensions
                .getExtension('hqyyqh.dynasense')
                ?.exports?._internals
                ?.ensureCardCellEditGuard?.();
            const observedChanges = [];
            const observedSelections = [];
            let navAtDocumentChange = null;
            const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
                if (event.document !== document) return;
                navAtDocumentChange = guard?.getNav?.() || null;
                observedChanges.push({
                    version: document.version,
                    changes: event.contentChanges.map(change => ({
                        range: `${change.range.start.line}:${change.range.start.character}` +
                            `-${change.range.end.line}:${change.range.end.character}`,
                        rangeLength: change.rangeLength,
                        text: change.text,
                    })),
                });
            });
            const selectionSubscription = vscode.window.onDidChangeTextEditorSelection(event => {
                if (event.textEditor !== editor) return;
                observedSelections.push({
                    kind: event.kind,
                    eventSelections: event.selections.map(selectionShape),
                    editorSelection: selectionShape(editor.selection),
                    nav: guard?.getNav?.() || null,
                });
            });
            editor.selection = new vscode.Selection(2, 0, 2, 0);
            await vscode.commands.executeCommand('extension.lsdynaTab');
            const versionAfterTab = document.version;
            const navAfterTab = guard?.getNav?.() || null;
            const selectionAfterTab = selectionShape(editor.selection);
            if (tabSettleMs > 0) {
                await new Promise(resolve => setTimeout(resolve, tabSettleMs));
            }
            const versionAfterTabSettle = document.version;
            const navAfterTabSettle = guard?.getNav?.() || null;
            const selectionAfterTabSettle = selectionShape(editor.selection);
            await writeClipboardText('9.5');
            const navBeforePaste = guard?.getNav?.() || null;
            try {
                await vscode.commands.executeCommand(command);
                await settleCardCellPostEdit(document);
                await waitForAssertion(() => {
                    const changedLine = document.lineAt(2).text;
                    assert.strictEqual(changedLine.slice(0, 8), originalLine.slice(0, 8), command);
                    assert.strictEqual(changedLine.slice(8, 24).trim(), '9.5', command);
                    assert.strictEqual(changedLine.slice(24), originalLine.slice(24), command);
                });
            } catch (error) {
                throw new Error(
                    `Paste stress ${command} iteration ${iteration + 1}/12 failed` +
                    `\ntabSettleMs=${tabSettleMs}` +
                    `\ndocument.version=${document.version}` +
                    `\nselection=${editor.selection.start.line}:${editor.selection.start.character}` +
                    `-${editor.selection.end.line}:${editor.selection.end.character}` +
                    `\nclipboard=${JSON.stringify(await vscode.env.clipboard.readText())}` +
                    `\nversionAfterTab=${versionAfterTab}` +
                    `\nversionAfterTabSettle=${versionAfterTabSettle}` +
                    `\nnavAfterTab=${JSON.stringify(navAfterTab)}` +
                    `\nnavAfterTabSettle=${JSON.stringify(navAfterTabSettle)}` +
                    `\nselectionAfterTab=${JSON.stringify(selectionAfterTab)}` +
                    `\nselectionAfterTabSettle=${JSON.stringify(selectionAfterTabSettle)}` +
                    `\nnavBeforePaste=${JSON.stringify(navBeforePaste)}` +
                    `\nnavAtDocumentChange=${JSON.stringify(navAtDocumentChange)}` +
                    `\nnavAfterFailure=${JSON.stringify(guard?.getNav?.() || null)}` +
                    `\nline=${JSON.stringify(document.lineAt(2).text)}` +
                    `\ncontentChanges=${JSON.stringify(observedChanges)}` +
                    `\nselectionChanges=${JSON.stringify(observedSelections)}`,
                    { cause: error },
                );
            } finally {
                changeSubscription.dispose();
                selectionSubscription.dispose();
            }

            await vscode.commands.executeCommand('undo');
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        }
    }

    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await writeClipboardText('9.5');
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await vscode.commands.executeCommand('type', { text: 'X' });
    await waitForAssertion(() => {
        const changedLine = document.lineAt(2).text;
        assert.strictEqual(changedLine.slice(0, 8), originalLine.slice(0, 8));
        assert.strictEqual(changedLine.slice(8, 24).trim(), '9.5X');
        assert.strictEqual(changedLine.slice(24), originalLine.slice(24));
    });
    await vscode.commands.executeCommand('undo');
    await waitForAssertion(() => {
        const pastedLine = document.lineAt(2).text;
        assert.strictEqual(pastedLine.slice(8, 24).trim(), '9.5');
        assert.strictEqual(pastedLine.slice(24), originalLine.slice(24));
    });
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await writeClipboardText('9.5');
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await waitForAssertion(() => {
        const changedLine = document.lineAt(2).text;
        assert.strictEqual(changedLine.slice(8, 24).trim(), '9.5');
        assert.strictEqual(changedLine.slice(24), originalLine.slice(24));
        assert.ok(editor.selection.start.character >= 24);
    });
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await writeClipboardText('9.5');
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await vscode.commands.executeCommand('extension.lsdynaCellDeleteLeft');
    await waitForAssertion(() => {
        const changedLine = document.lineAt(2).text;
        assert.strictEqual(changedLine.slice(8, 24).trim(), '9.');
        assert.strictEqual(changedLine.slice(24), originalLine.slice(24));
    });
    await vscode.commands.executeCommand('undo');
    await waitForAssertion(() => {
        const pastedLine = document.lineAt(2).text;
        assert.strictEqual(pastedLine.slice(8, 24).trim(), '9.5');
        assert.strictEqual(pastedLine.slice(24), originalLine.slice(24));
    });
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await writeClipboardText('12345678901234567');
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await settleCardCellPostEdit(document);
    await waitForAssertion(() => {
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    });

    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await vscode.commands.executeCommand('type', { text: '9' });
    const beforeApPaste = document.getText();
    await writeClipboardText('5');
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await settleCardCellPostEdit(document);
    await waitForAssertion(() => {
        const changedLine = document.lineAt(2).text;
        assert.strictEqual(changedLine.slice(8, 24).trim(), '95');
        assert.strictEqual(changedLine.slice(24), originalLine.slice(24));
    });
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), beforeApPaste);
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await writeClipboardText('9\n5');
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await settleCardCellPostEdit(document);
    await waitForAssertion(() => {
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    });

    let cutNoOpRetries = 0;
    for (let iteration = 0; iteration < 40; iteration++) {
        const selectionSettleMs = [0, 1, 5, 10, 19, 20, 21, 50, 100][iteration % 9];
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');
        const guard = vscode.extensions
            .getExtension('hqyyqh.dynasense')
            ?.exports?._internals
            ?.ensureCardCellEditGuard?.();
        const navAfterTab = guard?.getNav?.() || null;
        await vscode.commands.executeCommand('type', { text: '1234' });
        const navAfterType = guard?.getNav?.() || null;
        const lineAfterType = document.lineAt(2).text;
        const selectionAfterType = selectionShape(editor.selection);
        const beforeCut = document.getText();
        const observedChanges = [];
        let navAtDocumentChange = null;
        const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== document) return;
            navAtDocumentChange = guard?.getNav?.() || null;
            observedChanges.push({
                version: document.version,
                changes: event.contentChanges.map(change => ({
                    range: `${change.range.start.line}:${change.range.start.character}` +
                        `-${change.range.end.line}:${change.range.end.character}`,
                    rangeLength: change.rangeLength,
                    text: change.text,
                })),
            });
        });
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        editor.selection = new vscode.Selection(2, 21, 2, 23);
        const navBeforeCut = guard?.getNav?.() || null;
        if (selectionSettleMs > 0) {
            await new Promise(resolve => setTimeout(resolve, selectionSettleMs));
        }
        try {
            await vscode.commands.executeCommand('editor.action.clipboardCutAction');
            if (
                document.getText() === beforeCut &&
                observedChanges.length === 0 &&
                editor.selection.start.line === 2 &&
                editor.selection.start.character === 21 &&
                editor.selection.end.line === 2 &&
                editor.selection.end.character === 23
            ) {
                cutNoOpRetries++;
                await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
                await new Promise(resolve => setTimeout(resolve, 50));
                await vscode.commands.executeCommand('editor.action.clipboardCutAction');
            }
            await settleCardCellPostEdit(document);
            await waitForAssertion(() => {
                const changedLine = document.lineAt(2).text;
                assert.strictEqual(changedLine.slice(8, 24).trim(), '14');
                assert.strictEqual(changedLine.slice(24), originalLine.slice(24));
            });
        } catch (error) {
            const diagnostic = new Error(
                `Cut stress iteration ${iteration + 1}/40 failed` +
                `\nselectionSettleMs=${selectionSettleMs}` +
                `\ndocument.version=${document.version}` +
                `\nselection=${editor.selection.start.line}:${editor.selection.start.character}` +
                `-${editor.selection.end.line}:${editor.selection.end.character}` +
                `\nnavBeforeCut=${JSON.stringify(navBeforeCut)}` +
                `\nnavAfterTab=${JSON.stringify(navAfterTab)}` +
                `\nnavAfterType=${JSON.stringify(navAfterType)}` +
                `\nnavAtDocumentChange=${JSON.stringify(navAtDocumentChange)}` +
                `\nnavAfterFailure=${JSON.stringify(guard?.getNav?.() || null)}` +
                `\nselectionAfterType=${JSON.stringify(selectionAfterType)}` +
                `\nlineAfterType=${JSON.stringify(lineAfterType)}` +
                `\ncontentChanges=${JSON.stringify(observedChanges)}`,
                { cause: error },
            );
            throw diagnostic;
        } finally {
            changeSubscription.dispose();
        }
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), beforeCut);
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    }
    assert.ok(cutNoOpRetries < 40, 'Every Cut stress command was a renderer no-op');
}

async function assertPasteIntoSelectedCellKeepsColumns() {
    const originalClipboardText = await vscode.env.clipboard.readText();
    try {
        await runPasteIntoSelectedCellAssertions();
    } finally {
        await writeClipboardText(originalClipboardText);
    }
}

async function assertLineCommentInsertsAtColumnZeroAndUncommentsStrictly() {
    const { document, editor } = await openFixture('comment-toggle.key');
    const original = document.getText();
    const originalLine = document.lineAt(2).text;

    // Comment: insert $ at column 0, preserve indentation, shift cursor +1.
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    assert.strictEqual(document.lineAt(2).text, `$${originalLine}`);
    assert.strictEqual(editor.selection.active.line, 2);
    assert.strictEqual(editor.selection.active.character, 1); // cursor shifts with the inserted $
    assert.strictEqual(document.isDirty, true);
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    // Uncomment: remove the column-0 $, shift cursor -1 (strict inverse).
    const commentLine = document.lineAt(3).text; // '$ existing'
    editor.selection = new vscode.Selection(3, 1, 3, 1);
    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    assert.strictEqual(document.lineAt(3).text, commentLine.slice(1)); // ' existing'
    assert.strictEqual(editor.selection.active.line, 3);
    assert.strictEqual(editor.selection.active.character, 0); // (3,1) -> (3,0)
    assert.strictEqual(document.isDirty, true);
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertLineCommentEmptyLineIsLoneDollar() {
    const { document, editor } = await openFixture('comment-toggle.key');
    const original = document.getText();
    assert.strictEqual(document.lineAt(5).text, '');
    editor.selection = new vscode.Selection(5, 0, 5, 0);

    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    assert.strictEqual(document.lineAt(5).text, '$');
    assert.strictEqual(document.isDirty, true);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.lineAt(5).text, '');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertLineCommentMultiLineSelectionIsAtomicAndSingleUndo() {
    const { document, editor } = await openFixture('comment-toggle.key');
    const original = document.getText();
    const dataLine = document.lineAt(2).text;
    const fieldHeader = document.lineAt(6).text;
    const workspaceBefore = workspaceSnapshot();

    // Spans data(2), $col0(3), legacy indented $(4), empty(5), $# header(6), data(7).
    editor.selection = new vscode.Selection(
        new vscode.Position(2, 0),
        document.lineAt(7).range.end,
    );

    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    // Mixed mode: comment only uncommented lines 2/5/7; skip already-commented 3
    // and 4 (no $$); never touch the $# field-header line 6.
    assert.strictEqual(document.lineAt(2).text, `$${dataLine}`);
    assert.strictEqual(document.lineAt(3).text, '$ existing');
    assert.strictEqual(document.lineAt(4).text, '    $ legacy indented');
    assert.strictEqual(document.lineAt(5).text, '$');
    assert.strictEqual(document.lineAt(6).text, fieldHeader);
    assert.strictEqual(document.lineAt(7).text, `$${dataLine}`);
    assert.strictEqual(document.isDirty, true);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    await vscode.commands.executeCommand('undo'); // single Ctrl+Z restores every line
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
}

async function assertLineCommentMultiCursorIsAtomicAndSingleUndo() {
    const { document, editor } = await openFixture('comment-toggle.key');
    const original = document.getText();
    const dataLine = document.lineAt(2).text;
    editor.selections = [
        new vscode.Selection(2, 0, 2, 0),
        new vscode.Selection(7, 0, 7, 0),
    ];

    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    assert.strictEqual(document.lineAt(2).text, `$${dataLine}`);
    assert.strictEqual(document.lineAt(7).text, `$${dataLine}`);
    assert.strictEqual(editor.selections.length, 2);
    assert.deepStrictEqual(editor.selections.map(selectionShape), [
        { anchor: [2, 1], active: [2, 1] },
        { anchor: [7, 1], active: [7, 1] },
    ]);
    assert.strictEqual(document.isDirty, true);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertLineCommentAllCommentedUncommentsAndLeavesLegacy() {
    const { document, editor } = await openFixture('comment-toggle.key');
    const original = document.getText();
    const workspaceBefore = workspaceSnapshot();

    // Lines 3 ($ existing) and 4 (    $ legacy indented) are both commented.
    editor.selection = new vscode.Selection(
        new vscode.Position(3, 0),
        document.lineAt(4).range.end,
    );

    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    // All-commented -> uncomment mode: remove the column-0 $ on line 3, but the
    // legacy indented $ on line 4 (no column-0 $) is recognized yet not rewritten.
    assert.strictEqual(document.lineAt(3).text, ' existing');
    assert.strictEqual(document.lineAt(4).text, '    $ legacy indented');
    assert.strictEqual(document.isDirty, true);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertLineCommentFallsThroughForNonLsdynaDocument() {
    const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(workspaceRoot, 'plain-notes.txt')),
    );
    assert.notStrictEqual(document.languageId, 'lsdyna');
    const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
    });
    const original = document.getText();

    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    // Non-lsdyna documents delegate to VS Code's built-in comment line; the
    // command must never insert a column-0 $ into a plain-text file.
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

async function assertRendererCtrlSlashFiresColumnZeroComment() {
    const workspaceBefore = workspaceSnapshot();
    const devTools = await connectWorkbenchDevTools();
    try {
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
        const { document, editor } = await openFixture('comment-toggle.key', {
            viewColumn: vscode.ViewColumn.One,
        });
        const original = document.getText();
        const originalLine = document.lineAt(2).text;
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForAssertion(() => {
            assert.strictEqual(vscode.window.activeTextEditor, editor);
        });
        await waitForRendererEditorFocus(devTools);

        // Real Ctrl+/ via CDP must fire the lsdyna command (column-0 $), not VS
        // Code's default "first non-whitespace character" comment.
        await dispatchRendererKey(devTools, '/', 'Slash', 191, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(2).text, `$${originalLine}`);
            assert.strictEqual(document.isDirty, true);
        });

        // A single real Ctrl+Z fully restores the document.
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
        devTools.close();
    }
}

async function assertLineCommentFailsClosedWithoutMovingCursorOnReadonlyDeck() {
    const filesConfiguration = vscode.workspace.getConfiguration('files');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await filesConfiguration.update(
        'readonlyInclude',
        { '**/comment-toggle.key': true },
        vscode.ConfigurationTarget.Global,
    );

    try {
        const { document, editor } = await openFixture('comment-toggle.key');
        const original = document.getText();
        const workspaceBefore = workspaceSnapshot();
        editor.selection = new vscode.Selection(2, 0, 2, 0);

        await vscode.commands.executeCommand('extension.lsdynaLineComment');
        await new Promise(resolve => setTimeout(resolve, 50));

        // Read-only deck: files.readonlyInclude blocks the buffer write (and may
        // do so without flipping document.isReadonly or making editor.edit resolve
        // to false). Fail closed with no text change AND no cursor movement — the
        // handler never rewrites selections after the edit, so a rejected edit
        // leaves the caret exactly where it was.
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.strictEqual(editor.selection.active.line, 2);
        assert.strictEqual(editor.selection.active.character, 0);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        await filesConfiguration.update(
            'readonlyInclude',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertCloseUnsavedRevertKeepsDiskAndOtherFilesUnchanged() {
    // Layer-5 "关闭未保存" — Don't Save branch: dirty the buffer through an
    // extension write op (column-zero line comment), then discard it via
    // files.revert (the headless proxy for closing a dirty editor with "Don't
    // Save"). Disk must stay untouched and no other workspace file may move.
    const otherFilesBefore = workspaceSnapshot();
    const { document, editor } = await openFixture('comment-toggle.key');
    const original = document.getText();
    const originalBytes = fs.readFileSync(document.uri.fsPath);
    const targetLine = document.lineAt(2).text;

    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    assert.strictEqual(document.lineAt(2).text, `$${targetLine}`);
    assert.strictEqual(document.isDirty, true);
    assert.notStrictEqual(document.getText(), original);
    // The dirty buffer must not have reached disk yet.
    assert.deepStrictEqual(fs.readFileSync(document.uri.fsPath), originalBytes);

    // "Don't Save": discard the dirty buffer back to the on-disk state.
    await vscode.commands.executeCommand('workbench.action.files.revert');
    assert.strictEqual(document.isDirty, false);
    assert.strictEqual(document.getText(), original);
    assert.deepStrictEqual(fs.readFileSync(document.uri.fsPath), originalBytes);

    const otherFilesAfter = workspaceSnapshot();
    for (const [name, fingerprint] of Object.entries(otherFilesBefore)) {
        if (name === 'comment-toggle.key') continue;
        assert.deepStrictEqual(otherFilesAfter[name], fingerprint);
    }
}

async function assertRendererCtrlSlashFiresColumnZeroCommentWhileSuggestVisible() {
    const workspaceBefore = workspaceSnapshot();
    // Force VS Code's default line comment to insert a space after the token so
    // that a fall-through (the bug) produces '$ Sub/' and stays distinguishable
    // from our column-0 '$Sub/'.
    const commentsConfiguration = vscode.workspace.getConfiguration('editor.comments');
    const originalInsertSpace = commentsConfiguration.get('insertSpace');
    await commentsConfiguration.update(
        'insertSpace',
        true,
        vscode.ConfigurationTarget.Global,
    );

    const { document, editor } = await openFixture('completion.key');
    const original = document.getText();
    const originalLine = document.lineAt(2).text; // 'Sub/'
    const position = new vscode.Position(2, 4);
    editor.selection = new vscode.Selection(position, position);
    const devTools = await connectWorkbenchDevTools();
    try {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);

        // Open the real Suggest Widget (proven include-completion trigger) so
        // the suggestWidgetVisible context is genuinely true.
        await dispatchRendererKey(devTools, ' ', 'Space', 32, 2);
        const widget = await waitForRendererSuggestionWidget(devTools);
        assert.ok(
            widget && widget.rows.length > 0,
            'Suggest widget must be open for this scenario',
        );

        // Real Ctrl+/ while the Suggest Widget is visible must still fire the
        // lsdyna column-0 command (no inserted space, $ at index 0), not VS
        // Code's default "first non-whitespace char" comment.
        await dispatchRendererKey(devTools, '/', 'Slash', 191, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(2).text, `$${originalLine}`);
            assert.strictEqual(document.isDirty, true);
        });

        // A single real Ctrl+Z fully restores the document.
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
        devTools.close();
        await commentsConfiguration.update(
            'insertSpace',
            originalInsertSpace,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function run() {
    if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
        throw new Error('LSDYNA_EDITOR_SAFETY_WORKSPACE is missing');
    }

    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    assert.ok(extension, 'development extension was not loaded');
    await extension.activate();
    assert.strictEqual(extension.isActive, true);

    const focusedScenario = process.env.LSDYNA_EDITOR_SAFETY_ONLY;
    if (focusedScenario) {
        const scenarios = {
            'committed-ime': assertCommittedImeTextIsEditorLocalAndUndoable,
            composition: assertRendererImeCompositionIsLocalAndUndoable,
            'composition-cancel': assertRendererImeCompositionCancelRestoresCell,
            'composition-overwidth': assertRendererImeCompositionOverWidthIsRejected,
            latency: assertInteractiveLatencyBaseline,
            paste: assertPasteIntoSelectedCellKeepsColumns,
            'mouse-multicursor': assertRendererAltClickMultiCursorActionsAreAtomic,
            'mouse-drag': assertRendererMouseDragSelectionsAreScopedAndUndoable,
            'mouse-context-menu': assertRendererContextMenuPasteAndCutAreScopedAndUndoable,
            'mouse-code-action': assertIncludeCaseQuickFixMouseClickIsLocalAndUndoable,
            'line-comment': assertLineCommentInsertsAtColumnZeroAndUncommentsStrictly,
            'line-comment-readonly': assertLineCommentFailsClosedWithoutMovingCursorOnReadonlyDeck,
            'ctrl-slash': assertRendererCtrlSlashFiresColumnZeroComment,
            'ctrl-slash-suggest': assertRendererCtrlSlashFiresColumnZeroCommentWhileSuggestVisible,
            'hover-functional': assertFunctionalHoverMatrix,
        };
        assert.ok(scenarios[focusedScenario], `Unknown focused scenario: ${focusedScenario}`);
        await scenarios[focusedScenario]();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        console.log(`Editor safety focused Extension Host: ${focusedScenario} passed`);
        return;
    }

    await assertPassiveOperationsDoNotWrite();
    await assertFunctionalHoverMatrix();
    await assertCompletionAcceptCancelIsLocalAndUndoable();
    await assertCompletionMixedCursorsFailClosed();
    await assertMultiCursorNavigationCommandsFailClosed();
    await assertMultiCursorDeleteCommandsFailClosed();
    await assertRendererMultiCursorKeysStayNativeAndUndoable();
    await assertRendererAltClickMultiCursorActionsAreAtomic();
    await assertRendererMouseDragSelectionsAreScopedAndUndoable();
    await assertRendererContextMenuPasteAndCutAreScopedAndUndoable();
    await assertCellDeleteCannotModifyReadonlyDeck();
    await assertCellDeleteAndEnterUseCurrentExternalVersion();
    await assertTypeAfterExternalReloadCannotCollapseColumns();
    await assertCellDeleteAndBackspaceAreLocalAndUndoable();
    await assertEmptyCellBackspaceMovesWithoutWriting();
    await assertSecondDeleteRemovesNowEmptyCardRow();
    await assertCommaDeleteUsesNativeUndoableEditing();
    await assertEnterIsAtomicAndUndoable();
    await assertKeywordTitleOptionIsTransactional();
    await assertKeywordOptionsCannotModifyReadonlyDeck();
    await assertKeywordOptionPickerSwitchIsNoOp();
    await assertContactOptionsDoNotDuplicateOrRemoveComments();
    await assertParameterRenameIsDocumentLocalAndUndoable();
    await assertParameterRenameRendererCancelAndAcceptAreScoped();
    await assertIncludeCaseQuickFixIsLocalAndUndoable();
    await assertIncludeCaseQuickFixMouseClickIsLocalAndUndoable();
    await assertStaleIncludeCaseQuickFixFailsClosed();
    await assertIncludeCaseQuickFixCancelIsNoOp();
    await assertIncludeCaseQuickFixPreviewIsNonMutating();
    await assertIncludeCaseActionRevalidatesAfterMenuWait();
    await assertIncludeCaseActionRevalidatesAfterCaseOnlyRename();
    await assertIncludeCaseQuickFixCannotModifyReadonlyDeck();
    await assertIncludeCaseActionDoesNotOverwriteMenuTimeEdit();
    await assertCellTypeIsLocalAndUndoable();
    await assertCommaTabKeepsFreeFormatAndUndo();
    await assertOverWidthTypeIsRejectedAtomically();
    await assertFormatOnSaveScopeAndUndo();
    await assertExplicitFormattingIsScopedAndUndoable();
    await assertOverlappingFormatSelectionsAreAtomicAndUndoable();
    await assertOnBlurFormattingTracksOnlyTheActiveCondition();
    await assertOnBlurFormattingCannotModifyReadonlyDeck();
    await assertOnBlurFormattingCannotModifyOsReadonlyDeck();
    await assertOnBlurFormattingUsesCurrentExternalVersion();
    await assertRapidCloseDuringOnBlurCheckIsNonMutating();
    await assertAutoSaveFormatIsLocalAndUndoable();
    await assertCommittedImeTextIsEditorLocalAndUndoable();
    await assertRendererImeCompositionIsLocalAndUndoable();
    await assertRendererImeCompositionCancelRestoresCell();
    await assertRendererImeCompositionOverWidthIsRejected();
    await assertOfficialFormatCorpusFailsClosedInRealHost();
    await assertInteractiveLatencyBaseline();
    await assertPasteIntoSelectedCellKeepsColumns();
    await assertLineCommentInsertsAtColumnZeroAndUncommentsStrictly();
    await assertLineCommentEmptyLineIsLoneDollar();
    await assertLineCommentMultiLineSelectionIsAtomicAndSingleUndo();
    await assertLineCommentMultiCursorIsAtomicAndSingleUndo();
    await assertLineCommentAllCommentedUncommentsAndLeavesLegacy();
    await assertLineCommentFallsThroughForNonLsdynaDocument();
    await assertLineCommentFailsClosedWithoutMovingCursorOnReadonlyDeck();
    await assertCloseUnsavedRevertKeepsDiskAndOtherFilesUnchanged();
    await assertRendererCtrlSlashFiresColumnZeroComment();
    await assertRendererCtrlSlashFiresColumnZeroCommentWhileSuggestVisible();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    console.log('Editor safety Extension Host: 62 scenarios passed');
}

module.exports = { run };
