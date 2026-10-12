'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('node:module');
const { performance } = require('perf_hooks');
const vscode = require('vscode');
const { fetchJson, openSocket, createCdp } = require('../../../support/devtools.cjs');
const { hashFile } = require('../../../support/editor-safety/fileOracle.js');

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
    if (!devToolsPort || typeof fetch !== 'function') {
        throw new Error('VS Code renderer DevTools is unavailable');
    }

    const deadline = Date.now() + 5000;
    let target = null;
    while (Date.now() < deadline && !target) {
        try {
            const targets = await fetchJson(`http://127.0.0.1:${devToolsPort}/json/list`, Math.min(3000, deadline - Date.now()));
            target = targets.find(item =>
                item.type === 'page' &&
                typeof item.url === 'string' &&
                item.url.includes('/workbench.html') &&
                item.webSocketDebuggerUrl
            );
        } catch (_) {
            // Electron may publish its DevTools target after the extension host starts.
        }
        if (!target) await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!target) throw new Error('VS Code workbench DevTools target was not published');

    const socket = await openSocket(target.webSocketDebuggerUrl, Math.min(3000, deadline - Date.now()));
    const cdp = createCdp(socket, 3000);
    return { socket, ...cdp };
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
    const deadline = Date.now() + 5000;
    let widget = null;
    while (Date.now() < deadline) {
        const response = await devTools.call('Runtime.evaluate', {
            expression: `(() => {
                const queryAllDeep = selector => {
                    const matches = [];
                    const roots = [document];
                    for (const root of roots) {
                        matches.push(...root.querySelectorAll(selector));
                        for (const element of root.querySelectorAll('*')) {
                            if (element.shadowRoot) roots.push(element.shadowRoot);
                            if (String(element.tagName || '').toUpperCase() === 'IFRAME') {
                                try {
                                    if (element.contentDocument) roots.push(element.contentDocument);
                                } catch (_) {
                                    // Cross-origin frames are outside the VS Code workbench DOM.
                                }
                            }
                        }
                    }
                    return matches;
                };
                const isVisible = element => {
                    if (!element || element.nodeType !== 1 ||
                        typeof element.getBoundingClientRect !== 'function') return false;
                    const rect = element.getBoundingClientRect();
                    const view = element.ownerDocument && element.ownerDocument.defaultView;
                    const style = view && view.getComputedStyle(element);
                    return rect.width > 0 && rect.height > 0 &&
                        style && style.display !== 'none' && style.visibility !== 'hidden';
                };
                for (const element of queryAllDeep('.action-widget').filter(isVisible)) {
                    const rows = Array.from(
                        element.querySelectorAll('.monaco-list-row.action')
                    ).filter(isVisible).map(row =>
                        String(row.textContent || '').trim()
                    );
                    if (rows.length > 0) {
                        return {
                            text: String(element.textContent || '').trim(),
                            rows
                        };
                    }
                }
                return null;
            })()`,
            returnByValue: true,
        });
        widget = response.result ? response.result.value : null;
        if (widget && widget.rows.length > 0) return widget;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    await captureRendererDiagnostic(devTools, 'code-action-widget');
    throw new Error(
        `Renderer Code Action widget did not become ready: ${JSON.stringify(widget)}`,
    );
}

async function waitForRendererRefactorPreview(devTools) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        const response = await devTools.call('Runtime.evaluate', {
            expression: `Array.from(document.querySelectorAll('.bulk-edit-panel[data-state="data"]'))
                .some(element => element.offsetParent !== null && element.querySelector('.monaco-list-row'))`,
            returnByValue: true,
        });
        if (response.result?.value === true) return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    await captureRendererDiagnostic(devTools, 'refactor-preview');
    throw new Error('Refactor preview did not finish loading its proposed edits');
}

async function getRendererMenuItemState(devTools, expectedKeybinding) {
    if (process.platform === 'darwin') {
        const label = { 'Ctrl+V': 'Paste', 'Ctrl+X': 'Cut' }[expectedKeybinding];
        return require('../../../support/editor-safety/native-menu.cjs')(label);
    }
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
    // These editor shortcuts use Command on macOS; Ctrl+Space remains Control.
    if (process.platform === 'darwin' && (modifiers & 2) && ['KeyA', 'KeyZ', 'Slash', 'Enter'].includes(code))
        modifiers = (modifiers & ~2) | 4;
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
            const queryAllDeep = query => {
                const matches = [];
                const roots = [document];
                for (const root of roots) {
                    matches.push(...root.querySelectorAll(query));
                    for (const element of root.querySelectorAll('*')) {
                        if (element.shadowRoot) roots.push(element.shadowRoot);
                        if (String(element.tagName || '').toUpperCase() === 'IFRAME') {
                            try {
                                if (element.contentDocument) roots.push(element.contentDocument);
                            } catch (_) {
                                // Cross-origin frames are outside the VS Code workbench DOM.
                            }
                        }
                    }
                }
                return matches;
            };
            const elements = queryAllDeep(${JSON.stringify(selector)});
            const element = elements.find(candidate => {
                if (!candidate || candidate.nodeType !== 1 ||
                    typeof candidate.getBoundingClientRect !== 'function') return false;
                const rect = candidate.getBoundingClientRect();
                const view = candidate.ownerDocument && candidate.ownerDocument.defaultView;
                const style = view && view.getComputedStyle(candidate);
                return rect.width > 0 && rect.height > 0 &&
                    style && style.display !== 'none' && style.visibility !== 'hidden';
            });
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            let x = rect.left + rect.width / 2;
            let y = rect.top + rect.height / 2;
            let view = element.ownerDocument && element.ownerDocument.defaultView;
            while (view && view !== window) {
                let frame;
                try {
                    frame = view.frameElement;
                } catch (_) {
                    return null;
                }
                if (!frame) return null;
                const frameRect = frame.getBoundingClientRect();
                x += frameRect.left + Number(frame.clientLeft || 0);
                y += frameRect.top + Number(frame.clientTop || 0);
                view = frame.ownerDocument && frame.ownerDocument.defaultView;
            }
            return {
                x,
                y,
                text: String(element.textContent || '').trim()
            };
        })()`,
        returnByValue: true,
    });
    const point = response.result ? response.result.value : null;
    if (!point) throw new Error(`Visible renderer element not found: ${selector}`);
    return point;
}

async function getRendererVisibleTextElementCenter(
    devTools,
    selector,
    textFragment,
    startsWith = false,
) {
    const response = await devTools.call('Runtime.evaluate', {
        expression: `(() => {
            const queryAllDeep = query => {
                const matches = [];
                const roots = [document];
                for (const root of roots) {
                    matches.push(...root.querySelectorAll(query));
                    for (const element of root.querySelectorAll('*')) {
                        if (element.shadowRoot) roots.push(element.shadowRoot);
                        if (String(element.tagName || '').toUpperCase() === 'IFRAME') {
                            try {
                                if (element.contentDocument) roots.push(element.contentDocument);
                            } catch (_) {}
                        }
                    }
                }
                return matches;
            };
            const expected = ${JSON.stringify(String(textFragment))};
            const elements = queryAllDeep(${JSON.stringify(selector)});
            const element = elements.find(candidate => {
                if (!candidate || candidate.nodeType !== 1 ||
                    typeof candidate.getBoundingClientRect !== 'function') return false;
                const rect = candidate.getBoundingClientRect();
                const view = candidate.ownerDocument && candidate.ownerDocument.defaultView;
                const style = view && view.getComputedStyle(candidate);
                const text = String(candidate.textContent || '').trim() || candidate.getAttribute('aria-label') || candidate.getAttribute('title') || '';
                const textMatches = ${startsWith ? 'text.startsWith(expected)' : 'text.includes(expected)'};
                return textMatches && rect.width > 0 && rect.height > 0 &&
                    style && style.display !== 'none' && style.visibility !== 'hidden';
            });
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            let x = rect.left + rect.width / 2;
            let y = rect.top + rect.height / 2;
            let view = element.ownerDocument && element.ownerDocument.defaultView;
            while (view && view !== window) {
                let frame;
                try { frame = view.frameElement; } catch (_) { return null; }
                if (!frame) return null;
                const frameRect = frame.getBoundingClientRect();
                x += frameRect.left + Number(frame.clientLeft || 0);
                y += frameRect.top + Number(frame.clientTop || 0);
                view = frame.ownerDocument && frame.ownerDocument.defaultView;
            }
            return { x, y, text: String(element.textContent || '').trim() };
        })()`,
        returnByValue: true,
    });
    return response.result ? response.result.value : null;
}

async function waitForRendererVisibleTextElementCenter(
    devTools,
    selector,
    textFragment,
    startsWith = false,
    timeoutMs = 5000,
) {
    const deadline = Date.now() + timeoutMs;
    let point = null;
    while (Date.now() < deadline) {
        point = await getRendererVisibleTextElementCenter(
            devTools,
            selector,
            textFragment,
            startsWith,
        );
        if (point) return point;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    await captureRendererDiagnostic(
        devTools,
        `visible-text-${String(textFragment).replace(/[^a-z0-9]+/gi, '-')}`,
    );
    throw new Error(
        `Visible renderer text element did not appear: ${selector} / ${textFragment}; ` +
        JSON.stringify(point),
    );
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
                        x: Math.ceil(rect.left),
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
        name,
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

async function executeDetailedHover(document, position, expectedFragment) {
    // These assertions cover expanded engineering help, available through More.
    // The compact registered hover and actual rendered UI are checked separately below.
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    const { LsdynaFieldHoverProvider } = require(path.join(extension.extensionPath, 'out/extension'))._internals;
    const hovers = [await new LsdynaFieldHoverProvider().provideDetailedHover(document, position)];
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
    const error = new Error('System clipboard did not retain the test text after five write/read attempts');
    error.code = 'LSDYNA_CLIPBOARD_UNAVAILABLE';
    throw error;
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

async function runInlineEditChoice(commandFactory, expectedRowFragment, commands) {
    const devTools = await connectWorkbenchDevTools();
    try {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await commandFactory();
        const widget = await waitForRendererSuggestionWidget(devTools);
        assert.ok(
            widget.rows.some(row => row.includes(expectedRowFragment)),
            `Inline edit choices did not show ${JSON.stringify(expectedRowFragment)}: ${JSON.stringify(widget.rows)}`,
        );
        for (const command of commands) {
            await vscode.commands.executeCommand(command);
            await new Promise(resolve => setTimeout(resolve, 75));
        }
        await new Promise(resolve => setTimeout(resolve, 125));
    } finally {
        devTools.close();
    }
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

async function closeManagerAndFocusDocument(document) {
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            if (tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes("lsdynaKeywordManager")) {
                assert.equal(await vscode.window.tabGroups.close(tab, true), true);
            }
        }
    }
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One, false);
    await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
}

function keywordManagerProductApi() {
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    assert.ok(extension?.isActive);
    const productApi = createRequire(path.join(extension.extensionPath, 'out/extension.js'))('vscode');
    assert.strictEqual(productApi, createRequire(path.join(extension.extensionPath, 'out/core/i18n.js'))('vscode'));
    return productApi;
}

async function discardKeywordManagerDraft(document, original, workspaceBefore) {
    const productApi = keywordManagerProductApi();
    const api = require(path.join(vscode.extensions.getExtension('hqyyqh.dynasense').extensionPath, 'out/extension'))._internals;
    const { document: discardDocument } = await openFixture('option-title-other-condition.key');
    const discardOriginal = discardDocument.getText();
    const managerI18n = require(path.join(vscode.extensions.getExtension('hqyyqh.dynasense').extensionPath, 'out/core/i18n'));
    const originalShowWarningMessage = productApi.window.showWarningMessage;
    const originalDiscardApplyEdit = productApi.workspace.applyEdit;
    let discardPrompts = 0;
    let discardApplyAttempts = 0;
    try {
        // Simulate one explicit Discard choice; retain the actual guarded transition.
        productApi.window.showWarningMessage = async (message, options, ...choices) => {
            assert.strictEqual(++discardPrompts, 1);
            assert.strictEqual(message, managerI18n.get('keywordManagerDiscardDraftWarning', 1));
            assert.deepStrictEqual(options, { modal: true });
            assert.deepStrictEqual(choices, [managerI18n.get('keywordOptionsApply'), managerI18n.get('keywordManagerDiscardDraftConfirm')]);
            return choices[1];
        };
        productApi.workspace.applyEdit = function (...args) {
            discardApplyAttempts++;
            return originalDiscardApplyEdit.apply(this, args);
        };
        const discarded = await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions', 1);
        assert.ok(discarded);
        assert.strictEqual(discardPrompts, 1);
        assert.strictEqual(discardApplyAttempts, 0);
        assert.strictEqual(discarded.sourceDocument, discardDocument);
        assert.strictEqual(discarded.uri, discardDocument.uri.toString(true));
        assert.strictEqual(discarded.documentVersion, discardDocument.version);
        assert.notStrictEqual(discarded.stale, true);
        assert.strictEqual(discarded.targetKeyword, discarded.currentKeyword);
        assert.strictEqual(api.buildKeywordOptionsViewState(discarded).hasDrafts, false);
        assert.strictEqual(discardDocument.getText(), discardOriginal);
        assert.strictEqual(discardDocument.isDirty, false);
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        console.log(JSON.stringify({ name: 'alias-explicit-discard-transition', simulatedChoice: true, prompts: discardPrompts, workspaceApplyEditAttempts: discardApplyAttempts }));
    } finally {
        productApi.window.showWarningMessage = originalShowWarningMessage;
        productApi.workspace.applyEdit = originalDiscardApplyEdit;
    }
    return { discardDocument, discardOriginal };
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
        const compact = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, item.position);
        assert.ok(compact.some(hover => hoverMarkdown(hover).includes('command:extension.hoverMore')));
        assert.ok(compact.every(hover => !hoverMarkdown(hover).includes('Current-file source definition')));
        const hover = await executeDetailedHover(document, item.position, 'Current-file source definition');
        const markdown = hoverMarkdown(hover);
        assert.ok(markdown.includes('`7`'));
        assert.strictEqual(document.getText(hover.range), item.rangeText);
        assert.ok(!markdown.includes('complete project scan is unavailable'));
    }

    const unresolved = await executeDetailedHover(
        document,
        new vscode.Position(7, 5),
        'complete project scan is unavailable',
    );
    assert.strictEqual(document.getText(unresolved.range), '&UNKNOWN');

    const parameterKeyword = await executeDetailedHover(
        document,
        new vscode.Position(1, 4),
        'PARAMETER_MUTABLE_NOECHO_LOCAL',
    );
    const parameterKeywordMarkdown = hoverMarkdown(parameterKeyword);
    assert.ok(parameterKeywordMarkdown.includes('PRMR1'));
    assert.ok(parameterKeywordMarkdown.includes('Keyword options'));
    assert.ok(parameterKeywordMarkdown.includes('command:extension.selectKeyword'));

    const includeHover = await executeDetailedHover(
        document,
        new vscode.Position(9, 4),
        'command:extension.openIncludeNewTab',
    );
    const includeMarkdown = hoverMarkdown(includeHover);
    assert.strictEqual(document.getText(includeHover.range), 'Sub/Part.key');
    assert.ok(includeMarkdown.includes('command:extension.openIncludeSplit'));
    assert.ok(includeMarkdown.includes('command:extension.openIncludeFolder'));

    const missingInclude = await executeDetailedHover(
        document,
        new vscode.Position(11, 4),
        '$(symbol-field)',
    );
    const missingIncludeMarkdown = hoverMarkdown(missingInclude);
    assert.ok(missingIncludeMarkdown.includes('FILENAME'));
    assert.ok(!missingIncludeMarkdown.includes('command:extension.openIncludeNewTab'));

    const nodeKeyword = await executeDetailedHover(
        document,
        new vscode.Position(12, 2),
        '$(symbol-keyword)',
    );
    const nodeKeywordMarkdown = hoverMarkdown(nodeKeyword);
    assert.ok(nodeKeywordMarkdown.includes('**\\*NODE**'));
    assert.ok(nodeKeywordMarkdown.includes('command:extension.lsdynaFormatSelection'));

    const nodeField = await executeDetailedHover(
        document,
        new vscode.Position(13, 2),
        '$(symbol-field)',
    );
    assert.strictEqual(document.getText(nodeField.range).length, 8);
    assert.ok(hoverMarkdown(nodeField).includes('NID'));

    const unknownKeyword = await executeDetailedHover(
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
            assert.ok(!renderedText.includes('Current-file source definition'));
            assert.ok(!renderedText.includes('complete project scan is unavailable'));
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
    let devTools = null, scenarioError;

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
        if (process.platform === 'darwin') await require('../../../support/editor-safety/native-menu.cjs')('Focus', true);
        await dispatchRendererMouseClick(devTools, pasteClickPoint, 0, 'right');
        const pasteMenuPoint = await waitForRendererMenuItem(devTools, 'Ctrl+V');
        assert.deepStrictEqual(
            selectionRangeShape(editor.selection),
            pasteSelectionBeforeMenu,
        );
        await new Promise(resolve => setTimeout(resolve, 150));
        if (pasteMenuPoint.nativeItem) await require('../../../support/editor-safety/native-menu.cjs')(pasteMenuPoint.nativeItem, true);
        else await dispatchRendererMouseClick(devTools, pasteMenuPoint);
        try {
            // Renderer text and the Extension Host TextDocument are updated on
            // separate IPC turns. Busy startup notifications can make the old
            // fixed 100 ms sample observe stale model text even after the real
            // menu action has visibly applied.
            await waitForAssertion(() => {
                assert.notStrictEqual(document.getText(), original);
            }, 1500);
        } catch (_error) {
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
        if (process.platform === 'darwin') await require('../../../support/editor-safety/native-menu.cjs')('Focus', true);
        await dispatchRendererMouseClick(devTools, cutClickPoint, 0, 'right');
        const cutMenuPoint = await waitForRendererMenuItem(devTools, 'Ctrl+X');
        assert.deepStrictEqual(
            selectionRangeShape(editor.selection),
            cutSelectionBeforeMenu,
        );
        await new Promise(resolve => setTimeout(resolve, 150));
        if (cutMenuPoint.nativeItem) await require('../../../support/editor-safety/native-menu.cjs')(cutMenuPoint.nativeItem, true);
        else await dispatchRendererMouseClick(devTools, cutMenuPoint);
        await settleCardCellPostEdit(document);
        await waitForAssertion(() => {
            const changedLine = document.lineAt(2).text;
            assert.strictEqual(changedLine.length, originalLine.length);
            assert.strictEqual(changedLine.slice(8, 24).trim(), '14');
            assert.strictEqual(changedLine.slice(24), originalLine.slice(24));
            assert.strictEqual(document.isDirty, true);
        });
        // The native clipboard can settle one IPC turn after the TextDocument
        // cut edit. Keep this bounded and still require the exact selected text.
        await waitForAssertion(async () => {
            assert.strictEqual(await vscode.env.clipboard.readText(), '23');
        }, 1500);
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
    } catch (error) {
        scenarioError = error; throw error;
    } finally {
        try {
            if (devTools) {
                try {
                    // A native macOS menu does not receive renderer CDP key events.
                    if (process.platform === 'darwin') await require('../../../support/editor-safety/native-menu.cjs')('Escape', true);
                    else await dispatchRendererKey(devTools, 'Escape', 'Escape', 27);
                } catch (error) {
                    if (!scenarioError) throw error;
                    scenarioError.cleanupError = error;
                    console.error('Native menu cleanup failed after scenario failure:', error);
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

async function assertAdjacentFieldMergeIsChosenAndUndoable() {
    // An unverified field layout must use ordinary Backspace, never merge adjacent values.
    const unverified = await openFixture('merge-fields-unverified.key');
    const untouched = unverified.document.getText();
    unverified.editor.selection = new vscode.Selection(5, 77, 5, 77);
    await vscode.commands.executeCommand('extension.lsdynaCellDeleteLeft');
    const offset = unverified.document.offsetAt(new vscode.Position(5, 76));
    assert.equal(unverified.document.getText(), untouched.slice(0, offset) + untouched.slice(offset + 1));
    await vscode.commands.executeCommand('undo');
    assert.equal(unverified.document.getText(), untouched);
    assert.equal(unverified.document.isDirty, false);
    const { document, editor } = await openFixture('merge-fields.key');
    const original = document.getText();
    const sourceLine = document.lineAt(5).text;
    assert.strictEqual(sourceLine.slice(60, 70).trim(), '95200');
    assert.strictEqual(sourceLine.slice(70, 80).trim(), '501');

    editor.selection = new vscode.Selection(5, 77, 5, 77);
    await runInlineEditChoice(
        () => vscode.commands.executeCommand('extension.lsdynaCellDeleteLeft'),
        '95200501',
        ['extension.lsdynaCancelInlineEditChoice'],
    );
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    await runInlineEditChoice(
        () => vscode.commands.executeCommand('extension.lsdynaCellDeleteLeft'),
        '95200501',
        ['selectNextSuggestion', 'acceptSelectedSuggestion'],
    );
    assert.strictEqual(document.lineAt(5).text.slice(60, 70).trim(), '95200501');
    assert.strictEqual(document.lineAt(5).text.slice(70, 80).trim(), '');
    assert.strictEqual(document.lineAt(5).text.slice(0, 60), sourceLine.slice(0, 60));

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

}

async function assertRendererInlineChoiceCancelKeysPreserveSource() {
    const { document, editor } = await openFixture('merge-fields.key');
    const original = document.getText();
    const devTools = await connectWorkbenchDevTools();
    const keys = [
        ['Backspace', 'Backspace', 8],
        ['Delete', 'Delete', 46],
        ['Escape', 'Escape', 27],
    ];
    try {
        for (const [key, code, virtualKeyCode] of keys) {
            editor.selection = new vscode.Selection(5, 77, 5, 77);
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
            await waitForRendererEditorFocus(devTools);
            await new Promise(resolve => setTimeout(resolve, 100));
            await vscode.commands.executeCommand('extension.lsdynaCellDeleteLeft');
            const widget = await waitForRendererSuggestionWidget(devTools);
            assert.ok(widget.rows.some(row => row.includes('95200501')));

            await dispatchRendererKey(devTools, key, code, virtualKeyCode);
            await waitForAssertion(async () => {
                const currentWidget = await getRendererSuggestionWidget(devTools);
                assert.ok(!currentWidget || currentWidget.rows.length === 0);
                assert.strictEqual(document.getText(), original, key);
                assert.strictEqual(document.isDirty, false, key);
            });
        }
    } finally {
        devTools.close();
    }
}

async function assertRendererCompletionBackspaceKeepsFixedColumns() {
    const { document, editor } = await openFixture('fixed.key');
    const original = document.getText();
    const originalLine = document.lineAt(2).text;
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    const devTools = await connectWorkbenchDevTools();
    try {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await vscode.commands.executeCommand('editor.action.triggerSuggest');
        await waitForRendererSuggestionWidget(devTools);

        await dispatchRendererKey(devTools, 'Backspace', 'Backspace', 8);
        await waitForAssertion(() => {
            const changed = document.lineAt(2).text;
            assert.strictEqual(changed.slice(0, 8), originalLine.slice(0, 8));
            assert.strictEqual(changed.slice(8, 24).trim(), '');
            assert.strictEqual(changed.slice(24), originalLine.slice(24));
        });

        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
    } finally {
        devTools.close();
    }
}

async function assertEmptyFieldTypingAlignsWithoutTab() {
    const { document, editor } = await openFixture('empty-field-input.key');
    const original = document.getText();
    const sourceLine = document.lineAt(4).text;
    assert.strictEqual(sourceLine.length, 70);
    editor.selection = new vscode.Selection(4, 70, 4, 70);
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    const guard = extension.exports._internals.ensureCardCellEditGuard();
    const boundaryTarget = guard.getEmptyCellTypeTarget(document, editor.selection, '9');
    assert.ok(boundaryTarget, 'shared-boundary target should resolve');
    assert.strictEqual(boundaryTarget.fieldIndex, 7);
    assert.strictEqual(boundaryTarget.ambiguousPreviousFieldIndex, 6);
    guard.markAp(document, 4, 6, 70);

    let typed = '9';
    await runInlineEditChoice(
        () => vscode.commands.executeCommand('type', { text: typed }),
        'Write next field',
        ['selectNextSuggestion', 'acceptSelectedSuggestion'],
    );
    await waitForAssertion(() => {
        assert.strictEqual(document.lineAt(4).text.slice(70, 80).trim(), typed);
        assert.strictEqual(document.lineAt(4).text.slice(0, 70), sourceLine);
    });

    for (const character of '6200301') {
        typed += character;
        await vscode.commands.executeCommand('type', { text: character });
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(4).text.slice(70, 80).trim(), typed);
            assert.strictEqual(document.lineAt(4).text.slice(0, 70), sourceLine);
        });
    }

    assert.strictEqual(document.lineAt(4).text.slice(70, 80), '  96200301');
    assert.strictEqual(editor.selection.active.character, 80);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    // Keep accepting fast numeric input while the original suggestion widget is
    // open; once the previous field overflows, the next-field meaning is unique.
    editor.selection = new vscode.Selection(4, 70, 4, 70);
    await vscode.commands.executeCommand('type', { text: '9' });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.strictEqual(document.getText(), original);
    await vscode.commands.executeCommand('type', { text: '6' });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.strictEqual(document.getText(), original);
    await vscode.commands.executeCommand('type', { text: '2' });
    await waitForAssertion(() => {
        assert.strictEqual(document.lineAt(4).text.slice(70, 80).trim(), '962');
        assert.strictEqual(document.lineAt(4).text.slice(0, 70), sourceLine);
    });

    let fastTyped = '962';
    for (const character of '00301') {
        fastTyped += character;
        await vscode.commands.executeCommand('type', { text: character });
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(4).text.slice(70, 80).trim(), fastTyped);
            assert.strictEqual(document.lineAt(4).text.slice(0, 70), sourceLine);
        });
    }
    assert.strictEqual(document.lineAt(4).text.slice(70, 80), '  96200301');
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

}

async function assertLargeNodeBlockKeepsSchemaAfterEdit() {
    const { document, editor } = await openFixture('large-node-edit.key');
    const original = document.getText();
    assert.ok(document.lineCount > 100_000);
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    const internals = extension.exports._internals;
    const endLine = document.lineCount - 2;
    internals.setFileIndexForTesting(document.uri.fsPath, {
        keywordBlocks: [
            { keyword: '*KEYWORD', startLine: 0, endLine: 0 },
            { keyword: '*NODE', startLine: 1, endLine: endLine - 1 },
            { keyword: '*END', startLine: endLine, endLine },
        ],
    });

    try {
        const editLine = 6002;
        const oldEditLine = document.lineAt(editLine).text;
        await editor.edit(builder => builder.replace(
            new vscode.Range(editLine, 7, editLine, 8),
            oldEditLine.slice(7, 8) === '1' ? '2' : '1',
        ));
        await new Promise(resolve => setTimeout(resolve, 100));

        const targetLine = 90_000;
        const targetText = document.lineAt(targetLine).text;
        editor.selection = new vscode.Selection(targetLine, 0, targetLine, 0);
        await vscode.commands.executeCommand('extension.lsdynaTab');

        assert.strictEqual(document.lineAt(targetLine).text, targetText);
        assert.ok(!document.lineAt(targetLine).text.includes('\t'));
        assert.strictEqual(editor.selection.start.line, targetLine);
        assert.strictEqual(editor.selection.start.character, 9);
        assert.strictEqual(editor.selection.end.character, 24);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    } finally {
        internals.setFileIndexForTesting(document.uri.fsPath, null);
    }
}

async function assertOverlappingSchemaTabAndFormatAreByteStable() {
    const { document, editor } = await openFixture('overlapping-schema.key');
    const original = document.getText();
    const originalLine = document.lineAt(3).text;

    editor.selection = new vscode.Selection(3, 0, 3, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    assert.strictEqual(document.lineAt(3).text, originalLine);
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    await vscode.commands.executeCommand('extension.lsdynaShiftTab');
    assert.strictEqual(document.lineAt(3).text, originalLine);
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    editor.selection = new vscode.Selection(3, 0, 3, originalLine.length);
    await vscode.commands.executeCommand('extension.lsdynaFormatSelection');
    assert.strictEqual(document.lineAt(3).text, originalLine);
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertRendererTabKeepsSnippetPlaceholderNavigation() {
    const { document, editor } = await openFixture('snippet-tab.key');
    const original = document.getText();
    const position = new vscode.Position(2, 0);
    editor.selection = new vscode.Selection(position, position);
    const inserted = await editor.insertSnippet(
        new vscode.SnippetString('${1:11111111}${2:22222222}'),
        editor.selection,
    );
    assert.strictEqual(inserted, true);
    assert.strictEqual(document.lineAt(2).text, '1111111122222222');
    assert.strictEqual(editor.selection.start.character, 0);
    assert.strictEqual(editor.selection.end.character, 8);

    const devTools = await connectWorkbenchDevTools();
    try {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await dispatchRendererKey(devTools, 'Tab', 'Tab', 9);
        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(2).text, '1111111122222222');
            assert.strictEqual(editor.selection.start.character, 8);
            assert.strictEqual(editor.selection.end.character, 16);
        });

        await dispatchRendererKey(devTools, 'Escape', 'Escape', 27);
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
    } finally {
        devTools.close();
    }
}

async function assertRendererMultiLineSelectionUsesNativeTab() {
    const { document, editor } = await openFixture('renderer-multi.key');
    const original = document.getText();
    const firstLine = document.lineAt(2).text;
    const secondLine = document.lineAt(3).text;
    editor.options = { ...editor.options, insertSpaces: true, tabSize: 4 };
    editor.selection = new vscode.Selection(2, 0, 3, 12);

    const devTools = await connectWorkbenchDevTools();
    try {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await waitForRendererEditorFocus(devTools);
        await new Promise(resolve => setTimeout(resolve, 100));
        await dispatchRendererKey(devTools, 'Tab', 'Tab', 9);
        await waitForAssertion(() => {
            // Both source rows begin at visual column 7, so native indentation
            // advances them by one space to the next configured tab stop.
            assert.strictEqual(document.lineAt(2).text, ` ${firstLine}`);
            assert.strictEqual(document.lineAt(3).text, ` ${secondLine}`);
            assert.strictEqual(document.isDirty, true);
        });

        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
    } finally {
        devTools.close();
    }
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
        assert.strictEqual(document.lineAt(2).text, '', command);

        await vscode.commands.executeCommand(command);
        assert.strictEqual(document.lineCount, 4, command);
        assert.notStrictEqual(document.getText(), emptyRowText, command);

        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), emptyRowText, command);
        assert.strictEqual(document.lineAt(2).text, '', command);

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

async function assertVerifiedKeywordAliasIsTransactional() {
    const productApi = keywordManagerProductApi();
    console.log(JSON.stringify({ name: 'keyword-manager-product-api-identity', sameDriverApi: productApi === vscode,
        sameDriverWindow: productApi.window === vscode.window, sameDriverWorkspace: productApi.workspace === vscode.workspace,
        installedExtensionId: vscode.extensions.getExtension('hqyyqh.dynasense').id, repeatedProductApiEqual: true }));
    const { document: unresolvedDocument, editor: unresolvedEditor } = await openFixture('option-title-unresolved.key');
    const unresolvedOriginal = unresolvedDocument.getText();
    const unresolvedWorkspace = workspaceSnapshot();
    unresolvedEditor.selection = new vscode.Selection(1, 0, 1, 0);
    const unresolvedModel = await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions', 1);
    assert.strictEqual(unresolvedModel.plan.status, 'blocked');
    assert.strictEqual(unresolvedModel.plan.reason, 'lspp-input-form-source-layout-unresolved');
    await vscode.window.showTextDocument(unresolvedDocument, { preserveFocus: false, preview: false });
    const unresolvedStage = await vscode.commands.executeCommand('extension.keywordOptions.stage', 'spelling:*MAT_ELASTIC');
    assert.ok(unresolvedStage, 'Unresolved alias must be staged against the active source document');
    assert.strictEqual(unresolvedStage.uri, unresolvedDocument.uri.toString(true));
    assert.strictEqual(unresolvedStage.sourceDocument, unresolvedDocument);
    assert.strictEqual(unresolvedStage.documentVersion, unresolvedDocument.version);
    assert.notStrictEqual(unresolvedStage.stale, true);
    assert.strictEqual(unresolvedStage.currentKeyword, '*MAT_001');
    assert.strictEqual(unresolvedStage.targetKeyword, '*MAT_ELASTIC');
    assert.strictEqual(unresolvedStage.plan.status, 'blocked');
    assert.strictEqual(unresolvedStage.plan.reason, 'lspp-input-form-source-layout-unresolved');
    const originalApplyEdit = productApi.workspace.applyEdit;
    let unresolvedApplyAttempts = 0;
    productApi.workspace.applyEdit = function (...args) {
        unresolvedApplyAttempts++;
        return originalApplyEdit.apply(this, args);
    };
    try {
        const unresolvedApply = await vscode.commands.executeCommand('extension.keywordOptions.apply');
        console.log(JSON.stringify({
            name: 'unresolved-alias-apply-context',
            result: unresolvedApply,
            activeUri: vscode.window.activeTextEditor?.document.uri.toString() || null,
            sourceUri: unresolvedDocument.uri.toString(),
            sourceVersion: unresolvedDocument.version,
            stage: unresolvedStage ? {
                uri: unresolvedStage.uri,
                documentVersion: unresolvedStage.documentVersion,
                stale: unresolvedStage.stale,
                targetKeyword: unresolvedStage.targetKeyword,
                planStatus: unresolvedStage.plan?.status,
                planReason: unresolvedStage.plan?.reason,
            } : null,
        }));
        assert.ok(unresolvedApply === false || unresolvedApply === null,
            'Unresolved source must reject Apply with the command refusal contract');
        assert.strictEqual(unresolvedApplyAttempts, 0,
            'Unresolved source must not attempt a WorkspaceEdit');
    } finally {
        productApi.workspace.applyEdit = originalApplyEdit;
    }
    assert.strictEqual(unresolvedDocument.getText(), unresolvedOriginal);
    assert.strictEqual(unresolvedDocument.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), unresolvedWorkspace);
    const resetModel = await vscode.commands.executeCommand('extension.keywordOptions.reset');
    assert.ok(resetModel, 'Reset must reload the unresolved source without switching documents');
    assert.strictEqual(resetModel.targetKeyword, resetModel.currentKeyword);
    const managerApi = require(path.join(vscode.extensions.getExtension('hqyyqh.dynasense').extensionPath, 'out/extension'))._internals;
    assert.strictEqual(managerApi.buildKeywordOptionsViewState(resetModel).hasDrafts, false);
    assert.strictEqual(unresolvedDocument.getText(), unresolvedOriginal);
    assert.strictEqual(unresolvedDocument.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), unresolvedWorkspace);
    await closeManagerAndFocusDocument(unresolvedDocument);

    const { document, editor } = await openFixture('option-title.key');
    const original = document.getText();
    const otherFilesBefore = workspaceSnapshot();
    editor.selection = new vscode.Selection(1, 0, 1, 0);

    const openedModel = await vscode.commands.executeCommand(
        'extension.lsdynaChooseKeywordOptions',
        1,
    );
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), otherFilesBefore);

    assert.ok(!openedModel.choices.some(choice => choice.targetKeyword === '*MAT_001_TITLE' && choice.enabled),
        'TITLE is a native form control, not an equivalent-spelling choice');
    const rejected = await vscode.commands.executeCommand('extension.keywordOptions.stage', 'spelling:*MAT_001_TITLE');
    assert.equal(rejected, null);
    assert.equal(document.getText(), original);
    assert.equal(document.isDirty, false);
    const staged = await vscode.commands.executeCommand(
        'extension.keywordOptions.stage',
        'spelling:*MAT_ELASTIC',
    );
    assert.ok(staged, 'Keyword Manager did not retain the verified alias target');
    assert.strictEqual(staged.targetKeyword, '*MAT_ELASTIC');
    const originalVerifiedApplyEdit = productApi.workspace.applyEdit;
    let verifiedApplyAttempts = 0;
    let verifiedEdit = null;
    let applied;
    try {
        productApi.workspace.applyEdit = function (edit, ...args) {
            verifiedApplyAttempts++;
            verifiedEdit = edit;
            return originalVerifiedApplyEdit.call(this, edit, ...args);
        };
        applied = await vscode.commands.executeCommand('extension.keywordOptions.apply');
        assert.strictEqual(verifiedApplyAttempts, 1, 'The product WorkspaceEdit observer must see the successful alias transaction');
        assert.strictEqual(applied?.edit, verifiedEdit);
        console.log(JSON.stringify({ name: 'alias-product-workspace-edit-observer', successfulApplyAttempts: verifiedApplyAttempts,
            unresolvedApplyAttempts, targetUris: verifiedEdit.entries().map(([uri]) => uri.toString()) }));
    } finally {
        productApi.workspace.applyEdit = originalVerifiedApplyEdit;
    }
    assert.ok(applied, 'Keyword Manager rejected a current, writable alias plan in the real Extension Host');
    assert.strictEqual(applied.plan.targetKeyword, '*MAT_ELASTIC');
    const editEntries = applied.edit.entries();
    assert.strictEqual(editEntries.length, 1);
    assert.strictEqual(editEntries[0][0].toString(), document.uri.toString());
    assert.ok(editEntries[0][1][0].newText.startsWith('*MAT_ELASTIC'));
    await waitForAssertion(() => {
        assert.strictEqual(document.lineAt(1).text, '*MAT_ELASTIC');
        assert.strictEqual(document.lineAt(2).text, original.split('\r\n')[2]);
        assert.strictEqual(document.getText(), original.replace('*MAT_001', '*MAT_ELASTIC'));
    });

    const undoDevTools = await connectWorkbenchDevTools();
    try {
        await closeManagerAndFocusDocument(document);
        await waitForRendererEditorFocus(undoDevTools);
        await dispatchRendererKey(undoDevTools, 'z', 'KeyZ', 90, 2);
    } finally {
        undoDevTools.close();
    }
    await waitForAssertion(() => {
        assert.strictEqual(document.getText(), original);
    });
    assert.strictEqual(document.isDirty, false);

    assert.deepStrictEqual(workspaceSnapshot(), otherFilesBefore);
    const { discardDocument, discardOriginal } = await discardKeywordManagerDraft(document, original, otherFilesBefore);
    await closeManagerAndFocusDocument(document);
    const currentEditor = await vscode.window.showTextDocument(document, { preserveFocus: false, preview: false });
    assert.strictEqual(currentEditor.document, document);
    const currentModel = await vscode.commands.executeCommand(
        'extension.lsdynaChooseKeywordOptions',
        1,
    );
    assert.ok(currentModel);
    assert.notStrictEqual(currentModel, staged);
    assert.strictEqual(currentModel.sourceDocument, document);
    assert.strictEqual(currentModel.uri, document.uri.toString(true));
    assert.strictEqual(currentModel.documentVersion, document.version);
    assert.notStrictEqual(currentModel.stale, true);
    assert.strictEqual(currentModel.targetKeyword, currentModel.currentKeyword);
    assert.strictEqual(managerApi.buildKeywordOptionsViewState(currentModel).hasDrafts, false);
    const concurrentStage = await vscode.commands.executeCommand('extension.keywordOptions.stage', 'spelling:*MAT_ELASTIC');
    assert.ok(concurrentStage);
    assert.strictEqual(concurrentStage.sourceDocument, document);
    assert.strictEqual(concurrentStage.uri, document.uri.toString(true));
    assert.strictEqual(concurrentStage.documentVersion, document.version);
    assert.notStrictEqual(concurrentStage.stale, true);
    assert.strictEqual(concurrentStage.targetKeyword, '*MAT_ELASTIC');
    assert.strictEqual(concurrentStage.plan.status, 'ready');
    await currentEditor.edit(editBuilder => {
        editBuilder.insert(new vscode.Position(0, 0), '$ concurrent engineer edit\r\n');
    });
    const afterConcurrentEdit = document.getText();
    await waitForAssertion(() => assert.strictEqual(concurrentStage.stale, true));
    const originalStaleApplyEdit = productApi.workspace.applyEdit;
    let staleApplyAttempts = 0;
    try {
        productApi.workspace.applyEdit = function (...args) {
            staleApplyAttempts++;
            return originalStaleApplyEdit.apply(this, args);
        };
        assert.strictEqual(await vscode.commands.executeCommand('extension.keywordOptions.apply'), false);
        assert.strictEqual(staleApplyAttempts, 0);
    } finally {
        productApi.workspace.applyEdit = originalStaleApplyEdit;
    }

    assert.strictEqual(document.getText(), afterConcurrentEdit);
    const devTools = await connectWorkbenchDevTools();
    try {
        await closeManagerAndFocusDocument(document);
        await waitForRendererEditorFocus(devTools);
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
    } finally {
        devTools.close();
    }
    await waitForAssertion(() => {
        assert.strictEqual(document.getText(), original);
    });
    assert.strictEqual(document.isDirty, false);
    const finalResetModel = await vscode.commands.executeCommand('extension.keywordOptions.reset');
    assert.ok(finalResetModel);
    assert.strictEqual(finalResetModel.sourceDocument, document);
    assert.strictEqual(finalResetModel.uri, document.uri.toString(true));
    assert.strictEqual(finalResetModel.documentVersion, document.version);
    assert.notStrictEqual(finalResetModel.stale, true);
    assert.strictEqual(finalResetModel.targetKeyword, finalResetModel.currentKeyword);
    assert.strictEqual(managerApi.buildKeywordOptionsViewState(finalResetModel).hasDrafts, false);
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
    assert.strictEqual(discardDocument.getText(), discardOriginal);
    assert.strictEqual(discardDocument.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), otherFilesBefore);
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
        await vscode.commands.executeCommand(
            'extension.lsdynaChooseKeywordOptions',
            1,
        );
        await vscode.commands.executeCommand('extension.keywordOptions.stage', 'spelling:*MAT_ELASTIC');
        await vscode.commands.executeCommand('extension.keywordOptions.apply');

        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    } finally {
        await vscode.commands.executeCommand('extension.keywordOptions.reset');
        await filesConfiguration.update(
            'readonlyInclude',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertKeywordManagerRemainsBoundWhenEditorFocusChanges() {
    const { document, editor } = await openFixture('option-title.key');
    const original = document.getText();
    const workspaceBefore = workspaceSnapshot();
    editor.selection = new vscode.Selection(1, 0, 1, 0);

    await vscode.commands.executeCommand(
        'extension.lsdynaChooseKeywordOptions',
        1,
    );
    await vscode.commands.executeCommand('extension.keywordOptions.stage', 'spelling:*MAT_ELASTIC');

    const { document: otherDocument, editor: otherEditor } = await openFixture(
        'option-title-other-condition.key',
    );
    const otherOriginal = otherDocument.getText();
    const applied = await vscode.commands.executeCommand('extension.keywordOptions.apply');

    assert.ok(applied, 'a current manager draft remains bound to its original document');
    assert.equal(document.getText(), original.replace('*MAT_001', '*MAT_ELASTIC'));
    assert.deepEqual(applied.edit.entries().map(([uri]) => uri.toString()), [document.uri.toString()]);
    assert.strictEqual(otherDocument.getText(), otherOriginal);
    assert.strictEqual(otherDocument.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    await closeManagerAndFocusDocument(document);
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), original);
    assert.equal(document.isDirty, false);
    await discardKeywordManagerDraft(document, original, workspaceBefore);
}

async function assertContactOptionsDoNotDuplicateOrRemoveComments() {
    const { document, editor } = await openFixture('option-contact.key');
    const original = document.getText();
    const diskBefore = workspaceSnapshot();
    editor.selection = new vscode.Selection(1, 0, 1, 0);
    const opened = await vscode.commands.executeCommand('extension.lsdynaChooseKeywordOptions', 1);
    assert.ok(!opened.choices.some(choice => choice.kind === 'post-range'));
    assert.equal(await vscode.commands.executeCommand('extension.keywordOptions.stage', 'post:6'), null);
    assert.equal(document.getText(), original, 'the superseded post-count command must not write');
    await closeManagerAndFocusDocument(document);
    const api = require(path.join(vscode.extensions.getExtension('hqyyqh.dynasense').extensionPath, 'out/extension'))._internals;
    const optional = opened.controls.find(control => control.choices.some(choice => choice.value === 'ABCDEFG'));
    assert.ok(optional, 'published native A-G control must be available');
    const stage = value => api.buildKeywordOptionViewModel(editor, 1, {
        provisional: true, draftControlState: { [optional.controlId]: value },
    });
    const apply = model => api.applyKeywordOptionViewModel({ getModel: () => model, markStale() {} }, editor);
    const verifyComments = () => {
        assert.equal(document.getText().split('$ engineer comment must stay').length - 1, 1);
        assert.equal(document.getText().split('$#   surfa').length - 1, 1);
        assert.deepEqual(workspaceSnapshot(), diskBefore);
    };
    const expanded = stage('ABCDEF');
    assert.equal(expanded.plan.replacementRecords.length, 9);
    assert.ok(await apply(expanded));
    const withAThroughF = document.getText();
    verifyComments();
    const version = document.version;
    assert.equal(await apply(stage('ABCDEF')), null);
    assert.equal(document.version, version);
    assert.equal(document.getText(), withAThroughF);
    const shrunk = stage('ABC');
    assert.equal(shrunk.plan.replacementRecords.length, 6);
    assert.ok(await apply(shrunk));
    verifyComments();
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), withAThroughF);
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), original);
    assert.equal(document.isDirty, false);
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
    assert.strictEqual(document.lineAt(2).text, 'R finish  1.0');
    assert.strictEqual(document.lineAt(4).text, 'R dtplot finish/100.0');
    assert.strictEqual(document.lineAt(6).text, '   &finish');
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

async function assertParameterRenameKeepsFixedColumns() {
    const { document } = await openFixture('rename-alignment.key');
    await vscode.commands.executeCommand('workbench.action.joinAllGroups');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    const original = document.getText();
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    const previousLanguage = configuration.inspect('language').globalValue;
    const devTools = await connectWorkbenchDevTools();
    try {
        for (const language of ['zh-cn', 'en']) {
            await configuration.update('language', language, vscode.ConfigurationTarget.Global);
            const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider',
                document.uri, new vscode.Position(1, 3), 'lctmcrv1');
            assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
            assert.strictEqual(document.lineAt(1).text, 'I lctmcrv1 mxcrvid+8');
            const row = document.lineAt(4).text;
            assert.strictEqual(row.length, 80);
            assert.strictEqual(row.slice(50, 60), ' &lctmcrv1');
            assert.strictEqual(row.slice(60), '         1         0');
            await captureRendererDiagnostic(devTools, `parameter-rename-alignment-${language}`);
            await vscode.commands.executeCommand('undo');
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        }
    } finally {
        devTools.close();
        await configuration.update('language', previousLanguage, vscode.ConfigurationTarget.Global);
    }
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
        await waitForRendererRefactorPreview(devTools);
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
            assert.strictEqual(document.lineAt(2).text, 'R finish  1.0');
            assert.strictEqual(document.lineAt(4).text, 'R dtplot finish/100.0');
            assert.strictEqual(document.lineAt(6).text, '   &finish');
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

async function assertCaseSensitiveIncludeRemainsUnresolved() {
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    const api = require(path.join(extension.extensionPath, 'out/extension'))._internals;
    const { resolveIncludeWithCaseCheck } = require(path.join(extension.extensionPath, 'out/core/fs/pathCaseFidelity'));
    assert.ok(fs.existsSync(path.join(workspaceRoot, 'Sub/Part.key')));
    assert.ok(!fs.existsSync(path.join(workspaceRoot, 'sub/part.key')));
    assert.strictEqual((await resolveIncludeWithCaseCheck('sub/part.key', [workspaceRoot])).status, 'missing');
    const before = workspaceSnapshot();
    for (const name of ['include-case.key', 'include-case-continued.key']) {
        const { document } = await openFixture(name);
        const original = document.getText();
        const diagnostics = await api.collectIncludePathCaseDiagnostics(document, { mode: 'strict' });
        assert.strictEqual(diagnostics.length, 0, 'An unresolved path must not become a case-correction diagnosis');
        const actions = new api.LsdynaIncludePathCaseCodeActionProvider().provideCodeActions(
            document, new vscode.Range(2, 0, 2, document.lineAt(2).text.length), { diagnostics });
        assert.strictEqual(actions.length, 0, 'No case correction may be offered for an unresolved path');
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    }
    assert.deepStrictEqual(workspaceSnapshot(), before);
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

        // Other valid quick fixes (for example field comments) may remain.
        // Ask the actual host for actions without applying an unrelated first item.
        const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider',
            document.uri, new vscode.Range(2, 2, 2, 2), vscode.CodeActionKind.QuickFix.value);
        assert.ok(Array.isArray(actions));
        assert.ok(!actions.some(action => action.diagnostics?.some(
            diagnostic => diagnostic.code === 'include-path-case-mismatch')),
            'A stale Include path diagnostic must not offer a repair');

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
    const devTools = await connectWorkbenchDevTools();
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
        await waitForRendererActionWidget(devTools);
        const preview = vscode.commands.executeCommand('previewSelectedCodeAction');
        await waitForRendererRefactorPreview(devTools);

        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await withTimeout(Promise.all([preview, actionMenu,
            vscode.commands.executeCommand('refactorPreview.discard')]), 5000,
            'Include repair preview discard did not settle');
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    } finally {
        await vscode.commands.executeCommand('hideCodeActionWidget');
        await vscode.commands.executeCommand('refactorPreview.discard');
        devTools.close();
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

async function assertCommaTabRequiresExplicitConversionAndUndo() {
    const { document, editor } = await openFixture('comma.key');
    const original = document.getText();
    editor.selection = new vscode.Selection(2, 0, 2, 0);

    // The neutral, preselected choice must be a true no-op.  A comma-delimited
    // LS-DYNA row is already a valid free-format representation, so merely
    // opening and accepting the Tab menu must not silently convert it.
    await runInlineEditChoice(
        () => vscode.commands.executeCommand('extension.lsdynaTab'),
        'Keep source unchanged',
        ['acceptSelectedSuggestion'],
    );
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    // Conversion is still available, but only after explicitly navigating to
    // the non-default value-order candidate and accepting it with Enter.
    await runInlineEditChoice(
        () => vscode.commands.executeCommand('extension.lsdynaTab'),
        'Interpret by value order',
        ['selectNextSuggestion', 'acceptSelectedSuggestion'],
    );
    const converted = document.lineAt(2).text;
    assert.ok(!converted.includes(','));
    assert.strictEqual(converted.slice(0, 8).trim(), '1');
    assert.strictEqual(converted.slice(8, 24).trim(), '2.0');
    assert.strictEqual(converted.slice(24, 40).trim(), '-3.0');
    assert.strictEqual(converted.slice(40, 56).trim(), '4.0');

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
        for (const mode of ['file', 'modifications', 'modificationsIfAvailable']) {
            await configuration.update(
                'formatOnSaveMode',
                mode,
                vscode.ConfigurationTarget.Global,
            );
            const { document, editor } = await openFixture('format-on-save.key');
            const cleanText = document.getText();
            const cleanBytes = fs.readFileSync(document.uri.fsPath);
            assert.strictEqual(await document.save(), true);
            assert.deepStrictEqual(fs.readFileSync(document.uri.fsPath), cleanBytes);

            await editor.edit(editBuilder => {
                editBuilder.insert(new vscode.Position(1, 0), `$ engineer edit ${mode}\n`);
            });
            const beforeSaveText = document.getText();
            assert.strictEqual(document.isDirty, true);

            assert.strictEqual(await document.save(), true);
            assert.strictEqual(document.isDirty, false);
            assert.strictEqual(document.getText(), beforeSaveText, mode);
            assert.strictEqual(fs.readFileSync(document.uri.fsPath, 'utf8'), beforeSaveText, mode);

            const otherFilesAfter = workspaceSnapshot();
            for (const [name, fingerprint] of Object.entries(otherFilesBefore)) {
                if (name === 'format-on-save.key') continue;
                assert.deepStrictEqual(otherFilesAfter[name], fingerprint);
            }

            await vscode.commands.executeCommand('undo');
            assert.strictEqual(document.getText(), cleanText);
            assert.strictEqual(document.isDirty, true);
            assert.strictEqual(await document.save(), true);
            assert.strictEqual(document.isDirty, false);
        }
    } finally {
        await configuration.update(
            'formatOnSaveMode',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
        await configuration.update(
            'formatOnSave',
            undefined,
            vscode.ConfigurationTarget.Global,
        );
    }
}

async function assertStandardFormattingEntrypointsAreUnclaimed() {
    const configuration = vscode.workspace.getConfiguration('editor');
    const { document, editor } = await openFixture('format-selection.key');
    const original = document.getText();
    const options = { tabSize: 4, insertSpaces: true };
    const range = new vscode.Range(
        new vscode.Position(2, 0),
        document.lineAt(2).range.end,
    );

    const documentEdits = await vscode.commands.executeCommand(
        'vscode.executeFormatDocumentProvider',
        document.uri,
        options,
    );
    const rangeEdits = await vscode.commands.executeCommand(
        'vscode.executeFormatRangeProvider',
        document.uri,
        range,
        options,
    );
    assert.ok(!documentEdits || documentEdits.length === 0);
    assert.ok(!rangeEdits || rangeEdits.length === 0);
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    const originalClipboardText = await vscode.env.clipboard.readText();
    await configuration.update(
        'formatOnPaste',
        true,
        vscode.ConfigurationTarget.Global,
    );
    try {
        const pasted = '1,2.0,-3.0,4.0';
        editor.selection = new vscode.Selection(range.start, range.end);
        await writeClipboardText(pasted);
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
        assert.strictEqual(document.lineAt(2).text, pasted);
        assert.strictEqual(document.isDirty, true);
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    } finally {
        try {
            await configuration.update(
                'formatOnPaste',
                undefined,
                vscode.ConfigurationTarget.Global,
            );
        } finally { await writeClipboardText(originalClipboardText); }
    }
}

async function assertSaveAllDoesNotFormatInactiveDocuments() {
    const configuration = vscode.workspace.getConfiguration('editor');
    await configuration.update('formatOnSave', true, vscode.ConfigurationTarget.Global);
    try {
        const first = await openFixture('format-on-save.key', {
            viewColumn: vscode.ViewColumn.One,
        });
        const firstClean = first.document.getText();
        await first.editor.edit(builder => {
            builder.insert(new vscode.Position(1, 0), '$ inactive save-all edit\n');
        });
        const firstBeforeSave = first.document.getText();

        const second = await openFixture('autosave.key', {
            viewColumn: vscode.ViewColumn.Two,
        });
        const secondClean = second.document.getText();
        await second.editor.edit(builder => {
            builder.insert(new vscode.Position(1, 0), '$ active save-all edit\n');
        });
        const secondBeforeSave = second.document.getText();

        await vscode.commands.executeCommand('workbench.action.files.saveAll');
        assert.strictEqual(first.document.getText(), firstBeforeSave);
        assert.strictEqual(second.document.getText(), secondBeforeSave);
        assert.strictEqual(first.document.isDirty, false);
        assert.strictEqual(second.document.isDirty, false);

        await vscode.window.showTextDocument(first.document, {
            viewColumn: vscode.ViewColumn.One,
            preview: false,
            preserveFocus: false,
        });
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(first.document.getText(), firstClean);
        assert.strictEqual(await first.document.save(), true);

        await vscode.window.showTextDocument(second.document, {
            viewColumn: vscode.ViewColumn.Two,
            preview: false,
            preserveFocus: false,
        });
        await vscode.commands.executeCommand('undo');
        assert.strictEqual(second.document.getText(), secondClean);
        assert.strictEqual(await second.document.save(), true);
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

async function assertOnBlurFormattingCannotModifyOsReadonlyDeck(readonlyFromPermissions = false) {
    if (process.platform !== 'win32') return;

    const lsdynaConfiguration = vscode.workspace.getConfiguration('lsdyna');
    const filesConfiguration = vscode.workspace.getConfiguration('files');
    const fixturePath = path.join(workspaceRoot, 'on-blur-os-readonly.key');
    const originalBytes = fs.readFileSync(fixturePath);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    childProcess.execFileSync('attrib.exe', ['+R', fixturePath]);
    let failure;
    try {
        await filesConfiguration.update(
            'readonlyFromPermissions',
            readonlyFromPermissions,
            vscode.ConfigurationTarget.Global,
        );
        await lsdynaConfiguration.update(
            'autoFormat',
            'onBlur',
            vscode.ConfigurationTarget.Global,
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
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        const cleanup = await Promise.allSettled([
            Promise.resolve().then(() => lsdynaConfiguration.update('autoFormat', undefined, vscode.ConfigurationTarget.Global)),
            Promise.resolve().then(() => filesConfiguration.update('readonlyFromPermissions', undefined, vscode.ConfigurationTarget.Global)),
            Promise.resolve().then(() => childProcess.execFileSync('attrib.exe', ['-R', fixturePath])),
        ]);
        const errors = cleanup.filter(item => item.status === 'rejected').map(item => item.reason);
        if (errors.length) {
            if (!failure) throw new AggregateError(errors, 'Could not restore read-only test state');
            console.error('Read-only test cleanup failed:', ...errors);
        }
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
    const untouchedNextCommaLine = mixedDocument.lineAt(4).text;
    await runInlineEditChoice(
        () => vscode.commands.executeCommand('extension.lsdynaTab'),
        'Keep source unchanged',
        ['acceptSelectedSuggestion'],
    );
    assert.strictEqual(mixedDocument.getText(), mixedOriginal);
    assert.strictEqual(mixedDocument.isDirty, false);

    await runInlineEditChoice(
        () => vscode.commands.executeCommand('extension.lsdynaTab'),
        'Interpret by value order',
        ['selectNextSuggestion', 'acceptSelectedSuggestion'],
    );
    const convertedCommaLine = mixedDocument.lineAt(3).text;
    assert.ok(!convertedCommaLine.includes(','));
    assert.deepStrictEqual(
        convertedCommaLine.trim().split(/\s+/),
        ['0.0', '0.0'],
    );
    assert.strictEqual(mixedDocument.lineAt(4).text, untouchedNextCommaLine);
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

async function prepareOwnEditorFocus(devTools, document, editor) {
    const productApi = keywordManagerProductApi();
    const version = document.version, text = document.getText(), dirty = document.isDirty;
    const beforeWindowFocused = productApi.window.state.focused;
    if (!beforeWindowFocused) await devTools.call('Page.bringToFront');
    await waitForAssertion(() => {
        assert.strictEqual(productApi.window.state.focused, true, 'Own test window must be focused');
        assert.strictEqual(vscode.window.state.focused, true, 'Driver window focus must agree');
    });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await waitForRendererEditorFocus(devTools);
    const response = await devTools.call('Runtime.evaluate', {
        expression: `(() => {
            const active = document.activeElement;
            return {documentHasFocus:document.hasFocus(),textFocused:!!active&&((active.tagName==='TEXTAREA'&&String(active.className).includes('inputarea'))||String(active.className).includes('native-edit-context')),activeTagName:active?.tagName,activeClassName:String(active?.className||'')};
        })()`, returnByValue: true,
    });
    assert.ok(!response.exceptionDetails, 'Own renderer focus query must succeed');
    assert.strictEqual(response.result?.value?.documentHasFocus, true, 'Own renderer document must have focus');
    assert.strictEqual(response.result?.value?.textFocused, true, 'Own renderer text input must have focus');
    assert.strictEqual(productApi.window.state.focused, true);
    assert.strictEqual(vscode.window.state.focused, true);
    assert.strictEqual(productApi.window.activeTextEditor, editor);
    assert.strictEqual(vscode.window.activeTextEditor, editor);
    assert.strictEqual(editor.document, document);
    assert.strictEqual(document.isClosed, false);
    assert.strictEqual(document.version, version);
    assert.strictEqual(document.getText(), text);
    assert.strictEqual(document.isDirty, dirty);
}

async function runPasteIntoSelectedCellAssertions() {
    const { document, editor } = await openFixture('fixed.key');
    const original = document.getText();
    const originalLine = document.lineAt(2).text;
    const nativeInputDevTools = await connectWorkbenchDevTools();
    try {
    for (const command of [
        'editor.action.clipboardPasteAction',
        'editor.action.pasteAsText',
    ]) {
        for (let iteration = 0; iteration < 12; iteration++) {
            await prepareOwnEditorFocus(nativeInputDevTools, document, editor);
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

    await prepareOwnEditorFocus(nativeInputDevTools, document, editor);
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

    await prepareOwnEditorFocus(nativeInputDevTools, document, editor);
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

    await prepareOwnEditorFocus(nativeInputDevTools, document, editor);
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

    await prepareOwnEditorFocus(nativeInputDevTools, document, editor);
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await writeClipboardText('12345678901234567');
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await settleCardCellPostEdit(document);
    await waitForAssertion(() => {
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    });

    await prepareOwnEditorFocus(nativeInputDevTools, document, editor);
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

    await prepareOwnEditorFocus(nativeInputDevTools, document, editor);
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('extension.lsdynaTab');
    await writeClipboardText('9\n5');
    await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    await settleCardCellPostEdit(document);
    await waitForAssertion(() => {
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    });

    for (let iteration = 0; iteration < 40; iteration++) {
        await prepareOwnEditorFocus(nativeInputDevTools, document, editor);
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
        const cutSelection = new vscode.Selection(2, 21, 2, 23);
        const cutSelectionVersion = document.version;
        let rendererSelectionAcknowledgement = null;
        const cutSelectionSubscription = vscode.window.onDidChangeTextEditorSelection(event => {
            if (event.textEditor !== editor || event.textEditor.document !== document) return;
            rendererSelectionAcknowledgement = {
                selections: event.selections.map(selectionShape),
                documentVersionObserved: document.version,
            };
        });
        try {
            editor.selection = cutSelection;
            await waitForAssertion(() => {
                assert.ok(rendererSelectionAcknowledgement, 'Renderer must acknowledge the Cut selection');
                assert.deepStrictEqual(rendererSelectionAcknowledgement.selections, [selectionShape(cutSelection)]);
                assert.strictEqual(rendererSelectionAcknowledgement.documentVersionObserved, cutSelectionVersion);
                assert.strictEqual(vscode.window.activeTextEditor, editor);
                assert.strictEqual(editor.document, document);
                assert.strictEqual(document.isClosed, false);
                assert.strictEqual(document.version, cutSelectionVersion);
                assert.strictEqual(document.getText(), beforeCut);
            });
        } catch (error) {
            changeSubscription.dispose();
            throw error;
        } finally {
            cutSelectionSubscription.dispose();
        }
        const navBeforeCut = guard?.getNav?.() || null;
        if (selectionSettleMs > 0) {
            await new Promise(resolve => setTimeout(resolve, selectionSettleMs));
        }
        try {
            await dispatchRendererKey(
                nativeInputDevTools, 'x', 'KeyX', 88, process.platform === 'darwin' ? 4 : 2,
            );
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
    } finally {
        nativeInputDevTools.close();
    }
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

async function assertLineCommentEmptyLineIsNoop() {
    const { document, editor } = await openFixture('comment-toggle.key');
    const original = document.getText();
    assert.strictEqual(document.lineAt(5).text, '');
    editor.selection = new vscode.Selection(5, 0, 5, 0);

    await vscode.commands.executeCommand('extension.lsdynaLineComment');
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
    // Mixed mode layers every ordinary line, including the authored comment, so a
    // second toggle can remove exactly one layer without losing that comment.
    assert.strictEqual(document.lineAt(2).text, `$${dataLine}`);
    assert.strictEqual(document.lineAt(3).text, '$$ existing');
    assert.strictEqual(document.lineAt(4).text, '$    $ legacy indented');
    assert.strictEqual(document.lineAt(5).text, '');
    assert.strictEqual(document.lineAt(6).text, `$${fieldHeader}`);
    assert.strictEqual(document.lineAt(7).text, `$${dataLine}`);
    assert.strictEqual(document.isDirty, true);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    assert.strictEqual(document.getText(), original);

    // Each toggle is one transaction: undo once returns to the layered form, and
    // undo again restores the original clean buffer.
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.lineAt(3).text, '$$ existing');
    await vscode.commands.executeCommand('undo');
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

async function assertLineCommentOrdinaryPlusIndentedDollarUsesCommentMode() {
    const { document, editor } = await openFixture('comment-toggle.key');
    const original = document.getText();
    const workspaceBefore = workspaceSnapshot();

    // Only column-zero `$` is a solver line comment. The indented `$` line is
    // active code, so its presence selects comment mode for the mixed selection.
    editor.selection = new vscode.Selection(
        new vscode.Position(3, 0),
        document.lineAt(4).range.end,
    );

    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    assert.strictEqual(document.lineAt(3).text, '$$ existing');
    assert.strictEqual(document.lineAt(4).text, '$    $ legacy indented');
    assert.strictEqual(document.isDirty, true);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertKeywordCommentUsesManualInlineFormAndRoundTripsMixedBody() {
    const { document, editor } = await openFixture('comment-curve.key');
    const original = document.getText();
    const originalLines = original.split(/\r?\n/);
    const workspaceBefore = workspaceSnapshot();
    editor.selection = new vscode.Selection(
        new vscode.Position(0, 0),
        document.lineAt(6).range.end,
    );

    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    assert.strictEqual(document.lineAt(0).text, '*COMMENT *DEFINE_CURVE');
    for (let line = 1; line <= 6; line++) {
        assert.strictEqual(document.lineAt(line).text, originalLines[line]);
    }
    assert.strictEqual(
        document.lineAt(5).text,
        '$  add another point -- resolution IS lost when table of curves is used',
    );

    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    assert.strictEqual(document.getText(), original);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.lineAt(0).text, '*COMMENT *DEFINE_CURVE');
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
}

async function assertCommentOpaqueProvidersAndToggleAreScoped() {
    const { document, editor } = await openFixture('comment-opaque.key');
    const original = document.getText();
    const workspaceBefore = workspaceSnapshot();

    const controlHovers = await vscode.commands.executeCommand(
        'vscode.executeHoverProvider',
        document.uri,
        new vscode.Position(1, 2),
    );
    assert.ok((controlHovers || []).length > 0, '*COMMENT token lost keyword hover');
    const suffixHovers = await vscode.commands.executeCommand(
        'vscode.executeHoverProvider',
        document.uri,
        new vscode.Position(1, 13),
    );
    const bodyHovers = await vscode.commands.executeCommand(
        'vscode.executeHoverProvider',
        document.uri,
        new vscode.Position(5, 6),
    );
    assert.deepStrictEqual(suffixHovers || [], []);
    assert.deepStrictEqual(bodyHovers || [], []);

    const symbols = await vscode.commands.executeCommand(
        'vscode.executeDocumentSymbolProvider',
        document.uri,
    );
    assert.deepStrictEqual(
        (symbols || []).map(symbol => symbol.name),
        ['*KEYWORD', '*COMMENT', '*SET_SEGMENT', '*END'],
    );
    const links = await vscode.extensions
        .getExtension('hqyyqh.dynasense')
        ?.exports?._internals
        ?.collectIncludeDocumentLinks?.(document);
    assert.deepStrictEqual(links || [], []);
    const definitions = await vscode.commands.executeCommand(
        'vscode.executeDefinitionProvider',
        document.uri,
        new vscode.Position(6, 3),
    );
    const references = await vscode.commands.executeCommand(
        'vscode.executeReferenceProvider',
        document.uri,
        new vscode.Position(6, 3),
    );
    assert.deepStrictEqual(definitions || [], []);
    assert.deepStrictEqual(references || [], []);
    assert.ok(
        !vscode.languages.getDiagnostics(document.uri).some(diagnostic =>
            diagnostic.range.start.line >= 2 && diagnostic.range.start.line <= 6
        ),
        'opaque body produced diagnostics',
    );

    editor.selection = new vscode.Selection(
        new vscode.Position(1, 0),
        document.lineAt(9).range.end,
    );
    await vscode.commands.executeCommand('extension.lsdynaLineComment');
    assert.strictEqual(document.lineAt(1).text, '*COMMENT *COMMENT   *INCLUDE');
    for (let line = 2; line <= 6; line++) {
        assert.strictEqual(document.lineAt(line).text, original.split(/\r?\n/)[line]);
    }
    assert.strictEqual(document.lineAt(7).text, '*COMMENT *SET_SEGMENT');
    assert.strictEqual(document.lineAt(8).text, '$#       sid');
    assert.strictEqual(document.lineAt(9).text, '       1');
    assert.strictEqual(document.isDirty, true);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
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

async function assertOfficialFieldChoiceMouseFlowIsDiscoverableAndUndoable() {
    const workspaceBefore = workspaceSnapshot();
    const { document, editor } = await openFixture('official-field-choice.key');
    const original = document.getText();
    const originalLine = document.lineAt(3).text;
    const position = new vscode.Position(3, 75);
    editor.selection = new vscode.Selection(position, position);
    const devTools = await connectWorkbenchDevTools();
    try {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        // A freshly opened isolated workbench can leave DOM focus on the
        // unified agents bar even though the TextEditor is active. Use one real
        // renderer click to establish the same editor focus as a user click.
        const editorPoint = await getRendererVisibleElementCenter(
            devTools,
            '.monaco-editor .view-lines',
        );
        await dispatchRendererMouseClick(devTools, editorPoint);
        await waitForRendererEditorFocus(devTools);
        editor.selection = new vscode.Selection(position, position);

        const extensionInternals = vscode.extensions
            .getExtension('hqyyqh.dynasense')
            ?.exports?._internals;
        let latestPlan = null;
        await waitForAssertion(() => {
            latestPlan = extensionInternals?.planOfficialFieldChoicesForDocument?.(
                document,
                position,
            );
            assert.strictEqual(
                latestPlan?.status,
                'ready',
                `official choice plan was not ready: ${JSON.stringify(latestPlan)}`,
            );
        }, 5000);
        // Publish one post-index selection event as a real click/Tab would do.
        editor.selection = new vscode.Selection(position, position);

        // Selection alone must never open Suggest or QuickPick. The engineer can
        // keep typing, use an IME, or continue Tab navigation without focus theft.
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.strictEqual(await getRendererSuggestionWidget(devTools), null);
        const activeBeforeClick = await getRendererActiveElement(devTools);
        assert.ok(
            activeBeforeClick.className.includes('inputarea') ||
            activeBeforeClick.className.includes('native-edit-context'),
        );

        // Exercise the intended no-shortcut path: real mouse click on the status
        // item, followed by a native-verified value 1 QuickPick row. The manual's
        // 10/11 entries are outside this native descriptor's accepted enum.
        const statusPoint = await waitForRendererVisibleTextElementCenter(
            devTools,
            '.statusbar-item',
            'FLAG',
        );
        await dispatchRendererMouseClick(devTools, statusPoint);
        await waitForRendererInput(devTools, '');
        const valuePoint = await waitForRendererVisibleTextElementCenter(
            devTools,
            '.quick-input-widget .monaco-list-row',
            '1',
            true,
        );
        await dispatchRendererMouseClick(devTools, valuePoint);

        await waitForAssertion(() => {
            assert.strictEqual(document.lineAt(3).text.slice(70, 80), '         1');
            assert.strictEqual(document.isDirty, true);
        });
        assert.strictEqual(document.lineAt(3).text.slice(0, 70), originalLine.slice(0, 70));
        assert.strictEqual(document.lineAt(3).text.slice(80), originalLine.slice(80));

        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        const undoEditorPoint = await getRendererVisibleElementCenter(
            devTools,
            '.monaco-editor .view-lines',
        );
        await dispatchRendererMouseClick(devTools, undoEditorPoint);
        await waitForRendererEditorFocus(devTools);
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });

        // Exercise the actual field-hover command link after the edit/Undo
        // cycle. Provider-only tests can prove the URI text but cannot prove
        // that the workbench dispatches it after a real mouse click. The link
        // must use the document's current post-Undo version and cancellation
        // must leave the restored source untouched.
        editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand('editor.action.showHover');
        const hoverChoicePoint = await waitForRendererVisibleTextElementCenter(
            devTools,
            '.monaco-hover a:has(.codicon-list-selection)',
            '',
            false,
            3000,
        );
        await dispatchRendererMouseClick(devTools, hoverChoicePoint);
        await waitForRendererInput(devTools, '');
        await dispatchRendererKey(devTools, 'Escape', 'Escape', 27);
        await waitForAssertion(async () => {
            assert.strictEqual(await getRendererSuggestionWidget(devTools), null);
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
        devTools.close();
    }
}

async function assertKeywordStructureRepairMouseFlowIsRevalidatedAndUndoable() {
    const workspaceBefore = workspaceSnapshot();
    const { document, editor } = await openFixture('keyword-structure-winfrith-missing.key');
    const original = document.getText();
    const originalDisk = fs.readFileSync(document.uri.fsPath);
    // The complete-block diagnostic and suffix repair are on the keyword Hover.
    const position = new vscode.Position(1, 5);
    editor.selection = new vscode.Selection(position, position);

    const hover = await executeDetailedHover(document, position, 'Add these blank cards');
    const markdown = hoverMarkdown(hover);
    assert.ok(markdown.includes('Missing Card 5, Card 6, Card 7'));
    assert.ok(markdown.includes('command:extension.checkKeywordStructure'));
    assert.ok(markdown.includes('command:extension.addVerifiedConditionalCards'));
    const commandMatch = markdown.match(
        /command:extension\.addVerifiedConditionalCards\?([^ )"]+)/,
    );
    assert.ok(commandMatch, 'verified structure repair command URI was not published');
    const [staleRequest] = JSON.parse(decodeURIComponent(commandMatch[1]));

    // A command URI is only an identity hint. Any intervening document edit must
    // invalidate it, even when the resulting deck would still look repairable.
    await editor.edit(edit => edit.insert(document.lineAt(3).range.end, ' '));
    const staleText = document.getText();
    await vscode.commands.executeCommand(
        'extension.addVerifiedConditionalCards',
        staleRequest,
    );
    assert.strictEqual(document.getText(), staleText);
    assert.strictEqual(document.isDirty, true);
    assert.deepStrictEqual(fs.readFileSync(document.uri.fsPath), originalDisk);
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    await vscode.commands.executeCommand('undo');
    assert.strictEqual(document.getText(), original);
    assert.strictEqual(document.isDirty, false);

    // Exercise the real rendered Hover link. The click must append exactly three
    // verified headers and 80-column blanks in one WorkspaceEdit and touch no disk file.
    const devTools = await connectWorkbenchDevTools();
    try {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        const editorPoint = await getRendererVisibleElementCenter(
            devTools,
            '.monaco-editor .view-lines',
        );
        await dispatchRendererMouseClick(devTools, editorPoint);
        await waitForRendererEditorFocus(devTools);
        editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand('editor.action.hideHover');
        await vscode.commands.executeCommand('editor.action.showHover');
        const compact = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, position);
        const more = compact.map(hoverMarkdown).join('\n').match(/command:extension\.hoverMore\?([^ )"]+)/);
        assert.ok(more, 'Compact hover must expose its detail action');
        const [requestId] = JSON.parse(decodeURIComponent(more[1]));
        assert.equal(await vscode.commands.executeCommand('extension.toggleHoverDetails', requestId), true);
        // Hover content arrives asynchronously. Scroll only after the link exists;
        // a nonzero DOM rectangle can still be clipped outside the scroll viewport.
        await waitForRendererVisibleTextElementCenter(
            devTools, '.monaco-hover a', 'Add these blank cards', false, 3000,
        );
        await devTools.call('Runtime.evaluate', {
            expression: "Array.from(document.querySelectorAll('.monaco-hover a')).find(a => a.textContent.includes('Add these blank cards'))?.scrollIntoView({block:'nearest', inline:'nearest'})",
        });
        const repairPoint = await waitForRendererVisibleTextElementCenter(
            devTools,
            '.monaco-hover a',
            'Add these blank cards',
            false,
            3000,
        );
        await dispatchRendererMouseClick(devTools, repairPoint);

        const originalLines = original.split(/\r?\n/);
        await waitForAssertion(() => {
            const lines = document.getText().split(/\r?\n/);
            assert.strictEqual(lines.length, originalLines.length + 6);
            assert.deepStrictEqual(lines.slice(0, 6), originalLines.slice(0, 6));
            assert.deepStrictEqual(lines.slice(12), originalLines.slice(6));
            for (let index = 6; index < 12; index += 2) {
                assert.ok(lines[index].startsWith('$#'));
                assert.strictEqual(lines[index + 1], ' '.repeat(80));
            }
            assert.strictEqual(document.isDirty, true);
        });
        assert.deepStrictEqual(fs.readFileSync(document.uri.fsPath), originalDisk);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);

        const structure = vscode.extensions
            .getExtension('hqyyqh.dynasense')
            ?.exports?._internals
            ?.analyzeKeywordStructureForDocument?.(
                document,
                1,
                { bypassCache: true },
            );
        assert.strictEqual(structure?.status, 'valid');
        assert.strictEqual(structure?.observedDataRecords, 7);

        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        const undoPoint = await getRendererVisibleElementCenter(
            devTools,
            '.monaco-editor .view-lines',
        );
        await dispatchRendererMouseClick(devTools, undoPoint);
        await waitForRendererEditorFocus(devTools);
        await dispatchRendererKey(devTools, 'z', 'KeyZ', 90, 2);
        await waitForAssertion(() => {
            assert.strictEqual(document.getText(), original);
            assert.strictEqual(document.isDirty, false);
        });
        assert.deepStrictEqual(fs.readFileSync(document.uri.fsPath), originalDisk);
        assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } finally {
        devTools.close();
    }
}

async function assertUnverifiedTitleVariantStaysReadOnly() {
    const workspaceBefore = workspaceSnapshot();
    const { document } = await openFixture('title-card-position-conflict.key');
    const original = document.getText();
    const keywordHover = await executeDetailedHover(document, new vscode.Position(1, 5), '`TITLE`');
    const keywordMarkdown = hoverMarkdown(keywordHover);
    assert.ok(keywordMarkdown.includes('(active)'));
    assert.ok(!keywordMarkdown.includes('command:extension.insertVerifiedMissingRecords'));
    assert.ok(!keywordMarkdown.includes('record may be missing'));

    const titleHover = await executeDetailedHover(document, new vscode.Position(3, 5), 'TITLE');
    const titleMarkdown = hoverMarkdown(titleHover);
    assert.ok(!titleMarkdown.includes('command:extension.insertVerifiedMissingRecords'));

    const apparentFlagPosition = new vscode.Position(5, 75);
    const shiftedHover = await executeDetailedHover(
        document,
        new vscode.Position(5, 5),
        '**MID**',
    );
    const shiftedMarkdown = hoverMarkdown(shiftedHover);
    assert.ok(!shiftedMarkdown.includes('command:extension.insertVerifiedMissingRecords'));
    assert.ok(!shiftedMarkdown.includes('**FLAG**'));
    assert.ok(!shiftedMarkdown.includes('command:extension.pickOfficialFieldValue'));

    const plan = vscode.extensions
        .getExtension('hqyyqh.dynasense')
        ?.exports?._internals
        ?.planOfficialFieldChoicesForDocument?.(document, apparentFlagPosition);
    assert.strictEqual(plan?.status, 'no-choice');
    assert.strictEqual(plan?.reason, 'position-outside-field');
    assert.deepStrictEqual(plan?.choices, []);

    await vscode.commands.executeCommand('extension.insertVerifiedMissingRecords');
    await waitForAssertion(() => {
        assert.strictEqual(document.getText(), original);
        assert.strictEqual(document.isDirty, false);
    });
    assert.deepStrictEqual(workspaceSnapshot(), workspaceBefore);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

async function assertEntityReferencesWebviewActivatesAndQueries() {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
        'extension.queryLsdynaEntityId',
        'extension.entityReferences.refresh',
        'lsdynaEntityReferences.focus',
    ]) {
        assert.ok(commands.includes(command), `Missing object-reference command: ${command}`);
    }

    await openFixture('comment-curve.key');
    await vscode.commands.executeCommand('lsdynaEntityReferences.focus');
    const result = await vscode.commands.executeCommand(
        'extension.queryLsdynaEntityId',
        { targetKind: 'curve', id: 3 },
    );
    assert.ok(result, 'Object-reference command did not return a query result');
    assert.ok(['exact', 'complete', 'ambiguous'].includes(result.state), JSON.stringify(result.reasons));
    assert.ok(
        result.locations.some(location =>
            location.role === 'definition' && location.keyword === '*DEFINE_CURVE'
        ),
        'Object-reference Webview query did not resolve the curve definition',
    );
}

async function assertLargeFileCustomEditorOpensReadonly() {
    const filePath = path.join(workspaceRoot, 'large-file-viewer.key');
    const uri = vscode.Uri.file(filePath);
    const descriptor = fs.openSync(filePath, 'w');
    const header = Buffer.from([
        '*KEYWORD',
        '*PART',
        'Large file viewer fixture',
        '   2000101   2000101   2000101',
        '*MAT_ELASTIC',
        '   2000101',
        '',
    ].join('\n'), 'utf8');
    const chunk = Buffer.from(`${'$ large-file-viewer fixture'.padEnd(79)}\n`.repeat(8192), 'utf8');
    try {
        fs.writeSync(descriptor, header);
        while (fs.fstatSync(descriptor).size < 50 * 1024 * 1024) fs.writeSync(descriptor, chunk);
    } finally {
        fs.closeSync(descriptor);
    }
    const before = fs.statSync(filePath);
    const beforeSha256 = await hashFile(filePath);
    assert.ok(before.size >= 50 * 1024 * 1024);
    assert.ok(!vscode.workspace.textDocuments.some(document => document.uri.fsPath === filePath));

    try {
        const opened = await vscode.commands.executeCommand(
            'extension.openLsdynaLargeFileViewer',
            uri,
        );
        assert.strictEqual(opened, true);
        await waitForAssertion(() => {
            const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
            assert.strictEqual(input?.viewType, 'lsdyna.largeFileViewer');
            assert.strictEqual(path.resolve(input?.uri?.fsPath).toLowerCase(), path.resolve(filePath).toLowerCase());
        });
        assert.ok(!vscode.workspace.textDocuments.some(document => document.uri.fsPath === filePath));

        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        const after = fs.statSync(filePath);
        assert.strictEqual(after.size, before.size);
        assert.strictEqual(await hashFile(filePath), beforeSha256, 'Readonly viewer changed source bytes');
    } finally {
        if (vscode.window.tabGroups.activeTabGroup.activeTab?.input?.viewType ===
            'lsdyna.largeFileViewer') {
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
        fs.rmSync(filePath, { force: true });
        // A cancelled background reader can briefly leave a Windows delete-pending
        // entry. Do not feed that transient fixture into the next byte snapshot.
        await waitForAssertion(() => assert.ok(!fs.readdirSync(workspaceRoot).includes(path.basename(filePath))));
    }
}

async function assertCellNavigationBelongsToTheOpenDocument() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const fixturePath = path.join(workspaceRoot, 'fixed-stale-nav.key');
    const originalBytes = fs.readFileSync(fixturePath);
    const uri = vscode.Uri.file(path.join(workspaceRoot, 'cell-navigation-identity.key')).with({ scheme: 'untitled' });
    let original = await vscode.workspace.openTextDocument(uri);
    if (original.languageId !== 'lsdyna') original = await vscode.languages.setTextDocumentLanguage(original, 'lsdyna');
    const initialEditor = await vscode.window.showTextDocument(original, { preview: false });
    await initialEditor.edit(builder => builder.insert(new vscode.Position(0, 0), originalBytes.toString('utf8')));
    const originalText = original.getText();
    const originalLine = original.lineAt(2).text;
    const initialVersion = original.version;
    const events = [];
    const ids = new WeakMap();
    let nextId = 0;
    const id = document => {
        if (!ids.has(document)) ids.set(document, ++nextId);
        return ids.get(document);
    };
    const observe = (kind, document) => {
        if (document.uri.toString() === uri.toString()) events.push({
            kind, id: id(document), version: document.version, closed: document.isClosed,
        });
    };
    id(original);
    const closeSubscription = vscode.workspace.onDidCloseTextDocument(document => observe('close', document));
    let lastChange;
    const changeSubscription = vscode.workspace.onDidChangeTextDocument(event => {
        observe('change', event.document);
        if (event.document.uri.toString() === uri.toString() && event.contentChanges.length) lastChange = event;
    });
    const { createCardCellEditGuard } = require(path.join(
        vscode.extensions.getExtension('hqyyqh.dynasense').extensionPath,
        'out/client/services/cardCellEditGuard.js'));
    const fields = [{ p: 0, w: 8 }, { p: 8, w: 16 }, { p: 24, w: 16 },
        { p: 40, w: 16 }, { p: 56, w: 8 }, { p: 64, w: 8 }];
    const makeGuard = () => createCardCellEditGuard({ getCardFieldsForLine: () => fields,
        isLsdynaDocument: () => true, isProtectEnabled: () => true });
    const staleGuard = makeGuard();
    staleGuard.markA(original, 2, 1, true);
    const snapshot = staleGuard.getNav();
    let mutationRejected = false;
    try { snapshot.fieldIndex = 0; } catch (error) { mutationRejected = error instanceof TypeError; }
    const snapshotImmutable = mutationRejected && Object.isFrozen(snapshot) && staleGuard.getNav().fieldIndex === 1;
    staleGuard.markA(original, 2, 1, true);
    const loadedExtension = vscode.extensions.getExtension('hqyyqh.dynasense');
    const currentModule = Object.values(require.cache).find(entry =>
        entry.exports?._internals?.ensureCardCellEditGuard === loadedExtension.exports._internals.ensureCardCellEditGuard);
    assert.ok(currentModule, 'activated extension module must be in the CommonJS cache');
    assert.equal(fs.realpathSync(currentModule.filename).toLowerCase(),
        fs.realpathSync(path.join(loadedExtension.extensionPath, 'out/extension.js')).toLowerCase());
    const internals = currentModule.exports._internals;
    const singleton = internals.ensureCardCellEditGuard();
    assert.strictEqual(singleton, loadedExtension.exports._internals.ensureCardCellEditGuard());
    const clearNav = singleton.clearNav;
    const scopedClears = [];
    singleton.clearNav = document => {
        if (document) scopedClears.push({ id: id(document), closed: document.isClosed });
        return clearNav(document);
    };
    let reopened;
    try {
        internals.markCardCellA(singleton, original, 2, 1, true);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        await waitForAssertion(() => assert.equal(original.isClosed, true));
        const closeListenerClearedOwner = scopedClears.some(entry => entry.id === id(original) && entry.closed);
        reopened = await vscode.workspace.openTextDocument(uri);
        if (reopened.languageId !== 'lsdyna') reopened = await vscode.languages.setTextDocumentLanguage(reopened, 'lsdyna');
        const currentEditor = await vscode.window.showTextDocument(reopened, { preview: false });
        await currentEditor.edit(builder => builder.insert(new vscode.Position(0, 0), originalText));
        await waitForAssertion(() => assert.ok(lastChange && lastChange.document === reopened));
        const reopenedInitialVersion = reopened.version;
        const selection = new vscode.Selection(2, 9, 2, 24);
        currentEditor.selection = selection;
        const staleType = staleGuard.planType(reopened, selection, '9');
        const liveGuard = makeGuard();
        liveGuard.markA(reopened, 2, 1, true);
        lastChange = undefined;
        await currentEditor.edit(builder => builder.replace(new vscode.Range(2, 9, 2, 24), '9'));
        await waitForAssertion(() => assert.ok(lastChange && lastChange.document === reopened && lastChange.contentChanges[0].text === '9'));
        const stalePaste = staleGuard.planPostEditCorrection(reopened, lastChange.contentChanges);
        const livePaste = liveGuard.planPostEditCorrection(reopened, lastChange.contentChanges);
        const checks = { newObject: reopened !== original, sameUri: reopened.uri.toString() === original.uri.toString(),
            sameInitialVersion: reopenedInitialVersion === initialVersion, changeOwnsReopenedObject: lastChange.document === reopened,
            oldObjectClosed: original.isClosed, originalCloseObserved: events.some(event => event.kind === 'close' && event.id === id(original)),
            livePasteRetainsColumns: !!livePaste && livePaste.newText.slice(24) === originalLine.slice(24),
            staleTypeRejected: staleType === null, stalePasteRejected: stalePaste === null, snapshotImmutable };
        const evidencePath = process.env.LSDYNA_CELL_NAV_EVIDENCE;
        const beforeUndo = { checks, scopedClears, events, singletonNav: singleton.getNav(reopened),
            version: reopened.version, activeOwnsReopened: vscode.window.activeTextEditor?.document === reopened,
            originalText, pastedText: reopened.getText() };
        await vscode.commands.executeCommand('undo');
        if (evidencePath) fs.writeFileSync(evidencePath, JSON.stringify({ phase: 'undo-observation', beforeUndo,
            version: reopened.version, activeOwnsReopened: vscode.window.activeTextEditor?.document === reopened,
            currentText: reopened.getText() }, null, 2));
        await waitForAssertion(() => assert.equal(reopened.getText(), originalText));
        checks.closeListenerClearedOwner = closeListenerClearedOwner;
        internals.markCardCellA(singleton, reopened, 2, 1, true);
        const currentNav = singleton.getNav(reopened);
        const selected = new vscode.Selection(2, currentNav.expectedStart, 2, currentNav.expectedEnd);
        checks.liveTabEligible = internals.isTabSelectionEligible(currentEditor, selected);
        checks.staleTabRejected = !internals.isTabSelectionEligible(initialEditor, selected);
        checks.graceOwnsReopenedDocument = internals.hasRecentCardCellSelectionGrace(reopened) &&
            !internals.hasRecentCardCellSelectionGrace(original) &&
            internals.cardCellASelectionGraceRemaining(currentNav, reopened) > 0 &&
            internals.cardCellASelectionGraceRemaining(currentNav, original) === 0;
        singleton.clearNav(original);
        singleton.onSelectionChange(initialEditor);
        singleton.planPostEditCorrection(original, lastChange.contentChanges);
        checks.queuedOldEventsPreserveNewNav = JSON.stringify(singleton.getNav(reopened)) === JSON.stringify(currentNav);
        singleton.clearNav(reopened);
        checks.diskFixtureUnchanged = fs.readFileSync(fixturePath).equals(originalBytes);
        const evidence = { host: vscode.version, node: process.version, originalId: id(original), reopenedId: id(reopened),
            initialVersion, reopenedInitialVersion, reopenedVersionAfterUndo: reopened.version, events, scopedClears, checks,
            activatedModule: currentModule.filename, sourceRestored: reopened.getText() === originalText, resourceKind: 'owned untitled input deck' };
        if (evidencePath) fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
        for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, name);
    } finally {
        singleton.clearNav = clearNav; singleton.clearNav();
        closeSubscription.dispose(); changeSubscription.dispose();
        if (reopened && !reopened.isClosed) {
            await vscode.window.showTextDocument(reopened);
            await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        assert.deepEqual(fs.readFileSync(fixturePath), originalBytes);
    }
}


async function assertSemanticEvidenceGatesInTheActualHost() {
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    const currentModule = Object.values(require.cache).find(entry =>
        entry.exports?._internals?.ensureCardCellEditGuard === extension.exports._internals.ensureCardCellEditGuard);
    assert.ok(currentModule, 'use the activated extension module');
    const api = currentModule.exports._internals;
    const productRequire = createRequire(currentModule.filename);
    const i18n = productRequire('./core/i18n');
    const root = path.join(path.dirname(workspaceRoot), 'semantic-evidence-fixture');
    fs.mkdirSync(root);
    const bytes = Buffer.from('original synthetic locked PDF byte fixture');
    const pdfPath = path.join(root, 'original.pdf');
    const manifestBytes = Buffer.from(JSON.stringify({ documents: [
        { slug: 'synthetic-manual', pdfFile: 'original.pdf' },
    ] }));
    fs.writeFileSync(path.join(root, 'manifest.json'), manifestBytes);
    const sourceLock = { manualPackManifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
        documents: [{ manualId: 'synthetic-manual', pdfFile: 'original.pdf', pages: 1,
            size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] };
    const request = { keyword: '*TEST', ruleId: 'rule:synthetic', evidenceId: 'evidence:synthetic' };
    const evidence = { evidenceId: request.evidenceId, manualId: 'synthetic-manual', page: 1 };
    let summary = { sourceLock };
    const catalog = { summary: () => summary,
        rulesForKeyword: () => [{ ruleId: request.ruleId, evidence: [evidence] }] };
    const resolver = new api.SemanticEvidenceResolver();
    const opened = [];
    const openEvidence = () => api.handleOpenSemanticEvidenceCommand({}, request, {
        resolver, catalog, manualPackRoot: root, openPdf: (_context, file) => opened.push(file),
    });
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    const originalLanguage = configuration.get('language');
    const workspaceBefore = workspaceSnapshot();
    const devTools = await connectWorkbenchDevTools();
    const results = [];
    const evidencePath = process.env.LSDYNA_SEMANTIC_GATE_EVIDENCE;
    const fixedTime = new Date('2020-01-02T03:04:05.000Z');
    const clearNotifications = async () => {
        await vscode.commands.executeCommand('notifications.clearAll');
        await waitForAssertion(async () => {
            const response = await devTools.call('Runtime.evaluate', {
                expression: `document.querySelectorAll('.notification-list-item').length`, returnByValue: true,
            });
            assert.equal(response.result.value, 0);
        });
    };
    try {
        for (const language of ['en', 'zh-cn']) {
            await configuration.update('language', language, vscode.ConfigurationTarget.Global);
            i18n.updateLanguage();
            await clearNotifications();
            summary = { sourceLock };
            fs.writeFileSync(pdfPath, bytes);
            fs.utimesSync(pdfPath, fixedTime, fixedTime);
            const original = fs.statSync(pdfPath);
            assert.equal((await openEvidence()).status, 'resolved');
            const opensBeforeFailure = opened.length;
            fs.writeFileSync(pdfPath, Buffer.alloc(bytes.length, 0x78));
            fs.utimesSync(pdfPath, fixedTime, fixedTime);
            const replacement = fs.statSync(pdfPath);
            assert.equal(replacement.size, original.size);
            assert.equal(replacement.mtimeMs, original.mtimeMs);
            assert.equal((await openEvidence()).status, 'pdf-integrity-mismatch');
            for (const [kind, key] of [['byte-mismatch', 'semanticEvidencePdfMismatch'],
                ['invalid-authority', 'semanticEvidenceUnavailable']]) {
                if (kind === 'invalid-authority') {
                    await clearNotifications();
                    fs.writeFileSync(pdfPath, bytes);
                    summary = { sourceLock, evidenceAuthority: { profiles: [] } };
                    assert.equal((await openEvidence()).status, 'source-lock-unavailable');
                    assert.deepEqual(api.semanticEvidencePageLinks('*TEST', catalog.rulesForKeyword(),
                        { catalogSummary: summary }), []);
                }
                const expected = i18n.get(key);
                // VS Code limits a burst of toasts; the native notification
                // center still exposes every warning for actual UI verification.
                await vscode.commands.executeCommand('notifications.showList');
                await waitForAssertion(async () => {
                    const expanded = await devTools.call('Runtime.evaluate', {
                        expression: `(() => {
                            const item = Array.from(document.querySelectorAll('.notification-list-item'))
                                .find(element => element.textContent.includes(${JSON.stringify(expected)}));
                            if (!item) return false;
                            item.querySelector('[aria-label="Expand Notification (${process.platform === 'darwin' ? '→' : 'RightArrow'})"]')?.click();
                            return true;
                        })()`, returnByValue: true,
                    });
                    assert.equal(expanded.result.value, true);
                });
                let notification;
                await waitForAssertion(async () => {
                    const response = await devTools.call('Runtime.evaluate', {
                        expression: `Array.from(document.querySelectorAll('.notification-list-item')).map(element => ({
                            text: element.textContent, visible: element.getClientRects().length > 0,
                            width: element.getBoundingClientRect().width, className: element.className,
                            message: (() => {
                                const message = element.querySelector('.notification-list-item-message');
                                return message ? { text: message.textContent, height: message.clientHeight,
                                    scrollHeight: message.scrollHeight, width: message.clientWidth, scrollWidth: message.scrollWidth } : null;
                            })(),
                            actions: Array.from(element.querySelectorAll('[aria-label]')).map(node => node.getAttribute('aria-label'))
                        }))`, returnByValue: true,
                    });
                    if (evidencePath) fs.writeFileSync(evidencePath, JSON.stringify({ phase: 'notification-observation',
                        language, kind, expected, configuredLanguage: vscode.workspace.getConfiguration('lsdyna').get('language'),
                        notifications: response.result.value, results }, null, 2));
                    notification = response.result.value.find(item => item.visible && item.text.includes(expected));
                    assert.ok(notification, expected);
                    assert.ok(notification.actions.includes(`Collapse Notification (${process.platform === 'darwin' ? '←' : 'LeftArrow'})`), JSON.stringify(notification.actions));
                    assert.ok(notification.message && notification.message.text.includes(expected));
                    assert.ok(notification.message.height > 0 && notification.message.scrollHeight <= notification.message.height + 1);
                    assert.ok(notification.message.scrollWidth <= notification.message.width + 1);
                });
                const name = `${language}-${kind}`;
                const screenshot = await devTools.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                if (evidencePath) fs.writeFileSync(`${evidencePath}.${name}.png`, Buffer.from(screenshot.data, 'base64'));
                results.push({ language, kind, expected, notification, openerUnchanged: opened.length === opensBeforeFailure,
                    size: replacement.size, mtimeMs: replacement.mtimeMs });
                assert.equal(opened.length, opensBeforeFailure);
            }
        }
        assert.deepEqual(workspaceSnapshot(), workspaceBefore);
        if (evidencePath) fs.writeFileSync(evidencePath, JSON.stringify({ host: vscode.version,
            vscodeLocale: vscode.env.language, platform: process.platform, activatedModule: currentModule.filename,
            results, boundary: 'Original synthetic locked bytes/catalog; PDF opener observed; native resolver and notification UI execute unchanged.',
            workspaceUnchanged: true }, null, 2));
    } finally {
        devTools.close();
        await configuration.update('language', originalLanguage, vscode.ConfigurationTarget.Global);
        i18n.updateLanguage();
        await vscode.commands.executeCommand('notifications.clearAll');
    }
}

async function assertCustomKeywordOwnershipInTheActualHost() {
    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    const currentModule = Object.values(require.cache).find(entry =>
        entry.exports?._internals?.ensureCardCellEditGuard === extension.exports._internals.ensureCardCellEditGuard);
    assert.ok(currentModule, 'use the activated extension module');
    const productRequire = createRequire(currentModule.filename);
    const service = productRequire('./client/services/customValidKeywords');
    const ui = productRequire('./client/services/customValidKeywordsUi');
    const i18n = productRequire('./core/i18n');
    const configuration = vscode.workspace.getConfiguration('lsdyna');
    const priorLanguage = configuration.get('language');
    const priorKeywords = configuration.inspect('customValidKeywords').globalValue;
    const workspaceBefore = workspaceSnapshot();
    const devTools = await connectWorkbenchDevTools();
    const evidencePath = process.env.LSDYNA_CUSTOM_KEYWORD_EVIDENCE;
    const results = [];
    let observation;
    const save = phase => {
        if (evidencePath) fs.writeFileSync(evidencePath, JSON.stringify({ phase, host: vscode.version,
            vscodeLocale: vscode.env.language, platform: process.platform, activatedModule: currentModule.filename,
            results, observation, boundary: 'Native settings known-layer control; get-only adapter models unavailable ownership. Actual native QuickPick and warning UI. CDP-emulated viewport; no source snapshot or independent language approval.' }, null, 2));
    };
    try {
        await configuration.update('customValidKeywords', ['*HOST_USER'], vscode.ConfigurationTarget.Global);
        assert.equal(service.resolveEntrySource('*HOST_USER'), 'global');
        const knownLayer = service.inspectCustomValidKeywords();
        await configuration.update('customValidKeywords', priorKeywords, vscode.ConfigurationTarget.Global);
        for (const language of ['en', 'zh-cn']) {
            await configuration.update('language', language, vscode.ConfigurationTarget.Global);
            i18n.updateLanguage();
            for (const width of [360, 480]) {
                await vscode.commands.executeCommand('notifications.clearAll');
                await devTools.call('Emulation.setDeviceMetricsOverride', { width, height: 900,
                    deviceScaleFactor: 1, mobile: false });
                const entry = '*UNKNOWN_OWNER';
                let picks = 0, updates = 0;
                const commands = [];
                const config = { get: () => [entry], update() { updates++; throw Error('unknown owner must not be written'); } };
                const flow = ui.showManageCustomValidKeywordsPick({ config, executeCommand: (command, ...args) => {
                    commands.push({ command, args });
                    return vscode.commands.executeCommand(command, ...args);
                }, showQuickPick: (items, options) => {
                    assert.equal(items[0].action, 'add', 'must not offer edit/delete for unknown ownership');
                    return ++picks === 1 ? vscode.window.showQuickPick(items, options) : Promise.resolve(undefined);
                } });
                const observed = flow.then(() => ({ passed: true }), error => ({ error: error.stack }));
                const label = i18n.get('customValidKeywordSourceUnknown');
                let picker;
                await waitForAssertion(async () => {
                    const response = await devTools.call('Runtime.evaluate', { expression: `(() => {
                        const row = Array.from(document.querySelectorAll('.quick-input-widget .monaco-list-row'))
                            .find(item => item.textContent.includes(${JSON.stringify(entry)}));
                        const widget = row?.closest('.quick-input-widget');
                        return row ? { text: row.textContent, accessible: row.getAttribute('aria-label'),
                            opacity: Number(getComputedStyle(widget).opacity),
                            animations: widget.getAnimations({subtree:true}).filter(animation =>
                                animation.playState === 'running' && Number.isFinite(animation.effect.getTiming().iterations)).length,
                            title: row.getAttribute('title'), left: row.getBoundingClientRect().left,
                            right: row.getBoundingClientRect().right, viewport: innerWidth,
                            labels: Array.from(row.querySelectorAll('.label-name, .label-description')).map(item => {
                                const range = document.createRange(); range.selectNodeContents(item);
                                const glyphs = range.getBoundingClientRect();
                                const parent = item.parentElement.getBoundingClientRect();
                                return { text: item.textContent, title: item.getAttribute('title'), left: glyphs.left,
                                    right: glyphs.right, parentLeft: parent.left, parentRight: parent.right };
                            }) } : null;
                    })()`, returnByValue: true });
                    picker = response.result.value;
                    observation = { language, width, picker };
                    save('picker-observation');
                    assert.ok(picker?.text.includes(label));
                    assert.ok(picker.accessible?.includes(entry) && picker.accessible.includes(label));
                    assert.equal(picker.viewport, width);
                    assert.equal(picker.opacity, 1);
                    assert.equal(picker.animations, 0);
                    assert.ok(picker.left >= 0 && picker.right <= width + 1);
                    assert.ok(picker.labels.every(item => item.left >= item.parentLeft - 1 && item.right <= item.parentRight + 1));
                    assert.ok(picker.labels.every(item => item.left >= picker.left - 1 && item.right <= picker.right + 1));
                });
                const name = `${language}-${width}`;
                if (evidencePath) {
                    const screenshot = await devTools.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                    fs.writeFileSync(`${evidencePath}.${name}-picker.png`, Buffer.from(screenshot.data, 'base64'));
                }
                const point = await waitForRendererVisibleTextElementCenter(devTools,
                    '.quick-input-widget .monaco-list-row', entry, false, 3000);
                await dispatchRendererMouseClick(devTools, point);
                const expected = i18n.get('customValidKeywordSourceUnknownReadOnly', entry);
                const settingsAction = i18n.get('customValidKeywordManageOpenSettings');
                await vscode.commands.executeCommand('notifications.showList');
                let warning;
                await waitForAssertion(async () => {
                    const response = await devTools.call('Runtime.evaluate', { expression: `(() => {
                        const item = Array.from(document.querySelectorAll('.notification-list-item'))
                            .find(item => item.textContent.includes(${JSON.stringify(expected)}));
                        if (!item) return null;
                        item.querySelector('[aria-label^="Expand Notification"]')?.click();
                        const message = item.querySelector('.notification-list-item-message');
                        const bounds = message.getBoundingClientRect();
                        const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
                        const ancestors = [];
                        for (let parent = message.parentElement; parent; parent = parent.parentElement) {
                            const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
                            if (style.overflowX !== 'visible') {
                                clip.left = Math.max(clip.left, rect.left); clip.right = Math.min(clip.right, rect.right);
                            }
                            if (style.overflowY !== 'visible') {
                                clip.top = Math.max(clip.top, rect.top); clip.bottom = Math.min(clip.bottom, rect.bottom);
                            }
                            ancestors.push({ className: parent.className, top: rect.top, bottom: rect.bottom,
                                overflowX: style.overflowX, overflowY: style.overflowY });
                        }
                        return { text: message?.textContent, width: message?.clientWidth, scrollWidth: message?.scrollWidth,
                            height: message?.clientHeight, scrollHeight: message?.scrollHeight,
                            bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }, clip, ancestors,
                            left: item.getBoundingClientRect().left, right: item.getBoundingClientRect().right,
                            viewport: innerWidth, accessible: item.getAttribute('aria-label'),
                            buttons: Array.from(item.querySelectorAll('.monaco-button')).map(button => {
                                const rect = button.getBoundingClientRect();
                                const range = document.createRange(); range.selectNodeContents(button);
                                const glyphs = range.getBoundingClientRect();
                                return { text: button.textContent, accessible: button.getAttribute('aria-label'),
                                    left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                                    glyphs: { left: glyphs.left, right: glyphs.right, top: glyphs.top, bottom: glyphs.bottom } };
                            }) };
                    })()`, returnByValue: true });
                    warning = response.result.value;
                    observation = { language, width, picker, warning };
                    save('warning-observation');
                    assert.ok(warning?.text.includes(expected));
                    assert.ok(warning.height > 0 && warning.scrollHeight <= warning.height + 1);
                    assert.ok(warning.scrollWidth <= warning.width + 1);
                    assert.ok(warning.left >= 0 && warning.right <= width + 1);
                    assert.ok(warning.bounds.top >= warning.clip.top - 1 && warning.bounds.bottom <= warning.clip.bottom + 1);
                    assert.ok(warning.bounds.left >= warning.clip.left - 1 && warning.bounds.right <= warning.clip.right + 1);
                    const button = warning.buttons.find(button => button.text === settingsAction);
                    assert.ok(button && (!button.accessible || button.accessible === settingsAction));
                    assert.ok(button.left >= warning.clip.left - 1 && button.right <= warning.clip.right + 1);
                    assert.ok(button.top >= warning.clip.top - 1 && button.bottom <= warning.clip.bottom + 1);
                    assert.ok(button.glyphs.top >= warning.clip.top - 1 && button.glyphs.bottom <= warning.clip.bottom + 1);
                });
                const dom = await devTools.call('DOM.getDocument', { depth: 0 });
                const actionNode = await devTools.call('DOM.querySelector', {
                    nodeId: dom.root.nodeId, selector: '.notification-list-item .monaco-button',
                });
                const accessibility = await devTools.call('Accessibility.getPartialAXTree', {
                    nodeId: actionNode.nodeId, fetchRelatives: false,
                });
                const actionName = accessibility.nodes.find(node => !node.ignored && node.role?.value === 'button');
                assert.equal(actionName?.name?.value, settingsAction);
                warning.settingsActionAccessibleName = actionName.name.value;
                if (evidencePath) {
                    const screenshot = await devTools.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                    fs.writeFileSync(`${evidencePath}.${name}-warning.png`, Buffer.from(screenshot.data, 'base64'));
                }
                const actionPoint = await waitForRendererVisibleTextElementCenter(devTools,
                    '.notification-list-item .monaco-button', settingsAction, false, 3000);
                await dispatchRendererMouseClick(devTools, actionPoint);
                const completed = await withTimeout(observed, 3000, 'manage UI did not close after the warning');
                assert.equal(completed.error, undefined);
                assert.equal(picks, 1);
                assert.deepEqual(commands, [{ command: 'workbench.action.openSettings', args: ['lsdyna.customValidKeywords'] }]);
                assert.equal(updates, 0);
                assert.deepEqual(workspaceSnapshot(), workspaceBefore);
                results.push({ language, width, label, expected, settingsAction, commands, picker, warning, writes: updates, knownLayer });
                save('case-passed');
            }
        }
        save('passed');
    } catch (error) {
        observation = { ...observation, error: error.stack };
        save('failed');
        if (evidencePath) {
            const screenshot = await devTools.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            fs.writeFileSync(`${evidencePath}.failed.png`, Buffer.from(screenshot.data, 'base64'));
        }
        throw error;
    } finally {
        await devTools.call('Emulation.clearDeviceMetricsOverride');
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await vscode.commands.executeCommand('notifications.clearAll');
        await configuration.update('customValidKeywords', priorKeywords, vscode.ConfigurationTarget.Global);
        await configuration.update('language', priorLanguage, vscode.ConfigurationTarget.Global);
        i18n.updateLanguage();
        devTools.close();
    }
}

async function runScenarios() {
    if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
        throw new Error('LSDYNA_EDITOR_SAFETY_WORKSPACE is missing');
    }

    const extension = vscode.extensions.getExtension('hqyyqh.dynasense');
    assert.ok(extension, 'development extension was not loaded');
    if (process.env.LSDYNA_EDITOR_SAFETY_REPORT_ENVIRONMENT_GAPS === '1') {
        const original = await vscode.env.clipboard.readText();
        let writableBeforeActivation = false;
        try {
            await writeClipboardText('DynaSense isolated clipboard preflight');
            writableBeforeActivation = true;
        } catch (error) {
            if (error.code !== 'LSDYNA_CLIPBOARD_UNAVAILABLE') throw error;
        } finally { await vscode.env.clipboard.writeText(original); }
        fs.writeFileSync(path.join(workspaceRoot, 'clipboard-environment.json'), JSON.stringify({
            extensionActiveAtProbe: extension.isActive, writableBeforeActivation,
        }, null, 2));
        console.log(`Clipboard preflight before DynaSense activation: ${writableBeforeActivation}`);
    }
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
    // The suite's Enter scenarios exercise the explicit opt-in cleanup mode;
    // default-off preservation is covered by the provider regression tests.
    await vscode.workspace.getConfiguration('lsdyna').update(
        'clearAutoIndentOnEnter',
        true,
        vscode.ConfigurationTarget.Global,
    );

    const focusedScenario = process.env.LSDYNA_EDITOR_SAFETY_ONLY;
    if (focusedScenario) {
        const scenarios = {
            'parameter-rename': async () => {
                await assertParameterRenameIsDocumentLocalAndUndoable();
                await assertParameterRenameRendererCancelAndAcceptAreScoped();
                await assertParameterRenameKeepsFixedColumns();
            },
            'enter': assertEnterIsAtomicAndUndoable,
            'cell-navigation-identity': assertCellNavigationBelongsToTheOpenDocument,
            'semantic-evidence-integrity': assertSemanticEvidenceGatesInTheActualHost,
            'custom-keyword-owner': assertCustomKeywordOwnershipInTheActualHost,
            'cell-navigation-regression': async () => {
                for (const scenario of [
                    assertCellNavigationBelongsToTheOpenDocument,
                    assertPasteIntoSelectedCellKeepsColumns,
                    assertCellTypeIsLocalAndUndoable,
                    assertCommaTabRequiresExplicitConversionAndUndo,
                ]) {
                    await scenario();
                    console.log(`Cell navigation host passed: ${scenario.name}`);
                }
            },
            'release-b05': async () => {
                await assertPassiveOperationsDoNotWrite();
                console.log('B05 host passed: assertPassiveOperationsDoNotWrite');
                await assertCompletionAcceptCancelIsLocalAndUndoable();
                console.log('B05 host passed: assertCompletionAcceptCancelIsLocalAndUndoable');
                await assertCompletionMixedCursorsFailClosed();
                console.log('B05 host passed: assertCompletionMixedCursorsFailClosed');
                await assertMultiCursorNavigationCommandsFailClosed();
                console.log('B05 host passed: assertMultiCursorNavigationCommandsFailClosed');
                await assertMultiCursorDeleteCommandsFailClosed();
                console.log('B05 host passed: assertMultiCursorDeleteCommandsFailClosed');
                await assertCellDeleteCannotModifyReadonlyDeck();
                console.log('B05 host passed: assertCellDeleteCannotModifyReadonlyDeck');
                await assertCellDeleteAndEnterUseCurrentExternalVersion();
                console.log('B05 host passed: assertCellDeleteAndEnterUseCurrentExternalVersion');
                await assertTypeAfterExternalReloadCannotCollapseColumns();
                console.log('B05 host passed: assertTypeAfterExternalReloadCannotCollapseColumns');
                await assertCellDeleteAndBackspaceAreLocalAndUndoable();
                console.log('B05 host passed: assertCellDeleteAndBackspaceAreLocalAndUndoable');
                await assertAdjacentFieldMergeIsChosenAndUndoable();
                console.log('B05 host passed: assertAdjacentFieldMergeIsChosenAndUndoable');
                await assertEmptyFieldTypingAlignsWithoutTab();
                console.log('B05 host passed: assertEmptyFieldTypingAlignsWithoutTab');
                await assertLargeNodeBlockKeepsSchemaAfterEdit();
                console.log('B05 host passed: assertLargeNodeBlockKeepsSchemaAfterEdit');
                await assertOverlappingSchemaTabAndFormatAreByteStable();
                console.log('B05 host passed: assertOverlappingSchemaTabAndFormatAreByteStable');
                await assertEmptyCellBackspaceMovesWithoutWriting();
                console.log('B05 host passed: assertEmptyCellBackspaceMovesWithoutWriting');
                await assertSecondDeleteRemovesNowEmptyCardRow();
                console.log('B05 host passed: assertSecondDeleteRemovesNowEmptyCardRow');
                await assertCommaDeleteUsesNativeUndoableEditing();
                console.log('B05 host passed: assertCommaDeleteUsesNativeUndoableEditing');
                await assertEnterIsAtomicAndUndoable();
                console.log('B05 host passed: assertEnterIsAtomicAndUndoable');
                await assertCellTypeIsLocalAndUndoable();
                console.log('B05 host passed: assertCellTypeIsLocalAndUndoable');
                await assertCommaTabRequiresExplicitConversionAndUndo();
                console.log('B05 host passed: assertCommaTabRequiresExplicitConversionAndUndo');
                await assertOverWidthTypeIsRejectedAtomically();
                console.log('B05 host passed: assertOverWidthTypeIsRejectedAtomically');
                await assertFormatOnSaveScopeAndUndo();
                console.log('B05 host passed: assertFormatOnSaveScopeAndUndo');
                await assertStandardFormattingEntrypointsAreUnclaimed();
                console.log('B05 host passed: assertStandardFormattingEntrypointsAreUnclaimed');
                await assertSaveAllDoesNotFormatInactiveDocuments();
                console.log('B05 host passed: assertSaveAllDoesNotFormatInactiveDocuments');
                await assertExplicitFormattingIsScopedAndUndoable();
                console.log('B05 host passed: assertExplicitFormattingIsScopedAndUndoable');
                await assertOverlappingFormatSelectionsAreAtomicAndUndoable();
                console.log('B05 host passed: assertOverlappingFormatSelectionsAreAtomicAndUndoable');
                await assertOnBlurFormattingTracksOnlyTheActiveCondition();
                console.log('B05 host passed: assertOnBlurFormattingTracksOnlyTheActiveCondition');
                await assertOnBlurFormattingCannotModifyReadonlyDeck();
                console.log('B05 host passed: assertOnBlurFormattingCannotModifyReadonlyDeck');
                await assertOnBlurFormattingCannotModifyOsReadonlyDeck();
                console.log('B05 host passed: assertOnBlurFormattingCannotModifyOsReadonlyDeck');
                await assertOnBlurFormattingUsesCurrentExternalVersion();
                console.log('B05 host passed: assertOnBlurFormattingUsesCurrentExternalVersion');
                await assertRapidCloseDuringOnBlurCheckIsNonMutating();
                console.log('B05 host passed: assertRapidCloseDuringOnBlurCheckIsNonMutating');
                await assertAutoSaveFormatIsLocalAndUndoable();
                console.log('B05 host passed: assertAutoSaveFormatIsLocalAndUndoable');
                await assertLineCommentInsertsAtColumnZeroAndUncommentsStrictly();
                console.log('B05 host passed: assertLineCommentInsertsAtColumnZeroAndUncommentsStrictly');
                await assertLineCommentEmptyLineIsNoop();
                console.log('B05 host passed: assertLineCommentEmptyLineIsNoop');
                await assertLineCommentMultiLineSelectionIsAtomicAndSingleUndo();
                console.log('B05 host passed: assertLineCommentMultiLineSelectionIsAtomicAndSingleUndo');
                await assertLineCommentMultiCursorIsAtomicAndSingleUndo();
                console.log('B05 host passed: assertLineCommentMultiCursorIsAtomicAndSingleUndo');
                await assertLineCommentOrdinaryPlusIndentedDollarUsesCommentMode();
                console.log('B05 host passed: assertLineCommentOrdinaryPlusIndentedDollarUsesCommentMode');
                await assertKeywordCommentUsesManualInlineFormAndRoundTripsMixedBody();
                console.log('B05 host passed: assertKeywordCommentUsesManualInlineFormAndRoundTripsMixedBody');
                await assertCommentOpaqueProvidersAndToggleAreScoped();
                console.log('B05 host passed: assertCommentOpaqueProvidersAndToggleAreScoped');
                await assertLineCommentFallsThroughForNonLsdynaDocument();
                console.log('B05 host passed: assertLineCommentFallsThroughForNonLsdynaDocument');
                await assertLineCommentFailsClosedWithoutMovingCursorOnReadonlyDeck();
                console.log('B05 host passed: assertLineCommentFailsClosedWithoutMovingCursorOnReadonlyDeck');
                await assertCloseUnsavedRevertKeepsDiskAndOtherFilesUnchanged();
                console.log('B05 host passed: assertCloseUnsavedRevertKeepsDiskAndOtherFilesUnchanged');
                await assertOnBlurFormattingCannotModifyOsReadonlyDeck(true);
            },
            'entity-references-webview': assertEntityReferencesWebviewActivatesAndQueries,
            'large-file-viewer': assertLargeFileCustomEditorOpensReadonly,
            'committed-ime': assertCommittedImeTextIsEditorLocalAndUndoable,
            composition: assertRendererImeCompositionIsLocalAndUndoable,
            'composition-cancel': assertRendererImeCompositionCancelRestoresCell,
            'composition-overwidth': assertRendererImeCompositionOverWidthIsRejected,
            latency: assertInteractiveLatencyBaseline,
            paste: assertPasteIntoSelectedCellKeepsColumns,
            'mouse-multicursor': assertRendererAltClickMultiCursorActionsAreAtomic,
            'mouse-drag': assertRendererMouseDragSelectionsAreScopedAndUndoable,
            'mouse-context-menu': assertRendererContextMenuPasteAndCutAreScopedAndUndoable,
            'include-preview-sequence': async () => {
                await assertStaleIncludeCaseQuickFixFailsClosed();
                await assertIncludeCaseQuickFixCancelIsNoOp();
                await assertIncludeCaseQuickFixPreviewIsNonMutating();
                await assertIncludeCaseActionRevalidatesAfterMenuWait();
                await assertIncludeCaseActionRevalidatesAfterCaseOnlyRename();
            },
            'include-stale': assertStaleIncludeCaseQuickFixFailsClosed,
            'include-filesystem': async () => {
                if (fs.existsSync(path.join(workspaceRoot, 'sub/part.key'))) await assertIncludeCaseQuickFixIsLocalAndUndoable();
                else await assertCaseSensitiveIncludeRemainsUnresolved();
            },
            'mouse-code-action': assertIncludeCaseQuickFixMouseClickIsLocalAndUndoable,
            'line-comment': assertLineCommentInsertsAtColumnZeroAndUncommentsStrictly,
            'comment-roundtrip': assertKeywordCommentUsesManualInlineFormAndRoundTripsMixedBody,
            'comment-opaque': assertCommentOpaqueProvidersAndToggleAreScoped,
            'line-comment-readonly': assertLineCommentFailsClosedWithoutMovingCursorOnReadonlyDeck,
            'ctrl-slash': assertRendererCtrlSlashFiresColumnZeroComment,
            'ctrl-slash-suggest': assertRendererCtrlSlashFiresColumnZeroCommentWhileSuggestVisible,
            'inline-choice-cancel': assertRendererInlineChoiceCancelKeysPreserveSource,
            'completion-backspace': assertRendererCompletionBackspaceKeepsFixedColumns,
            'merge-choice': assertAdjacentFieldMergeIsChosenAndUndoable,
            'empty-field-input': assertEmptyFieldTypingAlignsWithoutTab,
            'keyword-title': assertVerifiedKeywordAliasIsTransactional,
            'keyword-alias': assertVerifiedKeywordAliasIsTransactional,
            'keyword-contact': assertContactOptionsDoNotDuplicateOrRemoveComments,
            'large-node-edit': assertLargeNodeBlockKeepsSchemaAfterEdit,
            'overlapping-schema': assertOverlappingSchemaTabAndFormatAreByteStable,
            'snippet-tab': assertRendererTabKeepsSnippetPlaceholderNavigation,
            'multiline-tab': assertRendererMultiLineSelectionUsesNativeTab,
            'comma-tab': assertCommaTabRequiresExplicitConversionAndUndo,
            'official-corpus': assertOfficialFormatCorpusFailsClosedInRealHost,
            'hover-functional': assertFunctionalHoverMatrix,
            'official-choice': assertOfficialFieldChoiceMouseFlowIsDiscoverableAndUndoable,
            'keyword-structure': assertKeywordStructureRepairMouseFlowIsRevalidatedAndUndoable,
            'title-card-position': assertUnverifiedTitleVariantStaysReadOnly,
        };
        assert.ok(scenarios[focusedScenario], `Unknown focused scenario: ${focusedScenario}`);
        await scenarios[focusedScenario]();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        console.log(`Editor safety focused Extension Host: ${focusedScenario} passed`);
        return;
    }

    const caseInsensitiveIncludes = fs.existsSync(path.join(workspaceRoot, 'sub/part.key'));
    assert.ok(fs.existsSync(path.join(workspaceRoot, 'Sub/Part.key')), 'Include case fixture must exist');
    const caseResults = [];
    for (const scenario of [
        assertPassiveOperationsDoNotWrite,
        assertSemanticEvidenceGatesInTheActualHost,
        assertCustomKeywordOwnershipInTheActualHost,
        assertCellNavigationBelongsToTheOpenDocument,
        assertEntityReferencesWebviewActivatesAndQueries,
        assertLargeFileCustomEditorOpensReadonly,
        assertFunctionalHoverMatrix,
        assertUnverifiedTitleVariantStaysReadOnly,
        assertKeywordStructureRepairMouseFlowIsRevalidatedAndUndoable,
        assertOfficialFieldChoiceMouseFlowIsDiscoverableAndUndoable,
        assertCompletionAcceptCancelIsLocalAndUndoable,
        assertCompletionMixedCursorsFailClosed,
        assertMultiCursorNavigationCommandsFailClosed,
        assertMultiCursorDeleteCommandsFailClosed,
        assertRendererMultiCursorKeysStayNativeAndUndoable,
        assertRendererAltClickMultiCursorActionsAreAtomic,
        assertRendererMouseDragSelectionsAreScopedAndUndoable,
        assertRendererContextMenuPasteAndCutAreScopedAndUndoable,
        assertCellDeleteCannotModifyReadonlyDeck,
        assertCellDeleteAndEnterUseCurrentExternalVersion,
        assertTypeAfterExternalReloadCannotCollapseColumns,
        assertCellDeleteAndBackspaceAreLocalAndUndoable,
        assertAdjacentFieldMergeIsChosenAndUndoable,
        assertRendererInlineChoiceCancelKeysPreserveSource,
        assertRendererCompletionBackspaceKeepsFixedColumns,
        assertEmptyFieldTypingAlignsWithoutTab,
        assertLargeNodeBlockKeepsSchemaAfterEdit,
        assertOverlappingSchemaTabAndFormatAreByteStable,
        assertRendererTabKeepsSnippetPlaceholderNavigation,
        assertRendererMultiLineSelectionUsesNativeTab,
        assertEmptyCellBackspaceMovesWithoutWriting,
        assertSecondDeleteRemovesNowEmptyCardRow,
        assertCommaDeleteUsesNativeUndoableEditing,
        assertEnterIsAtomicAndUndoable,
        assertVerifiedKeywordAliasIsTransactional,
        assertKeywordOptionsCannotModifyReadonlyDeck,
        assertKeywordManagerRemainsBoundWhenEditorFocusChanges,
        assertContactOptionsDoNotDuplicateOrRemoveComments,
        assertParameterRenameIsDocumentLocalAndUndoable,
        assertParameterRenameKeepsFixedColumns,
        assertParameterRenameRendererCancelAndAcceptAreScoped,
        ...(caseInsensitiveIncludes ? [assertIncludeCaseQuickFixIsLocalAndUndoable,
        assertIncludeCaseQuickFixMouseClickIsLocalAndUndoable,
        assertStaleIncludeCaseQuickFixFailsClosed,
        assertIncludeCaseQuickFixCancelIsNoOp,
        assertIncludeCaseQuickFixPreviewIsNonMutating,
        assertIncludeCaseActionRevalidatesAfterMenuWait,
        assertIncludeCaseActionRevalidatesAfterCaseOnlyRename,
        assertIncludeCaseQuickFixCannotModifyReadonlyDeck,
        assertIncludeCaseActionDoesNotOverwriteMenuTimeEdit] : [assertCaseSensitiveIncludeRemainsUnresolved]),
        assertCellTypeIsLocalAndUndoable,
        assertCommaTabRequiresExplicitConversionAndUndo,
        assertOverWidthTypeIsRejectedAtomically,
        assertFormatOnSaveScopeAndUndo,
        assertStandardFormattingEntrypointsAreUnclaimed,
        assertSaveAllDoesNotFormatInactiveDocuments,
        assertExplicitFormattingIsScopedAndUndoable,
        assertOverlappingFormatSelectionsAreAtomicAndUndoable,
        assertOnBlurFormattingTracksOnlyTheActiveCondition,
        assertOnBlurFormattingCannotModifyReadonlyDeck,
        assertOnBlurFormattingCannotModifyOsReadonlyDeck,
        assertOnBlurFormattingUsesCurrentExternalVersion,
        assertRapidCloseDuringOnBlurCheckIsNonMutating,
        assertAutoSaveFormatIsLocalAndUndoable,
        assertCommittedImeTextIsEditorLocalAndUndoable,
        assertRendererImeCompositionIsLocalAndUndoable,
        assertRendererImeCompositionCancelRestoresCell,
        assertRendererImeCompositionOverWidthIsRejected,
        assertOfficialFormatCorpusFailsClosedInRealHost,
        assertInteractiveLatencyBaseline,
        assertPasteIntoSelectedCellKeepsColumns,
        assertLineCommentInsertsAtColumnZeroAndUncommentsStrictly,
        assertLineCommentEmptyLineIsNoop,
        assertLineCommentMultiLineSelectionIsAtomicAndSingleUndo,
        assertLineCommentMultiCursorIsAtomicAndSingleUndo,
        assertLineCommentOrdinaryPlusIndentedDollarUsesCommentMode,
        assertKeywordCommentUsesManualInlineFormAndRoundTripsMixedBody,
        assertCommentOpaqueProvidersAndToggleAreScoped,
        assertLineCommentFallsThroughForNonLsdynaDocument,
        assertLineCommentFailsClosedWithoutMovingCursorOnReadonlyDeck,
        assertCloseUnsavedRevertKeepsDiskAndOtherFilesUnchanged,
        assertRendererCtrlSlashFiresColumnZeroComment,
        assertRendererCtrlSlashFiresColumnZeroCommentWhileSuggestVisible,
    ]) {
        try {
            await scenario();
            caseResults.push({ name: scenario.name, status: 'passed' });
        } catch (error) {
            if (error.code !== 'LSDYNA_CLIPBOARD_UNAVAILABLE' ||
                process.env.LSDYNA_EDITOR_SAFETY_REPORT_ENVIRONMENT_GAPS !== '1') throw error;
            caseResults.push({ name: scenario.name, status: 'unverified', reason: error.message });
        }
        console.log(JSON.stringify(caseResults[caseResults.length - 1]));
    }
    fs.writeFileSync(path.join(workspaceRoot, 'host-results.json'), JSON.stringify(caseResults, null, 2));
    const gaps = caseResults.filter(item => item.status !== 'passed');
    if (gaps.length) throw new Error('Host acceptance incomplete: ' + gaps.map(item => item.name).join(', '));
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    console.log(`Editor safety Extension Host: ${caseResults.length} scenarios passed`);
}

async function run() {
    const originalClipboardText = await vscode.env.clipboard.readText();
    try { return await runScenarios(); }
    finally { await writeClipboardText(originalClipboardText); }
}

module.exports = { run };
