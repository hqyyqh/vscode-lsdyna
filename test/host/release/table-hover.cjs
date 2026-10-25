'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const { fetchJson, openSocket, createCdp } = require('../../support/devtools.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Inspect and click the real workbench Hover, not a separately rendered Markdown fixture.
exports.check = async (file, root, checks) => {
    const targets = await fetchJson(`http://127.0.0.1:${process.env.LSDYNA_RELEASE_CDP_PORT}/json/list`);
    const target = targets.find(item => item.type === 'page' && item.url.includes('workbench'));
    assert.ok(target, 'VS Code workbench target');
    const socket = await openSocket(target.webSocketDebuggerUrl);
    const cdp = createCdp(socket, 10000), call = cdp.call;
    const evaluate = async expression => {
        const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
        return result.result.value;
    };
    const waitFor = async expression => {
        const deadline = Date.now() + 15000;
        do { const result = await evaluate(expression); if (result) return result; await delay(50); } while (Date.now() < deadline);
        throw Error(`Hover DOM timeout: ${expression}\n${await evaluate('document.body.innerText.slice(-5000)')}`);
    };
    const hoverState = `(() => {
        const hover = [...document.querySelectorAll('.monaco-hover')].find(h => h.getBoundingClientRect().height && h.querySelector('a[data-href*="setLsdynaTablePreviewView"]'));
        if (!hover) return null;
        const image = hover.querySelector('img[src*="image/svg+xml"]');
        if (!image || !image.complete || !image.naturalWidth) return null;
        const svg = atob(image.src.split(',')[1]);
        return {view: /data-table-view="([^"]+)"/.exec(svg)?.[1], text: hover.innerText,
            selected: [...hover.querySelectorAll('strong')].map(e => e.innerText),
            links: [...hover.querySelectorAll('a[data-href*="setLsdynaTablePreviewView"]')].map(e => ({text:e.innerText, title:e.title, href:e.dataset.href}))};
    })()`;
    try {
        const document = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(document);
        const original = document.getText(), version = document.version;
        const evidence = [];
        for (const language of ['en', 'zh-cn']) {
            await vscode.workspace.getConfiguration('lsdyna').update('language', language, vscode.ConfigurationTarget.Global);
            for (const [line, character] of [[6, 2], [18, 39]]) {
                await vscode.commands.executeCommand('editor.action.hideHover');
                editor.selection = new vscode.Selection(line, character, line, character);
                editor.revealRange(new vscode.Range(line, 0, line, 0));
                await vscode.commands.executeCommand('editor.action.showHover', { focus: 'autoFocusImmediately' });
                await waitFor(hoverState);
                for (const caret of ['elsewhere', 'inside', 'boundary']) {
                    // Include reversed selections, multicursors, and a caret at the field's exclusive end.
                    const column = caret === 'boundary' ? document.lineAt(line).text.length : character;
                    const selections = caret === 'elsewhere'
                        ? [new vscode.Selection(1, 10, 1, 1), new vscode.Selection(3, 2, 3, 2)]
                        : [new vscode.Selection(line, column, line, column)];
                    editor.selections = selections;
                    for (const view of ['front', 'side', 'reverse-isometric', 'isometric']) {
                        const link = await evaluate(`(() => {
                            const a = [...document.querySelectorAll('.monaco-hover a[data-href*="setLsdynaTablePreviewView"]')].find(a => decodeURIComponent(a.dataset.href).includes('"view":"${view}"'));
                            if (!a) return null;
                            a.scrollIntoView({block:'nearest'}); const r=a.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
                        })()`);
                        assert.ok(link, `Clickable ${view} link`);
                        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...link });
                        await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...link });
                        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...link });
                        const state = await waitFor(`(() => {const s=${hoverState};return s?.view==='${view}' && s;})()`);
                        assert.deepEqual(editor.selections, selections, 'Preserve all editing selections');
                        assert.equal(document.getText(), original); assert.equal(document.version, version);
                        assert.ok(!/\*\*|&#x20;/.test(state.text), 'No Markdown or HTML-entity leakage');
                        const label = {en: {front:'Front',side:'Side','reverse-isometric':'Reverse',isometric:'Isometric'},
                            'zh-cn': {front:'正视',side:'侧视','reverse-isometric':'反向',isometric:'等轴'}}[language][view];
                        assert.ok(state.selected.includes(label), `Current view has rendered emphasis: ${label}`);
                        evidence.push({language,caret,line:line+1,...state});
                    }
                }
            }
        }
        // Let the native Hover fade-in finish before capturing visual evidence.
        await delay(250);
        assert.equal((await waitFor(hoverState)).view, 'isometric');
        const screenshot = await call('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(root, 'table-hover.png'), Buffer.from(screenshot.data, 'base64'));
        fs.writeFileSync(path.join(root, 'table-hover.json'), JSON.stringify(evidence, null, 2));
        checks.push('table-hover: 48 real DOM viewpoint switches, EN/ZH, definition/reference, caret inside/outside/boundary, selections and document preserved');
    } finally {
        cdp.close();
    }
};
